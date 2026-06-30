const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeBlob {
  constructor(parts = [], options = {}) {
    this.parts = parts;
    this.type = options.type || '';
    this.size = parts.reduce((total, part) => {
      if (typeof part === 'string') return total + Buffer.byteLength(part);
      if (part instanceof ArrayBuffer) return total + part.byteLength;
      if (ArrayBuffer.isView(part)) return total + part.byteLength;
      return total;
    }, 0);
  }

  async text() {
    return this.parts.map((part) => {
      if (typeof part === 'string') return part;
      if (part instanceof ArrayBuffer) return Buffer.from(part).toString('utf8');
      if (ArrayBuffer.isView(part)) return Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString('utf8');
      return '';
    }).join('');
  }
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createContext() {
  const messages = [];
  const fakeUrl = function URLShim(value, base) {
    return new URL(value, base);
  };
  fakeUrl.createObjectURL = () => 'blob:https://example.test/playlist';

  const context = {
    Blob: FakeBlob,
    TextDecoder,
    URL: fakeUrl,
    XMLHttpRequest: null,
    clearTimeout,
    console,
    fetch: undefined,
    location: { href: 'https://example.test/watch' },
    setTimeout,
    window: null
  };
  context.window = context;
  context.window.postMessage = (message) => messages.push(message);
  return { context, messages };
}

function loadInject(context) {
  const source = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'inject.js' });
}

async function testBlobConstructorReportsPlaylistText() {
  const { context, messages } = createContext();
  loadInject(context);

  new context.window.Blob(['#EXTM3U\n#EXTINF:1,\nseg0.ts\n']);
  await wait();

  assert.ok(messages.some((message) => message.type === 'M3U8_DECRYPTED'), 'Blob playlist text should be reported');
}

async function testCreateObjectUrlReportsPlaylistBlob() {
  const { context, messages } = createContext();
  loadInject(context);

  const blob = new context.window.Blob(['#EXTM3U\n#EXTINF:1,\nseg0.ts\n']);
  context.window.URL.createObjectURL(blob);
  await wait();

  assert.ok(messages.some((message) => message.type === 'M3U8_DECRYPTED'), 'createObjectURL playlist blobs should be reported');
}

async function testHlsLoadSourceReportsInlinePlaylist() {
  const { context, messages } = createContext();
  loadInject(context);

  context.window.Hls = function Hls() {};
  context.window.Hls.prototype.loadSource = function loadSource() {};
  context.window.Hls.prototype.loadSource('#EXTM3U\n#EXTINF:1,\nseg0.ts\n');
  await wait();

  assert.ok(messages.some((message) => message.type === 'M3U8_DECRYPTED'), 'hls.js inline playlist should be reported');
}

(async () => {
  await testBlobConstructorReportsPlaylistText();
  await testCreateObjectUrlReportsPlaylistBlob();
  await testHlsLoadSourceReportsInlinePlaylist();
  console.log('inject regression tests passed');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
