const STORAGE_KEY = 'download_tasks';

let tasks = [];
let taskIdCounter = 0;
let filterText = '';
let filterStatus = 'all';
let selectedIds = new Set();
let _pendingPageUrl = '';

const $ = (sel) => document.querySelector(sel);
const taskContainer = $('#taskContainer');
const toastEl = $('#toast');

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2000);
}

function genTaskId() {
  return 'task_' + Date.now() + '_' + (++taskIdCounter);
}

function loadTasks() {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    tasks = data[STORAGE_KEY] || [];
    let needsSave = false;
    // 将"下载中"任务标记为中断（扩展重载导致连接断开）
    for (const task of tasks) {
      if (task.status === 'downloading') {
        task.status = 'failed';
        task.error = '扩展已重载，下载中断。点击重试可续传';
        needsSave = true;
      }
    }
    if (tasks.length > 0) {
      taskIdCounter = tasks.reduce((max, t) => {
        const m = t.id.match(/task_\\d+_(\\d+)/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
    }
    if (needsSave) saveTasks();
    renderTasks();

    const urlParam = new URLSearchParams(location.search).get('url');
    if (urlParam) {
      $('#taskUrl').value = urlParam;
      const titleParam = new URLSearchParams(location.search).get('title');
      if (titleParam) {
        $('#taskFilename').value = cleanTitle(titleParam) + '.mp4';
      } else {
        $('#taskFilename').value = guessFilename(urlParam);
      }
      const pageUrlParam = new URLSearchParams(location.search).get('pageUrl');
      if (pageUrlParam) _pendingPageUrl = pageUrlParam;
    }
  });
}

function saveTasks() {
  chrome.storage.local.set({ [STORAGE_KEY]: tasks });
}

function guessFilename(url) {
  // 解密 m3u8 的虚拟 URL → 返回通用文件名，由 title 参数覆盖
  if (url && url.startsWith('decrypted://')) {
    return 'video.mp4';
  }
  try {
    const u = new URL(url);
    let name = u.pathname.split('/').pop() || '';

    // 代理链接(如 mp.kkkppp.top/?url=xxx/preview.mp4)：从 query 参数提取真实文件名
    if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) {
      for (const key of ['url', 'v', 'src', 'target', 'redirect']) {
        const val = u.searchParams.get(key);
        if (val && /^https?:\/\//i.test(val)) {
          try {
            const inner = new URL(val).pathname.split('/').pop() || '';
            if (inner && /\.[a-z0-9]{2,5}$/i.test(inner)) {
              name = inner;
              break;
            }
          } catch {}
        }
      }
    }

    if (!name) name = 'video';

    // 已经是直接媒体文件 → 保留原始扩展名
    if (/\.(mp4|webm|mkv|mov|flv|wmv|avi|ogv|ogg)$/i.test(name)) {
      return name;
    }
    // m3u8 替换为 .mp4，其他情况追加 .mp4
    return name.replace(/\.m3u8$/i, '') + '.mp4';
  } catch {
    return 'video.mp4';
  }
}

// 去掉页面标题中的垃圾前缀（如"在线播放_"）
function cleanTitle(title) {
  const junkPrefixes = [
    /^在线播放[_\s]*/i, /^在線播放[_\s]*/i,
    /^正在播放[_\s]*/i, /^在线观看[_\s]*/i,
    /^在线视频[_\s]*/i,
    /^Online\s*Play[_\s]*/i, /^Watch\s*Online[_\s]*/i,
    /^\s*[\-_—|]+\s*/
  ];
  let cleaned = title;
  for (const re of junkPrefixes) {
    cleaned = cleaned.replace(re, '');
  }
  // 去掉末尾的网站名（空格或 - 分隔的短后缀，如 " - MissAV"）
  cleaned = cleaned.replace(/\s*[-—|]\s*\S{2,10}\.(com|net|org|tv|cc|xyz|top|info|me)\s*$/i, '');
  cleaned = cleaned.replace(/\s*[-—|]\s*\S{1,8}\s*$/, '');
  return sanitizeFilename(cleaned);
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')   // 去掉非法字符
    .replace(/\s+/g, ' ')           // 合并空格
    .replace(/\.+$/, '')            // 去掉末尾点号
    .trim()
    .substring(0, 200);             // 限制长度
}

