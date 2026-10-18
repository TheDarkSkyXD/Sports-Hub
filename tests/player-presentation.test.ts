import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {CandidateSchema,type Command,type Reply} from '../lib/football/shared.ts';
import {streamPresentation} from '../lib/stream-server.ts';
import {expireIdleStreams,registeredResource,revokeSession,touchStreamSession} from '../lib/stream-relay.ts';
import type {ProviderPlayback,ProviderResource} from '../lib/playback/provider.ts';
import {readPresentation} from '../lib/playback/presentation.ts';

const player={url:'https://gooz.aapmains.net/new-stream-embed/57069',referer:'https://gooz.aapmains.net/new-stream-embed/57069'};
const candidate=CandidateSchema.parse({id:'gooz-57069',gameId:'ncaaf-123',label:'Gooz',sourceIds:['gooz'],observedAt:1,availability:{kind:'unknown'},locator:{provider:'gooz',playerId:'57069'}});
const resource=(kind:'playlist'|'media'):ProviderResource=>({kind,identity:'https://media.example/live',
  async read(){throw new Error('Resolving the presentation must not read or decode media');},resolve(){return null;}});
function setup(viewing=false){
  const sessionId=randomUUID(),deadline=Date.now()+60_000;
  const input={gameId:candidate.gameId,sessionId,candidateId:candidate.id,generation:'0',signal:new AbortController().signal,intent:'primary' as const};
  const send=async():Promise<Reply>=>viewing?{kind:'authorized',candidate,
    session:{id:sessionId,gameId:candidate.gameId,candidateId:candidate.id,generation:0,state:'active',graceEndsAt:null}}:
    {kind:'verification-authorized',candidate,target:{sessionId,candidateId:candidate.id,gameId:candidate.gameId,generation:0},deadline};
  const fallbackUrl=`/api/stream/ncaaf-123/presentation?session=${sessionId}&candidate=gooz-57069&generation=0&intent=fallback`;
  return {sessionId,deadline,input,send,fallbackUrl};
}

test('presentation HTTP outcomes settle capacity and upstream deferrals instead of leaving a loading state',async()=>{
  assert.deepEqual(await readPresentation(new Response(null,{status:429})),{kind:'deferred',reason:'capacity',phase:'resolution',retryAfterMs:2000});
  assert.deepEqual(await readPresentation(new Response(null,{status:503})),{kind:'deferred',reason:'upstream',phase:'resolution',retryAfterMs:30000});
  assert.deepEqual(await readPresentation(new Response(null,{status:503,headers:{'Retry-After':'90'}})),{kind:'deferred',reason:'upstream',phase:'resolution',retryAfterMs:90000});
  assert.deepEqual(await readPresentation(new Response(null,{status:404})),{kind:'unavailable'});
  assert.deepEqual(await readPresentation(Response.json({kind:'hls',url:'https://untrusted.example/game.m3u8'})),{kind:'unavailable'});
});

test('direct descriptors accept only the local authorized fallback operation',async()=>{
  const {fallbackUrl}=setup();
  const descriptor={kind:'progressive',url:`/api/stream/media/${'a'.repeat(48)}`,fallbackUrl};
  assert.deepEqual(await readPresentation(Response.json(descriptor)),{kind:'ready',presentation:descriptor});
  for(const invalid of [
    `https://untrusted.example${fallbackUrl}`,`//untrusted.example${fallbackUrl}`,
    fallbackUrl.replace('/presentation?','/index.m3u8?'),fallbackUrl.replace('intent=fallback','intent=primary'),
    fallbackUrl.replace('generation=0','generation=wrong'),fallbackUrl.replace(/session=[^&]+&/,''),
    `${fallbackUrl}&session=other`,`${fallbackUrl}&extra=1`,`${fallbackUrl}#fragment`,
  ])assert.deepEqual(await readPresentation(Response.json({...descriptor,fallbackUrl:invalid})),{kind:'unavailable'},invalid);
  assert.deepEqual(await readPresentation(Response.json({...descriptor,fallbackUrl:undefined,fallback:randomUUID()})),{kind:'unavailable'});
});

