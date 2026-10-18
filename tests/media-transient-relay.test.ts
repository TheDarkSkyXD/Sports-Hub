import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {configuredProbeCandidate} from '../lib/playback/probe.ts';
import {observedPublicPage} from '../lib/playback/providers/public-page.ts';
import {test} from 'node:test';
import {streamIndex,streamToken,revokeVerificationTarget} from '../lib/stream-server.ts';
import {ProviderDeferredError,ProviderNoFeedError,sanitizedRead,type ProviderResource} from '../lib/playback/provider.ts';
import type {Candidate,Reply,VerificationTarget} from '../lib/football/shared.ts';
import verificationPolicy from '../lib/playback/verification-policy.json' with {type:'json'};

const bytes=(text:string)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}});
async function relay(role:'index'|'playlist'|'media',read:ProviderResource['read']){
  const target:VerificationTarget={sessionId:randomUUID(),gameId:'100',candidateId:'one',generation:0};
  const candidate:Candidate={id:'one',gameId:'100',label:'One',sourceIds:['fixture'],observedAt:Date.now(),locator:{provider:'gooz',playerId:'1'}};
  const send=async():Promise<Reply>=>({kind:'verification-authorized',candidate,target,deadline:Date.now()+65_000});
  const child:ProviderResource={kind:role==='playlist'?'playlist':'media',identity:'child',read,resolve:()=>null};
  const root:ProviderResource={kind:'playlist',identity:'root',read:role==='index'?read:async()=>({status:200,body:bytes(role==='playlist'?'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild':'#EXTM3U\n#EXTINF:2,\nchild\n#EXT-X-ENDLIST'),contentType:'application/vnd.apple.mpegurl'}),resolve:reference=>reference==='child'?child:null};
  try{
    const index=await streamIndex(target.gameId,target.sessionId,target.candidateId,'0',new AbortController().signal,send,async()=>({root,close(){}}));
    if(role==='index')return index;
    assert.equal(index.status,200);
    const token=/\/api\/stream\/media\/([a-f0-9]+)/.exec(await index.text())?.[1];assert.ok(token);
    return await streamToken(token,null,new AbortController().signal,send);
  }finally{revokeVerificationTarget(target.sessionId,0);}
}

test('the relay returns the reported acquisition phase and retry as a structured final outcome',async()=>{
  const response=await relay('index',async()=>{throw new ProviderDeferredError(45000,'ownership');});
  assert.equal(response.status,503);
  assert.deepEqual((await response.json()).outcome,{kind:'deferred',reason:'upstream',phase:'ownership',retryAfterMs:45000});
});

for(const role of ['index','playlist','media'] as const){
  for(const status of [408,429,500,502,503,504])test(`${role} relay preserves upstream ${status} as incomplete replay`,async()=>{
    const response=await relay(role,async()=>sanitizedRead(new Response('Temporary upstream failure',{status,headers:{'Retry-After':'90'}})));
    assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'90');
  });
  for(const status of [403,404])test(`${role} relay retains upstream ${status} as a hard rejection`,async()=>{
    const response=await relay(role,async()=>sanitizedRead(new Response('Denied or missing',{status})));
    assert.equal(response.status,status);assert.equal(response.headers.get('Retry-After'),null);
  });
  for(const kind of ['timeout','network'] as const)test(`${role} relay defers a ${kind} read without condemning the feed`,async()=>{
    const response=await relay(role,async()=>{throw kind==='timeout'?new DOMException('Timed out','TimeoutError'):
      new TypeError('fetch failed',{cause:Object.assign(new Error('Socket reset'),{code:'ECONNRESET'})});});
    assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'30');
  });
}

test('upstream throttling cancels its body and remains replay rather than local capacity',()=>{
  let canceled=0;
  assert.throws(()=>sanitizedRead(new Response(new ReadableStream({cancel(){canceled++;}}),{status:429,headers:{'Retry-After':'2'}})),error=>
    error instanceof ProviderDeferredError&&error.phase==='replay'&&error.retryAfterMs===2000);
  assert.equal(canceled,1);
  const accepted=sanitizedRead(new Response('Valid body',{status:200}));assert.equal(accepted.status,200);assert.equal(canceled,1);
});

for(const retryAfter of ['Infinity','NaN','-5','invalid'])test(`invalid Retry-After ${retryAfter} uses a finite default`,async()=>{
  const response=await relay('index',async()=>sanitizedRead(new Response('Temporary',{status:503,headers:{'Retry-After':retryAfter}})));
  assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'30');
});

