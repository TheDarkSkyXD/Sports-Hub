import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureCollector } from '../lib/football/adapters/sources.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import type { Observation } from '../lib/football/shared.ts';

const event = 'https://sportsurgei.is/Jamel-Herring-vs-John-Dodson/79537';
const server = 'https://live3.totalsportek.vg/Jamel-Herring-vs-John-Dodson/79537';
const invalid = [
  server.replace('live3.totalsportek.vg', 'live3.totalsportek.vg.evil.test'),
  server.replace('/79537', '/79538'),
  server.replace('Jamel-Herring-vs-John-Dodson', 'Dmitry-Bivol-vs-Michael-Eifert'),
  `${server}?next=1`, `${server}#player`, `${server}#player=clappr`,
  server.replace('live3.', 'live2.'), server.replace('live3.', 'live5.'),
  server.replace('https:', 'http:'),
];

test('the captured Sportsurgei BKFC live3 server requires its exact event route', () => {
  assert.equal(validEventPagePair(event, server), true);
  for (const url of invalid) assert.equal(validEventPagePair(event, url), false, url);
  assert.equal(validEventPagePair(event.replace('sportsurgei.is', 'nbabitez.com'), server), false);
});

test('the native collector publishes the captured BKFC live3 player and rejects unrelated routes', () => {
  const collector = createFixtureCollector();
  const observation: Observation = { id: 'sportsurgei-boxing:bkfc', sourceId: 'sportsurgei-boxing',
    url: event, title: 'Jamel Herring vs John Dodson', league: 'boxing', teams: null,
    kickoff: null, rawTime: '', observedAt: Date.parse('2026-10-17T22:00:00Z'), parserVersion: 3 };
  const detail = (url: string) => `<link rel="canonical" href="${event}"><a href="${url}">Server</a>`;
  const players = collector.compatiblePlayers('boxing-218065792495125', observation, detail(server));
  assert.equal(players.length, 1);
  assert.deepEqual(players[0].locator, { provider: 'event-page', gameId: 'boxing-218065792495125', eventUrl: event, serverUrl: server });
  for (const url of invalid) assert.deepEqual(collector.compatiblePlayers('boxing-218065792495125', observation, detail(url)), [], url);
});
