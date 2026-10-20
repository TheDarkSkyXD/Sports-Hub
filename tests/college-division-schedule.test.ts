import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { SCHEDULES, createFixtureSchedule } from '../lib/football/adapters/schedule.ts';
import {enqueueSchedule,enqueueMembership,waitForSchedule} from './schedule-fixture.ts';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { recordFinal } from '../lib/football/domain/lifecycle.ts';
import { detailIdentity } from '../lib/football/domain/source-policy.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { GameSchema, SeasonMembershipSchema, isMatchupGame } from '../lib/football/shared.ts';
import { parseScoreboard } from '../lib/sunday.ts';
import type { Game, Observation, SeasonMembership } from '../lib/football/shared.ts';

const fixture = z.object({
  capturedAt: z.string().datetime(),
  scoreboards: z.record(z.object({ current: z.array(z.unknown()), future: z.object({ events: z.array(z.unknown()) }).optional() })),
  memberships: z.record(z.array(z.string())),
  crossDivision: z.object({ event: z.unknown() }),
}).parse(JSON.parse(readFileSync(new URL('./fixtures/espn-college-divisions-20261017.json', import.meta.url), 'utf8')));
const at = Date.parse(fixture.capturedAt);
const partitions = [
  { id: 'fbs', league: 'ncaaf', path: 'college-football', group: '80' },
  { id: 'fcs', league: 'ncaaf', path: 'college-football', group: '81' },
  { id: 'd2-d3', league: 'ncaaf', path: 'college-football', group: '35' },
] as const;
function currentGames(group: string, partition: string): Game[] {
  return parseScoreboard({ events: fixture.scoreboards[group].current }, 'ncaaf').map(game =>
    GameSchema.parse(game.lifecycle === 'final' ? recordFinal({ ...game, partitions: [partition] }, at) : { ...game, partitions: [partition] }));
}
function membership(includeLower: boolean): SeasonMembership {
  return SeasonMembershipSchema.parse({ season: 2026, at, teams: Object.fromEntries(partitions
    .filter(partition => includeLower || partition.id !== 'd2-d3')
    .flatMap(partition => fixture.memberships[partition.group].map(id => [id, partition.id]))) });
}
const drain = async () => { for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('official Division II/III games use one partition with current and seven-day schedule coverage', async () => {
  const lower = SCHEDULES.find(partition => partition.id === 'd2-d3');
  assert.ok(lower, 'Division II/III must be included in the default NCAA schedules');
  const schedule=createFixtureSchedule();
  enqueueSchedule(schedule,lower,at,url=>{
    assert.equal(url.searchParams.get('groups'), '35');
    assert.equal(url.searchParams.get('limit'), '200');
    const day = url.searchParams.get('dates') || '';
    return {body:JSON.stringify({ events: day === '20261017' ? fixture.scoreboards['35'].current
      : day === '20261024' ? fixture.scoreboards['35'].future?.events : [] }),...(day==='20261017'?{gate:'current'}:{})};
  });
  try {
    const early: string[][] = [];
    const pending=schedule.readSchedule(lower, at, new AbortController().signal, current => early.push(current.games.map(game => game.id)));
    await waitForSchedule(()=>schedule.fixtureRequests().some(request=>new URL(request.url).searchParams.get('dates')==='20261016'));
    schedule.releaseFixtureGate('current');
    const result=await pending;
    const days=schedule.fixtureRequests().flatMap(request=>{const day=new URL(request.url).searchParams.get('dates');return day?[day]:[];});
    assert.deepEqual(early, [['ncaaf-401906940', 'ncaaf-401907890', 'ncaaf-401867961']]);
    assert.deepEqual(result.games.map(game => [game.id, game.partitions]), [
      ['ncaaf-401906940', ['d2-d3']], ['ncaaf-401907890', ['d2-d3']], ['ncaaf-401867961', ['d2-d3']], ['ncaaf-401908561', ['d2-d3']],
    ]);
    assert.deepEqual(days.sort(), ['20261016', '20261017', '20261018', '20261019', '20261020', '20261021', '20261022', '20261023', '20261024']);
  } finally { schedule.releaseFixtureGate('current');schedule.close(); }
});

test('a fresh official cross-division partition keeps its feed eligible while lower-division coverage reports stale', async () => {
  const parsed = parseScoreboard({ events: [fixture.crossDivision.event] }, 'ncaaf')[0];
  const current = GameSchema.parse(parsed.lifecycle === 'final' ? recordFinal(parsed, at) : parsed);
  assert.ok(isMatchupGame(current));
  for (const state of ['fresh-fcs', 'fresh-lower', 'failed-fcs', 'all-stale', 'unrelated-fresh'] as const) {
    const store = new FootballStore(':memory:');
    const earlier = state === 'fresh-lower' || state === 'failed-fcs'
      ? { ...current, date: '2026-10-17T19:00Z', status: 'pre' as const, lifecycle: 'scheduled' as const, detail: 'Scheduled' }
      : current;
    store.savePartition('fcs', { games: [{ ...earlier, partitions: ['fcs'] }], at: state === 'fresh-fcs' ? at : state === 'failed-fcs' ? at - 1_000 : at - 90_001 });
    store.savePartition('d2-d3', { games: [{ ...current, partitions: ['d2-d3'] }], at: state === 'fresh-lower' ? at : state === 'failed-fcs' ? at - 2_000 : at - 90_001 });
    store.savePartition('fbs', { games: currentGames('80', 'fbs'), at: state === 'all-stale' ? at - 90_001 : at });
    const observation: Observation = { id: 'cross-division', sourceId: 'fixture', url: 'https://fixture.example/game', title: current.name,
      teams: [current.away.name, current.home.name], league: 'ncaaf',
      kickoff: Date.parse(current.date || ''), rawTime: '', observedAt: at, parserVersion: 1 };
    store.observe(observation, { kind: 'matched', gameId: current.id });
    store.saveDetailEvidence({ outcome: 'resolved', observationId: observation.id, generation: 'captured',
      identity: detailIdentity(observation), at, nextEligibleAt: at + 30 * 60_000,
      players: [{ id: 'cross-feed', label: 'Published feed', locator: { provider: 'gooz', playerId: '123' } }] });
    const coordinator = new FootballCoordinator({ store, now: () => at, schedules: partitions,
      sources: [{ id: 'fixture', name: 'Fixture', url: 'https://fixture.example/', family: 'fixture', parserVersion: 1 }],
      readSchedule: (partition, _now, signal) => state === 'failed-fcs' && partition.id === 'fcs'
        ? Promise.reject(new Error('schedule-unavailable')) : new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
      }),
      readSeasonMembership: async () => membership(false), readHtml: async () => '',
      parseListings: () => ({ outcome: 'parsed', observations: [] }), enrichObservation: value => value,
      compatiblePlayers: () => [], tvappPlayers: () => [], probeCandidate: async () => ({ kind: 'deferred', retryAfterMs: 30_000 }),
      probeIdentity: locator => JSON.stringify(locator), persistableLocator: locator => locator, retryAfterMs: () => 0,
      id: () => 'fixture-session',
    });
    try {
      if (state === 'failed-fcs') { await coordinator.command({ kind: 'board' }); await drain(); }
      const board = await coordinator.command({ kind: 'board' });
      assert.equal(board.kind, 'board');
      if (board.kind !== 'board') return;
      assert.equal(board.board.games.filter(game => game.id === 'ncaaf-401867961').length, 1);
      assert.deepEqual(board.board.games.find(game => game.id === 'ncaaf-401867961')?.partitions?.toSorted(), ['d2-d3', 'fcs']);
      assert.equal(board.board.games.find(game => game.id === 'ncaaf-401867961')?.date, '2026-10-17T19:30Z');
      assert.equal(board.board.games.find(game => game.id === 'ncaaf-401867961')?.lifecycle, current.lifecycle);
      const sources = await coordinator.command({ kind: 'sources' });
      assert.equal(sources.kind, 'sources');
      if (sources.kind === 'sources') assert.deepEqual(sources.snapshot.games.find(game => game.gameId === current.id)?.candidates.map(candidate => candidate.id) || [],
        state === 'fresh-fcs' || state === 'fresh-lower' || state === 'failed-fcs' ? ['cross-feed'] : [], state);
      assert.ok(board.board.leagues.ncaaf.errors.some(error => error.includes(state === 'fresh-lower' || state === 'failed-fcs' ? 'FCS' : 'D2-D3')));
    } finally { await coordinator.stop(); }
  }
});

