// M3U8 Sniffer Native Messaging Host
// 浏览器扩展通过 stdin/stdout 与此程序通信，执行实际的文件下载

const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const https = require('https');
const http = require('http');

// ── 重试辅助 ──
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ERR_HTTP2_STREAM_CANCEL']);
function isRetryable(err) {
  if (!err) return false;
  if (err.message === 'CANCELLED') return false;
  // HTTP 502/504 是网关临时错误，可重试；4xx 和其他 5xx 不可重试
  if (err.message && /HTTP (502|504)/.test(err.message)) return true;
  if (err.message && (err.message.includes('HTTP 4') || err.message.includes('HTTP 5'))) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('socket hang up') || msg.includes('request timeout') || msg.includes('econnreset');
}

async function withRetry(fn, retries, label) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries && isRetryable(err)) {
        log(`Retry ${i + 1}/${retries} for ${label}: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 递增延迟
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── 日志 ──
function log(msg) {
  try {
    const logPath = path.join(__dirname, 'host.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] [${process.pid}] ${msg}\n`);
  } catch {}
}

// ── 崩溃诊断 ──
let stdoutBroken = false;
const activeDownloads = {}; // taskId → { controller: AbortController, tmpDir: string, ffmpeg: ChildProcess|null }
const runningTasks = new Set();

function trackTask(promise) {
  runningTasks.add(promise);
  promise.finally(() => runningTasks.delete(promise));
  return promise;
}

async function waitForRunningTasks() {
  while (runningTasks.size > 0) {
    await Promise.allSettled(Array.from(runningTasks));
  }
}

process.on('exit', (code) => {
  try { fs.appendFileSync(path.join(__dirname, 'host.log'), `[${new Date().toISOString()}] [${process.pid}] Process exit, code=${code}\n`); } catch {}
});
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(__dirname, 'host.log'), `[${new Date().toISOString()}] [${process.pid}] UNCAUGHT: ${err.message}\n${err.stack}\n`); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(path.join(__dirname, 'host.log'), `[${new Date().toISOString()}] [${process.pid}] UNHANDLED REJECTION: ${reason}\n`); } catch {}
});
process.stdout.on('error', (err) => {
  stdoutBroken = true;
});

// ── Native Messaging 协议 ──
// 使用 data 事件 + 缓冲区，比 readable+read 更可靠（尤其是 Windows 管道）
// CRITICAL: setEncoding(null) 必须在 resume() 和 on('data') 之前，否则 chunk 会是 string

process.stdin.setEncoding(null);

let stdinBuffer = Buffer.alloc(0);
let messageResolve = null;
let stdinClosed = false;
const messageQueue = [];

function deliverMessage(parsed) {
  log('Parsed message, action=' + (parsed.action || 'unknown'));
  if (messageResolve) {
    const rs = messageResolve;
    messageResolve = null;
    rs(parsed);
  } else {
    messageQueue.push(parsed);
    log('Queued message (no resolver yet), queue size=' + messageQueue.length);
  }
}

function tryRecoverJsonMessage(reason) {
  const jsonStart = stdinBuffer.indexOf(0x7B);
  if (jsonStart < 0 || jsonStart >= 100) return false;

  try {
    const parsed = JSON.parse(stdinBuffer.slice(jsonStart).toString('utf8'));
    log(reason + '; recovered JSON at offset ' + jsonStart + ', action=' + (parsed.action || 'unknown'));
    stdinBuffer = Buffer.alloc(0);
    deliverMessage(parsed);
    return true;
  } catch (e) {
    log(reason + '; JSON recovery from offset ' + jsonStart + ' failed: ' + e.message);
    return false;
  }
}

