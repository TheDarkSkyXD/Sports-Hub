import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-11T18:00:00Z');
const proof={kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} satisfies Extract<CandidateProbeResult,{kind:'playable'}>['proof'];
const drain=async()=>{for(let index=0;index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
function fixture(players:number[],probe:FootballDependencies['probeCandidate']){
  let clock=at,ids=players;
  const game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Home',short:'Home',abbreviation:'H',color:'112233',score:null},away:{name:'Away',short:'Away',abbreviation:'A',color:'332211',score:null}};
  const coordinator=createFootballCoordinator(':memory:',{now:()=>clock,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:[game],league:'nfl',at:clock}),readHtml:async()=>'<main/>',
    parseListings:()=>({outcome:'parsed',observations:[{id:'listing',sourceId:'fixture',url:'https://fixture.example/game',title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:clock,parserVersion:3} satisfies Observation]}),
    enrichObservation:value=>value,compatiblePlayers:()=>ids.map(id=>({id:`server-${id}`,label:`Server ${id}`,locator:{provider:'gooz',playerId:String(id)}})),probeCandidate:probe});
  return {coordinator,setClock(elapsed:number){clock=at+elapsed;},replacePlayers(next:number[]){ids=next;},replaceMatchup(){game.home.name='New Home';game.name='Away at New Home';},finish(){game.lifecycle='final';game.status='post';},
    async refresh(){await coordinator.refresh(true);await drain();},async stop(){await coordinator.stop();}};
}

for(const concurrency of [1,2])test(`an incomplete feed retries after a growing first-check backlog finishes with ${concurrency} active checks`,async()=>{
  const calls:string[]=[],held=new Map<string,(value:CandidateProbeResult)=>void>();
  let active=0,peak=0;
  const probe:FootballDependencies['probeCandidate']=async(locator,signal)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);
    peak=Math.max(peak,++active);
    try{
      if(locator.playerId==='1')return calls.filter(id=>id==='1').length===1?
        {kind:'deferred',retryAfterMs:300_000,phase:'replay'}:{kind:'playable',proof};
      return await new Promise(resolve=>{held.set(locator.playerId,resolve);signal.addEventListener('abort',()=>resolve({kind:'deferred',retryAfterMs:300_000}),{once:true});});
    }finally{active--;}
  };
  const run=fixture([1,2,3,4,5,6],Object.assign(probe,{concurrency}));
  try{
    await run.refresh();assert.deepEqual(calls,concurrency===1?['1','2']:['1','2','3']);
    run.setClock(299_999);await run.refresh();assert.equal(calls.filter(id=>id==='1').length,1);
    run.replacePlayers(Array.from({length:40},(_,index)=>index+1));
    run.setClock(30*60_000);await run.refresh();
    for(let turn=0;turn<40&&calls.filter(id=>id==='1').length===1;turn++){
      const next=held.keys().next().value;
      assert.ok(next);
      held.get(next)?.({kind:'unavailable',reason:'invalid-media'});held.delete(next);
      await drain();
    }
    assert.equal(calls.filter(id=>id==='1').length,2,'A due incomplete feed must retry after first checks finish');
    assert.equal(new Set(calls.slice(0,40)).size,40,'Every feed receives one attempt before an automatic retry');
    assert.equal(calls[40],'1');
    const result=await run.coordinator.command({kind:'sources'});assert.equal(result.kind,'sources');
    if(result.kind==='sources'){
      assert.equal(result.snapshot.games[0].candidates.find(candidate=>candidate.id==='server-1')?.availability.kind,'playable');
      assert.equal(result.snapshot.games[0].candidates.filter(candidate=>candidate.availability.kind==='unknown').length,0);
      assert.equal(result.snapshot.games[0].candidates.length,40);
    }
    assert.equal(peak,concurrency);
  }finally{await run.stop();}
});

test('first checks finish before retries under sustained incomplete results',async()=>{
  const calls:string[]=[],held=new Map<string,(value:CandidateProbeResult)=>void>();
  const probe:FootballDependencies['probeCandidate']=async(locator,signal)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);
    return new Promise(resolve=>{held.set(locator.playerId,resolve);signal.addEventListener('abort',()=>resolve({kind:'deferred',retryAfterMs:2000}),{once:true});});
  };
  const run=fixture(Array.from({length:40},(_,index)=>index+1),Object.assign(probe,{concurrency:1}));
  try{
    await run.refresh();
    for(let turn=1;turn<=20;turn++){
      run.setClock(turn*30_000);
      const next=held.keys().next().value;
      assert.ok(next);held.get(next)?.({kind:'deferred',retryAfterMs:2000});held.delete(next);
      await drain();await run.refresh();
    }
    assert.equal(calls.length,21);
    assert.equal(new Set(calls).size,21,'An incomplete feed cannot repeat while untouched feeds remain');
    for(let turn=21;turn<=40;turn++){
      run.setClock(turn*30_000);
      const next=held.keys().next().value;
      assert.ok(next);held.get(next)?.({kind:'deferred',retryAfterMs:2000});held.delete(next);
      await drain();await run.refresh();
    }
    assert.equal(new Set(calls.slice(0,40)).size,40);
    assert.equal(calls[40],'1','The earliest incomplete check retries when the first pass finishes');
  }finally{await run.stop();}
});

