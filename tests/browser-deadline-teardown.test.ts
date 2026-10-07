import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const file = resolve('desktop/sportsurge-collector.cjs');
const source = readFileSync(file, 'utf8');
const nativeRequire = createRequire(file);

test('a destroyed Sportsurge window settles its deadline and the next sweep creates a new window', async () => {
  const timers = new Map<number, { work: () => void; ms: number }>();
  let timerId = 0;
  let scriptStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { scriptStarted = resolve; });
  const windows: Window[] = [];
  class Window extends EventEmitter {
    destroyed = false;
    loadedUrl = '';
    stopFailed = false;
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.loadedUrl,
      getTitle: () => '',
      setAudioMuted() {},
      setWindowOpenHandler() {},
      stop: () => {
        if (this.destroyed && !this.stopFailed) {
          this.stopFailed = true;
          throw new Error('Object has been destroyed');
        }
      },
      executeJavaScript: (script: string) => {
        if (windows[0] === this) {
          scriptStarted?.();
          return new Promise(() => {});
        }
        if (script === 'document.documentElement.outerHTML') return Promise.resolve('<html></html>');
        return Promise.resolve({ url: this.loadedUrl, title: '', ready: true });
      },
    });
    constructor() { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadURL(url: string) {
      this.loadedUrl = url;
      this.webContents.emit('did-frame-navigate', {}, url, 200, '', true);
      this.webContents.emit('dom-ready');
      return Promise.resolve();
    }
  }
  const sourceSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} };
  const exported = { exports: {} };
  const categoryUrl = nativeRequire('./sportsurge-catalog.cjs').CATEGORY_URLS.nfl;
  let attempts = 0;
  runInNewContext(source, {
    module: exported,
    require: (id: string) => id === 'electron'
      ? { BrowserWindow: Window, session: { fromPartition: () => sourceSession } }
      : id === './sportsurge-sweep.cjs'
        ? { runSportsurgeSweep: async ({ read, signal }: {
          read: (url: string, page: string, league: string, signal: AbortSignal) => Promise<string>;
          signal: AbortSignal;
        }) => {
          attempts++;
          try {
            await read(categoryUrl, 'category', 'nfl', signal);
            return { state: { kind: 'complete' } };
          } catch {
            return { state: { kind: 'partial', reason: 'timeout' } };
          }
        } }
        : nativeRequire(id),
    Date, URL, Buffer, AbortController, AbortSignal,
    setTimeout: (work: () => void, ms: number) => {
      const id = ++timerId;
      timers.set(id, { work, ms });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const createCollector = Reflect.get(exported.exports, 'createSportsurgeCollector');
  const collector = createCollector({ origin: 'http://127.0.0.1:1', controlToken: 'unused', readyTimeoutMs: 1000 });
  try {
    const first = collector.requestSweep();
    await started;
    windows[0].destroy();
    const deadline = [...timers.values()].find(timer => timer.ms > 0 && timer.ms <= 1000);
    assert.ok(deadline);
    assert.doesNotThrow(() => deadline.work());
    await Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error('sweep stayed pending')), 100)),
    ]);
    const second = collector.requestSweep();
    await Promise.race([
      second,
      new Promise((_, reject) => setTimeout(() => reject(new Error('second sweep stayed pending')), 100)),
    ]);
    assert.equal(windows.length, 2);
    assert.equal(attempts, 2);
  } finally {
    collector.stop();
    timers.clear();
  }
});

for (const path of ['timeout', 'abort'] as const) {
  test(`a destroyed Sportsurge window still settles the ${path} wait`, async () => {
    let deadline: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    const exported = { exports: {} };
    runInNewContext(`${source}\nmodule.exports.beforeDeadline = beforeDeadline;`, {
      module: exported, require: nativeRequire,
      Date, setTimeout: (work: () => void) => { deadline = work; return 1; }, clearTimeout() {},
    });
    const beforeDeadline = Reflect.get(exported.exports, 'beforeDeadline');
    const signal = {
      addEventListener(_name: string, listener: () => void) { onAbort = listener; },
      removeEventListener() {},
    };
    const current = {
      isDestroyed: () => true,
      webContents: { stop() { throw new Error('Object has been destroyed'); } },
    };
    const pending = beforeDeadline(new Promise(() => {}), Date.now() + 1000, signal, current)
      .then(() => 'resolved', (error: Error) => error.message);
    const trigger = path === 'timeout' ? deadline : onAbort;
    assert.ok(trigger);
    assert.doesNotThrow(trigger);
    const result = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => resolve('stalled'), 100)),
    ]);
    assert.equal(result, path === 'timeout' ? 'timeout' : 'unavailable');
  });
}