test('resolved direct media does not wait for its unused native player fallback',async()=>{
  const {sessionId,input,send}=setup();let offers=0;
  try{
    const reply=await streamPresentation(input,{send,opener:async()=>({root:resource('playlist'),player,close(){}}),offer:async()=>{
      offers++;throw new DOMException('Native player registration timed out','TimeoutError');
    }});
    assert.equal(reply.status,200);
    const result=await readPresentation(reply);
    assert.equal(result.kind,'ready');
    if(result.kind==='ready')assert.equal(result.presentation.kind,'hls');
    assert.equal(offers,0);
  }finally{revokeSession(sessionId);}
});

for(const kind of ['playlist','media'] as const)test(`${kind} is ready without invoking a never-settling optional offer`,{timeout:2000},async()=>{
  const {sessionId,input,send,fallbackUrl}=setup();let offers=0;
  try{
    const response=await streamPresentation(input,{send,opener:async()=>({root:resource(kind),player,close(){}}),
      offer:()=>{offers++;return new Promise(()=>{});}});
    assert.equal(response.status,200);const result=await readPresentation(response);
    assert.equal(result.kind,'ready');
    if(result.kind==='ready'){
      assert.equal(result.presentation.kind,kind==='playlist'?'hls':'progressive');
      assert.ok(result.presentation.kind!=='isolated-embed');assert.equal(result.presentation.fallbackUrl,fallbackUrl);
    }
    assert.equal(offers,0);
  }finally{revokeSession(sessionId);}
});

test('primary resolution and concurrent fallback requests share one generation and native offer',async context=>{
  context.mock.timers.enable({apis:['Date']});
  const {sessionId,deadline,input,send,fallbackUrl}=setup();let opens=0,offers=0,closed=0,revoked=0;
  const authorizations:Command[]=[];
  const authorize=async(command:Command)=>{authorizations.push(command);return send();};
  const started=Promise.withResolvers<void>(),held=Promise.withResolvers<{capability:string;close():void}>();
  const opener=async():Promise<ProviderPlayback>=>{opens++;context.mock.timers.tick(25);return {root:resource('playlist'),player,close(){closed++;}};};
  const offer:NonNullable<Parameters<typeof streamPresentation>[1]>['offer']=async(target,document,offeredDeadline)=>{
    offers++;assert.deepEqual(target,{sessionId,candidateId:candidate.id,gameId:candidate.gameId,generation:0,purpose:'verification'});
    assert.deepEqual(document,player);assert.equal(offeredDeadline,deadline);started.resolve();return held.promise;
  };
  try{
    const first=await streamPresentation(input,{send:authorize,opener,offer});
    assert.equal(first.headers.get('Server-Timing'),'resolution;dur=25');
    assert.deepEqual(await first.json(),{kind:'hls',url:`/api/stream/ncaaf-123/index.m3u8?session=${sessionId}&candidate=gooz-57069&generation=0`,fallbackUrl});
    assert.equal(offers,0);
    const fallbackInput={...input,intent:'fallback' as const};
    const pending=streamPresentation(fallbackInput,{send:authorize,opener,offer});await started.promise;
    const duplicate=streamPresentation(fallbackInput,{send:authorize,opener,offer});
    const capability=randomUUID();held.resolve({capability,close(){revoked++;}});
    assert.deepEqual(await(await pending).json(),{kind:'isolated-embed',capability});
    assert.deepEqual(await(await duplicate).json(),{kind:'isolated-embed',capability});
    assert.equal(opens,1);assert.equal(offers,1);assert.equal(closed,0);assert.equal(revoked,0);
    assert.deepEqual(authorizations,Array.from({length:3},()=>({kind:'authorize',sessionId,candidateId:'gooz-57069',generation:0})));
  }finally{revokeSession(sessionId);}
  assert.equal(closed,1);assert.equal(revoked,1);
});

test('progressive video without a native player has no fallback descriptor',async()=>{
  const {sessionId,input,send}=setup();
  try{
    const reply=await streamPresentation(input,{send,opener:async()=>({root:resource('media'),close(){}})});
    assert.equal(reply.status,200);const value=await reply.json();
    assert.equal(value.kind,'progressive');assert.match(value.url,/^\/api\/stream\/media\/[a-f0-9]{48}$/);
    assert.equal(value.fallbackUrl,undefined);
  }finally{revokeSession(sessionId);}
});

