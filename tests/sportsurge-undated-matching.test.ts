import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { createObservationMatcher } from '../lib/football/domain/matching.ts';
import { sportsurgeCandidates, sportsurgeCatalogView } from '../lib/football/domain/sportsurge-catalog.ts';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import type { Game, Observation, SportsurgeCatalog } from '../lib/football/shared.ts';

const now = Date.parse('2026-10-07T22:00:00Z');
const kickoffToday = Date.parse('2026-10-08T01:00:00Z');
const kickoffTomorrow = Date.parse('2026-10-08T20:00:00Z');
const runId = '11111111-1111-4111-8111-111111111111';

const team = (name: string, id: string): Game['home'] => ({
  id, name, short: name, abbreviation: name.slice(0, 3), color: '112233', score: '0',
});

const games: Game[] = [
  { id: '1001', league: 'nfl', name: 'Kansas City Chiefs at Buffalo Bills',
    away: team('Kansas City Chiefs', 'espn:nfl:12'), home: team('Buffalo Bills', 'espn:nfl:2'),
    date: new Date(kickoffToday).toISOString(), lifecycle: 'scheduled', status: 'pre', detail: 'Scheduled', redzone: false, partitions: ['nfl'] },
  { id: '1002', league: 'nfl', name: 'Chicago Bears at Green Bay Packers',
    away: team('Chicago Bears', 'espn:nfl:3'), home: team('Green Bay Packers', 'espn:nfl:9'),
    date: new Date(kickoffTomorrow).toISOString(), lifecycle: 'scheduled', status: 'pre', detail: 'Scheduled', redzone: false, partitions: ['nfl'] },
  { id: 'ncaaf-1003', league: 'ncaaf', name: 'Alabama Crimson Tide at Auburn Tigers',
    away: team('Alabama Crimson Tide', 'espn:ncaaf:333'), home: team('Auburn Tigers', 'espn:ncaaf:2'),
    date: new Date(kickoffToday).toISOString(), lifecycle: 'scheduled', status: 'pre', detail: 'Scheduled', redzone: false, partitions: ['fbs'] },
  { id: 'ncaaf-1004', league: 'ncaaf', name: 'Delaware Blue Hens at Virginia Cavaliers',
    away: team('Delaware Blue Hens', 'espn:ncaaf:48'), home: team('Virginia Cavaliers', 'espn:ncaaf:258'),
    date: new Date(kickoffTomorrow).toISOString(), lifecycle: 'scheduled', status: 'pre', detail: 'Scheduled', redzone: false, partitions: ['fcs'] },
];

const legacyObservation = (game: Game, index: number): Observation => ({
  id: `sportsurge:fixture-${index}`, sourceId: 'sportsurge',
  url: `https://isportsurge.ws/watch-${index}-${game.league === 'nfl' ? 'nfl' : 'cfb'}-fixture`,
  title: game.name, league: game.league, teams: [game.away.name, game.home.name],
  kickoff: null, rawTime: '', observedAt: now, parserVersion: 1,
});

const v2Event = (game: Game, index: number): SportsurgeCatalog['events'][number] => ({
  id: `${game.league}:${index}`, league: game.league,
  url: `https://v2.sportsurge.net/watch-${index}-${game.league === 'nfl' ? 'nfl' : 'cfb'}-fixture/`,
  title: game.name, teams: [game.away.name, game.home.name], kickoff: null, sourceStatus: 'unknown',
  advertisedLinkCount: 2, detail: { kind: 'collected', at: now, providers: [1, 2].map(player => ({
    id: `${index}-${player}`, label: `Server ${player}`, observedAt: now,
    destination: { kind: 'link', url: `https://media.example/${index}/${player}` },
  })) },
});

