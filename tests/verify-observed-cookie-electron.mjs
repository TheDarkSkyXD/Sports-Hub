import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import {probeCandidate} from '../lib/playback/probe.ts';
import {observedPublicPage} from '../lib/playback/providers/public-page.ts';
import {prepareDevelopmentElectron} from '../scripts/electron-runtime.mjs';

const run=promisify(execFile);
const directory=await mkdtemp(join(tmpdir(),'sunday-observer-cookie-'));
const key=join(directory,'key.pem');
const certificate=join(directory,'cert.pem');
const profile=join(directory,'profile');
const fixture='https://fixture.example:8443';
const cross='https://other.fixture.example:8443';
const cookie='session=fixture-secret';
const segment=Buffer.alloc(188*3);
for(let offset=0;offset<segment.length;offset+=188)segment[offset]=0x47;
const playlist='#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\n/segments/segment.ts\n';
const referrerPage=`${fixture}/watch-referrer`;
const referrerPlaylist=playlist.replace('/segments/segment.ts','/segments/referrer.ts');
const evidence={playlist:0,segment:0,cross:0,playlistCookies:[],segmentCookies:[],
  referrerPlaylist:[],referrerSegment:[]};
let server;
let child;

async function createCertificate(){
  const bins=[process.env.OPENSSL_BIN,process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':undefined,'openssl']
    .filter(Boolean);
  let failure;
  for(const bin of bins){
    try{
      await run(bin,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,
        '-days','1','-subj','/CN=fixture.example','-addext','subjectAltName=DNS:fixture.example,DNS:other.fixture.example'],
      {windowsHide:true});
      return;
    }catch(error){failure=error;}
  }
  throw failure;
}

function fixtureRequest(request,response){
  const host=request.headers.host;
  if(request.method!=='GET'){
    response.writeHead(405);response.end();return;
  }
  if(host==='fixture.example:8443' && request.url==='/watch'){
    response.writeHead(200,{'content-type':'text/html; charset=utf-8',
      'set-cookie':`${cookie}; Path=/; Secure; SameSite=Lax`});
    response.end(`<video width="800" height="450" muted playsinline></video>
      <script>fetch('/hls/live.m3u8',{credentials:'include'}).catch(()=>{})</script>`);
    return;
  }
  if(host==='fixture.example:8443' && request.url==='/watch-referrer'){
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','referrer-policy':'unsafe-url'});
    response.end(`<video width="800" height="450" muted playsinline></video>
      <script>fetch('${cross}/hls/referrer.m3u8').catch(()=>{})</script>`);
    return;
  }
  if(host==='other.fixture.example:8443' &&
    ['/hls/referrer.m3u8','/segments/referrer.ts'].includes(request.url)){
    const isPlaylist=request.url==='/hls/referrer.m3u8';
    (isPlaylist?evidence.referrerPlaylist:evidence.referrerSegment).push(request.headers.referer);
    if(request.headers.referer!==referrerPage){response.writeHead(403);response.end();return;}
    response.writeHead(200,{'content-type':isPlaylist?'application/vnd.apple.mpegurl':'video/mp2t',
      'access-control-allow-origin':fixture});
    response.end(isPlaylist?referrerPlaylist:segment);return;
  }
  if(host==='fixture.example:8443' && request.url==='/hls/live.m3u8'){
    evidence.playlistCookies.push(request.headers.cookie===cookie);
    if(request.headers.cookie!==cookie){response.writeHead(403);response.end();return;}
    evidence.playlist++;
    response.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});
    response.end(playlist);return;
  }
  if(host==='fixture.example:8443' && request.url==='/segments/segment.ts'){
    evidence.segmentCookies.push(request.headers.cookie===cookie);
    if(request.headers.cookie!==cookie){response.writeHead(403);response.end();return;}
    evidence.segment++;
    response.writeHead(200,{'content-type':'video/mp2t'});
    response.end(segment);return;
  }
  if(host==='other.fixture.example:8443' && request.url==='/cross.ts'){
    if(request.headers.cookie || request.headers.referer!==`${fixture}/`){response.writeHead(409);response.end();return;}
    evidence.cross++;
    response.writeHead(200,{'content-type':'video/mp2t'});
    response.end(segment);return;
  }
  response.writeHead(404);response.end();
}

function sidecarReady(process){
  return new Promise((resolveReady,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Electron fixture readiness timed out')),15000);
    process.once('error',reject);
    process.once('exit',code=>reject(new Error(`Electron fixture exited ${code}`)));
    process.on('message',message=>{
      if(message?.kind==='ready'){clearTimeout(timer);resolveReady(message.origin);}
    });
  });
}

