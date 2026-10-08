import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Game, SportsurgeCatalog, StreameastCatalog } from '../lib/football/shared.ts';

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

function catalog(sequence: number, eventGame: Game | undefined, eventUrl = 'https://v2.sportsurge.net/watch-22222-nfl-football/'): SportsurgeCatalog {
  const observedAt = at + sequence * 1000;
  return {
    runId: '11111111-1111-4111-8111-111111111111', sequence, startedAt: at,
    state: sequence === 1 && !eventGame ? { kind: 'complete', at: observedAt } : { kind: 'collecting' },
    categories: { nfl: { kind: 'collected', at: observedAt }, ncaaf: { kind: 'collected', at: observedAt } },
    events: eventGame ? [{ id: 'nfl:22222', url: eventUrl,
      league: 'nfl', title: eventGame.name, teams: [eventGame.away.name, eventGame.home.name], kickoff,
      sourceStatus: 'upcoming', advertisedLinkCount: 1,
      detail: { kind: 'collected', at: observedAt, providers: [{ id: 'same-route', label: 'Same route', observedAt,
        destination: { kind: 'link', url: 'https://media.example/shared-route' } }] } }] : [],
    rejectedGames: [], catalogIssues: [],
  };
}

function streameastCatalog(sequence: number, eventGame: Game | undefined, externalGameId: string | null = null): StreameastCatalog {
  const observedAt = at + sequence * 1000;
  return {
    runId: '11111111-1111-4111-8111-111111111111', sequence, startedAt: at,
    state: { kind: 'collecting' },
    categories: { nfl: { kind: 'collected', at: observedAt }, ncaaf: { kind: 'collected', at: observedAt } },
    events: eventGame ? [{ id: 'nfl:22222', url: 'https://v2.streameast.ga/nfl/football/',
      league: 'nfl', title: eventGame.name, teams: [eventGame.away.name, eventGame.home.name], kickoff,
      espnEventId: externalGameId, detail: { kind: 'collected', at: observedAt, servers: [{
        id: '1', label: 'Free 1', url: 'https://v2.streameast.ga/nfl/football/1',
        availability: { kind: 'free-channel', channelId: '33' },
      }] } }] : [], rejectedGames: [],
  };
}

function fixture(source: 'sportsurge-v2' | 'streameast' = 'sportsurge-v2', persistable = false) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-reassignment-retention-'));
  const path = join(directory, 'state.sqlite');
  let store = new FootballStore(path);
  store.savePartition('nfl', { games, league: 'nfl', at });
  let clock = at;
  let ids = 0;
  let holdProbes = false;
  const pending: Array<(result: CandidateProbeResult) => void> = [];
  const create = () => new FootballCoordinator({
    store, now: () => clock, id: () => `session-${++ids}`,
    schedules: [{ id: 'nfl', league: 'nfl', path: '', group: null }],
    sources: source === 'sportsurge-v2' ?
      [{ id: 'sportsurge-v2', url: 'https://v2.sportsurge.net/watch-nfl-streams/', family: 'sportsurge', kind: 'browser-catalog' }] :
      [{ id: 'streameast', url: 'https://v2.streameast.ga/nfl/', family: 'streameast', kind: 'browser-catalog' }],
    readSchedule: async () => ({ games, league: 'nfl', at: clock }),
    readSeasonMembership: async () => { throw new Error('unused'); },
    readHtml: async () => { throw new Error('unused'); },
    parseListings: () => ({ observations: [], outcome: 'empty' }),
    enrichObservation: observation => observation,
    compatiblePlayers: () => [],
    retryAfterMs: () => 0,
    persistableLocator: () => persistable,
    probeCandidate: () => holdProbes ? new Promise<CandidateProbeResult>(resolve => { pending.push(resolve); }) :
      Promise.resolve({ kind: 'playable', proof: 'media' }),
  });
  let coordinator = create();
  const snapshot = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.ok(reply.kind === 'sources');
    return reply.snapshot;
  };
  const publish = async (sequence: number, eventGame: Game | undefined, eventUrl?: string, externalGameId: string | null = null) => {
    clock = Math.max(clock, at + sequence * 1000);
    const reply = source === 'sportsurge-v2' ?
      await coordinator.command({ kind: 'sportsurge-catalog', catalog: catalog(sequence, eventGame, eventUrl) }) :
      await coordinator.command({ kind: 'streameast-catalog', catalog: streameastCatalog(sequence, eventGame, externalGameId) });
    assert.equal(reply.kind, 'catalog-ack');
    for (let turn = 0; turn < 50; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { get coordinator() { return coordinator; }, snapshot, publish,
    storedRows: () => store.workingFeeds(),
    pending,
    hold: () => { holdProbes = true; },
    async advance(elapsed: number) {
      clock = at + elapsed;
      await coordinator.refresh(true);
      for (let turn = 0; turn < 50; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    },
    async restart() {
      await coordinator.stop();
      store = new FootballStore(path);
      coordinator = create();
      await coordinator.refresh(true);
      for (let turn = 0; turn < 50; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    },
    async stop() {
      for (const resolve of pending) resolve({ kind: 'deferred', retryAfterMs: 1000 });
      await coordinator.stop();
      rmSync(directory, { recursive: true, force: true });
    } };
}

test('a fresh Sportsurge reassignment withdraws proof from the old game', async () => {
  const run = fixture();
  try {
    await run.publish(0, games[0]);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
    await run.publish(1, games[1]);
    const snapshot = await run.snapshot();
    assert.equal(snapshot.games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    assert.equal(snapshot.games.find(game => game.gameId === games[1].id)?.workingChoiceCount, 1);
    await run.advance(2000);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false })).kind, 'error');
  } finally { await run.stop(); }
});

