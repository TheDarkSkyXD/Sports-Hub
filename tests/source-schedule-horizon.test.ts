import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEDULES, readSchedule } from '../lib/football/adapters/schedule.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult, ScheduleResult } from '../lib/football/domain/ports.ts';
import type { Game } from '../lib/football/shared.ts';

test('future-day failures stay visible during a retry and clear after successful completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-horizon-'));
  const originalFetch = globalThis.fetch;
  const at = Date.parse('2026-10-04T18:00:00Z');
  let clock = at;
  let retry = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async input => {
    const day = new URL(String(input)).searchParams.get('dates');
    if (!retry && day === '20261005') return new Response('', { status: 503 });
    if (retry && day !== null && day > '20261004') await gate;
    return Response.json({ events: [] });
  };
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, schedules: [SCHEDULES[0]], sources: [], readSchedule,
  });
  const board = async () => {
    const reply = await coordinator.command({ kind: 'board' });
    assert.equal(reply.kind, 'board');
    if (reply.kind !== 'board') throw new Error('Expected board');
    return reply.board;
  };
  try {
    await coordinator.refresh(true);
    assert.match((await board()).leagues.nfl.errors.join(' '), /20261005:http-503/);
    retry = true;
    clock += 300_001;
    const refreshing = coordinator.refresh(true);
    try {
      for (let index = 0; index < 60; index++) {
        if ((await board()).leagues.nfl.scoresAt === new Date(clock).toISOString()) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const pending = await board();
      assert.equal(pending.leagues.nfl.scoresAt, new Date(clock).toISOString());
      assert.match(pending.leagues.nfl.errors.join(' '), /20261005:http-503/);
      assert.doesNotMatch(pending.leagues.nfl.errors.join(' '), /stale-cache/);
    } finally { release(); await refreshing; }
    assert.deepEqual((await board()).leagues.nfl.errors, []);
  } finally {
    release(); await coordinator.stop(); globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const historyState of ['pending', 'history-unavailable']) test(`an overnight live game retains its media check while history is ${historyState}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-overnight-'));
  const at = Date.parse('2026-10-11T03:00:00Z');
  let clock = at;
  let phase: 'live' | 'partial' | 'empty' = 'live';
  const game: Game = { id: 'nba-401898720', league: 'nba', name: 'Away at Home',
    date: '2026-10-11T02:30:00Z', status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nba'],
    home: { id: 'home', name: 'Home', short: 'Home', abbreviation: 'H', color: '112233', score: '0' },
    away: { id: 'away', name: 'Away', short: 'Away', abbreviation: 'A', color: '332211', score: '0' } };
  const history = Promise.withResolvers<ScheduleResult>();
  const probes: Array<{ signal: AbortSignal; result: ReturnType<typeof Promise.withResolvers<CandidateProbeResult>> }> = [];
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, schedules: [{ id: 'nba', league: 'nba', path: '/fixture', group: null }],
    sources: [{ id: 'ppv', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async (_source, _now, _signal, onCurrent) => {
      if (phase === 'partial') {
        onCurrent?.({ games: [], league: 'nba', at: clock, historyErrors: [`20261010:${historyState}`] });
        return history.promise;
      }
      return { games: phase === 'live' ? [game] : [], league: 'nba', at: clock };
    },
    readHtml: async () => '<main>fixture</main>',
    parseListings: () => ({ outcome: 'parsed', observations: [{ id: 'event', sourceId: 'ppv',
      url: 'https://fixture.example/game', title: game.name, league: 'nba', teams: ['Away', 'Home'],
      kickoff: Date.parse(game.date ?? ''), rawTime: '', observedAt: clock, parserVersion: 1 }] }),
    enrichObservation: value => value,
    compatiblePlayers: () => [{ id: 'one', label: 'One', locator: { provider: 'gooz', playerId: '1' } }],
    probeCandidate: (_locator, signal, progress) => {
      progress({ kind: 'active' });
      const result = Promise.withResolvers<CandidateProbeResult>();
      probes.push({ signal, result });
      return result.promise;
    },
  });
  const settle = async () => { for (let index = 0; index < 40; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const board = async () => {
    const reply = await coordinator.command({ kind: 'board' });
    if (reply.kind !== 'board') throw new Error('Expected board');
    return reply.board;
  };
  const sources = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    if (reply.kind !== 'sources') throw new Error('Expected sources');
    return reply.snapshot;
  };
  try {
    await coordinator.refresh(true); await settle();
    assert.equal(probes.length, 1);
    clock += 30_000;
    phase = 'partial';
    const refreshing = coordinator.refresh(true);
    await settle();
    assert.deepEqual((await board()).games.map(value => value.id), [game.id]);
    assert.equal(probes[0].signal.aborted, false);
    probes[0].result.resolve({ kind: 'playable', proof: { kind: 'advancing-video', version: 1,
      startupMs: 3000, observedMs: 3000, mediaAdvanceMs: 3000, presentedFrames: 4 } });
    await settle();
    assert.equal((await sources()).games[0].candidates[0].availability.kind, 'playable');
    phase = 'live';
    history.resolve({ games: [game], league: 'nba', at: clock });
    await refreshing;
    assert.equal((await sources()).games[0].candidates[0].availability.kind, 'playable');
    assert.equal(probes.length, 1);
    clock += 300_000;
    await coordinator.refresh(true); await settle();
    assert.equal(probes.length, 2);
    phase = 'empty';
    await coordinator.refresh(true); await settle();
    assert.deepEqual((await board()).games, []);
    assert.equal(probes[1].signal.aborted, true);
  } finally {
    phase = 'empty'; history.resolve({ games: [], league: 'nba', at: clock });
    for (const probe of probes) probe.result.resolve({ kind: 'deferred', retryAfterMs: 300_000 });
    await coordinator.stop(); rmSync(directory, { recursive: true, force: true });
  }
});
