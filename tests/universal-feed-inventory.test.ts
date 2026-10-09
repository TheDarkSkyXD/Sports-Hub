import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import { feedWindow } from '../lib/football/domain/feed-eligibility.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import {createProbeResources,probeHttpResponse} from '../lib/playback/probe-capacity.ts';
import { GameSchema, LeagueSchema, SourcesSnapshotSchema, SportsurgeCatalogSchema, StreameastCatalogSchema, isMotorsportsLeague, isRaceGame, type Candidate, type DetailEvidence, type Game, type Observation } from '../lib/football/shared.ts';

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

test('paid, unclassified and legacy StreamEast details cannot claim no published feeds',()=>{
  const event={id:'nfl:100',url:'https://v2.streameast.ga/nfl/away-vs-home/',league:'nfl',title:'Away vs Home',
    teams:['Away','Home'],kickoff:at+3600_000,espnEventId:null};
  for(const [publication,reason] of [
    [{premium:0,unknown:0},'no-published-player'],[{premium:1,unknown:0},'paid-only'],
    [{premium:0,unknown:1},'parser-changed'],[undefined,'parser-changed'],
  ] as const) {
    const catalog=StreameastCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,
      startedAt:at,state:{kind:'collecting'},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'pending'}},
      events:[{...event,detail:{kind:'collected',at,servers:[],...(publication?{publication}:{})}}],rejectedGames:[]});
    const snapshot=sourceInventory({...base,sources:[{id:'streameast',url:'https://v2.streameast.ga/nfl-streams/',
      family:'streameast',kind:'browser-catalog',leagues:['nfl']}],streameastCatalog:{current:{catalog,receivedAt:at},lastComplete:null,previous:null}});
    assert.deepEqual(snapshot.sources[0].links[0].evidence,{kind:'missing',checkedAt:at,reason,retryAt:null});
    assert.equal(snapshot.sources[0].scopes[0].feeds.kind,publication&&reason==='no-published-player'?'no-feeds':'incomplete');
  }
  const unresolved=StreameastCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,
    startedAt:at,state:{kind:'collecting'},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'pending'}},
    events:[{...event,detail:{kind:'collected',at,publication:{premium:0,unknown:0},servers:[{
      id:'1',label:'Free server',url:`${event.url}1`,availability:{kind:'free-unresolved'}}]}}],rejectedGames:[]});
  const snapshot=sourceInventory({...base,sources:[{id:'streameast',url:'https://v2.streameast.ga/nfl-streams/',
    family:'streameast',kind:'browser-catalog',leagues:['nfl']}],streameastCatalog:{current:{catalog:unresolved,receivedAt:at},lastComplete:null,previous:null}});
  assert.equal(snapshot.sources[0].scopes[0].feeds.kind,'incomplete');
  assert.deepEqual(snapshot.sources[0].links[0].evidence,{kind:'missing',checkedAt:at,reason:'no-compatible-media',retryAt:null});
});

test('duplicate provider event identities prevent a complete empty scope',()=>{
  const catalog=SportsurgeCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,
    startedAt:at,state:{kind:'collecting'},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'pending'}},
    events:[],rejectedGames:[],catalogIssues:[{league:'nfl',title:'Away vs Home',reason:'duplicate-game-id'}]});
  const snapshot=sourceInventory({...base,sources:[{id:'sportsurge-v2',url:'https://sportsurge.ws/watch-nfl-streams/',
    family:'sportsurge',kind:'browser-catalog',leagues:['nfl']}],sportsurgeCatalog:{current:{catalog,receivedAt:at},lastComplete:null,previous:null}});
  assert.deepEqual(snapshot.sources[0].scopes[0].read,{kind:'incomplete',reason:'partial',checkedAt:at});
  assert.deepEqual(snapshot.games[0].feeds,{kind:'incomplete',reason:'listings'});
});

test('feed counts separate discovered, advancing, and pending choices',()=>{
  const choices:Candidate[]=['advance-one','advance-two','queued'].map((id,index)=>({id,gameId:'100',label:id,sourceIds:['fixture'],
    observedAt:at,locator:{provider:'gooz',playerId:String(index+1)}}));
  const snapshot=sourceInventory({...base,candidates:new Map([['100',choices]]),availability:candidate=>
    candidate.id==='queued'?{kind:'checking',progress:{kind:'queued',since:at}}:
      {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,
        observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}});
  assert.deepEqual(snapshot.games[0].feeds,{kind:'feeds',discovered:3,mediaVerified:2,decoded:2,checking:1});
  assert.deepEqual(snapshot.sources[0].scopes[0].feeds,snapshot.games[0].feeds);
});

