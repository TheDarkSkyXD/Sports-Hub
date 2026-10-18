const {BrowserWindow}=require('electron');
const {randomUUID}=require('node:crypto');
const verificationPolicy=require('../lib/playback/verification-policy.json');
const path=require('node:path');

function createPlaybackVerifier({pageOrigin,streamOrigin,registerHost}={}){
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
    if(window&&!window.isDestroyed())window.destroy();
    for(const job of active.values())job.cancel();
    active.clear();
    clearTimeout(idleTimer);
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
    const owned=new BrowserWindow({show:false,width:Math.min(4,verificationPolicy.concurrency)*320,
      height:Math.ceil(verificationPolicy.concurrency/4)*260,useContentSize:true,webPreferences:{
      preload:path.join(__dirname,'player-preload.cjs'),
      partition:'playback-verifier',contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,disableDialogs:true,backgroundThrottling:false,
    }});
    window=owned;
    registerHost?.(owned);
    owned.webContents.setAudioMuted(true);
    owned.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    owned.webContents.on('will-navigate',(event,url)=>{if(url!==page())event.preventDefault();});
    owned.webContents.on('render-process-gone',()=>{
      if(!owned.isDestroyed())owned.destroy();
      for(const job of active.values())if(job.window===owned)job.cancel();
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
    if([...active.values()].some(job=>job.target.sessionId===target.sessionId)||
      active.size>=verificationPolicy.concurrency)return null;
    clearTimeout(idleTimer);
    const id=randomUUID();
    let settled=false;
    let canceling=false;
    let cancelTimer=null;
    let resolveResult;
    const result=new Promise(resolve=>{resolveResult=resolve;});
    const finish=value=>{
      if(settled)return;
      settled=true;
      clearTimeout(cancelTimer);
      signal.removeEventListener('abort',cancel);
      active.delete(id);
      resolveResult(value);
      if(!active.size)idleTimer=setTimeout(stop,30000);
    };
    const cancel=()=>{
      if(settled)return;
      const canceled={kind:'deferred',reason:signal.reason?.name==='TimeoutError'?'timeout':'cancelled',retryAfterMs:signal.reason?.name==='TimeoutError'?30000:2000};
      const owned=job.window;
      if(!owned||owned.isDestroyed()){finish(canceled);return;}
      if(canceling)return;
      canceling=true;
      const discard=()=>{
        if(settled)return;
        if(!owned.isDestroyed())owned.destroy();
        for(const pending of active.values())if(pending.window===owned)pending.cancel();
      };
      cancelTimer=setTimeout(discard,2000);
      void owned.webContents.executeJavaScript(`window.__sundayVerify?.cancel(${JSON.stringify(id)})`)
        .then(()=>finish(canceled),discard);
    };
    const job={id,cancel,target,window:null};
    active.set(id,job);
    signal.addEventListener('abort',cancel,{once:true});
    void ready().then(owned=>{
      if(settled)return;
      job.window=owned;
      const url=`${streamOrigin||origin}/api/stream/${encodeURIComponent(target.gameId)}/index.m3u8?session=${encodeURIComponent(target.sessionId)}&candidate=${encodeURIComponent(target.candidateId)}&generation=${target.generation}`;
      return owned.webContents.executeJavaScript(`window.__sundayVerify.assign(${JSON.stringify(id)},${JSON.stringify(url)})`)
        .then(value=>finish(value),()=>finish({kind:'deferred',reason:'upstream',retryAfterMs:30000}));
    },()=>finish({kind:'deferred',reason:'upstream',phase:'resolution',retryAfterMs:30000}));
    return {result,cancel};
  }
  return {configure,verify,stop};
}

module.exports={createPlaybackVerifier};
