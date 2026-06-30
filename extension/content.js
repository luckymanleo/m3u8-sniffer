// 从 DOM 层面检测视频源
(function () {
  const VIDEO_EXTS = new Set(['m3u8','mp4','webm','mkv','mov','flv','wmv','avi','ogv','ogg']);
  const KEYWORD_RE = /\/hls\/|\/m3u8\//i;

  // ── 导航到新页面时清空当前 Tab 的旧 URL，防止跨页面残留 ──
  chrome.runtime.sendMessage({ type: 'CLEAR_LIST' }).catch(() => {});

  function isVideoSrc(src) {
    if (!src) return false;
    try {
      const path = new URL(src).pathname;
      const lastSegment = path.split('/').pop() || '';
      const dotIndex = lastSegment.lastIndexOf('.');
      if (dotIndex >= 0) {
        const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
        return ext !== 'ts' && VIDEO_EXTS.has(ext);
      }
    } catch {}
    return KEYWORD_RE.test(src);
  }

  function checkElement(el) {
    const src = el.src || el.getAttribute('src');
    if (isVideoSrc(src)) {
      chrome.runtime.sendMessage({
        type: 'M3U8_FOUND',
        url: src
      }).catch(() => {});
    }

    const sources = el.querySelectorAll('source');
    sources.forEach(s => {
      const ssrc = s.src || s.getAttribute('src');
      if (isVideoSrc(ssrc)) {
        chrome.runtime.sendMessage({
          type: 'M3U8_FOUND',
          url: ssrc
        }).catch(() => {});
      }
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
          checkElement(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('video, audio').forEach(checkElement);
        }
      });

      if (m.type === 'attributes' && m.attributeName === 'src') {
        checkElement(m.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  });

  document.querySelectorAll('video, audio').forEach(checkElement);

  // ── 解析 <script type="application/ld+json"> 中的 contentUrl ──
  function extractFromJSONLD() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const url = data.contentUrl || (data.mainEntity && data.mainEntity.contentUrl);
        if (url && /\.m3u8(\?|$)/i.test(url)) {
          chrome.runtime.sendMessage({
            type: 'M3U8_FOUND',
            url
          }).catch(() => {});
        }
      } catch {}
    }
  }

  // 页面已加载完毕时直接扫描；否则等待 DOM 完成
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    extractFromJSONLD();
  } else {
    document.addEventListener('DOMContentLoaded', extractFromJSONLD);
  }

  // MutationObserver 捕获动态注入的 JSON-LD
  const jsonldObserver = new MutationObserver(() => {
    if (document.querySelector('script[type="application/ld+json"]')) {
      extractFromJSONLD();
    }
  });
  jsonldObserver.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'M3U8_FOUND' && e.data.url) {
      chrome.runtime.sendMessage({
        type: 'M3U8_FOUND',
        url: e.data.url
      }).catch(() => {});
    }
  });
})();
