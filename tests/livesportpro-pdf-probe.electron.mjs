import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

async function verify(root){
  const mainRequire=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,session}=mainRequire('electron');
  const {join}=mainRequire('node:path');
  const uuid=mainRequire('node:crypto').randomUUID;
  const {sourceRequestAllowed}=mainRequire(join(root,'desktop/source-network.cjs'));
  if(!BrowserWindow.getAllWindows().some(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL())))
    throw new Error('Open the local Electron room before testing the LiveSportPro PDF probe');
  const player='https://embed.st/embed/ingest/fixture/1/';
  const probe='data:application/pdf;base64,aG1t';
  const own=session.fromPartition('livesportpro-pdf-probe-'+uuid(),{cache:false});
  const decisions=[];
  own.webRequest.onBeforeRequest((details,callback)=>{
    const allowed=sourceRequestAllowed(details,player);
    decisions.push({url:details.url,resourceType:details.resourceType,allowed});
    callback({cancel:!allowed});
  });
  own.protocol.handle('https',request=>request.url===player?new Response(`<!doctype html><html><body><script>
    window.probe={state:'pending'};
    const object=document.createElement('object');
    object.type='application/pdf';object.data='${probe}';
    object.addEventListener('load',()=>{window.probe.state='loaded'});
    object.addEventListener('error',()=>{window.probe.state='error'});
    document.body.appendChild(object);
  </script></body></html>`,{headers:{'content-type':'text/html'}}):new Response('',{status:404}));
  const window=new BrowserWindow({show:false,width:320,height:180,webPreferences:{session:own,sandbox:true,
    contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  let createdWindows=0;
  window.webContents.on('did-create-window',child=>{createdWindows++;child.destroy();});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  try{
    await window.loadURL(player);
    const end=Date.now()+3_000;
    let page;
    while(Date.now()<end){
      page=await window.webContents.executeJavaScript(`({state:window.probe?.state,
        sandbox:typeof process==='undefined'&&typeof require==='undefined'})`);
      if(page.state!=='pending')break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return {page,decisions,createdWindows};
  }finally{
    if(!window.isDestroyed())window.destroy();
    own.webRequest.onBeforeRequest((_details,callback)=>callback({cancel:true}));
    own.protocol.unhandle('https');
    await own.closeAllConnections();await own.clearStorageData();await own.clearCache();
  }
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1,'Expected one running local Electron main inspector');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolveResult,reject)=>{
    const timer=setTimeout(()=>reject(new Error('LiveSportPro PDF probe fixture timed out')),15_000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolveResult(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
      expression:`(${verify.toString()})(${JSON.stringify(resolve('.'))})`,awaitPromise:true,returnByValue:true,
    }}));
  });
  const output=resolve(process.argv[2]??'.scratch/livesportpro-sandbox-20261018/pdf-probe-native.json');
  await mkdir(dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(result,null,2)}\n`);
  console.log(JSON.stringify(result));
  assert.equal(result.page?.state,'loaded','The exact inert PDF object probe must complete');
  assert.equal(result.page?.sandbox,true,'The fixture renderer must retain Electron sandboxing');
  assert.ok(result.decisions.some(decision=>decision.url==='data:application/pdf;base64,aG1t'&&
    decision.resourceType==='object'&&decision.allowed),'The production policy must admit only the exact object probe');
  assert.equal(result.createdWindows,0,'The PDF probe must not create a popup window');
}finally{socket.close();}
