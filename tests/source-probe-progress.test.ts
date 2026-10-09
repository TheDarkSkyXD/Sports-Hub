import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Candidate, Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-03T21:00:00Z');
const matchups = [
  ['Aardvarks', 'Badgers'], ['Cougars', 'Dragons'], ['Eagles', 'Falcons'],
  ['Gophers', 'Huskies'], ['Iguanas', 'Jaguars'],
];
const games: Game[] = Array.from({ length: 5 }, (_, index) => ({
  id: String(index + 1), league: 'nfl', name: `${matchups[index][0]} at ${matchups[index][1]}`,
  date: new Date(at).toISOString(),
  home: { name: matchups[index][1], short: matchups[index][1], abbreviation: matchups[index][1].slice(0,3), color: '112233', score: '0' },
  away: { name: matchups[index][0], short: matchups[index][0], abbreviation: matchups[index][0].slice(0,3), color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
}));

for (const late of [false, true]) test(late
  ? 'a newly discovered direct feed starts while four event-page probes are pending'
  : 'a direct live feed starts alongside four slow event-page feeds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-probe-progress-'));
  const source = { id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' };
  const observations: Observation[] = games.map((game, index) => ({
    id: `listing-${index}`, sourceId: source.id, url: `https://fixture.example/detail/${index}`,
    title: game.name, league: 'nfl', teams: [game.away.name, game.home.name],
    kickoff: at, rawTime: '', observedAt: at, parserVersion: 1,
  }));
  const started: string[] = [];
  const aborted: string[] = [];
  const pending: Array<{ signal: AbortSignal; resolve: () => void }> = [];
  let now = at;
  let visibleCount = late ? 4 : 5;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => now, sources: [source],
    readSchedule: async partition => ({ games: partition.id === 'nfl' ? games.slice(0, visibleCount) : [], league: partition.league, at: now }),
    readHtml: async () => '<div>fixture</div>',
    parseListings: () => ({ outcome: 'parsed', observations: observations.slice(0, visibleCount) }),
    enrichObservation: value => value,
    compatiblePlayers: (gameId, observation): Candidate[] => [{
      id: gameId === '5' ? 'gooz-direct' : `event-page-${gameId}`,
      gameId, label: 'Server', sourceIds: [observation.sourceId], observedAt: at,
      locator: gameId === '5' ? { provider: 'gooz', playerId: '5' } : {
        provider: 'event-page', gameId,
        eventUrl: observation.url,
        serverUrl: `https://fixture.example/server/${gameId}`,
      },
    }],
    probeCandidate: async (locator, signal) => {
      started.push(locator.provider);
      await new Promise<void>(resolve => {
        pending.push({ signal, resolve });
        signal.addEventListener('abort', () => {
          aborted.push(locator.provider);
          if (!late) resolve();
        }, { once: true });
      });
      return { kind: 'playable', proof: 'media' };
    },
  });
  try {
    await coordinator.refresh(true);
    for (let attempt = 0; started.length < (late ? 4 : 5) && attempt < 100; attempt++)
      await new Promise<void>(resolve => setImmediate(resolve));
    if (late) {
      assert.deepEqual(started, ['event-page', 'event-page', 'event-page', 'event-page']);
      visibleCount = 5;
      now += 300_001;
      await coordinator.refresh(true);
      assert.deepEqual(aborted, []);
      for (let index = 0; index < 3; index++)
        assert.deepEqual(await coordinator.command({ kind: 'check-sources', gameIds: ['5'], retry: false }), { kind: 'ok' });
      assert.deepEqual(aborted, []);
      for (let attempt = 0; started.length < 5 && attempt < 100; attempt++)
        await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(started, ['event-page', 'event-page', 'event-page', 'event-page', 'gooz']);
      const reply = await coordinator.command({ kind: 'sources' });
      assert.equal(reply.kind, 'sources');
      if (reply.kind === 'sources') assert.deepEqual(reply.snapshot.games.slice(0, 5).map(game =>
        game.candidates[0]?.availability.kind), ['checking', 'checking', 'checking', 'checking', 'checking']);
    } else {
      assert.equal(started.length,5);
      assert.equal(started.filter(provider=>provider==='gooz').length,1);
      assert.deepEqual(aborted,[]);
    }
  } finally {
    for (const job of pending) job.resolve();
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a requested game admits two servers while a background game holds its first check', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-requested-probe-'));
  const scheduled: Game[] = Array.from({ length: 1 }, (_, index) => ({
    ...games[0], id: String(1000 + index), name: `Away ${index} at Home ${index}`,
    away: { ...games[0].away, name: `Away ${index}` }, home: { ...games[0].home, name: `Home ${index}` },
    status: 'pre', lifecycle: 'scheduled', date: new Date(at + 3_600_000).toISOString(), detail: 'Scheduled',
  }));
  const target: Game = { ...scheduled[0], id: '90000', name: 'Requested Away at Requested Home',
    away: { ...scheduled[0].away, name: 'Requested Away' }, home: { ...scheduled[0].home, name: 'Requested Home' } };
  const newBackground: Game = { ...scheduled[0], id: '80000', name: 'New Away at New Home',
    away: { ...scheduled[0].away, name: 'New Away' }, home: { ...scheduled[0].home, name: 'New Home' } };
  const source = { id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' };
  let now = at;
  let includeTarget = false;
  const observation = (game: Game): Observation => ({
    id: `listing-${game.id}`, sourceId: source.id, url: `https://fixture.example/detail/${game.id}`,
    title: game.name, league: 'nfl', teams: [game.away.name, game.home.name],
    kickoff: Date.parse(game.date || ''), rawTime: '', observedAt: game.id === scheduled[0].id ? at : now, parserVersion: 1,
  });
  const calls: string[] = [];
  const pending: Array<{ id: string; resolve: () => void }> = [];
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => now, sources: [source],
    readSchedule: async partition => ({ games: partition.id === 'nfl' ? includeTarget ? [newBackground, ...scheduled, target] : scheduled : [],
      league: partition.league, at: now }),
    readHtml: async () => '<div>fixture</div>',
    parseListings: () => ({ outcome: 'parsed', observations: (includeTarget ? [newBackground, ...scheduled, target] : scheduled).map(observation) }),
    enrichObservation: value => value,
    compatiblePlayers: (gameId, listing): Candidate[] => (gameId === target.id ? Array.from({ length: 5 }, (_, index) => 90_000 + index) :
      gameId === newBackground.id ? [80_000] : Array.from({ length: 300 }, (_, index) => 10_000 + index))
      .map(number => ({ id: `server-${number}`, gameId, label: 'Server', sourceIds: [listing.sourceId],
        observedAt: listing.observedAt, locator: { provider: 'gooz', playerId: String(number) } })),
    probeCandidate: async (locator, signal) => {
      assert.equal(locator.provider, 'gooz');
      const id = locator.provider === 'gooz' ? locator.playerId : '';
      calls.push(id);
      await new Promise<void>(resolve => {
        pending.push({ id, resolve });
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { kind: 'playable', proof: 'media' };
    },
  });
  try {
    await coordinator.refresh(true);
    for (let attempt = 0; calls.length < 1 && attempt < 100; attempt++)
      await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    const full = await coordinator.command({ kind: 'sources' });
    assert.equal(full.kind, 'sources');
    if (full.kind === 'sources') assert.equal(full.snapshot.games.find(game => game.gameId === scheduled[0].id)?.candidates.filter(candidate =>
      candidate.availability.kind === 'checking').length, 1);
    includeTarget = true;
    now += 300_001;
    await coordinator.refresh(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      const reply = await coordinator.command({ kind: 'sources' });
      if (reply.kind === 'sources' && reply.snapshot.games.some(game => game.gameId === target.id && game.candidates.length)) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const populated = await coordinator.command({ kind: 'sources' });
    assert.equal(populated.kind, 'sources');
    if (populated.kind === 'sources') {
      assert.equal(populated.snapshot.games.find(game => game.gameId === scheduled[0].id)?.candidates.filter(candidate =>
        candidate.availability.kind === 'checking').length, 1);
      assert.deepEqual(populated.snapshot.games.find(game => game.gameId === target.id)?.candidates.map(candidate =>
        candidate.availability.kind), ['checking', 'unknown', 'unknown', 'unknown', 'unknown']);
    }
    assert.deepEqual(await coordinator.command({ kind: 'check-sources', gameIds: [target.id], retry: false }), { kind: 'ok' });
    const requested = await coordinator.command({ kind: 'sources' });
    assert.equal(requested.kind, 'sources');
    if (requested.kind === 'sources') {
      assert.equal(requested.snapshot.games.find(game => game.gameId === scheduled[0].id)?.candidates.filter(candidate =>
        candidate.availability.kind === 'checking').length, 1);
      assert.deepEqual(requested.snapshot.games.find(game => game.gameId === target.id)?.candidates.map(candidate =>
        candidate.availability.kind), ['checking', 'checking', 'unknown', 'unknown', 'unknown']);
    }
    for (let attempt = 0; !calls.includes('90001') && attempt < 100; attempt++)
      await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.includes('90000'), true);
    assert.equal(calls.includes('90001'), true);
  } finally {
    for (const job of pending) job.resolve();
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
