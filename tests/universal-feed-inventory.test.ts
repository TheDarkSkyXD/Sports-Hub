import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import { feedWindow } from '../lib/football/domain/feed-eligibility.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { SourcesSnapshotSchema, type Candidate, type DetailEvidence, type Game, type Observation } from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T17:00:00Z');
const source={id:'fixture',url:'https://fixture.example/schedule',family:'fixture',leagues:['nfl'] as const};
const game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at+3600_000).toISOString(),
  home:{name:'Home',short:'Home',abbreviation:'HOM',score:null,color:'112233'},
  away:{name:'Away',short:'Away',abbreviation:'AWY',score:null,color:'332211'},
  status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['nfl']};
const observation:Observation={id:'event',sourceId:source.id,url:'https://fixture.example/event',
  league:'nfl',title:'Away vs Home',teams:['Away','Home'],kickoff:at+3600_000,
  rawTime:new Date(at+3600_000).toISOString(),observedAt:at,parserVersion:1};
const generation=JSON.stringify([observation.sourceId,observation.url,observation.teams,observation.kickoff,observation.observedAt,observation.parserVersion]);
const base={at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:true,sources:[source],games:[game],
  observations:[],candidates:new Map<string,Candidate[]>(),attempts:{fixture:{at,outcome:'empty' as const}},
  freshGameIds:new Set(['100']),sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
  streameastCatalog:{current:null,lastComplete:null,previous:null}};

test('inventory retains scheduled events without source links and distinguishes complete empty reads from failed reads',()=>{
  const tomorrow={...game,id:'101',date:'2026-10-09T18:00:00Z'};
  const later={...game,id:'102',date:'2026-10-10T18:00:00Z'};
  const complete=sourceInventory({...base,games:[game,tomorrow,later],freshGameIds:new Set(['100','101'])});
  assert.equal(SourcesSnapshotSchema.safeParse(complete).success,true);
  assert.deepEqual(complete.games.map(row=>({id:row.gameId,league:row.league,feeds:row.feeds.kind})),[
    {id:'100',league:'nfl',feeds:'no-feeds'},{id:'101',league:'nfl',feeds:'no-feeds'}]);
  assert.deepEqual(complete.sources[0].scopes[0],{league:'nfl',read:{kind:'complete',checkedAt:at},eventCount:0,
    feeds:{kind:'incomplete',reason:'listings'}});
  const failed=sourceInventory({...base,attempts:{fixture:{at,outcome:'failed',failure:'blocked'}}});
  assert.deepEqual(failed.sources[0].scopes[0].read,{kind:'incomplete',reason:'failed',checkedAt:at});
  assert.deepEqual(failed.games[0].feeds,{kind:'incomplete',reason:'listings'});
});

test('a recognized empty player differs from an unfinished detail and an unsupported player',()=>{
  const detail:DetailEvidence={outcome:'unresolved',observationId:'event',generation,at,
    reason:'no-published-player',failures:0,nextEligibleAt:at+300_000};
  const input={...base,observations:[observation],attempts:{fixture:{at,outcome:'parsed' as const}}};
  const empty=sourceInventory({...input,details:[detail]});
  assert.deepEqual(empty.games[0].feeds,{kind:'no-feeds',checkedAt:at});
  assert.deepEqual(empty.sources[0].scopes[0].feeds,{kind:'no-feeds',checkedAt:at});
  assert.deepEqual(sourceInventory(input).games[0].feeds,{kind:'incomplete',reason:'details'});
  assert.deepEqual(sourceInventory({...input,details:[{...detail,reason:'unsupported-player'}]}).games[0].feeds,
    {kind:'incomplete',reason:'details'});
});

test('an unresolved source identity cannot establish no feeds for a scheduled event',()=>{
  const unknown={...observation,teams:['Unknown A','Unknown B'] satisfies [string,string]};
  const snapshot=sourceInventory({...base,observations:[unknown],attempts:{fixture:{at,outcome:'parsed'}}});
  assert.deepEqual(snapshot.sources[0].scopes[0].read,{kind:'incomplete',reason:'partial',checkedAt:at});
  assert.deepEqual(snapshot.games[0].feeds,{kind:'incomplete',reason:'listings'});
});

