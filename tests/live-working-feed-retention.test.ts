import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { Game, Observation, SportsurgeCatalog } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const games: Game[] = [
  ['401872973', 'Tennessee Titans', 'Baltimore Ravens'],
  ['401872975', 'Denver Broncos', 'San Francisco 49ers'],
].map(([id, away, home]) => ({
  id, league: 'nfl', name: `${away} at ${home}`, date: new Date(at).toISOString(),
  home: { name: home, short: home, abbreviation: 'H', color: '112233', score: '0' },
  away: { name: away, short: away, abbreviation: 'A', color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
}));

async function drain(): Promise<void> {
  for (let index = 0; index < 60; index++) await new Promise<void>(resolve => setImmediate(resolve));
}

function fixture(upcoming = false, catalog = false) {
  const directory = mkdtempSync(join(tmpdir(), 'live-working-retention-'));
  let clock = at;
  let published = true;
  let playersPublished = true;
  let finished = false;
  let checks = 0;
  let detailReads = 0;
  let held = false;
  const pending: Array<{ id: string; resolve: (result: CandidateProbeResult) => void }> = [];
  const matches = () => games.map(game => upcoming ? { ...game, status: 'pre' as const, lifecycle: 'scheduled' as const,
    date: new Date(at + 3600000).toISOString() } : finished ? { ...game, status: 'post' as const,
    lifecycle: 'final' as const, detail: 'Final', finalObservedAt: clock, graceEndsAt: clock + 300000 } : game);
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, sources: catalog ? [{ id: 'sportsurge-v2', url: 'https://v2.sportsurge.net/watch-nfl-streams/',
      family: 'sportsurge-v2', kind: 'browser-catalog' }] : [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async source => ({ games: source.id === 'nfl' ? matches() : [], at: clock, league: source.league }),
    readHtml: async url => { if (url !== 'https://fixture.example/list') detailReads++; return '<main>published</main>'; },
    parseListings: () => ({ outcome: published ? 'parsed' : 'empty', observations: published ? matches().map((game): Observation => ({
      id: `listing-${game.id}`, sourceId: 'fixture', url: `https://fixture.example/game/${game.id}`,
      title: game.name, league: 'nfl', teams: [game.away.name, game.home.name], kickoff: Date.parse(game.date ?? ''),
      rawTime: '', observedAt: clock, parserVersion: 2,
    })) : [] }),
    enrichObservation: value => value,
    compatiblePlayers: gameId => playersPublished ? [1, 2].map(server => ({
      id: `${gameId}-${server}`, label: `Server ${server}`, locator: { provider: 'gooz' as const, playerId: `${gameId}${server}` },
    })) : [],
    probeCandidate: async (locator, signal) => {
      assert.ok(locator.provider === 'gooz' || locator.provider === 'sportsurge-v2');
      const id = locator.provider === 'gooz' ? locator.playerId : locator.provider === 'sportsurge-v2' ? locator.providerId : '';
      checks++;
      if (held) return await new Promise<CandidateProbeResult>(resolve => {
        pending.push({ id, resolve });
        signal.addEventListener('abort', () => resolve({ kind: 'deferred', retryAfterMs: 1000 }), { once: true });
      });
      return { kind: 'playable', proof: 'media' };
    },
  });
  const snapshot = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected sources');
    return reply.snapshot;
  };
  const refresh = async (time: number) => { clock = time; await coordinator.refresh(true); await drain(); };
  return { coordinator, snapshot, refresh, pending,
    checks: () => checks, detailReads: () => detailReads,
    hideListings: () => { published = false; }, hidePlayers: () => { playersPublished = false; },
    finish: () => { finished = true; }, hold: () => { held = true; },
    async stop() { for (const job of pending) job.resolve({ kind: 'deferred', retryAfterMs: 1000 });
      await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('live working alternatives survive scheduled detail rereads and media rechecks without viewing sessions', async () => {
  const run = fixture();
  try {
    await run.refresh(at);
    assert.deepEqual((await run.snapshot()).games.map(row => row.workingChoiceCount), [2, 2]);
    assert.equal(run.detailReads(), 2);
    run.hidePlayers();
    await run.refresh(at + 301000);
    assert.deepEqual((await run.snapshot()).games.map(row => row.candidates.filter(row => row.availability.kind === 'playable').length), [2, 2]);
    assert.equal(run.detailReads(), 4, 'both live observations are reread after their interval');
    assert.equal(run.checks(), 8, 'each proven route is rechecked at the saved interval');
  } finally { await run.stop(); }
});

test('a proven live route outlives its listing age and receives a scheduled media recheck', async () => {
  const run = fixture();
  try {
    await run.refresh(at);
    assert.equal(run.checks(), 4);
    run.hideListings();
    await run.refresh(at + 31 * 60000);
    assert.deepEqual((await run.snapshot()).games.map(row => row.candidates.length), [2, 2]);
    assert.deepEqual((await run.snapshot()).games.map(row => row.workingChoiceCount), [2, 2]);
    assert.equal(run.checks(), 8, 'aged retained routes are rechecked once when due');
  } finally { await run.stop(); }
});

test('a playback failure removes only the retained route whose listing is gone', async () => {
  const run = fixture();
  try {
    await run.refresh(at);
    assert.equal((await run.snapshot()).games.reduce((n, row) => n + row.workingChoiceCount, 0), 4);
    run.hideListings();
    const opened = await run.coordinator.command({ kind: 'open', gameId: games[0].id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    assert.equal(opened.playback.session.candidateId, `${games[0].id}-1`);
    await run.coordinator.command({ kind: 'session', sessionId: opened.playback.session.id,
      generation: 0, failure: true, retry: false });
    await run.refresh(at + 31 * 60000);
    const snapshot = await run.snapshot();
    assert.deepEqual(snapshot.games.map(row => row.candidates.map(candidate => candidate.id)), [
      [`${games[0].id}-2`], [`${games[1].id}-1`, `${games[1].id}-2`],
    ]);
    assert.deepEqual(snapshot.games.map(row => row.workingChoiceCount), [1, 2]);
  } finally { await run.stop(); }
});

test('final games retain proven working choices throughout their retention window without more checks', async () => {
  const run = fixture();
  try {
    await run.refresh(at);
    assert.equal((await run.snapshot()).games.length, 2);
    run.finish();
    await run.refresh(at + 301000);
    assert.deepEqual((await run.snapshot()).games.map(row => row.workingChoiceCount), [2, 2]);
    assert.equal(run.checks(), 4);
    await run.refresh(at + 301000 + 24 * 60 * 60_000);
    assert.deepEqual((await run.snapshot()).games, []);
    assert.equal(run.checks(), 4);
  } finally { await run.stop(); }
});

test('working upcoming choices survive expired listings while the game remains eligible', async () => {
  const run = fixture(true);
  try {
    await run.refresh(at);
    assert.equal((await run.snapshot()).games.reduce((n, row) => n + row.workingChoiceCount, 0), 4);
    run.hideListings();
    await run.refresh(at + 31 * 60000);
    const snapshot = await run.snapshot();
    assert.deepEqual(snapshot.games.map(row => row.workingChoiceCount), [2, 2]);
    assert.deepEqual(snapshot.games.flatMap(row => row.candidates.map(candidate => candidate.availability)),
      Array.from({ length: 4 }, () => ({ kind: 'playable', checkedAt: at + 31 * 60000, proof: 'media' })));
    assert.equal(run.checks(), 8);
  } finally { await run.stop(); }
});

test('never-proven live choices are not retained when their listings expire', async () => {
  const run = fixture();
  try {
    run.hold();
    await run.refresh(at);
    assert.equal((await run.snapshot()).games.reduce((n, row) => n + row.candidates.length, 0), 4);
    run.hideListings();
    await run.refresh(at + 31 * 60000);
    assert.equal((await run.snapshot()).games.reduce((n, row) => n + row.candidates.length, 0), 0);
  } finally { await run.stop(); }
});

test('an empty completed Sportsurge catalog retains every proven live alternative without a session', async () => {
  const run = fixture(false, true);
  const catalog: SportsurgeCatalog = {
    runId: '11111111-1111-4111-8111-111111111111', sequence: 0, startedAt: at, state: { kind: 'complete', at },
    categories: { ncaaf: { kind: 'collected', at }, nfl: { kind: 'collected', at } },
    rejectedGames: [], catalogIssues: [], events: games.map((game, index) => ({
      id: `nfl:${1000 + index}`, url: `https://v2.sportsurge.net/watch-${1000 + index}-nfl-game-${index}/`,
      league: 'nfl', title: game.name, teams: [game.away.name, game.home.name], kickoff: at,
      sourceStatus: 'live', advertisedLinkCount: 2,
      detail: { kind: 'collected', at, providers: [1, 2].map(server => ({
        id: `${game.id}-${server}`, label: `Server ${server}`, observedAt: at,
        destination: { kind: 'link', url: `https://fixture.example/player/${game.id}/${server}` },
      })) },
    })),
  };
  try {
    await run.refresh(at);
    assert.equal((await run.coordinator.command({ kind: 'sportsurge-catalog', catalog })).kind, 'catalog-ack');
    await drain();
    assert.deepEqual((await run.snapshot()).games.map(row => row.workingChoiceCount), [2, 2]);
    await run.refresh(at + 301000);
    const empty: SportsurgeCatalog = { ...catalog, runId: '22222222-2222-4222-8222-222222222222',
      startedAt: at + 301000, state: { kind: 'complete', at: at + 301000 }, events: [],
      categories: { ncaaf: { kind: 'collected', at: at + 301000 }, nfl: { kind: 'collected', at: at + 301000 } } };
    assert.equal((await run.coordinator.command({ kind: 'sportsurge-catalog', catalog: empty })).kind, 'catalog-ack');
    await drain();
    assert.deepEqual((await run.snapshot()).games.map(row => row.workingChoiceCount), [2, 2]);
  } finally { await run.stop(); }
});
