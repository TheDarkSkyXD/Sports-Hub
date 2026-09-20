const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sundayDesktop', Object.freeze({
  openGame: (gameId, server = 0, requestId) => ipcRenderer.invoke('room:open', { gameId, server, requestId }),
  closeGame: gameId => ipcRenderer.invoke('room:close', gameId),
  layout: items => ipcRenderer.send('room:layout', items),
  controls: value => ipcRenderer.send('room:controls', value),
  setFullscreen: value => ipcRenderer.invoke('room:set-fullscreen', value),
  onFullscreenChange: callback => {
    const listener = (_event, value) => { if(typeof value==='boolean')callback(value); };
    ipcRenderer.on('room:fullscreen-change', listener);
    return () => ipcRenderer.removeListener('room:fullscreen-change', listener);
  },
  onOverlayEscape: callback => {
    const listener = () => callback();
    ipcRenderer.on('room:overlay-escape', listener);
    return () => ipcRenderer.removeListener('room:overlay-escape', listener);
  },
  subscribe: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('room:status', listener);
    return () => ipcRenderer.removeListener('room:status', listener);
  },
}));
