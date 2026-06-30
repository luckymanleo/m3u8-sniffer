const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'mkv', 'mov', 'flv', 'wmv', 'avi', 'ogv', 'ogg', 'm3u8'
]);

const VIDEO_KEYWORDS = [
  /\/hls\//i, /\/m3u8\//i,
  /\/media\//i, /\/stream\//i, /\/download\//i,
  /\.m3u8/i
];

const MAX_STORED_URLS = 200;

let downloadedUrls = [];
let snifferEnabled = true;
let storageReady = false;
const pendingRequests = [];
const activePorts = {}; // taskId → NativeMessagingPort
const capturedHeaders = {}; // url → { cookie, referer, userAgent }

function isVideoUrl(url) {
  if (!url || url.startsWith('chrome-extension://')) return false;

  try {
    const path = new URL(url).pathname;
    const lastSegment = path.split('/').pop() || '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex >= 0) {
      const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext);
    }
  } catch {}

  return VIDEO_KEYWORDS.some(p => p.test(url));
}

function stripQuery(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function isDuplicate(url, base, tabId) {
  return downloadedUrls.some(item =>
    item.tabId === tabId && (item.base || item.url) === base
  );
}

function addUrl({ url, base, tabId }) {
  // 过滤已知加密/无效的 m3u8 变体
  if (/\.v1\.m3u8(\?|$)/i.test(url)) {
    console.log('[FILTER] blocked encrypted v1 m3u8:', url.substring(0, 80));
    return;
  }
  downloadedUrls.push({ url, base, tabId, time: Date.now() });
  if (downloadedUrls.length > MAX_STORED_URLS) {
    downloadedUrls = downloadedUrls.slice(-MAX_STORED_URLS);
  }
  chrome.storage.local.set({ m3u8_list: downloadedUrls });
  chrome.runtime.sendMessage({
    type: 'NEW_M3U8',
    url,
    tabId,
    timeStamp: Date.now()
  }).catch(() => {});
}

// 按目录对 .m3u8 去重：同一目录下只保留最短文件名的条目
function dedupM3u8ByDir(newUrl, tabId) {
  try {
    const u = new URL(newUrl);
    const parts = u.pathname.split('/');
    const filename = parts.pop();
    const dir = parts.join('/');

    const idx = downloadedUrls.findIndex(item => {
      if (item.tabId !== tabId || !item.url.endsWith('.m3u8')) return false;
      try {
        const iu = new URL(item.url);
        const ip = iu.pathname.split('/');
        ip.pop();
        return ip.join('/') === dir;
      } catch { return false; }
    });

    if (idx >= 0) {
      const existing = downloadedUrls[idx];
      const existingName = new URL(existing.url).pathname.split('/').pop();
      if (filename.length < existingName.length) {
        downloadedUrls[idx] = { url: newUrl, base: stripQuery(newUrl), tabId, time: Date.now() };
      }
      return true;
    }
  } catch {}
  return false;
}

// ── 嗅探：拦截网络请求 ──
function processWebRequest(details) {
  if (!snifferEnabled) return;
  const url = details.url;
  if (!isVideoUrl(url)) return;

  // 跳过所有直接视频扩展名的 URL：它们必须由 onHeadersReceived 验证 Content-Type
  const DIRECT_VIDEO_EXTS = ['.ts', '.m3u8', '.mp4', '.webm', '.mkv', '.mov', '.flv', '.wmv', '.avi', '.ogv', '.ogg'];
  try {
    const urlPath = new URL(url).pathname.toLowerCase();
    if (DIRECT_VIDEO_EXTS.some(ext => urlPath.endsWith(ext))) return;
  } catch {}

  const base = stripQuery(url);
  if (isDuplicate(url, base, details.tabId)) return;

  addUrl({ url, base, tabId: details.tabId });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!storageReady) {
      pendingRequests.push(details);
      return;
    }
    processWebRequest(details);
  },
  { urls: ['<all_urls>'] }
);