test('a full queue completes every game first check before an incomplete retry',async()=>{
  let clock=at;
  const games:Game[]=Array.from({length:275},(_,index)=>({id:String(1000+index),league:'nfl',
    name:`Away ${index} at Home ${index}`,date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null}}));
  const calls:string[]=[],held=new Map<string,(value:CandidateProbeResult)=>void>();
  const probe:FootballDependencies['probeCandidate']=async(locator,signal,onProgress)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);onProgress({kind:'active'});
    if(locator.playerId==='1000')return calls.filter(id=>id==='1000').length===1?
      {kind:'deferred',retryAfterMs:30_000}:{kind:'playable',proof};
    return new Promise(resolve=>{held.set(locator.playerId,resolve);signal.addEventListener('abort',()=>resolve({kind:'deferred',retryAfterMs:30_000}),{once:true});});
  };
  const coordinator=createFootballCoordinator(':memory:',{now:()=>clock,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:clock}),readHtml:async()=>'<main/>',
    parseListings:()=>({outcome:'parsed',observations:games.map(game=>({id:`listing-${game.id}`,sourceId:'fixture',url:`https://fixture.example/game/${game.id}`,
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:clock,parserVersion:3}))}),
    enrichObservation:value=>value,compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',locator:{provider:'gooz',playerId:gameId}}],
    probeCandidate:Object.assign(probe,{concurrency:1})});
  try{
    await coordinator.refresh(true);
    for(let turn=0;turn<10;turn++){
      await drain();
      const published=await coordinator.command({kind:'sources'});
      if(published.kind==='sources'&&published.snapshot.checks.queued===256)break;
      await coordinator.refresh(true);
    }
    const before=await coordinator.command({kind:'sources'});assert.equal(before.kind,'sources');
    if(before.kind==='sources')assert.equal(before.snapshot.checks.queued,256);
    clock=at+30_000;await coordinator.refresh(true);await drain();
    for(let turn=0;turn<4&&calls.filter(id=>id==='1000').length===1;turn++){
      const next=held.keys().next().value;assert.ok(next);
      held.get(next)?.({kind:'unavailable',reason:'invalid-media'});held.delete(next);await drain();
    }
    assert.equal(calls.filter(id=>id==='1000').length,1,'The full first-check queue stays ahead of automatic retries');
    for(let turn=0;turn<275&&calls.filter(id=>id==='1000').length===1;turn++){
      const next=held.keys().next().value;assert.ok(next);
      held.get(next)?.({kind:'unavailable',reason:'invalid-media'});held.delete(next);await drain();
    }
    assert.equal(new Set(calls.slice(0,275)).size,275);
    assert.equal(calls[275],'1000');
    assert.equal(calls.filter(id=>id==='1000').length,2);
    const after=await coordinator.command({kind:'sources'});assert.equal(after.kind,'sources');
    if(after.kind==='sources'){
      assert.ok(after.snapshot.checks.queued<=256);
      assert.equal(after.snapshot.games.find(game=>game.gameId==='1000')?.workingChoiceCount,1);
      assert.equal(after.snapshot.games.flatMap(game=>game.candidates).filter(candidate=>candidate.availability.kind==='unknown').length,0);
    }
  }finally{await coordinator.stop();}
});

test('explicit retry can revisit an incomplete feed ahead of untouched siblings',async()=>{
  const calls:string[]=[],held=new Map<string,(value:CandidateProbeResult)=>void>();
  const run=fixture([1,2,3,4],async(locator,signal)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);
    if(locator.playerId==='1')return calls.filter(id=>id==='1').length===1?{kind:'deferred',retryAfterMs:300_000,phase:'capture'}:{kind:'playable',proof};
    return new Promise(resolve=>{held.set(locator.playerId,resolve);signal.addEventListener('abort',()=>resolve({kind:'deferred',retryAfterMs:300_000}),{once:true});});
  });
  try{
    await run.refresh();assert.deepEqual(calls,['1','2','3']);
    run.setClock(1000);await run.coordinator.command({kind:'check-sources',gameIds:['100'],retry:true});
    held.get('2')?.({kind:'unavailable',reason:'invalid-media'});await drain();assert.equal(calls[3],'1');
    const result=await run.coordinator.command({kind:'sources'});assert.equal(result.kind,'sources');
    if(result.kind==='sources')assert.equal(result.snapshot.games[0].candidates.find(candidate=>candidate.id==='server-1')?.availability.kind,'playable');
  }finally{await run.stop();}
});

