import assert from 'node:assert/strict';
import test from 'node:test';
import { parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import type { ListingSource } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-12T14:00:00Z');
const kickoff = Date.parse('2026-10-13T23:00:00Z');
const sources = ['streamed', 'sportsupa', 'livesportpro', 'sportsbite'].map(id => {
  const source = SOURCES.find(row => row.id === id);
  assert.ok(source, id);
  return source;
});

function listing(source: ListingSource, category: string, title: string, id = 'category-event') {
  const event = {
    id, event_key: `fg-${id}`, title, category, date: kickoff,
    start: new Date(kickoff).toISOString(), kickoffMs: kickoff,
    teams: null, sources: [], streams: [],
  };
  const body = source.id === 'sportsbite'
    ? { scraped_at: new Date(at).toISOString(), days: [{ date: '2026-10-13', events: [event] }] }
    : [event];
  return parseListings(source, JSON.stringify(body), at);
}

for (const source of sources) {
  for (const [title, league, categories] of [
    ["Dana White's Contender Series: Season 10, Week 10", 'ufc', ['fight', 'mma', ' MMA ', 'UFC']],
    ['Formula 1 United States Grand Prix', 'f1', ['motor-sports', 'motor_sports', 'Motor Sports', 'motorsports', 'f1', ' F1 ']],
    ['MotoGP Australian Grand Prix', 'motogp', ['motor-sports', 'motor_sports', 'motogp', ' MotoGP ']],
    ['AEW Dynamite', 'aew', ['wrestling', ' Wrestling ', 'MMA']],
    ['Castillo vs Zarate', 'boxing', ['boxing', ' Boxing ']],
  ] satisfies ReadonlyArray<readonly [string, string, readonly string[]]>) {
    for (const category of categories) {
      test(`${source.id} retains ${league} under category ${JSON.stringify(category)}`, () => {
        const result = listing(source, category, title);
        assert.equal(result.outcome, 'parsed');
        assert.deepEqual(result.observations.map(row => ({ title: row.title, league: row.league, teams: row.teams, kickoff: row.kickoff })),
          [{ title, league, teams: null, kickoff }]);
      });
    }
  }

  test(`${source.id} category aliases still require recognizable event titles`, () => {
    for (const category of ['mma', ' MMA ', 'f1', 'motor_sports', 'motogp']) {
      assert.deepEqual(listing(source, category, 'Unidentified broadcast'), { outcome: 'empty', observations: [] });
    }
    for (const category of ['soccer', 'Golf', 'tennis', 'basketball']) {
      assert.deepEqual(listing(source, category, 'Formula 1 United States Grand Prix'), { outcome: 'empty', observations: [] });
    }
  });

  if (source.id !== 'sportsbite') {
    test(`${source.id} motorsport aliases retain conflicting series rejection`, () => {
      for (const category of ['motor-sports', 'motor_sports', ' Motor Sports ', 'motorsports']) {
        for (const title of ['NASCAR Truck Series at Charlotte', 'NASCAR Xfinity Series at Charlotte', 'MotoGP Charlotte Grand Prix', 'Formula 1 Charlotte Grand Prix']) {
          assert.deepEqual(listing(source, category, title, 'charlotte-nascar-cup-series'), { outcome: 'empty', observations: [] });
        }
      }
    });
  }
}
