import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {CommandSchema,FeedCheckIntervalMinutesSchema,type Game,type Observation} from '../lib/football/shared.ts';

test('feed check interval accepts only the offered minute choices',()=>{
  for(const minutes of [1,5,10,15])assert.equal(CommandSchema.safeParse({kind:'set-feed-check-interval',minutes}).success,true);
  for(const minutes of [0,2,5.5,16,'5'])assert.equal(FeedCheckIntervalMinutesSchema.safeParse(minutes).success,false);
});

test('a failed live listing is checked again after the selected minute without manual retry',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feed-check-recovery-'));
  const at=Date.parse('2026-10-04T17:00:00Z');
  let clock=at,listingReads=0;
  const game:Game={id:'401872973',league:'nfl',name:'Tennessee Titans at Baltimore Ravens',date:new Date(at).toISOString(),
    status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Baltimore Ravens',short:'Ravens',abbreviation:'BAL',color:'112233',score:'0'},
    away:{name:'Tennessee Titans',short:'Titans',abbreviation:'TEN',color:'332211',score:'0'}};
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at:clock}),
    readHtml:async url=>{if(url.endsWith('/list')&&++listingReads===1)throw new Error('network');return '<main>fixture</main>';},
    parseListings:()=>({outcome:'parsed',observations:[{id:'fixture-game',sourceId:'fixture',url:'https://fixture.example/detail',
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:clock,parserVersion:2} satisfies Observation]}),
    enrichObservation:observation=>observation,
    compatiblePlayers:()=>[{id:'server',label:'Server',locator:{provider:'gooz',playerId:'1'}}],
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try {
    await coordinator.refresh();
    for(let index=0;index<30;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(listingReads,1);
    const setting=await coordinator.command({kind:'set-feed-check-interval',minutes:1});
    assert.equal(setting.kind,'board');
    if(setting.kind==='board')assert.equal(setting.board.feedCheckIntervalMinutes,1);
    clock=at+59_999;
    await coordinator.refresh();
    assert.equal(listingReads,1);
    clock=at+60_000;
    await coordinator.refresh();
    for(let index=0;index<30;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(listingReads,2);
    const snapshot=await coordinator.command({kind:'sources'});
    assert.equal(snapshot.kind,'sources');
    if(snapshot.kind==='sources')assert.equal(snapshot.snapshot.games.find(row=>row.gameId===game.id)?.workingChoiceCount,1);
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

for(const result of ['playable','unavailable'] as const)test(`${result} media recheck is due at five minutes regardless of source interval`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'media-five-minute-'));
  const at=Date.parse('2026-10-04T17:00:00Z');
  let clock=at,probes=0;
  const game:Game={id:'401872973',league:'nfl',name:'Tennessee Titans at Baltimore Ravens',date:new Date(at).toISOString(),
    status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Baltimore Ravens',short:'Ravens',abbreviation:'BAL',color:'112233',score:'0'},
    away:{name:'Tennessee Titans',short:'Titans',abbreviation:'TEN',color:'332211',score:'0'}};
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at:clock}),
    readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:[{id:'fixture-game',sourceId:'fixture',url:'https://fixture.example/detail',
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:clock,parserVersion:2}]}),
    enrichObservation:observation=>observation,
    compatiblePlayers:()=>[{id:'server',label:'Server',locator:{provider:'gooz',playerId:'1'}}],
    probeCandidate:async()=>{probes++;return result==='playable'?{kind:'playable',proof:'media'}:{kind:'unavailable',reason:'no-feed'};},
  });
  const settle=async()=>{for(let index=0;index<30;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    await coordinator.refresh();await settle();
    assert.equal(probes,1);
    await coordinator.command({kind:'set-feed-check-interval',minutes:15});
    clock=at+299_999;await coordinator.refresh();await settle();
    assert.equal(probes,1);
    clock=at+300_000;await coordinator.refresh();await settle();
    assert.equal(probes,2);
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('interval persists and rebases source and detail retries without shortening rate limits',()=>{
  const directory=mkdtempSync(join(tmpdir(),'feed-check-interval-'));
  const path=join(directory,'state.sqlite');
  const at=Date.parse('2026-10-04T17:00:00Z');
  const store=new FootballStore(path);
  try {
    assert.equal(store.feedCheckIntervalMinutes(),5);
    store.saveListingAttempt('normal',{at,outcome:'failed',failure:'upstream-error',failures:1,nextEligibleAt:at+300_000},[]);
    store.saveListingAttempt('cooldown',{at,outcome:'failed',failure:'rate-limited',failures:1,nextEligibleAt:at+600_000},[]);
    store.saveDetailEvidence({outcome:'unresolved',observationId:'normal-detail',generation:'first',at,reason:'no-published-player',failures:0,nextEligibleAt:at+300_000});
    store.saveDetailEvidence({outcome:'failed',observationId:'limited-detail',generation:'first',at,failure:'rate-limited',failures:1,nextEligibleAt:at+300_000});
    store.setFeedCheckIntervalMinutes(1);
    store.saveSportsurgeCatalog({receivedAt:at,catalog:{runId:randomUUID(),sequence:0,startedAt:at,
      state:{kind:'collecting'},categories:{ncaaf:{kind:'failed',at,reason:'rate-limited'},nfl:{kind:'pending'}},
      events:[],rejectedGames:[],catalogIssues:[]}},[]);
    assert.equal(store.sourceAttempts().normal.nextEligibleAt,at+60_000);
    assert.equal(store.sourceAttempts().cooldown.nextEligibleAt,at+600_000);
    assert.equal(store.sourceAttempts()['sportsurge-v2'].nextEligibleAt,at+300_000);
    assert.equal(store.detailEvidence().find(detail=>detail.observationId==='normal-detail')?.nextEligibleAt,at+60_000);
    assert.equal(store.detailEvidence().find(detail=>detail.observationId==='limited-detail')?.nextEligibleAt,at+300_000);
    store.close();
    const restored=new FootballStore(path);
    try {
      assert.equal(restored.feedCheckIntervalMinutes(),1);
      restored.setFeedCheckIntervalMinutes(15);
      assert.equal(restored.sourceAttempts().normal.nextEligibleAt,at+900_000);
      assert.equal(restored.sourceAttempts().cooldown.nextEligibleAt,at+900_000);
      assert.equal(restored.detailEvidence().find(detail=>detail.observationId==='normal-detail')?.nextEligibleAt,at+900_000);
      restored.setFeedCheckIntervalMinutes(1);
      assert.equal(restored.sourceAttempts().cooldown.nextEligibleAt,at+900_000);
      assert.equal(restored.detailEvidence().find(detail=>detail.observationId==='limited-detail')?.nextEligibleAt,at+900_000);
    } finally {restored.close();}
  } finally {rmSync(directory,{recursive:true,force:true});}
});
