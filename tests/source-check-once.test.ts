import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { CandidateLocator, Game } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const game: Game = {
  id: '10001', league: 'nfl', name: 'Denver Broncos at San Francisco 49ers', date: new Date(at).toISOString(),
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
  home: { name: 'San Francisco 49ers', short: '49ers', abbreviation: 'SF', color: '112233', score: '0' },
  away: { name: 'Denver Broncos', short: 'Broncos', abbreviation: 'DEN', color: '332211', score: '0' },
};
async function drain() {
  for (let index = 0; index < 30; index++) await new Promise<void>(resolve => setImmediate(resolve));
}
function fixture(options: { count?: number; slow?: boolean; secondGame?: boolean; allFail?: boolean; recoverFailures?: boolean; holdRetries?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'source-check-once-'));
  let clock = at, visible = true, version = 1, finished = false, scheduled = true;
  let count = options.count ?? 2;
  const other: Game = { ...game, id: '10002', name: 'Miami Dolphins at Buffalo Bills',
    home: { ...game.home, name: 'Buffalo Bills', short: 'Bills', abbreviation: 'BUF' },
    away: { ...game.away, name: 'Miami Dolphins', short: 'Dolphins', abbreviation: 'MIA' } };
  const games = options.secondGame ? [game, other] : [game];
  const calls: CandidateLocator[] = [];
  const checked = new Map<string, number>();
  const pending = new Set<{ due: number; finish: () => void }>();
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, schedules: [{ id: 'nfl', league: 'nfl', path: '/fixture', group: null }],
    sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async () => ({ games: scheduled ? games.map(row => finished ? { ...row, status: 'post', lifecycle: 'final' } : row) : [], league: 'nfl', at: clock }),
    readHtml: async () => '<main>fixture</main>',
    parseListings: () => ({ outcome: visible ? 'parsed' : 'empty', observations: visible ? games.map(row => ({
      id: `event-${row.id}-${version}`, sourceId: 'fixture', url: `https://fixture.example/detail/${row.id}/${version}`,
      title: row.name, league: 'nfl', teams: [row.away.name, row.home.name], kickoff: at,
      rawTime: '', observedAt: clock, parserVersion: 2,
    })) : [] }),
    enrichObservation: value => value,
    compatiblePlayers: (gameId, observation) => Array.from({ length: count }, (_, index) => ({
      id: `route-${String(index).padStart(3, '0')}`, label: `Route ${index}`,
      locator: options.slow ? { provider: 'event-page' as const, gameId, eventUrl: observation.url,
        serverUrl: `https://fixture.example/player/${index}` } :
        { provider: 'gooz' as const, playerId: `${observation.url.endsWith('/1') ? 1 : 2}${index}` },
    })),
    probeCandidate: (locator, signal) => {
      calls.push(locator);
      const identity = JSON.stringify(locator);
      const attempts = (checked.get(identity) || 0) + 1;
      checked.set(identity, attempts);
      const index = locator.provider === 'event-page' ? Number(locator.serverUrl.split('/').at(-1)) :
        locator.provider === 'gooz' ? Number(locator.playerId.slice(1)) : 0;
      const result: CandidateProbeResult = (options.allFail || index % 2) && !(options.recoverFailures && attempts > 1)
        ? { kind: 'unavailable', reason: 'upstream' } : { kind: 'playable', proof: 'media' };
      if (!options.slow && !(options.holdRetries && attempts > 1)) return Promise.resolve(result);
      return new Promise<CandidateProbeResult>(resolve => {
        const entry = { due: clock + 20_000, finish: () => { pending.delete(entry); resolve(result); } };
        pending.add(entry);
        signal.addEventListener('abort', () => { pending.delete(entry); resolve({ kind: 'deferred', retryAfterMs: 1000 }); }, { once: true });
      });
    },
  });
  const snapshot = async () => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected sources');
    return reply.snapshot;
  };
  return { coordinator, calls, snapshot,
    setVisible: (value: boolean) => { visible = value; },
    setScheduled: (value: boolean) => { scheduled = value; },
    setCount: (value: number) => { count = value; },
    change: () => { version++; }, finish: () => { finished = true; },
    async refresh(elapsed = 0) {
      clock = at + elapsed;
      for (const entry of [...pending]) if (entry.due <= clock) entry.finish();
      await drain();
      await coordinator.refresh(true);
      await drain();
    },
    async stop() { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('300 slow browser choices qualify before maintenance and remain selectable during rechecks', async () => {
  const run = fixture({ count: 300, slow: true, recoverFailures: true });
  try {
    await run.refresh();
    for (let elapsed = 20_000; elapsed <= 26 * 60_000; elapsed += 20_000) await run.refresh(elapsed);
    assert.equal(new Set(run.calls.map(row => JSON.stringify(row))).size, 300);
    const firstRetry = run.calls.findIndex((row, index) => run.calls.slice(0, index)
      .some(previous => JSON.stringify(previous) === JSON.stringify(row)));
    assert.ok(firstRetry >= 300, 'retry work must not run ahead of never-checked feeds');
    const opened = await run.coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback', 'a working route remains selectable while maintenance probes are pending');
    for (let elapsed = 26 * 60_000 + 20_000; elapsed <= 45 * 60_000; elapsed += 20_000) await run.refresh(elapsed);
    const candidates = (await run.snapshot()).games[0].candidates;
    assert.equal(candidates.length, 300);
    assert.ok(candidates.filter(row => row.availability.kind === 'playable').length > 150,
      'failed routes make progress alongside working rechecks');
    const checksAt45 = run.calls.length;
    assert.ok(checksAt45 > 300);
    await run.refresh(50 * 60_000);
    assert.ok(run.calls.length > checksAt45, 'due maintenance keeps checking after initial qualification');
  } finally { await run.stop(); }
});

test('new published choices are discovered while working proof is refreshed at the interval', async () => {
  const run = fixture({ count: 1 });
  try {
    await run.refresh();
    const before = (await run.snapshot()).games[0].candidates[0].availability;
    run.setCount(2);
    await run.refresh(299_999);
    assert.equal((await run.snapshot()).games[0].candidates.length, 1);
    await run.refresh(300_001);
    const after = (await run.snapshot()).games[0].candidates;
    assert.equal(after.length, 2);
    assert.deepEqual(before, { kind: 'playable', proof: 'media', checkedAt: at });
    assert.deepEqual(after.find(row => row.id === 'route-000')?.availability,
      { kind: 'playable', proof: 'media', checkedAt: at + 300_001 });
    assert.equal(run.calls.length, 3);
  } finally { await run.stop(); }
});

test('automatic working rechecks and manual failed-feed retries use their own cadence', async () => {
  const run = fixture();
  try {
    await run.refresh();
    const before = (await run.snapshot()).games[0].candidates;
    await run.refresh(11 * 60_000);
    const after = (await run.snapshot()).games[0].candidates;
    assert.deepEqual(before.find(row => row.id === 'route-000')?.availability,
      { kind: 'playable', proof: 'media', checkedAt: at });
    assert.deepEqual(after.find(row => row.id === 'route-000')?.availability,
      { kind: 'playable', proof: 'media', checkedAt: at + 11 * 60_000 });
    assert.equal(after.find(row => row.id === 'route-001')?.availability.kind, 'unavailable');
    assert.equal(run.calls.length, 4);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: game.id, manual: false })).kind, 'playback');
    await run.coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: true });
    await drain();
    assert.equal(run.calls.length, 5);
    assert.equal(run.calls[4].provider === 'gooz' && run.calls[4].playerId, '11');
    await run.refresh(31 * 60_000);
    assert.deepEqual((await run.snapshot()).games[0].candidates.find(row => row.id === 'route-000')?.availability,
      { kind: 'playable', proof: 'media', checkedAt: at + 31 * 60_000 });
    assert.equal(run.calls.length, 7);
  } finally { await run.stop(); }
});

