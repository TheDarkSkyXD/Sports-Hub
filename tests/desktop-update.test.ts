import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  FailureReasonSchema, UpdateFeedUrlSchema, UpdateStateSchema, UpdateStatusSchema, parseUpdateFeedUrl, updateCommands,
  type UpdateStatus,
} from '../lib/desktop-update.ts';

// The state machine and the failure vocabulary are duplicated in `desktop/update.cjs`,
// because `eslint.config.mjs` forbids `desktop/**/*.cjs` from importing `lib/`. If the two
// ever disagree the app accepts a command the panel cannot offer, or hides a reason it
// cannot render, so both are asserted from here.
const require = createRequire(import.meta.url);
const updateModule = require('../desktop/update.cjs');
const { reduce, commandsFor, updateCommands: engineCommands, failureReasons } = updateModule;

const DEFAULT_FEED = 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
const at = Date.UTC(2026, 8, 30, 12, 0, 0);

function event(type: string, extra: Record<string, unknown> = {}) {
  return { type, at, release: null, ...extra };
}

/**
 * A stand-in for `NsisUpdater`.
 *
 * The engine is driven entirely through this object's methods and events, so every path
 * through the machine can be exercised without a network, a disk, or an installer. The
 * fake reports through the same events the real one does, which is the whole contract: a
 * fake that only returned values would not exercise the path the engine depends on.
 */
class FakeUpdater extends EventEmitter {
  checks = 0;
  downloads = 0;
  installs: { isSilent: boolean; isForceRunAfter: boolean }[] = [];
  feeds: (string | null)[] = [];
  checkResult: 'available' | 'none' | 'error' | 'event-error' | 'pending' = 'available';
  checkError: Error | null = null;
  checkInfo: Record<string, unknown> | null = null;
  throwOnCheck = false;
  throwOnDownload = false;
  throwOnInstall = false;

  info(version = '1.0.3', extra: Record<string, unknown> = {}) {
    return {
      version,
      releaseDate: '2026-09-30T11:00:00.000Z',
      releaseNotes: 'Restore the Sportsurge collection.',
      releaseName: `Sunday Room ${version}`,
      ...extra,
    };
  }

  checkForUpdates() {
    this.checks += 1;
    if (this.throwOnCheck) throw new Error('check exploded');
    if (this.checkResult === 'error') return Promise.reject(this.checkError ?? new Error('no feed'));
    if (this.checkResult === 'event-error') {
      const error = this.checkError ?? new Error('no feed');
      this.emitError(error);
      return Promise.reject(error);
    }
    // A check that never answers, so a second press can be tested against a check that is
    // genuinely still running.
    if (this.checkResult === 'pending') return new Promise(() => {});
    queueMicrotask(() => {
      this.emitChecking();
      if (this.checkResult === 'none') this.emitNone();
      else this.emitAvailable();
    });
    return Promise.resolve(true);
  }

  downloadUpdate() {
    this.downloads += 1;
    if (this.throwOnDownload) throw new Error('download exploded');
    return Promise.resolve(['C:\\cache\\Sunday-Room-1.0.3-Setup-x64.exe']);
  }

  quitAndInstall(isSilent = false, isForceRunAfter = false): void | Promise<void> {
    if (this.throwOnInstall) throw new Error('installer could not start');
    this.installs.push({ isSilent, isForceRunAfter });
  }

  setFeedURL(options: { provider?: string; url?: string }) {
    this.feeds.push(options?.url ?? null);
  }

  // Test helpers that mirror exactly what electron-updater emits.
  emitChecking() { this.emit('checking-for-update'); }
  emitAvailable(info = this.checkInfo ?? this.info()) { this.emit('update-available', info); }
  emitNone() { this.emit('update-not-available', { version: '1.0.2' }); }
  emitProgress(percent: number) {
    this.emit('download-progress', { percent, total: 119067581, transferred: Math.round(119067581 * percent / 100) });
  }
  emitDownloaded() { this.emit('update-downloaded', this.info()); }
  emitError(error: Error) { this.emit('error', error); }
}

// The common case at launch: the feed answers, and there is nothing newer.
function noneYet() {
  const updater = new FakeUpdater();
  updater.checkResult = 'none';
  return updater;
}