function isDownloadableUrl(url) {
  if (!url) return false;
  if (url.startsWith('decrypted://')) return true;
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return false;
    if (/\.(m3u8|mp4|webm|mkv|mov|flv|wmv|avi|ogv|ogg)(?:$|[?#])/i.test(url)) return true;
    if (/\/(?:hls|m3u8|media|stream|download)\//i.test(u.pathname)) return true;
    for (const key of ['url', 'v', 'src', 'target', 'redirect', 'file']) {
      const val = u.searchParams.get(key);
      if (val && /\.(m3u8|mp4|webm|mkv|mov|flv|wmv|avi|ogv|ogg)(?:$|[?#])/i.test(val)) return true;
    }
  } catch {}
  return false;
}

function addTask(url, filename, savePath, mode) {
  if (!url) {
    showToast('请输入 M3U8 地址');
    return null;
  }
  if (!isDownloadableUrl(url)) {
    showToast('Please use a sniffed m3u8/media URL, not the original web page URL. Play the video first, then click Download from the extension popup list.');
    return null;
  }
  if (!filename) {
    filename = guessFilename(url);
  }
  if (!savePath) {
    savePath = '';
  }

  const task = {
    id: genTaskId(),
    url,
    pageUrl: _pendingPageUrl || '',
    filename,
    savePath,
    mode: mode || 'mp4',
    status: 'pending',
    percent: 0,
    downloaded: '0',
    total: '?',
    speed: '',
    eta: '',
    error: '',
    createdAt: Date.now()
  };

  _pendingPageUrl = '';
  tasks.unshift(task);
  saveTasks();
  renderTasks();
  return task;
}

function startDownload(taskId, mergeOnly) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === 'downloading') return;
  if (task.status === 'completed') return;

  const wasFailed = task.status === 'failed';
  // 重试时保留已下载分片，仅续传缺失部分
  const cleanTemp = false;
  updateTask(taskId, { status: 'downloading', percent: 0, error: '', downloaded: '0', speed: '', eta: '' });

  chrome.runtime.sendMessage({
    type: 'START_DOWNLOAD',
    taskId: task.id,
    url: task.url,
    filename: task.filename,
    savePath: task.savePath,
    mode: task.mode,
    cleanTemp: cleanTemp,
    mergeOnly: !!mergeOnly
  }, (response) => {
    if (chrome.runtime.lastError) {
      updateTask(taskId, {
        status: 'failed',
        error: chrome.runtime.lastError.message || '通信失败，请确认已安装本地下载组件'
      });
      return;
    }
    if (response && response.error) {
      updateTask(taskId, { status: 'failed', error: response.error });
    }
  });
}

function cancelDownload(taskId) {
  chrome.runtime.sendMessage({
    type: 'CANCEL_DOWNLOAD',
    taskId: taskId
  });
}

function updateTask(taskId, updates) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  Object.assign(task, updates);

  if (task.percent >= 100 && task.status === 'downloading') {
    task.status = 'completed';
  }

  saveTasks();
  renderTasks();
}

function removeTask(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (task && task.status === 'downloading') {
    cancelDownload(taskId);
  }
  deleteLocalFiles(task);
  tasks = tasks.filter(t => t.id !== taskId);
  saveTasks();
  renderTasks();
}

function deleteLocalFiles(task) {
  if (!task) return;
  const pathsToDelete = [];
  // 已完成任务的文件路径
  if (task.filePath) {
    pathsToDelete.push(task.filePath);
  } else {
    // 未完成的任务，按 savePath + filename 尝试删除
    const outputPath = pathJoin(task.savePath, task.filename);
    if (outputPath) pathsToDelete.push(outputPath);
  }
  if (pathsToDelete.length > 0) {
    chrome.runtime.sendMessage({ type: 'DELETE_FILES', paths: pathsToDelete }).catch(() => {});
  }
}

function pathJoin(dir, file) {
  if (!dir || !file) return null;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + file;
}

function openFile(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task || !task.filePath) return;
  // 无法从 extension 直接打开文件，提示路径
  showToast('文件路径: ' + task.filePath);
}

function formatSize(bytes) {
  if (!bytes || bytes === '0') return '0 B';
  const n = parseInt(bytes);
  if (isNaN(n)) return bytes;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getFilteredTasks() {
  return tasks.filter(task => {
    if (filterStatus !== 'all' && task.status !== filterStatus) return false;
    if (filterText) {
      const term = filterText.toLowerCase();
      const matchUrl = task.url.toLowerCase().includes(term);
      const matchName = task.filename.toLowerCase().includes(term);
      if (!matchUrl && !matchName) return false;
    }
    return true;
  });
}

// ── 批量选择 ──

function toggleTaskSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  // Remove stale IDs
  const valid = new Set(tasks.map(t => t.id));
  for (const sid of selectedIds) { if (!valid.has(sid)) selectedIds.delete(sid); }
  renderTasks();
}

function selectAllTasks(select) {
  const filtered = getFilteredTasks();
  if (select) filtered.forEach(t => selectedIds.add(t.id));
  else selectedIds.clear();
  document.getElementById('selectAllCheck').checked = select;
  renderTasks();
}

function clearSelection() {
  selectedIds.clear();
  document.getElementById('selectAllCheck').checked = false;
  renderTasks();
}

function updateBatchBar() {
  const bar = document.getElementById('batchBar');
  const count = document.getElementById('selectedCount');
  const n = selectedIds.size;
  count.textContent = `已选择 ${n} 项`;
  bar.classList.toggle('visible', n > 0);
}

function batchStart() {
  let started = 0;
  for (const id of selectedIds) {
    const task = tasks.find(t => t.id === id);
    if (task && (task.status === 'pending' || task.status === 'paused' || task.status === 'failed')) {
      startDownload(id);
      started++;
    }
  }
  if (started > 0) showToast(`已开始 ${started} 个任务`);
  else showToast('所选任务中没有可开始的');
  clearSelection();
}

function batchRetry() {
  let started = 0;
  for (const id of selectedIds) {
    const task = tasks.find(t => t.id === id);
    if (task && task.status === 'failed') {
      startDownload(id);
      started++;
    }
  }
  if (started > 0) showToast(`已重试 ${started} 个任务`);
  else showToast('所选任务中没有失败的任务');
  clearSelection();
}

function batchCancel() {
  let cancelled = 0;
  for (const id of selectedIds) {
    const task = tasks.find(t => t.id === id);
    if (task && task.status === 'downloading') {
      cancelDownload(id);
      cancelled++;
    }
  }
  if (cancelled > 0) showToast(`已取消 ${cancelled} 个任务`);
  else showToast('所选任务中没有正在下载的');
  clearSelection();
}

function batchRemove() {
  const ids = [...selectedIds];
  if (!ids.length) return;

  let removed = 0;
  let skipped = 0;

  for (const id of ids) {
    const task = tasks.find(t => t.id === id);
    if (!task) continue;

    // 已完成的任务跳过不删
    if (task.status === 'completed') {
      skipped++;
      continue;
    }

    // 下载中的先取消（native host 会清理临时 TS 分片）
    if (task.status === 'downloading') {
      cancelDownload(id);
    }

    // 删除未完成任务的输出/临时文件
    deleteLocalFiles(task);
    removed++;
  }

  // 保留已完成的任务，删除其余
  tasks = tasks.filter(t => !ids.includes(t.id) || t.status === 'completed');
  selectedIds.clear();
  saveTasks();
  renderTasks();

  let msg = `已删除 ${removed} 个任务`;
  if (skipped > 0) msg += `，跳过 ${skipped} 个已完成`;
  showToast(msg);
}

function renderTasks() {
  const activeCount = tasks.filter(t => t.status === 'downloading').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  $('#activeCount').textContent = '进行中: ' + activeCount;
  $('#completedCount').textContent = '已完成: ' + completedCount;
  const filtered = getFilteredTasks();
  $('#taskTotal').textContent = tasks.length;

  if (tasks.length === 0) {
    taskContainer.innerHTML = `<div class="empty-state">
      <div class="icon">📥</div>
      <p>暂无下载任务</p>
      <p style="font-size:12px;">从弹窗嗅探列表添加，或手动输入 m3u8 地址</p>
    </div>`;
    return;
  }

  if (filtered.length === 0) {
    taskContainer.innerHTML = `<div class="empty-state">
      <div class="icon">🔍</div>
      <p>没有匹配的任务</p>
      <p style="font-size:12px;">尝试修改搜索条件</p>
    </div>`;
    return;
  }

  const isSelected = (id) => selectedIds.has(id) ? ' selected' : '';

  taskContainer.innerHTML = filtered.map(task => {
    const statusClass = 'status-' + task.status;
    const statusText = {
      pending: '等待中',
      downloading: '下载中',
      completed: '已完成',
      failed: '失败',
      paused: '已暂停'
    }[task.status] || task.status;

    const pgClass = task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : '';
    const pgWidth = task.percent || 0;

    const infoParts = [];
    if (task.mode) infoParts.push(`模式: ${task.mode.toUpperCase()}`);
    if (task.savePath) {
      const displayPath = task.savePath.length > 40
        ? task.savePath.substring(0, 18) + '...' + task.savePath.slice(-18)
        : task.savePath;
      infoParts.push(`保存到: ${displayPath}`);
    }
    if (task.downloaded) infoParts.push(`已下载: ${formatSize(task.downloaded)} / ${formatSize(task.total)}`);
    if (task.speed) infoParts.push(`速度: ${task.speed}`);
    if (task.eta) infoParts.push(`剩余: ${task.eta}`);

    const showStart = task.status === 'pending' || task.status === 'paused' || task.status === 'failed';
    const showCancel = task.status === 'downloading';
    const showRemove = task.status !== 'downloading';
    const showRetry = task.status === 'failed' && !task.mergeFailed;
    const showRemerge = task.status === 'failed' && task.mergeFailed;

    let actionBtns = '';
    actionBtns += `<button class="btn" data-action="copyFilename" data-id="${task.id}">复制文件名</button>`;
    actionBtns += `<button class="btn" data-action="copyUrl" data-id="${task.id}">复制地址</button>`;
    if (showStart && !task.mergeFailed) {
      actionBtns += `<button class="btn btn-primary" data-action="start" data-id="${task.id}">开始</button>`;
    }
    if (showRetry) {
      actionBtns += `<button class="btn btn-primary" data-action="start" data-id="${task.id}">重试</button>`;
    }
    if (showRemerge) {
      actionBtns += `<button class="btn btn-primary" data-action="remerge" data-id="${task.id}">重新合并</button>`;
      actionBtns += `<button class="btn" data-action="start" data-id="${task.id}">完整重试</button>`;
    }
    if (showCancel) {
      actionBtns += `<button class="btn btn-danger" data-action="cancel" data-id="${task.id}">取消</button>`;
    }
    const showOpenFolder = task.status === 'completed' && task.filePath;
    if (showOpenFolder) {
      actionBtns += `<button class="btn" data-action="openFolder" data-id="${task.id}">打开文件夹</button>`;
    }
    if (showRemove) {
      actionBtns += `<button class="btn" data-action="remove" data-id="${task.id}">删除</button>`;
    }

    return `<div class="task-card${isSelected(task.id)}" data-task-id="${task.id}">
      <div class="task-check">
        <input type="checkbox" data-action="select" data-id="${task.id}" ${selectedIds.has(task.id) ? 'checked' : ''}>
      </div>
      <div class="task-card-body">
        <div class="task-header">
          <span class="task-name" title="${escapeHtml(task.filename)}">${escapeHtml(task.filename)}</span>
          <span class="task-status ${statusClass}">${statusText}</span>
        </div>
        <div class="task-info">
          ${infoParts.map(s => '<span>' + s + '</span>').join('')}
        </div>
        ${task.pageUrl ? `<div class="task-page-url" title="${escapeHtml(task.pageUrl)}">📄 <span class="page-url-text">${escapeHtml(task.pageUrl.length > 60 ? task.pageUrl.substring(0, 57) + '...' : task.pageUrl)}</span><button class="btn btn-mini" data-action="copyPageUrl" data-id="${task.id}">复制</button></div>` : ''}
        <div class="progress-bar">
          <div class="progress-fill ${pgClass}" style="width:${pgWidth}%"></div>
        </div>
        ${task.error ? `<div style="font-size:12px;color:#d93025;margin-bottom:6px;">${escapeHtml(task.error)}</div>` : ''}
        <div class="task-actions">${actionBtns}</div>
      </div>
    </div>`;
  }).join('');

  // 绑定事件
  taskContainer.querySelectorAll('[data-action="start"]').forEach(btn => {
    btn.addEventListener('click', () => startDownload(btn.dataset.id));
  });
  taskContainer.querySelectorAll('[data-action="remerge"]').forEach(btn => {
    btn.addEventListener('click', () => startDownload(btn.dataset.id, true));
  });
  taskContainer.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => cancelDownload(btn.dataset.id));
  });
  taskContainer.querySelectorAll('[data-action="openFolder"]').forEach(btn => {
    btn.addEventListener('click', () => openFolder(btn.dataset.id));
  });
  taskContainer.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', () => removeTask(btn.dataset.id));
  });
  taskContainer.querySelectorAll('[data-action="copyFilename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const task = tasks.find(t => t.id === btn.dataset.id);
      if (task && task.filename) {
        navigator.clipboard.writeText(task.filename).then(() => showToast('文件名已复制'));
      }
    });
  });
  taskContainer.querySelectorAll('[data-action="copyUrl"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const task = tasks.find(t => t.id === btn.dataset.id);
      if (task && task.url) {
        navigator.clipboard.writeText(task.url).then(() => showToast('地址已复制'));
      }
    });
  });
  taskContainer.querySelectorAll('[data-action="copyPageUrl"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const task = tasks.find(t => t.id === btn.dataset.id);
      if (task && task.pageUrl) {
        navigator.clipboard.writeText(task.pageUrl).then(() => showToast('原始页面地址已复制'));
      }
    });
  });
  // 批量选择
  taskContainer.querySelectorAll('[data-action="select"]').forEach(cb => {
    cb.addEventListener('change', () => toggleTaskSelect(cb.dataset.id));
  });
  // 点击卡片切换选中
  taskContainer.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox' || e.target.closest('.task-actions') || e.target.closest('button')) return;
      const cb = card.querySelector('[data-action="select"]');
      if (cb) { cb.checked = !cb.checked; toggleTaskSelect(cb.dataset.id); }
    });
  });
  // Sync select-all checkbox
  const filteredIds = getFilteredTasks().map(t => t.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.has(id));
  document.getElementById('selectAllCheck').checked = allFilteredSelected;
  updateBatchBar();
}

