import assert from 'node:assert/strict';
import test from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {sourceInventory} from '../lib/football/domain/source-inventory.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Candidate,Game,VerificationTarget} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T17:00:00Z');
const playable:CandidateProbeResult={kind:'playable',proof:{kind:'advancing-video',version:1,
  startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
const drain=async()=>{for(let turn=0;turn<80;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};

function fixture(lifecycle:'live'|'scheduled',counts:number[],options:{aliases?:boolean;playableLimits?:number[]}={}){
  let version=0,hold=false;
  const source={id:'fixture',url:'https://fixture.example/list',family:'fixture',leagues:['nfl' as const],parserVersion:3};
  const started:VerificationTarget[]=[];
  const detailReads:string[]=[];
  const pending=new Map<string,(result:CandidateProbeResult)=>void>();
  const games:Game[]=counts.map((_,index)=>({id:String(100+index),league:'nfl',name:`Away ${index} at Home ${index}`,
    date:new Date(at+(lifecycle==='scheduled'?6*60*60_000:0)).toISOString(),status:lifecycle==='live'?'in':'pre',
    lifecycle,detail:'',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null}}));
  const probe:FootballDependencies['probeCandidate']=Object.assign((_locator,signal,onProgress,target)=>{
    started.push(target);onProgress({kind:'active',since:at});
    if(!hold){
      const limit=options.playableLimits?.[games.findIndex(game=>game.id===target.gameId)]??Infinity;
      return Promise.resolve(Number(target.candidateId.slice(5))<limit?playable:{kind:'unavailable',reason:'invalid-media'});
    }
    return new Promise<CandidateProbeResult>(resolve=>{
      const finish=(result:CandidateProbeResult)=>{pending.delete(target.sessionId);signal.removeEventListener('abort',abort);resolve(result);};
      const abort=()=>finish({kind:'deferred',reason:'cancelled',retryAfterMs:2000});
      pending.set(target.sessionId,finish);signal.addEventListener('abort',abort,{once:true});
    });
  },{concurrency:1});
  const coordinator=createFootballCoordinator(':memory:',{
    now:()=>at,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[source],
    readSchedule:async()=>({games,league:'nfl',at}),
    readHtml:async url=>{if(url!==source.url)detailReads.push(url);return '<main/>';},
    parseListings:()=>({outcome:'parsed',observations:games.map(game=>({id:`listing-${game.id}-${version}`,sourceId:'fixture',
      url:`https://fixture.example/${game.id}/${version}`,title:game.name,league:'nfl',teams:[game.away.name,game.home.name],
      kickoff:Date.parse(game.date??''),rawTime:'',observedAt:at,parserVersion:3}))}),
    enrichObservation:observation=>observation,
    compatiblePlayers:gameId=>{
      const count=counts[games.findIndex(game=>game.id===gameId)];
      return Array.from({length:count},(_,index)=>({
        id:`feed-${index}`,label:`Feed ${index}`,locator:{provider:'gooz' as const,
          playerId:options.aliases?String(1000+index):`${gameId}${String(index).padStart(2,'0')}`}}));
    },
    probeIdentity:options.aliases?()=> 'shared-player':undefined,
    probeCandidate:probe,
  });
  return {coordinator,games,started,pending,detailReads,
    async refresh(){await coordinator.refresh(true);await drain();},
    async publish(next:number[]){counts=next;version++;source.parserVersion++;hold=true;await coordinator.refresh(true);await drain();},
    async snapshot(){const reply=await coordinator.command({kind:'sources'});assert.ok(reply.kind==='sources');return reply.snapshot;}};
}

test('public aliases of a verified player count as one working feed',async()=>{
  const run=fixture('live',[10],{aliases:true});
  try{
    await run.refresh();
    const snapshot=await run.snapshot();
    assert.equal(run.started.length,1);
    assert.equal(snapshot.games[0].candidates.length,10,'Public choices retain their source attribution');
    assert.equal(snapshot.games[0].workingChoiceCount,1);
    assert.equal(snapshot.games[0].freeChoiceCount,1);
    assert.equal(snapshot.games[0].uniqueFeedCount,1);
    assert.deepEqual(snapshot.games[0].feeds,{kind:'feeds',discovered:1,mediaVerified:1,decoded:1,checking:0});
    assert.equal(snapshot.sources[0].workingChoiceCount,1);
    assert.equal(snapshot.sources[0].freeChoiceCount,1);
    assert.equal(snapshot.sources[0].compatibleFeedCount,1);
  }finally{await run.coordinator.stop();}
});

test('source league counts keep the same player in different games separate',async()=>{
  const run=fixture('live',[1,1]);
  try{
    const candidates=run.games.map((game):[string,Candidate[]]=>[game.id,[{id:'feed',gameId:game.id,label:'Feed',
      observedAt:at,sourceIds:['fixture'],locator:{provider:'gooz',playerId:'1000'}}]]);
    assert.ok(playable.kind==='playable');
    const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:false,
      sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture',leagues:['nfl']}],
      games:run.games,observations:[],candidates:new Map(candidates),attempts:{},candidateIdentity:()=> 'shared-player',
      availability:()=>({kind:'playable',proof:playable.proof,checkedAt:at}),
      sportsurgeCatalog:{current:null,lastComplete:null,previous:null},streameastCatalog:{current:null,lastComplete:null,previous:null}});
    assert.deepEqual(snapshot.games.map(game=>game.workingChoiceCount),[1,1]);
    assert.equal(snapshot.sources[0].workingChoiceCount,2);
    assert.deepEqual(snapshot.sources[0].scopes[0].feeds,{kind:'feeds',discovered:2,mediaVerified:2,decoded:2,checking:0});
  }finally{await run.coordinator.stop();}
});

