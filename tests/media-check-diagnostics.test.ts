import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test,type TestContext} from 'node:test';
import {candidateEvidence} from '../components/source-inventory-view.ts';
import {CandidateSummarySchema,type Game} from '../lib/football/shared.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {configuredProbeCandidate} from '../lib/playback/probe.ts';

test('decoded-video failures keep their reported cause through the checker and source inventory',async()=>{
  let report:unknown={kind:'unavailable'};
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify(request.url==='/verify'?report:{ok:true}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const previous=Object.fromEntries(['SUNDAY_ROOM_APP_ORIGIN','SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN','SUNDAY_ROOM_CONTROL_TOKEN']
    .map(key=>[key,process.env[key]]));
  process.env.SUNDAY_ROOM_APP_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=process.env.SUNDAY_ROOM_APP_ORIGIN;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='public-test-fixture';
  const target={sessionId:'00000000-0000-4000-8000-000000000001',gameId:'1',candidateId:'one',generation:0} satisfies Parameters<typeof configuredProbeCandidate>[3];
  try{
    for(const value of [
      {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},
        timings:{resolutionMs:100,captureMs:200,decodeMs:2700,path:'hls'}},
      {kind:'unavailable',reason:'no-feed',phase:'activation'},
      {kind:'unavailable',reason:'invalid-media',phase:'decode'},
      {kind:'deferred',reason:'upstream',phase:'ownership',retryAfterMs:45000},
      {kind:'deferred',reason:'capacity',phase:'capture',retryAfterMs:2000},
    ]){
      report=value;
      assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target),value);
    }
    const waiting=CandidateSummarySchema.parse({id:'one',gameId:'1',label:'One',sourceIds:['fixture'],observedAt:0,
      availability:{kind:'checking',progress:{kind:'deferred',since:1000,retryAt:3000,reason:'capacity',phase:'capture',retryAfterMs:2000}}});
    assert.equal(candidateEvidence(waiting,1000),'Waiting for a playback check · Retrying in 2s');
    for(const [reason,label] of [['blocked','Source denied media access'],['not-found','Source media not found'],
      ['invalid-media','No valid video returned'],['timeout','Media check timed out']]){
      report={kind:'unavailable',reason};
      const result=await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target);
      assert.deepEqual(result,{kind:'unavailable',reason,phase:'replay'});
      const candidate=CandidateSummarySchema.parse({id:'one',gameId:'1',label:'One',sourceIds:['fixture'],observedAt:0,
        availability:{...result,checkedAt:1000,retryAt:301000}});
      assert.equal(candidateEvidence(candidate,1000),`${label} · Waiting 5m 0s for next check`);
    }
    report={kind:'unavailable'};
    assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target),
      {kind:'unavailable',reason:'playback',phase:'replay'});
    for(const invalid of [{kind:'playable',proof:{kind:'advancing-video'}},{kind:'unavailable',reason:'invented'}]){
      report=invalid;
      assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target),
        {kind:'deferred',reason:'unverified',retryAfterMs:30000});
    }
  }finally{
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('a verifier service error cannot establish that the upstream video is broken',async()=>{
  const server=createServer((_request,response)=>{response.writeHead(500);response.end('Verifier unavailable');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const previous=Object.fromEntries(['SUNDAY_ROOM_APP_ORIGIN','SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN','SUNDAY_ROOM_CONTROL_TOKEN']
    .map(key=>[key,process.env[key]]));
  process.env.SUNDAY_ROOM_APP_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=process.env.SUNDAY_ROOM_APP_ORIGIN;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='public-test-fixture';
  try{
    assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},
      {sessionId:'00000000-0000-4000-8000-000000000001',gameId:'1',candidateId:'one',generation:0}),
    {kind:'deferred',reason:'upstream',retryAfterMs:30000});
  }finally{
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

const target={sessionId:'00000000-0000-4000-8000-000000000001',gameId:'100',candidateId:'one',generation:0} satisfies Parameters<typeof configuredProbeCandidate>[3];
const locator={provider:'gooz',playerId:'1'} satisfies Parameters<typeof configuredProbeCandidate>[0];
function verifierEnvironment(t:TestContext){
  const previous=Object.fromEntries(['SUNDAY_ROOM_APP_ORIGIN','SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN','SUNDAY_ROOM_CONTROL_TOKEN']
    .map(key=>[key,process.env[key]]));
  process.env.SUNDAY_ROOM_APP_ORIGIN='http://127.0.0.1:1';
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=process.env.SUNDAY_ROOM_APP_ORIGIN;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='public-test-fixture';
  t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

for(const status of [403,404,429,500,503])test(`verifier HTTP ${status} reports service failure without condemning the video`,async t=>{
  verifierEnvironment(t);
  let revoked=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    if(String(input).endsWith('/verify'))return new Response('',{status});
    revoked++;return new Response(null,{status:204});
  });
  assert.deepEqual(await configuredProbeCandidate(locator,new AbortController().signal,()=>{},target),
    status===429?{kind:'deferred',reason:'capacity',retryAfterMs:2000}:{kind:'deferred',reason:'upstream',retryAfterMs:30000});
  assert.equal(revoked,1);
});

for(const body of ['not json','null','{}','{"kind":"playable","proof":"media"}'])test(`malformed verifier reply ${body} remains unverified`,async t=>{
  verifierEnvironment(t);
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>String(input).endsWith('/verify')?
    new Response(body,{headers:{'Content-Type':'application/json'}}):new Response(null,{status:204}));
  assert.deepEqual(await configuredProbeCandidate(locator,new AbortController().signal,()=>{},target),
    {kind:'deferred',reason:'unverified',retryAfterMs:30000});
});

test('a verifier transport failure is upstream while the local deadline is a timeout',async t=>{
  verifierEnvironment(t);
  let failure:Error=new TypeError('fetch failed');
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    if(String(input).endsWith('/verify'))throw failure;
    return new Response(null,{status:204});
  });
  assert.deepEqual(await configuredProbeCandidate(locator,new AbortController().signal,()=>{},target),
    {kind:'deferred',reason:'upstream',retryAfterMs:30000});
  failure=new DOMException('Timed out','TimeoutError');
  assert.deepEqual(await configuredProbeCandidate(locator,new AbortController().signal,()=>{},target),
    {kind:'deferred',reason:'timeout',retryAfterMs:30000});
});