test('ready incomplete retries use available slots after every feed has had its first check',async()=>{
  const calls:string[]=[],counts=new Map<string,number>();
  const run=fixture([1,2],async locator=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);const count=(counts.get(locator.playerId)??0)+1;counts.set(locator.playerId,count);
    return count===1?{kind:'deferred',retryAfterMs:300_000,phase:'capture'}:{kind:'playable',proof};
  });
  try{
    await run.refresh();run.setClock(299_999);await run.refresh();assert.deepEqual(calls,['1','2']);
    run.setClock(300_000);await run.refresh();assert.deepEqual(calls,['1','2','1','2']);
    const result=await run.coordinator.command({kind:'sources'});assert.equal(result.kind,'sources');
    if(result.kind==='sources')assert.equal(result.snapshot.games[0].workingChoiceCount,2);
  }finally{await run.stop();}
});

test('an incomplete healthy-feed recheck retains its maintenance priority after thirty minutes',async()=>{
  let calls=0;
  const run=fixture([1],async()=>++calls===2?{kind:'deferred',retryAfterMs:60_000}:{kind:'playable',proof});
  try{
    await run.refresh();run.setClock(1_799_999);await run.refresh();assert.equal(calls,1);
    run.setClock(1_800_000);await run.refresh();assert.equal(calls,2);
    run.setClock(1_859_999);await run.refresh();assert.equal(calls,2);
    run.setClock(1_860_000);await run.refresh();assert.equal(calls,3);
    const result=await run.coordinator.command({kind:'sources'});assert.equal(result.kind,'sources');
    if(result.kind==='sources')assert.equal(result.snapshot.games[0].workingChoiceCount,1);
  }finally{await run.stop();}
});

test('capacity rejection stays a first check and can obtain its slot while another first check runs',async()=>{
  const calls:string[]=[];let release:(value:CandidateProbeResult)=>void=()=>{};
  const run=fixture([1,2],async(locator,signal)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);
    if(locator.playerId==='1')return calls.filter(id=>id==='1').length===1?{kind:'deferred',reason:'capacity',retryAfterMs:2000}:{kind:'playable',proof};
    return new Promise(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve({kind:'deferred',retryAfterMs:300_000}),{once:true});});
  });
  try{
    await run.refresh();run.setClock(1999);await run.refresh();assert.deepEqual(calls,['1','2']);
    run.setClock(2000);await run.refresh();assert.deepEqual(calls,['1','2','1']);
    const result=await run.coordinator.command({kind:'sources'});assert.equal(result.kind,'sources');
    if(result.kind==='sources')assert.equal(result.snapshot.games[0].workingChoiceCount,1);
  }finally{release({kind:'unavailable',reason:'invalid-media'});await run.stop();}
});

test('removed incomplete identities do not block newly published players and final games cancel their checks',async()=>{
  const calls:string[]=[],aborted:string[]=[];
  const run=fixture([1],async(locator,signal)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);
    if(locator.playerId==='1')return {kind:'deferred',retryAfterMs:3600_000,phase:'capture'};
    return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.push(locator.playerId);resolve({kind:'deferred',retryAfterMs:300_000});},{once:true}));
  });
  try{
    await run.refresh();run.replacePlayers([9]);run.setClock(30*60_000);await run.refresh();assert.deepEqual(calls,['1','1','9']);
    const published=await run.coordinator.command({kind:'sources'});assert.equal(published.kind,'sources');
    if(published.kind==='sources')assert.deepEqual(published.snapshot.games[0].candidates.map(candidate=>candidate.id),['server-9']);
    run.finish();run.setClock(30*60_000+1000);await run.refresh();assert.deepEqual(aborted,['9']);
    run.setClock(60*60_000);await run.refresh();assert.deepEqual(calls,['1','1','9']);
  }finally{await run.stop();}
});

test('a reused game ID and physical player receive a first check for their new matchup',async()=>{
  const calls:string[]=[];
  const run=fixture([1],async locator=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Expected player');
    calls.push(locator.playerId);
    return calls.length===1?{kind:'deferred',retryAfterMs:3600_000,phase:'capture'}:{kind:'playable',proof};
  });
  try{
    await run.refresh();run.replaceMatchup();run.setClock(30*60_000);await run.refresh();assert.deepEqual(calls,['1','1']);
    const result=await run.coordinator.command({kind:'sources'});assert.equal(result.kind,'sources');
    if(result.kind==='sources')assert.equal(result.snapshot.games[0].workingChoiceCount,1);
  }finally{await run.stop();}
});
