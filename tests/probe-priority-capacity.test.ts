import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game,Observation} from '../lib/football/shared.ts';
import {createProbeResources,probeObserverLease} from '../lib/playback/probe-capacity.ts';

const at=Date.parse('2026-10-08T17:00:00Z');
const makeGame=(index:number,kickoff:number,live=false):Game=>({
  id:String(1000+index),league:'nfl',name:`Away ${index} at Home ${index}`,
  date:new Date(kickoff).toISOString(),status:live?'in':'pre',lifecycle:live?'live':'scheduled',
  detail:live?'Q1':'Scheduled',redzone:false,partitions:['nfl'],
  home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
  away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null},
});

for(const priority of ['requested','near','live'] as const)test(`a late ${priority} first feed crosses real observer waiters`,async()=>{
  let now=at,showTarget=false;
  const background=Array.from({length:12},(_,index)=>makeGame(index,at+6*60*60_000));
  const target=makeGame(99,priority==='near'?at+10*60_000:at+6*60*60_000,priority==='live');
  const games=[...background,target];
  const observations:Observation[]=games.map(game=>({id:`listing-${game.id}`,sourceId:'fixture',
    url:`https://fixture.example/event/${game.id}`,title:game.name,league:'nfl',
    teams:[game.away.name,game.home.name],kickoff:Date.parse(game.date!),rawTime:game.date!,
    observedAt:at,parserVersion:1}));
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const calls:string[]=[];
  const held:Array<{id:string;signal:AbortSignal;release:()=>void}>=[];
  const directory=mkdtempSync(join(tmpdir(),'probe-priority-capacity-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:showTarget?observations:observations.slice(0,-1)}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',
      locator:{provider:'gooz' as const,playerId:gameId}}],
    probeCandidate:(locator,signal,onProgress)=>resources.run(signal,onProgress,async active=>{
      const release=await probeObserverLease(active);
      try{
        assert.equal(locator.provider,'gooz');
        if(locator.provider!=='gooz')throw new Error('Unexpected provider');
        calls.push(locator.playerId);
        if(locator.playerId!==target.id)
          await new Promise<void>(resolve=>held.push({id:locator.playerId,signal:active,release:resolve}));
        return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
      }finally{release();}
    }),
  });
  try{
    await coordinator.refresh(true);
    for(let index=0;held.length<4&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(held.length,4);
    now=at+300_001;
    showTarget=true;
    await coordinator.refresh(true);
    for(let index=0;index<100;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind==='sources'&&reply.snapshot.games.find(game=>game.gameId===target.id)?.candidates.length===1)break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    if(priority==='requested')assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[target.id],retry:false}),{kind:'ok'});
    assert.equal(held.every(job=>!job.signal.aborted),true);
    held[0].release();
    for(let index=0;calls.length<5&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls[4],target.id,JSON.stringify(calls));
    for(let index=0;calls.length<6&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls[5],background[4].id,'a displaced background waiter must resume');
    assert.equal(held.slice(1,4).every(job=>!job.signal.aborted),true);
  }finally{
    for(const job of held)job.release();
    await coordinator.stop();rmSync(directory,{recursive:true,force:true});
  }
});

