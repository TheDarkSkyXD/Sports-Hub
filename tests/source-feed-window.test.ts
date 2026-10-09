import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import { SportsurgeCatalogSchema, type Game, type SportsurgeCatalog } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-05T04:55:00Z');
const pairs = [['Denver Broncos', 'San Francisco 49ers'], ['Miami Dolphins', 'Buffalo Bills'],
  ['Dallas Cowboys', 'New York Giants'], ['Green Bay Packers', 'Chicago Bears']];
function games(): Game[] {
  return pairs.map(([away, home], index) => ({
    id: `${10001 + index}`, league: 'nfl', name: `${away} at ${home}`,
    date: `2026-10-0${3 + index}T17:00:00Z`,
    home: { name: home, short: home, abbreviation: `H${index}`, color: '112233', score: '0' },
    away: { name: away, short: away, abbreviation: `A${index}`, color: '332211', score: '0' },
    ...(index === 0 ? { status: 'in' as const, lifecycle: 'live' as const } : { status: 'pre' as const, lifecycle: 'scheduled' as const }),
    detail: '', redzone: false, partitions: ['nfl'],
  }));
}
async function drain() {
  for (let index = 0; index < 80; index++) await new Promise<void>(resolve => setImmediate(resolve));
}
function fixture(options: { emptyPlayers?: boolean; holdDetail?: string; holdProbe?: string; unmatchedDated?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'source-feed-window-'));
  let clock = at;
  const current = games(), detailReads: string[] = [], probes: string[] = [];
  const heldDetails: Array<{ signal: AbortSignal; release: () => void }> = [];
  const heldProbes: Array<{ signal: AbortSignal; release: () => void }> = [];
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, schedules: [{ id: 'nfl', league: 'nfl', path: '/fixture', group: null }],
    sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' },
      { id: 'sportsurge-v2', url: 'https://v2.sportsurge.net', family: 'sportsurge-v2', kind: 'browser-catalog' }],
    readSchedule: async () => ({ games: current, league: 'nfl', at: clock }),
    readHtml: async (url, signal) => {
      if (url.endsWith('/list')) return '<main>listing</main>';
      detailReads.push(url);
      if (url.endsWith(`/${options.holdDetail}`)) await new Promise<void>(resolve => {
        heldDetails.push({ signal, release: resolve });
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return '<main>player</main>';
    },
    parseListings: () => ({ outcome: 'parsed', observations: [...current.map(row => ({
      id: `event-${row.id}`, sourceId: 'fixture', url: `https://fixture.example/detail/${row.id}`,
      title: row.name, league: 'nfl' as const, teams: [row.away.name, row.home.name] as [string,string], kickoff: Date.parse(row.date!),
      rawTime: '', observedAt: clock, parserVersion: 2 as const,
    })), ...(options.unmatchedDated ? [{ id: 'unmatched', sourceId: 'fixture', url: 'https://fixture.example/detail/unmatched',
      title: 'Unmatched listing', league: 'nfl' as const, teams: ['Unknown Visitors', 'Unknown Hosts'] as [string,string],
      kickoff: Date.parse('2026-10-04T17:00:00Z'), rawTime: '', observedAt: clock, parserVersion: 2 as const }] : [])] }),
    enrichObservation: value => value,
    compatiblePlayers: gameId => options.emptyPlayers ? [] : [{ id: `route-${gameId}`, label: 'Free',
      locator: { provider: 'gooz', playerId: gameId } }],
    probeCandidate: async (locator, signal) => {
      assert.equal(locator.provider, 'gooz');
      probes.push(locator.playerId);
      if (locator.playerId === options.holdProbe) return new Promise<CandidateProbeResult>(resolve => {
        const release = () => resolve({ kind: 'playable', proof: 'media' });
        heldProbes.push({ signal, release });
        signal.addEventListener('abort', release, { once: true });
      });
      return { kind: 'playable', proof: 'media' };
    },
  });
  return { coordinator, current, detailReads, probes, heldDetails, heldProbes,
    setClock: (value: number) => { clock = value; },
    reschedule(index: number, date: string) { current[index] = { ...current[index], date }; },
    async refresh() { await coordinator.refresh(true); await drain(); },
    async snapshot() {
      const reply = await coordinator.command({ kind: 'sources' });
      assert.equal(reply.kind, 'sources');
      if (reply.kind !== 'sources') throw new Error('Expected sources');
      return reply.snapshot;
    },
    async stop() {
      for (const row of [...heldDetails, ...heldProbes]) row.release();
      await coordinator.stop(); rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('only live, today, and tomorrow cause feed work while full board and external manual playback remain available', async () => {
  const run = fixture();
  try {
    await run.refresh();
    assert.deepEqual(run.probes.sort(), ['10001', '10002', '10003']);
    assert.equal(run.detailReads.some(url => url.endsWith('/10004')), false);
    const snapshot = await run.snapshot();
    assert.deepEqual(snapshot.games.map(row => row.gameId).sort(), ['10001', '10002', '10003']);
    assert.equal(snapshot.sources.find(row => row.id === 'fixture')?.listingCount, 3);
    const board = await run.coordinator.command({ kind: 'board' });
    assert.equal(board.kind, 'board');
    if (board.kind === 'board') assert.equal(board.board.games.length, 4);
    for (const command of [{ kind: 'check-sources' as const, gameIds: ['10004'], retry: true },
      { kind: 'open' as const, gameId: '10004', manual: false }]) {
      const result = await run.coordinator.command(command);
      assert.equal(result.kind, 'error');
      if (result.kind === 'error') assert.equal(result.status, 409);
    }
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: '10004', manual: true })).kind, 'playback');
    await drain();
    assert.equal(run.detailReads.some(url => url.endsWith('/10004')), false);
    assert.equal(run.probes.length, 3);
  } finally { await run.stop(); }
});

