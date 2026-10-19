import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {CandidateSchema,type Reply} from '../lib/football/shared.ts';
import {readPresentation} from '../lib/playback/presentation.ts';
import {resource,type Requester} from '../lib/playback/providers/public-page.ts';
import {registerResource,revokeSession} from '../lib/stream-relay.ts';
import {streamPresentation,streamToken} from '../lib/stream-server.ts';

const candidate=CandidateSchema.parse({id:'dash-fixture',gameId:'fixture-game',label:'Fixture',sourceIds:['fixture'],observedAt:1,
  availability:{kind:'unknown'},locator:{provider:'gooz',playerId:'57069'}});
function fixture(){
  const sessionId=randomUUID(),requests:Array<{url:string;range:string|null;referer:string|null}>=[];
  const requester:Requester=async(url,_signal,headers)=>{
    requests.push({url:url.href,range:headers.get('range'),referer:headers.get('referer')});
    const manifest=url.hostname==='cdn.example'?'<MPD><Period><AdaptationSet><Representation id="video"><SegmentTemplate initialization="init.mp4" media="segment-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>':
      '<MPD><BaseURL>../tracks/</BaseURL><Location>https://cdn.example/alternate/main.mpd</Location><Period><AdaptationSet><Representation id="video"><SegmentTemplate initialization="https://cdn.example/track/init.mp4" media="video/segment-$Number%05d$.m4s?token=segment"/></Representation></AdaptationSet></Period></MPD>';
    return new Response(url.pathname.endsWith('.mpd')?manifest:'segment',{
      status:headers.has('range')?206:200,headers:{'content-type':url.pathname.endsWith('.mpd')?'application/dash+xml':'video/mp4',
        ...(headers.has('range')?{'content-range':'bytes 0-6/7'}:{})},
    });
  };
  const root=resource(new URL('https://media.example/sport/manifests/main.mpd?secret=server-only'),
    new URL('https://player.example/event'), 'dash',requester);
  const grant={sessionId,candidateId:candidate.id,gameId:candidate.gameId,generation:0};
  const send=async():Promise<Reply>=>({kind:'authorized',candidate,
    session:{id:sessionId,gameId:candidate.gameId,candidateId:candidate.id,generation:0,state:'active',graceEndsAt:null}});
  const token=registerResource(grant,root);
  return {sessionId,requests,root,grant,send,token};
}

test('DASH presentation retains its format and dormant isolated fallback',async()=>{
  const f=fixture();let offers=0;
  try{
    const response=await streamPresentation({gameId:candidate.gameId,sessionId:f.sessionId,candidateId:candidate.id,
      generation:'0',intent:'primary',signal:new AbortController().signal},{send:f.send,
      opener:async()=>({root:f.root,player:{url:'https://player.example/event',referer:'https://player.example/event'},close(){}}),
      offer:async()=>{offers++;throw new Error('Unused fallback must stay dormant');}});
    const result=await readPresentation(response);
    assert.equal(result.kind,'ready');
    if(result.kind==='ready'){
      assert.equal(result.presentation.kind,'dash');
      assert.ok('fallbackUrl'in result.presentation&&result.presentation.fallbackUrl);
    }
    assert.equal(offers,0);assert.deepEqual(f.requests,[]);
  }finally{revokeSession(f.sessionId);}
});

test('DASH manifest supplies an opaque virtual base and refresh preserves the admitted root query',async()=>{
  const f=fixture();
  try{
    for(let refresh=0;refresh<2;refresh++){
      const response=await streamToken(f.token,null,new AbortController().signal,f.send);
      assert.equal(response.status,200);
      assert.equal(response.headers.get('content-location'),`https://${f.token}.dash.invalid/sport/manifests/main.mpd`);
      assert.match(await response.text(),/^<MPD>/);
    }
    assert.equal(f.requests.length,2);
    assert.ok(f.requests.every(request=>request.url==='https://media.example/sport/manifests/main.mpd?secret=server-only'));
  }finally{revokeSession(f.sessionId);}
});

