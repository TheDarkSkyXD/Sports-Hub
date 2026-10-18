import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';

const root=resolve('.'),directory=resolve('.desktop-runtime/media-audit-fixes/progressive-observer');
await mkdir(directory,{recursive:true});
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','15','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',resolve(directory,'fixture.mp4'),
],{windowsHide:true,timeout:20000});
await promisify(execFile)(process.env.OPENSSL_BIN??resolve(process.env.ProgramFiles??'C:/Program Files','Git/usr/bin/openssl.exe'),[
  'req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=media-fixture.example',
  '-addext','subjectAltName=DNS:media-fixture.example','-keyout',resolve(directory,'key.pem'),'-out',resolve(directory,'cert.pem'),
],{windowsHide:true,timeout:20000});

async function verify(root,directory){
  const require=process.mainModule.require.bind(process.mainModule),{BrowserWindow,session,webFrameMain}=process.mainModule.require('electron');
  const fs=require('node:fs/promises'),path=require('node:path'),{createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
  const {createServer}=require('node:http'),{X509Certificate}=require('node:crypto'),sessions=[],requests=[];
  const media=await fs.readFile(path.join(directory,'fixture.mp4'));
  const origin='https://media-fixture.example:8443',certificate=await fs.readFile(path.join(directory,'cert.pem'));
  const fingerprint=new X509Certificate(certificate).fingerprint256;
  const fixtureServer=require('node:https').createServer({key:await fs.readFile(path.join(directory,'key.pem')),cert:certificate},(request,response)=>{
    const url=new URL(request.url,origin);requests.push({url:url.href,range:request.headers.range??null,cookie:request.headers.cookie??null});
    if(url.pathname==='/player'){
      response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><div id="player"><video muted autoplay src="/game.mp4" style="width:640px;height:360px"></video></div><script>fetch("/other-game.mp4")</script>');return;
    }
    if(['/game.mp4','/other-game.mp4'].includes(url.pathname)){
      const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||''),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(media.length-1,Number(range[2])):media.length-1;
      response.writeHead(range?206:200,{'content-type':'video/mp4','content-length':String(end-start+1),'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${media.length}`}:{})});response.end(media.subarray(start,end+1));return;
    }
    response.writeHead(404);response.end();
  });
  const pinAddress=async host=>{if(host!=='media-fixture.example')throw new Error('Unexpected fixture destination');return {address:'127.0.0.1',family:4};};
  const ownSessions={fromPartition(name){const own=session.fromPartition(name);own.setCertificateVerifyProc((details,callback)=>{
    let trusted=false;try{trusted=details.hostname==='media-fixture.example'&&new X509Certificate(details.certificate.data).fingerprint256===fingerprint;}catch{}
    callback(trusted?0:-3);
  });sessions.push(own);return own;}};
  const observerFile=path.join(root,'desktop/sportsurge-observer.cjs'),observerRequire=createRequire(observerFile);
  const source=await fs.readFile(observerFile,'utf8');
  const createSlot=require('node:vm').runInThisContext(`(function(require,module,exports){${source}\nreturn createObserverSlot;})`)(
    id=>id==='electron'?{BrowserWindow,session:ownSessions,webFrameMain}:observerRequire(id),{exports:{}},{});
  const slot=createSlot(0,pinAddress),{createObservedMedia}=require(path.join(root,'desktop/observed-media.cjs'));
  const {publicUrl}=require(path.join(root,'desktop/source-network.cjs'));
  const replay=createObservedMedia({pinAddress,validateUrl:publicUrl,sessions:ownSessions});
  let viewer,server,capability,capture;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try{
    await new Promise((resolve,reject)=>{fixtureServer.once('error',reject);fixtureServer.listen(8443,'127.0.0.1',resolve);});
    await sessions[0].cookies.set({url:origin,name:'fixture',value:'owned',secure:true,sameSite:'no_restriction'});
    await slot.start();const job=slot.observe(origin+'/player','probe');if(!job)throw new Error('Native observer did not admit the fixture');
    job.start();capture=await job.promise;
    if(!capture?.url)throw new Error('Native observer did not capture the selected progressive video');
    capability=await replay.register(capture);
    if(!capability)throw new Error('Captured media registration failed');
    server=createServer((request,response)=>{
      if(request.url==='/'){
        response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><video src="/relay.mp4" autoplay muted style="width:640px;height:360px"></video>');
      }else replay.read(capability,capture.url,request.headers.range,response);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture relay did not listen');
    viewer=new BrowserWindow({show:false,width:900,height:650,webPreferences:{session:ownSessions.fromPartition('progressive-viewer-'+randomUUID()),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
    await viewer.loadURL(`http://127.0.0.1:${address.port}/`);
    const sample=()=>viewer.webContents.executeJavaScript(`(()=>{const v=document.querySelector('video');return {time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight,paused:v.paused,error:v.error?.code??null}})()`);
    let before;const deadline=Date.now()+10000;
    do{before=await sample();if(before.frames>0&&before.width>0)break;await wait(100);}while(Date.now()<deadline);
    await wait(2200);const after=await sample();
    return {capture:{url:capture.url,kind:capture.kind,cookiePreserved:capture.mediaCookie?.includes('fixture=owned')??false},before,after,requests};
  }catch(error){return {failure:error.message,capture:capture?{url:capture.url,kind:capture.kind,outcome:capture.outcome}:null,requests};}
  finally{
    slot.stop();if(viewer&&!viewer.isDestroyed())viewer.destroy();replay.stop();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const own of sessions){await own.closeAllConnections();await own.clearStorageData();}
    if(fixtureServer.listening){fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));}
  }
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Progressive observer native check timed out')),45000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(root)},${JSON.stringify(directory)})`,awaitPromise:true,returnByValue:true}}));});
  await writeFile(resolve(process.argv[2]??'.desktop-runtime/media-audit-fixes/native-progressive-observer.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  assert.equal(result.failure,undefined,result.failure);assert.equal(result.capture.url,'https://media-fixture.example:8443/game.mp4');assert.equal(result.capture.kind,'progressive');
  assert.equal(result.capture.cookiePreserved,true);assert.equal(result.after.width,320);assert.equal(result.after.height,180);assert.equal(result.after.error,null);assert.equal(result.after.paused,false);
  assert.ok(result.after.time-result.before.time>=1.8&&result.after.frames>result.before.frames);
  assert.ok(result.requests.some(request=>request.url.endsWith('/other-game.mp4')),'Unrelated progressive traffic must occur without becoming the selected media');
  assert.ok(result.requests.filter(request=>request.url.endsWith('/game.mp4')).length>=2,'Captured progressive media must be replayed through its own session');
}finally{socket.close();}
