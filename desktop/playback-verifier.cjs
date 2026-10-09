const {BrowserWindow}=require('electron');
const {randomUUID}=require('node:crypto');

function createPlaybackVerifier({pageOrigin,streamOrigin}={}){
  for(const value of [pageOrigin,streamOrigin])
    if(value!==undefined&&!/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(value))
      throw new Error('Invalid verifier origin');
  let origin=null;
  let window=null;
  let loading=null;
  let idleTimer=null;
  const active=new Map();
  const page=()=>`${pageOrigin||origin}/internal/playback-verifier`;
  function stop(){
    clearTimeout(idleTimer);
    for(const job of active.values())job.cancel();
    active.clear();
    if(window&&!window.isDestroyed())window.destroy();
    window=null;
    loading=null;
  }
  function configure(value){
    if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value))throw new Error('Invalid verifier origin');
    if(origin&&origin!==value)stop();
    origin=value;
  }
  async function ready(){
    if(!origin)throw new Error('Verifier app is not ready');
    if(loading)return loading;
    if(window&&!window.isDestroyed()&&window.webContents.getURL()===page())return window;
    const owned=new BrowserWindow({show:false,width:800,height:260,webPreferences:{
      contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,
    }});
    window=owned;
    owned.webContents.setAudioMuted(true);
    owned.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    owned.webContents.on('will-navigate',(event,url)=>{if(url!==page())event.preventDefault();});
    owned.webContents.on('render-process-gone',()=>{
      for(const job of active.values())job.cancel();
      if(!owned.isDestroyed())owned.destroy();
      if(window===owned)window=null;
    });
    loading=(async()=>{
      await owned.loadURL(page());
      for(let attempt=0;attempt<100;attempt++){
        if(owned.isDestroyed())throw new Error('Verifier window ended');
        if(await owned.webContents.executeJavaScript('typeof window.__sundayVerify?.assign === "function"'))return owned;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('Verifier page did not become ready');
    })();
    try{return await loading;}
    catch(error){if(!owned.isDestroyed())owned.destroy();if(window===owned)window=null;throw error;}
    finally{loading=null;}
  }
  function verify(target,signal){
    if(!origin||signal.aborted)return null;
    const slot=[0,1].find(index=>!active.has(index));
    if(slot===undefined)return null;
    clearTimeout(idleTimer);
    const id=randomUUID();
    let settled=false;
    let resolveResult;
    const result=new Promise(resolve=>{resolveResult=resolve;});
    const finish=value=>{
      if(settled)return;
      settled=true;
      signal.removeEventListener('abort',cancel);
      active.delete(slot);
      resolveResult(value);
      if(!active.size)idleTimer=setTimeout(stop,30000);
    };
    const cancel=()=>{
      if(window&&!window.isDestroyed())void window.webContents.executeJavaScript(
        `window.__sundayVerify?.cancel(${JSON.stringify(id)})`).catch(()=>{});
      finish({kind:'deferred'});
    };
    active.set(slot,{cancel});
    signal.addEventListener('abort',cancel,{once:true});
    void ready().then(owned=>{
      if(settled)return;
      const url=`${streamOrigin||origin}/api/stream/${encodeURIComponent(target.gameId)}/index.m3u8?session=${encodeURIComponent(target.sessionId)}&candidate=${encodeURIComponent(target.candidateId)}&generation=${target.generation}`;
      return owned.webContents.executeJavaScript(`window.__sundayVerify.assign(${slot},${JSON.stringify(id)},${JSON.stringify(url)})`)
        .then(value=>finish(value),()=>finish({kind:'deferred'}));
    },()=>finish({kind:'deferred'}));
    return {result,cancel};
  }
  return {configure,verify,stop};
}

module.exports={createPlaybackVerifier};