// 通过 Content-Type 嗅探
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!storageReady || !snifferEnabled) return;

    // 跳过 .ts 分片（HLS 分段，避免污染列表）
    try {
      const urlPath = new URL(details.url).pathname.toLowerCase();
      if (urlPath.endsWith('.ts')) return;
    } catch {}

    const contentType = (details.responseHeaders || []).find(
      h => h.name.toLowerCase() === 'content-type'
    );
    if (!contentType) return;
    const val = (contentType.value || '').toLowerCase();

    const urlPathCheck = (() => {
      try { return new URL(details.url).pathname.toLowerCase(); } catch { return ''; }
    })();
    const pathIsMedia = /\.(m3u8|mp4|webm|mkv|mov|flv|avi|ogv|ogg)(\?|$)/i.test(urlPathCheck);

    if (urlPathCheck.endsWith('.m3u8') && /text\/html|application\/json|text\/css|text\/javascript|image\//.test(val)) return;

    const isVideo = val.includes('mpegurl') || val.includes('mpeg url') ||
      val.startsWith('video/') ||
      (pathIsMedia && (val.includes('octet-stream') || val.includes('text/plain') || val.includes('binary/'))) ||
      val.includes('matroska') || val.includes('x-msvideo');
    if (!isVideo) return;

    const url = details.url;
    const base = stripQuery(url);
    if (isDuplicate(url, base, details.tabId)) return;

    if (urlPathCheck.endsWith('.m3u8') && dedupM3u8ByDir(url, details.tabId)) return;

    // .m3u8 且 Content-Type 非标准 mpegurl → 轻量验证响应体
    if (urlPathCheck.endsWith('.m3u8') && !val.includes('mpegurl') && !val.includes('mpeg url')) {
      fetch(url, { headers: { 'Range': 'bytes=0-127' } })
        .then(res => res.text())
        .then(body => {
          if (/^#EXTM3U/i.test((body || '').trim())) {
            addUrl({ url, base, tabId: details.tabId });
          }
        })
        .catch(() => {});
      return;
    }

    addUrl({ url, base, tabId: details.tabId });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// 缓存浏览器发出的原始请求头
function looksLikeVideoUrl(url) {
  return isVideoUrl(url) ||
    /file=.+\.(?:m3u8|mp4|webm|mkv|ts|mov|flv)/i.test(url) ||
    /\.(?:m3u8|mp4|webm|mkv|ts|mov|flv)(?:\?|$)/i.test(url);
}
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!snifferEnabled) return;
    if (!looksLikeVideoUrl(details.url)) return;
    const h = {};
    for (const header of details.requestHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === 'cookie' || name === 'referer' || name === 'user-agent') {
        h[name] = header.value;
      }
    }
    if (h.cookie || h.referer) {
      capturedHeaders[details.url] = h;
      const keys = Object.keys(capturedHeaders);
      if (keys.length > 100) delete capturedHeaders[keys[0]];
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// ── 消息处理 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'M3U8_FOUND') {
    if (!storageReady) return;
    const url = msg.url;

    // 跳过 .ts 分片和 .webm 预览（不应进入列表）
    try {
      const urlPath = new URL(url).pathname.toLowerCase();
      if (urlPath.endsWith('.ts') || urlPath.endsWith('.webm')) return;
    } catch {}
    const base = stripQuery(url);
    const tabId = sender.tab ? sender.tab.id : 0;
    if (isDuplicate(url, base, tabId)) return;

    if (!isVideoUrl(url)) return;
    addUrl({ url, base, tabId });
  }

  if (msg.type === 'GET_M3U8_LIST') {
    const list = msg.tabId
      ? downloadedUrls.filter(item => item.tabId === msg.tabId)
      : downloadedUrls;
    sendResponse({ list: list.map(u => ({ url: u.url, time: u.time })) });
  }

  if (msg.type === 'CLEAR_LIST') {
    const tabId = msg.tabId || (sender.tab ? sender.tab.id : null);
    if (tabId) {
      downloadedUrls = downloadedUrls.filter(item => item.tabId !== tabId);
      chrome.storage.local.set({ m3u8_list: downloadedUrls });
    } else {
      downloadedUrls = [];
      chrome.storage.local.set({ m3u8_list: [] });
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'CHECK_M3U8') {
    sendResponse({ found: downloadedUrls.some(item => item.url === stripQuery(msg.url)) });
  }

  if (msg.type === 'TOGGLE_SNIFFER') {
    snifferEnabled = !!msg.enabled;
    chrome.storage.local.set({ sniffer_enabled: snifferEnabled });
    sendResponse({ enabled: snifferEnabled });
  }

  if (msg.type === 'GET_SNIFFER_STATUS') {
    sendResponse({ enabled: snifferEnabled });
  }

  if (msg.type === 'START_DOWNLOAD') {
    const cap = capturedHeaders[msg.url] || {};
    if (cap.cookie) msg.cookieHeader = cap.cookie;
    if (cap.referer) msg.referer = cap.referer;

    const fetchCookiesAndStart = () => {
      if (msg.cookieHeader) {
        startDownload(msg)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ error: err.message }));
        return;
      }
      try {
        const targetUrl = new URL(msg.url);
        chrome.cookies.getAll({ domain: targetUrl.hostname }, (cookies) => {
          if (cookies && cookies.length > 0) {
            msg.cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          }
          startDownload(msg)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        });
      } catch {
        startDownload(msg)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ error: err.message }));
      }
    };

    if (!msg.referer) {
      const entry = downloadedUrls.find(item => item.url === msg.url || item.base === stripQuery(msg.url));
      if (entry && entry.tabId) {
        chrome.tabs.get(entry.tabId, (tab) => {
          if (chrome.runtime.lastError) {
            fetchCookiesAndStart();
            return;
          }
          if (tab && tab.url) msg.referer = tab.url;
          fetchCookiesAndStart();
        });
        return true;
      }
    }
    fetchCookiesAndStart();
    return true;
  }

  if (msg.type === 'CANCEL_DOWNLOAD') {
    cancelDownload(msg.taskId);
    sendResponse({ ok: true });
  }

  if (msg.type === 'PICK_FOLDER') {
    pickFolder()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OPEN_FOLDER') {
    openFolder(msg.path)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'DELETE_FILES') {
    deleteFiles(msg.paths)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Native Messaging 下载 ──
function startDownload(taskData) {
  return new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative('com.m3u8.sniffer');
      const taskId = taskData.taskId;
      activePorts[taskId] = port;

      port.onMessage.addListener((msg) => {
        if (msg.type === 'progress') {
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_PROGRESS', taskId,
            data: { status: 'downloading', percent: msg.percent || 0,
              downloaded: String(msg.downloaded || 0), total: String(msg.total || 0),
              speed: msg.speed || '', eta: msg.eta || '' }
          }).catch(() => {});
          return;
        }
        if (msg.type === 'complete') {
          delete activePorts[taskId];
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_PROGRESS', taskId,
            data: { status: 'completed', percent: 100,
              downloaded: String(msg.size || 0), total: String(msg.size || 0),
              filePath: msg.filePath || '', speed: '', eta: '' }
          }).catch(() => {});
          port.disconnect();
          return;
        }
        if (msg.type === 'error') {
          delete activePorts[taskId];
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_PROGRESS', taskId,
            data: { status: 'failed', error: msg.error || '下载失败', mergeFailed: !!msg.mergeFailed }
          }).catch(() => {});
          port.disconnect();
          return;
        }
      });

      port.onDisconnect.addListener(() => {
        delete activePorts[taskId];
        const errMsg = chrome.runtime.lastError
          ? chrome.runtime.lastError.message || 'Native host exited unexpectedly.'
          : 'Native host disconnected.';
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS', taskId,
          data: { status: 'failed', error: errMsg }
        }).catch(() => {});
      });

      port.postMessage({
        action: 'download',
        taskId: taskData.taskId,
        url: taskData.url,
        filename: taskData.filename,
        savePath: taskData.savePath,
        mode: taskData.mode,
        headers: taskData.headers || {},
        referer: taskData.referer || '',
        cookieHeader: taskData.cookieHeader || '',
        cleanTemp: !!taskData.cleanTemp,
        mergeOnly: !!taskData.mergeOnly
      });

      resolve({ accepted: true, taskId });
    } catch (e) { reject(e); }
  });
}

