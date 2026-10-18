import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import policy from '../lib/playback/verification-policy.json' with {type:'json'};

async function inspect(count){
  const {BrowserWindow}=process.mainModule.require('electron');
  const {randomUUID}=process.mainModule.require('node:crypto');
  const waiting=new Set();let admitted=0,peak=0,host,timer;
  const server=process.mainModule.require('node:http').createServer((request,response)=>{
    if(request.url==='/'){
      response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Local verifier transport fixture</title>');return;
    }
    admitted++;waiting.add(response);peak=Math.max(peak,waiting.size);
    response.on('close',()=>waiting.delete(response));
    if(admitted===count)for(const response of waiting)response.end('ok');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    host=new BrowserWindow({show:false,webPreferences:{partition:`local-verifier-transport-${randomUUID()}`,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await host.loadURL(origin);
    const started=Date.now();
    const requests=host.webContents.executeJavaScript(`Promise.all(Array.from({length:${count}},(_,index)=>fetch('/probe/'+index).then(r=>r.text())))`);
    const result=await Promise.race([
      requests.then(values=>({finished:true,responses:values.length})),
      new Promise(resolve=>{timer=setTimeout(()=>resolve({finished:false,responses:0}),3000);}),
    ]);
    return {...result,count,admitted,peak,elapsedMs:Date.now()-started};
  }finally{
    clearTimeout(timer);for(const response of waiting)response.destroy();
    if(host&&!host.isDestroyed())host.destroy();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Electron local transport inspection timed out')),10000);
    socket.addEventListener('message',event=>{const response=JSON.parse(event.data);if(response.id!==1)return;clearTimeout(timer);
      if(response.error||response.result.exceptionDetails)reject(new Error('Electron local transport inspection failed'));
      else resolve(response.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${inspect.toString()})(${policy.concurrency})`,awaitPromise:true,returnByValue:true}}));
  });
  await writeFile(process.argv[2]??'.desktop-runtime/cold-start-20261017/local-verifier-transport.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.equal(result.peak,policy.concurrency,'Every verifier slot must be able to start its local request concurrently');
  assert.equal(result.finished,true,'Local requests must finish without waiting behind the per-origin socket limit');
}finally{socket.close();}
