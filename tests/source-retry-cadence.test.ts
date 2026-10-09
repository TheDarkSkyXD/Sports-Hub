import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const game: Game = { id: '401872973', league: 'nfl', name: 'Tennessee Titans at Baltimore Ravens',
  date: new Date(at).toISOString(), status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
  home: { name: 'Baltimore Ravens', short: 'Ravens', abbreviation: 'BAL', color: '112233', score: '0' },
  away: { name: 'Tennessee Titans', short: 'Titans', abbreviation: 'TEN', color: '332211', score: '0' } };

async function drain() {
  for (let i = 0; i < 60; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

for (const missing of [true, false]) test(missing ? 'missing player details retry at five minutes' : 'unavailable media retries automatically at five minutes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-minute-retry-'));
  let clock = at, details = 0, probes = 0;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async source => ({ games: source.id === 'nfl' ? [game] : [], league: source.league, at: clock }),
    readHtml: async url => { if (url.endsWith('/detail')) details++; return '<main>fixture</main>'; },
    parseListings: () => ({ outcome: 'parsed', observations: [{ id: 'listing', sourceId: 'fixture',
      url: 'https://fixture.example/detail', title: game.name, teams: [game.away.name, game.home.name],
      league: 'nfl', kickoff: at, rawTime: '', observedAt: clock, parserVersion: 2 } satisfies Observation] }),
    enrichObservation: value => value,
    compatiblePlayers: () => missing ? [] : [{ id: 'server', label: 'Server', locator: { provider: 'gooz', playerId: '1' } }],
    probeCandidate: async () => { probes++; return { kind: 'unavailable', reason: 'upstream' }; },
  });
  const refresh = async () => { await coordinator.refresh(); await drain(); };
  const count = () => missing ? details : probes;
  try {
    await refresh();
    assert.equal(count(), 1);
    clock = at + 299999;
    await coordinator.command({ kind: 'sources' });
    assert.equal(count(), 1);
    clock = at + 300000;
    await coordinator.refresh();
    await drain();
    assert.equal(count(), 2);
    if (!missing) {
      const sources = await coordinator.command({ kind: 'sources' });
      assert.equal(sources.kind, 'sources');
      if (sources.kind === 'sources') assert.equal(sources.snapshot.games[0]?.candidates[0]?.availability.kind, 'unavailable');
      assert.deepEqual(await coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: true }), { kind: 'ok' });
      await drain();
      assert.equal(probes, 3);
    }
  } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
});

for (const [retryAfter, cooldown] of [[600000, 600000], [0, 300000], [1000, 300000]])
test(`a 429 pauses same-host listings and details for ${cooldown}ms with Retry-After ${retryAfter}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-host-retry-'));
  let clock = at, limited = false;
  const reads: string[] = [];
  const sources = ['one', 'two'].map(id => ({ id, url: `https://fixture.example/${id}`, family: 'fixture' }));
  class Limited extends Error { readonly retryAfterMs = retryAfter; }
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, sources,
    retryAfterMs: error => error instanceof Limited ? error.retryAfterMs : 0,
    readSchedule: async source => ({ games: source.id === 'nfl' ? [game] : [], league: source.league, at: clock }),
    readHtml: async url => { reads.push(url); if (limited && url === sources[0].url) throw new Limited('http-429'); return '<main>fixture</main>'; },
    parseListings: source => ({ outcome: 'parsed', observations: [{ id: `listing-${source.id}`, sourceId: source.id,
      url: `https://fixture.example/detail-${source.id}`, title: game.name, teams: [game.away.name, game.home.name],
      league: 'nfl', kickoff: at, rawTime: '', observedAt: clock, parserVersion: 2 } satisfies Observation] }),
    enrichObservation: value => value,
    compatiblePlayers: (_gameId, observation) => observation.sourceId === 'one'
      ? [{ id: 'server', label: 'Server', locator: { provider: 'gooz', playerId: '1' } }] : [],
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  const refresh = async (time: number) => { clock = time; await coordinator.refresh(true); await drain(); };
  try {
    await refresh(at);
    const initialReads = reads.length;
    assert.equal(initialReads, 4);
    limited = true;
    await refresh(at + 300000);
    assert.deepEqual(reads.slice(initialReads), [sources[0].url]);
    const snapshot = await coordinator.command({ kind: 'sources' });
    assert.equal(snapshot.kind, 'sources');
    if (snapshot.kind === 'sources') {
      assert.equal(snapshot.snapshot.games[0].workingChoiceCount, 1);
      assert.equal(snapshot.snapshot.sources.find(source => source.id === 'one')?.lastAttempt?.failures, 1);
      assert.equal(snapshot.snapshot.sources.find(source => source.id === 'two')?.lastAttempt?.failures, 0);
    }
    limited = false;
    await refresh(at + 300000 + cooldown - 1);
    assert.equal(reads.length, initialReads + 1);
    await refresh(at + 300000 + cooldown);
    assert.ok(reads.slice(initialReads + 1).includes(sources[1].url));
    assert.ok(reads.slice(initialReads + 1).includes('https://fixture.example/detail-two'));
  } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
});

