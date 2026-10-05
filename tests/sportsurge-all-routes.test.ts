import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import type { Game, SportsurgeCatalog, SportsurgeProvider } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-03T20:00:00Z');
const runId = '11111111-1111-4111-8111-111111111111';

function game(league: Game['league']): Game {
  const nfl = league === 'nfl';
  const away = nfl ? 'Kansas City Chiefs' : 'Delaware Blue Hens';
  const home = nfl ? 'Buffalo Bills' : 'Virginia Cavaliers';
  const team = (name: string, id: string) => ({ id, name, short: name, abbreviation: name.slice(0, 3), color: '112233', score: '0' });
  return {
    id: `${league}-999`, league, name: `${away} at ${home}`, date: new Date(at).toISOString(),
    away: team(away, nfl ? 'espn:nfl:12' : 'espn:ncaaf:48'),
    home: team(home, nfl ? 'espn:nfl:2' : 'espn:ncaaf:258'),
    status: 'in', lifecycle: 'live', detail: 'Q2', redzone: false,
    partitions: [nfl ? 'nfl' : 'fcs'],
  };
}

function event(league: Game['league'], count: number, observedAt: number): SportsurgeCatalog['events'][number] {
  const nfl = league === 'nfl';
  const providers: SportsurgeProvider[] = Array.from({ length: count }, (_, index) => ({
    id: `${league}-row-${index + 1}`, label: `Server ${index + 1}`, observedAt,
    destination: { kind: 'link', url: `https://media.example/${league}/server-${index + 1}` },
  }));
  return {
    id: `${league}:${nfl ? 22222 : 11111}`,
    url: `https://v2.sportsurge.net/watch-${nfl ? 22222 : 11111}-${nfl ? 'nfl' : 'cfb'}-${nfl ? 'kansas-city-chiefs-buffalo-bills' : 'delaware-virginia'}/`,
    league, title: nfl ? 'Kansas City Chiefs vs Buffalo Bills' : 'Delaware vs Virginia',
    teams: nfl ? ['Kansas City Chiefs', 'Buffalo Bills'] : ['Delaware', 'Virginia'],
    sourceStatus: 'live', kickoff: nfl ? at : null, advertisedLinkCount: count,
    detail: { kind: 'collected', at: observedAt, providers },
  };
}

function catalog(count: number, sequence: number): SportsurgeCatalog {
  const observedAt = at + sequence * 1000;
  return {
    runId, sequence, startedAt: at,
    state: sequence === 0 ? { kind: 'collecting' } : { kind: 'complete', at: observedAt },
    categories: { ncaaf: { kind: 'collected', at }, nfl: { kind: 'collected', at } },
    events: [event('ncaaf', count, observedAt), event('nfl', count, observedAt)],
    rejectedGames: [], catalogIssues: [],
  };
}

test('live NCAA and NFL games retain and check every safe Sportsurge route across checkpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsurge-all-routes-'));
  const store = new FootballStore(join(dir, 'state.sqlite'));
  const games = [game('ncaaf'), game('nfl')];
  const probed = new Set<string>();
  for (const item of games) store.savePartition(item.league === 'nfl' ? 'nfl' : 'fcs', { games: [item], at });
  const coordinator = new FootballCoordinator({
    store, now: () => at + 60_000, id: () => runId,
    schedules: [{ id: 'fcs', league: 'ncaaf', path: '', group: null }, { id: 'nfl', league: 'nfl', path: '', group: null }],
    sources: [{ id: 'sportsurge-v2', url: 'https://v2.sportsurge.net/watch-nfl-streams/', family: 'sportsurge', kind: 'browser-catalog' }],
    readSchedule: async partition => ({ games: games.filter(item => item.league === partition.league), league: partition.league, at }),
    readSeasonMembership: async () => { throw new Error('unused'); },
    readHtml: async () => { throw new Error('unused'); },
    parseListings: () => ({ observations: [], outcome: 'empty' }),
    enrichObservation: observation => observation,
    compatiblePlayers: () => [],
    retryAfterMs: () => 0,
    probeCandidate: async locator => {
      if (locator.provider !== 'sportsurge-v2') throw new Error('Unexpected provider');
      probed.add(locator.url);
      return { kind: 'playable', proof: 'media' };
    },
  });

  async function checked(count: number) {
    let last: unknown = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      const reply = await coordinator.command({ kind: 'sources' });
      assert.equal(reply.kind, 'sources');
      if (reply.kind !== 'sources') continue;
      const rows = games.map(item => reply.snapshot.games.find(row => row.gameId === item.id));
      last = rows.map(row => ({ gameId: row?.gameId, candidates: row?.candidates.length, working: row?.workingChoiceCount }));
      if (rows.every(row => row?.candidates.length === count && row.workingChoiceCount === count)) return rows;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(`Expected ${count} verified routes for each live game: ${JSON.stringify(last)}`);
  }

  try {
    assert.equal((await coordinator.command({ kind: 'sportsurge-catalog', catalog: catalog(24, 0) })).kind, 'catalog-ack');
    const first = await checked(24);
    for (const row of first) {
      assert.equal(row?.freeChoiceCount, 24);
      assert.equal(new Set(row?.candidates.map(candidate => candidate.id)).size, 24);
    }
    const originalIds = first.map(row => new Set(row?.candidates.map(candidate => candidate.id)));

    assert.equal((await coordinator.command({ kind: 'sportsurge-catalog', catalog: catalog(25, 1) })).kind, 'catalog-ack');
    const second = await checked(25);
    for (let index = 0; index < second.length; index++) {
      const row = second[index];
      assert.equal(row?.freeChoiceCount, 25);
      assert.equal(row?.workingChoiceCount, 25);
      assert.equal(new Set(row?.candidates.map(candidate => candidate.id)).size, 25);
      for (const id of originalIds[index]) assert.equal(row?.candidates.some(candidate => candidate.id === id), true);
    }
    assert.equal(probed.size, 50);
    assert.equal(probed.has('https://media.example/ncaaf/server-25'), true);
    assert.equal(probed.has('https://media.example/nfl/server-25'), true);
  } finally {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
