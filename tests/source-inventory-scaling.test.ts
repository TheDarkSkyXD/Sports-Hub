import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

test('saved listings retain their matches without rebuilding game aliases for every listing', () => {
  const at = Date.parse('2026-10-08T18:00:00Z');
  let aliasReads = 0;
  const team = (name: string, id: string) => ({
    id, name, short: name, abbreviation: name, color: '112233',
    get aliases() { aliasReads++; return [name]; },
  });
  const games: Game[] = Array.from({ length: 40 }, (_, index) => ({
    id: String(index), league: 'nfl', name: `Away ${index} at Home ${index}`,
    date: new Date(at).toISOString(),
    home: team(`Home ${index}`, `espn:nfl:home-${index}`),
    away: team(`Away ${index}`, `espn:nfl:away-${index}`),
    status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
  }));
  const observations: Observation[] = Array.from({ length: 400 }, (_, index) => ({
    id: `listing-${index}`, sourceId: 'fixture', url: `https://fixture.example/watch/${index}`,
    title: 'Away 0 at Home 0', league: 'nfl', teams: ['Away 0', 'Home 0'],
    kickoff: at, rawTime: new Date(at).toISOString(), observedAt: at, parserVersion: 1,
  }));
  const snapshot = sourceInventory({
    at, revision: 1, lastDiscoveryAt: at,
    sources: [{ id: 'fixture', url: 'https://fixture.example/', family: 'fixture' }],
    observations, games, candidates: new Map(), attempts: {},
    availability: () => ({ kind: 'unknown' }),
    sportsurgeCatalog: { current: null, lastComplete: null, previous: null },
    streameastCatalog: { current: null, lastComplete: null, previous: null },
  });
  assert.equal(snapshot.sources[0].listingCount, 400);
  assert.equal(snapshot.sources[0].matchedGameCount, 1);
  assert.equal(snapshot.sources[0].links[0].gameId, '0');
  assert.ok(aliasReads <= games.length * 8,
    `Source polling reread game aliases ${aliasReads} times for ${games.length} games`);
});
