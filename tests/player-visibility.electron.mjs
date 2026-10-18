import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

async function verify(){
  const mainRequire=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,session,app}=mainRequire('electron');
  if(!BrowserWindow.getAllWindows().some(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL())))
    throw new Error('Open the local Electron room before verifying player visibility');
  const {randomUUID}=mainRequire('node:crypto');
  const {selectedPlayerEvidence}=mainRequire(app.getAppPath()+'/player-evidence.cjs');
  const own=session.fromPartition('player-visibility-'+randomUUID(),{cache:false});
  own.protocol.handle('https',request=>{
    const url=new URL(request.url);
    if(url.pathname==='/frame')return new Response('<!doctype html><body>Fixture player</body>',{headers:{'content-type':'text/html'}});
    const mode=url.pathname.slice(1);
    const style=`html{overflow:${mode==='body-clip'?'hidden':'visible'}}body{margin:0;overflow-y:hidden;${mode==='contain'?'contain:paint;':''}${mode==='body-clip'?'position:relative;':''}}
      iframe{position:absolute;left:0;top:0;width:640px;height:360px;border:0}
      .clip{position:relative;width:640px;height:18px;overflow:hidden}`;
    const frame='<iframe src="https://fixture.invalid/frame"></iframe>';
    const markup=mode==='ancestor-clip'?`<div class="clip">${frame}</div>`:frame+'<div style="height:18px"></div>';
    return new Response(`<!doctype html><style>${style}</style>${markup}`,{headers:{'content-type':'text/html'}});
  });
  const window=new BrowserWindow({show:false,useContentSize:true,width:640,height:360,
    webPreferences:{session:own,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  try{
    const results=[];
    for(const mode of ['viewport','ancestor-clip','contain','body-clip']){
      await window.loadURL('https://fixture.invalid/'+mode);
      results.push(await window.webContents.executeJavaScript(`(()=>{
        const frame=document.querySelector('iframe'),body=document.body.getBoundingClientRect();
        return {mode:${JSON.stringify(mode)},bodyHeight:body.height,frameHeight:frame.getBoundingClientRect().height,
          visibleAtCenter:document.elementFromPoint(320,180)===frame,
          proof:(${selectedPlayerEvidence.toString()})()};
      })()`));
    }
    return results;
  }finally{window.destroy();own.protocol.unhandle('https');}
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Player visibility verification timed out')),20000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})()`,awaitPromise:true,returnByValue:true}}));
  });
  await mkdir(resolve('.scratch/coverage-20261018'),{recursive:true});
  await writeFile(resolve('.scratch/coverage-20261018/player-visibility.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  assert.equal(result[0].visibleAtCenter,true,'Chromium must present the full player outside the short body box');
  assert.deepEqual(result[0].proof,{kind:'frame',url:'https://fixture.invalid/frame'},'Viewport-propagated overflow must not falsely hide the player');
  for(const entry of result.slice(1)){
    assert.equal(entry.visibleAtCenter,false,entry.mode+' must really clip the player');
    assert.equal(entry.proof,null,entry.mode+' must not provide selected-player evidence');
  }
}finally{socket.close();}