test('Chicago midnight invalidates cached listing-only rows and admits the new tomorrow without a cache delay', async () => {
  const run = fixture({ emptyPlayers: true });
  try {
    run.setClock(Date.parse('2026-10-05T04:59:59Z'));
    await run.refresh();
    assert.deepEqual((await run.snapshot()).games.map(row => row.gameId).sort(), ['10001', '10002', '10003']);
    run.setClock(Date.parse('2026-10-05T05:00:01Z'));
    assert.deepEqual((await run.snapshot()).games.map(row => row.gameId).sort(), ['10001', '10003', '10004']);
    assert.equal(run.probes.length, 0);
  } finally { await run.stop(); }
});

test('rescheduling outside the window aborts an active detail and blocks its late result', async () => {
  const run = fixture({ holdDetail: '10003' });
  try {
    await run.refresh();
    assert.equal(run.heldDetails.length, 1);
    run.reschedule(2, '2026-10-07T17:00:00Z');
    await run.refresh();
    assert.equal(run.heldDetails[0].signal.aborted, true);
    assert.equal(run.probes.includes('10003'), false);
    assert.equal((await run.snapshot()).games.some(row => row.gameId === '10003'), false);
  } finally { await run.stop(); }
});

test('Chicago midnight expires dated unmatched diagnostics even when eligible game IDs stay the same', async () => {
  const run = fixture({ emptyPlayers: true, unmatchedDated: true });
  try {
    run.current.splice(1);
    run.setClock(Date.parse('2026-10-05T04:59:59Z'));
    await run.refresh();
    assert.equal((await run.snapshot()).sources.find(row => row.id === 'fixture')?.listingCount, 2);
    run.setClock(Date.parse('2026-10-05T05:00:01Z'));
    assert.equal((await run.snapshot()).sources.find(row => row.id === 'fixture')?.listingCount, 1);
  } finally { await run.stop(); }
});

