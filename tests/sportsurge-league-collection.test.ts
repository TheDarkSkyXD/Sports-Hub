import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFixtureCollector, SOURCES } from '../lib/football/adapters/sources.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, SourcesSnapshot } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-07T22:00:00Z');
const kickoff = Date.parse('2026-10-07T23:30:00Z');
const source = SOURCES.find(row => row.id === 'sportsurge');
assert.ok(source);

const team = (id: string, name: string) => ({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const game = (id: string, league: Game['league'], partition: string, away: Game['away'], home: Game['home']): Game => ({
  id,league,partitions:[partition],name:`${away.name} at ${home.name}`,
  date:new Date(id==='ncaaf-2002'?kickoff+24*60*60_000:kickoff).toISOString(),
  away,home,status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,
});
const games = [
  game('1001','nfl','nfl',team('nfl:kc','Kansas City Chiefs'),team('nfl:buf','Buffalo Bills')),
  game('1002','nfl','nfl',team('nfl:dal','Dallas Cowboys'),team('nfl:nyg','New York Giants')),
  game('ncaaf-2001','ncaaf','fbs',team('espn:ncaaf:84','Indiana Hoosiers'),team('espn:ncaaf:2509','Purdue Boilermakers')),
  game('ncaaf-2002','ncaaf','fcs',team('espn:ncaaf:147','Montana State Bobcats'),team('espn:ncaaf:70','Idaho Vandals')),
];
const urls = [
  'https://isportsurge.ws/watch/nfl/kansas-city-buffalo/1001',
  'https://isportsurge.ws/watch/nfl/dallas-new-york/1002',
  'https://isportsurge.ws/watch/cfb/indiana-purdue/2001',
  'https://isportsurge.ws/watch/cfb/montana-state-idaho/2002',
];
const listing = (index: number) => `<a href="${urls[index]}"${index===3?'':` datetime="${games[index].date}"`}>`+
  `<span class="team-name-event-row"><img alt="${games[index].away.name}"></span>`+
  `<span class="team-name-event-row"><img alt="${games[index].home.name}"></span></a>`;
const category = (league: Game['league']) => `<html><body>${games.flatMap((row,index) => row.league===league ? [listing(index)] : []).join('')}</body></html>`;
const feeds = (snapshot: SourcesSnapshot) => snapshot.games.flatMap(row => row.candidates
  .filter(candidate => candidate.sourceIds.includes('sportsurge'))
  .map(candidate => [row.gameId,candidate.id] as const)).sort(([a],[b])=>a.localeCompare(b));

async function runCollection(failed: 'nfl' | 'ncaaf' | 'index' | null) {
  const directory = mkdtempSync(join(tmpdir(),'sportsurge-leagues-'));
  const collector=createFixtureCollector();
  let failedCategory=failed;
  let clock=at;
  const queueCollection=()=>{
    for(const [url,league] of [
      ['https://isportsurge.ws/nfl/livestreams3','nfl'],
      ['https://isportsurge.ws/cfb/livestreams2','ncaaf'],
      ['https://isportsurge.ws/nba/livestreams3',null],
      ['https://isportsurge.ws/nhl/livestreams3',null],
      ['https://isportsurge.ws/mlb/livestreams2',null],
    ] as const)collector.enqueueFixture({url,...(league===failedCategory?{failure:{message:`${league} timeout`}}:
      {body:league?category(league):'<html><body>No games</body></html>'})});
    for(const [index,url] of urls.entries()){
      if(games[index].league===failedCategory)continue;
      collector.enqueueFixture({url,body:`<html><body><h1>${games[index].name}</h1><time>2026-10-0${index===3?'8':'7'} 19:30ET</time>`+
        `<iframe src="https://gooz.aapmains.net/new-stream-embed/${57001+index}"></iframe></body></html>`});
    }
  };
  queueCollection();
  const coordinator = createFootballCoordinator(join(directory,'state.sqlite'),{
    sources:[source],schedules:[
      {id:'nfl',league:'nfl',path:'nfl',group:null},
      {id:'fbs',league:'ncaaf',path:'college-football',group:'80'},
      {id:'fcs',league:'ncaaf',path:'college-football',group:'81'},
    ],
    readSchedule:async partition => ({games:games.filter(row=>row.partitions?.includes(partition.id)),at,league:partition.league}),
    readSeasonMembership:async()=>{throw new Error('unexpected membership fetch');},
    probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),now:()=>clock,
    readHtml:collector.readHtml,parseListings:collector.parseListings,enrichObservation:collector.enrichObservation,
    compatiblePlayers:collector.compatiblePlayers,resolvePlayers:collector.resolvePlayers,
    missingPlayerReason:collector.missingPlayerReason,tvappPlayers:collector.tvappPlayers,
  });
  const snapshot = async (): Promise<SourcesSnapshot> => {
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    return reply.snapshot;
  };
  const settled = async (expectedGames: number): Promise<SourcesSnapshot> => {
    let current=await snapshot();
    for(let attempt=0;attempt<100;attempt++) {
      const published=current.games.flatMap(row=>row.candidates.filter(candidate=>candidate.sourceIds.includes('sportsurge')));
      if(published.length===expectedGames&&published.every(candidate=>candidate.availability.kind==='playable'))return current;
      await new Promise<void>(resolve=>setTimeout(resolve,10));
      current=await snapshot();
    }
    return current;
  };
  const close = async () => {
    await coordinator.stop();
    rmSync(directory,{recursive:true,force:true});
  };
  return {coordinator,snapshot,settled,close,collector,
    failNext:(category:'nfl'|'ncaaf')=>{failedCategory=category;clock+=5*60_000;queueCollection();},get clock(){return clock;}};
}

test('an NFL category timeout still publishes two NCAA game feeds and reports a partial attempt',async()=>{
  const run=await runCollection('nfl');
  try {
    await run.coordinator.refresh(true);
    const snapshot=await run.settled(2);
    const sourceRow=snapshot.sources.find(row=>row.id==='sportsurge');
    assert.deepEqual(feeds(snapshot),[['ncaaf-2001','gooz-57003'],['ncaaf-2002','gooz-57004']]);
    assert.equal(sourceRow?.lastAttempt?.outcome,'failed');
    assert.equal(sourceRow?.lastAttempt?.count,2);
  } finally {await run.close();}
});

test('a CFB category timeout still publishes both NFL game feeds',async()=>{
  const run=await runCollection('ncaaf');
  try {
    await run.coordinator.refresh(true);
    const snapshot=await run.settled(2);
    assert.deepEqual(feeds(snapshot),[['1001','gooz-57001'],['1002','gooz-57002']]);
    assert.equal(snapshot.sources.find(row=>row.id==='sportsurge')?.lastAttempt?.outcome,'failed');
    assert.equal(snapshot.sources.find(row=>row.id==='sportsurge')?.lastAttempt?.count,2);
  } finally {await run.close();}
});

test('category collection does not depend on a legacy index fetch',async()=>{
  const run=await runCollection('index');
  try {
    await run.coordinator.refresh(true);
    const snapshot=await run.settled(4);
    assert.deepEqual(feeds(snapshot),[['1001','gooz-57001'],['1002','gooz-57002'],
      ['ncaaf-2001','gooz-57003'],['ncaaf-2002','gooz-57004']]);
    assert.equal(run.collector.fixtureRequests().some(request=>request.url===source.url),false);
  } finally {await run.close();}
});

test('a complete Sportsurge pass publishes four distinct game feeds',async()=>{
  const run=await runCollection(null);
  try {
    await run.coordinator.refresh(true);
    const snapshot=await run.settled(4);
    assert.deepEqual(feeds(snapshot),[['1001','gooz-57001'],['1002','gooz-57002'],
      ['ncaaf-2001','gooz-57003'],['ncaaf-2002','gooz-57004']]);
    assert.equal(snapshot.sources.find(row=>row.id==='sportsurge')?.lastAttempt?.count,4);
  } finally {await run.close();}
});

test('a failed league retains its prior listing timestamp while the healthy league refreshes',async()=>{
  const run=await runCollection(null);
  try {
    await run.coordinator.refresh(true);
    assert.equal(feeds(await run.settled(4)).length,4);
    run.failNext('nfl');
    await run.coordinator.refresh(true);
    let snapshot=await run.snapshot();
    for(let attempt=0;attempt<100&&snapshot.sources.find(row=>row.id==='sportsurge')?.lastAttempt?.at!==run.clock;attempt++) {
      await new Promise<void>(resolve=>setTimeout(resolve,10));
      snapshot=await run.snapshot();
    }
    const sourceRow=snapshot.sources.find(row=>row.id==='sportsurge');
    assert.equal(sourceRow?.lastAttempt?.outcome,'failed');
    assert.equal(sourceRow.lastAttempt.count,2);
    assert.equal(sourceRow.links.find(link=>link.url===urls[0])?.observedAt,at);
    assert.equal(sourceRow.links.find(link=>link.url===urls[2])?.observedAt,run.clock);
  } finally {await run.close();}
});