process.stdin.on('data', (chunk) => {
  // 兼容：Windows 上 process.stdin 可能返回 string 或 Buffer
  if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
  log('stdin received ' + chunk.length + ' bytes (total buffered: ' + (stdinBuffer.length + chunk.length) + ')');
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);

  while (true) {
    if (stdinBuffer.length < 4) break;

    const msgLen = stdinBuffer.readUInt32LE(0);
    log('header msgLen=' + msgLen + ', bufferSize=' + stdinBuffer.length);

    if (msgLen > 100 * 1024 * 1024 || msgLen < 1) {
      if (tryRecoverJsonMessage('Bad message length: ' + msgLen)) {
        continue;
      }
      log('Bad message length: ' + msgLen + ', clearing buffer');
      stdinBuffer = Buffer.alloc(0);
      break;
    }

    // 当 header 中的 msgLen 远大于实际缓冲区时，说明前 4 字节不是合法长度前缀
    // （QQ 浏览器对较大消息会出现此问题），此时尝试将整个缓冲区当作原始 JSON 解析
    if (msgLen > stdinBuffer.length + 4096) {
      log('msgLen far exceeds buffer, header is garbage, first 16 bytes hex: ' + stdinBuffer.slice(0, 16).toString('hex'));
      if (tryRecoverJsonMessage('Header length exceeds buffered data')) {
        continue;
      }
      log('Cannot find JSON start, clearing buffer');
      stdinBuffer = Buffer.alloc(0);
      break;
    }

    let bodyLen = msgLen;
    if (stdinBuffer.length < 4 + msgLen) {
      if (stdinBuffer.length >= msgLen) {
        bodyLen = msgLen - 4;
        log('header appears to include itself, trying bodyLen=' + bodyLen);
      } else {
        break;
      }
    }

    if (stdinBuffer.length < 4 + bodyLen) break;

    const msgBuf = stdinBuffer.slice(4, 4 + bodyLen);
    stdinBuffer = stdinBuffer.slice(4 + bodyLen);

    try {
      const parsed = JSON.parse(msgBuf.toString('utf8'));
      deliverMessage(parsed);
    } catch (e) {
      log('JSON parse error: ' + e.message);
    }
  }
});

process.stdin.resume();

process.stdin.on('end', () => {
  log('stdin ENDED');
  stdinClosed = true;
  if (messageResolve) {
    messageResolve(null);
    messageResolve = null;
  }
});
process.stdin.on('close', () => {
  log('stdin CLOSED');
  stdinClosed = true;
  if (messageResolve) {
    messageResolve(null);
    messageResolve = null;
  }
});
process.stdin.on('error', (err) => {
  log('stdin ERROR: ' + err.message);
});

function readMessage() {
  if (messageQueue.length > 0) {
    return Promise.resolve(messageQueue.shift());
  }
  if (stdinClosed) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    messageResolve = resolve;
  });
}

function sendMessage(msg) {
  if (stdoutBroken) return;
  try {
    const json = JSON.stringify(msg);
    const buf = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(buf.length, 0);
    process.stdout.write(Buffer.concat([header, buf]));
  } catch (e) {
    stdoutBroken = true;
  }
}

// ── 取消任务 ──
function cancelTask(taskId) {
  const dl = activeDownloads[taskId];
  if (!dl) return;

  log('Cancelling task: ' + taskId);

  // 终止 ffmpeg 进程
  if (dl.ffmpeg) {
    try { dl.ffmpeg.kill('SIGTERM'); } catch (e) { log('Kill ffmpeg error: ' + e.message); }
  }

  // 中止所有正在进行的 HTTP 请求
  dl.controller.abort();

  // 清理临时目录
  if (dl.tmpDir && fs.existsSync(dl.tmpDir)) {
    try {
      fs.rmSync(dl.tmpDir, { recursive: true, force: true });
      log('Cleaned temp dir: ' + dl.tmpDir);
    } catch (e) {
      log('Clean temp dir error: ' + e.message);
    }
  }

  delete activeDownloads[taskId];
}

// ── URL 解析 ──
function resolveUrl(url, base) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) {
    const proto = base.match(/^(https?:)/);
    return (proto ? proto[1] : 'https:') + url;
  }
  try {
    return String(new URL(url, base));
  } catch {
    if (url.startsWith('/')) {
      const u = new URL(base);
      return u.origin + url;
    }
    const idx = base.lastIndexOf('/');
    return base.substring(0, idx + 1) + url;
  }
}

