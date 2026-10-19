import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomSources } from '../lib/football/domain/source-inventory.ts';
import { SourcesSnapshotSchema, type CandidateAvailability } from '../lib/football/shared.ts';

test('room summaries retain server choices and collection progress without diagnostic history', () => {
  const snapshot = SourcesSnapshotSchema.parse({
    at: 1000, revision: 7, windowStartAt: 0, lastDiscoveryAt: 900,
    browserCollectorsAvailable: true, sources: [],
    sportsurgeV2: { current: null, lastComplete: null, previous: null },
    streameast: { current: null, lastComplete: null, previous: null },
    games: [
      { gameId: 'pending', name: 'Pending', sourceCount: 0, uniqueFeedCount: 0,
        candidates: [], sourceLinks: [{ sourceId: 'source', title: 'Published event',
          url: 'https://example.com/event', observedAt: 900, freshness: 'fresh', evidence: { kind: 'pending' } }] },
      { gameId: 'stale', name: 'Stale schedule', sourceCount: 0, uniqueFeedCount: 0,
        feeds: { kind: 'incomplete', reason: 'schedule' }, candidates: [],
        sourceLinks: [{ sourceId: 'source', title: 'Published event', url: 'https://example.com/other',
          observedAt: 900, freshness: 'fresh', evidence: { kind: 'pending' } }] },
      { gameId: 'empty', name: 'No feeds', sourceCount: 0, uniqueFeedCount: 0,
        feeds: { kind: 'no-feeds', checkedAt: 900 }, candidates: [], sourceLinks: [] },
    ],
  });
  assert.deepEqual(roomSources(snapshot), {
    revision: 7, collecting: false,
    games: [
      { gameId: 'pending', candidates: [], pending: true },
      { gameId: 'stale', candidates: [], pending: false },
      { gameId: 'empty', candidates: [], pending: false },
    ],
  });
});

test('room polling follows unresolved checks and retains every selectable server', () => {
  const availabilities:CandidateAvailability[] = [
    { kind: 'unknown' },
    { kind: 'checking', progress: { kind: 'queued', since: 900 } },
    { kind: 'checking', progress: { kind: 'active', since: 900 } },
    { kind: 'checking', progress: { kind: 'deferred', since: 900, retryAt: 2000 } },
    { kind: 'playable', checkedAt: 900, proof: { kind: 'advancing-video', version: 1,
      startupMs: 3000, observedMs: 3000, mediaAdvanceMs: 3000, presentedFrames: 4 } },
    { kind: 'unavailable', reason: 'upstream', checkedAt: 900, retryAt: 2000 },
  ];
  const snapshot = SourcesSnapshotSchema.parse({
    at: 1000, revision: 8, windowStartAt: 0, lastDiscoveryAt: 900,
    browserCollectorsAvailable: true, sources: [],
    sportsurgeV2: { current: null, lastComplete: null, previous: null },
    streameast: { current: null, lastComplete: null, previous: null },
    games: availabilities.map((availability, index) => ({
      gameId: String(index), name: 'Event', sourceCount: 1, uniqueFeedCount: 1,
      candidates: [{ id: `server-${index}`, gameId: String(index), label: 'Server',
        sourceIds: ['source'], observedAt: 900, availability }], sourceLinks: [],
    })),
  });
  const summary = roomSources(snapshot);
  assert.deepEqual(summary.games.map(game => game.pending), [true, true, true, false, false, false]);
  assert.deepEqual(summary.games[4].candidates, [{ id: 'server-4', gameId: '4', label: 'Server',
    sourceIds: ['source'], observedAt: 900, availability: { kind: 'playable', checkedAt: 900,
      proof: { kind: 'advancing-video', version: 1, startupMs: 3000, observedMs: 3000,
        mediaAdvanceMs: 3000, presentedFrames: 4 } } }]);
});