for(const lifecycle of ['live','scheduled'] as const)test(`a ${lifecycle} game with nine verified feeds gets discovery before a game with ten`,async()=>{
  const run=fixture(lifecycle,[12,12],{playableLimits:[10,9]});
  try{
    await run.refresh();
    assert.deepEqual((await run.snapshot()).games.map(game=>game.workingChoiceCount),[10,9]);
    const viewing=await run.coordinator.command({kind:'open',gameId:'100',manual:false});
    assert.ok(viewing.kind==='playback');
    run.started.length=0;
    await run.publish([14,14]);
    assert.equal(run.started[0]?.gameId,'101');
    for(let batch=0;run.pending.size;batch++){
      assert.ok(batch<10,'Covered games retain spare discovery turns');
      for(const finish of [...run.pending.values()])finish(playable);
      await drain();
    }
    assert.deepEqual((await run.snapshot()).games.map(game=>game.workingChoiceCount),[12,11]);
    const authorized=await run.coordinator.command({kind:'authorize',sessionId:viewing.playback.session.id,
      candidateId:viewing.playback.session.candidateId,generation:viewing.playback.session.generation});
    assert.ok(authorized.kind==='authorized');
    assert.equal(authorized.session.generation,viewing.playback.session.generation);
  }finally{await run.coordinator.stop();}
});

test('losing verified playback restores discovery priority after the viewer closes',async()=>{
  const run=fixture('live',[12,12],{playableLimits:[10,10]});
  try{
    await run.refresh();
    assert.deepEqual((await run.snapshot()).games.map(game=>game.workingChoiceCount),[10,10]);
    const covered=await run.coordinator.command({kind:'open',gameId:'100',manual:false});
    const lost=await run.coordinator.command({kind:'open',gameId:'101',manual:false});
    assert.ok(covered.kind==='playback'&&lost.kind==='playback');
    const failed=await run.coordinator.command({kind:'session',sessionId:lost.playback.session.id,
      generation:lost.playback.session.generation,failure:true,retry:false});
    assert.ok(failed.kind==='session');
    await run.coordinator.command({kind:'close',sessionId:lost.playback.session.id});
    assert.deepEqual((await run.snapshot()).games.map(game=>game.workingChoiceCount),[10,9]);
    run.started.length=0;
    await run.publish([14,14]);
    assert.equal(run.started[0]?.gameId,'101');
    const authorized=await run.coordinator.command({kind:'authorize',sessionId:covered.playback.session.id,
      candidateId:covered.playback.session.candidateId,generation:covered.playback.session.generation});
    assert.ok(authorized.kind==='authorized');
  }finally{await run.coordinator.stop();}
});

test('detail discovery visits a below-target game before a covered viewer game',async()=>{
  const run=fixture('live',[12,12],{playableLimits:[10,9]});
  try{
    await run.refresh();
    const viewing=await run.coordinator.command({kind:'open',gameId:'100',manual:false});
    assert.ok(viewing.kind==='playback');
    run.detailReads.length=0;
    await run.publish([14,14]);
    assert.equal(run.detailReads[0],'https://fixture.example/101/1');
  }finally{await run.coordinator.stop();}
});
