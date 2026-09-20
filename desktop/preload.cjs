const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sundayDesktop', Object.freeze({
  openGame: (gameId, server = 0) => ipcRenderer.invoke('room:open', { gameId, server }),
  closeGame: gameId => ipcRenderer.invoke('room:close', gameId),
  layout: items => ipcRenderer.send('room:layout', items),
  controls: value => ipcRenderer.send('room:controls', value),
  subscribe: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('room:status', listener);
    return () => ipcRenderer.removeListener('room:status', listener);
  },
}));
