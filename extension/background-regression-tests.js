const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createChromeMock() {
  const listeners = [];
  const messageListeners = [];
  const storedLists = [];
  const sentMessages = [];
  const addListener = (fn) => listeners.push(fn);

  const chromeMock = {
    __messageListeners: messageListeners,
    __storedLists: storedLists,
    __sentMessages: sentMessages,
    cookies: {
      getAll(_query, cb) {
        cb([]);
      }
    },
    runtime: {
      connectNative() {
        return {
          onMessage: { addListener },
          onDisconnect: { addListener },
          postMessage() {},
          disconnect() {}
        };
      },
      lastError: null,
      onInstalled: { addListener },
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        }
      },
      sendMessage(message) {
        sentMessages.push(message);
        return Promise.resolve();
      }
    },
    scripting: {
      executeScript() {
        return Promise.resolve();
      }
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({});
        },
        set() {}
      }
    },
    tabs: {
      get(_tabId, cb) {
        cb({ url: 'https://example.test/page' });
      },
      onUpdated: { addListener },
      query(_query, cb) {
        cb([]);
      }
    },
    webRequest: {
      onBeforeRequest: { addListener },
      onBeforeSendHeaders: { addListener },
      onHeadersReceived: { addListener }
    }
  };
  chromeMock.storage.local.set = (data) => {
    if (Array.isArray(data.m3u8_list)) storedLists.push(data.m3u8_list);
  };
  return chromeMock;
}

function loadBackgroundWith(chromeMock) {
  const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  vm.runInNewContext(source, {
    URL,
    chrome: chromeMock,
    console,
    fetch,
    Promise,
    setTimeout
  }, { filename: 'background.js' });
}

function testBackgroundLoadsWithoutWebNavigationApi() {
  const chromeMock = createChromeMock();
  assert.strictEqual(chromeMock.webNavigation, undefined);
  assert.doesNotThrow(() => loadBackgroundWith(chromeMock));
}

function testPageReportedM3u8IsStored() {
  const chromeMock = createChromeMock();
  loadBackgroundWith(chromeMock);

  const listener = chromeMock.__messageListeners[0];
  assert.ok(listener, 'background onMessage listener should be registered');
  listener(
    { type: 'M3U8_FOUND', url: 'https://cdn.example.test/hls/index.m3u8?token=abc' },
    { tab: { id: 7, url: 'https://example.test/watch' } },
    () => {}
  );

  const latestList = chromeMock.__storedLists.at(-1) || [];
  assert.strictEqual(latestList.length, 1);
  assert.strictEqual(latestList[0].url, 'https://cdn.example.test/hls/index.m3u8?token=abc');
  assert.strictEqual(latestList[0].tabId, 7);
}

testBackgroundLoadsWithoutWebNavigationApi();
testPageReportedM3u8IsStored();
console.log('background regression tests passed');