test('a returning failed feed retries after its cooldown while a changed locator is checked immediately', async () => {
  const run = fixture({ allFail: true });
  try {
    await run.refresh();
    run.setVisible(false);
    await run.refresh(31 * 60_000);
    assert.equal((await run.snapshot()).games.flatMap(row => row.candidates).length, 0);
    run.setVisible(true);
    await run.refresh(36 * 60_000);
    assert.equal((await run.snapshot()).games[0].candidates.find(row => row.id === 'route-001')?.availability.kind, 'unavailable');
    assert.equal(run.calls.length, 4, 'a returning failed feed must recover after its check cooldown');
    run.change();
    await run.refresh(41 * 60_000);
    assert.equal(run.calls.length, 8);
    assert.deepEqual(run.calls.slice(4).map(row => row.provider === 'gooz' && row.playerId).sort(), ['10', '11', '20', '21']);
  } finally { await run.stop(); }
});

test('the same physical direct player in different games receives independent checks', async () => {
  const run = fixture({ secondGame: true, count: 1 });
  try {
    await run.refresh();
    const snapshot = await run.snapshot();
    assert.equal(run.calls.length, 2, JSON.stringify(snapshot.games));
    assert.deepEqual(snapshot.games.map(row => row.workingChoiceCount), [1, 1]);
  } finally { await run.stop(); }
});

