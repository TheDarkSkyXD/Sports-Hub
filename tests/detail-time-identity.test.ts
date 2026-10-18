import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { detailIdentity, detailIdentityMatches } from '../lib/football/domain/source-policy.ts';
import { DetailEvidenceSchema, GameSchema, ObservationSchema } from '../lib/football/shared.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Observation } from '../lib/football/shared.ts';

const captured = z.object({ game: GameSchema, observation: ObservationSchema, detail: DetailEvidenceSchema }).parse(JSON.parse(
  readFileSync(new URL('./fixtures/buffstreams-nhl-time-identity-20261017.json', import.meta.url), 'utf8')));
const expected = ['event-page:ed56154876aa326cfa0f2fa0'];

for (const change of ['equivalent-time', 'kickoff', 'source', 'parser', 'game', 'date'] as const)
  test(`a saved Buffstreams publication handles a listing refresh with ${change}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'detail-time-identity-'));
    const store = new FootballStore(join(directory, 'state.sqlite'));
    const now = captured.detail.at + 1000;
    let game = captured.game;
    store.savePartition('nhl', { games: [{ ...game, partitions: ['nhl'] }], at: now });
    store.observe(captured.observation, { kind: 'matched', gameId: game.id });
    store.saveDetailEvidence(captured.detail);
    const coordinator = new FootballCoordinator({ store, now: () => now, id: randomUUID,
      schedules: [{ id: 'nhl', league: 'nhl', path: 'hockey/nhl', group: null }],
      sources: [{ id: 'buffstreams', url: 'https://buffstreams.ch/', family: 'published-events' }],
      readSchedule: async () => ({ games: [game], league: 'nhl', at: now }),
      readSeasonMembership: async () => { throw new Error('No membership network'); },
      readHtml: async () => { throw new Error('No source network'); }, parseListings: () => ({ outcome: 'empty', observations: [] }),
      enrichObservation: row => row, compatiblePlayers: () => [], tvappPlayers: () => [], persistableLocator: () => false,
      probeIdentity: locator => JSON.stringify(locator), retryAfterMs: () => 0,
      probeCandidate: (_locator, signal) => new Promise<CandidateProbeResult>(resolve => {
        const finish = () => resolve({ kind: 'deferred', reason: 'cancelled', retryAfterMs: 2000 });
        if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
      }),
    });
    const ids = async () => {
      const result = await coordinator.command({ kind: 'sources' });
      assert.equal(result.kind, 'sources');
      if (result.kind !== 'sources') throw new Error('Expected source inventory');
      return result.snapshot.games.find(row => row.gameId === game.id)?.candidates.map(row => row.id) || [];
    };
    try {
      assert.deepEqual(await ids(), expected, 'The actual persisted ISO identity restores its unchecked publication');
      const observation: Observation = { ...captured.observation, observedAt: now, rawTime: String(captured.observation.kickoff),
        ...(change === 'kickoff' ? { kickoff: (captured.observation.kickoff || 0) + 3600_000 } : {}),
        ...(change === 'source' ? { sourceId: 'other-source' } : {}), ...(change === 'parser' ? { parserVersion: 2 } : {}) };
      if (change === 'game') game = { ...game, id: 'nhl-401892527' };
      if (change === 'date') game = { ...game, date: new Date(Date.parse(game.date || '') + 3600_000).toISOString() };
      store.savePartition('nhl', { games: [{ ...game, partitions: ['nhl'] }], at: now });
      store.observe(observation, { kind: 'matched', gameId: game.id });
      await coordinator.command({ kind: 'set-retention', minutes: 60 });
      assert.deepEqual(await ids(), change === 'equivalent-time' ? expected : [],
        'Only equivalent timestamp spelling can reuse the saved exact publication owner');
      if (change === 'equivalent-time') {
        const result = await coordinator.command({ kind: 'sources' });
        assert.equal(result.kind, 'sources');
        if (result.kind === 'sources') {
          assert.notEqual(result.snapshot.games[0]?.candidates[0]?.availability.kind, 'playable');
          assert.equal(result.snapshot.games[0]?.workingChoiceCount, 0);
          assert.deepEqual(result.snapshot.games[0]?.sourceLinks.find(link => link.sourceId === 'buffstreams')?.evidence,
            { kind: 'collected', checkedAt: captured.detail.at, candidateIds: expected });
        }
      }
    } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
  });

test('an unavailable kickoff preserves raw clock text as part of detail identity', () => {
  assert.notEqual(detailIdentity({ ...captured.observation, kickoff: null, rawTime: '7:00 PM ET' }),
    detailIdentity({ ...captured.observation, kickoff: null, rawTime: '8:00 PM ET' }));
});

for (const identity of ['invalid-json', 'x'.repeat(16_385), JSON.stringify(['buffstreams']),
  JSON.stringify(['streameast', 'nhl:46968', captured.observation.url, 'nhl', captured.observation.title,
    captured.observation.teams, captured.observation.kickoff, '401892524'])])
  test(`an unrelated or malformed saved detail identity is rejected (${identity.length} characters)`, () => {
    assert.equal(detailIdentityMatches(identity, captured.observation), false);
  });
