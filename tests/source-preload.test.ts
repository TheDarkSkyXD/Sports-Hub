import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Candidate, Game, Observation } from '../lib/football/shared.ts';

const at=Date.parse('2026-10-02T18:00:00Z');
const game=(index:number):Game=>({
  id:String(100000+index),league:'nfl',name:`Away ${index} at Home ${index}`,date:new Date(at).toISOString(),
  home:{id:`home-${index}`,name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
  away:{id:`away-${index}`,name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null},
  status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
});
const observation=(match:Game,index:number):Observation=>({
  id:`listing-${index}`,sourceId:'fixture',url:`https://fixture.example/game/${index}`,title:match.name,
  league:'nfl',teams:[match.away.name,match.home.name],kickoff:at,rawTime:'',observedAt:at,parserVersion:1,
});
const candidates=(gameId:string,index:number,count:number):Candidate[]=>Array.from({length:count},(_,server)=>({
  id:`candidate-${index}-${server}`,gameId,label:`Server ${server}`,sourceIds:['fixture'],observedAt:at,
  locator:{provider:'gooz',playerId:String(index*count+server+1)},
}));
async function waitFor(predicate:()=>Promise<boolean>,message:()=>string):Promise<void> {
  for(let attempt=0;attempt<300;attempt++) {
    if(await predicate())return;
    await new Promise<void>(resolve=>setTimeout(resolve,10));
  }
  assert.fail(message());
}

test('all fresh games and alternatives warm without check-sources, even beyond queue capacity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-preload-'));
  const games=Array.from({length:20},(_,index)=>game(index));
  let active=0;
  let peak=0;
  const probed:string[]=[];
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async(source,time)=>({games:source.id==='nfl'?games:[],at:time,league:source.league}),
    readHtml:async()=>'<div>fixture</div>',
    parseListings:()=>({outcome:'parsed',observations:games.map(observation)}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId,value)=>candidates(gameId,Number(value.id.slice('listing-'.length)),15),
    probeCandidate:async locator=>{
      assert.equal(locator.provider,'gooz');
      active++;
      peak=Math.max(peak,active);
      probed.push(locator.playerId);
      await new Promise<void>(resolve=>setImmediate(resolve));
      active--;
      return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
    },
  });
  try {
    await coordinator.refresh(true);
    let lastCounts='';
    await waitFor(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      const board=await coordinator.command({kind:'board'});
      if(reply.kind==='sources')lastCounts=`${board.kind==='board'?board.board.games.length:-1} board games, ${board.kind==='board'?JSON.stringify(board.board.leagues.nfl.errors):''}, ${reply.snapshot.games.length} source games, ${reply.snapshot.games.reduce((total,row)=>total+row.candidates.length,0)} candidates, ${probed.length} probes`;
      return reply.kind==='sources'&&reply.snapshot.games.reduce((total,row)=>total+row.candidates.filter(candidate=>candidate.availability.kind==='playable').length,0)===300;
    },()=>`all 300 candidates should become playable, observed ${lastCounts}`);
    assert.equal(probed.length,300);
    assert.equal(new Set(probed).size,300);
    assert.equal(peak,2,'native checks share two physical slots');
    const firstGameFeeds=new Set(games.map((_,index)=>String(index*15+1)));
    assert.equal(probed.slice(0,30).filter(id=>firstGameFeeds.has(id)).length,20,
      'all 20 live games should get a first feed turn within 30 admissions');
    assert.equal(probed.slice(0,30).some(id=>!firstGameFeeds.has(id)),true,
      'background alternatives should retain a share of probe turns');
    const opened=await coordinator.command({kind:'open',gameId:games[19].id,manual:false,requestId:'11111111-1111-4111-8111-111111111111'});
    assert.equal(opened.kind,'playback');
    if(opened.kind==='playback')assert.equal(opened.playback.candidates.filter(candidate=>candidate.availability.kind==='playable').length,15);
  } finally {
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('explicit retry reaches an unavailable server after admitted siblings release a game slot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-retry-'));
  const match=game(0);
  let listed:Game=match;
  const calls:string[]=[];
  const pending:{resolve:()=>void}[]=[];
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async(source,time)=>({games:source.id==='nfl'?[listed]:[],at:time,league:source.league}),
    readHtml:async()=>'<div>fixture</div>',
    parseListings:()=>({outcome:'parsed',observations:[observation(match,0)]}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId)=>candidates(gameId,0,270),
    probeCandidate:async(locator,signal)=>{
      assert.equal(locator.provider,'gooz');
      calls.push(locator.playerId);
      if(locator.playerId==='1'&&calls.filter(id=>id==='1').length===1)return {kind:'unavailable',reason:'upstream'};
      await new Promise<void>(resolve=>{
        const settle=()=>resolve();
        pending.push({resolve:settle});
        signal.addEventListener('abort',settle,{once:true});
      });
      return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
    },
  });
  try {
    await coordinator.refresh(true);
    let state='';
    await waitFor(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind==='sources')state=`${reply.snapshot.games[0]?.candidates.length} candidates, ${reply.snapshot.games[0]?.candidates.filter(candidate=>candidate.availability.kind==='checking').length} checking, ${reply.snapshot.games[0]?.candidates.find(candidate=>candidate.id==='candidate-0-0')?.availability.kind} first`;
      return reply.kind==='sources'&&reply.snapshot.games[0]?.candidates.find(candidate=>candidate.id==='candidate-0-0')?.availability.kind==='unavailable'&&
        reply.snapshot.games[0].candidates.filter(candidate=>candidate.availability.kind==='checking').length===2;
    },()=>`game frontier did not fill after the first failure, ${state}, calls ${calls.length}`);
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[match.id],retry:true}),{kind:'ok'});
    const queued=await coordinator.command({kind:'sources'});
    assert.equal(queued.kind,'sources');
    if(queued.kind==='sources')assert.equal(queued.snapshot.games[0].candidates.find(candidate=>candidate.id==='candidate-0-0')?.availability.kind,'unavailable');
    pending.shift()?.resolve();
    await waitFor(async()=>calls.filter(id=>id==='1').length===2,()=>`retry did not start, calls ${calls.slice(0,8).join(',')}`);
    assert.equal(calls[3],'1');
    listed={...match,status:'post',lifecycle:'final',detail:'Final',finalObservedAt:at,graceEndsAt:at+300000};
    await coordinator.refresh(true);
    const finalSnapshot=await coordinator.command({kind:'sources'});
    assert.equal(finalSnapshot.kind,'sources');
    if(finalSnapshot.kind==='sources') {
      assert.equal(finalSnapshot.snapshot.games.reduce((total,row)=>total+row.candidates.length,0),1);
      assert.equal(finalSnapshot.snapshot.games[0].candidates[0].availability.kind,'playable');
    }
    const before=calls.length;
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls.length,before);
  } finally {
    for(const job of pending)job.resolve();
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