test('DASH resolved children preserve absolute paths, nested bases, ranges and original referrer',async()=>{
  const f=fixture();
  try{
    await(await streamToken(f.token,null,new AbortController().signal,f.send)).text();f.requests.length=0;
    const response=await streamToken(f.token,'bytes=0-6',new AbortController().signal,f.send,
      {reference:'/sport/tracks/video/segment-00001.m4s?token=segment',kind:'segment'});
    assert.equal(response.status,206);assert.equal(await response.text(),'segment');
    assert.deepEqual(f.requests,[{url:'https://media.example/sport/tracks/video/segment-00001.m4s?token=segment',
      range:'bytes=0-6',referer:'https://player.example/event'}]);
    const absolute=await streamToken(f.token,null,new AbortController().signal,f.send,
      {reference:'https://cdn.example/track/init.mp4',kind:'segment'});
    assert.equal(await absolute.text(),'segment');assert.equal(f.requests[1].url,'https://cdn.example/track/init.mp4');
  }finally{revokeSession(f.sessionId);}
});

test('DASH children require declarations in the current bounded manifest',async()=>{
  const f=fixture();
  try{
    const before=await streamToken(f.token,null,new AbortController().signal,f.send,{reference:'https://cdn.example/track/init.mp4',kind:'segment'});
    assert.equal(before.status,400);assert.deepEqual(f.requests,[]);
    await(await streamToken(f.token,null,new AbortController().signal,f.send)).text();
    for(const reference of ['https://arbitrary.example/unpublished','/sport/tracks/video/segment-word.m4s?token=segment',
      '/sport/tracks/video/segment-00001.m4s?token=changed']){
      assert.equal((await streamToken(f.token,null,new AbortController().signal,f.send,{reference,kind:'segment'})).status,400);
    }
    assert.equal(f.requests.length,1);
  }finally{revokeSession(f.sessionId);}
});

test('cross-origin nested DASH manifests own a distinct virtual base and relative segments',async()=>{
  const f=fixture();
  try{
    await(await streamToken(f.token,null,new AbortController().signal,f.send)).text();
    const response=await streamToken(f.token,null,new AbortController().signal,f.send,
      {reference:'https://cdn.example/alternate/main.mpd',kind:'manifest'});
    assert.equal(response.status,200);await response.text();
    const base=new URL(response.headers.get('content-location')??'');
    const nestedToken=base.hostname.split('.')[0];assert.notEqual(nestedToken,f.token);
    const segment=await streamToken(nestedToken,null,new AbortController().signal,f.send,
      {reference:'/alternate/segment-1.m4s',kind:'segment'});
    assert.equal(await segment.text(),'segment');assert.equal(f.requests.at(-1)?.url,'https://cdn.example/alternate/segment-1.m4s');
  }finally{revokeSession(f.sessionId);}
});

test('DASH reference admission rejects malformed, private and non-DASH capabilities before reading',async()=>{
  const f=fixture();
  try{
    for(const reference of ['', 'x'.repeat(8193), 'https://127.0.0.1/private', 'http://media.example/plain',
      'https://user:password@media.example/segment', 'file:///segment', 'https://media.example/segment#fragment']){
      const response=await streamToken(f.token,null,new AbortController().signal,f.send,{reference,kind:'segment'});
      assert.equal(response.status,400,reference.slice(0,80));await response.body?.cancel();
    }
    const media=resource(new URL('https://media.example/video.mp4'),new URL('https://player.example/event'),'media',async()=>{
      throw new Error('Non-DASH capabilities must reject child reads');
    });
    const token=registerResource(f.grant,media);
    assert.equal((await streamToken(token,null,new AbortController().signal,f.send,{reference:'child',kind:'segment'})).status,400);
    assert.deepEqual(f.requests,[]);
  }finally{revokeSession(f.sessionId);}
});

test('DASH children reauthorize their parent and cannot outlive generation revocation',async()=>{
  const f=fixture();
  try{
    const denied=async():Promise<Reply>=>({kind:'error',status:410,message:'Expired generation'});
    const response=await streamToken(f.token,null,new AbortController().signal,denied,{reference:'child.m4s',kind:'segment'});
    assert.equal(response.status,410);assert.deepEqual(f.requests,[]);
    assert.equal((await streamToken(f.token,null,new AbortController().signal,f.send)).status,404);
  }finally{revokeSession(f.sessionId);}
});