test('explicit offline and invalid media remain hard failures',async()=>{
  const offline=await relay('index',async()=>{throw new ProviderNoFeedError('capture');});assert.equal(offline.status,404);
  const programming=await relay('media',async()=>{throw new TypeError('Invalid internal state');});assert.equal(programming.status,502);
});

for(const {name,body,status} of [
  {name:'invalid header',body:'This is not a playlist',status:422},
  {name:'invalid sequence',body:'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:invalid',status:422},
  {name:'unsupported resource',body:'#EXTM3U\n#EXTINF:2,\nunknown\n#EXT-X-ENDLIST',status:415},
])test(`relay ${name} remains a hard validation failure`,async()=>{
  const response=await relay('index',async()=>({status:200,body:bytes(body),contentType:'application/vnd.apple.mpegurl'}));
  assert.equal(response.status,status);assert.equal(response.headers.get('Retry-After'),null);
});


test('verification reads defer above the bounded response-body capacity',async()=>{
  const limit=verificationPolicy.concurrency*2;
  const targets:VerificationTarget[]=Array.from({length:limit+1},(_,index)=>({sessionId:randomUUID(),gameId:String(100+index),candidateId:'one',generation:0}));
  const controllers=targets.map(()=>new AbortController());
  const opened:number[]=[];
  const pending=targets.map((target,index)=>{
    const candidate:Candidate={id:'one',gameId:target.gameId,label:'One',sourceIds:['fixture'],observedAt:0,locator:{provider:'gooz',playerId:'1'}};
    const send=async():Promise<Reply>=>({kind:'verification-authorized',candidate,target,deadline:Date.now()+65_000});
    const root:ProviderResource={kind:'playlist',identity:'held-'+index,resolve:()=>null,async read(){
      opened.push(index);
      return {status:200,contentType:'application/vnd.apple.mpegurl',body:new ReadableStream<Uint8Array>({start(body){body.enqueue(new TextEncoder().encode('#EXTM3U\n'));}})};
    }};
    return streamIndex(target.gameId,target.sessionId,target.candidateId,'0',controllers[index].signal,send,async()=>({root,close(){}}));
  });
  let overflow:Response|undefined;
  void pending[limit].then(response=>{overflow=response;});
  try{
    for(let turn=0;turn<20;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(opened.length,limit);
    assert.equal(overflow?.status,429);
    assert.equal(overflow.headers.get('Retry-After'),'2');
  }finally{
    controllers.forEach(controller=>controller.abort());
    targets.forEach(target=>revokeVerificationTarget(target.sessionId,0));
    await Promise.allSettled(pending);
  }
});


test('observer service capacity reaches the relay and checker as a two-second deferral',async()=>{
  const target:VerificationTarget={sessionId:randomUUID(),gameId:'100',candidateId:'one',generation:0};
  const candidate:Candidate={id:'one',gameId:'100',label:'One',sourceIds:['fixture'],observedAt:0,locator:{provider:'gooz',playerId:'1'}};
  const send=async():Promise<Reply>=>({kind:'verification-authorized',candidate,target,deadline:Date.now()+65_000});
  let relayStatus=0,relayRetry:string|null=null;
  const server=createServer((request,response)=>{
    request.resume();
    if(request.url==='/observe'){response.writeHead(429);response.end();return;}
    if(request.url!=='/verify'){response.writeHead(204);response.end();return;}
    void streamIndex(target.gameId,target.sessionId,target.candidateId,'0',new AbortController().signal,send,async()=>{
      const playback=await observedPublicPage(new URL('https://player.example/watch'),new AbortController().signal,'probe');
      assert.ok(playback);return playback;
    }).then(result=>{
      relayStatus=result.status;relayRetry=result.headers.get('Retry-After');
      response.writeHead(result.status,{'Retry-After':relayRetry??'2'});response.end();
    },()=>{response.writeHead(500);response.end();});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const previous=Object.fromEntries(['SUNDAY_ROOM_APP_ORIGIN','SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN','SUNDAY_ROOM_CONTROL_TOKEN'].map(key=>[key,process.env[key]]));
  process.env.SUNDAY_ROOM_APP_ORIGIN='http://127.0.0.1:'+address.port;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=process.env.SUNDAY_ROOM_APP_ORIGIN;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='fixture-token';
  try{
    const result=await configuredProbeCandidate(candidate.locator,new AbortController().signal,()=>{},target);
    assert.equal(relayStatus,429);assert.equal(relayRetry,'2');
    assert.deepEqual(result,{kind:'deferred',reason:'capacity',retryAfterMs:2000});
  }finally{
    revokeVerificationTarget(target.sessionId,0);
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
