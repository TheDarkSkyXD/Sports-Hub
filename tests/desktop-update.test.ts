import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FailureReasonSchema, ReleaseRepoSchema, UpdateStateSchema, UpdateStatusSchema, parseReleaseSource, updateCommands, type UpdateStatus } from '../lib/desktop-update.ts';

const require = createRequire(import.meta.url);
const { CH, commandsFor, createUpdateService, failureReasons, installerArgs, isNewer, parseRelease, reduce, updateCommands: desktopCommands } = require('../desktop/update.cjs');

const GIB = 1024 * 1024 * 1024;
const REPO = 'TheDarkSkyXD/Sports-Hub';
const DIGEST = '0c3e8f0349e70aa99648e34844a94eab8bab96297a10a4c022ad66758a76af91';

const asset = (overrides: Record<string, unknown> = {}) => ({
  name: 'Sunday-Room-1.0.3-Setup-x64.exe',
  size: 119053612,
  browser_download_url: `https://github.com/${REPO}/releases/download/v1.0.3/Sunday-Room-1.0.3-Setup-x64.exe`,
  digest: `sha256:${DIGEST}`,
  ...overrides,
});

const releaseJson = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v1.0.3',
  html_url: `https://github.com/${REPO}/releases/tag/v1.0.3`,
  draft: false,
  prerelease: false,
  published_at: '2026-09-20T18:04:11Z',
  body: 'Full field of games.',
  assets: [asset()],
  ...overrides,
});

const release = parseRelease(releaseJson(), REPO);
assert.ok(release && !release.reason, 'the fixture release must parse');

const at = 1_780_000_000_000;
const states = {
  unsupported: { kind: 'unsupported', reason: 'platform' },
  idle: { kind: 'idle', lastCheckedAt: null },
  checking: { kind: 'checking' },
  current: { kind: 'current', lastCheckedAt: at },
  available: { kind: 'available', release, lastCheckedAt: at },
  downloading: { kind: 'downloading', release, received: 0, total: release.installer.bytes },
  ready: { kind: 'ready', release, bytes: release.installer.bytes, verifiedAt: at },
  installing: { kind: 'installing', release },
  failed: { kind: 'failed', reason: 'offline', detail: 'no route', retry: 'check', release },
} as const;

const event = (type: string, at2 = at) => ({ type, at: at2, release, received: 0, bytes: release.installer.bytes });

test('the command table answers the nine rows and refuses everything else', () => {
  assert.deepEqual(reduce(states.idle, event('check')), states.checking);
  assert.deepEqual(reduce(states.current, event('check')), states.checking);

    assert.equal(reduce(states.unsupported, event('check')), null, 'unsupported absorbs every command');
    assert.equal(reduce(states.checking, event('check')), null, 'checking accepts nothing');
    assert.equal(reduce(states.checking, event('download')), null);
    // Re-checking from available is how a user hears about a newer release, and it keeps
    // the known release so a failure cannot take it away.
    assert.deepEqual(reduce(states.available, event('check')),
      { kind: 'checking', release: states.available.release });
    assert.deepEqual(reduce(states.available, event('download')), states.downloading);
  assert.equal(reduce(states.downloading, event('download')), null, 'a second download is a no-op, not a second socket');
  assert.deepEqual(reduce(states.downloading, event('cancel')), states.available, 'cancel keeps the release and re-offers download');

  assert.deepEqual(reduce(states.ready, event('install')), states.installing);
  assert.equal(reduce(states.ready, event('download')), null, 'verified bytes are already on disk');
  assert.equal(reduce(states.ready, event('cancel')), null);
  assert.equal(reduce(states.installing, event('install')), null, 'installing is absorbing');
  assert.equal(reduce(states.installing, event('cancel')), null);

  assert.deepEqual(reduce(states.failed, event('check')), states.checking, 'retry names that command entry row');
  assert.equal(reduce(states.failed, event('download')), null, 'retry is check, so download is refused');
  assert.equal(reduce(states.failed, event('cancel')), null);
  const terminal = { kind: 'failed', reason: 'rate-limited', detail: 'spent', retry: null, release };
  for (const command of desktopCommands) assert.equal(reduce(terminal, event(command)), null, `${command} must be refused`);
});

test('commandsFor is a projection of the same rows, including their guards', () => {
  assert.deepEqual(commandsFor(states.unsupported), []);
  assert.deepEqual(commandsFor(states.idle), ['check']);
  assert.deepEqual(commandsFor(states.current), ['check']);
  assert.deepEqual(commandsFor(states.checking), []);
  assert.deepEqual(commandsFor(states.available), ['check', 'download']);
  assert.deepEqual(commandsFor(states.downloading), ['cancel']);
  assert.deepEqual(commandsFor(states.ready), ['install']);
  assert.deepEqual(commandsFor(states.installing), []);
  assert.deepEqual(commandsFor(states.failed), ['check']);

  const retryDownload = { kind: 'failed', reason: 'download', detail: 'cut', retry: 'download', release };
  assert.deepEqual(commandsFor(retryDownload), ['download']);
  assert.deepEqual(reduce(retryDownload, event('download')), states.downloading, 'a retry re-enters the download row');
  const terminal = { kind: 'failed', reason: 'rate-limited', detail: 'spent', retry: null, release };
  assert.deepEqual(commandsFor(terminal), []);
  assert.deepEqual(commandsFor({ ...retryDownload, release: null }), [], 'a retry with nothing to retry offers nothing');
  const huge = { kind: 'available', release: { ...release, installer: { ...release.installer, bytes: GIB + 1 } }, lastCheckedAt: at };
  assert.equal(commandsFor(huge).includes('download'), false, 'over a gigabyte offers no download button');
  assert.equal(reduce(huge, event('download')), null, 'and the button and the command still agree');
});