function openFolder(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task || !task.filePath) return;
  const folderPath = task.filePath.replace(/[^\\\/]+$/, '');
  chrome.runtime.sendMessage({
    type: 'OPEN_FOLDER',
    path: folderPath
  }, (response) => {
    if (chrome.runtime.lastError) {
      showToast('打开文件夹失败: ' + chrome.runtime.lastError.message);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 事件绑定
$('#addTaskBtn').addEventListener('click', () => {
  const url = $('#taskUrl').value.trim();
  const filename = $('#taskFilename').value.trim();
  const savePath = $('#taskSavePath').value.trim();
  const mode = $('#taskMode').value;
  const task = addTask(url, filename, savePath, mode);
  if (task) {
    showToast('任务已添加');
    $('#taskUrl').value = '';
    $('#taskFilename').value = '';
  }
});

$('#addAndStartBtn').addEventListener('click', () => {
  const urlEl = $('#taskUrl');
  const filenameEl = $('#taskFilename');
  const savePathEl = $('#taskSavePath');
  const modeEl = $('#taskMode');

  if (!urlEl || !filenameEl || !savePathEl || !modeEl) {
    showToast('表单元素未找到，请刷新页面');
    return;
  }

  const url = urlEl.value.trim();
  const filename = filenameEl.value.trim();
  const savePath = savePathEl.value.trim();
  const mode = modeEl.value;

  if (!url) {
    showToast('请输入 M3U8 地址');
    urlEl.focus();
    return;
  }
  if (!savePath) {
    showToast('请输入保存目录');
    savePathEl.focus();
    return;
  }

  const task = addTask(url, filename, savePath, mode);
  if (task) {
    showToast('任务已添加，开始下载');
    urlEl.value = '';
    filenameEl.value = '';
    startDownload(task.id);
  }
});

$('#browseBtn').addEventListener('click', () => {
  const btn = $('#browseBtn');
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'PICK_FOLDER' }, (response) => {
    btn.disabled = false;
    const err = chrome.runtime.lastError;
    if (err) {
      showToast('选择目录失败: ' + err.message);
      return;
    }
    if (response && response.path) {
      $('#taskSavePath').value = response.path;
    } else if (response && response.error) {
      showToast(response.error);
    }
  });
});

// 进度更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DOWNLOAD_PROGRESS') {
    const data = msg.data;
    updateTask(msg.taskId, {
      percent: data.percent || 0,
      downloaded: data.downloaded || '0',
      total: data.total || '?',
      speed: data.speed || '',
      eta: data.eta || '',
      status: data.status || 'downloading',
      filePath: data.filePath || undefined,
      error: data.error || '',
      mergeFailed: data.mergeFailed || false
    });

    if (data.status === 'completed') {
      showToast('下载完成: ' + (tasks.find(t => t.id === msg.taskId)?.filename || msg.taskId));
    }
    if (data.status === 'failed') {
      showToast('下载失败: ' + (data.error || '未知错误'));
    }
  }

  // 从弹窗传入新 URL（管理器已打开时不刷新页面，改为消息传递）
  if (msg.type === 'SET_TASK_URL' && msg.url) {
    const urlEl = $('#taskUrl');
    const filenameEl = $('#taskFilename');
    // 仅在字段为空时才自动填入，避免覆盖用户正在编辑的内容
    if (!urlEl.value.trim()) {
      urlEl.value = msg.url;
    }
    if (!filenameEl.value.trim()) {
      if (msg.title) {
        filenameEl.value = cleanTitle(msg.title) + '.mp4';
      } else {
        filenameEl.value = guessFilename(msg.url);
      }
    }
    if (msg.pageUrl) _pendingPageUrl = msg.pageUrl;
  }
});

