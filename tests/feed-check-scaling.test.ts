import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-04T17:00:00Z');
const games:Game[]=[
  {id:'10001',league:'nfl',name:'Denver Broncos at San Francisco 49ers',date:new Date(at).toISOString(),
    lifecycle:'live',status:'in',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'San Francisco 49ers',short:'49ers',abbreviation:'SF',color:'112233',score:'0'},
    away:{name:'Denver Broncos',short:'Broncos',abbreviation:'DEN',color:'332211',score:'0'}},
  {id:'10002',league:'nfl',name:'Tennessee Titans at Baltimore Ravens',date:new Date(at).toISOString(),
    lifecycle:'live',status:'in',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Baltimore Ravens',short:'Ravens',abbreviation:'BAL',color:'112233',score:'0'},
    away:{name:'Tennessee Titans',short:'Titans',abbreviation:'TEN',color:'332211',score:'0'}},
];
const playable:CandidateProbeResult={kind:'playable',proof:{kind:'advancing-video',version:1,
  startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};

async function drain() {
  for(let index=0;index<40;index++)await new Promise<void>(resolve=>setImmediate(resolve));
}

function fixture(gameCount:number,concurrency:number,options:{counts?:number[];scheduled?:boolean;games?:Game[]}={}) {
  const directory=mkdtempSync(join(tmpdir(),'feed-check-scaling-'));
  const selectedGames=(options.games??games).slice(0,gameCount).map(game=>options.scheduled?
    {...game,lifecycle:'scheduled' as const,status:'pre',date:new Date(at+2*60*60_000).toISOString()}:game);
  const countByGame=new Map(selectedGames.map((game,index)=>[game.id,options.counts?.[index]??12]));
  const pending=new Map<string,{gameId:string;signal:AbortSignal;finish:(result:CandidateProbeResult)=>void}>();
  const started:string[]=[];
  let peak=0;
  const probeCandidate:FootballDependencies['probeCandidate']=Object.assign((locator,signal,onProgress,target)=>{
    assert.equal(locator.provider,'gooz');
    const key=`${target.gameId}/${target.candidateId}`;
    started.push(key);
    onProgress({kind:'active',since:at});
    return new Promise<CandidateProbeResult>(resolve=>{
      const finish=(result:CandidateProbeResult)=>{
        signal.removeEventListener('abort',onAbort);
        pending.delete(key);
        resolve(result);
      };
      const onAbort=()=>finish({kind:'deferred',retryAfterMs:2000});
      pending.set(key,{gameId:target.gameId,signal,finish});
      signal.addEventListener('abort',onAbort,{once:true});
      peak=Math.max(peak,pending.size);
    });
  },{concurrency});
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,
    schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:selectedGames,league:'nfl',at}),
    readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:selectedGames.map(game=>({
      id:`event-${game.id}`,sourceId:'fixture',url:`https://fixture.example/event/${game.id}`,
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,
      rawTime:'',observedAt:at,parserVersion:2,
    }))}),
    enrichObservation:observation=>observation,
    compatiblePlayers:gameId=>Array.from({length:countByGame.get(gameId)??0},(_,index)=>({
      id:`route-${index}`,label:`Route ${index}`,locator:{provider:'gooz',playerId:`${gameId}${index}`},
    })),
    probeCandidate,
  });
  return {coordinator,pending,started,peak:()=>peak,
    async finishAll() {
      const total=[...countByGame.values()].reduce((sum,count)=>sum+count,0);
      for(let batch=0;started.length<total||pending.size;batch++){
        assert.ok(batch<24,'All backup feeds should finish within 24 batches');
        for(const job of [...pending.values()])job.finish(playable);
        await drain();
      }
    },
    async stop() {
      await coordinator.stop();
      rmSync(directory,{recursive:true,force:true});
    },
  };
}

