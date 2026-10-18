const {randomUUID}=require('node:crypto');
const path=require('node:path');
const dispatchers=new WeakMap();

const shortcuts=new Set(['toggle-playing','toggle-audible','toggle-room-fullscreen','toggle-theater',
  'focus-player-1','focus-player-2','focus-player-3','focus-player-4','escape']);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validAction(action){
  if(!action||typeof action!=='object')return false;
  switch(action.kind){
    case 'set-playing':return exact(action,['kind','playing'])&&typeof action.playing==='boolean';
    case 'set-audible':return exact(action,['kind','audible'])&&typeof action.audible==='boolean';
    case 'set-volume':return exact(action,['kind','volume'])&&Number.isFinite(action.volume)&&action.volume>=0&&action.volume<=100;
    case 'set-fullscreen':return exact(action,['kind','fullscreen'])&&typeof action.fullscreen==='boolean';
    case 'set-picture-in-picture':return exact(action,['kind','active'])&&typeof action.active==='boolean';
    case 'set-quality':return exact(action,['kind','selection'])&&
      (exact(action.selection,['kind'])&&action.selection.kind==='auto'||exact(action.selection,['kind','id'])&&
        action.selection.kind==='level'&&typeof action.selection.id==='string'&&/^quality-[a-f0-9-]{36}-\d+$/.test(action.selection.id)&&action.selection.id.length<=128);
    case 'focus-player':return exact(action,['kind']);
    case 'shortcut':return exact(action,['kind','shortcut'])&&shortcuts.has(action.shortcut);
    default:return false;
  }
}

function createPlayerChrome({createView,ipcMain,isCurrent,act}){
  const entries=new Map();
  let stopped=false;
  const invalid=()=>new Error('Player controls are unavailable');
  function live(entry,active){
    return !stopped&&!entry.host.closed&&!entry.host.window.isDestroyed()&&!entry.host.contents.isDestroyed()&&
      !entry.contents.isDestroyed()&&entry.active===active&&!!active&&isCurrent(active.offer,entry.host);
  }
  function sender(dispatcher,event){
    const entry=dispatcher.entries.get(event.sender);
    if(!entry||event.senderFrame!==entry.contents.mainFrame||event.senderFrame.url!==entry.url)throw invalid();
    try{if(new URL(entry.host.contents.mainFrame.url).origin!==entry.host.origin)throw invalid();}catch{throw invalid();}
    return entry;
  }
  function display(entry){entry.view.setVisible(entry.ready&&entry.loaded&&live(entry,entry.active));}
  function listen(){
    let dispatcher=dispatchers.get(ipcMain);if(dispatcher)return dispatcher;
    dispatcher={entries:new Map()};dispatchers.set(ipcMain,dispatcher);
    ipcMain.handle('sunday-player-controls:ready',async event=>{
      const entry=sender(dispatcher,event);entry.ready=true;entry.display();return entry.current(entry.active)?entry.active.snapshot:null;
    });
    ipcMain.handle('sunday-player-controls:dispatch',async(event,input)=>{
      const entry=sender(dispatcher,event),active=entry.active;
      if(!exact(input,['binding','action'])||input.binding!==active?.binding||!validAction(input.action)||!entry.ready||!entry.loaded||!entry.current(active))throw invalid();
      const current=()=>entry.ready&&entry.loaded&&entry.current(active)&&entry.contents.mainFrame.url===entry.url;
      const result=await entry.act(entry.host,active.offer,input.action,current);
      if(!current())throw invalid();
      return result;
    });
    return dispatcher;
  }
  function send(entry){
    if(entry.loaded&&!entry.contents.isDestroyed())entry.contents.send('sunday-player-controls:state',entry.active?.snapshot??null);
  }
  function hide(host,offer){
    const entry=entries.get(host);if(!entry||offer&&entry.active?.offer!==offer)return;
    const active=entry.active;entry.active=null;entry.view.setVisible(false);if(active)send(entry);
  }
  function destroy(host){
    const entry=entries.get(host);if(!entry)return;
    entries.delete(host);entry.active=null;
    try{host.window.contentView.removeChildView(entry.view);}catch{}
    if(!entry.contents.isDestroyed())entry.contents.close();
    const dispatcher=dispatchers.get(ipcMain);dispatcher?.entries.delete(entry.contents);
    if(dispatcher&&!dispatcher.entries.size){
      ipcMain.removeHandler('sunday-player-controls:ready');ipcMain.removeHandler('sunday-player-controls:dispatch');dispatchers.delete(ipcMain);
    }
  }
  function raise(host){
    const entry=entries.get(host);if(entry&&!entry.contents.isDestroyed())host.window.contentView.addChildView(entry.view);
  }
  function bind(host,offer,bounds,snapshot){
    if(stopped||!isCurrent(offer,host))return;
    let entry=entries.get(host);
    if(!entry){
      const view=createView({session:host.contents.session,preload:path.join(__dirname,'player-controls-preload.cjs'),
        sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,disableDialogs:true,backgroundThrottling:false});
      const contents=view.webContents,url=`${host.origin}/player-controls`;
      entry={host,view,contents,url,active:null,loaded:false,ready:false,act,current:active=>live(entry,active),display:()=>display(entry)};entries.set(host,entry);
      listen().entries.set(contents,entry);
      view.setBackgroundColor('#00000000');contents.setWindowOpenHandler(()=>({action:'deny'}));
      for(const name of ['will-navigate','will-redirect','will-frame-navigate'])contents.on(name,(event,destination)=>{
        if(event.isMainFrame!==false&&(event.url||destination)!==url)event.preventDefault();
      });
      contents.on('will-attach-webview',event=>event.preventDefault());
      contents.on('did-start-navigation',(_event,_url,inPlace,main)=>{
        if(main&&!inPlace){entry.ready=false;entry.loaded=false;entry.view.setVisible(false);}
      });
      const loaded=()=>{
        if(entries.get(host)!==entry||contents.isDestroyed()||entry.loaded||contents.mainFrame.url!==url)return;
        entry.loaded=true;send(entry);display(entry);
      };
      contents.on('did-finish-load',loaded);
      contents.on('render-process-gone',()=>destroy(host));
      contents.once('destroyed',()=>{if(entries.get(host)===entry)destroy(host);});
      view.setVisible(false);host.window.contentView.addChildView(view);
      void contents.loadURL(url).then(loaded).catch(()=>destroy(host));
    }
    if(entry.active?.offer!==offer)entry.active={offer,binding:randomUUID()};
    const active=entry.active,next={binding:active.binding,...snapshot},signature=JSON.stringify(next);
    if(signature!==active.signature){active.signature=signature;active.snapshot=next;send(entry);}
    entry.view.setBounds(bounds);display(entry);raise(host);
  }
  function focus(host){const entry=entries.get(host);if(entry?.ready&&entry.loaded&&live(entry,entry.active))entry.contents.focus();}
  function stop(){
    stopped=true;for(const host of entries.keys())destroy(host);
  }
  return {bind,hide,raise,focus,destroy,stop};
}

module.exports={createPlayerChrome};
