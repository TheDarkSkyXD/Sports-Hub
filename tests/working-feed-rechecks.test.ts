import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Game } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const live: Game = {
  id: '10001', league: 'nfl', name: 'Denver Broncos at San Francisco 49ers',
  date: new Date(at).toISOString(), lifecycle: 'live', status: 'in', detail: 'Q1',
  redzone: false, partitions: ['nfl'],
  home: { name: 'San Francisco 49ers', short: '49ers', abbreviation: 'SF', color: '112233', score: '0' },
  away: { name: 'Denver Broncos', short: 'Broncos', abbreviation: 'DEN', color: '332211', score: '0' },
};

async function drain() {
  for (let index = 0; index < 40; index++) await new Promise<void>(resolve => setImmediate(resolve));
}

function fixture(options: { game?: Game; count?: number; persistable?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'working-feed-rechecks-'));
  const path = join(directory, 'state.sqlite');
  let clock = at;
  let game = options.game ?? live;
  let holdRechecks = false;
  let nextResult: CandidateProbeResult = { kind: 'playable', proof: 'media' };
  const calls: string[] = [];
  const pending = new Map<string, (result: CandidateProbeResult) => void>();
  const start = () => createFootballCoordinator(path, {
    now: () => clock,
    schedules: [{ id: 'nfl', league: 'nfl', path: '/fixture', group: null }],
    sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async () => ({ games: [game], league: 'nfl', at: clock }),
    readHtml: async () => '<main>fixture</main>',
    parseListings: () => ({ outcome: 'parsed', observations: [{
      id: 'event-10001', sourceId: 'fixture', url: 'https://fixture.example/event/10001',
      title: game.name, league: 'nfl', teams: [game.away.name, game.home.name],
      kickoff: Date.parse(game.date!), rawTime: '', observedAt: clock, parserVersion: 2,
    }] }),
    enrichObservation: value => value,
    persistableLocator: () => options.persistable ?? true,
    compatiblePlayers: () => Array.from({ length: options.count ?? 1 }, (_, index) => ({
      id: `route-${index}`, label: `Route ${index}`, locator: { provider: 'gooz' as const, playerId: String(index + 100) },
    })),
    probeCandidate: locator => {
      assert.equal(locator.provider, 'gooz');
      if (locator.provider !== 'gooz') throw new Error('Expected gooz locator');
      calls.push(locator.playerId);
      if (!holdRechecks || calls.filter(id => id === locator.playerId).length === 1) return Promise.resolve(nextResult);
      return new Promise<CandidateProbeResult>(resolve => { pending.set(locator.playerId, resolve); });
    },
  });
  const snapshot = async (coordinator: ReturnType<typeof start>) => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected sources');
    return reply.snapshot;
  };
  const rows = () => {
    const db = new DatabaseSync(path);
    try { return db.prepare('SELECT payload FROM working_feeds').all(); }
    finally { db.close(); }
  };
  return {
    calls, pending, rows, snapshot, start,
    hold: () => { holdRechecks = true; },
    setResult: (result: CandidateProbeResult) => { nextResult = result; },
    setGame: (value: Game) => { game = value; },
    setClock: (elapsed: number) => { clock = at + elapsed; },
    async refresh(coordinator: ReturnType<typeof start>, elapsed: number) {
      clock = at + elapsed;
      await coordinator.refresh(true);
      await drain();
    },
    release(id: string, result: CandidateProbeResult) {
      const resolve = pending.get(id);
      assert.ok(resolve, `Expected pending probe ${id}`);
      pending.delete(id);
      resolve(result);
    },
    async stop(coordinator: ReturnType<typeof start>) {
      for (const resolve of pending.values()) resolve({ kind: 'deferred', retryAfterMs: 1000 });
      pending.clear();
      await coordinator.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a due working feed is rechecked at five minutes while playback stays on its proven route', async () => {
  const run = fixture();
  const coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    run.hold();
    await run.refresh(coordinator, 299_999);
    assert.deepEqual(run.calls, ['100']);
    const opened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at });
    await run.refresh(coordinator, 300_000);
    assert.deepEqual(run.calls, ['100', '100']);
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at });
    const continuing = await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id, generation: 0,
      failure: false, retry: false });
    assert.equal(continuing.kind, 'session');
    if (continuing.kind === 'session') assert.equal(continuing.session.candidateId, opened.playback.session.candidateId);
    run.release('100', { kind: 'playable', proof: 'media' });
    await drain();
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at + 300_000 });
    assert.equal(run.rows().length, 1);
  } finally { await run.stop(coordinator); }
});

test('a playable route without durable proof is still rechecked at the saved interval', async () => {
  const run = fixture({ persistable: false });
  const coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    assert.equal(run.rows().length, 0);
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at });
    await run.refresh(coordinator, 299_999);
    assert.deepEqual(run.calls, ['100']);
    await run.refresh(coordinator, 300_000);
    assert.deepEqual(run.calls, ['100', '100']);
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at + 300_000 });
    assert.equal(run.rows().length, 0);
  } finally { await run.stop(coordinator); }
});

