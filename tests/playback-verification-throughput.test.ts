import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock,test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Game,Observation} from '../lib/football/shared.ts';
import {configuredProbeCandidate} from '../lib/playback/probe.ts';

const at=Date.parse('2026-10-11T18:00:00Z');
const proof={kind:'advancing-video' as const,version:1 as const,startupMs:3000,
  observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4};
const drain=async()=>{for(let index=0;index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));};

function fixture(count:number,probeCandidate:FootballDependencies['probeCandidate']){
  let now=at;
  const games:Game[]=Array.from({length:count},(_,index)=>({id:String(100+index),league:'nfl',
    name:`Away ${index} at Home ${index}`,date:new Date(at).toISOString(),status:'in',lifecycle:'live',
    detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:'0'},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:'0'}}));
  const observations:Observation[]=games.map(game=>({id:`listing-${game.id}`,sourceId:'fixture',
    url:`https://fixture.example/${game.id}`,title:game.name,league:'nfl',
    teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:at,parserVersion:3}));
  const directory=mkdtempSync(join(tmpdir(),'verification-throughput-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',locator:{provider:'gooz',playerId:gameId}}],
    probeCandidate,
  });
  return {coordinator,advance(ms:number){now+=ms;},async stop(){await coordinator.stop();rmSync(directory,{recursive:true,force:true});}};
}

test('the configured playback checks start before a slow check releases its slot',async()=>{
  const started:string[]=[];
  let running=0,peak=0;
  const releases:Array<()=>void>=[];
  const probe=Object.assign(async(locator:Parameters<FootballDependencies['probeCandidate']>[0])=>{
    assert.equal(locator.provider,'gooz');
    if(locator.provider!=='gooz')throw new Error('Expected fixture player');
    started.push(locator.playerId);peak=Math.max(peak,++running);
    await new Promise<void>(resolve=>releases.push(resolve));
    running--;
    return {kind:'playable' as const,proof};
  },{concurrency:configuredProbeCandidate.concurrency});
  const capacity=configuredProbeCandidate.concurrency;
  const run=fixture(capacity+8,probe);
  try{
    await run.coordinator.refresh(true);await drain();
    assert.equal(started.length,capacity);
    assert.equal(running,capacity);
    releases[0]();await drain();
    assert.equal(started.length,capacity+1);
    assert.equal(running,capacity);
    assert.equal(peak,capacity);
  }finally{for(const release of releases)release();await run.stop();}
});

test('a local capacity wait retries after two seconds instead of waiting five minutes',async()=>{
  let calls=0;
  mock.timers.enable({apis:['setTimeout']});
  const run=fixture(1,async()=>++calls===1
    ? {kind:'deferred',reason:'capacity',retryAfterMs:2000}
    : {kind:'playable',proof});
  try{
    await run.coordinator.refresh(true);await drain();
    assert.equal(calls,1);
    run.advance(1999);mock.timers.tick(1999);await drain();
    assert.equal(calls,1);
    run.advance(1);mock.timers.tick(1);await drain();
    assert.equal(calls,2);
    const reply=await run.coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.games[0].candidates[0].availability.kind,'playable');
  }finally{await run.stop();mock.timers.reset();}
});
