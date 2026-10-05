import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { test } from 'node:test';
import { compatiblePlayers, enrichObservation, parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import type { Observation } from '../lib/football/shared.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';

const slug = 'baltimore-ravens-vs-tennessee-titans';
const vipEvent = `https://vipbox.fm/onair/nfl/${slug}`;
const strikeEvent = `https://strikeout.im/nfl/stream-${slug}-live`;
const vipServers = [
  'https://vipbox.fm/live/nfl/baltimore-ravens-vs-tennessee-titans-1',
  'https://vipbox.fm/live/nfl/baltimore-ravens-vs-tennessee-titans-2',
  'https://vipbox.fm/live/nfl/baltimore-ravens-vs-tennessee-titans-3',
  'https://vipbox.fm/live/nfl/baltimore-ravens-vs-tennessee-titans-4',
];
const strikeServers = [
  'https://strikeout.im/nfl/1/baltimore-ravens-vs-tennessee-titans-stream',
  'https://strikeout.im/nfl/2/baltimore-ravens-vs-tennessee-titans-stream',
  'https://strikeout.im/nfl/3/baltimore-ravens-vs-tennessee-titans-stream',
  'https://strikeout.im/nfl/4/baltimore-ravens-vs-tennessee-titans-stream',
];

for (const sourceId of ['vipbox-nfl', 'strikeout-nfl']) {
  test(`${sourceId} extracts every published NFL server after checking page identity and kickoff`, () => {
    const vip = sourceId === 'vipbox-nfl';
    const url = vip ? vipEvent : strikeEvent;
    const servers = vip ? vipServers : strikeServers;
    const observation: Observation = {
      id: `${sourceId}:ravens`, sourceId, url, title: 'Baltimore Ravens vs Tennessee Titans',
      league: 'nfl', teams: ['Baltimore Ravens', 'Tennessee Titans'], kickoff: null, rawTime: '',
      observedAt: 1791133500000, parserVersion: 2,
    };
    const html = `<meta property="og:url" content="${url}">
      <h1>${vip ? 'Baltimore Ravens vs Tennessee Titans Streaming Online' : 'Live Baltimore Ravens vs. Tennessee Titans Streams Online'}</h1>
      <script>const siteConfig={"loaded_page":"stream","event_start_ts":1791133200};</script>
      ${servers.map((server, index) => `<button data-uri="${server}">Stream ${index + 1}</button>`).join('')}
      <button data-uri="${servers[0]}">Stream 1 duplicate layout</button>`;
    const enriched = enrichObservation(observation, html);
    assert.equal(enriched.kickoff, Date.parse('2026-10-04T17:00:00Z'));
    const players = compatiblePlayers('401872973', enriched, html);
    assert.deepEqual(players.map(player => player.locator), servers.map(serverUrl => ({
      provider: 'event-page', gameId: '401872973', eventUrl: url, serverUrl,
    })));
    assert.deepEqual(compatiblePlayers('401872973', { ...enriched, kickoff: 1791133260000 }, html), []);
    assert.deepEqual(compatiblePlayers('401872973', { ...enriched, teams: ['Other Team', 'Tennessee Titans'] }, html), []);
    assert.deepEqual(compatiblePlayers('401872973', enriched, html.replace(`content="${url}"`, 'content="https://other.example/event"')), []);
  });
}

test('Strikeout NFL uses one catalog and retains its four published server identities', () => {
  const registered = SOURCES.filter(source => source.id === 'strikeout-football' ||
    'name' in source && source.name === 'Strikeout NFL');
  assert.deepEqual(registered.map(source => source.id),['strikeout-nfl']);
  const source = registered[0];
  const at = Date.parse('2026-10-05T03:50:00Z');
  const catalog = readFileSync(new URL('./fixtures/strikeout-nfl-current-catalog.html',import.meta.url),'utf8');
  const detail = readFileSync(new URL('./fixtures/strikeout-nfl-current-detail.html',import.meta.url),'utf8');
  const observations = parseListings(source,catalog,at).observations;
  assert.deepEqual(observations.map(observation => observation.url),[
    'https://strikeout.im/nfl/stream-carolina-panthers-vs-detroit-lions-live',
    'https://strikeout.im/nfl/stream-new-orleans-saints-vs-atlanta-falcons-live',
  ]);
  const live = enrichObservation(observations[0],detail);
  assert.equal(live.kickoff,Date.parse('2026-10-05T00:20:00Z'));
  assert.deepEqual(compatiblePlayers('401872978',live,detail).map(player => player.id),[
    'event-page:83de474f7a9b6b4f27e449ea',
    'event-page:fce2cbf06b8c40a58a749f49',
    'event-page:54cc450cebd090927577e9ce',
    'event-page:449ff66165ba1d246b6596cd',
  ]);
});

test('NFL event pages retain exact host, league, matchup and server-number boundaries', () => {
  for (const [event, server, wrongLeague] of [
    [vipEvent, vipServers[0], vipServers[0].replace('/nfl/', '/ncaaf/')],
    [strikeEvent, strikeServers[0], strikeServers[0].replace('/nfl/', '/college-football/')],
  ]) {
    assert.equal(validEventPagePair(event, server), true);
    for (const invalid of [wrongLeague, server.replace(slug, 'other-team-vs-tennessee-titans'),
      server.replace('https://', 'https://other.'), server.replace('https://', 'https://user:pass@'),
      `${server}?channel=1`, `${server}#player`, server.replace('https://', 'http://'),
      server.replace('/nfl/', '/nfl/%2e%2e/'), server.replace('.fm/', '.fm:8443/').replace('.im/', '.im:8443/'),
    ]) assert.equal(validEventPagePair(event, invalid), false, invalid);
    for (const invalidEvent of [`${event}?channel=1`, `${event}#player`, event.replace('https://', 'https://user@'),
      event.replace('/nfl/', '/football/'), event.replace('https://', 'http://'),
    ]) assert.equal(validEventPagePair(invalidEvent, server), false, invalidEvent);
  }
  for (const number of ['0', '01', '-1', '10000', 'one']) {
    assert.equal(validEventPagePair(vipEvent, `https://vipbox.fm/live/nfl/${slug}-${number}`), false);
    assert.equal(validEventPagePair(strikeEvent, `https://strikeout.im/nfl/${number}/${slug}-stream`), false);
  }
  assert.equal(validEventPagePair('https://vipbox.fm/onair/ncaaf/oregon-vs-ucla', 'https://vipbox.fm/live/ncaaf/oregon-vs-ucla-1'), true);
  assert.equal(validEventPagePair('https://strikeout.im/college-football/stream-oregon-vs-ucla-live', 'https://strikeout.im/college-football/1/oregon-vs-ucla-stream'), true);
});