test('the combined verification deadline reaches the adapter as a timeout',async t=>{
  verifierEnvironment(t);
  const timeout=AbortSignal.timeout;
  t.mock.method(AbortSignal,'timeout',(ms:number)=>ms===65000?AbortSignal.abort(new DOMException('Timed out','TimeoutError')):timeout(ms));
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).endsWith('/verify'))init?.signal?.throwIfAborted();
    return new Response(null,{status:204});
  });
  assert.deepEqual(await configuredProbeCandidate(locator,new AbortController().signal,()=>{},target),
    {kind:'deferred',reason:'timeout',retryAfterMs:30000});
});

test('a caller deadline remains a timeout at the verifier boundary',async t=>{
  verifierEnvironment(t);
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).endsWith('/verify'))init?.signal?.throwIfAborted();
    return new Response(null,{status:204});
  });
  assert.deepEqual(await configuredProbeCandidate(locator,AbortSignal.abort(new DOMException('Caller deadline','TimeoutError')),()=>{},target),
    {kind:'deferred',reason:'timeout',retryAfterMs:30000});
});

for(const cause of [new Error('Caller cancelled'),new DOMException('Caller cancelled','AbortError')])
  test(`caller ${cause.name} cancellation takes precedence over a transport timeout`,async t=>{
    verifierEnvironment(t);
    t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
      if(String(input).endsWith('/verify'))throw new DOMException('Transport timed out','TimeoutError');
      return new Response(null,{status:204});
    });
    assert.deepEqual(await configuredProbeCandidate(locator,AbortSignal.abort(cause),()=>{},target),
      {kind:'deferred',reason:'cancelled',retryAfterMs:30000});
  });

test('caller cancellation survives the adapter and does not advance the coordinator incomplete streak',async t=>{
  verifierEnvironment(t);
  const controller=new AbortController();
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    if(String(input).endsWith('/verify')){controller.abort(new Error('Fixture cancellation'));throw controller.signal.reason;}
    return new Response(null,{status:204});
  });
  const cancelled=await configuredProbeCandidate(locator,controller.signal,()=>{},target);
  assert.deepEqual(cancelled,{kind:'deferred',reason:'cancelled',retryAfterMs:30000});
  let now=Date.parse('2026-10-18T18:00:00Z'),calls=0;
  const game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(now).toISOString(),status:'in',lifecycle:'live',
    detail:'Q1',redzone:false,partitions:['nfl'],home:{name:'Home',short:'Home',abbreviation:'H',color:'112233',score:null},
    away:{name:'Away',short:'Away',abbreviation:'A',color:'332211',score:null}};
  const coordinator=createFootballCoordinator(':memory:',{now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],readSchedule:async()=>({games:[game],league:'nfl',at:now}),
    readHtml:async()=>'<main/>',parseListings:()=>({outcome:'parsed',observations:[{id:'listing',sourceId:'fixture',url:'https://fixture.example/game',
      title:game.name,league:'nfl',teams:['Away','Home'],kickoff:Date.parse(game.date!),rawTime:'',observedAt:now,parserVersion:3}]}),
    enrichObservation:value=>value,compatiblePlayers:()=>[{id:'player',label:'Player',locator}],
    probeCandidate:async()=>++calls===2?cancelled:{kind:'deferred',reason:'upstream',retryAfterMs:30000}});
  try{
    for(const [index,reason,delay] of [[1,'upstream',30000],[2,'cancelled',30000],[3,'upstream',60000]] as const){
      await coordinator.refresh(true);
      for(let turn=0;turn<50;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(calls,index);
      const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');
      if(reply.kind!=='sources')throw new Error('Expected sources');
      const availability=reply.snapshot.games[0]?.candidates[0]?.availability;
      assert.equal(availability?.kind,'checking');if(availability?.kind!=='checking')throw new Error('Expected check');
      assert.deepEqual(availability.progress,{kind:'deferred',since:now,retryAt:now+delay,reason,retryAfterMs:delay});
      now+=delay;
    }
  }finally{await coordinator.stop();}
});

test('missing verifier configuration stays a safe service deferral',async t=>{
  verifierEnvironment(t);delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected request');});
  assert.deepEqual(await configuredProbeCandidate(locator,new AbortController().signal,()=>{},target),{kind:'deferred',retryAfterMs:30000});
  assert.equal(fetch.mock.callCount(),0);
});