test('a requested game admits its second sibling after its first entered the observer wait',async()=>{
  const backgrounds=Array.from({length:12},(_,index)=>makeGame(index,at+6*60*60_000));
  const target=makeGame(99,at+6*60*60_000);
  const games=[...backgrounds,target];
  const observations:Observation[]=games.map(game=>({id:`listing-${game.id}`,sourceId:'fixture',
    url:`https://fixture.example/event/${game.id}`,title:game.name,league:'nfl',
    teams:[game.away.name,game.home.name],kickoff:Date.parse(game.date!),rawTime:game.date!,
    observedAt:at,parserVersion:1}));
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const calls:string[]=[];
  const held:Array<{id:string;release:()=>void;signal:AbortSignal}>=[];
  const directory=mkdtempSync(join(tmpdir(),'probe-requested-siblings-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>Array.from({length:gameId===target.id?2:1},(_,index)=>({
      id:`server-${gameId}-${index}`,label:'Server',locator:{provider:'gooz' as const,
        playerId:gameId===target.id?String(Number(gameId)*10+index):gameId}})),
    probeCandidate:(locator,signal,onProgress)=>resources.run(signal,onProgress,async active=>{
      const release=await probeObserverLease(active);
      try{
        assert.equal(locator.provider,'gooz');
        if(locator.provider!=='gooz')throw new Error('Unexpected provider');
        calls.push(locator.playerId);
        if(!locator.playerId.startsWith(target.id))
          await new Promise<void>(resolve=>held.push({id:locator.playerId,release:resolve,signal:active}));
        return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
      }finally{release();}
    }),
  });
  try{
    await coordinator.refresh(true);
    for(let index=0;held.length<4&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(held.length,4);
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[target.id],retry:false}),{kind:'ok'});
    assert.equal(held.every(job=>!job.signal.aborted),true);
    held[0].release();
    for(let index=0;calls.length<5&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.ok(calls[4].startsWith(target.id),JSON.stringify(calls));
    held[1].release();
    for(let index=0;calls.length<6&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(new Set(calls.slice(4,6)),new Set([`${target.id}0`,`${target.id}1`]));
    held[2].release();
    for(let index=0;calls.length<7&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.ok(backgrounds.some(game=>game.id===calls[6]),'displaced background work resumes');
  }finally{
    for(const job of held)job.release();
    await coordinator.stop();rmSync(directory,{recursive:true,force:true});
  }
});

test('manual retry promotes an automatic retry already waiting for an observer',async()=>{
  let now=at,targetAttempts=0;
  const backgrounds=Array.from({length:12},(_,index)=>makeGame(index,at+6*60*60_000));
  const target=makeGame(99,at+6*60*60_000);
  const games=[...backgrounds,target];
  const observations:Observation[]=games.map(game=>({id:`listing-${game.id}`,sourceId:'fixture',
    url:`https://fixture.example/event/${game.id}`,title:game.name,league:'nfl',
    teams:[game.away.name,game.home.name],kickoff:Date.parse(game.date!),rawTime:game.date!,
    observedAt:at,parserVersion:1}));
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const calls:string[]=[];
  const held:Array<{id:string;release:()=>void;signal:AbortSignal}>=[];
  const directory=mkdtempSync(join(tmpdir(),'probe-forced-waiter-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',
      locator:{provider:'gooz' as const,playerId:gameId}}],
    probeCandidate:(locator,signal,onProgress)=>{
      assert.equal(locator.provider,'gooz');
      if(locator.provider!=='gooz')throw new Error('Unexpected provider');
      if(locator.playerId===target.id&&++targetAttempts===1)
        return Promise.resolve({kind:'unavailable' as const,reason:'upstream' as const});
      return resources.run(signal,onProgress,async active=>{
        const release=await probeObserverLease(active);
        try{
          calls.push(locator.playerId);
          if(locator.playerId!==target.id)
            await new Promise<void>(resolve=>held.push({id:locator.playerId,release:resolve,signal:active}));
          return {kind:'playable' as const,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} as const};
        }finally{release();}
      });
    },
  });
  try{
    await coordinator.refresh(true);
    for(let index=0;(targetAttempts<1||held.length<4)&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(targetAttempts,1);
    assert.equal(held.length,4);
    now+=300_000;
    await coordinator.refresh(true);
    for(let index=0;index<100;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(held.length===4&&targetAttempts>=2&&reply.kind==='sources'&&
        reply.snapshot.games.find(game=>game.gameId===target.id)?.candidates[0]?.availability.kind==='checking'&&
        reply.snapshot.games.find(game=>game.gameId===target.id)?.candidates[0]?.availability.progress.kind==='queued')break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.equal(held.length,4);
    assert.equal(targetAttempts,2);
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[target.id],retry:true}),{kind:'ok'});
    assert.equal(held.every(job=>!job.signal.aborted),true);
    held[0].release();
    for(let index=0;calls.length<5&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls[4],target.id,JSON.stringify(calls));
    assert.equal(targetAttempts,3,'the waiting automatic retry was replaced by a forced attempt');
    held[1].release();
    for(let index=0;calls.length<6&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.ok(backgrounds.some(game=>game.id===calls[5]),'displaced background work resumes');
  }finally{
    for(const job of held)job.release();
    await coordinator.stop();rmSync(directory,{recursive:true,force:true});
  }
});
