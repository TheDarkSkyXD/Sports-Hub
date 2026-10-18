import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureCollector, SOURCES } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import type { Game } from '../lib/football/shared.ts';

const scrapedAt = '2026-10-11T16:46:32.754Z';
const at = Date.parse(scrapedAt);
const event = {
  event_key: 'fg-washington-commanders-vs-new-york-giants',
  title: 'Washington Commanders vs New York Giants',
  category: 'american-football',
  start: '2026-10-11T17:00:00.000Z',
  kickoffMs: 1791738000000,
  teams: { home: { name: 'Washington Commanders' }, away: { name: 'New York Giants' } },
  streams: [{
    id: 'fg-lol-new-york-giants-vs-washington-commanders-hd',
    manifest_url: 'https://sportsbite.org/lol-embed/embed/new-york-giants-vs-washington-commanders?v=high&emb=90',
    format: 'iframe',
  }],
};
const otherEvents = [
  {
    title: 'Rennes vs Auxerre',
    category: 'Sports Event',
    start: '2026-10-11T15:15:00.000Z',
    kickoffMs: 1791731700000,
    teams: { home: { name: 'Rennes' }, away: { name: 'Au - erre' } },
    streams: [],
  },
  {
    event_key: 'fg-streamed-live-event_dana-white-s-contender-series-season-10-week-10-live-stream',
    title: "Dana White's Contender Series: Season 10, Week 10",
    category: 'fight',
    start: '2026-10-13T23:00:00.000Z',
    kickoffMs: 1791932400000,
    teams: null,
    streams: [],
  },
];
const catalog = (events: unknown[]) => JSON.stringify({
  scraped_at: scrapedAt,
  days: [{ date: '2026-10-11', events }],
});
const game: Game = {
  id: '401872988', league: 'nfl', name: 'New York Giants at Washington Commanders',
  date: '2026-10-11T17:00:00Z', status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled', redzone: false,
  home: { id: 'espn:nfl:28', name: 'Washington Commanders', short: 'Commanders', abbreviation: 'WSH', color: '5a1414', score: '0' },
  away: { id: 'espn:nfl:19', name: 'New York Giants', short: 'Giants', abbreviation: 'NYG', color: '003c7f', score: '0' },
};

test('unrelated Sportsbite catalog rows cannot discard a supported game or its published player', async () => {
  const source = SOURCES.find(row => row.id === 'sportsbite');
  assert.ok(source);
  const collector = createFixtureCollector();
  const listing = collector.parseListings(source, catalog([...otherEvents, event]), at);
  assert.equal(listing.outcome, 'parsed');
  assert.equal(listing.observations.length, 2);
  assert.equal(listing.observations.find(row => row.league === 'ufc')?.title, "Dana White's Contender Series: Season 10, Week 10");
  const observation = listing.observations.find(row => row.league === 'nfl' || row.teams !== null);
  assert.ok(observation);
  assert.equal(observation.title, 'Washington Commanders vs New York Giants');
  assert.equal(observation.kickoff, 1791738000000);
  assert.deepEqual(matchObservation(observation, [game], at), { kind: 'matched', gameId: '401872988' });
  const detail = await collector.readHtml(observation.url, new AbortController().signal);
  const players = await collector.resolvePlayers(game.id, observation, detail, new AbortController().signal);
  assert.deepEqual(players.map(player => player.locator), [{
    provider: 'event-page',
    gameId: '401872988',
    eventUrl: 'https://sportsbite.org/event/fg-washington-commanders-vs-new-york-giants',
    serverUrl: 'https://sportsbite.org/lol-embed/embed/new-york-giants-vs-washington-commanders?v=high&emb=90',
  }]);
  assert.deepEqual(collector.fixtureRequests(), []);
});

test('malformed Sportsbite rows claiming a supported category still invalidate the catalog', () => {
  const source = SOURCES.find(row => row.id === 'sportsbite');
  assert.ok(source);
  const malformed = [
    { ...event, event_key: undefined },
    { ...event, event_key: 'fg-invalid_key' },
    { ...event, start: '2026-10-12T17:00:00.000Z' },
    { ...event, teams: { home: { name: '' }, away: { name: 'New York Giants' } } },
    { ...event, streams: [{ ...event.streams[0], manifest_url: 'invalid-url' }] },
  ];
  for (const row of malformed) {
    const listing = createFixtureCollector().parseListings(source, catalog([event, row]), at);
    assert.deepEqual(listing, { outcome: 'parser-changed', observations: [] });
  }
});