function pickFolder() {
  return new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative('com.m3u8.sniffer');
      port.onMessage.addListener((msg) => { resolve(msg); port.disconnect(); });
      port.onDisconnect.addListener(() => { resolve({ error: '连接已断开' }); });
      port.postMessage({ action: 'pickFolder' });
    } catch (e) { reject(e); }
  });
}

function openFolder(folderPath) {
  return new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative('com.m3u8.sniffer');
      port.onMessage.addListener((msg) => { resolve(msg); port.disconnect(); });
      port.onDisconnect.addListener(() => { resolve({ status: 'done' }); });
      port.postMessage({ action: 'openFolder', path: folderPath });
      resolve({ accepted: true });
    } catch (e) { reject(e); }
  });
}

function deleteFiles(filePaths) {
  return new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative('com.m3u8.sniffer');
      port.onMessage.addListener((msg) => { resolve(msg); port.disconnect(); });
      port.onDisconnect.addListener(() => { resolve({ results: [] }); });
      port.postMessage({ action: 'deleteFiles', files: filePaths });
    } catch (e) { reject(e); }
  });
}

function cancelDownload(taskId) {
  const port = activePorts[taskId];
  if (port) {
    try { port.postMessage({ action: 'cancel', taskId }); } catch (e) {}
    setTimeout(() => {
      try { port.disconnect(); } catch {}
      delete activePorts[taskId];
    }, 100);
  }
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS', taskId,
    data: { status: 'failed', error: '用户取消' }
  }).catch(() => {});
}

// ── 初始化 ──
chrome.storage.local.get(['m3u8_list', 'sniffer_enabled'], (data) => {
  if (data && data.m3u8_list) {
    downloadedUrls = data.m3u8_list
      .map(item => typeof item === 'string' ? { url: item, tabId: 0, time: 0 } : item)
      .filter(item => {
        try { return isVideoUrl(item.url); }
        catch { return true; }
      });
  }
  if (typeof data.sniffer_enabled === 'boolean') {
    snifferEnabled = data.sniffer_enabled;
  }
  if (data.m3u8_list && downloadedUrls.length < data.m3u8_list.length) {
    chrome.storage.local.set({ m3u8_list: downloadedUrls });
  }
  storageReady = true;
  for (const details of pendingRequests) {
    processWebRequest(details);
  }
  pendingRequests.length = 0;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('M3U8 Sniffer & Downloader 已安装');
  console.log('请运行 native-host/install.bat 安装本地下载组件');
});