// 文件名实时净化：过滤非法字符
$('#taskFilename').addEventListener('input', () => {
  const el = $('#taskFilename');
  const pos = el.selectionStart;
  const before = el.value;
  const after = sanitizeFilename(before);
  if (after !== before) {
    el.value = after;
    // 恢复光标位置
    const shift = before.length - after.length;
    el.selectionStart = el.selectionEnd = Math.max(0, pos - shift);
  }
});

// 回车键添加任务（URL 和文件名两个输入框都支持）
function handleEnterKey(e) {
  if (e.key === 'Enter') {
    const url = $('#taskUrl').value.trim();
    const filename = $('#taskFilename').value.trim();
    const savePath = $('#taskSavePath').value.trim();
    const mode = $('#taskMode').value;
    addTask(url, filename, savePath, mode);
    $('#taskUrl').value = '';
    $('#taskFilename').value = '';
  }
}
$('#taskUrl').addEventListener('keydown', handleEnterKey);
$('#taskFilename').addEventListener('keydown', handleEnterKey);

// ── 搜索筛选 ──
const searchInput = document.getElementById('searchInput');
const statusFilterEl = document.getElementById('statusFilter');

searchInput.addEventListener('input', () => {
  filterText = searchInput.value.trim();
  renderTasks();
});

statusFilterEl.addEventListener('change', () => {
  filterStatus = statusFilterEl.value;
  renderTasks();
});

// ── 批量操作事件 ──
document.getElementById('selectAllCheck').addEventListener('change', (e) => {
  selectAllTasks(e.target.checked);
});

document.getElementById('batchStartBtn').addEventListener('click', batchStart);
document.getElementById('batchCancelBtn').addEventListener('click', batchCancel);
document.getElementById('batchRemoveBtn').addEventListener('click', batchRemove);
document.getElementById('batchRetryBtn').addEventListener('click', batchRetry);
document.getElementById('batchClearBtn').addEventListener('click', clearSelection);

loadTasks();
