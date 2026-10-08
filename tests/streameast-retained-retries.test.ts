import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Game, StreameastCatalog } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-07T20:00:00Z');
const minute = 60_000;
const game: Game = {
  id: 'ncaaf-46296', league: 'ncaaf', name: 'New Mexico State Aggies at FIU Panthers',
  date: new Date(at - 20 * minute).toISOString(), status: 'in', lifecycle: 'live', detail: 'Q1',
  redzone: false, partitions: ['fbs'],
  away: { id: 'espn:ncaaf:166', name: 'New Mexico State Aggies', short: 'Aggies', abbreviation: 'NMSU', color: '112233', score: '0' },
  home: { id: 'espn:ncaaf:2229', name: 'FIU Panthers', short: 'Panthers', abbreviation: 'FIU', color: '112233', score: '0' },
};
const eventUrl = 'https://v2.streameast.ga/cfb/new-mexico-state-aggies-vs-fiu-panthers/';

function catalog(startedAt: number, detail: StreameastCatalog['events'][number]['detail'],
  options: { title?: string; gameId?: string; categoryAt?: number; state?: 'collecting' | 'complete' } = {}): StreameastCatalog {
  return {
    runId: startedAt === at ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    sequence: 0, startedAt,
    state: options.state === 'complete' ? { kind: 'complete', at: startedAt } : { kind: 'collecting' },
    categories: { nfl: { kind: 'collected', at: startedAt }, ncaaf: { kind: 'collected', at: options.categoryAt ?? startedAt } },
    events: [{ id: 'ncaaf:46296', url: eventUrl, league: 'ncaaf', title: options.title ?? game.name,
      teams: [game.away.name, game.home.name], kickoff: Date.parse(game.date!), espnEventId: options.gameId ?? '46296',
      detail }], rejectedGames: [],
  };
}

function collected(time: number, serverIds = ['1', '2', '3']): StreameastCatalog['events'][number]['detail'] {
  return { kind: 'collected', at: time, servers: serverIds.map(id => ({ id, label: `Server ${id}`,
    url: `${eventUrl}${id}`, availability: { kind: 'free-page' } })) };
}

async function drain() {
  for (let turn = 0; turn < 50; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'streameast-retained-retries-'));
  const path = join(directory, 'state.sqlite');
  let store = new FootballStore(path);
  store.savePartition('fbs', { games: [game], league: 'ncaaf', at });
  let now = at;
  const calls = new Map<string, number>();
  const pending = new Map<string, (result: CandidateProbeResult) => void>();
  const create = () => new FootballCoordinator({
    store, now: () => now, id: () => 'session',
    schedules: [{ id: 'fbs', league: 'ncaaf', path: '', group: 'fbs' }],
    sources: [{ id: 'streameast', url: 'https://v2.streameast.ga/cfb/', family: 'streameast', kind: 'browser-catalog' }],
    readSchedule: async () => ({ games: [game], league: 'ncaaf', at: now }),
    readSeasonMembership: async () => { throw new Error('unused'); },
    readHtml: async () => { throw new Error('unused'); },
    parseListings: () => ({ observations: [], outcome: 'empty' }),
    enrichObservation: observation => observation,
    compatiblePlayers: () => [], retryAfterMs: () => 0,
    persistableLocator: () => false,
    probeCandidate: locator => {
      assert.equal(locator.provider, 'streameast-server');
      if (locator.provider !== 'streameast-server') throw new Error('unexpected locator');
      const count = (calls.get(locator.serverId) ?? 0) + 1;
      calls.set(locator.serverId, count);
      if (count === 1) return Promise.resolve({ kind: 'playable', proof: 'media' });
      if (count === 2) return Promise.resolve({ kind: 'unavailable', reason: 'upstream' });
      return new Promise<CandidateProbeResult>(resolve => { pending.set(locator.serverId, resolve); });
    },
  });
  let coordinator = create();
  const publish = async (value: StreameastCatalog) => {
    const reply = await coordinator.command({ kind: 'streameast-catalog', catalog: value });
    assert.equal(reply.kind, 'catalog-ack');
    await drain();
  };
  const candidates = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('expected sources');
    return reply.snapshot.games.find(row => row.gameId === game.id)?.candidates ?? [];
  };
  return { calls, pending, publish, candidates, get coordinator() { return coordinator; },
    async advance(minutes: number) {
      now = at + minutes * minute;
      await coordinator.refresh(true);
      await drain();
    },
    async restart() {
      for (const resolve of pending.values()) resolve({ kind: 'deferred', retryAfterMs: minute });
      pending.clear();
      await coordinator.stop();
      store = new FootballStore(path);
      coordinator = create();
      await coordinator.refresh(true);
      await drain();
    },
    async stop() {
      for (const resolve of pending.values()) resolve({ kind: 'deferred', retryAfterMs: minute });
      await coordinator.stop();
      rmSync(directory, { recursive: true, force: true });
    } };
}