function harness(options: Record<string, unknown> = {}, seed?: Record<string, unknown>) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'sunday-update-'));
  if (seed) writeFileSync(path.join(userDataDir, 'update.json'), JSON.stringify(seed));
  const broadcasts: UpdateStatus[] = [];
  let clock = at;
  const updater = (options.updater as FakeUpdater | undefined) ?? new FakeUpdater();
  const service = updateModule.createUpdateService({
    currentVersion: '1.0.2',
    userDataDir,
    isPackaged: true,
    platform: 'win32',
    updater,
    now: () => clock,
    trusted: () => true,
    broadcast: (status: UpdateStatus) => broadcasts.push(status),
    log: () => {},
    ...options,
  });
  const settle = async () => {
    for (let index = 0; index < 15; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
  };
  return {
    service, userDataDir, updater, broadcasts, settle,
    setClock: (value: number) => { clock = value; },
    read: () => JSON.parse(readFileSync(path.join(userDataDir, 'update.json'), 'utf8')),
  };
}

// Start and let the automatic check land, which is what a real launch does.
async function started(options: Record<string, unknown> = {}, seed?: Record<string, unknown>) {
  const room = harness(options, seed);
  await room.service.start();
  await room.settle();
  return room;
}

test('the command set and the failure vocabulary agree across the boundary', () => {
  assert.deepEqual([...engineCommands], [...updateCommands], 'the engine and the panel must offer the same commands');
  assert.equal(FailureReasonSchema.options.length, failureReasons.length, 'one reason per declared failure');
  for (const reason of FailureReasonSchema.options) {
    assert.ok(failureReasons.includes(reason), `${reason} must exist in the engine`);
  }
  assert.equal(channels.cancel, undefined, 'electron-updater cannot cancel, so no cancel channel exists');
  assert.match(channels.setSource as string, /^sunday-update:/, 'the feed can be moved in development');
});

test('the feed parser accepts a canonical release URL and one trailing slash', () => {
  const feed = 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
  assert.equal(parseUpdateFeedUrl(feed), feed);
  assert.equal(parseUpdateFeedUrl(`${feed}/`), feed);
  for (const invalid of [
    'https://github.com/TheDarkSkyXD/Sports-Hub/releases/download',
    'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download/extra',
    `${feed}//`, `${feed}?asset=other`, `${feed}#fragment`,
    'https://user:password@github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download',
    'https://github.com/TheDarkSkyXD/../Sports-Hub/releases/latest/download',
    'https://github.com/TheDarkSkyXD/%2e%2e/Sports-Hub/releases/latest/download',
    'https://example.com/TheDarkSkyXD/Sports-Hub/releases/latest/download',
  ]) assert.equal(parseUpdateFeedUrl(invalid), null, invalid);
});

