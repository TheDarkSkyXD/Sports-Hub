import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import type {FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-17T18:00:00Z');
const drain=async()=>{for(let turn=0;turn<60;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'detail-publication-')),path=join(directory,'state.sqlite');
  let clock=at,mode:'resolved'|'failed'|'pending'|'empty'='resolved',playerId='1',candidateId='player-1';
  const probes:string[]=[];
  let release:()=>void=()=>{};
  let game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Home',short:'Home',abbreviation:'H',color:'112233',score:null},away:{name:'Away',short:'Away',abbreviation:'A',color:'332211',score:null}};
  const observation:Observation={id:'listing',sourceId:'fixture',url:'https://fixture.example/game',title:game.name,
    league:'nfl',teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:at,parserVersion:3};
  const options={now:()=>clock,schedules:[{id:'nfl',league:'nfl' as const,path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:[game],league:'nfl' as const,at:clock}),
    readHtml:async(url:string)=>{if(url.endsWith('/list'))return '<main/>';if(mode==='failed')throw new Error('HTTP 502');
      if(mode==='pending')await new Promise<void>(resolve=>{release=resolve;});return '<main/>';},
    parseListings:()=>({outcome:'parsed' as const,observations:[{...observation,observedAt:clock}]}),
    enrichObservation:(value:Observation)=>value,
    compatiblePlayers:()=>mode==='empty'?[]:[{id:candidateId,label:'Player',locator:{provider:'gooz' as const,playerId}}],
    missingPlayerReason:()=> 'no-published-player' as const,
    probeCandidate:async(locator:Parameters<FootballDependencies['probeCandidate']>[0])=>{
      if(locator.provider==='gooz')probes.push(locator.playerId);return {kind:'deferred' as const,retryAfterMs:300_000};}};
  let coordinator=createFootballCoordinator(path,options);
  return {path,game,observation,get coordinator(){return coordinator;},setClock(elapsed:number){clock=at+elapsed;},
    probes,setMode(value:typeof mode){mode=value;},replacePlayer(id:string){playerId=id;candidateId=`player-${id}`;},replaceLocator(id:string){playerId=id;},release(){release();},
    async refresh(){await coordinator.refresh(true);await drain();},
    async choices(){const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');
      if(reply.kind!=='sources')throw new Error('Expected source inventory');const row=reply.snapshot.games.find(row=>row.gameId===game.id);
      return {ids:row?.candidates.map(candidate=>candidate.id).sort()??[],working:row?.workingChoiceCount??0};},
    async restart(){await coordinator.stop();coordinator=createFootballCoordinator(path,options);await drain();},
    async restoreFailed(change:'identity'|'date'|'game'|'final'|'ownerless'|'listing'|'future'){
      await coordinator.stop();
      const store=new FootballStore(path);
      try{
        const saved=store.detailEvidence()[0];assert.equal(saved?.outcome,'resolved');
        if(saved?.outcome!=='resolved')throw new Error('Expected published players');
        const publishedOwner={gameId:game.id,date:game.date??null};
        if(change==='date')game.date=new Date(at+24*60*60_000).toISOString();
        if(change==='game')game.id='200';
        if(change==='final')game={...game,status:'post',lifecycle:'final',finalObservedAt:clock,graceEndsAt:clock+300_000};
        store.savePartition('nfl',{games:[game],at:clock});
        store.observe(change==='identity'?{...observation,title:'Changed listing'}:observation,{kind:'matched',gameId:game.id});
        store.saveDetailEvidence({outcome:'failed',observationId:observation.id,generation:saved.generation,at:clock,
          failure:'upstream-error',failures:1,nextEligibleAt:clock+300_000,lastSuccess:{identity:detailIdentity(observation),at:change==='future'?clock+60_001:at,count:1,
            ...(change==='ownerless'?{}:{publication:{players:saved.players,event:publishedOwner}})}});
      }finally{store.close();}
      coordinator=createFootballCoordinator(path,options);await drain();
    },
    async stop(){release();await coordinator.stop();rmSync(directory,{recursive:true,force:true});}};
}

test('a transient detail error preserves unverified players across restart under a fresh matching listing',async()=>{
  const run=fixture();
  try{
    await run.refresh();assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    run.setMode('failed');run.setClock(31*60_000);await run.refresh();
    assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    await run.restart();assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    run.setClock(59*60_000);await run.refresh();assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    run.setClock(60*60_000);await run.refresh();assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    run.setClock(60*60_000+1);await run.refresh();
    assert.deepEqual(await run.choices(),{ids:[],working:0},'Repeated failed reads must not extend the original success grace');
  }finally{await run.stop();}
});

test('delayed detail refresh keeps prior players until a successful replacement or empty publication',async()=>{
  const run=fixture();
  try{
    await run.refresh();run.setMode('pending');run.setClock(31*60_000);await run.refresh();
    run.setClock(32*60_000);await run.coordinator.command({kind:'set-retention',minutes:60});
    assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    run.replacePlayer('2');run.setMode('resolved');run.release();await drain();
    assert.deepEqual(await run.choices(),{ids:['player-2'],working:0});
    run.setMode('empty');run.setClock(62*60_000);await run.refresh();
    assert.deepEqual(await run.choices(),{ids:[],working:0});
    run.setMode('failed');run.setClock(93*60_000);await run.refresh();
    assert.deepEqual(await run.choices(),{ids:[],working:0},'A later failure must not resurrect an explicitly removed player');
  }finally{await run.stop();}
});

for(const change of ['identity','date','game','final','ownerless','listing','future'] as const)test(`saved retained players reject changed ${change}`,async()=>{
  const run=fixture();
  try{
    await run.refresh();if(change==='listing')run.setClock(32*60_000);await run.restoreFailed(change);
    assert.deepEqual(await run.choices(),{ids:[],working:0});
  }finally{await run.stop();}
});

test('a delayed refresh cannot extend the original unchecked publication beyond sixty minutes',async()=>{
  const run=fixture();
  try{
    await run.refresh();run.setMode('pending');run.setClock(31*60_000);await run.refresh();
    run.setClock(60*60_000);await run.refresh();assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    run.setClock(60*60_000+1);await run.refresh();assert.deepEqual(await run.choices(),{ids:[],working:0});
  }finally{await run.stop();}
});

test('successful detail replaces the locator of an unchecked player with the same ID',async()=>{
  const run=fixture();
  try{
    await run.refresh();assert.ok(run.probes.includes('1'));
    run.replaceLocator('2');run.setClock(31*60_000);await run.refresh();
    assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
    assert.ok(run.probes.includes('2'),'The replacement locator must receive its own first check');
    await run.restart();assert.deepEqual(await run.choices(),{ids:['player-1'],working:0});
  }finally{await run.stop();}
});
