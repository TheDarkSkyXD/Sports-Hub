const fs = require('node:fs');
const path = require('node:path');

// These literals are duplicated in `preload.cjs` because a sandboxed preload cannot
// require a sibling module. A typo cannot ship: `tests/packaged-desktop.mjs` calls the
// bridge end to end against the packaged app.
const CH = Object.freeze({
  status: 'sunday-update:status',
  get: 'sunday-update:get',
  check: 'sunday-update:check',
  download: 'sunday-update:download',
  install: 'sunday-update:install',
});

const AUTOMATIC_CHECK_GAP_MS = 6 * 60 * 60 * 1000;

// The update union lives in `lib/desktop-update.ts` and again here, because
// `eslint.config.mjs` forbids `desktop/**/*.cjs` from importing `lib/`. The failure
// vocabulary is the part that has to agree, so it is exported and asserted by
// `tests/desktop-update.test.ts`.
const updateCommands = Object.freeze(['check', 'download', 'install']);
const failureReasons = Object.freeze(['offline', 'rate-limited', 'unavailable', 'malformed', 'checksum', 'download', 'install']);

const defaultReleaseRepo = 'TheDarkSkyXD/Sports-Hub';
const releaseRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const retryEntry = Object.freeze({ check: 'idle', download: 'available', install: 'ready' });

function releasePageUrl(repo) {
  return `https://github.com/${repo}/releases`;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

// electron-updater reports failures as coded errors. The UI has its own vocabulary, and
// the two are kept apart on purpose: these strings are the library's, and a version bump
// can change them, so nothing user-facing is built out of them.
function classify(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = describe(error);
  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS|ERR_UPDATER_CHANNEL_DOES_NOT_EXIST/.test(code)) {
    return { reason: 'unavailable', detail: 'This source has no published release to install yet.', retry: undefined };
  }
  if (/ERR_UPDATER_INVALID_UPDATE_INFO|ERR_UPDATER_UPDATE_INFO_NOT_FOUND|ERR_UPDATER_BAD_CODE/.test(code)) {
    return { reason: 'malformed', detail: 'The published update record could not be read.', retry: null };
  }
  if (/ERR_UPDATER_SHA512|ERR_UPDATER_CHECKSUM|checksum/i.test(code) || /checksum/i.test(message)) {
    return { reason: 'checksum', detail: 'The download did not match the published checksum, so it was discarded.', retry: undefined };
  }
  if (/rate limit|429|secondary rate/i.test(message)) {
    return { reason: 'rate-limited', detail: 'GitHub reports almost no request budget left for this address. Try again later.', retry: undefined };
  }
  if (/ERR_UPDATER_DOWNLOAD|ERR_UPDATER_TEMP_DIR|ENOENT|ENOSPC|EACCES/i.test(code)) {
    return { reason: 'download', detail: 'The update could not be downloaded to this machine.', retry: undefined };
  }
  if (/ERR_UPDATER_LAUNCH_ERROR|ERR_UPDATER_INSTALL|install/i.test(code)) {
    return { reason: 'install', detail: 'The installer could not be started.', retry: undefined };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|socket hang up|Certificate/i.test(message)) {
    return { reason: 'offline', detail: 'Sunday Room could not reach the release source.', retry: undefined };
  }
  return { reason: 'offline', detail: message, retry: undefined };
}

// A row reads its release off the state it is leaving, never off the event, so a caller
// cannot offer a release the row would have refused.
function probeEvent(state, command) {
  const event = { type: command, release: state.release ?? null };
  if (typeof state.lastCheckedAt === 'number') event.at = state.lastCheckedAt;
  else event.at = 0;
  return event;
}

