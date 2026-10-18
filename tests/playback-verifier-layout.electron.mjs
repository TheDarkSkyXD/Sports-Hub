import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import policy from '../lib/playback/verification-policy.json' with {type:'json'};

const directory=resolve('.desktop-runtime/cold-start-20261017');
await mkdir(directory,{recursive:true});
const mediaPath=resolve(directory,'verifier-layout.mp4');
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','15','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',mediaPath,
],{windowsHide:true,timeout:20000});

async function inspect(mediaPath,count){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,session,net}=process.mainModule.require('electron');
  const {randomUUID}=require('node:crypto');
  const room=BrowserWindow.getAllWindows().find(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL()));
  if(!room)throw new Error('The local Electron room must be running');
  const origin=new URL(room.webContents.getURL()).origin;
  const media=await require('node:fs/promises').readFile(mediaPath);
  const own=session.fromPartition(`verifier-layout-${randomUUID()}`,{cache:false});
  own.protocol.handle('http',request=>{
    const url=new URL(request.url);
    if(url.origin===origin&&url.pathname.startsWith('/api/stream/layout-')&&url.pathname.endsWith('/presentation'))
      return Response.json({kind:'progressive',url:`/api/stream/media/${'a'.repeat(48)}`});
    if(url.origin===origin&&url.pathname===`/api/stream/media/${'a'.repeat(48)}`){
      const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range')||'');
      const start=range?Number(range[1]):0,end=range?.[2]?Math.min(media.length-1,Number(range[2])):media.length-1;
      return new Response(media.subarray(start,end+1),{status:range?206:200,headers:{
        'content-type':'video/mp4','accept-ranges':'bytes','content-length':String(end-start+1),
        ...(range?{'content-range':`bytes ${start}-${end}/${media.length}`}:{})}});
    }
    return net.fetch(request,{session:own,bypassCustomProtocolHandlers:true});
  });
  const host=new BrowserWindow({show:false,width:Math.min(4,count)*320,height:Math.ceil(count/4)*260,useContentSize:true,webPreferences:{session:own,
    sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  const evaluate=expression=>host.webContents.executeJavaScript(expression);
  const until=async(expression)=>{
    const deadline=Date.now()+12000;
    while(Date.now()<deadline){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error(`Verifier fixture timed out: ${expression}`);
  };
  try{
    await host.loadURL(`${origin}/internal/playback-verifier`);
    await until('!!window.__sundayVerify');
    await evaluate(`(()=>{
      window.layoutOutcomes=[];
      for(let index=0;index<${count};index++)void window.__sundayVerify.assign('layout-'+index,
        location.origin+'/api/stream/layout-'+index+'/index.m3u8?session=fixture&candidate=fixture&generation=0')
        .then(result=>window.layoutOutcomes.push(result));
    })()`);
    await until(`document.querySelectorAll("video").length===${count}`);
    const boxes=await evaluate(`[...document.querySelectorAll('video')].map(video=>{
      const rect=video.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
    })`);
    await until(`window.layoutOutcomes.length===${count}`);
    return {boxes,outcomes:await evaluate('window.layoutOutcomes')};
  }finally{
    host.destroy();own.protocol.unhandle('http');
    await own.closeAllConnections();await own.clearStorageData();await own.clearCache();
  }
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Electron verifier layout check timed out')),30000);
    socket.addEventListener('message',event=>{
      const response=JSON.parse(event.data);if(response.id!==1)return;clearTimeout(timer);
      if(response.error||response.result.exceptionDetails)reject(new Error(JSON.stringify(response.error??response.result.exceptionDetails)));
      else resolve(response.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
      expression:`(${inspect.toString()})(${JSON.stringify(mediaPath)},${policy.concurrency})`,awaitPromise:true,returnByValue:true}}));
  });
  await writeFile(resolve(process.argv[2]??resolve(directory,'verifier-layout.json')),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.equal(result.boxes.length,policy.concurrency);
  for(const [index,box] of result.boxes.entries()){
    assert.ok(box.width>=240&&box.height>=135,'Every checker player must keep enough visible area');
    for(const prior of result.boxes.slice(0,index))assert.ok(
      box.x>=prior.x+prior.width||prior.x>=box.x+box.width||box.y>=prior.y+prior.height||prior.y>=box.y+box.height,
      'Concurrent checker players must occupy separate grid cells');
  }
  assert.equal(result.outcomes.length,policy.concurrency);
  assert.ok(result.outcomes.every(outcome=>outcome.kind==='playable'&&outcome.proof?.kind==='advancing-video'),
    'Every concurrent player must present advancing video');
}finally{socket.close();}