// 从代理/跳转 URL 中提取真实地址（如 yutujx.com/?url=REAL.m3u8）
function extractProxyUrl(url) {
  try {
    const u = new URL(url);
    // 常见代理参数名：url, v, src, target, redirect（完整 URL）
    for (const key of ['url', 'v', 'src', 'target', 'redirect']) {
      const val = u.searchParams.get(key);
      if (val && /^https?:\/\/.+/i.test(val)) {
        return val;
      }
    }
    // file 参数：通常是相对路径，需要拼接 origin（如 remote_control.php?file=/videos/x.mp4）
    const fileVal = u.searchParams.get('file');
    if (fileVal) {
      const decoded = decodeURIComponent(fileVal);
      if (/^https?:\/\//i.test(decoded)) return decoded;
      if (/^\//.test(decoded)) return u.origin + decoded;
      return u.origin + '/' + decoded;
    }
  } catch {}
  return null;
}

// ── HTTP 请求 ──
function httpGetBuffer(url, headers = {}, signal) {
  return withRetry(() => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      timeout: 60000,
      signal,
      rejectUnauthorized: false
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGetBuffer(resolveUrl(res.headers.location, url), headers, signal)
          .then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', (err) => {
      if (err.name === 'AbortError') {
        reject(new Error('CANCELLED'));
      } else {
        reject(err);
      }
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  }), 2, url.substring(0, 80));
}

function downloadFile(url, filepath, headers = {}, signal) {
  return withRetry(() => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      timeout: 300000,
      signal,
      rejectUnauthorized: false
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(resolveUrl(res.headers.location, url), filepath, headers, signal)
          .then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0');
      const ws = fs.createWriteStream(filepath);
      let downloaded = 0;
      res.pipe(ws);
      res.on('data', (chunk) => { downloaded += chunk.length; });
      res.on('end', () => { ws.end(); });
      ws.on('finish', () => resolve({ size: downloaded, total }));
      res.on('error', (err) => {
        ws.close();
        try { fs.unlinkSync(filepath); } catch {}
        reject(err);
      });
    });
    req.on('error', (err) => {
      try { fs.unlinkSync(filepath); } catch {}
      if (err.name === 'AbortError') {
        reject(new Error('CANCELLED'));
      } else {
        reject(err);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      try { fs.unlinkSync(filepath); } catch {}
      reject(new Error('Download timeout'));
    });
  }), 8, url.substring(0, 80));
}

// ── m3u8 解析 ──
function parseM3U8(content, baseUrl) {
  const lines = content.split(/\r?\n/);
  const segments = [];
  let keyUri = null;
  let keyIv = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([^,\s]+)/i);
      const uriMatch = line.match(/URI="([^"]+)"/i);
      const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);
      if (methodMatch && methodMatch[1].toUpperCase() === 'AES-128' && uriMatch) {
        keyUri = resolveUrl(uriMatch[1], baseUrl);
        keyIv = ivMatch ? ivMatch[1] : null;
      } else if (methodMatch && methodMatch[1].toUpperCase() === 'NONE') {
        keyUri = null;
        keyIv = null;
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/[\d.]+/);
      const duration = durMatch ? parseFloat(durMatch[0]) : 0;
      // 下一个非注释行就是分片 URL
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j].trim();
        if (next && !next.startsWith('#')) {
          segments.push({
            url: resolveUrl(next, baseUrl),
            keyUri,
            keyIv
          });
          break;
        }
        if (next.startsWith('#EXT-X-KEY:')) {
          // 分片级密钥覆盖
          const m = next.match(/METHOD=([^,\s]+)/i);
          const u = next.match(/URI="([^"]+)"/i);
          const iv = next.match(/IV=0x([0-9a-fA-F]+)/i);
          if (m && m[1].toUpperCase() === 'AES-128' && u) {
            keyUri = resolveUrl(u[1], baseUrl);
            keyIv = iv ? iv[1] : null;
          }
        }
        j++;
      }
      i = j;
    }
  }

  return segments;
}

