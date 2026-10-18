import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

async function verify(){
  const mainRequire=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,WebContentsView,session,app}=mainRequire('electron');
  if(!BrowserWindow.getAllWindows().some(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL())))
    throw new Error('Open the local Electron room before testing verification startup');
  const {createIsolatedPlayers}=mainRequire(app.getAppPath()+'/isolated-player.cjs');
  const uuid=mainRequire('node:crypto').randomUUID;
  const own=session.fromPartition('verification-startup-host-'+uuid(),{cache:false});
  own.protocol.handle('http',()=>new Response('<!doctype html><title>Verification fixture</title>'));
  const contents=[],states=[];
  const host=new BrowserWindow({show:false,useContentSize:true,width:640,height:360,
    webPreferences:{session:own,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const send=host.webContents.send.bind(host.webContents);
  host.webContents.send=(channel,value)=>{if(channel==='sunday-player:state')states.push(value);send(channel,value);};
  const factory=createIsolatedPlayers({authorizeTarget:async()=>true,
    createProxy:()=>({credentials:{username:'fixture',password:'fixture'},start:async()=>{},stop(){}}),
    createSession(){
      const native=session.fromPartition('verification-startup-player-'+uuid(),{cache:false});
      native.protocol.handle('https',()=>new Response('<!doctype html><body style="margin:0"><div id="player"><video style="width:640px;height:360px"></video></div>',
        {headers:{'content-type':'text/html'}}));
      return native;
    },
    createView(preferences){const view=new WebContentsView({webPreferences:preferences});contents.push(view.webContents);return view;},
  });
  try{
    await host.loadURL('http://127.0.0.1:9000/');
    factory.registerHost(host,'http://127.0.0.1:9000','verification');
    const event={sender:host.webContents,senderFrame:host.webContents.mainFrame};
    const capability=await factory.offer({target:{sessionId:uuid(),candidateId:'startup-fixture',gameId:'fixture',generation:0,purpose:'verification'},
      player:{url:'https://embed.st/embed/basketball/fixture/1',referer:'https://ppv.st/events/fixture'}});
    const started=Date.now();
    await factory.mount(event,{capability});
    await factory.update(event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,playing:true,audible:false,volume:0});
    while(!states.some(value=>value.kind==='failed')&&Date.now()-started<15000)await new Promise(resolve=>setTimeout(resolve,100));
    return {elapsedMs:Date.now()-started,states:states.map(({kind,reason})=>({kind,...(reason?{reason}:{})})),
      nativeClosed:contents.every(contents=>contents.isDestroyed())};
  }finally{await factory.stop();host.destroy();own.protocol.unhandle('http');}
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Verification startup fixture timed out')),25000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})()`,awaitPromise:true,returnByValue:true}}));
  });
  const label=process.argv[2]??'verification-startup';assert.match(label,/^[a-z0-9-]+$/);
  await mkdir(resolve('.scratch/coverage-20261018'),{recursive:true});
  await writeFile(resolve('.scratch/coverage-20261018',label+'.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  assert.deepEqual(result.states,[{kind:'failed',reason:'upstream'},{kind:'ended'}]);
  assert.equal(result.nativeClosed,true,'A nonstarting verification player must release its native view');
  assert.ok(result.elapsedMs>=11500&&result.elapsedMs<15000,'A nonstarting verification must stop around twelve seconds');
}finally{socket.close();}
