import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedDiscoveryUrl, createFixtureCollector, parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { parseScoreboard } from '../lib/sunday.ts';
import { createSourceEventMatcher } from '../lib/football/domain/matching.ts';
import { GameSchema } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-12T14:00:00Z');
const kickoff = Date.parse('2026-10-13T23:00:00Z');
function source(id: string) {
  const found = SOURCES.find(row => row.id === id);
  assert.ok(found);
  return found;
}

test('published Contender Series spellings retain UFC classification', () => {
  for (const title of ["Dana White's Contender Series", 'Dana Whites Contender Series', 'Dana White’s Contender Series']) {
    const body = JSON.stringify([{ id: 'dwcs-week-10', title, category: 'fight', date: kickoff, teams: null, sources: [] }]);
    assert.deepEqual(parseListings(source('streamed'), body, at).observations.map(row => row.league), ['ufc'], title);
    const games = parseScoreboard({ events: [{ id: '600060741', name: title, date: new Date(kickoff).toISOString() }] }, 'ufc');
    assert.deepEqual(games.map(game => game.id), ['ufc-600060741'], title);
  }
});

test('Sportsbite retains supported combat and wrestling cards without team fields', () => {
  for (const league of ['ufc', 'boxing', 'wwe', 'tna', 'aew', 'wrestling'] as const) {
    assert.ok(source('sportsbite').leagues.includes(league), league);
  }
  const events = [
    { title: "Dana White's Contender Series: Season 10, Week 10", category: 'fight', league: 'ufc' },
    { title: 'Castillo vs Zarate', category: 'boxing', league: 'boxing' },
    { title: 'AEW Dynamite', category: 'wrestling', league: 'aew' },
  ].map((row, index) => ({ ...row, event_key: `fg-event-${index}`, start: new Date(kickoff).toISOString(),
    kickoffMs: kickoff, teams: null, streams: [] }));
  const body = JSON.stringify({ scraped_at: new Date(at).toISOString(), days: [{ date: '2026-10-13', events }] });
  assert.deepEqual(parseListings(source('sportsbite'), body, at).observations.map(row => [row.title, row.league]),
    events.map(row => [row.title, row.league]));
});

test('dedicated event categories classify dated cards and leave continuous channels unclassified', () => {
  const html = '<a href="https://ms.buffstream.io/mma-streams/dana-whites-contender-series-season-10-week-10-live-stream"><h4>Dana Whites Contender Series Season 10 Week 10 vs Live Broadcast</h4><p>2026-10-13, Tuesday - 07:00 pm ET</p></a>';
  assert.deepEqual(parseListings(source('markkystreams-ufc'), html, at).observations.map(row => row.league), ['ufc']);
  const channel = '<a href="/event/ppv-nfl-network">NFL Network Live Channel24/7Watch→</a>';
  assert.deepEqual(parseListings(source('methstreams'), channel, at).observations.map(row => row.league), [null]);
  const brandedChannel = '<a href="https://ms.buffstream.io/mma-streams/aew-wrestling-live-stream"><h4>AEW Wrestling 24/7</h4></a>';
  assert.deepEqual(parseListings(source('markkystreams-ufc'), brandedChannel, at).observations.map(row => row.league), [null]);
});

test('mixed MMA pages retain UFC coverage and classify published AEW events', () => {
  const cases = [
    ['DWCS S10 W10 PostFight Press Conference vs HD Stream', 'dwcs-s10-w10-postfight-press-conference', 'ufc'],
    ['AEW Dynamite vs Free Online Streaming', 'aew-dynamite', 'aew'],
    ['All Elite Wrestling Collision vs Stream in HD', 'all-elite-wrestling-collision', 'aew'],
  ];
  for (const id of ['markkystreams-ufc', 'ecrackstreams-ufc', 'crackstreams-so-ufc', 'crackstreams-ws-ufc', 'streameasthd-ufc']) {
    const html = cases.map(([title, slug]) => `<a href="https://ms.buffstream.io/mma-streams/${slug}-live-stream"><h4>${title}</h4><p>2026-10-13, Tuesday - 07:00 pm ET</p></a>`).join('');
    assert.deepEqual(parseListings(source(id), html, at).observations.map(row => row.league), ['ufc', 'aew', 'aew'], id);
    assert.ok(source(id).leagues.includes('aew'), id);
  }
});

test('Sportsbite hockey listings can match their scheduled category', () => {
  const games = [
    { id: 'nhl-401892485', league: 'nhl', name: 'Florida Panthers at Buffalo Sabres',
      home: { name: 'Buffalo Sabres', short: 'Sabres', abbreviation: 'BUF', color: '112233', score: '0' },
      away: { name: 'Florida Panthers', short: 'Panthers', abbreviation: 'FLA', color: '332211', score: '0' },
      status: 'pre', lifecycle: 'scheduled', detail: '', redzone: false, date: new Date(kickoff).toISOString() },
  ].map(row => GameSchema.parse(row));
  const body = JSON.stringify({ scraped_at: new Date(at).toISOString(), days: [{ date: '2026-10-13', events: [{
    event_key: 'fg-buffalo-sabres-vs-florida-panthers', title: 'Buffalo Sabres vs Florida Panthers', category: 'hockey',
    start: new Date(kickoff).toISOString(), kickoffMs: kickoff,
    teams: { home: { name: 'Buffalo Sabres' }, away: { name: 'Florida Panthers' } }, streams: [],
  }] }] });
  const listing = parseListings(source('sportsbite'), body, at).observations[0];
  assert.deepEqual(createSourceEventMatcher(games)(listing, { undated: 'none', externalGameId: null }, at).match,
    { kind: 'matched', gameId: 'nhl-401892485' });
  assert.ok(source('sportsbite').leagues.includes('nhl'));
});

test('Sportsbite imported event keys do not discard the other category events', async () => {
  const collector = createFixtureCollector();
  const row = { event_key: 'fg-streamed-live_nba-preseason_trail-blazers-london-lions-live-streaming-660000528',
    title: 'Portland Trail Blazers vs London Lions', category: 'basketball',
    start: new Date(kickoff).toISOString(), kickoffMs: kickoff,
    teams: { home: { name: 'London Lions' }, away: { name: 'Portland Trail Blazers' } }, streams: [] };
  const ufc = { ...row, event_key: 'fg-dana-white-s-contender-series', title: "Dana White's Contender Series",
    category: 'fight', teams: null };
  const body = JSON.stringify({ scraped_at: new Date(at).toISOString(), days: [{ date: '2026-10-13', events: [row, ufc] }] });
  const listing = collector.parseListings(source('sportsbite'), body, at);
  assert.equal(listing.outcome, 'parsed');
  assert.deepEqual(listing.observations.map(event => event.title), ['Portland Trail Blazers vs London Lions', "Dana White's Contender Series"]);
  const event = listing.observations[0];
  assert.equal(allowedDiscoveryUrl(event.url), true);
  assert.equal(JSON.parse(await collector.readHtml(event.url, new AbortController().signal)).event_key, row.event_key);
});