test('a never-checked feed displaces a queued retry without losing the failed feed evidence', async () => {
  const run = fixture({ count: 300, allFail: true, holdRetries: true });
  try {
    await run.refresh();
    assert.equal(run.calls.length, 300);
    assert.equal((await run.snapshot()).games[0].candidates.filter(row => row.availability.kind === 'unavailable').length, 300);
    await run.refresh(300_000);
    const queued = (await run.snapshot()).games[0].candidates;
    assert.equal(queued.filter(row => row.availability.kind === 'checking' && row.availability.progress.kind === 'queued').length, 256);
    assert.equal(run.calls.length, 304);

    run.setCount(301);
    await run.refresh(600_000);
    const discovered = (await run.snapshot()).games[0].candidates;
    assert.equal(discovered.find(row => row.id === 'route-300')?.availability.kind, 'checking');
    const displaced = queued.find(row => row.availability.kind === 'checking' && row.availability.progress.kind === 'queued' &&
      discovered.find(candidate => candidate.id === row.id)?.availability.kind === 'unavailable');
    assert.ok(displaced, 'displacing a queued retry must preserve the earlier failed check');
    assert.equal(discovered.find(row => row.id === displaced.id)?.availability.kind, 'unavailable');

    const admitted = run.calls.length;
    await run.refresh(620_000);
    assert.equal(run.calls[admitted]?.provider === 'gooz' && run.calls[admitted].playerId, '1300', 'new feed checks must run before automatic retries');
    assert.equal((await run.snapshot()).games[0].candidates.find(row => row.id === 'route-300')?.availability.kind, 'unavailable');
  } finally { await run.stop(); }
});

test('increasing the interval postpones queued retries while active checks finish', async () => {
  const run = fixture({ count: 8, allFail: true, holdRetries: true, recoverFailures: true });
  try {
    await run.refresh();
    await run.coordinator.command({ kind: 'set-feed-check-interval', minutes: 1 });
    await drain();
    await run.refresh(60_000);
    const queued = (await run.snapshot()).games[0].candidates;
    assert.equal(queued.filter(row => row.availability.kind === 'checking' && row.availability.progress.kind === 'queued').length, 4);
    assert.equal(run.calls.length, 12);

    await run.coordinator.command({ kind: 'set-feed-check-interval', minutes: 15 });
    await drain();
    await run.refresh(80_000);
    const postponed = (await run.snapshot()).games[0];
    assert.equal(postponed.workingChoiceCount, 4);
    assert.equal(postponed.candidates.filter(row => row.availability.kind === 'unavailable' && row.availability.retryAt === at + 900_000).length, 4);
    await run.refresh(899_999);
    assert.equal(run.calls.length, 12);
    await run.refresh(900_000);
    assert.equal(run.calls.length, 16);
    await run.refresh(920_000);
    assert.equal((await run.snapshot()).games[0].workingChoiceCount, 8);
  } finally { await run.stop(); }
});

test('final games cancel unfinished checks and cannot restart them after grace cleanup', async () => {
  const run = fixture({ count: 8, slow: true });
  try {
    await run.refresh();
    assert.equal(run.calls.length, 4);
    run.finish();
    await run.refresh(1000);
    assert.equal((await run.snapshot()).games.flatMap(row => row.candidates).length, 0);
    await run.refresh(301_001);
    await run.coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: true });
    await drain();
    assert.equal(run.calls.length, 4);
    assert.equal((await run.coordinator.command({ kind: 'open', gameId: game.id, manual: false })).kind, 'error');
  } finally { await run.stop(); }
});

test('decoded playback cancels its queued retry while other explicit retries still run', async () => {
  const run = fixture();
  try {
    await run.refresh();
    const opened = await run.coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    const session = opened.playback.session;
    const failed = await run.coordinator.command({ kind: 'session', sessionId: session.id, generation: 0, failure: true, retry: false });
    assert.equal(failed.kind, 'session');
    await run.coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: true });
    await run.coordinator.command({ kind: 'playback-evidence', sessionId: session.id, candidateId: session.candidateId,
      generation: 1, evidence: { kind: 'decoded', startupMs: 100 } });
    await drain();
    assert.equal(run.calls.length, 3);
    assert.equal(run.calls[2].provider === 'gooz' && run.calls[2].playerId, '11');
    assert.equal((await run.snapshot()).games[0].candidates.find(row => row.id === session.candidateId)?.availability.kind, 'playable');
  } finally { await run.stop(); }
});

test('a game leaving the schedule without a session releases its terminal proof ownership', async () => {
  const run = fixture({ count: 1, allFail: true });
  try {
    await run.refresh();
    assert.equal(run.calls.length, 1);
    run.setScheduled(false);
    await run.refresh(301_000);
    assert.equal((await run.snapshot()).games.flatMap(row => row.candidates).length, 0);
    run.setScheduled(true);
    await run.refresh(602_000);
    assert.equal(run.calls.length, 2);
    assert.equal((await run.snapshot()).games[0].candidates[0].availability.kind, 'unavailable');
  } finally { await run.stop(); }
});
