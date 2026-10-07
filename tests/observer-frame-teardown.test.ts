import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';

const observerFile = new URL('../desktop/sportsurge-observer.cjs', import.meta.url);
const observerRequire = createRequire(observerFile);
const source = readFileSync(observerFile, 'utf8');
const loadSlot = runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout,setInterval,clearInterval){
  ${source}
  return createObserverSlot;
})`);

type RequestHook = (details: unknown, callback: (result: unknown) => void) => void;

function createObserverHarness(mainFrame: { framesInSubtree: unknown[] },
  frameLookup: () => object | null = () => null) {
  let tick: (() => void) | undefined;
  const windows: FakeWindow[] = [];
  let beforeRequest: RequestHook | undefined;
  let beforeSendHeaders: RequestHook | undefined;
  let headersReceived: RequestHook | undefined;
  class FakeWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame,
      setAudioMuted() {},
      setWindowOpenHandler() {},
    });
    constructor() { super(); windows.push(this); }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const sourceSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    webRequest: {
      onBeforeRequest(callback: RequestHook) { beforeRequest = callback; },
      onBeforeSendHeaders(callback: RequestHook) { beforeSendHeaders = callback; },
      onHeadersReceived(callback: RequestHook) { headersReceived = callback; },
    },
  };
  const createSlot = loadSlot(
    (id: string) => id === 'electron'
      ? { BrowserWindow: FakeWindow, session: { fromPartition: () => sourceSession },
        webFrameMain: { fromId: frameLookup } }
      : observerRequire(id),
    { exports: {} }, {},
    () => 0, () => {}, (callback: () => void) => { tick = callback; return 0; }, () => {},
  );
  return {
    observer: createSlot(0),
    tick() { assert.equal(typeof tick, 'function'); tick?.(); },
    window() { const window = windows.at(-1); assert.ok(window); return window; },
    request(details: unknown) {
      assert.ok(beforeRequest);
      let admitted: unknown;
      beforeRequest(details, result => { admitted = result; });
      assert.deepEqual(admitted, { cancel: false });
    },
    sendHeaders(details: unknown) {
      assert.ok(beforeSendHeaders);
      beforeSendHeaders(details, () => {});
    },
    receiveHeaders(details: unknown) {
      assert.ok(headersReceived);
      headersReceived(details, () => {});
    },
  };
}

test('the observer keeps scanning one live player while Electron tears down sibling iframes', async () => {
  let playerChecks = 0;
  const player = {
    url: 'https://ch.aianimalvibes.com/football/728',
    isDestroyed: () => false,
    executeJavaScript: () => { playerChecks++; return Promise.resolve(false); },
  };
  const destroyed = {
    isDestroyed: () => true,
    get url(): string { throw new Error('destroyed frame URL accessed'); },
  };
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [null, destroyed, player] };
  const harness = createObserverHarness(mainFrame);
  const operation = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  assert.doesNotThrow(() => harness.tick());
  assert.equal(playerChecks, 1);

  const secondPlayer = { ...player, executeJavaScript: () => Promise.resolve(false) };
  mainFrame.framesInSubtree = [null, player, secondPlayer];
  harness.tick();
  assert.equal(playerChecks, 1);
  operation.cancel();
  assert.equal(await operation.promise, null);
});

test('a removed sibling does not break selected StreamEast player uniqueness', async () => {
  const playerUrl = 'https://dlive.sx/stream/stream-44.php';
  const selected: { parent?: object; url: string; isDestroyed: () => boolean } = {
    url: playerUrl, isDestroyed: () => false,
  };
  const destroyed: { parent: object | null; url: string; isDestroyed: () => boolean } = {
    parent: null, url: playerUrl, isDestroyed: () => true,
  };
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [null, destroyed, selected] };
  selected.parent = mainFrame;
  destroyed.parent = mainFrame;
  const harness = createObserverHarness(mainFrame, () => selected);
  const selection: { playerUrl: string; playerFrame?: object } = { playerUrl };
  const operation = harness.observer.observe('https://v2.streameast.ga/nfl/falcons-vs-saints-1/2',
    'probe', undefined, selection);
  assert.ok(operation);
  harness.window().webContents.emit('did-frame-navigate', {}, playerUrl, 200, '', false, 1, 2);
  assert.equal(selection.playerFrame, selected);
  operation.cancel();
  assert.equal(await operation.promise, null);

  const second = { parent: mainFrame, url: playerUrl, isDestroyed: () => false };
  mainFrame.framesInSubtree = [null, selected, second];
  const secondSelection: { playerUrl: string; playerFrame?: object } = { playerUrl };
  const another = harness.observer.observe('https://v2.streameast.ga/nfl/falcons-vs-saints-1/2',
    'probe', undefined, secondSelection);
  assert.ok(another);
  harness.window().webContents.emit('did-frame-navigate', {}, playerUrl, 200, '', false, 1, 2);
  assert.equal(secondSelection.playerFrame, undefined);
  assert.equal(await another.promise, null);
});

test('a media probe finds the valid player next to a removed iframe', async () => {
  const mediaUrl = 'https://player.example/live.m3u8';
  const player = {
    url: 'https://player.example/watch',
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve(true),
  };
  const harness = createObserverHarness({ framesInSubtree: [null, player] });
  const operation = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  harness.request({ id: 1, url: mediaUrl, resourceType: 'media' });
  harness.sendHeaders({ id: 1, url: mediaUrl, requestHeaders: {
    referer: player.url, 'user-agent': 'Observer test',
  }, initiatorOrigin: 'https://player.example' });
  harness.receiveHeaders({ id: 1, url: mediaUrl, statusCode: 200, responseHeaders: {
    'content-type': ['application/vnd.apple.mpegurl'],
  } });
  const result = await operation.promise;
  assert.equal(result?.url, mediaUrl);
  assert.equal(result?.referer, player.url);
});

test('a disposed native frame tree ends a media probe without an unhandled rejection', async () => {
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [] };
  Object.defineProperty(mainFrame, 'framesInSubtree', {
    get() { throw new Error('native frame tree disposed'); },
  });
  const harness = createObserverHarness(mainFrame);
  const operation = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  const mediaUrl = 'https://player.example/live.m3u8';
  harness.request({ id: 1, url: mediaUrl, resourceType: 'media' });
  harness.sendHeaders({ id: 1, url: mediaUrl, requestHeaders: {
    referer: 'https://player.example/watch', 'user-agent': 'Observer test',
  }, initiatorOrigin: 'https://player.example' });
  harness.receiveHeaders({ id: 1, url: mediaUrl, statusCode: 200, responseHeaders: {
    'content-type': ['application/vnd.apple.mpegurl'],
  } });
  assert.equal(await operation.promise, null);
});
