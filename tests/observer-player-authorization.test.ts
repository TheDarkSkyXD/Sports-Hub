import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import test from 'node:test';

const observerFile=new URL('../desktop/sportsurge-observer.cjs',import.meta.url);
const localRequire=createRequire(observerFile);
const target={sessionId:'d03a2653-5d97-4453-8e6b-681861777337',candidateId:'selected',gameId:'nascar-cup-202610180053',generation:2};

function harness(fetcher:(url:string,options:{signal:AbortSignal;headers:Record<string,string>;body:string;redirect:string})=>Promise<Response>){
  let authorize:((value:typeof target)=>Promise<boolean>)|undefined;
  const timers:ReturnType<typeof setTimeout>[]=[];
  const sourceSession={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},
    webRequest:{onBeforeRequest(){},onBeforeSendHeaders(){},onHeadersReceived(){}}};
  const load=runInThisContext(`(function(require,module,fetch,AbortSignal){${readFileSync(observerFile,'utf8')};return module.exports;})`);
  const observer=load((id:string)=>{
    if(id==='electron')return {session:{fromPartition:()=>sourceSession}};
    if(id==='./isolated-player.cjs')return {createIsolatedPlayers:({authorizeTarget}:{authorizeTarget:NonNullable<typeof authorize>})=>{
      authorize=authorizeTarget;return {stop:async()=>{},registerHost(){}};
    }};
    if(id==='./observed-media.cjs')return {createObservedMedia:()=>({stop(){}})};
    if(id==='./playback-verifier.cjs')return {createPlaybackVerifier:()=>({configure(){},stop(){}})};
    if(id==='./source-page-reader.cjs')return {createSourcePageReader:()=>({stop(){}})};
    return localRequire(id);
  },{exports:{}},fetcher,{timeout:(ms:number)=>{
    const controller=new AbortController();timers.push(setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),ms));
    return controller.signal;
  }}).createSportsurgeObserver({controlToken:'fixture-control-token'});
  assert.ok(authorize);
  return {authorize,configure(){observer.configureVerifier('http://127.0.0.1:9000');},async stop(){await observer.stop();for(const timer of timers)clearTimeout(timer);}};
}

test('player authorization waits for a valid delayed local control reply',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const h=harness(async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:9000/api/internal/player');assert.equal(options.redirect,'manual');
    assert.equal(options.headers['x-sunday-control-token'],'fixture-control-token');assert.deepEqual(JSON.parse(options.body),target);
    return new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
      setTimeout(()=>resolve(new Response(null,{status:204})),4000);
    });
  });
  try{
    h.configure();const authorized=h.authorize(target);context.mock.timers.tick(4000);
    assert.equal(await authorized,true);
  }finally{await h.stop();}
});

test('player authorization preserves immediate explicit denial and unconfigured rejection',async()=>{
  let calls=0;
  const h=harness(async()=>{calls++;return new Response(null,{status:403});});
  try{
    assert.equal(await h.authorize(target),false);assert.equal(calls,0);
    h.configure();assert.equal(await h.authorize(target),false);assert.equal(calls,1);
  }finally{await h.stop();}
});

test('a hung local authorization request still fails at the control command deadline',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const h=harness(async(_url,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
  }));
  try{
    h.configure();let settled=false;
    const authorized=h.authorize(target).then(value=>{settled=true;return value;});
    context.mock.timers.tick(44999);for(let turn=0;turn<6;turn++)await Promise.resolve();
    assert.equal(settled,false);
    context.mock.timers.tick(1);assert.equal(await authorized,false);
  }finally{await h.stop();}
});
