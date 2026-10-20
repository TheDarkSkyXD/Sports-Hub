import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compatiblePlayers, createFixtureCollector, parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { createFixtureSchedule, SCHEDULES } from '../lib/football/adapters/schedule.ts';
import {enqueueListings} from './schedule-fixture.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';

const now = Date.parse('2026-10-11T20:31:00Z');
const event = {
  id: 30225, name: 'TNA Bound for Glory', tag: 'Wrestling', source_tag: 'PPV',
  uri_name: 'tna-bound-for-glory-30225', starts_at: 1791750600, ends_at: 1791765000,
  always_live: 0, iframe: 'https://taifood-blog.asia/embed/tna-bound-for-glory-30225', substreams: [],
};
const catalog = JSON.stringify({ success: true, streams: [{ category: 'Wrestling', id: 38, streams: [event] }] });
const eventUrl = 'https://ppv.st/live/tna-bound-for-glory-30225';

test('a published wrestling event page reads its exact catalog detail through the native transport', async () => {
  const collector = createFixtureCollector();
  collector.enqueueFixture({ url: 'https://api.ppv.st/api/streams', body: catalog });
  const detail = JSON.parse(await collector.readHtml(eventUrl, new AbortController().signal));
  assert.equal(detail.id, 30225);
  assert.equal(detail.iframe, event.iframe);
  assert.deepEqual(collector.fixtureRequests().map(request => request.url), ['https://api.ppv.st/api/streams']);
  for (const invalid of [eventUrl + '/extra', eventUrl + '?redirect=1', eventUrl.replace('ppv.st', 'evil.example')]) {
    assert.equal(collector.allowedDiscoveryUrl(invalid), false);
  }
});

test('PPV exposes its Wrestling category for every wrestling scope', () => {
  const snapshot = sourceInventory({ at: now, revision: 1, lastDiscoveryAt: null, browserCollectorsAvailable: true,
    sources: SOURCES, observations: [], games: [], candidates: new Map(), attempts: {},
    sportsurgeCatalog: { current: null, lastComplete: null, previous: null },
    streameastCatalog: { current: null, lastComplete: null, previous: null } });
  const ppv = snapshot.sources.find(source => source.id === 'ppv');
  assert.ok(ppv);
  for (const league of ['wwe', 'tna', 'aew', 'wrestling']) {
    assert.deepEqual(ppv.scopes.find(scope => scope.league === league)?.publicUrls,
      ['https://ppv.st/#38','https://ppv.tj/#38','https://ppvs.pk/#38','https://ppv.rw/#38','https://ppv.ms/#38','https://ppv.bi/#38','https://ppv.ug/#38']);
  }
});

test('the PPV Wrestling category retains AEW and other promotions without inventing teams', () => {
  const source = SOURCES.find(source => source.id === 'ppv');
  assert.ok(source);
  const events = [
    { ...event, id: 29977, name: 'AEW Grand Slam: Collision', uri_name: 'aew/2026-10-10',
      starts_at: 1791676800, iframe: 'https://taifood-blog.asia/embed/aew/2026-10-10' },
    { ...event, id: 30226, name: 'Other promotion event', uri_name: 'other-promotion-event-30226',
      iframe: 'https://taifood-blog.asia/embed/other-promotion-event-30226' },
  ];
  const result = parseListings(source, JSON.stringify({ success: true,
    streams: [{ category: 'Wrestling', streams: events }] }), now);
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations.map(row => row.league), ['aew', 'wrestling']);
  for (const [index, observation] of result.observations.entries()) {
    assert.equal(observation.teams, null);
    const players = compatiblePlayers(`${observation.league}-123`, observation, JSON.stringify(events[index]));
    assert.equal(players.length, 1);
    assert.equal(validEventPagePair(observation.url, events[index].iframe), true);
  }
  const wrongGroup = parseListings(source, JSON.stringify({ success: true,
    streams: [{ category: 'Basketball', streams: events }] }), now);
  assert.deepEqual(wrongGroup.observations, []);
});

test('the published TNA PPV event becomes a schedule card with a matching playable candidate', async () => {
  const source = SOURCES.find(source => source.id === 'ppv');
  const partition = SCHEDULES.find(partition => partition.id === 'tna');
  assert.ok(source);
  assert.ok(partition);
  const result = parseListings(source, catalog, now);
  assert.equal(result.outcome, 'parsed');
  assert.equal(result.observations.length, 1);
  const observation = result.observations[0];
  assert.equal(observation.league, 'tna');
  assert.equal(observation.url, eventUrl);
  assert.equal(observation.teams, null);
  const fixture=createFixtureSchedule();
  await enqueueListings(fixture,async url=>{
      if (url !== 'https://api.ppv.st/api/streams') throw new Error('offline');
      return catalog;
    });
  const { games } = await fixture.readSchedule(partition, now, new AbortController().signal);
  assert.equal(games.length, 1);
  assert.equal(games[0].name, 'TNA Bound for Glory');
  assert.equal(games[0].date, '2026-10-11T20:30:00.000Z');
  assert.deepEqual(matchObservation(observation, games, now), { kind: 'matched', gameId: games[0].id });
  const players = compatiblePlayers(games[0].id, observation, JSON.stringify(event));
  assert.equal(players.length, 1);
  assert.equal(players[0].locator.provider, 'event-page');
  assert.equal(validEventPagePair(eventUrl, event.iframe), true);
  assert.equal(validEventPagePair(eventUrl, event.iframe.replace('30225', '30226')), false);
  assert.equal(validEventPagePair(eventUrl, event.iframe.replace('taifood-blog.asia', 'embedindia.st')), false);
  for (const changed of [{ ...event, id: 30226 }, { ...event, name: 'WWE Bound for Glory' },
    { ...event, iframe: event.iframe.replace('30225', '30226') }]) {
    assert.deepEqual(compatiblePlayers(games[0].id, observation, JSON.stringify(changed)), []);
  }
});
