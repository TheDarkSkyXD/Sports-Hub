const protectedApps=new WeakSet();
const protectedSessions=new WeakSet();
const trustedUi=new WeakMap();

function registerTrustedUi(contents,origin){
  if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin))throw new Error('UI origin must be local.');
  const entry={origin};trustedUi.set(contents,entry);
  return ()=>{if(trustedUi.get(contents)===entry)trustedUi.delete(contents);};
}
function trustedUiRequest(contents,details,requestingOrigin){
  const entry=contents&&trustedUi.get(contents);
  if(!entry||contents.isDestroyed()||details?.isMainFrame!==true)return false;
  try{return new URL(contents.mainFrame.url).origin===entry.origin&&
    new URL(details.requestingUrl||requestingOrigin).origin===entry.origin&&
    (!requestingOrigin||new URL(requestingOrigin).origin===entry.origin);
  }catch{return false;}
}

function protectSession(source){
  if(protectedSessions.has(source))return;
  protectedSessions.add(source);
  source.on('will-download',(event,item)=>{
    event.preventDefault();
    try{item.cancel();}catch{}
  });
  source.setPermissionRequestHandler((contents,permission,callback,details)=>callback(
    ['fullscreen','clipboard-sanitized-write'].includes(permission)&&trustedUiRequest(contents,details)));
  source.setPermissionCheckHandler((contents,permission,origin,details)=>
    permission==='clipboard-sanitized-write'&&trustedUiRequest(contents,details,origin));
  source.setDevicePermissionHandler(()=>false);
  source.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
}

function installSessionSecurity({app,session}){
  if(protectedApps.has(app))return;
  protectedApps.add(app);
  app.enableSandbox();
  app.on('session-created',protectSession);
  if(app.isReady())protectSession(session.defaultSession);
  else app.once('ready',()=>protectSession(session.defaultSession));
  app.on('web-contents-created',(_event,contents)=>{
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    contents.on('will-attach-webview',event=>event.preventDefault());
  });
}

function allowedProjectLink(value,feeds){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.port||url.search||url.hash)return false;
    return feeds.some(feed=>{
      const repository=/^https:\/\/github\.com(\/[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9._-]{1,100})\/releases\/latest\/download$/.exec(feed)?.[1];
      if(!repository)return false;
      return url.pathname===repository||url.pathname===`${repository}/releases`||
        url.pathname.startsWith(`${repository}/releases/tag/`)&&/^[A-Za-z0-9._-]{1,120}$/.test(url.pathname.slice(`${repository}/releases/tag/`.length));
    });
  }catch{return false;}
}

module.exports={installSessionSecurity,allowedProjectLink,registerTrustedUi};