for (const failure of ['network', 'parser']) test(`repeated ordinary ${failure} failures retry every five minutes`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-repeat-retry-'));
  let clock = at, reads = 0;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async source => ({ games: source.id === 'nfl' ? [game] : [], league: source.league, at: clock }),
    readHtml: async () => { reads++; if (failure === 'network') throw new Error('fetch failed'); return '<main>fixture</main>'; },
    parseListings: () => ({ outcome: 'parser-changed', observations: [] }),
  });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      clock = at + attempt * 300000;
      await coordinator.refresh();
      await drain();
      assert.equal(reads, attempt + 1);
      const reply = await coordinator.command({ kind: 'sources' });
      assert.equal(reply.kind, 'sources');
      if (reply.kind === 'sources') {
        assert.equal(reply.snapshot.sources[0].lastAttempt?.failures, attempt + 1);
        assert.equal(reply.snapshot.sources[0].lastAttempt?.nextEligibleAt, clock + 300000);
      }
    }
  } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
});

for(const outcome of ['parser-changed','failed'] as const)test(`startup migrates outdated ${outcome} evidence without bypassing transport cooldowns`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-parser-migration-'));
  const path=join(directory,'state.sqlite');
  const store=new FootballStore(path);
  store.saveListingAttempt('fixture',{at,outcome,count:0,failures:4,parserVersion:2,
    nextEligibleAt:at+600000,...(outcome==='failed'?{failure:'rate-limited' as const}:{})},[]);
  store.close();
  let clock=at,reads=0;
  const coordinator=createFootballCoordinator(path,{
    now:()=>clock,sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at:clock}),
    readHtml:async()=>{reads++;return '<main>empty</main>';},
    parseListings:()=>({outcome:'empty',observations:[]}),
  });
  try{
    await coordinator.refresh();await drain();
    assert.equal(reads,outcome==='parser-changed'?1:0);
    if(outcome==='failed'){
      clock=at+600000;
      await coordinator.refresh();await drain();
      assert.equal(reads,1);
    }
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.sources[0].lastAttempt?.parserVersion,3);
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('NFLStreams retries old unsupported evidence without waking another version-three source',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'nflstreams-parser-retry-'));
  const path=join(directory,'state.sqlite');
  const store=new FootballStore(path);
  for(const id of ['nflstreams','fixture'])store.saveListingAttempt(id,{at,outcome:'unsupported',count:0,
    parserVersion:3,nextEligibleAt:Number.MAX_SAFE_INTEGER},[]);
  store.close();
  const reads:string[]=[];
  const sources=[
    {id:'nflstreams',url:'https://nflstreams.org/',family:'nflstreams',parserVersion:4},
    {id:'fixture',url:'https://fixture.example/list',family:'fixture'},
  ];
  const coordinator=createFootballCoordinator(path,{
    now:()=>at,sources,
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at}),
    readHtml:async url=>{reads.push(url);return '<main>empty</main>';},
    parseListings:()=>({outcome:'empty',observations:[]}),
  });
  try{
    await coordinator.refresh();await drain();
    assert.deepEqual(reads,[sources[0].url]);
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources'){
      assert.equal(reply.snapshot.sources.find(source=>source.id==='nflstreams')?.lastAttempt?.parserVersion,4);
      assert.equal(reply.snapshot.sources.find(source=>source.id==='fixture')?.lastAttempt?.parserVersion,3);
    }
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a source completing after the scan starts is admitted on the first local poll after its five-minute deadline',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-completion-cadence-'));
  let clock=at,reads=0;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at:clock}),
    readHtml:async()=>{reads++;clock+=1000;return '<main>empty</main>';},
    parseListings:()=>({outcome:'empty',observations:[]}),
  });
  const refresh=async(time:number)=>{clock=time;await coordinator.refresh();await drain();};
  try{
    await refresh(at);
    assert.equal(reads,1);
    const initial=await coordinator.command({kind:'sources'});
    assert.equal(initial.kind,'sources');
    if(initial.kind==='sources')assert.equal(initial.snapshot.sources[0].lastAttempt?.nextEligibleAt,at+301000);
    await refresh(at+300000);
    assert.equal(reads,1,'the network request must wait until five minutes after completion');
    await refresh(at+330000);
    assert.equal(reads,2,'a skipped admission poll must not add another five-minute delay');
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
