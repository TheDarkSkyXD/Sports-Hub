import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const output=resolve(process.argv[2]??'.desktop-runtime/feed-isolation/native-update-quit.json');
await mkdir(dirname(output),{recursive:true});
await writeFile(output+'.events','');
const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
function arm(root,output){
  const require=process.mainModule.require.bind(process.mainModule),{app}=process.mainModule.require('electron');
  const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
  const localRequire=require('node:module').createRequire(root+'/desktop/main.cjs');
  const {DesktopNsisUpdater}=localRequire(root+'/desktop/nsis-updater.cjs');
  const updater=new DesktopNsisUpdater(undefined,undefined,()=>{},app);
  const pending=path.join(path.dirname(output),'quit-canary-pending');fs.mkdirSync(pending,{recursive:true});
  const name='Sunday-Room-1.0.7-Setup-x64.exe',file=path.join(pending,name),bytes=Buffer.from('inert native quit verification fixture');
  fs.writeFileSync(file,bytes);const sha512=createHash('sha512').update(bytes).digest('base64');
  const feed='https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
  updater.setFeedURL({provider:'generic',url:feed});
  updater.httpExecutor.admitRelease({version:'1.0.7'},[{url:new URL(feed+'/'+name),info:{sha512}}]);
  updater.downloadedUpdateHelper={file,cacheDirForPendingUpdate:pending,packageFile:null,downloadedFileInfo:{fileName:name,sha512,isAdminRightsRequired:false}};
  let acknowledged=false;
  const record=event=>fs.appendFileSync(output+'.events',JSON.stringify({at:new Date().toISOString(),event,acknowledged})+'\n');
  updater.spawnLog=async()=>{record('spawn-intercepted');await new Promise(resolve=>setTimeout(resolve,400));acknowledged=true;record('spawn-acknowledged');return true;};
  updater.logger={info(){},warn(){},debug(){},error(error){record('error:'+String(error))}};
  updater.addQuitHandler();app.on('before-quit',()=>record('before-quit'));app.on('quit',()=>record('quit'));
  record('armed');setTimeout(()=>app.quit(),500);return{pid:process.pid,electron:process.versions.electron};
}
const root=resolve('.');
try{
  const info=await new Promise((resolve,reject)=>{
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${arm.toString()})(${JSON.stringify(root)},${JSON.stringify(output)})`,returnByValue:true}}));
  });
  socket.close();
  let exited=false;
  for(let attempt=0;attempt<450;attempt++){
    try{process.kill(info.pid,0);}catch{exited=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const events=(await readFile(output+'.events','utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const result={at:new Date().toISOString(),...info,exited,events,realInstallerExecuted:false};
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  assert.ok(exited,'The real application process must finish quitting');
  assert.ok(events.find(event=>event.event==='quit')?.acknowledged,'Installer acknowledgement must precede final real application quit');
}finally{socket.close();}
