const {randomUUID}=require('node:crypto');
const {publicNetworkUrl,pinnedAddress,sourceRequestAllowed,createNetworkBudget,createPinnedProxy}=require('./source-network.cjs');

const DEADLINE_MS=35_000;
const MAX_BYTES=4*1024*1024;
const MAX_QUEUED=12;
const SPORTS='nba|nfl|nhl|mlb|cfb|wnba|mma|boxing|f1|nascar|motogp|wwe';
const CATEGORY=new RegExp(`^/category/(${SPORTS})/$`);
const EVENT=new RegExp(`^/(?:${SPORTS})[1-9][0-9]{0,2}/$`);

function sourcePageUrl(value) {
  try {
    const url=new URL(value);
    return value===url.href&&url.origin==='https://dudestream1.com'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&
      (CATEGORY.test(url.pathname)||EVENT.test(url.pathname))?url:null;
  } catch {return null;}
}

function pageSnapshot(expectedUrl,category,maxBytes) {
  const body=document.body?.innerText.slice(0,64_000)||'';
  const challenge=/just a moment|verify you are human|enable javascript and cookies|checking your browser/i.test(body);
  const heading=document.querySelector('h1')?.textContent.trim().replace(/\s+/g,' ').toLowerCase()||'';
  const ready=location.href===expectedUrl&&!challenge&&(category?heading===`category: ${category}`:
    !!document.querySelector('article.page-content-single,article.hentry .entry-title,article .entry-content'));
  const html=ready?document.documentElement.outerHTML:null;
  const tooLarge=html!==null&&(html.length>maxBytes||new TextEncoder().encode(html).byteLength>maxBytes);
  return {ready,url:location.href,challenge,tooLarge,body:tooLarge?null:html};
}