test('a failed recheck removes durable proof and the route recovers on its next interval', async () => {
  const run = fixture();
  const coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    assert.equal(run.rows().length, 1);
    run.hold();
    await run.refresh(coordinator, 300_000);
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at });
    run.release('100', { kind: 'unavailable', reason: 'invalid-media' });
    await drain();
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'unavailable', reason: 'invalid-media', checkedAt: at + 300_000, retryAt: at + 600_000 });
    assert.equal(run.rows().length, 0);
    await run.refresh(coordinator, 599_999);
    assert.deepEqual(run.calls, ['100', '100']);
    await run.refresh(coordinator, 600_000);
    assert.deepEqual(run.calls, ['100', '100', '100']);
    run.release('100', { kind: 'playable', proof: 'media' });
    await drain();
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at + 600_000 });
    assert.equal(run.rows().length, 1);
  } finally { await run.stop(coordinator); }
});

test('a deferred recheck retains playable proof and does not immediately retry', async () => {
  const run = fixture();
  const coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    run.hold();
    await run.refresh(coordinator, 300_000);
    run.release('100', { kind: 'deferred', retryAfterMs: 30_000 });
    await drain();
    await run.refresh(coordinator, 300_001);
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'media', checkedAt: at });
    assert.equal(run.rows().length, 1);
    assert.deepEqual(run.calls, ['100', '100']);
  } finally { await run.stop(coordinator); }
});

test('decoded playback wins over an active working-feed recheck', async () => {
  const run = fixture();
  const coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    await run.refresh(coordinator, 299_999);
    const opened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    run.hold();
    await run.refresh(coordinator, 300_000);
    assert.deepEqual(run.calls, ['100', '100']);
    const session = opened.playback.session;
    const reply = await coordinator.command({ kind: 'playback-evidence', sessionId: session.id,
      candidateId: session.candidateId, generation: 0, evidence: { kind: 'decoded', startupMs: 100 } });
    assert.equal(reply.kind, 'ok');
    run.release('100', { kind: 'unavailable', reason: 'invalid-media' });
    await drain();
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates[0].availability,
      { kind: 'playable', proof: 'decoded', checkedAt: at + 300_000 });
    assert.equal(run.rows().length, 1);
  } finally { await run.stop(coordinator); }
});

test('decoded playback removes its queued recheck while other due routes proceed', async () => {
  const run = fixture({ count: 6 });
  const coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    run.hold();
    await run.refresh(coordinator, 300_000);
    assert.deepEqual(run.calls, ['100', '101', '102', '103', '104', '105', '100', '101', '102', '103']);
    const opened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false,
      initialCandidateId: 'route-4' });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    const session = opened.playback.session;
    const reply = await coordinator.command({ kind: 'playback-evidence', sessionId: session.id,
      candidateId: session.candidateId, generation: 0, evidence: { kind: 'decoded', startupMs: 100 } });
    assert.equal(reply.kind, 'ok');
    for (const id of [...run.pending.keys()]) run.release(id, { kind: 'playable', proof: 'media' });
    await drain();
    assert.equal(run.calls.filter(id => id === '104').length, 1);
    assert.equal(run.calls.filter(id => id === '105').length, 2);
    assert.deepEqual((await run.snapshot(coordinator)).games[0].candidates.find(row => row.id === 'route-4')?.availability,
      { kind: 'playable', proof: 'decoded', checkedAt: at + 300_000 });
  } finally { await run.stop(coordinator); }
});

test('an increased interval postpones queued working rechecks and a shorter interval survives restart', async () => {
  const run = fixture({ count: 6 });
  let coordinator = run.start();
  try {
    await run.refresh(coordinator, 0);
    assert.equal(run.rows().length, 6);
    run.hold();
    await run.refresh(coordinator, 300_000);
    assert.equal(run.pending.size, 4);
    assert.equal(run.calls.length, 10);
    assert.equal((await run.snapshot(coordinator)).games[0].workingChoiceCount, 6);
    const increased = await coordinator.command({ kind: 'set-feed-check-interval', minutes: 15 });
    assert.equal(increased.kind, 'board');
    await drain();
    const pending = [...run.pending.keys()];
    for (const id of pending) run.release(id, { kind: 'playable', proof: 'media' });
    await drain();
    await run.refresh(coordinator, 899_999);
    assert.equal(run.calls.length, 10);
    await run.refresh(coordinator, 900_000);
    assert.equal(run.calls.length, 12);
    for (const id of [...run.pending.keys()]) run.release(id, { kind: 'playable', proof: 'media' });
    await drain();
    await coordinator.stop();
    coordinator = run.start();
    const shortened = await coordinator.command({ kind: 'set-feed-check-interval', minutes: 1 });
    assert.equal(shortened.kind, 'board');
    await run.refresh(coordinator, 900_001);
    assert.equal(run.calls.length, 16);
  } finally { await run.stop(coordinator); }
});

test('today and tomorrow games recheck working feeds, but final games schedule no new probes', async () => {
  for (const days of [0, 1]) {
    const date = new Date(at + days * 86_400_000).toISOString();
    const run = fixture({ game: { ...live, date, lifecycle: 'scheduled', status: 'pre' } });
    const coordinator = run.start();
    try {
      await run.refresh(coordinator, 0);
      assert.deepEqual(run.calls, ['100']);
      await run.refresh(coordinator, 300_000);
      assert.deepEqual(run.calls, ['100', '100']);
      run.setGame({ ...live, date, lifecycle: 'final', status: 'post' });
      await run.refresh(coordinator, 600_000);
      assert.deepEqual(run.calls, ['100', '100']);
    } finally { await run.stop(coordinator); }
  }
});