test('a fresh matched board keeps older published StreamEast servers retryable after detail rate limit', async () => {
  const run = fixture();
  try {
    await run.publish(catalog(at, collected(at), { state: 'complete' }));
    assert.equal((await run.candidates()).length, 3);
    await run.advance(25);
    assert.equal((await run.candidates()).filter(row => row.availability.kind === 'unavailable').length, 3);
    await run.advance(31);
    await run.publish(catalog(at + 31 * minute, { kind: 'failed', at: at + 31 * minute, reason: 'rate-limited' }));
    const rows = await run.candidates();
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.availability.kind !== 'playable'));
    assert.ok(run.calls.get('2') && run.calls.get('2')! >= 3);
    assert.ok(run.pending.has('2'));
    run.pending.get('2')?.({ kind: 'playable', proof: 'media' });
    await drain();
    assert.equal((await run.candidates()).find(row => row.id === 'streameast-server:ncaaf:46296:2')?.availability.kind, 'playable');
  } finally { await run.stop(); }
});

test('retained published servers are rebuilt after restart without restoring stale playable proof', async () => {
  const run = fixture();
  try {
    await run.publish(catalog(at, collected(at), { state: 'complete' }));
    await run.advance(25);
    await run.advance(31);
    await run.publish(catalog(at + 31 * minute, { kind: 'failed', at: at + 31 * minute, reason: 'rate-limited' }));
    await run.restart();
    const rows = await run.candidates();
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.availability.kind !== 'playable'));
  } finally { await run.stop(); }
});

for (const currentDetail of [collected(at + 31 * minute, []), collected(at + 31 * minute, ['1'])])
  test('a new collected detail replaces historical server publication', async () => {
    const run = fixture();
    try {
      await run.publish(catalog(at, collected(at), { state: 'complete' }));
      await run.advance(31);
      await run.publish(catalog(at + 31 * minute, currentDetail));
      assert.deepEqual((await run.candidates()).map(row => row.id),
        currentDetail.kind === 'collected' && currentDetail.servers.length ? ['streameast-server:ncaaf:46296:1'] : []);
    } finally { await run.stop(); }
  });

test('a changed event identity cannot inherit historical server publication', async () => {
  const run = fixture();
  try {
    await run.publish(catalog(at, collected(at), { state: 'complete' }));
    await run.advance(31);
    await run.publish(catalog(at + 31 * minute, { kind: 'pending' }, { title: `${game.name} alternate` }));
    assert.equal((await run.candidates()).length, 0);
  } finally { await run.stop(); }
});

test('an expired current category cannot retain older server publication', async () => {
  const run = fixture();
  try {
    await run.publish(catalog(at, collected(at), { state: 'complete' }));
    await run.advance(31);
    await run.publish(catalog(at + 31 * minute, { kind: 'pending' }));
    await run.advance(62);
    assert.equal((await run.candidates()).length, 0);
  } finally { await run.stop(); }
});