// The transition table, and the only place that knows what is legal. `commandsFor` is a
// projection of these same rows, so the buttons a user can press and the commands the
// system accepts cannot drift apart.
const commandRows = {
  unsupported: {},
  idle: { check: () => ({ kind: 'checking' }) },
  current: { check: () => ({ kind: 'checking' }) },
  checking: {},
  available: {
    // Re-checking is how a user finds out whether a newer release landed, so it has to
    // reach the feed. The known release rides along so a failure cannot lose it.
    check: state => ({ kind: 'checking', release: state.release }),
    download: state => ({ kind: 'downloading', release: state.release, percent: 0 }),
  },
  downloading: {},
  ready: { install: state => (state.release ? { kind: 'installing', release: state.release } : null) },
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
    // electron-updater reports a percentage rather than bytes, and the total it knows is
    // the file size from the published record. The progress bar is the whole story here.
    ':progress': (state, event) => ({ ...state, percent: Math.min(100, Math.max(0, Number(event.percent) || 0)) }),
    ':downloaded': (state, event) => ({ kind: 'ready', release: state.release, verifiedAt: event.at }),
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
  return { schema: 1, lastCheckedAt: null };
}

// Only the check time is ours now. electron-updater owns the downloaded file, its
// checksum, and its own cache, so there is no second record to keep in step with it.
function readPersisted(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultPersisted();
    const value = defaultPersisted();
    if (Number.isInteger(parsed.lastCheckedAt) && parsed.lastCheckedAt >= 0) value.lastCheckedAt = parsed.lastCheckedAt;
    return value;
  } catch { return defaultPersisted(); }
}

/**
 * Wires `electron-updater` to the state machine the UI already speaks.
 *
 * `updater` is injected so the machine can be tested without a network, a disk, or an
 * installer. It must expose `checkForUpdates`, `downloadUpdate`, `quitAndInstall`, and
 * the `checking-for-update`, `update-available`, `update-not-available`,
 * `download-progress`, `update-downloaded` and `error` events.
 */
