import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { recordFinal } from '../lib/football/domain/lifecycle.ts';
import { CommandSchema, FinishedGameRetentionMinutesSchema, type Game } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const day = 24 * 60 * 60_000;
const live: Game = { id: '10001', league: 'nfl', name: 'Away at Home', date: new Date(at).toISOString(),
  lifecycle: 'live', status: 'in', detail: 'Q1', redzone: false, partitions: ['nfl'],
  home: { id: 'home', name: 'Home', short: 'Home', abbreviation: 'H', color: '112233', score: '0' },
  away: { id: 'away', name: 'Away', short: 'Away', abbreviation: 'A', color: '332211', score: '0' } };
async function drain() { for (let index = 0; index < 60; index++) await new Promise<void>(resolve => setImmediate(resolve)); }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'finished-retention-')), path = join(directory, 'state.sqlite');
  let now = at, games: Game[] = [live], reads = 0, probes = 0, published = true;
  const start = () => createFootballCoordinator(path, {
    now: () => now, schedules: [{ id: 'nfl', league: 'nfl', path: '/fixture', group: null }],
    sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async () => ({ games, league: 'nfl', at: now }),
    readHtml: async () => { reads++; return '<main>fixture</main>'; },
    parseListings: () => ({ outcome: published ? 'parsed' : 'empty', observations: published ? [{
      id: 'fixture-game', sourceId: 'fixture', url: 'https://fixture.example/event', title: live.name,
      league: 'nfl', teams: [live.away.name, live.home.name], kickoff: at, rawTime: '', observedAt: now, parserVersion: 2,
    }] : [] }),
    enrichObservation: value => value,
    compatiblePlayers: () => [1, 2].map(index => ({ id: `server-${index}`, label: `Server ${index}`,
      locator: { provider: 'gooz' as const, playerId: String(index) } })),
    probeCandidate: async () => { probes++; return { kind: 'playable', proof: 'media' }; },
  });
  return { path, start, counts: () => ({ reads, probes }), clock: (value: number) => { now = value; },
    finish: () => { published = false; games = [recordFinal({ ...live, lifecycle: 'final', status: 'post' }, now)]; },
    disappear: () => { games = []; },
    sql: (statement: string) => { const db = new DatabaseSync(path); try { db.exec(statement); } finally { db.close(); } },
    count: (table: 'working_feeds' | 'observations' | 'details') => {
      const db = new DatabaseSync(path); try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n; } finally { db.close(); }
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
async function sources(coordinator: ReturnType<typeof createFootballCoordinator>) {
  const reply = await coordinator.command({ kind: 'sources' });
  assert.equal(reply.kind, 'sources');
  if (reply.kind !== 'sources') throw new Error('Expected sources');
  return reply.snapshot;
}

test('retention commands accept whole minutes from five minutes to seven days', () => {
  for (const minutes of [5, 1440, 10080]) assert.equal(CommandSchema.safeParse({ kind: 'set-retention', minutes }).success, true);
  for (const minutes of [4, 10081, 5.5, NaN, '1440']) assert.equal(FinishedGameRetentionMinutesSchema.safeParse(minutes).success, false);
});

test('retention persists and rebases finals from the first observation, including the one-time legacy migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retention-store-')), path = join(directory, 'state.sqlite');
  let store = new FootballStore(path);
  try {
    assert.equal(store.finishedGameRetentionMinutes(), 1440);
    store.savePartition('nfl', { games: [recordFinal({ ...live, lifecycle: 'final', status: 'post' }, at)], at });
    assert.equal(store.finals()[0].graceEndsAt, at + day);
    store.setFinishedGameRetentionMinutes(60);
    store.savePartition('nfl', { games: [recordFinal({ ...live, lifecycle: 'final', status: 'post' }, at + 120_000)], at: at + 120_000 });
    assert.equal(store.finals()[0].finalObservedAt, at);
    assert.equal(store.finals()[0].graceEndsAt, at + 60 * 60_000);
    assert.equal(store.partition('nfl')?.games[0].graceEndsAt, at + 60 * 60_000);
    store.close(); store = new FootballStore(path);
    assert.equal(store.finishedGameRetentionMinutes(), 60);
    store.close();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("DELETE FROM settings WHERE id='finishedGameRetentionMinutes'; UPDATE finals SET payload=json_set(payload,'$.graceEndsAt',at+300000)");
    } finally { legacy.close(); }
    store = new FootballStore(path);
    assert.equal(store.finals()[0].graceEndsAt, at + day);
    assert.equal(store.partition('nfl')?.games[0].graceEndsAt, at + day);
    store.setFinishedGameRetentionMinutes(5);
    store.close(); store = new FootballStore(path);
    assert.equal(store.finishedGameRetentionMinutes(), 5);
    assert.equal(store.finals()[0].finalObservedAt, at);
    assert.equal(store.finals()[0].graceEndsAt, at + 300_000);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('finished games and saved servers survive missing schedules and cold restore until the exact 24-hour deadline', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    const before = (await sources(coordinator)).games[0].candidates;
    assert.deepEqual(before.map(row => row.id), ['server-1', 'server-2']);
    const counts = run.counts();
    run.clock(at + 10 * 60_000); run.finish();
    await coordinator.refresh(true); await drain();
    run.disappear(); await coordinator.refresh(true); await drain();
    await coordinator.stop(); run.clock(at + 10 * 60_000 + day - 1); coordinator = run.start();
    assert.deepEqual((await sources(coordinator)).games[0].candidates, before);
    const board = await coordinator.command({ kind: 'set-retention', minutes: 1440 });
    assert.equal(board.kind, 'board');
    if (board.kind === 'board') {
      assert.equal(board.board.finishedGameRetentionMinutes, 1440);
      assert.equal(board.board.games[0].sourceUrl, `/play/${live.id}`);
      assert.equal(board.board.games[0].finalObservedAt, at + 10 * 60_000);
    }
    const opened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    assert.equal(opened.playback.session.state, 'draining');
    const switched = await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id, generation: 0,
      candidateId: 'server-2', failure: false, retry: false });
    assert.equal(switched.kind, 'session');
    if (switched.kind !== 'session') return;
    assert.equal(switched.session.candidateId, 'server-2');
    assert.equal(switched.session.generation, 1);
    assert.equal((await coordinator.command({ kind: 'authorize', sessionId: switched.session.id, candidateId: 'server-2', generation: 1 })).kind, 'authorized');
    assert.equal((await coordinator.command({ kind: 'check-sources', gameIds: [live.id], retry: true })).kind, 'error');
    assert.deepEqual(run.counts(), counts);
    run.clock(at + 10 * 60_000 + day);
    assert.deepEqual((await sources(coordinator)).games, []);
    assert.equal((await coordinator.command({ kind: 'authorize', sessionId: switched.session.id, candidateId: 'server-2', generation: 1 })).kind, 'error');
    for (const table of ['working_feeds', 'observations', 'details'] as const) assert.equal(run.count(table), 0);
    const expired = await coordinator.command({ kind: 'set-retention', minutes: 1440 });
    assert.equal(expired.kind, 'board');
    if (expired.kind === 'board') assert.deepEqual(expired.board.games, []);
    await coordinator.stop(); coordinator = run.start();
    assert.deepEqual((await sources(coordinator)).games, []);
    assert.deepEqual(run.counts(), counts);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('changing retention updates draining sessions and never recreates already purged saved feeds', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    run.clock(at + 10 * 60_000); run.finish(); await coordinator.refresh(true); await drain();
    const opened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    const changed = await coordinator.command({ kind: 'set-retention', minutes: 60 });
    assert.equal(changed.kind, 'board');
    if (changed.kind === 'board') assert.equal(changed.board.games[0].finalObservedAt, at + 10 * 60_000);
    const session = await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id, generation: 0, failure: false, retry: false });
    assert.equal(session.kind, 'session');
    if (session.kind === 'session') assert.equal(session.session.graceEndsAt, at + 70 * 60_000);
    const counts = run.counts();
    run.clock(at + 16 * 60_000);
    const shortened = await coordinator.command({ kind: 'set-retention', minutes: 5 });
    assert.equal(shortened.kind, 'board');
    if (shortened.kind === 'board') assert.deepEqual(shortened.board.games, []);
    assert.equal(run.count('working_feeds'), 0);
    const increased = await coordinator.command({ kind: 'set-retention', minutes: 60 });
    assert.equal(increased.kind, 'board');
    if (increased.kind === 'board') {
      assert.equal(increased.board.games.length, 1);
      assert.equal(increased.board.games[0].sourceUrl, undefined);
      assert.equal(increased.board.games[0].finalObservedAt, at + 10 * 60_000);
    }
    assert.equal((await coordinator.command({ kind: 'open', gameId: live.id, manual: false })).kind, 'error');
    assert.deepEqual((await sources(coordinator)).games, []);
    await coordinator.stop(); coordinator = run.start();
    const restored = await coordinator.command({ kind: 'set-retention', minutes: 60 });
    assert.equal(restored.kind, 'board');
    if (restored.kind === 'board') assert.equal(restored.board.finishedGameRetentionMinutes, 60);
    assert.deepEqual(run.counts(), counts);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('cold restore rejects a final saved feed whose exact team owner changed', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    run.finish(); await coordinator.refresh(true); await drain();
    await coordinator.stop();
    run.sql("UPDATE working_feeds SET payload=json_set(payload,'$.owner.home.id','other','$.owner.home.name','Other')");
    coordinator = run.start();
    assert.deepEqual((await sources(coordinator)).games, []);
    assert.equal(run.count('working_feeds'), 0);
    assert.equal((await coordinator.command({ kind: 'open', gameId: live.id, manual: false })).kind, 'error');
    assert.equal(run.counts().probes, 2);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('final playback failures invalidate saved proof and fall back only to another retained working server', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    run.finish(); await coordinator.refresh(true); await drain();
    const counts = run.counts();
    const opened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    const sessionId = opened.playback.session.id;
    const failed = await coordinator.command({ kind: 'session', sessionId, generation: 0, failure: true, retry: false });
    assert.equal(failed.kind, 'session');
    if (failed.kind !== 'session') return;
    assert.equal(failed.session.candidateId, 'server-2');
    assert.equal(failed.session.generation, 1);
    assert.deepEqual((await sources(coordinator)).games[0].candidates.map(row => row.id), ['server-2']);
    assert.equal(run.count('working_feeds'), 1);
    const reopened = await coordinator.command({ kind: 'open', gameId: live.id, manual: false });
    assert.equal(reopened.kind, 'playback');
    if (reopened.kind === 'playback') assert.equal(reopened.playback.session.candidateId, 'server-2');
    await coordinator.command({ kind: 'session', sessionId, generation: 1, failure: true, retry: false });
    assert.equal(run.count('working_feeds'), 0);
    assert.deepEqual((await sources(coordinator)).games, []);
    assert.equal((await coordinator.command({ kind: 'open', gameId: live.id, manual: false })).kind, 'error');
    await coordinator.stop(); coordinator = run.start();
    assert.deepEqual((await sources(coordinator)).games, []);
    assert.equal((await coordinator.command({ kind: 'open', gameId: live.id, manual: false })).kind, 'error');
    assert.deepEqual(run.counts(), counts);
  } finally { await coordinator.stop(); run.cleanup(); }
});