test('membership validates all 407 combined members without overlapping FBS or FCS', async () => {
  const schedule=createFixtureSchedule();
  enqueueMembership(schedule,2026,group=>{
    const ids = fixture.memberships[group];
    return { count: ids.length, pageCount: 1, pageIndex: 1,
      items: ids.map(id => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/teams/${id}` })) };
  });
  try {
    const value = SeasonMembershipSchema.parse(await schedule.readSeasonMembership(2026, new AbortController().signal));
    const requested=schedule.fixtureRequests().map(request=>/\/groups\/(\d+)\/teams/.exec(request.url)?.[1]);
    assert.deepEqual(requested, ['80', '81', '35']);
    assert.equal(Object.values(value.teams).filter(group => group === 'fbs').length, 148);
    assert.equal(Object.values(value.teams).filter(group => group === 'fcs').length, 130);
    assert.equal(Object.values(value.teams).filter(group => group === 'd2-d3').length, 407);
    assert.equal(Object.keys(value.teams).length, 685);
  } finally { schedule.close(); }
});

test('cached boards include both lower divisions before legacy membership refresh settles and persist the upgrade', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'college-divisions-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let finish: (value: SeasonMembership) => void = () => {};
  const pending = new Promise<SeasonMembership>(resolve => { finish = resolve; });
  let membershipReads = 0;
  const seed = new FootballStore(path);
  for (const partition of partitions) seed.savePartition(partition.id, { games: currentGames(partition.group, partition.id), at });
  seed.saveMembership(membership(false));
  seed.close();
  const coordinator = createFootballCoordinator(path, { now: () => at, schedules: partitions, sources: [],
    readSchedule: async partition => ({ games: currentGames(partition.group || '', partition.id), league: 'ncaaf', at }),
    readSeasonMembership: async () => { membershipReads++; return pending; },
  });
  try {
    const refreshing = coordinator.refresh(true);
    await drain();
    const early = await coordinator.command({ kind: 'board' });
    assert.equal(early.kind, 'board');
    if (early.kind !== 'board') return;
    assert.deepEqual(early.board.games.map(game => game.id).sort(), ['ncaaf-401856809', 'ncaaf-401867961', 'ncaaf-401867993', 'ncaaf-401906940', 'ncaaf-401907890']);
    assert.equal(early.board.leagues.ncaaf.scoresAt, new Date(at).toISOString());
    assert.deepEqual(early.board.leagues.ncaaf.errors, []);
    assert.equal(membershipReads, 1, 'fresh legacy membership must not hide the newly supported division');
    finish(membership(true));
    await refreshing;
    const upgraded = await coordinator.command({ kind: 'board' });
    assert.equal(upgraded.kind, 'board');
    if (upgraded.kind !== 'board') return;
    const lower = upgraded.board.games.filter(game => game.partitions?.includes('d2-d3'));
    assert.deepEqual(lower.map(game => isMatchupGame(game) ? [game.home.membership?.subdivision, game.away.membership?.subdivision] : []),
      [['fcs', 'd2-d3'], ['d2-d3', 'd2-d3'], ['d2-d3', 'd2-d3']]);
  } finally { finish(membership(false)); await coordinator.stop(); }
  const restored = createFootballCoordinator(path, { now: () => at, schedules: partitions, sources: [],
    readSchedule: async partition => ({ games: currentGames(partition.group || '', partition.id), league: 'ncaaf', at }),
    readSeasonMembership: async () => { throw new Error('fresh upgraded membership must be reused'); },
  });
  try {
    await restored.refresh(true);
    const board = await restored.command({ kind: 'board' });
    assert.equal(board.kind, 'board');
    if (board.kind === 'board') {
      assert.deepEqual(board.board.leagues.ncaaf.errors, []);
      assert.equal(board.board.games.filter(game => game.partitions?.includes('d2-d3')).length, 3);
    }
  } finally { await restored.stop(); }
});