test('feed counts separate discovery, verified media, decoded working playback and pending checks',()=>{
  const choices:Candidate[]=['media','decoded','queued'].map((id,index)=>({id,gameId:'100',label:id,sourceIds:['fixture'],
    observedAt:at,locator:{provider:'gooz',playerId:String(index+1)}}));
  const snapshot=sourceInventory({...base,candidates:new Map([['100',choices]]),availability:candidate=>
    candidate.id==='queued'?{kind:'checking',progress:{kind:'queued',since:at}}:
      {kind:'playable',proof:candidate.id==='decoded'?'decoded':'media',checkedAt:at}});
  assert.deepEqual(snapshot.games[0].feeds,{kind:'feeds',discovered:3,mediaVerified:2,decoded:1,checking:1});
  assert.deepEqual(snapshot.sources[0].scopes[0].feeds,snapshot.games[0].feeds);
});

test('Chicago collection dates follow the calendar across daylight saving transitions',()=>{
  assert.deepEqual(feedWindow(Date.parse('2026-11-01T05:30:00Z')),
    {timeZone:'America/Chicago',days:['2026-11-01','2026-11-02']});
  assert.deepEqual(feedWindow(Date.parse('2026-03-08T07:30:00Z')),
    {timeZone:'America/Chicago',days:['2026-03-08','2026-03-09']});
});

test('source collection starts when every schedule partition fails',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-schedule-failure-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>{throw new Error('offline');},readHtml:async()=>'<main>Recognized empty schedule</main>',
    parseListings:()=>({outcome:'empty',observations:[]})});
  try {
    await coordinator.refresh();
    for(let index=0;index<100;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind!=='sources')assert.fail('expected sources reply');
      if(reply.snapshot.sources[0].lastAttempt){
        assert.equal(reply.snapshot.sources[0].lastAttempt.outcome,'empty');
        assert.deepEqual(reply.snapshot.sources[0].scopes[0].read,{kind:'complete',checkedAt:at});
        assert.deepEqual(reply.snapshot.scheduleScopes[0].read,{kind:'incomplete',reason:'failed',checkedAt:null});
        return;
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.fail('source collection did not finish');
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a listing after the former thousand-row limit still reaches source settings',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-listing-backlog-'));
  const rows=Array.from({length:1001},(_,index)=>({...observation,id:`event-${index}`,url:`https://fixture.example/event/${index}`}));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>({league:'nfl',games:[game],at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:rows}),compatiblePlayers:()=>[],
    missingPlayerReason:()=> 'no-published-player'});
  try {
    await coordinator.refresh();
    for(let index=0;index<150;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind!=='sources')assert.fail('expected sources reply');
      if(reply.snapshot.sources[0].lastAttempt){
        assert.equal(reply.snapshot.sources[0].listingCount,1001);
        assert.equal(reply.snapshot.sources[0].links.find(link=>link.url==='https://fixture.example/event/1000')?.gameId,'100');
        return;
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.fail('listing backlog did not reach inventory');
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('all choices beyond the dispatch queue are checked with bounded concurrency',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-probe-backlog-'));
  let active=0,maximum=0;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>({league:'nfl',games:[game],at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:[observation]}),
    compatiblePlayers:()=>Array.from({length:300},(_,index)=>({id:`choice-${index}`,label:`Server ${index}`,
      locator:{provider:'gooz',playerId:String(index+1)}})),
    probeCandidate:async()=>{active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>setImmediate(resolve));active--;return {kind:'playable',proof:'media'};}});
  try {
    await coordinator.refresh();
    for(let index=0;index<600;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind!=='sources')assert.fail('expected sources reply');
      const row=reply.snapshot.games[0];
      if(row?.feeds.kind==='feeds'&&row.feeds.mediaVerified===300){
        assert.deepEqual(row.feeds,{kind:'feeds',discovered:300,mediaVerified:300,decoded:0,checking:0});
        assert.equal(maximum,4);
        return;
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.fail('remaining choices did not leave the probe backlog');
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
