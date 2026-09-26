const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('sundayDesktop',Object.freeze({}));