function createUpdateService(deps) {
  const {
    updater, currentVersion, userDataDir, isPackaged, platform,
    repo = defaultReleaseRepo, origin = 'packaged', trusted = () => false,
    now = () => Date.now(), log = () => {}, broadcast = () => {},
  } = deps;

  const file = path.join(userDataDir, 'update.json');
  const persisted = readPersisted(file);
  const source = { repo, origin };
  let state = null;
  let stopped = false;

  // The source decides which installer this app will run, and the binary is unsigned, so
  // there is no signature to check that installer against. An installed build therefore
  // reads the feed electron-builder baked into it and nothing else: neither a stray
  // variable nor a rewritten `update.json` can move it. A development build may point
  // elsewhere, because it refuses to download and install anything.
  const allowedCommand = isPackaged && platform === 'win32'
    ? null
    : (command) => command === 'check';

  function initialState() {
    if (platform !== 'win32') return { kind: 'unsupported', reason: 'platform' };
    return { kind: 'idle', lastCheckedAt: persisted.lastCheckedAt };
  }

  function writePersisted() {
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(persisted));
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

  function refuse(name, message) {
    const error = new Error(message);
    error.name = name;
    throw error;
  }

  // electron-updater's UpdateInfo carries a version, a date, and release notes. The page
  // address is derived from the pinned repository rather than trusted from the response.
  // The workflow requires a tag of `v$version`, so the tag is rebuilt from the version
  // rather than taken from the feed, which reports the version without the prefix.
  function toRelease(info) {
    if (!info || typeof info !== 'object' || typeof info.version !== 'string') return null;
    const version = info.version.trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(version)) return null;
    const published = Date.parse(info.releaseDate ?? '');
    const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes
      : typeof info.releaseName === 'string' ? info.releaseName : '';
    return Object.freeze({
      version,
      pageUrl: `${releasePageUrl(source.repo)}/tag/${encodeURIComponent(`v${version}`)}`,
      notes,
      publishedAt: Number.isFinite(published) && published >= 0 ? Math.floor(published) : null,
    });
  }

  function fail(error, retry) {
    const classified = classify(error);
    // A record that cannot be read is not an outage: pressing again would read the same
    // record, so there is nothing to retry.
    const choice = classified.retry === null ? null : retry;
    log(`update: ${describe(error)}`);
    apply({ type: ':failed', reason: classified.reason, retry: choice, detail: classified.detail });
  }

  function beginCheck() {
    // No in-flight flag: the table already refuses a check from `checking`, so a second
    // press while one is running is free without a second source of truth.
    if (!apply({ type: 'check' })) return;
    let result = null;
    try {
      result = updater.checkForUpdates();
    } catch (error) {
      fail(error, 'check');
      return;
    }
    // The events own the outcome. This only stops an unhandled rejection when the library
    // reports through `error` instead of rejecting.
    Promise.resolve(result).catch(error => {
      if (state?.kind === 'checking') fail(error, 'check');
    });
  }

  function beginDownload() {
    if (!apply({ type: 'download' })) return;
    let result = null;
    try {
      result = updater.downloadUpdate();
    } catch (error) {
      fail(error, 'download');
      return;
    }
    Promise.resolve(result).catch(error => {
      if (state?.kind === 'downloading') fail(error, 'download');
    });
  }

  function listen() {
    const on = (event, handler) => { updater.on(event, handler); return () => updater.removeListener(event, handler); };
    const offs = [
      on('checking-for-update', () => { if (state?.kind !== 'checking') apply({ type: 'check' }); }),
      on('update-available', info => {
        const release = toRelease(info);
        if (!release) { apply({ type: ':failed', reason: 'malformed', retry: null, detail: 'The published release could not be read.' }); return; }
        // A check that succeeded records its time whether or not it found something, or
        // a pending update would make every launch ask again.
        persisted.lastCheckedAt = now();
        writePersisted();
        apply({ type: ':checked', release });
      }),
      on('update-not-available', () => {
        persisted.lastCheckedAt = now();
        writePersisted();
        apply({ type: ':checked', release: null });
      }),
      on('download-progress', progress => apply({ type: ':progress', percent: progress?.percent })),
      on('update-downloaded', () => apply({ type: ':downloaded' })),
      on('error', error => {
        // A failure during a download is retryable as a download; during a check, as a check.
        const retry = state?.kind === 'downloading' ? 'download' : 'check';
        fail(error, retry);
      }),
    ];
    return () => { for (const off of offs) off(); };
  }

  function validArgument(command, value) {
    // A check with no argument is a manual check. The bridge is allowed to omit it, so
    // refusing an absent flag would make the button fail for a reason the user cannot see.
    if (command === 'check') return value === undefined || typeof value === 'boolean';
    return true;
  }

  function invoke(command) {
    return async (event, value) => {
      if (!trusted(event)) return refuse('untrusted-sender', 'Sunday Room desktop bridge is unavailable.');
      // The table already refuses these, but the download and install paths are the ones
      // that write to the machine and run a binary, so they are checked again here. A
      // development build must never reach them, whatever the state says.
      if (command !== 'get' && allowedCommand && !allowedCommand(command)) {
        return refuse('unavailable', 'Installing an update runs only in the installed Windows app.');
      }
      if (command !== 'get' && !validArgument(command, value)) {
        return refuse('invalid-argument', 'That update request was not understood.');
      }
      if (command === 'check') beginCheck();
      else if (command === 'download') beginDownload();
      else if (command === 'install') {
        if (state?.kind !== 'ready') return snapshot();
        // Silent with a forced relaunch, which is what an in-app update means. The library
        // passes `/D=` last and unquoted, which is what `desktop/installer.nsh` needs to
        // restore the install directory.
        if (apply({ type: 'install' })) updater.quitAndInstall(true, true);
      }
      return snapshot();
    };
  }

  return {
    get currentVersion() { return currentVersion; },
    snapshot,
    invoke,
    start() {
      stopped = false;
      state = initialState();
      stopListening = listen();
      publish();
      // electron-updater has no "check at most every N hours" of its own, so the gap stays
      // here. It is only ever crossed once per launch, so it costs nothing to be simple.
      return Promise.resolve().then(() => {
        if (persisted.lastCheckedAt === null || now() - persisted.lastCheckedAt >= AUTOMATIC_CHECK_GAP_MS) beginCheck();
      });
    },
    stop() {
      stopped = true;
      stopListening?.();
      stopListening = null;
      state = null;
    },
  };
}

module.exports = {
  CH,
  createUpdateService,
  updateCommands,
  failureReasons,
  defaultReleaseRepo,
  releaseRepoPattern,
  reduce,
  commandsFor,
};
