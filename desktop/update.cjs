const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { finished } = require('node:stream/promises');

// These literals are duplicated in `preload.cjs` because a sandboxed preload cannot
// require a sibling module. A typo cannot ship: `tests/packaged-desktop.mjs` calls the
// bridge end to end against the packaged app.
const CH = Object.freeze({
  status: 'sunday-update:status',
  get: 'sunday-update:get',
  check: 'sunday-update:check',
  download: 'sunday-update:download',
  cancel: 'sunday-update:cancel',
  install: 'sunday-update:install',
  setSource: 'sunday-update:set-source',
});

const GIB = 1024 * 1024 * 1024;
const AUTOMATIC_CHECK_GAP_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_FLOOR = 5;
const CHECK_TIMEOUT_MS = 20000;
const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_QUANTUM = 64 * 1024;
const PROGRESS_FRACTION = 0.01;

// The update union lives in `lib/desktop-update.ts` and again here, because
// `eslint.config.mjs` forbids `desktop/**/*.cjs` from importing `lib/`. The failure
// vocabulary is the part that has to agree, so it is exported and asserted by
// `tests/desktop-update.test.ts`.
const updateCommands = Object.freeze(['check', 'download', 'cancel', 'install']);
const failureReasons = Object.freeze(['offline', 'rate-limited', 'unavailable', 'malformed', 'checksum', 'download', 'install']);

const defaultReleaseRepo = 'TheDarkSkyXD/Sports-Hub';
const releaseRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const tagPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;
const installerPattern = /^Sunday-Room-(\d+\.\d+\.\d+)-Setup-(x64|ia32|arm64)\.exe$/;
const digestPattern = /^sha256:([0-9a-f]{64})$/;
const imageInstallerPattern = /^(?:Sunday-Room-[\d.]+-Setup-(?:x64|ia32|arm64)\.exe|Sunday Room Installer\.exe)$/i;
const retryEntry = Object.freeze({ check: 'idle', download: 'available', install: 'ready' });

const MALFORMED = Object.freeze({ reason: 'malformed' });

function assetUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && !host.endsWith('.githubusercontent.com')) return null;
    return url.href;
  } catch { return null; }
}

