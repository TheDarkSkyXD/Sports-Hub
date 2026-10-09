import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game,Observation} from '../lib/football/shared.ts';
import {createProbeResources,probeObserverLease} from '../lib/playback/probe-capacity.ts';

test('the bounded frontier admits one candidate per background game before siblings',async()=>{
  const at=Date.parse('2026-10-08T17:00:00Z');
  const kickoff=at+6*60*60_000;
  const games:Game[]=Array.from({length:95},(_,index)=>({
    id:String(index+1000),league:'nfl',name:`Away ${index} at Home ${index}`,
    date:new Date(kickoff).toISOString(),status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,
    partitions:['nfl'],home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null},
  }));
  const observations:Observation[]=games.map((game,index)=>({id:`listing-${index}`,sourceId:'fixture',
    url:`https://fixture.example/event/${index}`,title:game.name,league:'nfl',teams:[game.away.name,game.home.name],
    kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:at,parserVersion:1}));
  const directory=mkdtempSync(join(tmpdir(),'probe-frontier-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({observations,outcome:'parsed'}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>Array.from({length:18},(_,index)=>({id:`${gameId}-${index}`,label:`Server ${index}`,
      locator:{provider:'gooz' as const,playerId:`${gameId}${index.toString().padStart(2,'0')}`}})),
    probeCandidate:(_locator,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>
      resolve({kind:'deferred',retryAfterMs:300_000}),{once:true})),
  });
  try{
    await coordinator.refresh(true);
    let snapshot:Awaited<ReturnType<typeof coordinator.command>>|undefined;
    for(let index=0;index<300;index++){
      snapshot=await coordinator.command({kind:'sources'});
      if(snapshot.kind==='sources'&&snapshot.snapshot.games.length===95&&
        snapshot.snapshot.games.every(game=>game.candidates.length===18))break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.equal(snapshot?.kind,'sources');
    if(snapshot?.kind!=='sources')return;
    assert.equal(snapshot.snapshot.games.length,95);
    for(const game of snapshot.snapshot.games){
      assert.equal(game.candidates.length,18,JSON.stringify({id:game.gameId,links:game.sourceLinks,
        source:snapshot.snapshot.sources[0].listingCount}));
      assert.equal(game.candidates.filter(candidate=>candidate.availability.kind==='checking').length,1);
    }
    assert.equal(snapshot.snapshot.games.reduce((count,game)=>count+
      game.candidates.filter(candidate=>candidate.availability.kind==='unknown').length,0),95*17);
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a due playable recheck gets the next game slot ahead of unknown siblings',async()=>{
  const at=Date.parse('2026-10-08T17:00:00Z');
  let now=at;
  const kickoff=at+6*60*60_000;
  const game:Game={id:'5001',league:'nfl',name:'Away at Home',date:new Date(kickoff).toISOString(),
    status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:'Home',short:'Home',abbreviation:'HOM',color:'112233',score:null},
    away:{name:'Away',short:'Away',abbreviation:'AWY',color:'332211',score:null}};
  const observation:Observation={id:'listing',sourceId:'fixture',url:'https://fixture.example/event/5001',
    title:game.name,league:'nfl',teams:['Away','Home'],kickoff,rawTime:new Date(kickoff).toISOString(),
    observedAt:at,parserVersion:1};
  const directory=mkdtempSync(join(tmpdir(),'probe-frontier-recheck-'));
  const calls:string[]=[];
  let releaseSibling:()=>void=()=>{};
  const sibling=new Promise<void>(resolve=>{releaseSibling=resolve;});
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:[game],league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({observations:[observation],outcome:'parsed'}),enrichObservation:value=>value,
    compatiblePlayers:()=>[1,2,3].map(playerId=>({id:`server-${playerId}`,label:`Server ${playerId}`,
      locator:{provider:'gooz' as const,playerId:String(playerId)}})),
    probeCandidate:async locator=>{
      assert.equal(locator.provider,'gooz');
      if(locator.provider!=='gooz')throw new Error('Unexpected provider');
      calls.push(locator.playerId);
      if(locator.playerId==='2')await sibling;
      return locator.playerId==='2'?{kind:'unavailable',reason:'invalid-media'}:{kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
    },
  });
  try{
    await coordinator.refresh(true);
    for(let index=0;calls.length<2&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,['1','2']);
    now=at+300_001;
    await coordinator.refresh(true);
    releaseSibling();
    for(let index=0;calls.length<3&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    const snapshot=await coordinator.command({kind:'sources'});
    assert.deepEqual(calls.slice(0,3),['1','2','1'],JSON.stringify(snapshot));
    for(let index=0;calls.length<4&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls[3],'3');
  }finally{releaseSibling();await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

for(const demanded of [false,true])test(`a due recheck passes ${demanded?'live first-feed':'background'} permit waiters and they resume afterward`,async()=>{
  const at=Date.parse('2026-10-08T17:00:00Z');
  let now=at;
  const kickoff=at+6*60*60_000;
  const games:Game[]=Array.from({length:12},(_,index)=>({id:String(1000+index),league:'nfl',
    name:`Away ${index} at Home ${index}`,date:new Date(kickoff).toISOString(),status:demanded&&index>0?'in':'pre',
    lifecycle:demanded&&index>0?'live':'scheduled',detail:demanded&&index>0?'Q1':'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null}}));
  const observations:Observation[]=games.map((game,index)=>({id:`listing-${index}`,sourceId:'fixture',
    url:`https://fixture.example/event/${index}`,title:game.name,league:'nfl',
    teams:[game.away.name,game.home.name],kickoff,rawTime:new Date(kickoff).toISOString(),
    observedAt:at,parserVersion:1}));
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const calls:string[]=[];
  const pending:Array<{id:string;signal:AbortSignal;release:()=>void}>=[];
  const directory=mkdtempSync(join(tmpdir(),'probe-frontier-priority-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({observations,outcome:'parsed'}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',
      locator:{provider:'gooz' as const,playerId:gameId}}],
    probeCandidate:(locator,signal,onProgress)=>resources.run(signal,onProgress,async active=>{
      const release=await probeObserverLease(active);
      try{
        assert.equal(locator.provider,'gooz');
        if(locator.provider!=='gooz')throw new Error('Unexpected provider');
        calls.push(locator.playerId);
        if(locator.playerId!=='1000')await new Promise<void>(resolve=>pending.push({id:locator.playerId,signal:active,release:resolve}));
        return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
      }finally{release();}
    }),
  });
  try{
    await coordinator.refresh(true);
    for(let index=0;pending.length<4&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(pending.length,4);
    assert.equal(calls.filter(id=>id==='1000').length,1);
    now=at+300_001;
    await coordinator.refresh(true);
    assert.equal(pending.every(job=>!job.signal.aborted),true);
    pending[0].release();
    for(let index=0;calls.filter(id=>id==='1000').length<2&&index<100;index++)
      await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls[5],'1000',JSON.stringify(calls));
    for(let index=0;calls.length<7&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls[6],'1005');
    assert.equal(pending.slice(1,4).every(job=>!job.signal.aborted),true);
  }finally{
    for(const job of pending)job.release();
    await coordinator.stop();rmSync(directory,{recursive:true,force:true});
  }
});

test('a background waiter advances through sustained newly due rechecks',async()=>{
  const at=Date.parse('2026-10-08T17:00:00Z');
  let now=at,showBackground=false,backgroundAttempts=0,backgroundAborts=0;
  const kickoff=at+24*60*60_000;
  const games:Game[]=Array.from({length:11},(_,index)=>({id:String(2000+index),league:'nfl',
    name:`Away ${index} at Home ${index}`,date:new Date(kickoff).toISOString(),status:'pre',
    lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null}}));
  const background=games[10].id;
  const observations=()=>games.slice(0,showBackground?11:10).map((game,index):Observation=>({
    id:`listing-${index}`,sourceId:'fixture',url:`https://fixture.example/event/${index}`,title:game.name,
    league:'nfl',teams:[game.away.name,game.home.name],kickoff,rawTime:new Date(kickoff).toISOString(),
    observedAt:now,parserVersion:1}));
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const calls:string[]=[];
  const held:Array<{id:string;release:()=>void;signal:AbortSignal}>=[];
  const directory=mkdtempSync(join(tmpdir(),'probe-sustained-rechecks-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({observations:observations(),outcome:'parsed'}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',
      locator:{provider:'gooz' as const,playerId:gameId}}],
    probeCandidate:(locator,signal,onProgress)=>{
      assert.equal(locator.provider,'gooz');
      if(locator.provider!=='gooz')throw new Error('Unexpected provider');
      if(now===at)return Promise.resolve({kind:'playable' as const,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} as const});
      if(locator.playerId===background){
        backgroundAttempts++;
        signal.addEventListener('abort',()=>backgroundAborts++,{once:true});
      }
      return resources.run(signal,onProgress,async active=>{
        const release=await probeObserverLease(active);
        try{
          calls.push(locator.playerId);
          if(locator.playerId!==background)
            await new Promise<void>(resolve=>held.push({id:locator.playerId,release:resolve,signal:active}));
          return {kind:'playable' as const,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} as const};
        }finally{release();}
      });
    },
  });
  try{
    await coordinator.refresh(true);
    for(let index=0;index<100;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind==='sources'&&reply.snapshot.games.slice(0,10).every(game=>game.workingChoiceCount===1))break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    now+=300_001;
    showBackground=true;
    await coordinator.refresh(true);
    let backgroundVisible=false;
    for(let index=0;index<100;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind==='sources'&&reply.snapshot.games.find(game=>game.gameId===background)?.candidates.length===1){
        backgroundVisible=true;break;
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.equal(backgroundVisible,true);
    for(let index=0;index<20;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(backgroundAttempts,1);
    for(let index=0;held.length<4&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(held.length,4);
    assert.equal(calls.includes(background),false);
    for(let round=0;round<30&&!calls.includes(background);round++){
      now+=300_001;
      held.shift()?.release();
      for(let index=0;index<20;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.ok(calls.includes(background),JSON.stringify({calls,backgroundAttempts,backgroundAborts}));
    assert.ok(backgroundAttempts>=1);
    assert.ok(backgroundAborts<=1,JSON.stringify({calls,backgroundAttempts,backgroundAborts}));
    assert.ok(held.some(job=>!job.signal.aborted),'physical observer work remains active');
  }finally{
    for(const job of held)job.release();
    await coordinator.stop();rmSync(directory,{recursive:true,force:true});
  }
});