// ── 分片下载 ──
async function downloadAllSegments(segments, tmpDir, headers, onProgress, cancelCheck, existingFiles, signal) {
  const concurrency = 5;
  let completed = 0;
  let totalBytes = 0;
  const startTime = Date.now();
  const results = [];
  const skipSet = existingFiles || new Set();

  // 预填充已存在的分片，计算它们的文件大小
  for (const i of skipSet) {
    const tmpFile = path.join(tmpDir, `seg_${String(i).padStart(6, '0')}.ts`);
    try {
      const stat = fs.statSync(tmpFile);
      totalBytes += stat.size;
      results.push({ index: i, file: tmpFile, ok: true });
      completed++;
    } catch {
      skipSet.delete(i);
    }
  }

  const pendingSegments = segments.filter((_, i) => !skipSet.has(i));
  log(`Resume: ${completed} segments already done, ${pendingSegments.length} remaining`);

  onProgress(
    segments.length > 0 ? Math.round((completed / segments.length) * 100) : 0,
    totalBytes, totalBytes, '', ''
  );

  const queue = pendingSegments.map((seg, i) => ({ seg, i }));

  async function worker() {
    while (queue.length > 0) {
      if (stdoutBroken) return;
      if (cancelCheck && cancelCheck()) return;
      const { seg, i } = queue.shift();
      const tmpFile = path.join(tmpDir, `seg_${String(i).padStart(6, '0')}.ts`);

      try {
        // 下载分片
        const dl = await downloadFile(seg.url, tmpFile, headers, signal);
        let fileSize = dl.size;

        // 检测空文件
        if (fileSize === 0) {
          try { fs.unlinkSync(tmpFile); } catch {}
          throw new Error('Empty response');
        }

        // 检测无效数据（TS 分片必须以 0x47 开头）
        // AES-128-CBC decrypt before validating TS sync byte.
        if (seg.keyUri) {
          try {
            const keyData = await httpGetBuffer(seg.keyUri, headers, signal);
            const crypto = require('crypto');
            const ivHex = seg.keyIv || String(i + 1).padStart(32, '0');
            const iv = Buffer.from(ivHex, 'hex');
            const encrypted = fs.readFileSync(tmpFile);
            const decipher = crypto.createDecipheriv('aes-128-cbc', keyData.slice(0, 16), iv);
            decipher.setAutoPadding(true);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            fs.writeFileSync(tmpFile, decrypted);
            fileSize = decrypted.length;
          } catch (cryptErr) {
            log(`Decrypt failed for segment ${i}: ${cryptErr.message}`);
            try { fs.unlinkSync(tmpFile); } catch {}
            throw new Error('Decrypt failed: ' + cryptErr.message);
          }
        }

        const firstByte = fs.readFileSync(tmpFile, { encoding: null }).slice(0, 1);
        if (firstByte.length > 0 && firstByte[0] !== 0x47) {
          log(`Segment ${i} is not valid TS (first byte: 0x${firstByte[0].toString(16)}), discarding`);
          try { fs.unlinkSync(tmpFile); } catch {}
          throw new Error('Invalid TS data');
        }

        totalBytes += fileSize;
        results.push({ index: i, file: tmpFile, ok: true });
      } catch (err) {
        if (err.message === 'CANCELLED') throw err; // 终止取消传播
        log(`Segment ${i} failed: ${err.message}`);
        results.push({ index: i, file: null, ok: false, error: err.message });
      }

      completed++;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? totalBytes / elapsed : 0;
      const remaining = segments.length - completed;
      const avgSizePerSeg = completed > 0 ? totalBytes / completed : 500 * 1024;
      const etaSecs = speed > 0 && avgSizePerSeg > 0 ? (remaining * avgSizePerSeg) / speed : 0;
      const percent = Math.round((completed / segments.length) * 100);

      onProgress(percent, totalBytes, totalBytes + Math.round(remaining * avgSizePerSeg), formatSpeed(speed), formatDuration(Math.round(etaSecs)));
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, pendingSegments.length); w++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  results.sort((a, b) => a.index - b.index);
  return results;
}

// ── 合并为 MP4 ──
function mergeToMp4(tsFiles, outputPath, signal) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + '.list.txt';
    const listContent = tsFiles
      .map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');

    const args = [
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart', '-y', outputPath
    ];

    log('ffmpeg args: ' + args.join(' '));

    const ffmpeg = execFile('ffmpeg', args, {
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout, stderr) => {
      try { fs.unlinkSync(listPath); } catch {}

      if (signal && signal.aborted) {
        reject(new Error('CANCELLED'));
        return;
      }

      if (err) {
        // ffmpeg banner is in stderr; the actual error is at the end
        const lines = (stderr || '').split(/\r?\n/);
        const tail = lines.slice(-5).join('\n');
        log('ffmpeg error (last 5 lines): ' + tail);
        reject(new Error(tail.substring(0, 300)));
        return;
      }

      // 检查 stderr 中是否有帧丢弃/时间戳损坏警告（ffmpeg 退出码为 0 但视频不完整）
      const stderrStr = (stderr || '').toLowerCase();
      const corruptPatterns = [
        /discard(?:ing|ed)?\s+(?:corrupt|packet)/i,
        /corrupt\s+(?:decoded|packet|frame|stream)/i,
        /pts\s+has\s+no\s+value/i,
        /non-monotonous\s+dts/i,
        /duration.*out\s+of\s+range/i,
        /timestamp.*out\s+of\s+range/i,
        /coded\s+picture\s+timing/i,
      ];
      const matched = corruptPatterns.find(p => p.test(stderrStr));
      if (matched) {
        const lines = stderrStr.split(/\r?\n/);
        const errorLines = lines.filter(l => /discard|corrupt|pts|dts|duration|timestamp|coded picture/i.test(l));
        const detail = errorLines.slice(0, 3).join('; ');
        log('ffmpeg completed with corrupt frame warnings: ' + detail);
        // 删除不完整的输出文件
        try { fs.unlinkSync(outputPath); } catch {}
        reject(new Error('视频流时间戳损坏，合并后不完整 — 源文件有问题'));
        return;
      }

      resolve();
    });

    // 注册 ffmpeg 进程到 activeDownloads，以便取消时 kill
    for (const taskId of Object.keys(activeDownloads)) {
      const dl = activeDownloads[taskId];
      if (dl && dl.controller.signal === signal) {
        dl.ffmpeg = ffmpeg;
        break;
      }
    }

    // 如果信号已中止，kill ffmpeg
    if (signal && signal.aborted) {
      try { ffmpeg.kill('SIGTERM'); } catch {}
      reject(new Error('CANCELLED'));
    }
  });
}

