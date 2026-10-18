import assert from 'node:assert/strict';
import test from 'node:test';
import { compatiblePlayers } from '../lib/football/adapters/sources.ts';
import type { Observation } from '../lib/football/shared.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import { eventPageProbeIdentity, eventPageProvider } from '../lib/playback/providers/event-page.ts';
import {publishedTopstreamerVideo} from '../lib/playback/providers/topstreamer.ts';

const slug = 'charlotte-motor-speedway-the-chase-race-bank-of-america-400';
const title = 'Charlotte Motor Speedway — The Chase - Race: Bank of America 400';
const date = '2026-10-11T19:00:00Z';
const gameId = 'nascar-cup-202610110021';
const server = `https://foxiy.st/event/${slug}-nascar-cup-series-1791745200/hotel/1`;
const sources = [
  { id: 'buffstreams-f1', host: 'buffstreams.ch' },
  { id: 'methstreams-vg-f1', host: 'methstreams.vg' },
];

function observation(source: typeof sources[number]): Observation {
  return { id: `${source.id}:charlotte`, sourceId: source.id, url: `https://${source.host}/event/${slug}`,
    title, league: 'nascar-cup', teams: null, kickoff: Date.parse(date), rawTime: date,
    observedAt: Date.parse('2026-10-11T17:30:00Z'), parserVersion: 2 };
}

function detail(row: Observation, player = server): string {
  const event = { '@type': 'SportsEvent', name: title, url: row.url, startDate: date,
    sport: 'NASCAR Cup Series', performer: [{ '@type': 'SportsTeam', name: title }], offers: { price: '0' } };
  return `<link rel="canonical" href="${row.url}"><meta property="og:url" content="${row.url}">
    <script type="application/ld+json">${JSON.stringify(event)}</script>
    <a class="sl-row" href="${player}" aria-label="Watch ${title} on Relay A1, opens the player in a new tab"><span class="sl-nm">Relay A1</span></a>`;
}

test('Buffstreams CH and Methstreams VG admit only their exact published NASCAR Foxiy branch', () => {
  for (const source of sources) {
    const row = observation(source);
    assert.equal(validEventPagePair(row.url, server), true);
    for (const invalid of [
      server.replace('foxiy.st', 'fxtrend.st'),
      server.replace('foxiy.st', 'foxiy.st.evil.test'),
      server.replace(slug, 'other-race'),
      server.replace('nascar-cup-series', 'nascar-truck-series'),
      server.replace('/hotel/1', '/hotel/0'),
      server.replace('/hotel/1', '/hotel/01'),
      server.replace('/hotel/1', '/hotel/1000'),
      server.replace('/hotel/1', '/vector/1'),
      server.replace('1791745200', '179174520'),
      `${server}?player=1`,
      `${server}#player`,
      server.replace('https:', 'http:'),
      `https://foxiy.st/event/${slug}`,
    ]) assert.equal(validEventPagePair(row.url, invalid), false, invalid);
    assert.equal(validEventPagePair(row.url.replace(source.host, `${source.host}.evil.test`), server), false);
  }
});

test('both new source details retain the exact same-race player and reject conflicting dates and series', () => {
  for (const source of sources) {
    const row = observation(source);
    const players = compatiblePlayers(gameId, row, detail(row));
    assert.deepEqual(players.map(player => player.locator), [{ provider: 'event-page', gameId, eventUrl: row.url, serverUrl: server }]);
    assert.deepEqual(compatiblePlayers(gameId, row, detail(row, server.replace('1791745200', '1791831600'))), []);
    assert.deepEqual(compatiblePlayers(gameId, { ...row, kickoff: Date.parse(date) + 86_400_000 }, detail(row)), []);
    assert.deepEqual(compatiblePlayers(gameId, { ...row, league: 'nascar-truck' }, detail(row)), []);
    assert.deepEqual(compatiblePlayers(gameId, row, detail(row, server.replace('foxiy.st', 'fxtrend.st'))), []);
  }
});

test('the shared Foxiy player keeps one probe across both new hosts and existing published sources', () => {
  const expected = JSON.stringify(['event-page', 'fxtrend', gameId, server]);
  for (const host of ['buffstreams.ch', 'methstreams.vg', 'methstreams.st', 'crackstreams.st']) {
    assert.equal(eventPageProbeIdentity({ provider: 'event-page', gameId, eventUrl: `https://${host}/event/${slug}`, serverUrl: server }), expected);
  }
});

test('both new hosts use the shared static Foxiy path and honor cancellation before browser playback', async () => {
  for (const source of sources) {
    let opened = false;
    const provider = eventPageProvider(async () => { opened = true; return null; });
    const controller = new AbortController();
    const reason = new Error('Player request canceled');
    controller.abort(reason);
    await assert.rejects(provider.open({ provider: 'event-page', gameId, eventUrl: observation(source).url, serverUrl: server },
      controller.signal, 'probe'), error => error === reason);
    assert.equal(opened, false);
  }
});

test('the dated NASCAR player bypasses a static adapter that requires an identical source event path',async()=>{
  let reads=0;
  const playback=await publishedTopstreamerVideo(new URL(server),new URL(observation(sources[0]).url),
    new AbortController().signal,async()=>{reads++;return new Response('<html></html>',{headers:{'content-type':'text/html'}});});
  assert.equal(playback,null);
  assert.equal(reads,0);
});
