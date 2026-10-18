import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

async function verify(root){
  const require=process.mainModule.require.bind(process.mainModule);
  const {session,net}=process.mainModule.require('electron');
  const localRequire=require('node:module').createRequire(root+'/desktop/main.cjs');
  delete localRequire.cache[localRequire.resolve(root+'/desktop/update-network.cjs')];
  const {GitHubUpdateExecutor}=require(root+'/desktop/update-network.cjs');
  const {defaultUpdateFeedUrl}=require(root+'/desktop/update.cjs');
  const own=session.fromPartition('update-network-'+require('node:crypto').randomUUID(),{cache:false});
  let requests=0;const events=[];
  const beforeRequest=own.webRequest.onBeforeRequest.bind(own.webRequest);
  own.webRequest.onBeforeRequest=handler=>beforeRequest((details,respond)=>handler(details,decision=>{events.push({url:details.url,id:details.id,method:details.method,pending:[...executor.pending],epoch:executor.epoch,...decision});respond(decision)}));
  const executor=new GitHubUpdateExecutor({getSession:()=>own,request:options=>{requests++;const result=net.request(options);for(const event of ['close','abort','error','finish','redirect','response'])result.on(event,()=>events.push({event,pending:[...executor.pending]}));return result}});
  executor.setFeed(defaultUpdateFeedUrl);
  const url=new URL(defaultUpdateFeedUrl+'/latest.yml');
  const options=value=>({protocol:value.protocol,hostname:value.hostname,path:value.pathname+value.search,headers:{'User-Agent':'Sunday-Room-audit'}});
  try{
    let metadata;try{metadata=await executor.request(options(url));}catch(error){return{failure:String(error),events,requests}};
    const parsed=localRequire('js-yaml').load(metadata);
    const result={at:new Date().toISOString(),electron:process.versions.electron,feed:defaultUpdateFeedUrl,
      version:parsed.version,metadataBytes:Buffer.byteLength(metadata),legitimateRequests:requests,denied:[]};
    for(const address of ['https://example.com/payload.exe','https://release-assets.githubusercontent.com/payload.exe','https://github.com/other/repo/releases/latest/download/latest.yml']){
      const before=requests;
      try{await executor.request(options(new URL(address)));result.denied.push({address,blocked:false,requests:requests-before});}
      catch(error){result.denied.push({address,blocked:true,requests:requests-before,error:String(error.message)});}
    }
    return result;
  }finally{await own.closeAllConnections();await own.clearStorageData();await own.clearCache();}
}
const root=resolve('.');
const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
try{
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Native update metadata request timed out')),45000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(root)})`,returnByValue:true,awaitPromise:true}}));
  });
  await writeFile(resolve(process.argv[2]??'.desktop-runtime/feed-isolation/native-update-network.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.ok(!result.failure,JSON.stringify(result));
  assert.match(result.version,/^\d+\.\d+\.\d+/);assert.ok(result.metadataBytes>0&&result.legitimateRequests>0);
  assert.ok(result.denied.every(item=>item.blocked&&item.requests===0));
}finally{socket.close();}