test('commandsFor and reduce agree for every state the machine can reach', () => {
  const reachable = [
    ...Object.values(states),
    { kind: 'failed', reason: 'download', detail: 'cut', retry: 'download', release },
    { kind: 'failed', reason: 'install', detail: 'blocked', retry: 'install', release },
    { kind: 'failed', reason: 'offline', detail: 'no route', retry: 'check', release: null },
    { kind: 'failed', reason: 'rate-limited', detail: 'spent', retry: null, release },
    { kind: 'failed', reason: 'download', detail: 'gone', retry: 'download', release: null },
    { kind: 'failed', reason: 'install', detail: 'gone', retry: 'install', release: null },
    { kind: 'available', release: { ...release, installer: { ...release.installer, url: 'http://evil.test/a.exe' } }, lastCheckedAt: at },
    { kind: 'available', release: { ...release, installer: { ...release.installer, bytes: GIB + 1 } }, lastCheckedAt: at },
  ];
  for (const state of reachable) {
    assert.equal(UpdateStateSchema.safeParse(state).success, true, `${(state as { kind: string }).kind} must parse`);
    const offered = commandsFor(state);
    for (const command of desktopCommands) {
      const accepted = reduce(state, event(command)) !== null;
      assert.equal(offered.includes(command), accepted, `${(state as { kind: string }).kind} ${command}`);
    }
  }
});

test('parseRelease normalizes a GitHub releases/latest payload', () => {
  assert.equal(release.version, '1.0.3', 'the leading v is stripped');
  assert.equal(release.pageUrl, `https://github.com/${REPO}/releases/tag/v1.0.3`);
  assert.equal(release.notes, 'Full field of games.');
  assert.equal(release.publishedAt, Date.parse('2026-09-20T18:04:11Z'));
  assert.equal(release.installer.name, 'Sunday-Room-1.0.3-Setup-x64.exe');
  assert.equal(release.installer.bytes, 119053612);
  assert.equal(release.installer.sha256, DIGEST, 'sha256 is read out of assets[].digest');
  assert.equal(parseRelease(releaseJson({ assets: [asset({ digest: undefined })] }), REPO).installer.sha256, null);
  assert.equal(parseRelease(releaseJson({ tag_name: '1.0.3' }), REPO).pageUrl, `https://github.com/${REPO}/releases/tag/1.0.3`);
  assert.equal(parseRelease(releaseJson({ body: null, published_at: null }), REPO).publishedAt, null);
});

test('parseRelease selects the installer by artifactName and prefers the host arch', () => {
  const arm = { ...asset(), name: 'Sunday-Room-1.0.3-Setup-arm64.exe', browser_download_url: `https://github.com/${REPO}/releases/download/v1.0.3/Sunday-Room-1.0.3-Setup-arm64.exe` };
  assert.equal(parseRelease(releaseJson({ assets: [arm, asset()] }), REPO, 'x64').installer.name, 'Sunday-Room-1.0.3-Setup-x64.exe');
  assert.equal(parseRelease(releaseJson({ assets: [arm, asset()] }), REPO, 'arm64').installer.name, 'Sunday-Room-1.0.3-Setup-arm64.exe');
  assert.equal(parseRelease(releaseJson({ assets: [arm] }), REPO, 'x64').installer.name, 'Sunday-Room-1.0.3-Setup-arm64.exe');
  assert.deepEqual(parseRelease(releaseJson({ assets: [{ name: 'Sunday-Room-1.0.3.dmg', size: 5, browser_download_url: 'https://github.com/x' }] }), REPO), { reason: 'malformed' });
});

test('parseRelease rejects a draft, a prerelease, a bad tag, and a non-GitHub asset url', () => {
  assert.deepEqual(parseRelease(releaseJson({ draft: true }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ prerelease: true }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ tag_name: 'v1.0.3-beta.1' }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ tag_name: 'latest' }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ assets: [] }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ assets: [asset({ size: 0 })] }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ assets: [asset({ browser_download_url: 'http://github.com/a.exe' })] }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ assets: [asset({ browser_download_url: 'https://user:pass@github.com/a.exe' })] }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson({ assets: [asset({ browser_download_url: 'https://evil.test/a.exe' })] }), REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(null, REPO), { reason: 'malformed' });
  assert.deepEqual(parseRelease(releaseJson(), 'not-a-slug'), { reason: 'malformed' });
});