test('one live game fills every advertised verifier slot and checks all backup feeds',async()=>{
  const run=fixture(1,8);
  try{
    await run.coordinator.refresh();await drain();
    assert.equal(run.pending.size,8);
    await run.finishAll();
    const reply=await run.coordinator.command({kind:'sources'});
    assert.ok(reply.kind==='sources');
    assert.deepEqual(reply.snapshot.games.map(game=>game.workingChoiceCount),[12]);
    assert.equal(new Set(run.started).size,12);
    assert.equal(run.peak(),8);
  }finally{await run.stop();}
});

test('many scheduled games retain one admitted feed each at higher verifier capacity',async()=>{
  const backgroundGames:Game[]=Array.from({length:12},(_,index)=>({...games[0],id:String(2000+index),
    name:`Away ${index} at Home ${index}`,
    home:{...games[0].home,name:`Home ${index}`,abbreviation:`H${index}`},
    away:{...games[0].away,name:`Away ${index}`,abbreviation:`A${index}`},
  }));
  const run=fixture(12,8,{scheduled:true,games:backgroundGames});
  try{
    await run.coordinator.refresh();await drain();
    assert.equal(run.pending.size,8);
    assert.equal(new Set([...run.pending.values()].map(job=>job.gameId)).size,8);
    const queued=await run.coordinator.command({kind:'sources'});
    assert.ok(queued.kind==='sources');
    assert.deepEqual(queued.snapshot.games.map(game=>
      game.candidates.filter(candidate=>candidate.availability.kind==='checking').length),Array(12).fill(1));
    await run.finishAll();
    const reply=await run.coordinator.command({kind:'sources'});
    assert.ok(reply.kind==='sources');
    assert.deepEqual(reply.snapshot.games.map(game=>game.workingChoiceCount),Array(12).fill(12));
    assert.equal(new Set(run.started).size,144);
    assert.equal(run.peak(),8);
  }finally{await run.stop();}
});

test('games with no remaining checks do not keep verifier slots idle for another live game',async()=>{
  const run=fixture(2,8,{counts:[4,12]});
  try{
    await run.coordinator.refresh();await drain();
    for(const job of [...run.pending.values()])if(job.gameId==='10001')job.finish(playable);
    await drain();
    assert.equal(run.pending.size,8);
    assert.ok([...run.pending.values()].every(job=>job.gameId==='10002'&&!job.signal.aborted));
    await run.finishAll();
    const reply=await run.coordinator.command({kind:'sources'});
    assert.ok(reply.kind==='sources');
    assert.deepEqual(reply.snapshot.games.map(game=>game.workingChoiceCount),[4,12]);
    assert.equal(run.peak(),8);
  }finally{await run.stop();}
});

test('scheduled games share otherwise idle verifier slots for their backup feeds',async()=>{
  const run=fixture(2,8,{scheduled:true});
  try{
    await run.coordinator.refresh();await drain();
    assert.equal(run.pending.size,8);
    assert.deepEqual(games.map(game=>[...run.pending.values()].filter(job=>job.gameId===game.id).length),[4,4]);
    await run.finishAll();
    const reply=await run.coordinator.command({kind:'sources'});
    assert.ok(reply.kind==='sources');
    assert.deepEqual(reply.snapshot.games.map(game=>game.workingChoiceCount),[12,12]);
    assert.equal(run.peak(),8);
  }finally{await run.stop();}
});

test('two live games share advertised verifier slots and keep checking after their first playable feed',async()=>{
  const run=fixture(2,8);
  try{
    await run.coordinator.refresh();await drain();
    assert.equal(run.pending.size,8);
    assert.deepEqual(games.map(game=>[...run.pending.values()].filter(job=>job.gameId===game.id).length),[4,4]);
    const jobs=[...run.pending.values()];
    for(const game of games)jobs.find(job=>job.gameId===game.id)?.finish(playable);
    await drain();
    assert.equal(run.pending.size,8);
    assert.ok([...run.pending.values()].every(job=>!job.signal.aborted));
    await run.finishAll();
    const reply=await run.coordinator.command({kind:'sources'});
    assert.ok(reply.kind==='sources');
    assert.deepEqual(reply.snapshot.games.map(game=>game.workingChoiceCount),[12,12]);
    assert.equal(new Set(run.started).size,24);
    assert.equal(run.peak(),8);
  }finally{await run.stop();}
});
