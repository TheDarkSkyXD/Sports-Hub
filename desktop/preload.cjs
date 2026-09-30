const { contextBridge, ipcRenderer } = require('electron');

// These literals are duplicated in `desktop/update.cjs` because a sandboxed preload
// cannot require a sibling module. A typo cannot ship: `tests/packaged-desktop.mjs`
// calls the bridge end to end against the packaged app.
const CH = Object.freeze({
  status: 'sunday-update:status',
  get: 'sunday-update:get',
  check: 'sunday-update:check',
  download: 'sunday-update:download',
  install: 'sunday-update:install',
  setSource: 'sunday-update:set-source',
});

// The renderer never sees an Electron object, an IpcRendererEvent, or a Node error.
// Commands resolve with the resulting `UpdateStatus`; bad news is `state.kind` of
// `'failed'`. A rejection carries `error.name` of `'untrusted-sender'` or
// `'invalid-argument'` and nothing else — those are facts about the call, not about
// the update. The listener identity stays here, so the caller gets back its own
// unsubscribe closure and never holds the wrapper it is paired with.
contextBridge.exposeInMainWorld('sundayDesktop', Object.freeze({
  get: () => ipcRenderer.invoke(CH.get),
  setSource: (url) => ipcRenderer.invoke(CH.setSource, String(url ?? '')),
  // `true` marks a manual check, which the main process rate-limits separately from the
  // automatic one. Omitting it made every manual check fail argument validation.
  check: (manual = true) => ipcRenderer.invoke(CH.check, manual === true),
  download: () => ipcRenderer.invoke(CH.download),
  install: () => ipcRenderer.invoke(CH.install),
  subscribe: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, status) => {
      // One throwing subscriber must not take down the main process publish loop.
      try { listener(status); } catch {}
    };
    ipcRenderer.on(CH.status, wrapped);
    return () => { ipcRenderer.removeListener(CH.status, wrapped); };
  },
}));