test('version comparison is numeric, so 1.10.0 outranks 1.9.0', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
  assert.equal(isNewer('1.0.3', '1.0.3'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.0', '1.0.0'), false);
  assert.equal(parseRelease(releaseJson({ tag_name: 'v1.10.0' }), REPO).version, '1.10.0');
});

test('installerArgs is the verified NSIS list with an unquoted trailing /D=', () => {
  const installDir = 'C:\\Users\\Player\\AppData\\Local\\Programs\\Sunday Room';
  assert.deepEqual(installerArgs(installDir), ['/S', '/updated', '/force-run', `/D=${installDir}`]);
  assert.equal(installerArgs(installDir).at(-1), `/D=${installDir}`);
  assert.equal(installerArgs(installDir).some(arg => arg.includes('"')), false, 'NSIS mangles a quoted /D= path');
  assert.equal(installerArgs(path.dirname('C:\\Program Files\\Sunday Room\\Sunday Room.exe')).at(-1), '/D=C:\\Program Files\\Sunday Room');
});

function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => payload,
    body: null,
  };
}

function streamResponse(chunks: Buffer[], headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => ({}),
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
}

function harness(options: Record<string, unknown> = {}, seed?: Record<string, unknown> | ((userDataDir: string) => Record<string, unknown>)) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'sunday-update-'));
  if (typeof seed === 'function') writeFileSync(path.join(userDataDir, 'update.json'), JSON.stringify(seed(userDataDir)));
  else if (seed) writeFileSync(path.join(userDataDir, 'update.json'), JSON.stringify(seed));
  const requests: string[] = [];
  const broadcasts: UpdateStatus[] = [];
  const spawned: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const exited: number[] = [];
  let clock = at;
  const service = createUpdateService({
    currentVersion: '1.0.2',
    userDataDir,
    isPackaged: true,
    platform: 'win32',
    execPath: path.join('C:\\Program Files\\Sunday Room', 'Sunday Room.exe'),
    now: () => clock,
    fetch: async (url: string) => { requests.push(String(url)); return jsonResponse(releaseJson()); },
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ file, args, options });
      return { unref: () => {}, kill: () => {} };
    },
    trusted: () => true,
    beginShutdown: async () => {},
    exit: (code: number) => { exited.push(code); },
    broadcast: (status: UpdateStatus) => broadcasts.push(status),
    listProcesses: async () => [],
    log: () => {},
    ...options,
  });
  const settle = async () => {
    // Real I/O and real timers: the transfers below use the filesystem, so draining
    // microtasks is not enough to see them finish.
    for (let index = 0; index < 15; index += 1) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const until = async (predicate: () => boolean, label: string) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  return {
    service, userDataDir, requests, broadcasts, spawned, exited, settle, until,
    setClock: (value: number) => { clock = value; },
    read: () => JSON.parse(readFileSync(path.join(userDataDir, 'update.json'), 'utf8')),
  };
}

