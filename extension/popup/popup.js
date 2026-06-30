const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');
let m3u8List = [];

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1500);
}

function renderList() {
  countEl.textContent = m3u8List.length;

  if (m3u8List.length === 0) {
    listEl.innerHTML = `<div class="empty">
      <div class="icon">📡</div>
      <div>等待检测到 m3u8 资源...</div>
      <div style="margin-top:4px;font-size:11px">浏览视频页面即可自动嗅探</div>
    </div>`;
    return;
  }

  listEl.innerHTML = m3u8List.map((item, i) => {
    const url = typeof item === 'string' ? item : item.url;
    const time = item.time ? new Date(item.time).toLocaleTimeString() : '';
    return `<div class="item" data-index="${i}">
      <div class="url">${escapeHtml(url)}</div>
      <div class="meta">${time}</div>
      <div class="item-actions">
        <button class="btn" data-action="copy" data-index="${i}">复制地址</button>
        <button class="btn btn-primary" data-action="download" data-index="${i}">下载</button>
      </div>
    </div>`;
  }).join('');

  // 绑定事件
  listEl.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      const url = typeof m3u8List[idx] === 'string' ? m3u8List[idx] : m3u8List[idx].url;
      navigator.clipboard.writeText(url).then(() => showToast('已复制到剪贴板'));
    });
  });

  listEl.querySelectorAll('[data-action="download"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      const url = typeof m3u8List[idx] === 'string' ? m3u8List[idx] : m3u8List[idx].url;
      openManagerWithUrl(url);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function openOrFocusManager(params, callback) {
  const managerUrl = chrome.runtime.getURL('manager/manager.html');
  chrome.tabs.query({ url: managerUrl + '*' }, (tabs) => {
    if (tabs.length > 0) {
      // 管理器已打开：聚焦标签页，通过消息传递 URL（避免刷新页面导致编辑丢失）
      const tab = tabs[0];
      chrome.tabs.update(tab.id, { active: true }, () => {
        chrome.runtime.sendMessage({
          type: 'SET_TASK_URL',
          url: params ? params.get('url') : '',
          title: params ? params.get('title') || '' : '',
          pageUrl: params ? params.get('pageUrl') || '' : ''
        });
        if (callback) callback();
      });
    } else {
      const url = params ? managerUrl + '?' + params.toString() : managerUrl;
      chrome.tabs.create({ url }, callback);
    }
  });
}

function openManagerWithUrl(url) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const title = (tabs[0] && tabs[0].title) ? tabs[0].title : '';
    const pageUrl = (tabs[0] && tabs[0].url) ? tabs[0].url : '';
    const params = new URLSearchParams();
    params.set('url', url);
    if (title) params.set('title', title);
    if (pageUrl) params.set('pageUrl', pageUrl);
    openOrFocusManager(params);
  });
}

function loadList() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    chrome.runtime.sendMessage({ type: 'GET_M3U8_LIST', tabId }, (response) => {
      m3u8List = response?.list || [];
      renderList();
    });
  });
}

// ── 嗅探开关 ──
const snifferToggle = document.getElementById('snifferToggle');
const snifferLabel = document.getElementById('snifferLabel');

function updateToggleUI(enabled) {
  snifferToggle.checked = enabled;
  snifferLabel.textContent = enabled ? '嗅探已开启' : '嗅探已停止';
}

chrome.runtime.sendMessage({ type: 'GET_SNIFFER_STATUS' }, (response) => {
  if (!chrome.runtime.lastError && response) {
    updateToggleUI(response.enabled);
  }
});

snifferToggle.addEventListener('change', () => {
  const enabled = snifferToggle.checked;
  updateToggleUI(enabled);
  chrome.runtime.sendMessage({ type: 'TOGGLE_SNIFFER', enabled });
});

document.getElementById('openManager').addEventListener('click', () => {
  openOrFocusManager();
});

document.getElementById('clearBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    chrome.runtime.sendMessage({ type: 'CLEAR_LIST', tabId }, () => {
      m3u8List = [];
      renderList();
      showToast('列表已清空');
    });
  });
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadList();
  showToast('已刷新');
});

// 实时更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'NEW_M3U8') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTabId = tabs[0]?.id;
      if (msg.tabId === currentTabId) {
        if (!m3u8List.some(item => item.url === msg.url)) {
          m3u8List.push({ url: msg.url, time: msg.timeStamp });
          renderList();
        }
      }
    });
  }
});

loadList();
