const { BrowserWindow,session } = require('electron');
const { ORIGIN,CATEGORY_URLS,MAX_PAGE_BYTES,MAX_CHECKPOINT_BYTES,eventUrl } = require('./streameast-catalog.cjs');
const { runStreameastSweep } = require('./streameast-sweep.cjs');

const READY_TIMEOUT_MS=30000;

function allowedNavigation(value,requestedPath) {
  try {
    const url=new URL(value);
    if(url.username||url.password||url.port||url.hash)return false;
    if(url.origin===ORIGIN&&url.pathname===requestedPath&&!url.search)return true;
    if(url.origin==='https://auth.streamea.st'&&url.pathname==='/SsoHandoff.php'&&
      [...url.searchParams.keys()].sort().join(',')==='h,p')
      return url.searchParams.get('h')==='v2.streameast.ga'&&url.searchParams.get('p')===requestedPath;
    if(url.origin===ORIGIN&&url.pathname==='/connect.php'&&
      [...url.searchParams.keys()].join(',')==='redirect')
      return url.searchParams.get('redirect')===requestedPath;
    return false;
  } catch{return false;}
}

function pause(ms,signal) {
  return new Promise((resolve,reject)=>{
    if (signal.aborted) {reject(new Error('unavailable'));return;}
    const onAbort=()=>{clearTimeout(timer);reject(new Error('unavailable'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}
async function beforeDeadline(promise,deadline,signal,current) {
  if(signal.aborted)throw new Error('unavailable');
  const remaining=deadline-Date.now();
  if (remaining<=0) throw new Error('timeout');
  let timer,onAbort;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>{if(!current.isDestroyed())current.webContents.stop();reject(new Error('timeout'));},remaining);
      onAbort=()=>{if(!current.isDestroyed())current.webContents.stop();reject(new Error('unavailable'));};
      signal.addEventListener('abort',onAbort,{once:true});
    })]);
  } finally {clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}

