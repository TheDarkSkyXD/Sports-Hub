import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';

const mediaPath=resolve('.desktop-runtime/feed-isolation/csp-manual.mp4');
await mkdir(dirname(mediaPath),{recursive:true});
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','10','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',mediaPath,
],{windowsHide:true,timeout:20000});

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});

async function inspect(mediaPath){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,session,net}=process.mainModule.require('electron');
  const {randomUUID}=require('node:crypto');
  const room=BrowserWindow.getAllWindows().find(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL()));
  if(!room)throw new Error('The real watch room must be open');
  const origin=room.webContents.getURL();
  const documents=await Promise.all([0,1].map(async()=>{
    const response=await fetch(origin,{headers:{Accept:'text/html'},cache:'no-store'});
    return{policy:response.headers.get('content-security-policy'),html:await response.text()};
  }));
  const nonces=documents.map(doc=>doc.policy?.match(/'nonce-([^']+)'/)?.[1]??null);
  const result={at:new Date().toISOString(),noncePresent:nonces.every(Boolean),nonceUnique:nonces[0]!==nonces[1],
    frameworkScriptsHaveMatchingNonce:documents.every((doc,index)=>{
      const values=[...doc.html.matchAll(/<script\b[^>]*nonce="([^"]+)"/g)].map(match=>match[1]);
      return values.length>0&&values.every(value=>value===nonces[index]);
    }),
    inlineCodeAllowed:documents.some(doc=>/script-src[^;]*'unsafe-inline'/.test(doc.policy??'')),cases:[]};
  for(const [index,protectedPage] of [false,true].entries()){
    const source=documents[index];
    const policy=protectedPage?source.policy:null;
    const nonce=nonces[index]??'baseline';
    const injected=`<script nonce="${nonce}">globalThis.__cspFixture={allowed:true,violations:[]};document.addEventListener('securitypolicyviolation',e=>__cspFixture.violations.push(e.effectiveDirective));</script><script>globalThis.__feedInjectionFixture=true;</script>`;
    const html=source.html.replace(/<head>/i,`<head>${injected}`);
    const ownSession=session.fromPartition(`ui-csp-${randomUUID()}`,{cache:false});
    await ownSession.protocol.handle('http',request=>{
      if(request.url!==origin)return net.fetch(request,{session:ownSession,bypassCustomProtocolHandlers:true});
      return new Response(html,{headers:{'content-type':'text/html',...(policy?{'content-security-policy':policy}:{})}});
    });
    const window=new BrowserWindow({show:false,webPreferences:{session:ownSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try{
      await window.loadURL(origin);
      let observed;
      for(let attempt=0;attempt<100;attempt++){
        observed=await window.webContents.executeJavaScript(`({injectionExecuted:globalThis.__feedInjectionFixture===true,allowed:globalThis.__cspFixture?.allowed===true,violations:globalThis.__cspFixture?.violations??[],hydrated:!!document.querySelector('button[aria-label="Room settings"]')})`);
        if(observed.hydrated)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      result.cases.push({protectedPage,...observed});
    }finally{
      window.destroy();ownSession.protocol.unhandle('http');
      await ownSession.closeAllConnections();await ownSession.clearStorageData();await ownSession.clearCache();
    }
  }
  const media=await require('node:fs/promises').readFile(mediaPath);
  result.manual=[];
  for(const url of ['https://manual-fixture.example/video.mp4','http://127.0.0.1:9001/video.mp4','http://[::1]:9001/video.mp4']){
    const ownSession=session.fromPartition(`manual-csp-${randomUUID()}`,{cache:false});
    const html=`<!doctype html><head><script nonce="${nonces[1]}">globalThis.manualFetch='pending';fetch(${JSON.stringify(url)}).then(r=>r.arrayBuffer()).then(()=>manualFetch='complete',()=>manualFetch='blocked');</script></head><body><video autoplay muted playsinline src="${url}"></video></body>`;
    const handle=request=>request.url===origin?new Response(html,{headers:{'content-type':'text/html','content-security-policy':documents[1].policy}}):
      request.url===url?new Response(media,{headers:{'content-type':'video/mp4','access-control-allow-origin':'*'}}):new Response(null,{status:404});
    await ownSession.protocol.handle('http',handle);await ownSession.protocol.handle('https',handle);
    const window=new BrowserWindow({show:false,webPreferences:{session:ownSession,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    try{
      await window.loadURL(origin);
      const sample=()=>window.webContents.executeJavaScript(`(()=>{const v=document.querySelector('video');return{fetch:globalThis.manualFetch,width:v.videoWidth,height:v.videoHeight,time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,error:v.error?.code??null}})()`);
      let before;
      for(let attempt=0;attempt<40;attempt++){before=await sample();if(before.width||before.error)break;await new Promise(resolve=>setTimeout(resolve,50));}
      await new Promise(resolve=>setTimeout(resolve,700));
      result.manual.push({url,before,after:await sample()});
    }finally{
      window.destroy();ownSession.protocol.unhandle('http');ownSession.protocol.unhandle('https');
      await ownSession.closeAllConnections();await ownSession.clearStorageData();await ownSession.clearCache();
    }
  }
  const api=await fetch(new URL('/api/sources',origin));await api.body?.cancel();
  result.sourceApiHasNonce=api.headers.get('content-security-policy')?.includes('nonce-')??false;
  result.realRoomHydrated=await room.webContents.executeJavaScript(`!!document.querySelector('button[aria-label="Room settings"]')`);
  result.policy=documents[1].policy?.replace(/'nonce-[^']+'/g,"'nonce-<redacted>'")??null;
  return result;
}

try{
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Native CSP fixture timed out')),30000);
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${inspect.toString()})(${JSON.stringify(mediaPath)})`,returnByValue:true,awaitPromise:true}}));
  });
  const output=resolve(process.argv[2]??'.desktop-runtime/feed-isolation/native-ui-csp.json');
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  const [control,protectedPage]=result.cases;
  assert.equal(control.injectionExecuted,true,'The matched no-policy control must execute the harmless parser-inserted payload');
  assert.equal(protectedPage.injectionExecuted,false,'The actual app policy must block the same parser-inserted payload');
  assert.ok(protectedPage.violations.includes('script-src-elem'));
  assert.ok(result.cases.every(item=>item.allowed&&item.hydrated),'Nonce-authorized code and real framework hydration must work in both documents');
  assert.ok(result.noncePresent&&result.nonceUnique&&result.frameworkScriptsHaveMatchingNonce);
  assert.equal(result.inlineCodeAllowed,false);assert.equal(result.sourceApiHasNonce,false);assert.equal(result.realRoomHydrated,true);
  for(const item of result.manual){
    assert.equal(item.after.fetch,'complete',`Manual source requests must remain supported: ${item.url}`);
    assert.ok(item.after.width===320&&item.after.height===180&&item.after.frames>item.before.frames&&item.after.time>item.before.time,
      `Manual video must decode and advance under the actual app policy: ${item.url}`);
  }
}finally{socket.close();}
