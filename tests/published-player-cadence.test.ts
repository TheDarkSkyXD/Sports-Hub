import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { DetailEvidenceSchema, GameSchema, ObservationSchema } from '../lib/football/shared.ts';
import type { DetailEvidence } from '../lib/football/shared.ts';

const captured = z.object({ game: GameSchema, observation: ObservationSchema, detail: DetailEvidenceSchema }).parse(JSON.parse(
  readFileSync(new URL('./fixtures/ppv-future-publication-20261017.json', import.meta.url), 'utf8')));
assert.equal(captured.detail.outcome, 'resolved');
if (captured.detail.outcome !== 'resolved') throw new Error('Expected captured PPV publication');
const published = captured.detail;
const minute = 60_000;
const expected = ['event-page:b74f73ee778a55ad09ddf773'];
const drain = async () => { for (let turn = 0; turn < 20; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };

function fixture(successAt = published.at, empty = false) {
  const directory = mkdtempSync(join(tmpdir(), 'published-player-cadence-'));
  const store = new FootballStore(join(directory, 'state.sqlite'));
  let now = successAt, detailReads = 0;
  const source = { id: 'ppv', url: 'https://ppv.st/', family: 'ppv', kind: 'catalog' as const };
  const observation = { ...captured.observation, observedAt: successAt };
  const game = { ...captured.game, partitions: ['nfl'] };
  store.savePartition('nfl', { games: [game], at: now });
  store.saveListingAttempt(source.id, { at: now, outcome: 'parsed', count: 1, failures: 0,
    nextEligibleAt: now + 30 * minute, parserVersion: 3 }, [{ observation, result: { kind: 'matched', gameId: game.id } }]);
  const detail: DetailEvidence = empty ? { outcome: 'unresolved', reason: 'no-published-player', failures: 0,
    observationId: observation.id, generation: published.generation, identity: published.identity,
    at: successAt, nextEligibleAt: successAt + 5 * 60 * minute, polling: published.polling, event: published.event }
    : { ...published, at: successAt, nextEligibleAt: successAt + 5 * 60 * minute,
      lastSuccess: published.lastSuccess ? { ...published.lastSuccess, at: successAt } : undefined };
  store.saveDetailEvidence(detail);
  const coordinator = new FootballCoordinator({ store, now: () => now, id: randomUUID,
    schedules: [{ id: 'nfl', league: 'nfl', path: 'football/nfl', group: null }], sources: [source],
    readSchedule: async () => ({ games: [game], league: 'nfl', at: now }),
    readSeasonMembership: async () => { throw new Error('No membership network'); },
    readHtml: async url => { if (url !== source.url) detailReads++; return '<main/>'; },
    parseListings: () => ({ outcome: 'parsed', observations: [{ ...observation, observedAt: now }] }),
    enrichObservation: row => row, compatiblePlayers: () => empty ? [] : published.players,
    missingPlayerReason: () => 'no-published-player', tvappPlayers: () => [], persistableLocator: () => false,
    probeIdentity: locator => JSON.stringify(locator), retryAfterMs: () => 0,
    probeCandidate: async () => ({ kind: 'deferred', retryAfterMs: 300_000 }),
  });
  return { get detailReads() { return detailReads; }, saved: () => store.detailEvidence()[0],
    async refresh(elapsed: number) { now = successAt + elapsed; await coordinator.refresh(true); await drain(); },
    async choices() {
      const result = await coordinator.command({ kind: 'sources' });
      assert.equal(result.kind, 'sources');
      if (result.kind !== 'sources') throw new Error('Expected source inventory');
      const row = result.snapshot.games.find(row => row.gameId === game.id);
      return { ids: row?.candidates.map(candidate => candidate.id) || [], working: row?.workingChoiceCount || 0 };
    },
    async stop() { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('a restored five-hour PPV deadline refreshes eligible published players on the thirty-minute cycle', async () => {
  const run = fixture();
  try {
    assert.deepEqual(await run.choices(), { ids: expected, working: 0 });
    await run.refresh(30 * minute - 1);
    assert.equal(run.detailReads, 0);
    await run.refresh(30 * minute);
    assert.equal(run.detailReads, 1, 'Published eligible players must refresh before the original sixty-minute publication cap');
    assert.equal(run.saved()?.nextEligibleAt, published.at + 60 * minute);
  } finally { await run.stop(); }
});

test('successful refreshes keep the actual unchecked PPV player published beyond its original expiry', async () => {
  const run = fixture();
  try {
    assert.deepEqual(await run.choices(), { ids: expected, working: 0 });
    await run.refresh(30 * minute);
    await run.refresh(60 * minute + 1);
    assert.deepEqual(await run.choices(), { ids: expected, working: 0 });
    assert.equal(run.detailReads, 2);
  } finally { await run.stop(); }
});

test('a published player entering tomorrow eligibility adopts the active refresh cycle', async () => {
  const start = Date.parse('2026-10-17T04:50:00Z');
  const run = fixture(start);
  try {
    await run.refresh(9 * minute);
    assert.equal(run.detailReads, 0);
    assert.deepEqual(await run.choices(), { ids: [], working: 0 });
    await run.refresh(10 * minute);
    assert.deepEqual(await run.choices(), { ids: expected, working: 0 });
    assert.equal(run.detailReads, 0);
    await run.refresh(30 * minute);
    assert.equal(run.detailReads, 1);
  } finally { await run.stop(); }
});

test('an empty eligible PPV page keeps its five-hour idle deadline', async () => {
  const run = fixture(published.at, true);
  try {
    await run.refresh(30 * minute);
    await run.refresh(4 * 60 * minute);
    assert.equal(run.detailReads, 0);
    assert.equal(run.saved()?.nextEligibleAt, published.at + 5 * 60 * minute);
    assert.deepEqual(await run.choices(), { ids: [], working: 0 });
  } finally { await run.stop(); }
});

test('a published PPV page outside today and tomorrow remains idle', async () => {
  const run = fixture(Date.parse('2026-10-16T18:00:00Z'));
  try {
    await run.refresh(30 * minute);
    await run.refresh(4 * 60 * minute);
    assert.equal(run.detailReads, 0);
    assert.deepEqual(await run.choices(), { ids: [], working: 0 });
  } finally { await run.stop(); }
});