try{
  await createCertificate();
  server=createServer({key:await readFile(key),cert:await readFile(certificate)},fixtureRequest);
  await new Promise((resolveReady,reject)=>{
    server.once('error',reject);
    server.listen(8443,'127.0.0.1',resolveReady);
  });
  await mkdir(profile);
  const token='fixture-observer-control';
  const env={...process.env,SUNDAY_ROOM_CONTROL_TOKEN:token,SUNDAY_ROOM_FIXTURE_PROFILE:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(await prepareDevelopmentElectron(),[resolve('tests/fixtures/observer-cookie-electron.ts')],{
    cwd:process.cwd(),env,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
  });
  let childError='';
  child.stderr.on('data',part=>{childError=(childError+part.toString()).slice(-8192);});
  const origin=await sidecarReady(child);
  assert.ok(origin,childError||'Observer did not start');
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=origin;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN=token;
  const observed=await fetch(`${origin}/observe`,{method:'POST',headers:{
    'content-type':'application/json','x-sunday-control-token':token,
  },body:JSON.stringify({url:`${fixture}/watch`,purpose:'probe'}),signal:AbortSignal.timeout(25000)});
  assert.equal(observed.status,200,`observer returned ${observed.status}: ${await observed.clone().text()}`);
  const result=await observed.json();
  assert.equal(result.url,`${fixture}/hls/live.m3u8`);
  assert.equal(result.referer,`${fixture}/watch`);
  assert.equal('mediaCookie' in result,false);
  assert.equal(JSON.stringify(result).includes(cookie),false);
  assert.ok(evidence.playlist>=1,'browser must request the cookie-gated playlist');
  const requestMedia=(url)=>fetch(`${origin}/media`,{method:'POST',headers:{
    'content-type':'application/json','x-sunday-control-token':token,
  },body:JSON.stringify({capability:result.capability,url}),signal:AbortSignal.timeout(10000)});
  const root=await requestMedia(`${fixture}/hls/live.m3u8`);
  assert.equal(root.status,200,'native replay must retain the observed cookie');
  assert.equal(await root.text(),playlist);
  const media=await requestMedia(`${fixture}/segments/segment.ts`);
  assert.equal(media.status,200,'same-origin segment must retain the observed cookie');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()),segment);
  const other=await requestMedia(`${cross}/cross.ts`);
  assert.equal(other.status,200,'cross-origin media must not receive the observed cookie');
  assert.deepEqual(Buffer.from(await other.arrayBuffer()),segment);
  await fetch(`${origin}/media/${result.capability}`,{method:'DELETE',headers:{'x-sunday-control-token':token}});
  const proof=await probeCandidate({provider:'gooz',playerId:'fixture'},AbortSignal.timeout(65000),
    (_locator,signal,purpose)=>observedPublicPage(new URL(`${fixture}/watch`),signal,purpose));
  assert.deepEqual(proof,{kind:'playable',proof:'media'});
  assert.ok(evidence.playlist>=3,'browser and relay both read the playlist');
  assert.ok(evidence.segment>=2,'manual replay and probe both read a full segment');
  assert.equal(evidence.cross,1);
  const referrerObserved=await fetch(`${origin}/observe`,{method:'POST',headers:{
    'content-type':'application/json','x-sunday-control-token':token,
  },body:JSON.stringify({url:referrerPage,purpose:'probe'}),signal:AbortSignal.timeout(25000)});
  assert.equal(referrerObserved.status,200,`referrer observer returned ${referrerObserved.status}: ${await referrerObserved.clone().text()}`);
  const referrerResult=await referrerObserved.json();
  assert.equal(referrerResult.url,`${cross}/hls/referrer.m3u8`);
  assert.deepEqual(evidence.referrerPlaylist,[referrerPage],'browser must send the full referrer to the accepted playlist');
  const replay=await fetch(`${origin}/media`,{method:'POST',headers:{
    'content-type':'application/json','x-sunday-control-token':token,
  },body:JSON.stringify({capability:referrerResult.capability,url:referrerResult.url}),signal:AbortSignal.timeout(10000)});
  assert.equal(replay.status,200,`native replay must retain the accepted full referrer: ${JSON.stringify(evidence.referrerPlaylist)}`);
  assert.equal(await replay.text(),referrerPlaylist);
  await fetch(`${origin}/media/${referrerResult.capability}`,{method:'DELETE',headers:{'x-sunday-control-token':token}});
  const referrerProof=await probeCandidate({provider:'gooz',playerId:'referrer-fixture'},AbortSignal.timeout(65000),
    (_locator,signal,purpose)=>observedPublicPage(new URL(referrerPage),signal,purpose));
  assert.deepEqual(referrerProof,{kind:'playable',proof:'media'});
  assert.deepEqual(evidence.referrerPlaylist,Array(4).fill(referrerPage));
  assert.deepEqual(evidence.referrerSegment,[referrerPage]);
  console.log('real Electron observer and media lease verified',JSON.stringify(evidence));
}finally{
  delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if(child?.connected)child.send({kind:'stop'});
  if(child)await new Promise(resolveExit=>{child.once('exit',resolveExit);setTimeout(resolveExit,3000);});
  if(server)await new Promise(resolveClose=>server.close(resolveClose));
  if(!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))throw new Error('Fixture cleanup escaped temp directory');
  await rm(directory,{recursive:true,force:true});
}