function versionParts(value) {
  const match = tagPattern.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(version, other) {
  const left = versionParts(version);
  const right = versionParts(other);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

// Keys off the shape of the response, not off the host it came from, so a mirror of
// the same document needs no protocol picker.
function parseRelease(json, repo, arch = process.arch) {
  if (!json || typeof json !== 'object' || json.draft === true || json.prerelease === true) return MALFORMED;
  const tag = typeof json.tag_name === 'string' ? json.tag_name : '';
  const parts = versionParts(tag);
  if (!parts || typeof repo !== 'string' || !releaseRepoPattern.test(repo)) return MALFORMED;
  const assets = Array.isArray(json.assets) ? json.assets.filter(item => item && typeof item === 'object') : [];
  const installers = assets.filter(item => typeof item.name === 'string' && installerPattern.test(item.name));
  const asset = installers.find(item => installerPattern.exec(item.name)[2] === arch) || installers[0];
  if (!asset) return MALFORMED;
  const bytes = Number(asset.size);
  const url = assetUrl(asset.browser_download_url);
  if (!Number.isInteger(bytes) || bytes <= 0 || !url) return MALFORMED;
  const digest = typeof asset.digest === 'string' ? digestPattern.exec(asset.digest) : null;
  const published = typeof json.published_at === 'string' ? Date.parse(json.published_at) : Number.NaN;
  return Object.freeze({
    version: `${parts[0]}.${parts[1]}.${parts[2]}`,
    pageUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    notes: typeof json.body === 'string' ? json.body : '',
    publishedAt: Number.isFinite(published) && published >= 0 ? Math.floor(published) : null,
    installer: Object.freeze({ name: asset.name, url, bytes, sha256: digest ? digest[1] : null }),
  });
}

// electron-builder registers `updated` and `force-run` as real flags
// (`NsisTarget.js:579`), and the assisted installer relaunches the app only under
// `${isForceRun}` and `${Silent}` (`installSection.nsh:104-110`). `/D=` must be last
// and unquoted: `multiUser.nsh:102-104` states it, and `GetDParameter` hand-parses the
// raw command line because NSIS's own `/D` handling mangles a quoted path.
function installerArgs(installDir) {
  return ['/S', '/updated', '/force-run', `/D=${installDir}`];
}

function downloadable(release) {
  const installer = release && typeof release === 'object' ? release.installer : null;
  if (!installer || typeof installer !== 'object') return false;
  if (!Number.isInteger(installer.bytes) || installer.bytes <= 0 || installer.bytes > GIB) return false;
  return assetUrl(installer.url) !== null;
}

// A row reads its release off the state it is leaving, never off the event, so a caller
// cannot offer a release the row would have refused.
function probeEvent(state, command) {
  const event = { type: command, release: state.release ?? null };
  if (typeof state.lastCheckedAt === 'number') event.at = state.lastCheckedAt;
  else event.at = 0;
  return event;
}

// The nine-row transition table, and the only place that knows what is legal.
// `commandsFor` is a projection of these same rows, so the buttons a user can press and
// the commands the system accepts cannot drift apart.
const commandRows = {
  unsupported: {},
  idle: { check: () => ({ kind: 'checking' }) },
  current: { check: () => ({ kind: 'checking' }) },
  checking: {},
    available: {
      // Re-checking is how a user finds out whether a newer release landed, so it has to
      // reach GitHub. The known release rides along so a failure cannot lose it.
      check: state => ({ kind: 'checking', release: state.release }),
      download: state => downloadable(state.release)
        ? { kind: 'downloading', release: state.release, received: 0, total: state.release.installer.bytes }
        : null,
    },
  downloading: {
    cancel: (state, event) => state.release && event.at >= 0
      ? { kind: 'available', release: state.release, lastCheckedAt: event.at }
      : null,
  },
  ready: {
    install: state => state.release ? { kind: 'installing', release: state.release } : null,
  },
  installing: {},
  failed: {},
};

// `:` events are the asynchronous outcomes. They cannot collide with a command name.
const outcomeRows = {
    checking: {
      // Asking again must never cost the user the update they were about to install, so a
      // re-check that finds nothing newer falls back to the release it already had.
      ':checked': (state, event) => {
        const release = event.release ?? state.release ?? null;
        return release
          ? { kind: 'available', release, lastCheckedAt: event.at }
          : { kind: 'current', lastCheckedAt: event.at };
      },
    },
  downloading: {
    ':progress': (state, event) => ({
      kind: 'downloading', release: state.release,
      received: Math.min(state.total, Math.max(0, Math.floor(Number(event.received) || 0))), total: state.total,
    }),
    ':verified': (state, event) => ({ kind: 'ready', release: state.release, bytes: event.bytes, verifiedAt: event.at }),
  },
};

const failureSources = new Set(['idle', 'current', 'checking', 'available', 'downloading', 'ready', 'installing']);

// `allow` withholds a command the table would otherwise accept. The table stays the single
// source of truth about legality; this only narrows what a given build may do, so a
// development build can exercise every screen without ever running an installer.
function commandRow(state, command, allow) {
  if (!state || typeof state.kind !== 'string' || !updateCommands.includes(command)) return null;
  if (allow && !allow(command)) return null;
  if (state.kind === 'failed') {
    if (state.retry !== command) return null;
    const row = commandRows[retryEntry[command]] && commandRows[retryEntry[command]][command];
    return row ? (from, event) => row(from, { ...event, release: from.release ?? event.release }) : null;
  }
  const row = commandRows[state.kind];
  return row && Object.hasOwn(row, command) ? row[command] : null;
}

function commandsFor(state, allow) {
  if (!state || typeof state.kind !== 'string') return [];
  return updateCommands.filter(command => {
    const row = commandRow(state, command, allow);
    return !!row && row(state, probeEvent(state, command)) !== null;
  });
}

function reduce(state, event, allow) {
    if (!state || typeof state.kind !== 'string' || !event || typeof event.type !== 'string') return null;
  if (event.type.startsWith(':')) {
    if (event.type === ':failed') {
      if (!failureSources.has(state.kind)) return null;
      return {
        kind: 'failed', reason: event.reason, detail: String(event.detail ?? ''),
        retry: event.retry ?? null, release: state.release ?? null,
      };
    }
    const row = outcomeRows[state.kind];
    return row && Object.hasOwn(row, event.type) ? row[event.type](state, event) : null;
  }
  const row = commandRow(state, event.type, allow);
  return row ? row(state, event) : null;
}

function defaultPersisted() {
  return { schema: 1, source: defaultReleaseRepo, lastCheckedAt: null, verified: null, pendingInstall: null };
}

function readPersisted(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultPersisted();
    const value = defaultPersisted();
    if (typeof parsed.source === 'string' && releaseRepoPattern.test(parsed.source)) value.source = parsed.source;
    if (Number.isInteger(parsed.lastCheckedAt) && parsed.lastCheckedAt >= 0) value.lastCheckedAt = parsed.lastCheckedAt;
    if (parsed.verified && typeof parsed.verified === 'object' && typeof parsed.verified.version === 'string' &&
      typeof parsed.verified.path === 'string' && Number.isInteger(parsed.verified.bytes) && parsed.verified.bytes > 0 &&
      Number.isInteger(parsed.verified.verifiedAt)) value.verified = parsed.verified;
    if (parsed.pendingInstall && typeof parsed.pendingInstall === 'object' &&
      typeof parsed.pendingInstall.version === 'string' && Number.isInteger(parsed.pendingInstall.startedAt)) {
      value.pendingInstall = parsed.pendingInstall;
    }
    return value;
  } catch { return defaultPersisted(); }
}

function writableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function defaultListProcesses() {
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(String(stdout).split(/\r?\n/).flatMap(line => /^"([^"]+)"/.exec(line)?.slice(1) ?? []));
    });
  });
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