test('legacy Sportsurge resolves every unique undated NFL, FBS, and FCS game and both feeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsurge-undated-'));
  const store = new FootballStore(join(dir, 'state.sqlite'));
  const observations = games.map(legacyObservation);
  const coordinator = new FootballCoordinator({
    store, now: () => now, id: () => runId,
    schedules: ['nfl', 'fbs', 'fcs'].map(id => ({ id, league: id === 'nfl' ? 'nfl' as const : 'ncaaf' as const, path: '', group: null })),
    sources: [{ id: 'sportsurge', url: 'https://isportsurge.ws/index6', family: 'sportsurge', kind: 'listing' }],
    readSchedule: async partition => ({ games: games.filter(game => game.partitions?.includes(partition.id)), league: partition.league, at: now }),
    readSeasonMembership: async () => { throw new Error('unused'); },
    readHtml: async () => '<main>detail has no event time</main>',
    parseListings: () => ({ outcome: 'parsed', observations }),
    enrichObservation: observation => observation,
    compatiblePlayers: gameId => [1, 2].map(player => ({
      id: `gooz-${gameId}-${player}`, label: `Server ${player}`, locator: { provider: 'gooz' as const, playerId: String(57000 + Number(gameId.replace(/\D/g, '')) * 2 + player) },
    })),
    retryAfterMs: () => 0,
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  try {
    await coordinator.refresh(true);
    let snapshot: Awaited<ReturnType<typeof coordinator.command>> | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await coordinator.command({ kind: 'sources' });
      if (snapshot.kind === 'sources' && games.every(game => snapshot?.kind === 'sources' &&
        snapshot.snapshot.games.find(row => row.gameId === game.id)?.workingChoiceCount === 2)) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(snapshot?.kind, 'sources');
    if (snapshot?.kind !== 'sources') return;
    assert.equal(snapshot.snapshot.games.length, 4);
    for (const game of games) {
      const row = snapshot.snapshot.games.find(row => row.gameId === game.id);
      assert.equal(row?.workingChoiceCount, 2, game.name);
      assert.equal(row?.sourceLinks.some(link => link.sourceId === 'sportsurge'), true);
      assert.deepEqual(row?.candidates.map(candidate => candidate.id).sort(), [`gooz-${game.id}-1`, `gooz-${game.id}-2`]);
    }
    assert.deepEqual(store.sourceEventBindings().filter(binding => binding.sourceId === 'sportsurge')
      .map(binding => binding.gameId).sort(), games.map(game => game.id).sort());
  } finally { await coordinator.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('v2 checkpoint stores undated game assignments and final-protection bindings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsurge-undated-catalog-'));
  const store = new FootballStore(join(dir, 'state.sqlite'));
  const events = games.map((game, index) => v2Event(game, index + 1));
  const catalog: SportsurgeCatalog = { runId, sequence: 0, startedAt: now, state: { kind: 'complete', at: now },
    categories: { nfl: { kind: 'collected', at: now }, ncaaf: { kind: 'collected', at: now } },
    events, rejectedGames: [], catalogIssues: [] };
  for (const partition of ['nfl', 'fbs', 'fcs']) store.savePartition(partition, {
    games: games.filter(game => game.partitions?.includes(partition)), at: now,
  });
  const coordinator = new FootballCoordinator({
    store, now: () => now, id: () => runId,
    schedules: ['nfl', 'fbs', 'fcs'].map(id => ({ id, league: id === 'nfl' ? 'nfl' as const : 'ncaaf' as const, path: '', group: null })),
    sources: [{ id: 'sportsurge-v2', url: 'https://v2.sportsurge.net/watch-cfb-streams/', family: 'sportsurge', kind: 'browser-catalog' }],
    readSchedule: async partition => ({ games: games.filter(game => game.partitions?.includes(partition.id)), league: partition.league, at: now }),
    readSeasonMembership: async () => { throw new Error('unused'); },
    readHtml: async () => { throw new Error('unused'); },
    parseListings: () => ({ outcome: 'empty', observations: [] }),
    enrichObservation: observation => observation,
    compatiblePlayers: () => [], retryAfterMs: () => 0,
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  try {
    assert.equal((await coordinator.command({ kind: 'sportsurge-catalog', catalog })).kind, 'catalog-ack');
    assert.deepEqual(store.sourceEventBindings().filter(binding => binding.sourceId === 'sportsurge-v2')
      .map(binding => binding.gameId).sort(), games.map(game => game.id).sort());
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind === 'sources') assert.equal(reply.snapshot.sources[0].matchedGameCount, 4);
  } finally { await coordinator.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('Sportsurge v2 admits all providers for unique undated games and inventory links match them', () => {
  const events = games.map((game, index) => v2Event(game, index + 1));
  const catalog: SportsurgeCatalog = { runId, sequence: 0, startedAt: now, state: { kind: 'complete', at: now },
    categories: { nfl: { kind: 'collected', at: now }, ncaaf: { kind: 'collected', at: now } },
    events, rejectedGames: [], catalogIssues: [] };
  const stored = { catalog, receivedAt: now };
  const candidates = sportsurgeCandidates({ current: stored, previous: null, lastComplete: null, games, now });
  assert.equal(candidates.length, 8);
  for (const game of games) assert.equal(candidates.filter(candidate => candidate.gameId === game.id).length, 2);
  const inventory = sourceInventory({ at: now, revision: 1, lastDiscoveryAt: null, browserCollectorsAvailable: true,
    sources: [{ id: 'sportsurge-v2', url: 'https://v2.sportsurge.net/watch-cfb-streams/', family: 'sportsurge', kind: 'browser-catalog' }],
    observations: [], games, candidates: new Map(games.map(game => [game.id, candidates.filter(candidate => candidate.gameId === game.id)])),
    attempts: {}, sportsurgeCatalog: { current: stored, previous: null, lastComplete: null },
    streameastCatalog: { current: null, previous: null, lastComplete: null },
    availability: () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}, checkedAt: now }) });
  assert.equal(inventory.sources[0].matchedGameCount, 4);
  assert.equal(inventory.sources[0].compatibleFeedCount, 8);
  for (const game of games) assert.equal(inventory.games.find(row => row.gameId === game.id)?.sourceLinks
    .some(link => link.sourceId === 'sportsurge-v2'), true);
  assert.deepEqual(sportsurgeCatalogView(stored, games, now).games.map(row => row.gameId), games.map(game => game.id));
});

test('an older live v2 category keeps freshly collected feeds, while stale unknown and stale detail do not', () => {
  const live: Game = { ...games[3], date: new Date(now - 60 * 60_000).toISOString(), status: 'in', lifecycle: 'live' };
  const oldCategoryAt = now - 31 * 60_000;
  const event = { ...v2Event(live, 4), sourceStatus: 'live' as const };
  const catalog: SportsurgeCatalog = { runId, sequence: 0, startedAt: oldCategoryAt, state: { kind: 'complete', at: now },
    categories: { nfl: { kind: 'collected', at: oldCategoryAt }, ncaaf: { kind: 'collected', at: oldCategoryAt } },
    events: [event], rejectedGames: [], catalogIssues: [] };
  const candidates = (value: SportsurgeCatalog) => sportsurgeCandidates({
    current: { catalog: value, receivedAt: now }, previous: null, lastComplete: null, games: [live], now,
  });
  assert.equal(candidates(catalog).length, 2);
  assert.equal(sportsurgeCatalogView({ catalog, receivedAt: now }, [live], now).games[0].gameId, live.id);
  assert.equal(candidates({ ...catalog, events: [{ ...event, sourceStatus: 'unknown' }] }).length, 0);
  if (event.detail.kind !== 'collected') throw new Error('Expected collected fixture');
  const oldDetail = { ...event, detail: { ...event.detail, at: oldCategoryAt,
    providers: event.detail.providers.map(row => ({ ...row, observedAt: oldCategoryAt })) } };
  assert.equal(candidates({ ...catalog, events: [oldDetail] }).length, 0);
});

test('undated Sportsurge matching rejects ambiguity, contextual aliases, wrong league, stale, final, and day two', () => {
  const original = legacyObservation(games[3], 4);
  const strict = createObservationMatcher(games);
  const raw = strict(original, now);
  assert.deepEqual(raw, { kind: 'unmatched', reason: 'unverified-kickoff', possibleGameIds: [games[3].id] });
  assert.deepEqual(strict({ ...original, sourceId: 'tvapp' }, now), raw);
  const contextualGame = { ...games[3], id: 'ncaaf-contextual',
    away: team('Southern Miss Golden Eagles', 'espn:ncaaf:2572'),
    home: team('Troy Trojans', 'espn:ncaaf:2653') };
  const contextual = { ...original, teams: ['Southern Miss', 'Troy'] as [string, string] };
  const contextualRaw = createObservationMatcher([contextualGame])(contextual, now);
  assert.equal(contextualRaw.kind, 'unmatched');
  if (contextualRaw.kind === 'unmatched') assert.equal(contextualRaw.reason, 'unverified-contextual-kickoff');
  const repeated = { ...games[3], id: 'ncaaf-repeated', date: new Date(now + 7 * 86_400_000).toISOString() };
  const repeatedRaw = createObservationMatcher([games[3], repeated])(original, now);
  assert.equal(repeatedRaw.kind, 'unmatched');
  const dated = { ...original, kickoff: kickoffTomorrow + 4 * 60 * 60_000 };
  const datedRaw = strict(dated, now);
  assert.equal(datedRaw.kind, 'unmatched');
  const catalog = (observation: Observation, list: Game[], at: number) => {
    const event = v2Event(list[0], 4);
    event.teams = observation.teams || event.teams;
    event.league = observation.league || event.league;
    event.kickoff = observation.kickoff;
    event.id = `${event.league}:4`;
    event.url = `https://v2.sportsurge.net/watch-4-${event.league === 'nfl' ? 'nfl' : 'cfb'}-fixture/`;
    const value: SportsurgeCatalog = { runId, sequence: 0, startedAt: observation.observedAt, state: { kind: 'complete', at: now },
      categories: { nfl: { kind: 'collected', at: observation.observedAt }, ncaaf: { kind: 'collected', at: observation.observedAt } },
      events: [event], rejectedGames: [], catalogIssues: [] };
    return sportsurgeCandidates({ current: { catalog: value, receivedAt: now }, previous: null, lastComplete: null, games: list, now: at });
  };
  assert.equal(catalog(original, [games[3]], now).length, 2);
  assert.equal(catalog(original, [games[3], repeated], now).length, 0);
  assert.equal(catalog(contextual, [contextualGame], now).length, 0);
  assert.equal(catalog({ ...original, league: 'nfl' }, [games[3]], now).length, 0);
  assert.equal(catalog(dated, [games[3]], now).length, 0);
  assert.equal(catalog(original, [{ ...games[3], lifecycle: 'final', status: 'post' }], now).length, 0);
  assert.equal(catalog(original, [{ ...games[3], date: new Date(now + 2 * 86_400_000).toISOString() }], now).length, 0);
  assert.equal(catalog(original, [{ ...games[3], date: undefined }], now).length, 0);
  assert.equal(catalog({ ...original, observedAt: now - 30 * 60_000 }, [games[3]], now).length, 0);
  assert.equal(catalog({ ...original, observedAt: now + 60_001 }, [games[3]], now).length, 0);
  assert.equal(catalog(original, [games[3]], now + 31 * 60_000).length, 0);
});
