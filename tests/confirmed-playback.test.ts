import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {streamIndex,streamToken,revokeVerificationTarget} from '../lib/stream-server.ts';
import type {ProviderResource} from '../lib/playback/provider.ts';
import type {AdvancingVideo, VerificationTarget} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-04T17:00:00Z');
const proof:AdvancingVideo={kind:'advancing-video',version:1,startupMs:3000,
  observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4};
const drain=async()=>{for(let i=0;i<80;i++)await new Promise(setImmediate);};

function fixture(aliases=false){
  let now=at,replaced=false,visible=true,hold=aliases,calls=0;
  const pending:Array<{target:VerificationTarget;resolve:(value:{kind:'deferred';retryAfterMs:number})=>void}>=[];
  const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const game={id:'910002',league:'nfl' as const,name:'Away at Home',date:new Date(at).toISOString(),
    lifecycle:'live' as const,status:'in',detail:'Q1',redzone:false,partitions:['nfl'],
    home:team('Home'),away:team('Away')};
  const directory=mkdtempSync(join(tmpdir(),'confirmed-playback-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:[game],league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:visible?'parsed' as const:'empty' as const,
      observations:visible?[{id:'event',sourceId:'fixture',url:'https://fixture.example/game',
        title:game.name,league:'nfl' as const,teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:now,parserVersion:3}]:[]}),
    enrichObservation:value=>value,
    compatiblePlayers:()=>[{id:'one',label:'One',locator:{provider:'gooz' as const,playerId:replaced?'2':'1'}},
      ...(aliases?[{id:'two',label:'Two',locator:{provider:'gooz' as const,playerId:'1'}}]:[])],
    probeCandidate:async(_locator,signal,_progress,target)=>{
      calls++;
      if(!hold)return {kind:'playable' as const,proof};
      return new Promise(resolve=>{
        pending.push({target,resolve});
        signal.addEventListener('abort',()=>resolve({kind:'deferred',retryAfterMs:300000}),{once:true});
      });
    },
  });
  return {coordinator,game,pending,directory,get calls(){return calls;},
    setTime(value:number){now=at+value;},replace(){replaced=true;},hide(){visible=false;},hold(){hold=true;},
    async refresh(value:number){now=at+value;await coordinator.refresh(true);await drain();},
    async snapshot(){const reply=await coordinator.command({kind:'sources'});return reply.kind==='sources'?reply.snapshot:null;},
    async stop(){for(const item of pending)item.resolve({kind:'deferred',retryAfterMs:300000});
      await coordinator.stop();rmSync(directory,{recursive:true,force:true});},
  };
}

test('Available expires at the proof deadline even inside the inventory cache window',async()=>{
  const value=fixture();
  try{
    await value.refresh(0);
    await value.refresh(298000);
    value.setTime(299999);
    const before=await value.snapshot();
    value.setTime(300001);
    const after=await value.snapshot();
    assert.equal(before?.games[0].candidates[0].availability.kind,'playable');
    assert.deepEqual(after?.games[0].candidates[0].availability,
      {kind:'checking',progress:{kind:'queued',since:at+300000}});
    assert.notEqual(before,after);
    const opened=await value.coordinator.command({kind:'open',gameId:value.game.id,manual:false});
    assert.equal(opened.kind,'error');
  }finally{await value.stop();}
});

test('an aged route remains eligible for re-verification after its proof expires',async()=>{
  const value=fixture();
  try{
    await value.refresh(0);
    await value.refresh(298000);
    value.hide();value.hold();
    await value.refresh(31*60000);
    const snapshot=await value.snapshot();
    assert.equal(value.calls,2);
    assert.equal(snapshot?.games[0].candidates[0].availability.kind,'checking');
  }finally{await value.stop();}
});

test('a private trial cannot authorize a new locator that reused its candidate ID',async()=>{
  const value=fixture(true);
  try{
    await value.coordinator.command({kind:'set-feed-check-interval',minutes:1});
    await value.refresh(0);
    const first=value.pending[0];
    assert.ok(first);
    value.replace();
    await value.refresh(60001);
    const reply=await value.coordinator.command({kind:'authorize',sessionId:first.target.sessionId,
      candidateId:first.target.candidateId,generation:0});
    assert.equal(reply.kind,'error');
    if(reply.kind==='error')assert.equal(reply.status,410);
  }finally{await value.stop();}
});

test('a private trial opens playlist and media through the relay, then revokes both',async()=>{
  const value=fixture(true);
  try{
    await value.refresh(0);
    const target=value.pending[0]?.target;
    assert.ok(target);
    const bytes=(text:string)=>new ReadableStream<Uint8Array>({start(controller){
      controller.enqueue(new TextEncoder().encode(text));controller.close();
    }});
    const media:ProviderResource={kind:'media',identity:'segment',
      read:async()=>({status:200,body:bytes('decoded segment'),contentType:'video/mp2t'}),resolve:()=>null};
    const root:ProviderResource={kind:'playlist',identity:'root',
      read:async()=>({status:200,body:bytes('#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST'),
        contentType:'application/vnd.apple.mpegurl'}),
      resolve:(reference,expected)=>reference==='segment.ts'&&expected==='media'?media:null};
    const send=(command:Parameters<typeof value.coordinator.command>[0])=>value.coordinator.command(command);
    const opener=async()=>({root,close(){}});
    const index=await streamIndex(target.gameId,target.sessionId,target.candidateId,'0',
      new AbortController().signal,send,opener);
    assert.equal(index.status,200);
    const playlist=await index.text();
    const token=/\/api\/stream\/media\/([\w-]+)/.exec(playlist)?.[1];
    assert.ok(token);
    const segment=await streamToken(token,null,new AbortController().signal,send);
    assert.equal(segment.status,200);
    assert.equal(await segment.text(),'decoded segment');
    revokeVerificationTarget(target.sessionId,target.generation);
    assert.equal((await streamToken(token,null,new AbortController().signal,send)).status,404);
  }finally{await value.stop();}
});