// ── 格式化 ──
function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return Math.round(bytesPerSec) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

// ── 主下载流程 ──
async function doDownload(task) {
  const { taskId, url, filename, savePath: rawSavePath, mode, headers, referer, cookieHeader } = task;
  const savePath = rawSavePath || path.join(__dirname, '..');
  // 构建带 Referer 和 Cookie 的请求头（防盗链 + 鉴权）
  const dlHeaders = { ...(headers || {}) };
  if (referer) {
    dlHeaders['Referer'] = referer;
    log(`Using Referer: ${referer}`);
  } else {
    log(`No Referer provided — CDN may serve default content`);
  }
  if (cookieHeader) {
    dlHeaders['Cookie'] = cookieHeader;
    log(`Using Cookie (${cookieHeader.length} chars)`);
  } else {
    log(`No Cookie provided — CDN may serve default content`);
  }

  // 注册任务用于取消
  const controller = new AbortController();
  activeDownloads[taskId] = { controller, tmpDir: null, ffmpeg: null };
  let mergeStage = false;

  try {
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    const outputPath = path.join(savePath, filename);
    log(`Download: ${url} → ${outputPath} (mode: ${mode})`);

    // 非重试场景下，如果输出文件已存在则跳过（避免重复下载覆盖已有文件）
    if (!task.cleanTemp && !task.mergeOnly && fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > 0) {
        log(`Output file already exists, skipping download: ${outputPath} (${stat.size} bytes)`);
        const emit = (msg) => sendMessage({ ...msg, taskId });
        emit({ type: 'complete', filePath: outputPath, size: stat.size });
        return;
      }
      // 文件存在但大小为 0 → 删除残留，重新下载
      log(`Output file exists but empty, removing: ${outputPath}`);
      try { fs.unlinkSync(outputPath); } catch {}
    }

    // 检测代理 URL（如 yutujx.com/?url=REAL.m3u8），提取真实地址用于类型检测
    const originalUrl = url;
    let actualUrl = extractProxyUrl(url);
    const isProxy = !!actualUrl;
    if (actualUrl) {
      log(`Extracted proxy URL: ${actualUrl}`);
    } else {
      actualUrl = url;
    }
    // 代理链接：提取真实地址，优先用真实地址下载（附带原始 Referer 鉴权）
    const downloadUrl = actualUrl;
    // 用原始代理 URL 的页面作为 Referer
    if (isProxy && !dlHeaders['Referer']) {
      dlHeaders['Referer'] = originalUrl;
      log(`Using proxy page as Referer: ${originalUrl}`);
    }

    const emit = (msg) => sendMessage({ ...msg, taskId });

    // ── 仅重新合并（分片已下载，只跑 ffmpeg）──
    if (task.mergeOnly) {
      const tmpDir = path.join(savePath, `.tmp_${taskId}`);
      if (!fs.existsSync(tmpDir)) {
        throw new Error('临时文件不存在，请完整重试');
      }
      const existing = fs.readdirSync(tmpDir).filter(f => /^seg_\d+\.ts$/.test(f));
      if (existing.length === 0) {
        throw new Error('没有可合并的分片，请完整重试');
      }
      const tsFiles = existing
        .sort((a, b) => {
          const na = parseInt(a.match(/^seg_(\d+)\.ts$/)[1]);
          const nb = parseInt(b.match(/^seg_(\d+)\.ts$/)[1]);
          return na - nb;
        })
        .map(f => path.join(tmpDir, f));

      log(`Merge-only: found ${tsFiles.length} segments in ${tmpDir}`);
      activeDownloads[taskId].tmpDir = tmpDir;
      mergeStage = true;
      emit({ type: 'progress', percent: 95, downloaded: 0, total: 0, speed: '', eta: '合并中...' });
      await mergeToMp4(tsFiles, outputPath, controller.signal);

      fs.rmSync(tmpDir, { recursive: true, force: true });
      const stat = fs.statSync(outputPath);
      log(`Merge-only complete: ${outputPath} (${stat.size} bytes)`);
      emit({ type: 'complete', filePath: outputPath, size: stat.size });
      return;
    }

    // ── 自动检测直接媒体文件（MP4/WebM 等），直接下载而非当成播放列表 ──
    // 必须在 mode 判断之前：代理链接(如 mp.kkkppp.top/?url=xxx.mp4)提取后可能是 mp4，
    // 如果 mode 是 m3u8 且提取失败，会错误下载代理 HTML 页（KB 级别）
    const DIRECT_VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.mov', '.flv', '.wmv', '.avi', '.ogv', '.ogg'];
    try {
      const urlPath = new URL(actualUrl).pathname.toLowerCase();
      const isDirectMedia = DIRECT_VIDEO_EXTS.some(ext => urlPath.endsWith(ext));
      if (isDirectMedia) {
        log('Direct media file detected, downloading directly');
        emit({ type: 'progress', percent: 0, downloaded: 0, total: 0, speed: '', eta: '' });
        const result = await downloadFile(downloadUrl, outputPath, dlHeaders, controller.signal);
        const stat = fs.statSync(outputPath);
        emit({ type: 'complete', filePath: outputPath, size: stat.size });
        return;
      }
    } catch (e) {
      log('URL parse error in direct media check: ' + e.message);
    }

    // ── 模式 1: 仅下载 m3u8 文件 ──
    if (mode === 'm3u8') {
      emit({ type: 'progress', percent: 0, downloaded: 0, total: 0, speed: '', eta: '' });
      const result = await downloadFile(downloadUrl, outputPath, dlHeaders, controller.signal);
      const stat = fs.statSync(outputPath);
      emit({ type: 'complete', filePath: outputPath, size: stat.size });
      return;
    }

    // ── 模式 2: 下载分片并合并为 MP4 ──
    emit({ type: 'progress', percent: 0, downloaded: 0, total: 0, speed: '', eta: '解析中...' });

    // 1. 获取内容并检测是否为 m3u8 播放列表
    const playlistBuf = await httpGetBuffer(downloadUrl, dlHeaders, controller.signal);
    const content = playlistBuf.toString('utf8');

    // 如果内容不是 m3u8 格式（不以 #EXTM3U 开头），检查响应类型
    if (!/^#EXTM3U/i.test(content.trim())) {
      const head = content.trim().substring(0, 500).toLowerCase();

      // 1. HTML/XML 错误页 → 拒绝
      if (/<html|<body|<head|<script|<!doctype|^<\\?xml/i.test(head)) {
        log('Response is HTML/XML (likely error/auth page), rejecting');
        throw new Error('服务器未返回有效的 m3u8 播放列表（收到网页而非视频内容，可能需要有效的 Cookie 或 Referer）');
      }

      // 2. 编码/加密文本（全部可见 ASCII 字符，非 HTML 非 m3u8）→ CDN 端加密，拒绝
      //    特征：base64 类编码数据，仅含字母数字和 +/= 等，浏览器需通过 JS 解密
      const sample = content.substring(0, 500);
      if (/^[\x20-\x7e\r\n\t]+$/.test(sample)) {
        log('Response is encoded/encrypted text (' + playlistBuf.length + ' bytes), not a valid playlist');
        throw new Error('CDN 返回了加密/编码数据（非 m3u8 格式），浏览器内可能通过 JS 解密。\n请尝试在浏览器中播放视频后，再嗅探 TS 分片地址进行下载');
      }

      // 3. 二进制数据（含不可打印字符）→ 按直链保存
      log('Content is not m3u8, downloading as direct file (' + playlistBuf.length + ' bytes)');
      if (playlistBuf.length < 1024) {
        log('WARNING: Response is very small (' + playlistBuf.length + ' bytes), may not be a valid video');
      }
      fs.writeFileSync(outputPath, playlistBuf);
      const stat = fs.statSync(outputPath);
      emit({ type: 'complete', filePath: outputPath, size: stat.size });
      return;
    }

    // 2. 检测是否为主播放列表（变体播放列表）
    let streamUrl = actualUrl;
    let streamContent = content;

    const nonCommentLines = content.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    if (nonCommentLines.length > 0 && nonCommentLines.every(l => /\.m3u8/i.test(l))) {
      // 主播放列表，选最高码率
      log('Resolving variant playlist...');
      const variants = [];
      const lines = content.split(/\r?\n/);
      let bw = 0;
      for (const line of lines) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        if (bwMatch) bw = parseInt(bwMatch[1]);
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && /\.m3u8/i.test(trimmed)) {
          variants.push({ url: resolveUrl(trimmed, actualUrl), bandwidth: bw });
        }
      }
      if (variants.length > 0) {
        const best = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
        streamUrl = best.url;
        log(`Selected: ${best.bandwidth} bps → ${streamUrl}`);
        const buf = await httpGetBuffer(streamUrl, dlHeaders, controller.signal);
        streamContent = buf.toString('utf8');
      }
    }

    // 3. 解析分片
    const segments = parseM3U8(streamContent, streamUrl);
    log(`Parsed ${segments.length} segments`);
    if (segments.length === 0) {
      throw new Error('未在 m3u8 中找到任何分片');
    }

    // 4. 创建临时目录（重试时清除旧的残留文件）
    const tmpDir = path.join(savePath, `.tmp_${taskId}`);
    activeDownloads[taskId].tmpDir = tmpDir; // 记录临时目录以便取消时清理

    if (task.cleanTemp) {
      // 清除旧临时目录
      if (fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          log('Cleaned old temp dir for retry');
        } catch (e) {
          log('Failed to clean old temp dir: ' + e.message);
        }
      }
      // 清除上次合并失败残留的输出文件
      try { fs.unlinkSync(outputPath); } catch {}
    }
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 扫描已下载的分片（断点续传）
    let existingFiles = new Set();
    try {
      const existing = fs.readdirSync(tmpDir);
      for (const f of existing) {
        const m = f.match(/^seg_(\d+)\.ts$/);
        if (m) {
          const idx = parseInt(m[1]);
          const stat = fs.statSync(path.join(tmpDir, f));
          if (stat.size > 0) existingFiles.add(idx);
        }
      }
    } catch {}
    if (existingFiles.size > 0) {
      log(`Found ${existingFiles.size} existing segments in ${tmpDir}`);
    }

    // 5. 下载所有分片
    let cancelled = false;
    const results = await downloadAllSegments(
      segments, tmpDir, dlHeaders,
      (percent, downloaded, total, speed, eta) => {
        emit({ type: 'progress', percent, downloaded, total, speed, eta });
      },
      () => cancelled,
      existingFiles,
      controller.signal
    );

    const okFiles = results.filter(r => r.ok).map(r => r.file);
    const failedCount = results.filter(r => !r.ok).length;

    if (stdoutBroken) {
      log('stdout broken, aborting download');
      return;
    }

    if (okFiles.length === 0) {
      throw new Error('所有分片下载失败');
    }

    if (failedCount > 0) {
      // 有分片下载失败 → 不合并，保留临时文件供重试
      throw new Error(`${failedCount}/${segments.length} 个分片下载失败，请重试（已下载的分片会保留）`);
    }

    log(`Downloaded ${okFiles.length}/${segments.length} segments`);

    // 6. 合并为 mp4
    mergeStage = true;
    emit({ type: 'progress', percent: 95, downloaded: 0, total: 0, speed: '', eta: '合并中...' });

    await mergeToMp4(okFiles, outputPath, controller.signal);

    // 7. 清理
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      log('Cleanup warning: ' + e.message);
    }

    const stat = fs.statSync(outputPath);
    log(`Complete: ${outputPath} (${stat.size} bytes)`);

    emit({ type: 'complete', filePath: outputPath, size: stat.size });
  } catch (err) {
    if (err.message === 'CANCELLED') {
      log('Download cancelled by user: ' + taskId);
      sendMessage({
        type: 'error',
        taskId: taskId,
        error: '用户取消'
      });
    } else {
      log('Download error: ' + err.message + (mergeStage ? ' (merge stage)' : ''));
      sendMessage({
        type: 'error',
        taskId: taskId,
        error: err.message,
        mergeFailed: mergeStage
      });
    }
  } finally {
    delete activeDownloads[taskId];
  }
}