test('rescheduling aborts active media work while completed proof survives a temporary window exclusion', async () => {
  const run = fixture({ holdProbe: '10003' });
  try {
    await run.refresh();
    assert.equal(run.heldProbes.length, 1);
    run.reschedule(1, '2026-10-07T17:00:00Z');
    run.reschedule(2, '2026-10-07T17:00:00Z');
    await run.refresh();
    assert.equal(run.heldProbes[0].signal.aborted, true);
    assert.deepEqual((await run.snapshot()).games.map(row => row.gameId), ['10001']);
    run.reschedule(1, '2026-10-04T17:00:00Z');
    await run.refresh();
    assert.equal((await run.snapshot()).games.find(row => row.gameId === '10002')?.workingChoiceCount, 1);
    assert.equal(run.probes.filter(id => id === '10002').length, 2);
  } finally { await run.stop(); }
});

test('Sportsurge skip decisions preserve an eligible sibling sharing an excluded event ID', async () => {
  const run = fixture({ emptyPlayers: true });
  try {
    await run.refresh();
    const rows = [run.current[2], run.current[3], run.current[3]];
    const catalog: SportsurgeCatalog = { runId: '11111111-1111-4111-8111-111111111111', sequence: 0,
      startedAt: at, state: { kind: 'collecting' }, categories: { nfl: { kind: 'collected', at }, ncaaf: { kind: 'collected', at } },
      rejectedGames: [], catalogIssues: [], events: rows.map((row, index) => ({
        id: `nfl:${index === 2 ? 2 : 1}`, url: `https://v2.sportsurge.net/watch-${index === 2 ? 2 : 1}-nfl-game-${index}/`,
        league: 'nfl', title: row.name, teams: [row.away.name, row.home.name], kickoff: Date.parse(row.date!),
        sourceStatus: 'upcoming', advertisedLinkCount: 1, detail: { kind: 'pending' },
      })) };
    const parsed = SportsurgeCatalogSchema.parse(catalog);
    const reply = await run.coordinator.command({ kind: 'sportsurge-catalog', catalog: parsed });
    assert.equal(reply.kind, 'catalog-ack');
    if (reply.kind === 'catalog-ack') {
      assert.deepEqual(reply.skipDetailEventIds, ['nfl:2']);
      assert.deepEqual(reply.skipDetailEventUrls, [catalog.events[1].url]);
    }
    assert.deepEqual(await run.coordinator.command({ kind: 'sportsurge-catalog', catalog: parsed }), reply);
    assert.equal((await run.snapshot()).sportsurgeV2.current?.gameCount, 1);
  } finally { await run.stop(); }
});

test('full-schedule matching preserves an ambiguous live listing when its sibling matchup is outside the window', async () => {
  const run = fixture({ emptyPlayers: true });
  try {
    run.current[3] = { ...run.current[0], id: '10004', date: '2026-10-06T17:00:00Z', lifecycle: 'scheduled', status: 'pre' };
    await run.refresh();
    const catalog: SportsurgeCatalog = { runId: '22222222-2222-4222-8222-222222222222', sequence: 0,
      startedAt: at, state: { kind: 'collecting' }, categories: { nfl: { kind: 'collected', at }, ncaaf: { kind: 'collected', at } },
      rejectedGames: [], catalogIssues: [], events: [{ id: 'nfl:3', url: 'https://v2.sportsurge.net/watch-3-nfl-ambiguous/',
        league: 'nfl', title: run.current[0].name, teams: [run.current[0].away.name, run.current[0].home.name],
        kickoff: null, sourceStatus: 'live', advertisedLinkCount: 1, detail: { kind: 'pending' } }] };
    const reply = await run.coordinator.command({ kind: 'sportsurge-catalog', catalog });
    assert.equal(reply.kind, 'catalog-ack');
    if (reply.kind === 'catalog-ack') assert.deepEqual(reply.skipDetailEventIds, []);
    const snapshot = await run.snapshot();
    assert.equal(snapshot.sportsurgeV2.current?.games[0].gameId, null);
    assert.equal(snapshot.sources.find(row => row.id === 'sportsurge-v2')?.matchedGameCount, 0);
  } finally { await run.stop(); }
});
