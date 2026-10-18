import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { recordFinal } from '../lib/football/domain/lifecycle.ts';
import { browserPublicationIdentity, retainedBrowserPublication } from '../lib/football/domain/browser-polling.ts';
import { combatListingFeedEligible, feedEligible } from '../lib/football/domain/feed-eligibility.ts';
import { streameastCandidates } from '../lib/football/domain/streameast-catalog.ts';
import { GameSchema, SportsurgeCatalogSchema, StreameastCatalogSchema } from '../lib/football/shared.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Game, SportsurgeCatalog, StreameastCatalog } from '../lib/football/shared.ts';

const east = z.object({ game: GameSchema, event: StreameastCatalogSchema.shape.events.element }).parse(JSON.parse(
  readFileSync(new URL('./fixtures/streameast-asu-texas-tech-publication-20261017.json', import.meta.url), 'utf8')));
const surge = z.object({ game: GameSchema, event: SportsurgeCatalogSchema.shape.events.element,
  expectedCandidateIds: z.array(z.string()) }).parse(JSON.parse(
  readFileSync(new URL('./fixtures/sportsurge-browser-publication-20261017.json', import.meta.url), 'utf8')));
assert.equal(east.event.detail.kind, 'collected');
assert.equal(surge.event.detail.kind, 'collected');
if (east.event.detail.kind !== 'collected' || surge.event.detail.kind !== 'collected') throw new Error('Expected captured successful details');
const eastDetail = east.event.detail;
const surgeDetail = surge.event.detail;
const minute = 60_000;
type Kind = 'streameast' | 'sportsurge-v2';
type Publication = 'initial' | 'pending' | 'failed' | 'empty' | 'replacement' | 'reused';
type Change = 'event-id' | 'external-id' | 'status' | 'link-count' | 'kickoff';
const expected = {
  streameast: ['streameast-server:ncaaf:46996:3', 'streameast-server:ncaaf:46996:4', 'streameast:54', 'wikisport:strm:24'].sort(),
  'sportsurge-v2': ['sportsurge-v2:84fac0e5601dfb5d5bbdd7cf', 'sportsurge-v2:8f19998246a9a7679a247994'],
};
const drain = async () => { for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('retention preserves caller-approved eligibility for an unknown boxing card', () => {
  const captured = z.object({ games: z.array(GameSchema) }).parse(JSON.parse(readFileSync(
    new URL('./fixtures/sportsurge-matching-variants.json', import.meta.url), 'utf8'))).games.find(game => game.id === 'boxing-218065792495125');
  assert.ok(captured);
  const game: Game = { ...captured, status: 'unknown', lifecycle: 'unknown' };
  const at = Date.parse(game.date || '') + minute;
  const now = at + 32 * minute;
  assert.equal(feedEligible(game, now), false);
  assert.equal(combatListingFeedEligible(game, now), true);
  const event: StreameastCatalog['events'][number] = { ...east.event, league: 'boxing', title: game.name,
    teams: null, kickoff: Date.parse(game.date || ''), espnEventId: null, detail: { ...eastDetail, at } };
  const players = streameastCandidates(event, game.id);
  assert.equal(players.length, 4);
  const detail = { outcome: 'resolved' as const, observationId: `streameast:${event.url}`, generation: 'boxing-publication',
    at, players: [], nextEligibleAt: at + 30 * minute, lastSuccess: { identity: browserPublicationIdentity(event), at,
      count: players.length, publication: { players, event: { gameId: game.id, date: game.date || null } } } };
  const retained = retainedBrowserPublication({ ...event, detail: { kind: 'pending' } }, now, detail, game, now);
  assert.deepEqual(retained?.players.map(player => player.id).sort(), expected.streameast);
});

function fixture(kind: Kind) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-publication-'));
  const path = join(directory, 'state.sqlite');
  const captured = kind === 'streameast' ? east : surge;
  const at = captured.event.detail.kind === 'collected' ? captured.event.detail.at : 0;
  let now = at;
  let game: Game = captured.game;
  let enabled = true;
  let store = new FootballStore(path);
  let originalRunId: string | undefined;
  const saveSchedule = () => store.savePartition('fbs', { games: [{ ...game, partitions: ['fbs'] }], at: now });
  saveSchedule();
  const create = () => new FootballCoordinator({ store, now: () => now, id: randomUUID,
    schedules: [{ id: 'fbs', league: 'ncaaf', path: 'college-football', group: '80' }],
    sources: enabled ? [{ id: kind, url: kind === 'streameast' ? 'https://v2.streameast.ga/cfb-streams/' : 'https://v2.sportsurge.net/watch-cfb-streams/',
      family: kind, kind: 'browser-catalog' }] : [],
    readSchedule: async () => ({ games: [{ ...game, partitions: ['fbs'] }], league: 'ncaaf', at: now }),
    readSeasonMembership: async () => { throw new Error('No membership network'); },
    readHtml: async () => { throw new Error('No listing network'); }, parseListings: () => ({ outcome: 'empty', observations: [] }),
    enrichObservation: row => row, compatiblePlayers: () => [], tvappPlayers: () => [], persistableLocator: () => false,
    probeIdentity: locator => JSON.stringify(locator), retryAfterMs: () => 0,
    probeCandidate: (_locator, signal) => new Promise<CandidateProbeResult>(resolve => {
      const finish = () => resolve({ kind: 'deferred', reason: 'cancelled', retryAfterMs: 2000 });
      if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
    }),
  });
  let coordinator = create();
  const publish = async (publication: Publication, change?: Change) => {
    if (kind === 'streameast') {
      const detail: StreameastCatalog['events'][number]['detail'] = publication === 'pending' ? { kind: 'pending' }
        : publication === 'failed' ? { kind: 'failed', at: now, reason: 'timeout' }
          : { kind: 'collected', at: publication === 'reused' ? at : now, servers: publication === 'empty' ? []
            : publication === 'replacement' ? eastDetail.servers.slice(0, 1) : eastDetail.servers,
            ...(publication === 'reused' ? { retainedFromRunId: originalRunId } : {}) };
      const event = { ...east.event, detail,
        ...(change === 'event-id' ? { id: 'ncaaf:46997' } : {}),
        ...(change === 'external-id' ? { espnEventId: '401858264' } : {}),
        ...(change === 'kickoff' ? { kickoff: (east.event.kickoff || 0) + minute } : {}),
      };
      const catalog: StreameastCatalog = { runId: randomUUID(), sequence: 0, startedAt: now,
        state: { kind: 'collecting' }, categories: { nfl: { kind: 'pending' }, ncaaf: { kind: 'collected', at: now } },
        events: [event], rejectedGames: [] };
      if (publication === 'initial') originalRunId = catalog.runId;
      assert.equal((await coordinator.command({ kind: 'streameast-catalog', catalog })).kind, 'catalog-ack');
    } else {
      const detail: SportsurgeCatalog['events'][number]['detail'] = publication === 'pending' ? { kind: 'pending' }
        : publication === 'failed' ? { kind: 'failed', at: now, reason: 'timeout' }
          : { kind: 'collected', at: publication === 'reused' ? at : now, providers: (publication === 'empty' ? [] : publication === 'replacement'
            ? surgeDetail.providers.slice(0, 1) : surgeDetail.providers).map(provider => ({ ...provider, observedAt: publication === 'reused' ? at : now })),
            ...(publication === 'reused' ? { retainedFromRunId: originalRunId } : {}) };
      const event = { ...surge.event, detail,
        ...(change === 'event-id' ? { id: 'ncaaf:66920', url: surge.event.url.replace(/watch-\d+-/, 'watch-66920-') } : {}),
        ...(change === 'status' ? { sourceStatus: 'upcoming' as const } : {}),
        ...(change === 'link-count' ? { advertisedLinkCount: surge.event.advertisedLinkCount + 1 } : {}),
        ...(change === 'kickoff' ? { kickoff: (surge.event.kickoff || 0) + minute } : {}),
      };
      const catalog: SportsurgeCatalog = { runId: randomUUID(), sequence: 0, startedAt: now,
        state: { kind: 'collecting' }, categories: { nfl: { kind: 'pending' }, ncaaf: { kind: 'collected', at: now } },
        events: [event], rejectedGames: [], catalogIssues: [] };
      if (publication === 'initial') originalRunId = catalog.runId;
      assert.equal((await coordinator.command({ kind: 'sportsurge-catalog', catalog })).kind, 'catalog-ack');
    }
    await drain();
  };
  const candidates = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected inventory');
    return reply.snapshot.games.find(row => row.gameId === game.id)?.candidates || [];
  };
  return { at, publish, candidates,
    get store() { return store; },
    async advance(elapsed: number) { now = at + elapsed; saveSchedule(); await coordinator.refresh(true); await drain(); },
    clockOnly(elapsed: number) { now = at + elapsed; },
    setGame(value: Game) { game = value; },
    async restart(sourceEnabled = true) { await coordinator.stop(); enabled = sourceEnabled; store = new FootballStore(path); saveSchedule(); coordinator = create(); await drain(); },
    async stop() { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const kind of ['streameast', 'sportsurge-v2'] as const) {
  test(`${kind} keeps unchecked publications through two interrupted catalogs and restart`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      assert.deepEqual((await run.candidates()).map(row => row.id).sort(), expected[kind]);
      await run.advance(31 * minute); await run.publish('pending');
      await run.advance(32 * minute); await run.publish('pending');
      assert.deepEqual((await run.candidates()).map(row => row.id).sort(), expected[kind]);
      await run.restart();
      const restored = await run.candidates();
      assert.deepEqual(restored.map(row => row.id).sort(), expected[kind]);
      assert.ok(restored.every(row => row.availability.kind !== 'playable'));
    } finally { await run.stop(); }
  });

  test(`${kind} bounds pending and failed retention to the original success plus sixty minutes`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      await run.advance(31 * minute); await run.publish('reused');
      await run.advance(32 * minute); await run.publish('failed');
      await run.advance(59 * minute); await run.publish('failed');
      assert.equal(run.store.detailEvidence()[0]?.lastSuccess?.at, run.at);
      await run.advance(60 * minute); await run.publish('pending');
      assert.deepEqual((await run.candidates()).map(row => row.id).sort(), expected[kind]);
      run.clockOnly(60 * minute + 1);
      assert.deepEqual((await run.candidates()).map(row => row.id), []);
    } finally { await run.stop(); }
  });

  for (const publication of ['empty', 'replacement'] as const) test(`${kind} authoritative ${publication} cannot resurrect the prior publication`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      await run.advance(31 * minute); await run.publish('pending');
      await run.advance(32 * minute); await run.publish(publication);
      const fresh = await run.candidates();
      assert.equal(fresh.length, publication === 'empty' ? 0 : 1);
      await run.advance(33 * minute); await run.publish('pending');
      await run.restart();
      assert.deepEqual((await run.candidates()).map(row => row.id), fresh.map(row => row.id));
    } finally { await run.stop(); }
  });

  const changes: Change[] = kind === 'streameast' ? ['event-id', 'external-id', 'kickoff'] : ['event-id', 'status', 'link-count', 'kickoff'];
  for (const change of changes) test(`${kind} does not inherit a publication after its ${change} changes`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      await run.advance(31 * minute); await run.publish('pending', change);
      await run.advance(32 * minute); await run.publish('pending', change);
      assert.deepEqual((await run.candidates()).map(row => row.id), []);
    } finally { await run.stop(); }
  });

  test(`${kind} stops retention when its current listing expires or source is disabled`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      await run.advance(10 * minute); await run.publish('pending');
      await run.advance(41 * minute + 1);
      assert.deepEqual((await run.candidates()).map(row => row.id), []);
      await run.publish('pending');
      assert.deepEqual((await run.candidates()).map(row => row.id).sort(), expected[kind]);
      await run.restart(false);
      assert.deepEqual((await run.candidates()).map(row => row.id), []);
    } finally { await run.stop(); }
  });

  for (const correction of ['date', 'game', 'final'] as const) test(`${kind} rejects retained publication after the schedule ${correction} changes`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      const game = kind === 'streameast' ? east.game : surge.game;
      run.setGame(correction === 'date' ? { ...game, date: new Date(Date.parse(game.date || '') + minute).toISOString() }
        : correction === 'game' ? { ...game, id: kind === 'streameast' ? surge.game.id : east.game.id }
          : recordFinal({ ...game, status: 'post', lifecycle: 'final' }, run.at + 31 * minute));
      await run.advance(31 * minute); await run.publish('pending');
      await run.advance(32 * minute); await run.publish('pending');
      assert.deepEqual((await run.candidates()).map(row => row.id), []);
    } finally { await run.stop(); }
  });

  for (const invalid of ['ownerless', 'wrong-game', 'wrong-date', 'future'] as const) test(`${kind} rejects ${invalid} saved publication evidence`, async () => {
    const run = fixture(kind);
    try {
      await run.publish('initial');
      const detail = run.store.detailEvidence()[0];
      assert.ok(detail?.lastSuccess?.publication);
      const success = detail.lastSuccess;
      const publication = success.publication;
      assert.ok(publication);
      run.store.saveDetailEvidence({ ...detail, lastSuccess: { ...success,
        ...(invalid === 'future' ? { at: run.at + 2 * 60 * minute } : {}),
        publication: invalid === 'ownerless' ? undefined : { ...publication, event: { ...publication.event,
          ...(invalid === 'wrong-game' ? { gameId: 'ncaaf-401856809' } : {}),
          ...(invalid === 'wrong-date' ? { date: new Date(Date.parse(publication.event.date || '') + minute).toISOString() } : {}),
        } },
      } });
      await run.advance(31 * minute); await run.publish('pending');
      await run.advance(32 * minute); await run.publish('pending');
      await run.restart();
      assert.deepEqual((await run.candidates()).map(row => row.id), []);
    } finally { await run.stop(); }
  });
}
