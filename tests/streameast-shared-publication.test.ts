import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { GameSchema, StreameastCatalogSchema } from '../lib/football/shared.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Session, StreameastCatalog } from '../lib/football/shared.ts';

const captured = z.object({ now: z.number(), games: z.array(GameSchema),
  events: z.array(StreameastCatalogSchema.shape.events.element) }).parse(JSON.parse(readFileSync(
  new URL('./fixtures/streameast-shared-wikisport-20261017.json', import.meta.url), 'utf8')));

for (const checked of [false, true]) test(`an unchanged StreamEast checkpoint keeps a shared ${checked ? 'proven and selected' : 'unchecked'} Wikisport player on both published games`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'streameast-shared-channel-'));
  const store = new FootballStore(join(directory, 'state.sqlite'));
  let now = captured.now;
  store.savePartition('fbs', { games: captured.games.map(game => ({ ...game, partitions: ['fbs'] })), at: now });
  const coordinator = new FootballCoordinator({ store, now: () => now, id: randomUUID,
    schedules: [{ id: 'fbs', league: 'ncaaf', path: 'college-football', group: '80' }],
    sources: [{ id: 'streameast', url: 'https://v2.streameast.ga/cfb-streams/', family: 'streameast', kind: 'browser-catalog' }],
    readSchedule: async () => ({ games: captured.games, league: 'ncaaf', at: now }),
    readSeasonMembership: async () => { throw new Error('No membership network'); },
    readHtml: async () => { throw new Error('No listing network'); }, parseListings: () => ({ outcome: 'empty', observations: [] }),
    enrichObservation: row => row, compatiblePlayers: () => [], tvappPlayers: () => [], persistableLocator: () => false,
    probeIdentity: locator => JSON.stringify(locator), retryAfterMs: () => 0,
    probeCandidate: (_locator, signal) => checked ? Promise.resolve({ kind: 'playable',
      proof: { kind: 'advancing-video', version: 1, startupMs: 3000, observedMs: 3000, mediaAdvanceMs: 3000, presentedFrames: 4 } }) : new Promise<CandidateProbeResult>(resolve => {
      const finish = () => resolve({ kind: 'deferred', reason: 'cancelled', retryAfterMs: 2000 });
      if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
    }),
  });
  const inventory = async () => {
    const result = await coordinator.command({ kind: 'sources' });
    assert.equal(result.kind, 'sources');
    if (result.kind !== 'sources') throw new Error('Expected source inventory');
    return result.snapshot.games.map(game => ({ gameId: game.gameId,
      candidateIds: game.candidates.map(candidate => candidate.id) }));
  };
  const expected = [
    { gameId: 'ncaaf-401856828', candidateIds: ['wikisport:strm:24'] },
    { gameId: 'ncaaf-401856831', candidateIds: ['wikisport:strm:24'] },
  ];
  try {
    const startedAt = Math.min(...captured.events.map(event => event.detail.kind === 'collected' ? event.detail.at : Infinity));
    const catalog: StreameastCatalog = { runId: randomUUID(), sequence: 0, startedAt, state: { kind: 'collecting' },
      categories: { nfl: { kind: 'pending' }, ncaaf: { kind: 'collected', at: startedAt } },
      events: captured.events, rejectedGames: [] };
    assert.equal((await coordinator.command({ kind: 'streameast-catalog', catalog })).kind, 'catalog-ack');
    for (let turn = 0; turn < 5; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(await inventory(), expected);
    let selected: Session | undefined;
    if (checked) {
      const opened = await coordinator.command({ kind: 'open', gameId: 'ncaaf-401856828', manual: false });
      assert.equal(opened.kind, 'playback');
      if (opened.kind !== 'playback') throw new Error('Expected proven player');
      selected = opened.playback.session;
      assert.equal(selected.candidateId, 'wikisport:strm:24');
    }
    now++;
    assert.equal((await coordinator.command({ kind: 'streameast-catalog', catalog: { ...catalog, sequence: 1 } })).kind, 'catalog-ack');
    assert.deepEqual(await inventory(), expected, 'The same two publications still own their shared player after the checkpoint');
    if (selected) {
      const authorized = await coordinator.command({ kind: 'authorize', sessionId: selected.id,
        candidateId: selected.candidateId, generation: selected.generation });
      assert.equal(authorized.kind, 'authorized');
      if (authorized.kind !== 'authorized') throw new Error('Expected unchanged selected player');
      assert.equal(authorized.session.candidateId, selected.candidateId);
      assert.equal(authorized.session.generation, selected.generation);
      const result = await coordinator.command({ kind: 'sources' });
      assert.equal(result.kind, 'sources');
      if (result.kind === 'sources') assert.deepEqual(result.snapshot.games.map(game => game.workingChoiceCount), [1, 1]);
    }
  } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
});