test('a supported build checks once on start and reports a newer release', async () => {
  const room = harness();
  try {
    await room.service.start();
    await room.settle();
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'available');
    assert.deepEqual(room.requests, [`https://api.github.com/repos/${REPO}/releases/latest`]);
    assert.equal(status.currentVersion, '1.0.2');
    assert.equal(ReleaseRepoSchema.safeParse(status.source.repo).success, true);
    assert.equal(status.source.origin, 'packaged');
    assert.equal(UpdateStatusSchema.safeParse(status).success, true);
    assert.deepEqual(status.commands, ['check', 'download']);
    assert.equal(room.read().lastCheckedAt, at, 'the check time is persisted so a relaunch does not re-spend a request');
    assert.equal(room.read().source, REPO);

    const relaunched = harness({}, room.read());
    try {
      await relaunched.service.start();
      await relaunched.settle();
      assert.equal(relaunched.requests.length, 0, 'a launch inside six hours spends no request');
      assert.equal(relaunched.service.snapshot().state.kind, 'idle');
    } finally { rmSync(relaunched.userDataDir, { recursive: true, force: true }); }
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an unpublished source is one truthful unavailable reason, not three invented ones', async () => {
  const room = harness({ fetch: async () => jsonResponse({}, { status: 404 }) });
  try {
    await room.service.start();
    await room.settle();
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'failed');
    assert.equal((status.state as { reason: string }).reason, 'unavailable');
    assert.equal((status.state as { retry: string }).retry, 'check');
    assert.deepEqual(status.commands, ['check']);
    assert.equal(UpdateStatusSchema.safeParse(status).success, true);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a source document this build cannot read is malformed and is never retried on a timer', async () => {
  const room = harness({ fetch: async () => jsonResponse(releaseJson({ draft: true })) });
  try {
    await room.service.start();
    await room.settle();
    const status = room.service.snapshot();
    assert.equal((status.state as { reason: string }).reason, 'malformed');
    assert.deepEqual(status.commands, []);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an unreachable source is offline, and the network refusal carries the release it had', async () => {
  const room = harness({ fetch: async (url: string) => {
    if (String(url).includes('api.github.com')) return jsonResponse(releaseJson());
    throw new Error('socket hang up');
  } });
  try {
    await room.service.start();
    await room.settle();
    await room.service.invoke('download')(event('download'));
    await room.settle();
    const status = room.service.snapshot();
    assert.equal((status.state as { reason: string }).reason, 'download');
    assert.deepEqual((status.state as { release: unknown }).release, release, 'the failed state still names the release');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a development build can check and read every screen, but never installs', async () => {
  const room = harness({ isPackaged: false });
  try {
    await room.service.start();
    await room.settle();
    // The whole point of the panel is to be exercised before packaging, so a development
    // build gets the read-only surface: it asks GitHub and reports a real release.
    assert.equal(room.service.snapshot().state.kind, 'available');
    assert.match(room.requests[0], /^https:\/\/api\.github\.com\//, 'a development build still checks GitHub');
    assert.deepEqual(room.service.snapshot().commands, ['check'], 'and offers nothing that writes to the machine');

    const changed = await room.service.invoke('setSource')(event('set-source'), 'Someone/Fork');
    assert.equal(changed.source.repo, 'Someone/Fork');
    assert.equal(changed.source.origin, 'file');
    // Clearing `lastCheckedAt` sends the new source straight back to GitHub, which is the
    // only way to learn whether the fork has anything newer.
    await room.until(() => room.service.snapshot().state.kind === 'checking', 'the new source to be checked');
    assert.equal(room.read().source, 'Someone/Fork');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a development build refuses download and install instead of running an unsigned binary', async () => {
  const room = harness({ isPackaged: false });
  try {
    await room.service.start();
    await room.settle();
    for (const command of ['download', 'install', 'cancel'] as const) {
      await assert.rejects(() => room.service.invoke(command)(event(command)),
        (error: Error) => error.name === 'unavailable', command);
    }
    assert.equal(room.service.snapshot().state.kind, 'available', 'a refusal leaves the machine untouched');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('the source field accepts a releases address and still stores only the slug', async () => {
  // Someone reading this in a browser has a releases URL in front of them, so every one of
  // these has to work. All of them name the same repository.
  for (const input of [
    'https://github.com/TheDarkSkyXD/Sports-Hub/releases',
    'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest',
    'https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v1.0.2',
    'https://github.com/TheDarkSkyXD/Sports-Hub',
    '  https://github.com/TheDarkSkyXD/Sports-Hub/releases  ',
    'https://GITHUB.COM/TheDarkSkyXD/Sports-Hub/releases',
  ]) {
    const room = harness();
    try {
      const parsed = parseReleaseSource(input);
      assert.equal(parsed, 'TheDarkSkyXD/Sports-Hub', `${input} must resolve to the slug`);
      // And the same string through the real bridge lands on disk as the slug alone.
      const changed = await room.service.invoke('setSource')(event('set-source'), parsed);
      assert.equal(changed.source.repo, 'TheDarkSkyXD/Sports-Hub');
      assert.equal(room.read().source, 'TheDarkSkyXD/Sports-Hub');
    } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
  }
});

test('a source with no releases address to direct to is refused', async () => {
  // Without an address there is nothing to send a reader to, so guessing is worse than
  // reporting the mistake.
  for (const unusable of [
    'TheDarkSkyXD/Sports-Hub',      // a bare slug names no page
    'not a url',
    '',
    'github.com/TheDarkSkyXD/Sports-Hub/releases',  // no scheme
    '//github.com/TheDarkSkyXD/Sports-Hub/releases',  // protocol relative
    'https://github.com/owner',    // no repository
  ]) {
    assert.equal(parseReleaseSource(unusable), null, `${JSON.stringify(unusable)} must be refused`);
  }

  // And a page that is not a releases page is refused, so the field cannot be pointed at
  // a repository page that will never carry an installer.
  for (const wrongPage of [
    'https://github.com/owner/name/tree/main',
    'https://github.com/owner/name/issues',
  ]) {
    assert.equal(parseReleaseSource(wrongPage), null, `${wrongPage} is not a releases address`);
  }
});

test('a URL cannot walk the path to a different owner', async () => {
  // `URL` collapses `..` while parsing, so by the time `pathname` is readable
  // `/a/b/releases/../../evil` already reads as `/a/evil`. The attempt is only still
  // visible in the raw text, so that is what has to be refused.
  for (const traversal of [
    'https://github.com/a/b/releases/../../evil',
    'https://github.com/a/b/releases/%2e%2e/evil',
    'https://github.com/a/b/releases/..',
    'https://github.com/a/b/releases/./x',
    'https://github.com/a/b/releases\\..\\evil',
  ]) {
    assert.equal(parseReleaseSource(traversal), null, `${traversal} must be refused`);
  }

  // The rest of the trust boundary: only plain https github.com repository addresses.
  for (const hostile of [
    'https://evil.test/owner/name/releases',
    'http://github.com/owner/name/releases',
    'ftp://github.com/owner/name/releases',
    'file:///c:/x',
    'javascript:alert(1)',
    'https://github.com.evil.test/owner/name/releases',
    'https://user:pass@github.com/owner/name/releases',
    'https://github.com:8443/owner/name/releases',
    'https://github.com/owner/name/releases?next=evil',
    'https://github.com/owner/name/releases#frag',
    'https://github.com//name/releases',
    'https://github.com/owner/name%2Freleases',
  ]) {
    assert.equal(parseReleaseSource(hostile), null, `${hostile} must not be accepted`);
  }
});

test('a non-Windows build is unsupported for its own reason', async () => {
  const room = harness({ platform: 'darwin' });
  try { assert.deepEqual(room.service.snapshot().state, { kind: 'unsupported', reason: 'platform' }); }
  finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('the environment override only wins when the app is not packaged', async () => {
  const previous = process.env.SUNDAY_ROOM_UPDATE_SOURCE;
  process.env.SUNDAY_ROOM_UPDATE_SOURCE = 'Dev/Fork';
  try {
    const dev = harness({ isPackaged: false });
    const shipped = harness({ isPackaged: true });
    try {
      assert.equal(dev.service.snapshot().source.repo, 'Dev/Fork');
      assert.equal(dev.service.snapshot().source.origin, 'environment');
      assert.equal(shipped.service.snapshot().source.repo, REPO);
      assert.equal(shipped.service.snapshot().source.origin, 'packaged');
    } finally { rmSync(dev.userDataDir, { recursive: true, force: true }); rmSync(shipped.userDataDir, { recursive: true, force: true }); }
  } finally {
    if (previous === undefined) delete process.env.SUNDAY_ROOM_UPDATE_SOURCE;
    else process.env.SUNDAY_ROOM_UPDATE_SOURCE = previous;
  }
});

test('an untrusted sender and a bad argument are the only two rejections', async () => {
  const closed = harness({ trusted: () => false });
  try {
    for (const command of ['get', 'check', 'download', 'cancel', 'install'] as const) {
      await assert.rejects(() => closed.service.invoke(command)(event(command)), (error: Error) => error.name === 'untrusted-sender', command);
    }
    assert.deepEqual(closed.service.snapshot().state, { kind: 'idle', lastCheckedAt: null }, 'a refusal leaves the machine untouched');
  } finally { rmSync(closed.userDataDir, { recursive: true, force: true }); }

  const open = harness();
  try {
    await assert.rejects(() => open.service.invoke('setSource')(event('set-source'), 'https://evil.test/x'),
      (error: Error) => error.name === 'invalid-argument');
    await assert.rejects(() => open.service.invoke('check')(event('check'), 'yes'),
      (error: Error) => error.name === 'invalid-argument');
    const status = await open.service.invoke('get')(event('get'));
    assert.equal(UpdateStatusSchema.safeParse(status).success, true);
    assert.deepEqual(status.commands, ['check']);
  } finally { rmSync(open.userDataDir, { recursive: true, force: true }); }
});

test('a check with no argument is a manual check, because that is what the bridge sends', async () => {
  const room = harness();
  try {
    // desktop/preload.cjs may call `ipcRenderer.invoke(CH.check)`, so the handler
    // receives `undefined`. Treating that as a refusal broke the button in the app.
    const status = await room.service.invoke('check')(event('check'), undefined);
    assert.equal(status.state.kind, 'checking', 'an omitted flag must still start a manual check');
    const throttled = await room.service.invoke('check')(event('check'), undefined);
    assert.equal(throttled.state.kind, 'checking', 'a repeat press is throttled, not refused');
    assert.ok(room.requests.length <= 1, `a manual check spends at most one request, saw ${room.requests.length}`);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a manual check asks GitHub every time it is pressed, and a spent budget is terminal', async () => {
  const room = harness();
  try {
    await room.service.start();
    await room.settle();
    assert.equal(room.requests.length, 1, 'the startup check asks GitHub once');
    // A cooldown used to swallow this press, so the button looked dead. The state machine
    // is what bounds repeats, not a timer.
    // The reply is the snapshot taken as the check starts, so it reads `checking`; the
    // second request is the proof that the press was not swallowed.
    const pressed = await room.service.invoke('check')(event('check'), true);
    assert.equal(pressed.state.kind, 'checking');
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'available');
    assert.equal(room.requests.length, 2, 'a press always reaches GitHub, even right after a check');
    assert.match(room.requests[1], /^https:\/\/api\.github\.com\/repos\/TheDarkSkyXD\/Sports-Hub\/releases\/latest$/);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }

  // Presses landing while a check is already running must not become extra GitHub requests.
  const overlappingSeen: string[] = [];
  const overlapping = harness({ fetch: (url: string) => {
    overlappingSeen.push(String(url));
    return new Promise((resolve) => { setTimeout(() => resolve(jsonResponse(releaseJson())), 40); });
  } });
  try {
    await Promise.all([
      overlapping.service.invoke('check')(event('check'), true),
      overlapping.service.invoke('check')(event('check'), true),
      overlapping.service.invoke('check')(event('check'), true),
    ]);
    assert.equal(overlappingSeen.length, 1, 'only the first press reaches GitHub while one is running');
  } finally { rmSync(overlapping.userDataDir, { recursive: true, force: true }); }

  const spentRequests: string[] = [];
  const spent = harness({ fetch: async (url: string) => {
    spentRequests.push(String(url));
    return jsonResponse(releaseJson(), { headers: { 'x-ratelimit-remaining': '2' } });
  } });
  try {
    await spent.service.start();
    await spent.settle();
    assert.equal(spentRequests.length, 1);
    spent.setClock(at + 11 * 60_000);
    await spent.service.invoke('check')(event('check'), true);
    const status = spent.service.snapshot();
    assert.equal(status.state.kind, 'failed');
    assert.equal((status.state as { reason: string }).reason, 'rate-limited');
    assert.equal((status.state as { retry: unknown }).retry, null);
    assert.deepEqual(status.commands, []);
    assert.equal(spentRequests.length, 1, 'the floor is read from the last answer, so no request is wasted');
  } finally { rmSync(spent.userDataDir, { recursive: true, force: true }); }
});

test('a response without a rate-limit header does not invent an exhausted budget', async () => {
  const same = releaseJson({ tag_name: 'v1.0.2', assets: [asset({ name: 'Sunday-Room-1.0.2-Setup-x64.exe' })] });
  const fetches: string[] = [];
  const room = harness({ fetch: async (url: string) => { fetches.push(String(url)); return jsonResponse(same); } },
    { schema: 1, source: REPO, lastCheckedAt: null, verified: null, pendingInstall: null });
  try {
    await room.service.start();
    await room.until(() => room.service.snapshot().state.kind === 'current', 'the launch check');
    room.setClock(at + 11 * 60_000);
    const again = await room.service.invoke('check')(event('check'), true);
    assert.equal(again.state.kind, 'checking', 'a second manual check still runs');
    await room.until(() => room.service.snapshot().state.kind === 'current', 'the second check');
    assert.equal(fetches.length, 2);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a download that already verified on disk reaches ready with no network call', async () => {
  const bytes = Buffer.alloc(4096, 7);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const json = releaseJson({ assets: [asset({ size: bytes.length, digest: `sha256:${digest}` })] });
  let orphan = '';
  const fetches: string[] = [];
  // A kill between download and install leaves exactly this: a verified file and its record.
  const room = harness({ fetch: async (url: string) => { fetches.push(String(url)); return jsonResponse(json); } }, userDataDir => {
    const dir = path.join(userDataDir, 'updates', '1.0.3');
    mkdirSync(path.join(userDataDir, 'updates', '1.0.4'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    const verifiedPath = path.join(dir, 'Sunday-Room-1.0.3-Setup-x64.exe');
    writeFileSync(verifiedPath, bytes);
    orphan = path.join(userDataDir, 'updates', '1.0.4', 'Sunday-Room-1.0.4-Setup-x64.exe.part');
    writeFileSync(orphan, bytes);
    return { schema: 1, source: REPO, lastCheckedAt: null,
      verified: { version: '1.0.3', path: verifiedPath, bytes: bytes.length, verifiedAt: at }, pendingInstall: null };
  });
  try {
    await room.service.start();
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'available');
    await room.service.invoke('download')(event('download'));
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'ready');
    assert.equal(fetches.length, 1, 'the disk answered, so no installer bytes were re-fetched');
    assert.equal(fetches[0].includes('api.github.com'), true, 'only the release check went to the network');
    assert.equal(room.read().verified.version, '1.0.3');
    assert.equal(existsSync(orphan), false, 'an orphan is swept at start');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('start sweeps every partial and every installer that is not the current target', async () => {
  const target = path.join('C:\\Users\\Player\\AppData\\Roaming\\Sunday Room', 'updates', '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe');
  const room = harness({ fetch: async () => jsonResponse(releaseJson()) }, {
    schema: 1, source: REPO, lastCheckedAt: at - 60_000,
    verified: { version: '1.0.3', path: target, bytes: 11, verifiedAt: at - 60_000 }, pendingInstall: null,
  });
  try {
    const updates = path.join(room.userDataDir, 'updates');
    mkdirSync(path.join(updates, '1.0.3'), { recursive: true });
    mkdirSync(path.join(updates, '1.0.4'), { recursive: true });
    writeFileSync(path.join(updates, '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe.part'), Buffer.alloc(8));
    writeFileSync(path.join(updates, '1.0.4', 'Sunday-Room-1.0.4-Setup-x64.exe.part'), Buffer.alloc(8));
    writeFileSync(path.join(updates, '1.0.4', 'Sunday-Room-1.0.4-Setup-x64.exe'), Buffer.alloc(8));
    writeFileSync(path.join(updates, '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe'), Buffer.alloc(11));
    await room.service.start();
    await room.settle();
    assert.equal(existsSync(path.join(updates, '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe.part')), false);
    assert.equal(existsSync(path.join(updates, '1.0.4', 'Sunday-Room-1.0.4-Setup-x64.exe.part')), false);
    assert.equal(existsSync(path.join(updates, '1.0.4', 'Sunday-Room-1.0.4-Setup-x64.exe')), false, 'an older version is not the target');
    assert.equal(existsSync(path.join(updates, '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe')), true, 'the target is left for the download short circuit');
    room.service.stop();
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('download streams to a .part, verifies size and sha256, then renames atomically', async () => {
  const bytes = Buffer.alloc(256 * 1024, 3);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const chunks = [bytes.subarray(0, 100_000), bytes.subarray(100_000, 180_000), bytes.subarray(180_000)];
  const room = harness({ fetch: async (url: string) => String(url).includes('api.github.com')
    ? jsonResponse(releaseJson({ assets: [asset({ size: bytes.length, digest: `sha256:${digest}` })] }))
    : streamResponse(chunks, { 'content-length': String(bytes.length) }) });
  try {
    await room.service.start();
    await room.settle();
    await room.service.invoke('download')(event('download'));
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'ready');
    const dir = path.join(room.userDataDir, 'updates', '1.0.3');
    assert.equal(existsSync(path.join(dir, 'Sunday-Room-1.0.3-Setup-x64.exe')), true, 'the .part was renamed');
    assert.equal(existsSync(path.join(dir, 'Sunday-Room-1.0.3-Setup-x64.exe.part')), false);
    assert.equal(createHash('sha256').update(await readFile(path.join(dir, 'Sunday-Room-1.0.3-Setup-x64.exe'))).digest('hex'), digest);
    const progress = room.broadcasts.filter(status => status.state.kind === 'downloading');
    assert.equal(progress.some(status => (status.state as { received: number }).received > 0), true, 'progress is pushed');
    assert.ok(progress.length <= 6, `progress is throttled, not one message per chunk (${progress.length} pushes)`);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a checksum mismatch unlinks the .part and offers a retry', async () => {
  const bytes = Buffer.alloc(4096, 5);
  const room = harness({ fetch: async (url: string) => String(url).includes('api.github.com')
    ? jsonResponse(releaseJson({ assets: [asset({ size: bytes.length, digest: `sha256:${DIGEST}` })] }))
    : streamResponse([bytes]) });
  try {
    await room.service.start();
    await room.settle();
    await room.service.invoke('download')(event('download'));
    await room.settle();
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'failed');
    assert.equal((status.state as { reason: string }).reason, 'checksum');
    assert.deepEqual(status.commands, ['download']);
    assert.equal(existsSync(path.join(room.userDataDir, 'updates', '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe.part')), false);
    assert.equal(existsSync(path.join(room.userDataDir, 'updates', '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe')), false, 'a .part is never renamed');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an installer above a gigabyte is refused before a socket is opened', async () => {
  let assetRequests = 0;
  const room = harness({ fetch: async (url: string) => {
    if (!String(url).includes('api.github.com')) { assetRequests += 1; return streamResponse([Buffer.alloc(16, 9)]); }
    return jsonResponse(releaseJson({ assets: [asset({ size: GIB + 1, digest: null })] }));
  } });
  try {
    await room.service.start();
    await room.settle();
    // Re-checking is still offered, but there is no download button, so no socket opens.
    assert.equal(room.service.snapshot().commands.includes('download'), false, 'no button, so no request');
    await room.service.invoke('download')(event('download'));
    await room.settle();
    assert.equal(assetRequests, 0);
    assert.equal(room.service.snapshot().state.kind, 'available');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('cancel aborts the transfer and returns to available without a second fetch', async () => {
  const bytes = Buffer.alloc(8 * 65536, 4);
  let assetRequests = 0;
  const room = harness({ fetch: async (url: string) => {
    if (!String(url).includes('api.github.com')) {
      assetRequests += 1;
      return {
        ok: true, status: 200, headers: { get: () => String(bytes.length) }, json: async () => ({}),
        body: (async function* () {
          for (let index = 0; index < 8; index += 1) { await new Promise(resolve => setTimeout(resolve, 5)); yield bytes.subarray(0, 65536); }
        })(),
      };
    }
    return jsonResponse(releaseJson({ assets: [asset({ size: bytes.length, digest: null })] }));
  } });
  try {
    await room.service.start();
    await room.settle();
    const started = room.service.invoke('download')(event('download'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const cancelled = await room.service.invoke('cancel')(event('cancel'));
    assert.equal(cancelled.state.kind, 'available');
    assert.deepEqual(cancelled.commands, ['check', 'download']);
    await started;
    await room.settle();
    assert.equal(assetRequests, 1, 'cancel unlinks the .part instead of re-fetching');
    assert.equal(existsSync(path.join(room.userDataDir, 'updates', '1.0.3', 'Sunday-Room-1.0.3-Setup-x64.exe.part')), false);
    assert.equal(room.service.snapshot().state.kind, 'available', 'an aborted transfer is not a failure');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('install teardown, spawns detached, and exits only after the tree is down', async () => {
  const bytes = Buffer.alloc(2048, 6);
  const appDir = mkdtempSync(path.join(tmpdir(), 'sunday-room-install-'));
  const order: string[] = [];
  const room: ReturnType<typeof harness> = harness({
    execPath: path.join(appDir, 'Sunday Room.exe'),
    fetch: async (url: string) => String(url).includes('api.github.com')
      ? jsonResponse(releaseJson({ assets: [asset({ size: bytes.length, digest: null })] }))
      : streamResponse([bytes]),
    beginShutdown: async () => { order.push('shutdown'); },
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      order.push('spawn');
      room.spawned.push({ file, args, options });
      return { unref: () => order.push('unref'), kill: () => {} };
    },
    exit: (code: number) => { order.push(`exit:${code}`); room.exited.push(code); },
  });
  try {
    await room.service.start();
    await room.settle();
    await room.service.invoke('download')(event('download'));
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'ready');

    const installing = await room.service.invoke('install')(event('install'));
    assert.equal(installing.state.kind, 'installing');
    assert.deepEqual(installing.commands, []);
    await room.settle();
    assert.deepEqual(order, ['shutdown', 'spawn', 'unref', 'exit:0'], 'the order is the point');
    assert.deepEqual(room.spawned[0].args, ['/S', '/updated', '/force-run', `/D=${appDir}`]);
    assert.equal(room.spawned[0].file.endsWith('Sunday-Room-1.0.3-Setup-x64.exe'), true);
    assert.deepEqual(room.spawned[0].options, { detached: true, stdio: 'ignore', windowsHide: true });
    assert.equal(room.read().pendingInstall.version, '1.0.3');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); rmSync(appDir, { recursive: true, force: true }); }
});

test('an install directory this process cannot write drops /S so the installer can elevate', async () => {
  const bytes = Buffer.alloc(2048, 6);
  const room = harness({
    execPath: 'C:\\Program Files\\Sunday Room\\Sunday Room.exe',
    fetch: async (url: string) => String(url).includes('api.github.com')
      ? jsonResponse(releaseJson({ assets: [asset({ size: bytes.length, digest: null })] }))
      : streamResponse([bytes]),
  });
  try {
    await room.service.start();
    await room.settle();
    await room.service.invoke('download')(event('download'));
    await room.settle();
    await room.service.invoke('install')(event('install'));
    await room.settle();
    assert.deepEqual(room.spawned[0].args, ['/updated', '/force-run', '/D=C:\\Program Files\\Sunday Room'],
      'a silent no-op is the worst failure mode, so the assisted installer shows its own UI');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('an installer already running refuses the transition instead of a silent no-op', async () => {
  const bytes = Buffer.alloc(2048, 6);
  const room = harness({
    fetch: async (url: string) => String(url).includes('api.github.com')
      ? jsonResponse(releaseJson({ assets: [asset({ size: bytes.length, digest: null })] }))
      : streamResponse([bytes]),
    listProcesses: async () => ['explorer.exe', 'Sunday-Room-1.0.4-Setup-x64.exe'],
  });
  try {
    await room.service.start();
    await room.settle();
    await room.service.invoke('download')(event('download'));
    await room.settle();
    const status = await room.service.invoke('install')(event('install'));
    assert.equal(status.state.kind, 'failed');
    assert.equal((status.state as { reason: string }).reason, 'install');
    assert.deepEqual(status.commands, ['install']);
    assert.equal(room.spawned.length, 0);
    assert.equal(room.exited.length, 0);
    assert.equal(room.read().pendingInstall, null, 'no marker, so the next launch does not claim an install began');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a marker whose version is not ours reopens as a recoverable install failure', async () => {
  const room = harness({}, { schema: 1, source: REPO, lastCheckedAt: at - 60_000, verified: null, pendingInstall: { version: '1.0.3', startedAt: at - 30_000 } });
  try {
    await room.service.start();
    await room.settle();
    const status = room.service.snapshot();
    assert.equal(status.state.kind, 'failed');
    assert.equal((status.state as { reason: string }).reason, 'install');
    assert.deepEqual(status.commands, ['check']);
    assert.equal((status.state as { release: unknown }).release, null, 'the file records no release to name the bytes by');
    assert.equal(room.read().pendingInstall, null, 'the marker is cleared either way');
    assert.equal(room.requests.length, 0, 'a check inside six hours costs nothing');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('a marker whose version is ours means the install landed', async () => {
  const room = harness({ currentVersion: '1.0.3' }, { schema: 1, source: REPO, lastCheckedAt: at - 60_000, verified: null, pendingInstall: { version: '1.0.3', startedAt: at - 30_000 } });
  try {
    await room.service.start();
    await room.settle();
    assert.equal(room.service.snapshot().state.kind, 'idle');
    assert.equal(room.read().pendingInstall, null);
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});

test('every state the desktop module can produce satisfies the renderer schema', () => {
  assert.deepEqual([...failureReasons], [...FailureReasonSchema.options], 'the duplicated failure vocabulary must agree');
  assert.deepEqual([...desktopCommands], [...updateCommands], 'the duplicated command list must agree');
  const chain = reduce(states.idle, event('check'));
  const produced: unknown[] = [
    states.unsupported, states.checking, states.current, states.available, states.downloading, states.ready, states.installing, states.failed,
    chain, reduce(chain, event(':checked')), reduce(chain, { type: ':checked', at, release: null }),
    reduce(states.downloading, event(':progress')), reduce(states.downloading, event(':verified')),
    reduce(states.downloading, event('cancel')), reduce(states.ready, event('install')),
    reduce({ kind: 'failed', reason: 'offline', detail: 'x', retry: 'check', release: null }, event('check')),
  ];
  for (const reason of FailureReasonSchema.options) {
    produced.push(reduce(states.checking, { type: ':failed', reason, detail: 'x', retry: null, at }));
    produced.push(reduce(states.available, { type: ':failed', reason, detail: 'x', retry: 'download', at }));
    produced.push(reduce(states.installing, { type: ':failed', reason, detail: 'x', retry: 'install', at }));
  }
  for (const state of produced) {
    if (state === null) continue;
    assert.equal(UpdateStateSchema.safeParse(state).success, true, JSON.stringify(state).slice(0, 160));
  }
  assert.equal(produced.filter(state => state !== null).length >= 30, true, 'the table was not fully exercised');
});

test('the channel literals and the persisted file are the documented shape', async () => {
  assert.deepEqual(CH, {
    status: 'sunday-update:status', get: 'sunday-update:get', check: 'sunday-update:check',
    download: 'sunday-update:download', cancel: 'sunday-update:cancel', install: 'sunday-update:install',
    setSource: 'sunday-update:set-source',
  });
  const room = harness();
  try {
    await room.service.start();
    await room.settle();
    assert.deepEqual(Object.keys(room.read()).sort(), ['lastCheckedAt', 'pendingInstall', 'schema', 'source', 'verified']);
    assert.equal(room.read().schema, 1);
    assert.equal(existsSync(path.join(room.userDataDir, 'update.json.tmp')), false, 'the write is atomic');
  } finally { rmSync(room.userDataDir, { recursive: true, force: true }); }
});