test('a StreamEast external game ID conflict vetoes a matching date and teams', async () => {
  const run = fixture('streameast');
  try {
    await run.publish(0, games[0], undefined, '401234567');
    const snapshot = await run.snapshot();
    assert.equal(snapshot.sources.find(source => source.id === 'streameast')?.matchedGameCount, 0);
    assert.equal(snapshot.games.find(game => game.gameId === games[0].id)?.candidates.length ?? 0, 0);
    assert.equal(snapshot.streameast.current?.games[0]?.gameId, null);
    await run.advance(1000);
    const rebuilt = await run.snapshot();
    assert.equal(rebuilt.sources.find(source => source.id === 'streameast')?.matchedGameCount, 0);
    assert.equal(rebuilt.games.find(game => game.gameId === games[0].id)?.candidates.length ?? 0, 0);
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

test('a reassigned Sportsurge page awaiting details cannot republish its old game', async () => {
  const run = fixture();
  try {
    await run.publish(0, games[0]);
    const pending = catalog(1, games[1]);
    pending.runId = '22222222-2222-4222-8222-222222222222';
    pending.sequence = 0;
    pending.startedAt = at + 1000;
    pending.events[0].detail = { kind: 'pending' };
    assert.equal((await run.coordinator.command({ kind: 'sportsurge-catalog', catalog: pending })).kind, 'catalog-ack');
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    await run.advance(2000);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false })).kind, 'error');
  } finally { await run.stop(); }
});

test('a fresh StreamEast reassignment withdraws proof from the old game', async () => {
  const run = fixture('streameast');
  try {
    await run.publish(0, games[0]);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
    await run.publish(1, games[1]);
    const snapshot = await run.snapshot();
    assert.equal(snapshot.games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    await run.advance(2000);
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false })).kind, 'error');
  } finally { await run.stop(); }
});

test('a distinct Sportsurge event URL with the same event ID does not revoke the original route', async () => {
  const run = fixture();
  try {
    await run.publish(0, games[0]);
    await run.publish(1, games[1], 'https://v2.sportsurge.net/watch-22222-nfl-second-football/');
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
  } finally { await run.stop(); }
});

test('a reassigned durable route stays withdrawn after restart and old viewer evidence', async () => {
  const run = fixture('sportsurge-v2', true);
  try {
    await run.publish(0, games[0]);
    assert.equal(run.storedRows().length, 1);
    const opened = await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false });
    assert.ok(opened.kind === 'playback');
    await run.publish(1, games[1]);
    assert.equal((await run.coordinator.command({ kind: 'playback-evidence', sessionId: opened.playback.session.id,
      candidateId: opened.playback.session.candidateId, generation: 0,
      evidence: { kind: 'decoded', startupMs: 100 } })).kind, 'error');
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    await run.restart();
    assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false })).kind, 'error');
  } finally { await run.stop(); }
});

for (const result of [{ kind: 'playable', proof: 'media' }, { kind: 'unavailable', reason: 'invalid-media' }] as const)
  test(`a late ${result.kind} recheck cannot restore a reassigned Sportsurge route`, async () => {
    const run = fixture();
    try {
      await run.publish(0, games[0]);
      run.hold();
      await run.advance(300_000);
      assert.equal(run.pending.length, 1);
      assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount, 1);
      const oldResult = run.pending[0];
      await run.publish(1, games[1]);
      oldResult(result);
      for (let turn = 0; turn < 50; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await run.snapshot()).games.find(game => game.gameId === games[0].id)?.workingChoiceCount ?? 0, 0);
    } finally { await run.stop(); }
  });
