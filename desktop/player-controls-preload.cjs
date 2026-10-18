const {contextBridge,ipcRenderer}=require('electron');

contextBridge.exposeInMainWorld('sundayPlayerControls',Object.freeze({
  ready:()=>ipcRenderer.invoke('sunday-player-controls:ready'),
  dispatch:value=>ipcRenderer.invoke('sunday-player-controls:dispatch',value),
  subscribe:listener=>{
    if(typeof listener!=='function')return ()=>{};
    const wrapped=(_event,value)=>listener(value);
    ipcRenderer.on('sunday-player-controls:state',wrapped);
    return ()=>ipcRenderer.removeListener('sunday-player-controls:state',wrapped);
  },
}));