test('Chicago collection dates follow the calendar across daylight saving transitions',()=>{
  assert.deepEqual(feedWindow(Date.parse('2026-11-01T05:30:00Z')),
    {timeZone:'America/Chicago',days:['2026-11-01','2026-11-02']});
  assert.deepEqual(feedWindow(Date.parse('2026-03-08T07:30:00Z')),
    {timeZone:'America/Chicago',days:['2026-03-08','2026-03-09']});
});

test('a known event with unknown status remains visible without authorizing its feeds',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-unknown-event-'));
  const event=GameSchema.parse({id:'motogp-10001',league:'motogp',name:'Fixture Grand Prix Race',
    date:new Date(at-3600_000).toISOString(),race:{eventId:'100',sessionId:'101',session:'race',round:'Fixture Grand Prix'},
    status:'unknown',lifecycle:'unknown',detail:'Status unavailable',partitions:['motogp']});
  let probes=0;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[],
    schedules:[{id:'motogp',league:'motogp',path:'source-motogp',group:null}],
    readSchedule:async()=>({league:'motogp',games:[event],at}),probeCandidate:async()=>{probes++;return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};}});
  try {
    await coordinator.refresh();
    const reply=await coordinator.command({kind:'sources'});
    if(reply.kind!=='sources')assert.fail('expected sources reply');
    assert.equal(reply.snapshot.games[0].gameId,event.id);
    assert.deepEqual(reply.snapshot.games[0].feeds,{kind:'incomplete',reason:'schedule'});
    assert.equal(reply.snapshot.scheduleScopes[0].read.kind,'complete');
    assert.equal(probes,0);
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
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

test('source collection starts while schedule requests are still pending',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-pending-schedule-'));
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  let sourceReads=0;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>{await pending;return {league:'nfl',games:[game],at};},
    readHtml:async()=>{sourceReads++;return '<main>Recognized empty schedule</main>';},
    parseListings:()=>({outcome:'empty',observations:[]})});
  const refresh=coordinator.refresh();
  try {
    for(let index=0;index<30;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(sourceReads,1);
    const reply=await coordinator.command({kind:'sources'});
    if(reply.kind!=='sources')assert.fail('expected sources reply');
    assert.equal(reply.snapshot.sources[0].scopes[0].read.kind,'complete');
    assert.equal(reply.snapshot.scheduleScopes[0].read.kind,'incomplete');
  } finally {release();await refresh;await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a later source cycle proceeds while a saved schedule refresh remains pending',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-later-pending-schedule-'));
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  let clock=at,reads=0,sourceReads=0;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>clock,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>{if(++reads>1)await pending;return {league:'nfl',games:[game],at:clock};},
    readHtml:async()=>{sourceReads++;return '<main>Recognized empty schedule</main>';},
    parseListings:()=>({outcome:'empty',observations:[]})});
  try {
    await coordinator.refresh(true);
    for(let index=0;index<30&&sourceReads<1;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(sourceReads,1);
    clock+=300_001;
    const refreshing=coordinator.refresh(true);
    for(let index=0;index<30&&sourceReads<2;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(sourceReads,2);
    const reply=await coordinator.command({kind:'board'});
    assert.equal(reply.kind,'board');
    if(reply.kind==='board')assert.deepEqual(reply.board.games.map(row=>row.id),[game.id]);
    release();
    await refreshing;
  } finally {release();await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a fast forced schedule result starts one source collection cycle',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-single-discovery-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>({league:'nfl',games:[game],at}),
    readHtml:async()=>'<main>Recognized empty schedule</main>',
    parseListings:()=>({outcome:'empty',observations:[]})});
  const measured=coordinator as unknown as {discover:(force:boolean)=>Promise<void>};
  const discover=measured.discover.bind(coordinator);
  let collections=0;
  measured.discover=async force=>{collections++;await discover(force);};
  try {
    await coordinator.refresh(true);
    for(let index=0;index<5;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(collections,1);
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

test('all choices across game frontiers are checked within two playback slots',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-probe-backlog-'));
  const games=Array.from({length:20},(_,index)=>({...game,id:String(100+index),
    name:`Away ${index} at Home ${index}`,home:{...game.home,name:`Home ${index}`},away:{...game.away,name:`Away ${index}`}}));
  const observations=games.map(match=>({...observation,id:`event-${match.id}`,
    url:`https://fixture.example/event/${match.id}`,title:match.name,teams:[match.away.name,match.home.name]}));
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  let active=0,maximum=0;
  const completed:string[]=[];
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'football/nfl',group:null}],
    readSchedule:async()=>({league:'nfl',games,at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>Array.from({length:15},(_,index)=>({id:`choice-${gameId}-${index}`,label:`Server ${index}`,
      locator:{provider:'gooz',playerId:String(Number(gameId)*100+index)}})),
    probeCandidate:(locator,signal,onProgress)=>resources.run(signal,onProgress,async activeSignal=>{
      const response=await probeHttpResponse(activeSignal,async()=>{
        active++;maximum=Math.max(maximum,active);
        try{await new Promise<void>(resolve=>setImmediate(resolve));return new Response('ok');}
        finally{active--;}
      });
      await response.text();
      completed.push(locator.playerId);
      return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
    })});
  try {
    await coordinator.refresh();
    for(let index=0;index<2000;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind!=='sources')assert.fail('expected sources reply');
      if(reply.snapshot.games.reduce((count,row)=>count+(row.feeds.kind==='feeds'?row.feeds.mediaVerified:0),0)===300){
        assert.equal(reply.snapshot.games.length,20);
        assert.equal(new Set(completed).size,300);
        assert.equal(new Set(completed.slice(0,20).map(id=>Math.floor(Number(id)/100))).size,20);
        assert.equal(maximum,2);
        return;
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    const pending=await coordinator.command({kind:'sources'});
    assert.fail(`remaining choices did not leave the probe backlog: ${completed.length}, ${pending.kind==='sources'?pending.snapshot.games.reduce((count,row)=>count+row.candidates.length,0):pending.kind} candidates`);
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('the common pipeline collects today and tomorrow across every supported league',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'universal-all-leagues-'));
  const games=LeagueSchema.options.flatMap(league=>[0,1].map(day=>{
    const date=new Date(at+(day*24+1)*3600_000).toISOString();
    const common={id:`${league}-${day+1}`,league,date,partitions:[league],status:'pre',lifecycle:'scheduled',detail:'Scheduled'};
    return GameSchema.parse(isMotorsportsLeague(league)?{...common,name:`${league} Fixture Grand Prix Race`,
      race:{eventId:'1',sessionId:String(day+1),session:'race',round:'Fixture Grand Prix'}}:
      {...common,name:`${league} Away at ${league} Home`,home:{...game.home,name:`${league} Home`},
        away:{...game.away,name:`${league} Away`},redzone:false});
  }));
  const listings:Observation[]=games.map(game=>({...observation,id:game.id,url:`https://fixture.example/event/${game.id}`,
    league:game.league,title:isRaceGame(game)?game.name:`${game.away.name} vs ${game.home.name}`,
    teams:isRaceGame(game)?null:[game.away.name,game.home.name],kickoff:Date.parse(game.date??''),rawTime:game.date??''}));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,
    sources:[{...source,leagues:LeagueSchema.options}],
    schedules:LeagueSchema.options.map(league=>({id:league,league,path:league,group:null})),
    readSchedule:async partition=>({league:partition.league,games:games.filter(game=>game.league===partition.league),at}),
    readHtml:async()=>'<main>fixture</main>',parseListings:()=>({outcome:'parsed',observations:listings}),
    compatiblePlayers:gameId=>[{id:`choice-${gameId}`,label:'Published feed',locator:{provider:'gooz',playerId:'1'}}],
    probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}})});
  let last='';
  try {
    await coordinator.refresh();
    for(let index=0;index<250;index++){
      const reply=await coordinator.command({kind:'sources'});
      if(reply.kind!=='sources')assert.fail('expected sources reply');
      if(index===249)last=JSON.stringify(reply.snapshot.games.map(row=>({id:row.gameId,feeds:row.feeds,links:row.sourceLinks.length})));
      if(reply.snapshot.games.length===22&&reply.snapshot.games.every(row=>row.feeds.kind==='feeds'&&row.feeds.mediaVerified===1)){
        assert.deepEqual(reply.snapshot.games.map(row=>row.gameId).sort(),[
          'f1-1','f1-2','mlb-1','mlb-2','motogp-1','motogp-2','motorsport-1','motorsport-2',
          'nascar-cup-1','nascar-cup-2','nascar-truck-1','nascar-truck-2','nba-1','nba-2',
          'ncaaf-1','ncaaf-2',
          'nfl-1','nfl-2','nhl-1','nhl-2','wnba-1','wnba-2']);
        assert.equal(reply.snapshot.sources[0].scopes.length,11);
        return;
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.fail(`all supported leagues did not complete their feed checks ${last}`);
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