// A missing header is `null`, not zero. Reading it as zero would record an exhausted
// budget the server never reported and refuse every later manual check.
function headerNumber(response, name) {
  const raw = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function* bodyChunks(response) {
  if (!response.body) return;
  for await (const chunk of response.body) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

function checkFailure(status) {
  if (status === 403 || status === 429) return {
    reason: 'rate-limited', retry: null,
    detail: 'GitHub refused the request because the unauthenticated budget for this address is spent.',
  };
  if (status === 404) return {
    reason: 'unavailable', retry: 'check',
    detail: 'The source published no release. It may be private, renamed, or not published yet.',
  };
  return { reason: 'unavailable', retry: 'check', detail: `The release source answered ${status}.` };
}

function createUpdateService(deps) {
  const {
    currentVersion, userDataDir, isPackaged, platform, execPath, fetch: request, spawn, trusted,
    beginShutdown, exit, now = () => Date.now(), log = () => {}, broadcast = () => {},
    listProcesses = defaultListProcesses,
  } = deps;

  const file = path.join(userDataDir, 'update.json');
  const updatesDir = path.join(userDataDir, 'updates');
  const persisted = readPersisted(file);
  const source = resolveSource();
  let state = initialState();
  let rateLimitRemaining = null;
  let inflight = null;
  let stopped = false;

  function resolveSource() {
    if (!isPackaged) {
      const override = process.env.SUNDAY_ROOM_UPDATE_SOURCE;
      // Development only. The app is unsigned, so a stray variable that redirects the
      // feed is a code-execution vector for anyone who can set env vars on the machine.
      if (typeof override === 'string' && releaseRepoPattern.test(override)) return { repo: override, origin: 'environment' };
    }
    if (persisted.source !== defaultReleaseRepo) return { repo: persisted.source, origin: 'file' };
    return { repo: defaultReleaseRepo, origin: 'packaged' };
  }

  // A development build gets the whole read-only surface: it can check GitHub, show a
  // release, and read every screen the way a person does. It never downloads or installs,
  // because those two write to the machine and run an unsigned binary. Platform is still
  // terminal, since the installer is Windows-only on any build.
  const allowedCommand = isPackaged && platform === 'win32'
    ? null
    : (command) => command === 'check';

  function initialState() {
    if (platform !== 'win32') return { kind: 'unsupported', reason: 'platform' };
    const marker = persisted.pendingInstall;
    if (!marker) return { kind: 'idle', lastCheckedAt: persisted.lastCheckedAt };
    persisted.pendingInstall = null;
    writePersisted();
    // A marker whose version is not ours means the install died mid-flight. The bytes
    // are still on disk, but the file records no release to name them by, so the only
    // honest way back is a fresh check; `download` then short-circuits to `ready`.
    if (marker.version === currentVersion) return { kind: 'idle', lastCheckedAt: persisted.lastCheckedAt };
    return {
      kind: 'failed', reason: 'install', retry: 'check', release: null,
      detail: `Version ${marker.version} was never installed. Its installer is still on disk; check for the release again to install it.`,
    };
  }

  function writePersisted() {
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ ...persisted, source: source.repo }));
      fs.renameSync(temp, file);
    } catch (error) { log(`update: could not write ${file}: ${describe(error)}`); }
  }

  function snapshot() {
    return Object.freeze({
      currentVersion,
      source: Object.freeze({ repo: source.repo, origin: source.origin }),
      state,
      commands: Object.freeze(commandsFor(state, allowedCommand)),
    });
  }

  function publish() {
    if (!stopped) broadcast(snapshot());
  }

  function apply(event) {
    const next = reduce(state, { ...event, at: typeof event.at === 'number' ? event.at : now() }, allowedCommand);
    if (!next) return false;
    state = next;
    publish();
    return true;
  }

  function inFlight(kind) {
    return !stopped && state.kind === kind;
  }

  function beginCheck(manual) {
    const at = now();
    if (manual) {
      // A press is a deliberate request for the truth, so it always asks GitHub again.
      // There is no time window on it: a ten minute cooldown made the button look dead
      // right after the startup check, which is exactly when a user presses it. Hammering
      // is bounded instead by the state machine, which refuses a check while one is
      // running, and by the budget floor below.
      if (rateLimitRemaining !== null && rateLimitRemaining < RATE_LIMIT_FLOOR) {
        apply({
          type: ':failed', reason: 'rate-limited', retry: null,
          detail: 'GitHub reports almost no unauthenticated requests left for this address. Try again later.',
        });
        return;
      }
    }
    if (apply({ type: 'check', at })) void runCheck();
  }

  async function runCheck() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    inflight = controller;
    let response;
    try {
      response = await request(`https://api.github.com/repos/${source.repo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': `SundayRoom/${currentVersion}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (!inFlight('checking')) return;
      return apply({ type: ':failed', reason: 'offline', retry: 'check', detail: describe(error) });
    } finally { clearTimeout(timer); if (inflight === controller) inflight = null; }
    if (!inFlight('checking')) return;
    const remaining = headerNumber(response, 'x-ratelimit-remaining');
    if (remaining !== null) rateLimitRemaining = remaining;
    if (!response.ok) return apply({ type: ':failed', ...checkFailure(response.status) });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!inFlight('checking')) return;
    const release = payload && typeof payload === 'object' ? parseRelease(payload, source.repo) : MALFORMED;
    if (release === MALFORMED || !release || release.reason === 'malformed') {
      return apply({
        type: ':failed', reason: 'malformed', retry: null,
        detail: 'That release carries no Sunday Room installer this build can use.',
      });
    }
    persisted.lastCheckedAt = now();
    writePersisted();
    apply({
      type: ':checked', at: persisted.lastCheckedAt,
      release: isNewer(release.version, currentVersion) ? release : null,
    });
  }

  async function verifiedBytes(target, release) {
    let size;
    try { size = (await fsp.stat(target)).size; } catch { return null; }
    if (size !== release.installer.bytes) return null;
    if (!release.installer.sha256) return size;
    const digest = createHash('sha256').update(await fsp.readFile(target)).digest('hex');
    return digest === release.installer.sha256 ? size : null;
  }

  async function streamToDisk(release, dir, final, part, controller) {
    let response;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.rm(part, { force: true });
      response = await request(release.installer.url, { signal: controller.signal });
    } catch (error) {
      if (!inFlight('downloading')) return;
      return apply({ type: ':failed', reason: 'download', retry: 'download', detail: `The download could not start. ${describe(error)}` });
    }
    if (!inFlight('downloading')) return;
    if (!response.ok) {
      return apply({ type: ':failed', reason: 'download', retry: 'download', detail: `The release host answered ${response.status}.` });
    }
    const declared = headerNumber(response, 'content-length');
    if (declared !== null && declared > GIB) {
      return apply({
        type: ':failed', reason: 'download', retry: null,
        detail: 'That installer is larger than the one gigabyte this updater will download.',
      });
    }

    const hash = createHash('sha256');
    const writer = fs.createWriteStream(part);
    let received = 0;
    let sent = 0;
    let sentAt = 0;
    try {
      for await (const chunk of bodyChunks(response)) {
        if (!writer.write(chunk)) await new Promise(resolve => writer.once('drain', resolve));
        hash.update(chunk);
        received += chunk.length;
        // A 119 MB download is roughly forty thousand chunks. Emitting each one would
        // mean forty thousand IPC messages and forty thousand React renders.
        const rounded = Math.floor(received / PROGRESS_QUANTUM) * PROGRESS_QUANTUM;
        const at = now();
        if (rounded > sent && (at - sentAt >= PROGRESS_INTERVAL_MS || received - sent >= release.installer.bytes * PROGRESS_FRACTION)) {
          sent = rounded;
          sentAt = at;
          apply({ type: ':progress', received: rounded });
        }
      }
      writer.end();
      await finished(writer);
    } catch (error) {
      writer.destroy();
      await fsp.rm(part, { force: true }).catch(() => {});
      if (!inFlight('downloading')) return;
      return apply({ type: ':failed', reason: 'download', retry: 'download', detail: `The download stopped before it finished. ${describe(error)}` });
    }
    if (!inFlight('downloading')) { await fsp.rm(part, { force: true }).catch(() => {}); return; }

    const digest = hash.digest('hex');
    if (received !== release.installer.bytes) {
      await fsp.rm(part, { force: true }).catch(() => {});
      return apply({
        type: ':failed', reason: 'checksum', retry: 'download',
        detail: `The download was ${received} bytes; the release publishes ${release.installer.bytes}.`,
      });
    }
    if (release.installer.sha256 && digest !== release.installer.sha256) {
      await fsp.rm(part, { force: true }).catch(() => {});
      return apply({
        type: ':failed', reason: 'checksum', retry: 'download',
        detail: 'The downloaded installer did not match the sha256 the release publishes.',
      });
    }
    // Atomic on NTFS, and a `.part` is never executable and never renamed.
    await fsp.rename(part, final);
    persisted.verified = { version: release.version, path: final, bytes: received, verifiedAt: now() };
    writePersisted();
    apply({ type: ':verified', bytes: received });
  }

  async function runDownload() {
    if (state.kind !== 'downloading') return;
    const release = state.release;
    const dir = path.join(updatesDir, release.version);
    const final = path.join(dir, release.installer.name);

    // Idempotence lives on the filesystem, not in a flag: the filename is the proof.
    if (persisted.verified && (persisted.verified.version !== release.version || persisted.verified.path !== final)) {
      persisted.verified = null;
      writePersisted();
    }
    const onDisk = await verifiedBytes(final, release).catch(() => null);
    if (!inFlight('downloading')) return;
    if (onDisk) {
      persisted.verified = { version: release.version, path: final, bytes: onDisk, verifiedAt: now() };
      writePersisted();
      return apply({ type: ':verified', bytes: onDisk });
    }
    const controller = new AbortController();
    inflight = controller;
    // `inflight` stays set for the whole transfer, so `cancel` can still abort a body
    // that has already been handed over by `fetch`.
    try { await streamToDisk(release, dir, final, `${final}.part`, controller); }
    finally { if (inflight === controller) inflight = null; }
  }

  function beginDownload() {
    const release = state.release ?? null;
    if (apply({ type: 'download', release })) void runDownload();
  }

  function cancelDownload() {
    const release = state.release ?? null;
    if (!apply({ type: 'cancel', release })) return;
    const pending = inflight;
    inflight = null;
    pending?.abort();
    if (release) void fsp.rm(partFor(release), { force: true }).catch(() => {});
  }

  function partFor(release) {
    return path.join(updatesDir, release.version, `${release.installer.name}.part`);
  }

  async function installerObstacle() {
    if (!isPackaged || platform !== 'win32') return null;
    let images;
    try { images = await listProcesses(); } catch { return null; }
    if (!images.some(image => imageInstallerPattern.test(String(image)))) return null;
    return 'Another Sunday Room installer is already running. Close it and try again.';
  }

  async function requestInstall() {
    if (state.kind !== 'ready') return snapshot();
    const obstacle = await installerObstacle();
    if (obstacle) {
      apply({ type: ':failed', reason: 'install', retry: 'install', detail: obstacle });
      return snapshot();
    }
    const release = state.release;
    const installer = path.join(updatesDir, release.version, release.installer.name);
    if (!fs.existsSync(installer)) {
      apply({
        type: ':failed', reason: 'install', retry: 'download',
        detail: 'The downloaded installer is no longer on disk. Download it again.',
      });
      return snapshot();
    }
    if (!apply({ type: 'install', release })) return snapshot();
    persisted.pendingInstall = { version: release.version, startedAt: now() };
    writePersisted();
    void (async () => {
      const appDir = path.dirname(execPath);
      const args = installerArgs(appDir);
      // An ACL heuristic, not a guarantee: `W_OK` is this process's view of the
      // directory, which an elevated installer can still write through. When it is not
      // writable, drop `/S` so the assisted installer shows its own UI and elevates
      // rather than exiting silently having installed nothing.
      const command = writableDir(appDir) ? args : args.filter(arg => arg !== '/S');
      try {
        // Teardown first: the Next child process must be provably dead before NSIS
        // looks for it, or `allowOnlyOneInstallerInstance.nsh` force-kills mid-shutdown.
        await beginShutdown();
        const child = spawn(installer, command, { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        // `app.exit` does not fire `before-quit`, so there is no second `app.quit()`
        // to interleave. It is only correct after the teardown above.
        exit(0);
      } catch (error) {
        apply({ type: ':failed', reason: 'install', retry: 'install', detail: `The installer could not be started. ${describe(error)}` });
      }
    })();
    return snapshot();
  }

  function setSource(value) {
    const repo = String(value ?? '').trim();
    if (!releaseRepoPattern.test(repo)) return false;
    source.repo = repo;
    source.origin = repo === defaultReleaseRepo ? 'packaged' : 'file';
    persisted.source = repo;
    persisted.lastCheckedAt = null;
    persisted.verified = null;
    persisted.pendingInstall = null;
    writePersisted();
    state = state.kind === 'unsupported' ? state : { kind: 'idle', lastCheckedAt: null };
    publish();
    if (state.kind === 'idle') beginCheck(false);
    return true;
  }

  async function sweep() {
    let entries;
    try { entries = await fsp.readdir(updatesDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = persisted.verified && persisted.verified.version === entry.name;
      const files = await fsp.readdir(path.join(updatesDir, entry.name)).catch(() => []);
      for (const name of files) {
        const full = path.join(updatesDir, entry.name, name);
        if (name.endsWith('.part')) await fsp.rm(full, { force: true }).catch(() => {});
        else if (!target && name.toLowerCase().endsWith('.exe')) await fsp.rm(full, { force: true }).catch(() => {});
      }
    }
  }

function validArgument(command, value) {
      // A check with no argument is a manual check. The bridge is allowed to omit it, so
      // refusing an absent flag would make the button fail for a reason the user cannot see.
      if (command === 'check') return value === undefined || typeof value === 'boolean';
      if (command === 'setSource') return typeof value === 'string' && releaseRepoPattern.test(value.trim());
      return true;
    }

  function refuse(name, message) {
    const error = new Error(message);
    error.name = name;
    throw error;
  }

  function invoke(command) {
    return async (event, value) => {
      if (!trusted(event)) return refuse('untrusted-sender', 'Sunday Room desktop bridge is unavailable.');
      // Belt and braces with `allowedCommand`: the table already refuses these, and this
      // stops the download and install paths from being reached at all on a dev build.
      if (command !== 'get' && command !== 'setSource' && allowedCommand && !allowedCommand(command)) {
        return refuse('unavailable', 'Installing an update runs only in the installed Windows app.');
      }
      if (command !== 'get' && !validArgument(command, value)) {
        return refuse('invalid-argument', 'That update request was not understood.');
      }
      if (command === 'setSource') { setSource(value); return snapshot(); }
      if (command === 'check') beginCheck(value !== false);
      else if (command === 'download') beginDownload();
      else if (command === 'cancel') cancelDownload();
      else if (command === 'install') await requestInstall();
      return snapshot();
    };
  }

  return {
    start() {
      stopped = false;
      // Resolves once the stale-file sweep is done, so a caller can wait for the disk to
      // be clean before the first check spends a request.
      return sweep().then(() => {
        const at = now();
        if (persisted.lastCheckedAt === null || at - persisted.lastCheckedAt >= AUTOMATIC_CHECK_GAP_MS) beginCheck(false);
      });
    },
    stop() {
      stopped = true;
      const pending = inflight;
      inflight = null;
      pending?.abort();
      if (state.kind === 'downloading' && state.release) {
        void fsp.rm(partFor(state.release), { force: true }).catch(() => {});
      }
    },
    snapshot,
    invoke,
    requestInstall,
  };
}

module.exports = {
  CH,
  createUpdateService,
  commandsFor,
  failureReasons,
  installerArgs,
  isNewer,
  parseRelease,
  reduce,
  updateCommands,
};
