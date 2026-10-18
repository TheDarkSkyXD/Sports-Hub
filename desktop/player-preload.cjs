const {contextBridge,ipcRenderer}=require('electron');

contextBridge.exposeInMainWorld('sundayPlayer',Object.freeze({
  mount:value=>ipcRenderer.invoke('sunday-player:mount',value),
  update:value=>ipcRenderer.invoke('sunday-player:update',value),
  control:value=>ipcRenderer.invoke('sunday-player:control',value),
  release:value=>ipcRenderer.invoke('sunday-player:release',value),
  subscribe:listener=>{
    if(typeof listener!=='function')return ()=>{};
    const wrapped=(_event,value)=>listener(value);
    ipcRenderer.on('sunday-player:state',wrapped);
    return ()=>ipcRenderer.removeListener('sunday-player:state',wrapped);
  },
}));
