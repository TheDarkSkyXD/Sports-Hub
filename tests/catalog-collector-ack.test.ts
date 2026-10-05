import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);

async function collectAck(file:string,exportName:string,sweepName:string,response:Response) {
  const Module=require('node:module');
  const originalLoad=Module._load;
  const originalFetch=globalThis.fetch;
  let seen:unknown;
  let error:unknown;
  const sourceSession={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){}};
  Module._load=function(request:string,parent:{filename?:string}|null,isMain:boolean) {
    if(parent?.filename?.endsWith(file)) {
      if(request==='electron')return {session:{fromPartition(){return sourceSession;}}};
      if(request===sweepName)return { [sweepName==='./sportsurge-sweep.cjs'?'runSportsurgeSweep':'runStreameastSweep']:
        async({send}:{send:(catalog:object)=>Promise<unknown>})=>{
          try {seen=await send({runId:'fixture',sequence:0});}
          catch(caught){error=caught;}
          return {state:{kind:'complete'}};
        }};
    }
    return originalLoad.call(this,request,parent,isMain);
  };
  globalThis.fetch=async()=>response;
  let createCollector;
  const target=require.resolve(`../desktop/${file}`);
  delete require.cache[target];
  try {({[exportName]:createCollector}=require(target));}
  finally {Module._load=originalLoad;}
  const collector=createCollector({origin:'http://127.0.0.1:1',controlToken:'unused'});
  try {await collector.requestSweep();}
  finally {collector.stop();globalThis.fetch=originalFetch;}
  return {seen,error};
}

test('both collectors return accepted checkpoint acknowledgments and tolerate legacy 204 replies',async()=>{
  for(const [file,exportName,sweepName] of [
    ['sportsurge-collector.cjs','createSportsurgeCollector','./sportsurge-sweep.cjs'],
    ['streameast-collector.cjs','createStreameastCollector','./streameast-sweep.cjs'],
  ]) {
    const ack={kind:'catalog-ack',skipDetailEventIds:['ncaaf:10001']};
    assert.deepEqual((await collectAck(file,exportName,sweepName,Response.json(ack))).seen,ack);
    const intervalAck={kind:'catalog-ack',skipDetailEventIds:[],sourceRefreshMs:60_000};
    assert.deepEqual((await collectAck(file,exportName,sweepName,Response.json(intervalAck))).seen,intervalAck);
    assert.equal((await collectAck(file,exportName,sweepName,new Response(null,{status:204}))).seen,undefined);
    const malformed=await collectAck(file,exportName,sweepName,Response.json({kind:'catalog-ack',skipDetailEventIds:[42]}));
    assert.equal(malformed.error instanceof Error?malformed.error.message:null,'parser-changed');
    const invalidInterval=await collectAck(file,exportName,sweepName,Response.json({kind:'catalog-ack',skipDetailEventIds:[],sourceRefreshMs:500}));
    assert.equal(invalidInterval.error instanceof Error?invalidInterval.error.message:null,'parser-changed');
  }
});