function createSourcePageReader({BrowserWindow,session,validateNetworkUrl=publicNetworkUrl,resolveAddress=pinnedAddress,createProxy=createPinnedProxy}={}) {
  let stopped=false;
  let active=null;
  let queued=[];
  let sourceSession;
  let sourceProxy;
  const failed=reason=>({kind:'failed',reason});

  function finish(job,result,error) {
    if(job.settled)return;
    job.settled=true;
    job.network?.close();
    clearTimeout(job.deadline);
    clearInterval(job.poll);
    job.signal.removeEventListener('abort',job.abort);
    queued=queued.filter(waiter=>waiter!==job);
    if(active===job) {
      active=null;
      if(job.window&&!job.window.isDestroyed())job.window.destroy();
    }
    if(error)job.reject(error);else job.resolve(result);
    pump();
  }

  function sharedSession() {
    if(sourceSession)return sourceSession;
    sourceSession=session.fromPartition(`source-page-reader-${randomUUID()}`);
    sourceSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    sourceSession.setPermissionCheckHandler(()=>false);
    sourceSession.on('will-download',(event,item)=>{event.preventDefault();item.cancel();});
    sourceProxy=createProxy({session:sourceSession,getBudget:()=>active?.network,pinAddress:resolveAddress});
    sourceSession.webRequest.onBeforeRequest((details,callback)=>{
      callback({cancel:!active||!sourceRequestAllowed(details,active.url)||!validateNetworkUrl(details.url)||
        ['media','image','font','ping','cspReport'].includes(details.resourceType)||!active.network.request()});
    });
    return sourceSession;
  }

  async function inspect(job) {
    if(active!==job||job.inspecting||job.window.isDestroyed())return;
    job.inspecting=true;
    try {
      const category=CATEGORY.exec(new URL(job.url).pathname)?.[1]||null;
      const snapshot=await job.window.webContents.executeJavaScript(`(${pageSnapshot.toString()})(${JSON.stringify(job.url)},${JSON.stringify(category)},${MAX_BYTES})`);
      if(active!==job)return;
      job.challenge=snapshot?.challenge===true;
      if(job.status!==200||snapshot?.ready!==true)return;
      if(snapshot.tooLarge===true) {finish(job,failed('response-too-large'));return;}
      if(snapshot.url!==job.url||typeof snapshot.body!=='string') {finish(job,failed('page-changed'));return;}
      if(Buffer.byteLength(snapshot.body,'utf8')>MAX_BYTES) {finish(job,failed('response-too-large'));return;}
      finish(job,{kind:'complete',url:job.url,body:snapshot.body});
    } catch {} finally {job.inspecting=false;}
  }

  function pump() {
    if(stopped||active)return;
    const job=queued.shift();
    if(!job)return;
    if(job.expiresAt<=Date.now()) {finish(job,failed('timeout'));return;}
    active=job;
    job.network=createNetworkBudget({requests:200,frames:16,onLimit:reason=>finish(job,failed(reason))});
    try {
      job.window=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{session:sharedSession(),sandbox:true,
        contextIsolation:true,nodeIntegration:false,webSecurity:true,disableDialogs:true,backgroundThrottling:false}});
      const contents=job.window.webContents;
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      contents.setAudioMuted(true);
      contents.setWindowOpenHandler(()=>({action:'deny'}));
      contents.on('login',(event,_details,authInfo,callback)=>{
        if(!authInfo.isProxy||authInfo.host!=='127.0.0.1')return;
        event.preventDefault();callback(sourceProxy.credentials.username,sourceProxy.credentials.password);
      });
      contents.on('frame-created',()=>{
        if(active!==job)return;
        try{job.network.frames(contents.mainFrame.framesInSubtree.length);}catch{finish(job,failed('window-closed'));}
      });
      const navigation=(event,target)=>{
        try {
          const next=new URL(target),expected=new URL(job.url);
          if(next.origin===expected.origin&&next.pathname===expected.pathname&&!next.username&&!next.password&&!next.hash)return;
        } catch {}
        event.preventDefault();
      };
      contents.on('will-navigate',navigation);
      contents.on('will-redirect',navigation);
      contents.on('did-navigate',(_event,url,status)=>{
        if(active===job&&url===job.url) {
          job.status=status;
          void inspect(job);
        }
      });
      contents.on('did-finish-load',()=>{void inspect(job);});
      job.window.on('closed',()=>finish(job,failed('window-closed')));
      job.poll=setInterval(()=>{void inspect(job);},500);
      void sourceProxy.start().then(()=>{if(active===job)return job.window.loadURL(job.url);}).then(()=>inspect(job)).catch(error=>{
        if(active===job&&!String(error?.message).includes('ERR_ABORTED'))finish(job,failed('network-error'));
      });
    } catch {finish(job,failed('unavailable'));}
  }

  function read(value,signal) {
    signal.throwIfAborted();
    const url=sourcePageUrl(value);
    if(!url)return Promise.resolve(failed('unsupported-address'));
    if(stopped)return Promise.resolve(failed('closed'));
    if(!BrowserWindow||!session)return Promise.resolve(failed('unavailable'));
    if(queued.length>=MAX_QUEUED)return Promise.resolve(failed('capacity'));
    return new Promise((resolve,reject)=>{
      const job={url:url.href,signal,resolve,reject,settled:false,expiresAt:Date.now()+DEADLINE_MS,status:0,challenge:false};
      job.abort=()=>finish(job,null,signal.reason);
      job.deadline=setTimeout(()=>finish(job,failed(job.challenge||job.status===403?'challenge':'timeout')),DEADLINE_MS);
      signal.addEventListener('abort',job.abort,{once:true});
      queued.push(job);
      pump();
    });
  }

  function stop() {
    if(stopped)return;
    stopped=true;
    if(active)finish(active,failed('closed'));
    for(const job of [...queued])finish(job,failed('closed'));
    if(sourceSession) {
      sourceProxy.stop();
      sourceSession.webRequest.onBeforeRequest(null);
      void sourceSession.clearStorageData().catch(()=>{});
      void sourceSession.clearCache().catch(()=>{});
    }
  }
  return {read,stop};
}

module.exports={createSourcePageReader};