test('an embed-only primary request waits for its required opaque capability',async()=>{
  const {sessionId,input,send}=setup(),capability=randomUUID();
  const started=Promise.withResolvers<void>(),held=Promise.withResolvers<{capability:string;close():void}>();let settled=false;
  try{
    const pending=streamPresentation(input,{send,opener:async()=>({root:null,player,close(){}}),offer:async()=>{started.resolve();return held.promise;}});
    void pending.then(()=>{settled=true;});await started.promise;assert.equal(settled,false);
    held.resolve({capability,close(){}});
    const response=await pending;assert.equal(response.status,200);const body=await response.text();
    assert.deepEqual(JSON.parse(body),{kind:'isolated-embed',capability});assert.equal(body.includes('gooz.aapmains.net'),false);
  }finally{revokeSession(sessionId);}
});

test('canceling one fallback waiter leaves the shared offer available to another',async()=>{
  const {sessionId,input,send}=setup();const controller=new AbortController();let offers=0;
  const started=Promise.withResolvers<void>(),held=Promise.withResolvers<{capability:string;close():void}>();
  const opener=async():Promise<ProviderPlayback>=>({root:resource('playlist'),player,close(){}});
  const offer=async()=>{offers++;started.resolve();return held.promise;};
  try{
    await streamPresentation(input,{send,opener,offer});
    const first=streamPresentation({...input,intent:'fallback',signal:controller.signal},{send,opener,offer});await started.promise;
    const second=streamPresentation({...input,intent:'fallback'},{send,opener,offer});
    const canceled=assert.rejects(first,{name:'AbortError'});controller.abort();await canceled;
    const capability=randomUUID();held.resolve({capability,close(){}});
    assert.deepEqual(await(await second).json(),{kind:'isolated-embed',capability});assert.equal(offers,1);
  }finally{held.resolve({capability:randomUUID(),close(){}});revokeSession(sessionId);}
});

test('revocation closes a capability arriving after its generation ended',async()=>{
  const {sessionId,input,send}=setup();let closed=0;
  const started=Promise.withResolvers<void>(),held=Promise.withResolvers<{capability:string;close():void}>();
  try{
    const pending=streamPresentation({...input,intent:'fallback'},{send,opener:async()=>({root:resource('playlist'),player,close(){}}),
      offer:async()=>{started.resolve();return held.promise;}});
    await started.promise;revokeSession(sessionId);held.resolve({capability:randomUUID(),close(){closed++;}});
    assert.notEqual((await pending).status,200);assert.equal(closed,1);
  }finally{revokeSession(sessionId);}
});

test('a progressive fallback survives idle media-token expiry while normal heartbeat keeps the generation alive',async context=>{
  context.mock.timers.enable({apis:['Date']});
  const {sessionId,input,send,fallbackUrl}=setup(true);let opens=0,offers=0;
  const opener=async():Promise<ProviderPlayback>=>{opens++;return {root:resource('media'),player,close(){}};};
  const capability=randomUUID(),offer=async()=>{offers++;return {capability,close(){}};};
  try{
    const primary=await(await streamPresentation(input,{send,opener,offer})).json();assert.equal(primary.fallbackUrl,fallbackUrl);
    for(let heartbeat=0;heartbeat<12;heartbeat++){
      context.mock.timers.tick(30_000);touchStreamSession(sessionId,0);expireIdleStreams();
    }
    assert.equal(registeredResource(primary.url.split('/').at(-1)),null);
    const reply=await streamPresentation({...input,intent:'fallback'},{send,opener,offer});
    assert.deepEqual(await reply.json(),{kind:'isolated-embed',capability});assert.equal(opens,1);assert.equal(offers,1);
  }finally{revokeSession(sessionId);}
});

test('fallback reauthorization rejects an expired grant before touching cached playback or native registration',async()=>{
  const {sessionId,input,send}=setup();let offers=0,opens=0;
  const opener=async():Promise<ProviderPlayback>=>{opens++;return {root:resource('playlist'),player,close(){}};};
  const offer=async()=>{offers++;return {capability:randomUUID(),close(){}};};
  try{
    await streamPresentation(input,{send,opener,offer});
    const denied=async():Promise<Reply>=>({kind:'error',status:410,message:'Stream generation expired.'});
    const response=await streamPresentation({...input,intent:'fallback'},{send:denied,opener,offer});
    assert.equal(response.status,410);assert.equal(opens,1);assert.equal(offers,0);
  }finally{revokeSession(sessionId);}
});
