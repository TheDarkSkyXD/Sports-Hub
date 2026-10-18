import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

const output=resolve(process.argv[2]??'.desktop-runtime/feed-isolation/native-isolation.json');
const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1,'Attach to the existing local Electron app');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});

async function verify(){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,session,shell}=process.mainModule.require('electron');
  const {createServer}=require('node:http');
  const {randomUUID}=require('node:crypto');
  const server=createServer((request,response)=>{
    if(request.url==='/file'){
      response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="blocked-fixture.txt"'});
      response.end('A harmless download fixture.');
    }else{
      response.writeHead(200,{'content-type':'text/html'});
      response.end('<!doctype html><title>Feed isolation fixture</title><a id="download" href="/file" download>Download</a>');
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const results=[];
  const windows=[];
  const originalOpen=shell.openExternal;
  const external=[];
  try{
    for(const [role,ses] of [
      ['default',session.defaultSession],
      ['verifier',session.fromPartition('playback-verifier')],
      ['future',session.fromPartition(`feed-isolation-${randomUUID()}`,{cache:false})],
    ]){
      const window=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});
      windows.push(window);
      await window.loadURL(origin);
      const sandbox=await window.webContents.executeJavaScript(`({node:typeof require,process:typeof process,updates:typeof window.sundayDesktop,player:typeof window.sundayPlayer})`);
      const permission=await window.webContents.executeJavaScript("navigator.permissions.query({name:'geolocation'}).then(p=>p.state)");
      const clipboard=await window.webContents.executeJavaScript("Promise.all(['clipboard-read','clipboard-write'].map(name=>navigator.permissions.query({name}).then(p=>p.state)))");
      let handler;
      const download=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{ses.removeListener('will-download',handler);reject(new Error(`${role} did not attempt the fixture download`));},5000);
        handler=(event,item)=>{
          const blockedByApp=event.defaultPrevented===true;
          event.preventDefault();
          item.cancel();
          clearTimeout(timer);
          ses.removeListener('will-download',handler);
          resolve({blockedByApp,saved:false});
        };
        ses.on('will-download',handler);
        void window.webContents.executeJavaScript("document.getElementById('download').click();true").catch(error=>{
          clearTimeout(timer);ses.removeListener('will-download',handler);reject(error);
        });
      });
      results.push({role,permission,clipboard,sandbox:{node:sandbox.node,process:sandbox.process,updates:sandbox.updates,player:sandbox.player},download});
      window.destroy();
    }
    shell.openExternal=async url=>{external.push(url);};
    const room=BrowserWindow.getAllWindows().find(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL()));
    if(!room)throw new Error('The actual watch room is missing');
    const trustedClipboard=await room.webContents.executeJavaScript("Promise.all(['clipboard-read','clipboard-write'].map(name=>navigator.permissions.query({name}).then(p=>p.state)))");
    await room.webContents.executeJavaScript("window.open('https://untrusted-feed.example/download.exe','_blank');true");
    await new Promise(resolve=>setTimeout(resolve,150));
    return {electron:process.versions.electron,roles:results,trustedClipboard,untrustedExternalLaunches:external.length,filesSaved:0};
  }finally{
    shell.openExternal=originalOpen;
    for(const window of windows)if(!window.isDestroyed())window.destroy();
    await new Promise(resolve=>server.close(resolve));
  }
}

try{
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Native feed isolation verification timed out')),25000);
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})()`,returnByValue:true,awaitPromise:true}}));
  });
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.ok(result.roles.every(role=>role.download.blockedByApp),'Every session must block file downloads before the verification cleanup listener');
  assert.ok(result.roles.every(role=>role.permission==='denied'),'Browsing sessions must deny device/location permission checks');
  assert.ok(result.roles.every(role=>role.clipboard.every(state=>state==='denied')),'Untrusted content must lack clipboard access');
  assert.deepEqual(result.trustedClipboard,['denied','granted'],'Only the trusted room may write sanitized clipboard text');
  assert.ok(result.roles.every(role=>Object.values(role.sandbox).every(value=>value==='undefined')),'Untrusted content must lack Node and application bridges');
  assert.equal(result.untrustedExternalLaunches,0,'An untrusted HTTPS popup must not launch the system browser');
}finally{socket.close();}