// ── 主循环 ──
async function main() {
  log('Native host started, pid=' + process.pid + ', stdin isPaused=' + process.stdin.isPaused());

  while (true) {
    let msg;
    log('Entering readMessage wait...');
    try {
      msg = await readMessage();
    } catch (e) {
      log('Read error: ' + e.message);
      break;
    }

    if (!msg) {
      log('stdin closed, waiting for ' + runningTasks.size + ' running task(s)');
      await waitForRunningTasks();
      log('stdin closed, exiting main loop');
      break;
    }

    log('readMessage returned, action=' + (msg.action || 'unknown'));

    if (msg.action === 'download') {
      trackTask(doDownload(msg)).catch(err => {
        log('Download error: ' + err.message);
        sendMessage({
          type: 'error',
          taskId: msg.taskId,
          error: err.message
        });
      });
    }

    if (msg.action === 'cancel') {
      cancelTask(msg.taskId);
      sendMessage({ type: 'cancelled', taskId: msg.taskId });
    }

    if (msg.action === 'pickFolder') {
      try {
        const psScript = [
          '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms',
          '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
          "$d.Description='Choose save directory'",
          '$d.ShowNewFolderButton=$true',
          '$d.RootFolder="MyComputer"',
          "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.SelectedPath}else{''}"
        ].join(';');
        const result = execSync(`powershell -STA -NoProfile -Command "${psScript}"`, {
          encoding: 'utf8',
          timeout: 120000
        }).trim();
        log('Pick folder result: ' + (result || '(cancelled)'));
        sendMessage({ type: 'folderPicked', path: result || null });
      } catch (e) {
        log('Pick folder error: ' + e.message);
        sendMessage({ type: 'error', error: e.message });
      }
    }

    if (msg.action === 'openFolder') {
      const folderPath = msg.path;
      try {
        const { exec } = require('child_process');
        exec(`explorer "${folderPath}"`);
        sendMessage({ type: 'folderOpened', path: folderPath });
      } catch (e) {
        log('Open folder error: ' + e.message);
        sendMessage({ type: 'error', error: e.message });
      }
    }

    if (msg.action === 'deleteFiles') {
      const files = msg.files || [];
      const results = [];
      for (const file of files) {
        try {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            results.push({ path: file, deleted: true });
            log('Deleted file: ' + file);
          } else {
            results.push({ path: file, deleted: false, reason: 'not_found' });
          }
        } catch (e) {
          results.push({ path: file, deleted: false, reason: e.message });
          log('Delete failed: ' + file + ' - ' + e.message);
        }
      }
      sendMessage({ type: 'filesDeleted', results });
    }

    if (msg.action === 'ping') {
      sendMessage({ type: 'pong' });
    }
  }

  log('Native host exiting');
}

main().catch(err => {
  log('Fatal: ' + err.message);
  sendMessage({ type: 'error', error: 'Fatal: ' + err.message });
  process.exit(1);
});
