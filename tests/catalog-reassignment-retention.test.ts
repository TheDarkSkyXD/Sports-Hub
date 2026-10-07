import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import type { Game, SportsurgeCatalog } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-03T20:00:00Z');
const kickoff = at + 60 * 60_000;
const team = (name: string) => ({ name, short: name, abbreviation: name.slice(0, 3), color: '112233', score: '0' });
const games: Game[] = [
  { id: 'game-a', league: 'nfl', name: 'Kansas City Chiefs at Buffalo Bills', date: new Date(kickoff).toISOString(),
    away: team('Kansas City Chiefs'), home: team('Buffalo Bills'), status: 'pre', lifecycle: 'scheduled',
    detail: '', redzone: false, partitions: ['nfl'] },
  { id: 'game-b', league: 'nfl', name: 'Denver Broncos at San Francisco 49ers', date: new Date(kickoff).toISOString(),
    away: team('Denver Broncos'), home: team('San Francisco 49ers'), status: 'pre', lifecycle: 'scheduled',
    detail: '', redzone: false, partitions: ['nfl'] },
];

function catalog(sequence: number, eventGame: Game | undefined): SportsurgeCatalog {
  const observedAt = at + sequence * 1000;
  return {
    runId: '11111111-1111-4111-8111-111111111111', sequence, startedAt: at,
    state: sequence === 1 && !eventGame ? { kind: 'complete', at: observedAt } : { kind: 'collecting' },
    categories: { nfl: { kind: 'collected', at: observedAt }, ncaaf: { kind: 'collected', at: observedAt } },
    events: eventGame ? [{ id: 'nfl:22222', url: 'https://v2.sportsurge.net/watch-22222-nfl-football/',
      league: 'nfl', title: eventGame.name, teams: [eventGame.away.name, eventGame.home.name], kickoff,
      sourceStatus: 'upcoming', advertisedLinkCount: 1,
      detail: { kind: 'collected', at: observedAt, providers: [{ id: 'same-route', label: 'Same route', observedAt,
        destination: { kind: 'link', url: 'https://media.example/shared-route' } }] } }] : [],
    rejectedGames: [], catalogIssues: [],
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-reassignment-retention-'));
  const store = new FootballStore(join(directory, 'state.sqlite'));
  store.savePartition('nfl', { games, league: 'nfl', at });
  let clock = at;
  let ids = 0;
  const coordinator = new FootballCoordinator({
    store, now: () => clock, id: () => `session-${++ids}`,
    schedules: [{ id: 'nfl', league: 'nfl', path: '', group: null }],
    sources: [{ id: 'sportsurge-v2', url: 'https://v2.sportsurge.net/watch-nfl-streams/', family: 'sportsurge', kind: 'browser-catalog' }],
    readSchedule: async () => ({ games, league: 'nfl', at: clock }),
    readSeasonMembership: async () => { throw new Error('unused'); },
    readHtml: async () => { throw new Error('unused'); },
    parseListings: () => ({ observations: [], outcome: 'empty' }),
    enrichObservation: observation => observation,
    compatiblePlayers: () => [],
    retryAfterMs: () => 0,
    persistableLocator: () => false,
    probeCandidate: async () => ({ kind: 'playable', proof: 'media' }),
  });
  const snapshot = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.ok(reply.kind === 'sources');
    return reply.snapshot;
  };
  const publish = async (sequence: number, eventGame: Game | undefined) => {
    clock = at + sequence * 1000;
    assert.equal((await coordinator.command({ kind: 'sportsurge-catalog', catalog: catalog(sequence, eventGame) })).kind, 'catalog-ack');
    for (let turn = 0; turn < 50; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { coordinator, snapshot, publish, async stop() { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

test('a fresh Sportsurge reassignment withdraws proof from the old game', async () => {
  const run = fixture();
  try {
    await run.publish(0, games[0]);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
    await run.publish(1, games[1]);
    const snapshot = await run.snapshot();
    assert.equal(snapshot.games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false })).kind, 'error');
  } finally { await run.stop(); }
});

test('a missing Sportsurge event preserves its last proven game', async () => {
  const run = fixture();
  try {
    await run.publish(0, games[0]);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
    await run.publish(1, undefined);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false })).kind, 'playback');
  } finally { await run.stop(); }
});
