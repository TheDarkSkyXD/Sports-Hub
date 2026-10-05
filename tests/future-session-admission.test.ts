import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-03T18:00:00Z');
const source = { id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' };
const makeGame = (id: string, league: Game['league'], live: boolean): Game => ({
  id, league, name: `Away ${id} at Home ${id}`,
  date: new Date(at + (live ? 0 : 12 * 3600_000)).toISOString(),
  home: { name: `Home ${id}`, short: `Home ${id}`, abbreviation: 'HOM', color: '112233', score: '0' },
  away: { name: `Away ${id}`, short: `Away ${id}`, abbreviation: 'AWY', color: '332211', score: '0' },
  status: live ? 'in' : 'pre', lifecycle: live ? 'live' : 'scheduled',
  detail: live ? 'Q1' : 'Scheduled', redzone: false, partitions: [league === 'nfl' ? 'nfl' : 'fcs'],
});
const future = Array.from({ length: 4 }, (_, index) => makeGame(String(1000 + index), 'nfl', false));
const live = Array.from({ length: 11 }, (_, index) => makeGame(`ncaaf-${2000 + index}`, 'ncaaf', true));
const observation = (game: Game): Observation => ({
  id: `listing-${game.id}`, sourceId: source.id, url: `https://fixture.example/detail/${game.id}`,
  title: game.name, league: game.league, teams: [game.away.name, game.home.name],
  kickoff: Date.parse(game.date || ''), rawTime: '', observedAt: at, parserVersion: 2,
});
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (await check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('coordinator did not reach the required state');
}

test('live first feeds take priority over future selected alternatives while future work still progresses', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'future-session-admission-'));
  let clock = at;
  let publishLive = false;
  let hold = false;
  const admissions: Array<{ gameId: string; phase: 'seed' | 'hold' }> = [];
  const pending: Array<() => void> = [];
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock,
    sources: [source],
    readSchedule: async partition => ({
      games: partition.id === 'nfl' ? future : partition.id === 'fcs' && publishLive ? live : [],
      league: partition.league, at: clock,
    }),
    readHtml: async () => '<main>fixture</main>',
    parseListings: () => ({ outcome: 'parsed', observations: [...future, ...(publishLive ? live : [])].map(observation) }),
    enrichObservation: value => value,
    compatiblePlayers: (gameId, listing) => [
      ...(!gameId.startsWith('ncaaf') ? [{ id: `direct-${gameId}`, label: 'Direct', locator: { provider: 'gooz' as const, playerId: gameId } }] : []),
      ...Array.from({ length: !gameId.startsWith('ncaaf') ? 20 : 1 }, (_, index) => ({
        id: `browser-${gameId}-${index}`, label: 'Browser',
        locator: { provider: 'event-page' as const, gameId, eventUrl: listing.url,
          serverUrl: `https://fixture.example/server/${gameId}/${index}` },
      })),
    ],
    probeCandidate: async (locator, signal) => {
      if (locator.provider === 'gooz') return { kind: 'playable' as const, proof: 'media' as const };
      assert.equal(locator.provider, 'event-page');
      admissions.push({ gameId: locator.gameId, phase: hold ? 'hold' : 'seed' });
      if (!hold) return { kind: 'deferred' as const, retryAfterMs: 2000 };
      await new Promise<void>(resolve => {
        pending.push(resolve);
        signal.addEventListener('abort', resolve, { once: true });
      });
      return locator.gameId.startsWith('ncaaf')
        ? { kind: 'playable' as const, proof: 'media' as const }
        : { kind: 'unavailable' as const, reason: 'upstream' as const };
    },
  });
  try {
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && future.every(game =>
        reply.snapshot.games.find(row => row.gameId === game.id)?.workingChoiceCount === 1);
    });
    const sessions: string[] = [];
    for (const game of future) {
      const reply = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
      assert.equal(reply.kind, 'playback');
      if (reply.kind === 'playback') sessions.push(reply.playback.session.id);
    }
    await until(() => admissions.filter(row => row.phase === 'seed').length >= 4);
    for (let minute = 1; minute <= 5; minute++) {
      clock = at + minute * 60_000;
      for (const sessionId of sessions) {
        const reply = await coordinator.command({ kind: 'session', sessionId, generation: 0, failure: false, retry: false });
        assert.equal(reply.kind, 'session');
      }
    }
    clock += 1;
    publishLive = true;
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && live.every(game =>
        reply.snapshot.games.find(row => row.gameId === game.id)?.freeChoiceCount === 1);
    });
    hold = true;
    clock += 2001;
    await coordinator.refresh(true);
    await until(() => admissions.filter(row => row.phase === 'hold').length >= 4);
    for (let expected = 5; expected <= 44; expected++) {
      pending.shift()?.();
      await until(() => admissions.filter(row => row.phase === 'hold').length >= expected);
    }
    const next = admissions.filter(row => row.phase === 'hold').slice(0, 44).map(row => row.gameId);
    const firstLivePositions = live.map(game => next.indexOf(game.id) + 1);
    assert.deepEqual(firstLivePositions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(next.slice(0, 4).filter(id => id.startsWith('ncaaf')).length, 4,
      'live games without working choices should take the next four admissions');
    assert.ok(next.slice(11).some(id => future.some(game => game.id === id)),
      'future alternatives must keep receiving bounded background turns after first live proofs');
  } finally {
    for (const release of pending) release();
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
