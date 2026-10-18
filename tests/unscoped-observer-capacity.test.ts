import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import test from 'node:test';
import {createProbeResources,probeObserverLease} from '../lib/playback/probe-capacity.ts';
import {ProviderDeferredError,type ProviderPlayback} from '../lib/playback/provider.ts';
import {probeCandidate} from '../lib/playback/probe.ts';
import {observedPublicPage} from '../lib/playback/providers/public-page.ts';
import verificationPolicy from '../lib/playback/verification-policy.json' with {type:'json'};

const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('a full production observer pool immediately defers with retryable capacity',async()=>{
  const held=await Promise.all(Array.from({length:verificationPolicy.concurrency},()=>probeObserverLease(new AbortController().signal)));
  const controller=new AbortController();
  let result:unknown='pending';
  const attempt=probeCandidate({provider:'gooz',playerId:'1'},controller.signal,async()=>{
    const release=await probeObserverLease(controller.signal);
    release();
    throw new Error('No observer should have been admitted');
  }).then(value=>{result=value;});
  try{
    await settle();
    assert.deepEqual(result,{kind:'deferred',reason:'capacity',retryAfterMs:2000});
    held[0]();
    const release=await probeObserverLease(controller.signal);release();
    const aborted=new AbortController(),reason=new Error('Canceled capture');aborted.abort(reason);
    await assert.rejects(probeObserverLease(aborted.signal),error=>error===reason);
  }finally{controller.abort();held.forEach(release=>release());await attempt;}
});

for(const observerLimit of [1,6])test(`scoped observer calls retain their configured limit of ${observerLimit}`,async()=>{
  const resources=createProbeResources({httpLimit:8,observerLimit,activeBudgetMs:10000});
  const finish=Promise.withResolvers<void>();
  const admitted:number[]=[];
  const releases=new Map<number,()=>void>();
  const jobs=Array.from({length:8},(_,index)=>resources.run(new AbortController().signal,()=>{},async signal=>{
    const release=await probeObserverLease(signal);
    admitted.push(index);
    releases.set(index,release);
    try{await finish.promise;}finally{release();}
  }));
  try{
    await settle();
    assert.deepEqual(admitted,Array.from({length:observerLimit},(_,index)=>index));
    const release=releases.get(0);
    assert.ok(release);
    release();await settle();
    assert.deepEqual(admitted,Array.from({length:observerLimit+1},(_,index)=>index));
  }finally{
    finish.resolve();
    await Promise.all(jobs);
  }
});

test('observer capacity stays unavailable until an observed session acknowledges close',async()=>{
  let captures=0;
  let holdClose=true;
  const closing:ServerResponse[]=[];
  const closeRequested=Promise.withResolvers<void>();
  const server=createServer((request,response)=>{
    request.resume();
    if(request.method==='DELETE'){
      if(holdClose){closing.push(response);closeRequested.resolve();}
      else{response.writeHead(204);response.end();}
      return;
    }
    captures++;
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({url:`https://cdn.example/live/${captures}/index.m3u8`,
      referer:'https://player.example/watch',userAgent:'Fixture observer',
      capability:`00000000-0000-4000-8000-${String(captures).padStart(12,'0')}`}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const previousOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const previousToken=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='fixture-control';
  const playbacks:ProviderPlayback[]=[];
  const limit=verificationPolicy.concurrency;
  const controllers=Array.from({length:limit+1},()=>new AbortController());
  const capture=async(controller:AbortController)=>{
    const playback=await observedPublicPage(new URL('https://player.example/watch'),controller.signal,'probe');
    assert.ok(playback);
    playbacks.push(playback);
    return playback;
  };
  let following:Promise<ProviderPlayback>|undefined;
  try{
    await Promise.all(controllers.slice(0,limit).map(capture));
    const denied=capture(controllers[limit]).then(()=>null,error=>error);
    await settle();
    const failure=await Promise.race([denied,Promise.resolve('pending')]);
    assert.ok(failure instanceof ProviderDeferredError);
    assert.equal(failure.retryAfterMs,2000);
    assert.equal(captures,limit);
    playbacks[0].close();
    await closeRequested.promise;
    assert.equal(captures,limit);
    holdClose=false;
    for(const response of closing){response.writeHead(204);response.end();}
    let released=false;
    for(let turn=0;turn<100&&!released;turn++){
      try{const release=await probeObserverLease(controllers[limit].signal);release();released=true;}
      catch(error){if(!(error instanceof ProviderDeferredError))throw error;await settle();}
    }
    assert.equal(released,true,'The close acknowledgement releases the observer permit');
    following=capture(controllers[limit]);
    const admitted=await following;
    assert.equal(captures,limit+1);
    assert.equal(admitted.root.identity,`https://cdn.example/live/${limit+1}/index.m3u8`);
  }finally{
    holdClose=false;
    for(const response of closing)if(!response.writableEnded){response.writeHead(204);response.end();}
    for(const controller of controllers)controller.abort();
    if(following)await Promise.allSettled([following]);
    for(const playback of playbacks)playback.close();
    await settle();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previousOrigin===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=previousOrigin;
    if(previousToken===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN=previousToken;
  }
});
