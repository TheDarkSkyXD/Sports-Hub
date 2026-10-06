import assert from 'node:assert/strict';
import test from 'node:test';
import { compatiblePlayers, enrichObservation, parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import type { Game } from '../lib/football/shared.ts';

const observedAt = Date.parse('2026-10-05T23:00:00Z');
const kickoff = Date.parse('2026-10-07T00:00:00Z');
const eventUrl = 'https://strikeout.im/college-football/stream-southern-miss-vs-troy-live';
const source = SOURCES.find(item => item.id === 'strikeout-cfb');
assert.ok(source);

const listing = '<a href="/college-football/stream-southern-miss-vs-troy-live">Southern Miss vs Troy</a>';
const detail = `<meta property="og:url" content="${eventUrl}">
  <h1>Live Southern Miss vs. Troy Streams Online</h1>
  <script>const siteConfig={"loaded_page":"stream","event_start_ts":1791331200};</script>
  ${[1, 2, 3].map(number => `<button data-uri="/college-football/${number}/southern-miss-vs-troy-stream">Stream ${number}</button>`).join('')}`;
const team = (id: string, name: string): Game['home'] => ({
  id, name, short: name, abbreviation: name.slice(0, 3), color: '112233', score: null,
});
const southernMiss = team('espn:ncaaf:2572', 'Southern Miss Golden Eagles');
const trojans = team('espn:ncaaf:2653', 'Troy Trojans');
const vikings = team('espn:ncaaf:3237', 'Troy Vikings');
const game = (id: string, home: Game['home']): Game => ({
  id, league: 'ncaaf', name: `${southernMiss.name} at ${home.name}`,
  date: new Date(kickoff).toISOString(), home, away: southernMiss,
  status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled', redzone: false,
});
const trojansGame = game('ncaaf-401871090', trojans);

function publishedObservation() {
  const parsed = parseListings(source, listing, observedAt);
  assert.equal(parsed.outcome, 'parsed');
  assert.equal(parsed.observations.length, 1);
  return enrichObservation(parsed.observations[0], detail);
}

test('tomorrow Strikeout CFB matchup matches its unique dated NCAA game and retains all published servers', () => {
  const observation = publishedObservation();
  assert.deepEqual(observation.teams, ['Southern Miss', 'Troy']);
  assert.equal(observation.kickoff, kickoff);
  assert.deepEqual(matchObservation(observation, [trojansGame], observedAt),
    { kind: 'matched', gameId: trojansGame.id });
  assert.deepEqual(compatiblePlayers(trojansGame.id, observation, detail).map(player =>
    player.locator.provider === 'event-page' ? player.locator.serverUrl : null),
  [1, 2, 3].map(number => `https://strikeout.im/college-football/${number}/southern-miss-vs-troy-stream`));
});

test('the same short Troy name refuses two dated games with the same opponent', () => {
  const observation = publishedObservation();
  const result = matchObservation(observation, [trojansGame, game('ncaaf-other-troy', vikings)], observedAt);
  assert.equal(result.kind, 'unmatched');
});
