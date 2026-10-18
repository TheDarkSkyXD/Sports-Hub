import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { recordFinal } from '../lib/football/domain/lifecycle.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import { GameSchema, SportsurgeCatalogSchema, StreameastCatalogSchema } from '../lib/football/shared.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Game, SportsurgeCatalog, StreameastCatalog } from '../lib/football/shared.ts';

const captured = z.object({ game: GameSchema, event: SportsurgeCatalogSchema.shape.events.element,
  expectedCandidateIds: z.array(z.string()) }).parse(JSON.parse(readFileSync(
  new URL('./fixtures/sportsurge-browser-publication-20261017.json', import.meta.url), 'utf8')));
assert.equal(captured.event.detail.kind, 'collected');
if (captured.event.detail.kind !== 'collected') throw new Error('Expected captured provider publication');
const published = captured.event.detail;
const expectedCandidates = ['sportsurge-v2:a900c41871079f3c381ee3fb', 'sportsurge-v2:fc3426be65d7d54cd7dff3a6'];
const require = createRequire(import.meta.url);
const { runSportsurgeSweep } = require('../desktop/sportsurge-sweep.cjs');
const drain = async () => { for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };

function fixture({ game = captured.game, at = published.at, kind = 'sportsurge-v2' }: {
  game?: Game; at?: number; kind?: 'sportsurge-v2' | 'streameast';
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-progress-freshness-'));
  const store = new FootballStore(join(directory, 'state.sqlite'));
  let now = at, probes = 0, cancelled = 0, scheduleError = false;
  store.savePartition('fbs', { games: [{ ...game, partitions: ['fbs'] }], at });
  const coordinator = new FootballCoordinator({ store, now: () => now, id: randomUUID,
    schedules: [{ id: 'fbs', league: 'ncaaf', path: 'college-football', group: '80' }],
    sources: [{ id: kind, family: kind, kind: 'browser-catalog', url: kind === 'sportsurge-v2'
      ? 'https://v2.sportsurge.net/watch-cfb-streams/' : 'https://v2.streameast.ga/cfb-streams/' }],
    readSchedule: async () => {
      if (scheduleError) throw new Error('Schedule unavailable');
      return { games: [{ ...game, partitions: ['fbs'] }], league: 'ncaaf', at: now };
    },
    readSeasonMembership: async () => { throw new Error('No membership network'); },
    readHtml: async () => { throw new Error('No source network'); }, parseListings: () => ({ outcome: 'empty', observations: [] }),
    enrichObservation: observation => observation, compatiblePlayers: () => [], tvappPlayers: () => [],
    persistableLocator: () => false, probeIdentity: locator => JSON.stringify(locator), retryAfterMs: () => 0,
    probeCandidate: (_locator, signal) => new Promise<CandidateProbeResult>(resolve => {
      probes++;
      const abort = () => { cancelled++; resolve({ kind: 'deferred', reason: 'cancelled', retryAfterMs: 2000 }); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  return { at, store, coordinator, get now() { return now; }, get probes() { return probes; }, get cancelled() { return cancelled; },
    clockOnly(elapsed: number) { now = at + elapsed; },
    async refreshSchedule(failed = false) { scheduleError = failed; await coordinator.refresh(true); await drain(); },
    async choices() {
      const reply = await coordinator.command({ kind: 'sources' });
      assert.equal(reply.kind, 'sources');
      return reply.kind === 'sources' ? reply.snapshot.games.find(row => row.gameId === game.id)?.candidates.map(row => row.id).sort() || [] : [];
    },
    async stop() { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const outage of ['stale', 'failed'] as const)
test(`native progress preserves a published event through ${outage} schedule acknowledgements and recovery`, async () => {
  const run = fixture();
  const empty = '<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>';
  const category = `<main id="match-list-container"><a class="match-row" href="${captured.event.url}"><span class="match-row-team-name">${captured.game.away.name}</span><span class="match-row-team-name">${captured.game.home.name}</span><span class="live-badge">Live</span><span>${captured.event.advertisedLinkCount} Streams</span></a></main>`;
  const detail = `<div class="stream-list">${published.providers.map(provider => provider.destination.kind === 'link'
    ? `<div class="stream-item" data-href="${provider.destination.url}"><span class="stream-row-site-name">${provider.label}</span><button class="stream-vote" id="${provider.id}"></button></div>` : '').join('')}</div>`;
  let firstPublication = false, staleProgress = false;
  let probesBeforeStale = 0;
  const staleSkips: string[] = [];
  try {
    const result: SportsurgeCatalog = await runSportsurgeSweep({ now: () => run.now, signal: new AbortController().signal,
      read: async (_url: string, role: string, league: string) => {
        if (role === 'detail') return detail;
        if (league === 'ncaaf') return category;
        if (league === 'nfl') {
          assert.equal(firstPublication, true);
          probesBeforeStale = run.probes;
          run.clockOnly(outage === 'stale' ? 91_000 : 1000);
          if (outage === 'failed') await run.refreshSchedule(true);
        }
        return empty;
      },
      send: async (catalog: SportsurgeCatalog) => {
        const reply = await run.coordinator.command({ kind: 'sportsurge-catalog', catalog });
        assert.equal(reply.kind, 'catalog-ack');
        if (reply.kind !== 'catalog-ack') throw new Error('Expected catalog acknowledgement');
        await drain();
        if (run.now === run.at && catalog.events.some(event => event.detail.kind === 'collected')) {
          firstPublication = true;
          assert.deepEqual(await run.choices(), expectedCandidates);
        }
        if (run.now > run.at) {
          staleProgress = true;
          staleSkips.push(...reply.skipDetailEventIds);
          assert.equal(run.probes, probesBeforeStale, 'Stale schedules must not admit another verification');
        }
        return reply;
      },
    });
    assert.equal(staleProgress, true);
    assert.equal(probesBeforeStale, 2);
    assert.equal(run.cancelled, 2, 'Existing verification must stop when schedule proof expires');
    await run.refreshSchedule();
    assert.deepEqual({ retainedEvents: result.events.map(event => event.id), skippedPublishedEvent: staleSkips.includes(captured.event.id),
      restoredChoices: await run.choices() }, {
      retainedEvents: ['ncaaf:66919'], skippedPublishedEvent: false, restoredChoices: expectedCandidates,
    });
    run.clockOnly(outage === 'stale' ? 94_000 : 4000);
    await run.coordinator.command({ kind: 'check-sources', gameIds: [captured.game.id], retry: false });
    await drain();
    assert.equal(run.probes, 4, 'Verification resumes after fresh schedule proof and cancellation cooldown');
  } finally { await run.stop(); }
});

test('StreamEast acknowledgements preserve an eligible publication while schedule verification is stale', async () => {
  const east = z.object({ game: GameSchema, event: StreameastCatalogSchema.shape.events.element }).parse(JSON.parse(
    readFileSync(new URL('./fixtures/streameast-asu-texas-tech-publication-20261017.json', import.meta.url), 'utf8')));
  assert.equal(east.event.detail.kind, 'collected');
  if (east.event.detail.kind !== 'collected') throw new Error('Expected captured servers');
  const run = fixture({ game: east.game, at: east.event.detail.at, kind: 'streameast' });
  const runId = randomUUID();
  const event = { ...east.event, detail: { kind: 'collected' as const, at: run.at, servers: east.event.detail.servers } };
  const publish = (sequence: number) => run.coordinator.command({ kind: 'streameast-catalog', catalog: {
    runId, sequence, startedAt: run.at, state: { kind: 'collecting' }, categories: {
      ncaaf: { kind: 'collected', at: run.at }, nfl: { kind: 'pending' },
    }, events: [event], rejectedGames: [],
  } satisfies StreameastCatalog });
  try {
    assert.equal((await publish(0)).kind, 'catalog-ack');
    await drain();
    assert.deepEqual(await run.choices(), ['streameast-server:ncaaf:46996:3', 'streameast-server:ncaaf:46996:4', 'streameast:54', 'wikisport:strm:24']);
    const before = run.probes;
    run.clockOnly(91_000);
    const reply = await publish(1);
    await drain();
    assert.equal(run.probes, before, 'An eligible listing must not authorize stale-schedule verification');
    assert.equal(reply.kind, 'catalog-ack');
    if (reply.kind === 'catalog-ack') assert.deepEqual(reply.skipDetailEventIds, []);
  } finally { await run.stop(); }
});

for (const excluded of ['final', 'unmatched'] as const) test(`${excluded} browser events remain excluded from native detail work`, async () => {
  const run = fixture({ game: excluded === 'final' ? recordFinal({ ...captured.game, status: 'post', lifecycle: 'final' }, published.at) : captured.game });
  try {
    const teams: [string, string] | null = excluded === 'unmatched'
      ? [captured.game.home.name, captured.game.home.name] : captured.event.teams;
    const event: SportsurgeCatalog['events'][number] = { ...captured.event, teams, detail: { kind: 'pending' } };
    const catalog: SportsurgeCatalog = { runId: randomUUID(), sequence: 0, startedAt: run.at, state: { kind: 'collecting' },
      categories: { ncaaf: { kind: 'collected', at: run.at }, nfl: { kind: 'pending' } }, events: [event], rejectedGames: [], catalogIssues: [] };
    const reply = await run.coordinator.command({ kind: 'sportsurge-catalog', catalog });
    assert.equal(reply.kind, 'catalog-ack');
    if (reply.kind === 'catalog-ack') assert.deepEqual(reply.skipDetailEventIds, ['ncaaf:66919']);
    assert.equal(run.probes, 0);
    assert.deepEqual(await run.choices(), []);
  } finally { await run.stop(); }
});
