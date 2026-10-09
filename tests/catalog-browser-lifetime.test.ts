import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const providers = [
  { name: 'sportsurge', url: 'https://v2.sportsurge.net/watch-cfb-streams/', partition: 'sportsurge-catalog' },
  { name: 'streameast', url: 'https://v2.streameast.ga/cfb-streams/', partition: 'streameast-catalog' },
];

for (const provider of providers) {
  function fixture(options: { destroyThrows?: boolean; destroyReenters?: boolean; noRead?: boolean; fail?: boolean;
    stalled?: boolean; pendingScript?: boolean; rendererGone?: boolean } = {}) {
    const file = resolve(`desktop/${provider.name}-collector.cjs`);
    const actualRequire = createRequire(file);
    const windows: Array<{ destroyed: boolean; destroyCalls: number; partition: string;
      webContents: EventEmitter; destroy: () => void }> = [];
    let reads = 0;
    let sweeps = 0;
    let lateRead: ((signal: AbortSignal) => Promise<string>) | undefined;
    let releaseRead: (() => void) | undefined;
    let releaseScript: (() => void) | undefined;
    let readEntered: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { readEntered = resolve; });
    let overlapOnDestroy: Promise<unknown> | undefined;
    const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} };
    function BrowserWindow(optionsForWindow: { webPreferences: { partition: string } }) {
      const contents = new EventEmitter();
      let url = '';
      Object.assign(contents, {
        setAudioMuted() {}, setWindowOpenHandler() {}, getURL() { return url; }, getTitle() { return ''; }, stop() {},
        executeJavaScript(script: string) {
          if (options.pendingScript) {
            options.pendingScript = false;
            readEntered?.();
            return new Promise(resolve => { releaseScript = () => resolve({ url, title: '', ready: true }); });
          }
          return Promise.resolve(script === 'document.documentElement.outerHTML' ? '<html>fixture</html>' : { url, title: '', ready: true });
        },
        mainFrame: { executeJavaScript(script: string) {
          if (options.pendingScript) {
            options.pendingScript = false;
            readEntered?.();
            return new Promise(resolve => { releaseScript = () => resolve({ url, title: '', cards: 1, empty: false, detail: false }); });
          }
          if (script === 'document.documentElement.outerHTML') return Promise.resolve('<html>fixture</html>');
          if (script.includes('more:')) return Promise.resolve({ count: 1, more: false });
          return Promise.resolve({ url, title: '', cards: 1, empty: false, detail: false });
        } },
      });
      const window = {
        destroyed: false, destroyCalls: 0, partition: optionsForWindow.webPreferences.partition,
        webContents: contents,
        isDestroyed() { return this.destroyed; },
        destroy() {
          this.destroyCalls++;
          if (options.destroyReenters) overlapOnDestroy = collector.requestSweep();
          if (options.destroyThrows) { options.destroyThrows = false; throw new Error('destroy failed'); }
          this.destroyed = true;
        },
        loadURL(target: string) {
          url = target;
          contents.emit('did-frame-navigate', null, target, 200, null, true);
          contents.emit('dom-ready');
          return Promise.resolve();
        },
      };
      windows.push(window);
      return window;
    }
    const exported = { exports: {} };
    const sweepName = provider.name === 'sportsurge' ? 'runSportsurgeSweep' : 'runStreameastSweep';
    const createName = provider.name === 'sportsurge' ? 'createSportsurgeCollector' : 'createStreameastCollector';
    runInNewContext(readFileSync(file, 'utf8'), {
      module: exported, Buffer, AbortController, AbortSignal, URL, setTimeout, clearTimeout,
      require: (id: string) => {
        if (id === 'electron') return { BrowserWindow, session: { fromPartition: () => session } };
        if (id === `./${provider.name}-catalog.cjs`) return {
          ORIGIN: new URL(provider.url).origin, CATEGORY_URLS: { ncaaf: provider.url }, CATEGORIES: { ncaaf: { emptyTitles: [] } },
          MAX_PAGE_BYTES: 100000, MAX_CHECKPOINT_BYTES: 100000, detailUrl: () => null, eventUrl: () => null,
        };
        if (id === `./${provider.name}-sweep.cjs`) return { [sweepName]: async ({ read, signal }: {
          read: (url: string, page: string, league: string, signal: AbortSignal) => Promise<string>; signal: AbortSignal;
        }) => {
          sweeps++;
          lateRead = currentSignal => read(provider.url, 'category', 'ncaaf', currentSignal);
          if (!options.noRead) {
            reads++;
            await read(provider.url, 'category', 'ncaaf', signal);
            readEntered?.();
            if (options.stalled) await new Promise<void>(resolve => { releaseRead = resolve; });
            reads++;
            await read(provider.url, 'category', 'ncaaf', signal);
          }
          if (options.rendererGone) windows.at(-1)?.webContents.emit('render-process-gone');
          if (options.fail) throw new Error('publish failed');
          return { state: { kind: 'complete' } };
        } };
        return actualRequire(id);
      },
    });
    const create = Reflect.get(exported.exports, createName);
    const collector = create({ origin: 'http://127.0.0.1:1', controlToken: 'unused' });
    return { collector, windows, entered, release: () => { releaseRead?.(); releaseScript?.(); },
      get reads() { return reads; }, get sweeps() { return sweeps; },
      get overlapOnDestroy() { return overlapOnDestroy; }, lateRead: () => lateRead?.(new AbortController().signal) };
  }

  test(`${provider.name} releases one window after all reads and uses its partition again`, async () => {
    const run = fixture();
    try {
      await run.collector.requestSweep();
      assert.equal(run.reads, 2);
      assert.equal(run.windows.length, 1);
      assert.equal(run.windows[0].destroyed, true);
      assert.equal(run.windows[0].destroyCalls, 1);
      await run.collector.requestSweep();
      assert.equal(run.windows.length, 2);
      assert.deepEqual(run.windows.map(window => window.partition), [provider.partition, provider.partition]);
      assert.equal(run.windows[1].destroyed, true);
    } finally { run.collector.stop(); }
  });

  test(`${provider.name} releases on failure and leaves a no-read sweep windowless`, async () => {
    const failed = fixture({ fail: true });
    const empty = fixture({ noRead: true });
    try {
      await failed.collector.requestSweep();
      assert.equal(failed.windows.length, 1);
      assert.equal(failed.windows[0].destroyed, true);
      await empty.collector.requestSweep();
      assert.equal(empty.windows.length, 0);
    } finally { failed.collector.stop(); empty.collector.stop(); }
  });

  test(`${provider.name} joins overlap, and stop rejects late reads and stays terminal`, async () => {
    const run = fixture({ stalled: true });
    try {
      const first = run.collector.requestSweep();
      await run.entered;
      assert.equal(run.collector.requestSweep(), first);
      assert.equal(run.sweeps, 1);
      run.collector.stop();
      assert.equal(run.windows[0].destroyCalls, 1);
      await assert.rejects(run.lateRead(), /unavailable/);
      run.release();
      await first;
      assert.equal(run.windows.length, 1);
      assert.equal(run.windows[0].destroyCalls, 1);
      assert.equal(run.collector.requestSweep(), undefined);
      run.collector.start();
      assert.equal(run.sweeps, 1);
    } finally { run.release(); run.collector.stop(); }
  });

  test(`${provider.name} retries a failed destroy without allocating another live window`, async () => {
    const run = fixture({ destroyThrows: true });
    try {
      await run.collector.requestSweep();
      assert.equal(run.windows[0].destroyed, false);
      await run.collector.requestSweep();
      assert.equal(run.sweeps, 2);
      assert.equal(run.windows.length, 1);
      assert.equal(run.windows[0].destroyCalls, 2);
      assert.equal(run.windows[0].destroyed, true);
    } finally { run.collector.stop(); }
  });

  test(`${provider.name} keeps admission during synchronous destroy reentry`, async () => {
    const run = fixture({ destroyReenters: true });
    try {
      const first = run.collector.requestSweep();
      await first;
      assert.equal(run.overlapOnDestroy, first);
      assert.equal(run.sweeps, 1);
      await run.collector.requestSweep();
      assert.equal(run.sweeps, 2);
    } finally { run.collector.stop(); }
  });

  test(`${provider.name} stop during pending renderer work rejects stale admission`, async () => {
    const run = fixture({ pendingScript: true });
    try {
      const first = run.collector.requestSweep();
      await run.entered;
      run.collector.stop();
      run.release();
      await first;
      await assert.rejects(run.lateRead(), /unavailable/);
      assert.equal(run.windows.length, 1);
      assert.equal(run.windows[0].destroyCalls, 1);
      assert.equal(run.collector.requestSweep(), undefined);
    } finally { run.release(); run.collector.stop(); }
  });

  test(`${provider.name} releases a window after renderer loss`, async () => {
    const run = fixture({ rendererGone: true });
    try {
      await run.collector.requestSweep();
      assert.equal(run.windows[0].destroyed, true);
    } finally { run.collector.stop(); }
  });
}
