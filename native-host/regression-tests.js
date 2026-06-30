const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function sendNativeMessage(child, msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.end(Buffer.concat([header, body]));
}

function readNativeMessages(stream) {
  let buffer = Buffer.alloc(0);
  const messages = [];
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      messages.push(JSON.parse(buffer.slice(4, 4 + len).toString('utf8')));
      buffer = buffer.slice(4 + len);
    }
  });
  return messages;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function runHostDownload(task) {
  const child = spawn(process.execPath, [path.join(__dirname, 'host.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const messages = readNativeMessages(child.stdout);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  sendNativeMessage(child, task);

  await new Promise((resolve) => child.on('exit', resolve));
  return { messages, stderr };
}

async function testEncryptedSegmentsAreDecryptedBeforeValidation() {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const ivHex = '00000000000000000000000000000001';
  const iv = Buffer.from(ivHex, 'hex');
  const plainTs = Buffer.concat([
    Buffer.from([0x47]),
    Buffer.alloc(187, 0)
  ]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encryptedTs = Buffer.concat([cipher.update(plainTs), cipher.final()]);
  assert.notStrictEqual(encryptedTs[0], 0x47, 'test fixture must look encrypted');

  const server = http.createServer((req, res) => {
    if (req.url === '/key.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(key);
      return;
    }
    if (req.url === '/seg0.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end(encryptedTs);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });

  const port = await listen(server);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-sniffer-test-'));
  try {
    const base = `http://127.0.0.1:${port}`;
    const outName = 'encrypted-output.mp4';
    const result = await runHostDownload({
      action: 'downloadUrls',
      taskId: 'encrypted-regression',
      urls: [`${base}/seg0.ts`],
      segments: [{
        url: `${base}/seg0.ts`,
        keyUri: `${base}/key.bin`,
        keyIv: ivHex
      }],
      filename: outName,
      savePath: tmpDir,
      referer: 'http://example.test/page'
    });

    const error = result.messages.find((msg) => msg.type === 'error');
    assert.ok(error, 'expected fake TS fixture to fail at merge stage');
    assert.strictEqual(error.mergeFailed, true, 'encrypted segment should download/decrypt before merge');
    assert.ok(!/Invalid TS data|所有分片下载失败/.test(error.error), error.error);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

(async () => {
  await testEncryptedSegmentsAreDecryptedBeforeValidation();
  console.log('regression tests passed');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