function createStreameastCollector({origin,controlToken}) {
  let window,active,timer,controller;
  let stopped=false;
  let requestedPath='';
  const partition='streameast-catalog';
  const sourceSession=session.fromPartition(partition);
  sourceSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  sourceSession.setPermissionCheckHandler(()=>false);
  sourceSession.on('will-download',event=>event.preventDefault());

  function browser() {
    if (window && !window.isDestroyed()) return window;
    window=new BrowserWindow({title:'StreamEast collector',show:false,webPreferences:{
      partition,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,
    }});
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    for (const name of ['will-navigate','will-redirect']) window.webContents.on(name,event=>{
      if(!event.isMainFrame)return;
      if(allowedNavigation(event.url,requestedPath))return;
      event.preventDefault();
    });
    return window;
  }

  async function document(url,page,league,signal) {
    const path=new URL(url).pathname;
    const category=page==='category';
    if (category ? url!==CATEGORY_URLS[league] : !eventUrl(page==='server'?url.replace(/\d{1,4}$/,''):url,league))
      throw new Error('parser-changed');
    const current=browser();
    const deadline=Date.now()+READY_TIMEOUT_MS;
    requestedPath=path;
    let pageStatus=0;
    let documentReady=false;
    const onNavigate=(_event,navigatedUrl,httpResponseCode,_status,isMainFrame)=>{
      if(isMainFrame) {
        documentReady=false;
        pageStatus=navigatedUrl===url?httpResponseCode:0;
      }
    };
    const onReady=()=>{documentReady=current.webContents.getURL()===url;};
    current.webContents.on('did-frame-navigate',onNavigate);
    current.webContents.on('dom-ready',onReady);
    try {
      void current.loadURL(url).catch(()=>{});
      let challenge=false;
      while(Date.now()<deadline) {
        if(pageStatus>=400)throw new Error('unavailable');
        if (signal.aborted || current.isDestroyed()) throw new Error('unavailable');
        if(!documentReady || pageStatus<200 || pageStatus>=300) {await pause(400,signal);continue;}
        try {
          const state=await beforeDeadline(current.webContents.mainFrame.executeJavaScript(`({url:location.href,title:document.title,cards:document.querySelectorAll('.m-card').length,
          empty:!!document.querySelector('#m-schedule-empty.m-empty .m-empty__title') && /no (?:college football|cfb|nfl) games available/i.test(document.querySelector('#m-schedule-empty.m-empty .m-empty__title').textContent||''),
          detail:!!document.querySelector('.stream-alt-list a.stream-alt-item')})`),deadline,signal,current);
          challenge=/just a moment|verify you are human|checking your browser/i.test(state.title);
          if (state.url===url && !challenge && (category ? state.cards>0 || state.empty : state.detail)) {
            if (category) {
              for (;;) {
                const before=await beforeDeadline(current.webContents.mainFrame.executeJavaScript(`({count:document.querySelectorAll('.m-card').length,
                more:!!document.querySelector('button.m-show-more[aria-label="Load more games"]'),
                enabled:!!document.querySelector('button.m-show-more[aria-label="Load more games"]:not([disabled])')})`),deadline,signal,current);
                if (!before.more) break;
                if (!before.enabled) {await pause(300,signal);continue;}
                await beforeDeadline(current.webContents.mainFrame.executeJavaScript(`document.querySelector('button.m-show-more[aria-label="Load more games"]').click()`),deadline,signal,current);
                let grew=false;
                while(Date.now()<deadline) {
                  const after=await beforeDeadline(current.webContents.mainFrame.executeJavaScript(`({count:document.querySelectorAll('.m-card').length,
                  more:!!document.querySelector('button.m-show-more[aria-label="Load more games"]')})`),deadline,signal,current);
                  if (after.count>before.count || !after.more) {grew=true;break;}
                  await pause(300,signal);
                }
                if (!grew) throw new Error('timeout');
              }
            }
            const html=await beforeDeadline(current.webContents.mainFrame.executeJavaScript('document.documentElement.outerHTML'),deadline,signal,current);
            if (Buffer.byteLength(html,'utf8')>MAX_PAGE_BYTES) throw new Error('limit');
            return html;
          }
        } catch(error) {if(['limit','timeout','unavailable'].includes(error?.message))throw error;}
        await pause(400,signal);
      }
      throw new Error(challenge?'blocked':'timeout');
    } finally {
      if(!current.isDestroyed()) {
        current.webContents.off('did-frame-navigate',onNavigate);
        current.webContents.off('dom-ready',onReady);
        current.webContents.stop();
      }
    }
  }

  async function checkpoint(catalog,signal) {
    const body=JSON.stringify({kind:'streameast-catalog',catalog});
    if (Buffer.byteLength(body,'utf8')>MAX_CHECKPOINT_BYTES) throw new Error('limit');
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const response=await fetch(`${origin}/api/internal/streameast`,{method:'POST',
          headers:{'content-type':'application/json','x-sunday-control-token':controlToken},body,
          signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
        if(response.status===204)return;
        await response.body?.cancel();
        if(response.status>=400&&response.status<500)throw new Error('parser-changed');
      } catch(error) {if(signal.aborted||error?.message==='parser-changed')throw error;}
      if(attempt===0)await pause(500,signal);
    }
    throw new Error('unavailable');
  }

  function requestSweep() {
    if(stopped)return;
    if(active)return active;
    controller=new AbortController();
    active=runStreameastSweep({read:document,send:catalog=>checkpoint(catalog,controller.signal),signal:controller.signal})
      .catch(()=>{}).finally(()=>{active=undefined;controller=undefined;});
    return active;
  }
  function start() {if(stopped||timer)return;timer=setInterval(requestSweep,120000);requestSweep();}
  function stop() {stopped=true;if(timer)clearInterval(timer);controller?.abort();if(window&&!window.isDestroyed())window.destroy();}
  return {start,requestSweep,stop};
}

module.exports={createStreameastCollector,allowedNavigation};
