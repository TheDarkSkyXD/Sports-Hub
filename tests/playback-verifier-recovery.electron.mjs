import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve('.');

async function inspect(root){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow}=process.mainModule.require('electron');
  const {createPlaybackVerifier}=require(require('node:path').join(root,'desktop/playback-verifier.cjs'));
  const limit=require(require('node:path').join(root,'lib/playback/verification-policy.json')).concurrency;
  const server=require('node:http').createServer((_request,response)=>{
    response.setHeader('Content-Type','text/html');
    response.end('<script>window.__sundayVerify={assign(){return new Promise(()=>{})},cancel(){return new Promise(()=>{})}}</script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const verifier=createPlaybackVerifier({pageOrigin:origin});
  verifier.configure(origin);
  const controllers=Array.from({length:limit},()=>new AbortController());
  const target=index=>({gameId:`fixture-${index}`,candidateId:`feed-${index}`,sessionId:`session-${index}`,generation:0});
  try{
    const jobs=controllers.map((controller,index)=>verifier.verify(target(index),controller.signal));
    if(jobs.some(job=>!job))throw new Error('The full checker pool must be admitted');
    let window;
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===`${origin}/internal/playback-verifier`);
      if(window&&await window.webContents.executeJavaScript('!!window.__sundayVerify'))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!window)throw new Error('The fixture verifier window must load');
    await new Promise(resolve=>setTimeout(resolve,100));
    const started=Date.now();
    for(const controller of controllers)controller.abort(new DOMException('Fixture timeout','TimeoutError'));
    const heldBeforeTeardown=verifier.verify(target(limit),new AbortController().signal)===null;
    const results=await Promise.race([
      Promise.all(jobs.map(job=>job.result)),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('Stalled checks did not release their slots')),5000)),
    ]);
    const elapsedMs=Date.now()-started;
    const replacements=Array.from({length:limit},(_,index)=>verifier.verify(target(index+limit+1),new AbortController().signal));
    return {limit,heldBeforeTeardown,elapsedMs,destroyed:window.isDestroyed(),results,
      replacementsAccepted:replacements.filter(Boolean).length};
  }finally{verifier.stop();await new Promise(resolve=>server.close(resolve));}
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Electron recovery check timed out')),15000);
    socket.addEventListener('message',event=>{
      const response=JSON.parse(event.data);if(response.id!==1)return;clearTimeout(timer);
      if(response.error||response.result.exceptionDetails)reject(new Error(JSON.stringify(response.error??response.result.exceptionDetails)));
      else resolve(response.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
      expression:`(${inspect.toString()})(${JSON.stringify(root)})`,awaitPromise:true,returnByValue:true}}));
  });
  await writeFile(resolve(process.argv[2]??'.desktop-runtime/cold-start-20261017/verifier-recovery-native.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.equal(result.heldBeforeTeardown,true);
  assert.equal(result.destroyed,true);
  assert.equal(result.replacementsAccepted,result.limit);
  assert.ok(result.results.every(outcome=>outcome.kind==='deferred'&&outcome.reason==='timeout'));
  assert.ok(result.elapsedMs>=1900&&result.elapsedMs<5000);
}finally{socket.close();}