test('a supported build checks once on start and reports a newer release', async () => {
  const room = harness();
  try {
    await room.service.start();
    await room.settle();
    assert.equal(room.updater.checks, 1, 'one check at launch');
    const status = room.service.snapshot();
    assert.equal(status.currentVersion, '1.0.2');
    assert.equal(UpdateFeedUrlSchema.safeParse(status.source.url).success, true);
    assert.equal(status.source.editable, false, 'an installed build keeps its feed');
    assert.equal(UpdateStatusSchema.safeParse(status).success, true);
    assert.deepEqual(status.commands, ['check', 'download']);
    assert.equal(status.state.kind, 'available');
    const release = (status.state as { release: { version: string; pageUrl: string; notes: string } }).release;
    assert.equal(release.version, '1.0.3');
    assert.equal(release.pageUrl, 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v1.0.3',
      'the feed reports the version without a v, and the tag carries one');
    assert.match(release.notes, /Sportsurge/, 'the notes come from the feed');
    assert.equal(room.read().lastCheckedAt, at, 'a check that found something records its time too');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('the scheduler waits out its interval, and keeps looking once the app stays open', async () => {
  const recent = await started({}, { lastCheckedAt: at - 60_000 });
  try {
    assert.equal(recent.updater.checks, 0, 'a minute since the last check is not a gap');
    assert.equal(recent.service.snapshot().state.kind, 'idle');
  } finally { rmSync(recent.userDataDir, { recursive: true, force: true }); }

  const stale = await started({}, { lastCheckedAt: at - (24 * 60 * 60 * 1000) - 1 });
  try {
    assert.equal(stale.updater.checks, 1, 'past the daily interval it checks at launch');
    assert.equal(stale.service.snapshot().state.kind, 'available');
  } finally { rmSync(stale.userDataDir, { recursive: true, force: true }); }
});

test('the schedule is a preference, and turning it off stops the looking', async () => {
  const room = await started();
  try {
    assert.deepEqual(room.service.snapshot().preferences,
      { autoCheckEnabled: true, checkFrequency: 'daily' },
      'on by default, because an updater nobody hears from is not one');

    await room.service.invoke('setPreferences')(event('set-preferences'), { autoCheckEnabled: false });
    assert.equal(room.service.snapshot().preferences.autoCheckEnabled, false);
    assert.equal(room.read().autoCheckEnabled, false, 'and it survives a restart');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a frequency outside the presets is refused, and a preset is stored', async () => {
  const room = await started();
  try {
    await room.service.invoke('setPreferences')(event('set-preferences'), { checkFrequency: 'weekly' });
    assert.equal(room.service.snapshot().preferences.checkFrequency, 'weekly');
    assert.equal(room.read().checkFrequency, 'weekly');

    for (const bad of [{ checkFrequency: 'every-second' }, { checkFrequency: 0 }, { autoCheckEnabled: 'yes' }, {}, 'hourly']) {
      await assert.rejects(() => room.service.invoke('setPreferences')(event('set-preferences'), bad),
        (error: Error) => error.name === 'invalid-argument', JSON.stringify(bad));
    }
    assert.equal(room.service.snapshot().preferences.checkFrequency, 'weekly', 'nothing moved');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('no newer release settles on current and records the time', async () => {
  const room = await started({ updater: noneYet() });
  try {
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'current');
    assert.deepEqual(status.commands, ['check']);
    assert.equal(room.read().lastCheckedAt, at);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a press always asks the feed, with nothing throttling it', async () => {
  const room = await started();
  try {
    assert.equal(room.updater.checks, 1);
    // electron-updater has no cooldown of its own, and this service adds none. A person
    // pressing the button always gets an answer.
    const reply = await room.service.invoke('check')(event('check'));
    assert.equal(reply.state.kind, 'checking',
      'the reply is the state as the check starts, before the feed has answered');
    assert.equal(room.updater.checks, 2, 'a press reaches the feed');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a check with no argument is a manual check, because that is what the bridge sends', async () => {
  const room = await started();
  try {
    // desktop/preload.cjs may call `ipcRenderer.invoke(CH.check)`, so the handler receives
    // `undefined`. Treating that as a refusal broke the button in the app.
    const status = await room.service.invoke('check')(event('check'), undefined);
    assert.equal(status.state.kind, 'checking', 'an omitted flag must still start a check');
    assert.equal(room.updater.checks, 2);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a press while a check is still running spends no second request', async () => {
  const updater = new FakeUpdater();
  updater.checkResult = 'pending';
  const room = await started({ updater });
  try {
    assert.equal(room.service.snapshot().state.kind, 'checking');
    assert.equal(room.updater.checks, 1);
    await room.service.invoke('check')(event('check'));
    assert.equal(room.updater.checks, 1, 'a press while one is already running is free');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a release is downloaded, reports progress, and becomes ready to install', async () => {
  const room = await started();
  try {
    await room.service.invoke('download')(event('download'));
    assert.equal(room.service.snapshot().state.kind, 'downloading');
    assert.equal(room.updater.downloads, 1);
    room.updater.emitProgress(41.26);
    await room.settle();
    assert.equal((room.service.snapshot().state as { percent: number }).percent, 41.3);
    assert.equal(UpdateStatusSchema.safeParse(room.service.snapshot()).success, true);
    room.updater.emitDownloaded();
    await room.settle();
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'ready');
    assert.deepEqual(status.commands, ['install']);
    // The library keeps the file, its checksum, and its cache. There is no second record
    // here to keep in step with it.
    assert.equal(room.read().verified, undefined);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an install failure keeps the verified release and offers install again', async () => {
  const room = await started();
  try {
    await room.service.invoke('download')(event('download'));
    room.updater.emitDownloaded();
    room.updater.throwOnInstall = true;
    const status = await room.service.invoke('install')(event('install'));
    assert.equal(status.state.kind, 'failed');
    if (status.state.kind !== 'failed') return;
    assert.equal(status.state.reason, 'install');
    assert.equal(status.state.retry, 'install');
    assert.equal(status.state.release?.version, '1.0.3');
    assert.deepEqual(status.commands, ['install']);
    room.updater.throwOnInstall = false;
    await room.service.invoke('install')(event('install'));
    assert.equal(room.service.snapshot().state.kind, 'installing');
  } finally { room.service.stop(); rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('installing is silent and relaunches', async () => {
  const room = await started();
  try {
    await room.service.invoke('download')(event('download'));
    room.updater.emitDownloaded();
    await room.settle();
    await room.service.invoke('install')(event('install'));
    assert.equal(room.service.snapshot().state.kind, 'installing');
    assert.deepEqual(room.updater.installs, [{ isSilent: true, isForceRunAfter: true }],
      'an in-app update installs quietly and comes back up');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('install waits for preparation and installer acknowledgement, and rejects a duplicate press', async () => {
  let finishPreparation = () => {};
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  let finishLaunch = () => {};
  const launch = new Promise<void>(resolve => { finishLaunch = resolve; });
  class PendingUpdater extends FakeUpdater {
    override quitAndInstall(isSilent = false, isForceRunAfter = false) {
      super.quitAndInstall(isSilent, isForceRunAfter);
      return launch;
    }
  }
  const room = await started({ updater: new PendingUpdater(), prepareInstall: () => preparation });
  try {
    await room.service.invoke('download')(event('download'));
    room.updater.emitDownloaded();
    const first = room.service.invoke('install')(event('install'));
    assert.equal(room.service.snapshot().state.kind, 'installing');
    assert.deepEqual(room.service.snapshot().commands, []);
    await room.service.invoke('install')(event('install'));
    assert.equal(room.updater.installs.length, 0);
    finishPreparation();
    await Promise.resolve();
    assert.deepEqual(room.updater.installs, [{ isSilent: true, isForceRunAfter: true }]);
    finishLaunch();
    await first;
    assert.equal(room.service.snapshot().state.kind, 'installing');
  } finally { room.service.stop(); rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('preparation and asynchronous launch failures keep install retryable', async () => {
  let attempts = 0;
  class RejectingUpdater extends FakeUpdater {
    override quitAndInstall(isSilent = false, isForceRunAfter = false) {
      super.quitAndInstall(isSilent, isForceRunAfter);
      return attempts === 2 ? Promise.reject(new Error('spawn failed')) : Promise.resolve();
    }
  }
  const room = await started({
    updater: new RejectingUpdater(),
    prepareInstall: async () => { attempts += 1; if (attempts === 1) throw new Error('paint failed'); },
  });
  try {
    await room.service.invoke('download')(event('download'));
    room.updater.emitDownloaded();
    for (let index = 0; index < 2; index += 1) {
      const result = await room.service.invoke('install')(event('install'));
      assert.equal(result.state.kind, 'failed');
      assert.deepEqual(result.commands, ['install']);
      assert.equal(result.state.release?.version, '1.0.3');
      assert.equal(result.state.detail, index === 0 ? 'paint failed' : 'spawn failed');
    }
    assert.equal(room.updater.installs.length, 1);
    const retried = await room.service.invoke('install')(event('install'));
    assert.equal(retried.state.kind, 'installing');
    assert.equal(room.updater.installs.length, 2);
  } finally { room.service.stop(); rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('install is refused until the bytes are verified', async () => {
  const room = await started();
  try {
    await room.service.invoke('install')(event('install'));
    assert.equal(room.updater.installs.length, 0, 'nothing runs before a download completes');
    assert.equal(room.service.snapshot().state.kind, 'available');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a source with no published release is unavailable, not broken', async () => {
  for (const code of [
    'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
    'ERR_UPDATER_CHANNEL_DOES_NOT_EXIST',
  ]) {
    const room = await started();
    try {
      room.updater.emitError(Object.assign(new Error('boom'), { code }));
      await room.settle();
      const state = room.service.snapshot().state as { kind: string; reason: string; detail: string; retry: unknown };
      assert.equal(state.kind, 'failed');
      assert.equal(state.reason, 'unavailable', `${code} is not an outage`);
      assert.match(state.detail, /no published release/i);
      assert.equal(state.retry, 'check', 'and the user can ask again');
    } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
  }
});

test('a release missing latest.yml reports its missing update record', async () => {
  const room = await started();
  try {
    room.updater.emitError(Object.assign(new Error('404'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }));
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'failed');
    if (status.state.kind !== 'failed') return;
    assert.equal(status.state.reason, 'unavailable');
    assert.equal(status.state.detail, 'The published release is missing its update record.');
    assert.equal(status.state.retry, 'check');
  } finally { room.service.stop(); rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a published record that cannot be read is malformed and not retryable', async () => {
  for (const code of ['ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_UPDATE_INFO_NOT_FOUND']) {
    const room = await started();
    try {
      room.updater.emitError(Object.assign(new Error('boom'), { code }));
      await room.settle();
      const state = room.service.snapshot().state as { reason: string; retry: unknown };
      assert.equal(state.reason, 'malformed', `${code} means the record itself is wrong`);
      assert.equal(state.retry, null, 'pressing again would read the same record');
    } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
  }
});

test('a download that fails mid-transfer is retryable as a download', async () => {
  const room = await started();
  try {
    await room.service.invoke('download')(event('download'));
    await room.settle();
    room.updater.emitError(Object.assign(new Error('write failed'), { code: 'ERR_UPDATER_DOWNLOAD_FAILURE' }));
    await room.settle();
    const status = room.service.snapshot();
    const state = status.state as { kind: string; reason: string; retry: string; release: { version: string } };
    assert.equal(state.kind, 'failed');
    assert.equal(state.reason, 'download');
    assert.equal(state.retry, 'download', 'the same button retries the transfer');
    assert.equal(state.release.version, '1.0.3', 'and the release it was for is kept');
    assert.deepEqual(status.commands, ['download']);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a download that throws is contained, not crashed through', async () => {
  const room = await started();
  try {
    room.updater.throwOnDownload = true;
    await room.service.invoke('download')(event('download'));
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'failed', 'the machine survives a synchronous throw');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('being unable to reach the feed is reported as offline', async () => {
  for (const message of ['getaddrinfo ENOTFOUND api.github.com', 'socket hang up', 'read ECONNRESET']) {
    const room = await started();
    try {
      room.updater.emitError(new Error(message));
      await room.settle();
      const state = room.service.snapshot().state as { reason: string };
      assert.equal(state.reason, 'offline', `${message} is a network failure`);
    } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
  }
});

test('a check that rejects without emitting is still contained', async () => {
  const room = harness();
  try {
    room.updater.checkResult = 'error';
    room.updater.checkError = new Error('getaddrinfo ENOTFOUND api.github.com');
    await room.service.start();
    await room.settle();
    const state = room.service.snapshot().state as { kind: string; reason: string };
    assert.equal(state.kind, 'failed');
    assert.equal(state.reason, 'offline', 'a rejection that never became an event is not swallowed');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an automatic check restores its timestamp when the updater emits an error and rejects', async () => {
  const updater = new FakeUpdater();
  updater.checkResult = 'event-error';
  updater.checkError = new Error('getaddrinfo ENOTFOUND api.github.com');
  const previous = at - 24 * 60 * 60 * 1000 - 1;
  const room = await started({ updater }, { lastCheckedAt: previous });
  try {
    assert.equal(room.read().lastCheckedAt, previous);
    assert.equal(room.service.snapshot().state.kind, 'failed');
    assert.equal(room.broadcasts.filter(status => status.state.kind === 'failed').length, 1);
  } finally { room.service.stop(); rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a check that throws synchronously is contained', async () => {
  const room = harness();
  try {
    room.updater.throwOnCheck = true;
    await room.service.start();
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'failed');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a release whose version cannot be read is refused rather than rendered', async () => {
  for (const info of [{ version: '' }, { version: 'nightly' }, {}]) {
    const room = await started();
    try {
      room.updater.emitAvailable(info as never);
      await room.settle();
      const state = room.service.snapshot().state as { kind: string; reason: string };
      assert.equal(state.kind, 'failed', `${JSON.stringify(info)} is not a version`);
      assert.equal(state.reason, 'malformed');
    } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
  }
});

test('a re-check never costs the user the update they were about to install', async () => {
  const room = await started();
  try {
    await room.service.invoke('check')(event('check'));
    room.updater.emitNone();
    await room.settle();
    const state = room.service.snapshot().state as { kind: string; release: { version: string } };
    assert.equal(state.kind, 'available', 'finding nothing newer must not lose the release');
    assert.equal(state.release.version, '1.0.3');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a development build can read another feed, and exercises the whole flow', async () => {
  const updater = new FakeUpdater();
  const room = harness({ isPackaged: false, updater });
  try {
    await room.service.start();
    await room.settle();
    const status = room.service.snapshot();
    assert.equal(status.source.editable, true, 'a development build may move its feed');
    assert.equal(status.state.kind, 'available', 'so the whole flow can be exercised before packaging');
    // The whole point of the panel is to be exercised before packaging, so a development
    // build gets the read-only surface and nothing that writes to the machine.
    assert.deepEqual(status.commands, ['check']);
    const changed = await room.service.invoke('setPreferences')(event('set-preferences'), { checkFrequency: 'weekly' });
    assert.equal(changed.preferences.checkFrequency, 'weekly');
    assert.equal(room.read().checkFrequency, 'weekly');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('the feed is a plain URL the updater is handed, and only development can move it', async () => {
  const fork = 'https://github.com/Someone/Fork/releases/latest/download';

  const installed = harness();
  try {
    await assert.rejects(() => installed.service.invoke('setSource')(event('set-source'), fork),
      (error: Error) => error.name === 'unavailable', 'an installed build refuses outright');
    assert.equal(installed.service.snapshot().source.url, DEFAULT_FEED,
      'an installed build cannot be pointed elsewhere');
    assert.equal(installed.service.snapshot().source.editable, false);
    assert.deepEqual(installed.updater.feeds, [], 'and nothing reaches the library');
  } finally { rmSync(installed.userDataDir, { recursive: true, force: true }); }

  const dev = await started({ isPackaged: false });
  try {
    await dev.service.invoke('setSource')(event('set-source'), fork);
    assert.equal(dev.service.snapshot().source.url, fork, 'a development build may read another feed');
    assert.equal(dev.service.snapshot().source.editable, true);
    assert.deepEqual(dev.updater.feeds, [fork], 'and the library is told, not just the record');
  } finally { rmSync(dev.userDataDir, { recursive: true, force: true }); }
});

test('a feed that is not a GitHub releases address is refused', async () => {
  const room = await started({ isPackaged: false });
  try {
    for (const bad of [
      'https://evil.test/a/b/releases/latest/download',  // another host
      'http://github.com/a/b/releases/latest/download',  // not https
      'https://user:pass@github.com/a/b/releases/latest/download',  // credentials
      'https://github.com:8443/a/b/releases/latest/download',  // a port
      'https://github.com/a/b/releases/latest/download?x=1',  // a query
      'https://github.com/a/b/releases/latest/download#f',  // a fragment
      'https://github.com//b/releases/latest/download',  // an empty owner
      'https://github.com/a/b/releases/latest',  // not the download path
      'github.com/a/b/releases/latest/download',  // no scheme
      'not a url',
      '',
    ]) {
      await assert.rejects(() => room.service.invoke('setSource')(event('set-source'), bad),
        (error: Error) => error.name === 'invalid-argument', bad);
      assert.equal(room.service.snapshot().source.url, DEFAULT_FEED, `${bad} must not be accepted`);
    }
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a feed that walks the path to another repository is refused', async () => {
  const room = await started({ isPackaged: false });
  try {
    for (const traversal of [
      'https://github.com/a/b/releases/latest/download/../../elsewhere',
      'https://github.com/a/b/releases/latest/download/%2e%2e/elsewhere',
      'https://github.com/a/b/releases/latest/download/..',
    ]) {
      await assert.rejects(() => room.service.invoke('setSource')(event('set-source'), traversal),
        (error: Error) => error.name === 'invalid-argument', traversal);
    }
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a development build refuses download and install instead of running an unsigned binary', async () => {
  const room = await started({ isPackaged: false });
  try {
    for (const command of ['download', 'install'] as const) {
      await assert.rejects(() => room.service.invoke(command)(event(command)),
        (error: Error) => error.name === 'unavailable', command);
    }
    assert.equal(room.updater.downloads, 0, 'nothing was fetched');
    assert.equal(room.service.snapshot().state.kind, 'available', 'a refusal leaves the machine untouched');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an untrusted sender is refused and spends no request', async () => {
  const closed = harness({ trusted: () => false });
  try {
    for (const command of ['get', 'check', 'download', 'install'] as const) {
      await assert.rejects(() => closed.service.invoke(command)(event(command)),
        (error: Error) => error.name === 'untrusted-sender', command);
    }
    assert.equal(closed.updater.checks, 0);
  } finally { rmSync(closed.userDataDir, { recursive: true, force: true }); }
});

test('a bad argument is refused and changes nothing', async () => {
  const open = await started();
  try {
    await assert.rejects(() => open.service.invoke('check')(event('check'), 'yes'),
      (error: Error) => error.name === 'invalid-argument');
    assert.equal(open.updater.checks, 1, 'a refusal spends no request');
    assert.equal(UpdateStatusSchema.safeParse(open.service.snapshot()).success, true);
  } finally { rmSync(open.userDataDir, { recursive: true, force: true }); }
});

test('a non-Windows build is unsupported for its own reason', async () => {
  const room = harness({ platform: 'darwin' });
  try {
    await room.service.start();
    await room.settle();
    assert.deepEqual(room.service.snapshot().state, { kind: 'unsupported', reason: 'platform' });
    assert.deepEqual(room.service.snapshot().commands, []);
    assert.equal(room.updater.checks, 0, 'and it never spends a request');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('every state the engine broadcasts satisfies the renderer schema', async () => {
  const room = await started();
  try {
    assert.ok(room.broadcasts.length > 1, 'the launch actually broadcast something');
    for (const status of room.broadcasts) {
      assert.equal(UpdateStatusSchema.safeParse(status).success, true,
        `a broadcast state did not match the schema: ${JSON.stringify(status.state)}`);
    }
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('the persisted file holds only what this app owns', async () => {
  const room = await started({ updater: noneYet() });
  try {
    assert.deepEqual(Object.keys(room.read()).sort(),
      ['autoCheckEnabled', 'checkFrequency', 'lastCheckedAt', 'schema'],
      'the download, its checksum, and its cache belong to electron-updater');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a corrupt persisted file is ignored rather than fatal', async () => {
  const room = harness();
  try {
    writeFileSync(path.join(room.userDataDir, 'update.json'), '{ not json');
    const second = updateModule.createUpdateService({
      currentVersion: '1.0.2', userDataDir: room.userDataDir, isPackaged: true, platform: 'win32',
      updater: new FakeUpdater(), trusted: () => true, now: () => at, log: () => {},
    });
    second.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual(second.snapshot().state.kind, 'idle',
      'an unreadable file is treated as a first launch, so the schedule checks');
    second.stop();
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('stopping unsubscribes, so a stopped service cannot publish', async () => {
  const room = await started();
  try {
    const before = room.broadcasts.length;
    room.service.stop();
    room.updater.emitAvailable();
    await room.settle();
    assert.equal(room.broadcasts.length, before, 'a stopped service is silent');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('stopping one service removes only its updater listeners', async () => {
  const updater = new FakeUpdater();
  const first = harness({ updater, isPackaged: false });
  const second = harness({ updater, isPackaged: false });
  try {
    await first.service.start();
    await second.service.start();
    await first.settle();
    first.service.stop();
    const before = first.broadcasts.length;
    updater.emitError(new Error('getaddrinfo ENOTFOUND api.github.com'));
    assert.equal(first.broadcasts.length, before);
    assert.equal(second.service.snapshot().state.kind, 'failed');
    assert.equal(second.broadcasts.at(-1)?.state.kind, 'failed');
    second.service.stop();
    assert.equal(updater.listenerCount('error'), 0);
  } finally {
    first.service.stop();
    second.service.stop();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(second.userDataDir, { recursive: true, force: true });
  }
});

// The channel literals the preload duplicates. A mismatch cannot ship, because
// `tests/packaged-desktop.mjs` calls the bridge end to end against the packaged app.
const channels = {
  cancel: (updateModule.CH as Record<string, unknown>).cancel,
  setSource: updateModule.CH.setSource as string | undefined,
};

test('the preload carries exactly the channels the engine defines', () => {
  const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  for (const key of ['status', 'get', 'check', 'download', 'install', 'setSource'] as const) {
    assert.ok(preload.includes(`'${updateModule.CH[key]}'`), `preload.cjs must carry ${key}: ${updateModule.CH[key]}`);
  }
  assert.ok(!/CH\.cancel/.test(preload), 'the preload must not offer a channel the engine dropped');
});

// The pure table, kept honest on its own. These do not need a service, so a change to the
// machine is caught even if every integration test above is skipped.
test('the transition table is the only thing that knows what is legal', () => {
  const release = { version: '1.0.3', pageUrl: 'https://example.test', notes: '', publishedAt: 0 };
  const states = {
    unsupported: { kind: 'unsupported', reason: 'platform' },
    idle: { kind: 'idle', lastCheckedAt: null },
    checking: { kind: 'checking' },
    current: { kind: 'current', lastCheckedAt: at },
    available: { kind: 'available', release, lastCheckedAt: at },
    downloading: { kind: 'downloading', release, percent: 10 },
    ready: { kind: 'ready', release, verifiedAt: at },
    installing: { kind: 'installing', release },
    failed: { kind: 'failed', reason: 'download', detail: 'x', retry: 'download', release },
  };
  for (const [name, state] of Object.entries(states)) {
    assert.equal(UpdateStateSchema.safeParse(state).success, true, `${name} must match the schema`);
  }

  assert.deepEqual(reduce(states.idle, event('check')), states.checking);
  assert.deepEqual(reduce(states.current, event('check')), states.checking);
  assert.equal(reduce(states.unsupported, event('check')), null, 'unsupported absorbs every command');
  assert.equal(reduce(states.checking, event('check')), null, 'checking accepts nothing');
  assert.deepEqual(reduce(states.available, event('check')), { kind: 'checking', release });
  assert.deepEqual(reduce(states.available, event('download')), { kind: 'downloading', release, percent: 0 });
  assert.equal(reduce(states.downloading, event('download')), null, 'a second download is a no-op, not a second socket');
  assert.deepEqual(reduce(states.ready, event('install')), states.installing);
  assert.equal(reduce(states.installing, event('install')), null);

  assert.deepEqual(commandsFor(states.unsupported), []);
  assert.deepEqual(commandsFor(states.idle), ['check']);
  assert.deepEqual(commandsFor(states.current), ['check']);
  assert.deepEqual(commandsFor(states.checking), []);
  assert.deepEqual(commandsFor(states.available), ['check', 'download']);
  // No cancel: the library cannot abort a transfer, so the machine must not pretend.
  assert.deepEqual(commandsFor(states.downloading), []);
  assert.deepEqual(commandsFor(states.ready), ['install']);
  assert.deepEqual(commandsFor(states.installing), []);
  assert.deepEqual(commandsFor(states.failed), ['download']);
});

test('a development build is offered only what cannot touch the machine', () => {
  const release = { version: '1.0.3', pageUrl: 'https://example.test', notes: '', publishedAt: 0 };
  const allow = (command: string) => command === 'check';
  const available = { kind: 'available', release, lastCheckedAt: at };
  const ready = { kind: 'ready', release, verifiedAt: at };
  assert.deepEqual(commandsFor(available, allow), ['check']);
  // A development build can never reach `ready`, because it may not download, so the
  // install row is unreachable there rather than merely filtered.
  assert.deepEqual(commandsFor(ready, allow), []);
  assert.deepEqual(commandsFor({ kind: 'idle', lastCheckedAt: null }, allow), ['check']);
});
