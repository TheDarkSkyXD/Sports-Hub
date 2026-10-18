import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureCollector, SOURCES } from '../lib/football/adapters/sources.ts';
import { catalogStreamProvider } from '../lib/playback/providers/catalog-stream.ts';
import { validStreamTarget } from '../lib/playback/providers/catalog-stream-policy.ts';

const eventId = 'charlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200';
const at = Date.parse('2026-10-11T17:30:00Z');
const event = {
  id: eventId,
  title: 'Charlotte Motor Speedway — The Chase - Race: Bank of America 400',
  category: 'motor-sports',
  date: 1791745200000,
  teams: null,
  sources: [{ source: 'sp:hotel', id: eventId }],
};
const media = 'https://lb5.strmd.st/secure/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/hotel/stream/hotelcharlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200/1/playlist.m3u8';
const stream = { id: eventId, streamNo: 1, source: 'streamed', embedUrl: media };
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6,\nsegment.ts';

test('the published hotel HLS branch belongs only to the LiveSportPro hotel source', () => {
  assert.equal(validStreamTarget('livesportpro', 'sp:hotel', eventId, 1, media), true);
  assert.equal(validStreamTarget('livesportpro', 'sp:hotel', eventId, 1, media.replace('/hotel/', '/ingest/')), true);
  assert.equal(validStreamTarget('livesportpro', 'sp:golf', eventId, 1, media), false);
  assert.equal(validStreamTarget('streamed', 'hotel', eventId, 1, media), false);
  for (const invalid of [
    media.replace('lb5.strmd.st', 'lb5.strmd.st.evil.test'),
    media.replace('/hotel/', '/hotels/'),
    media.replace('/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/', '/short/'),
    media.replace('/1/playlist', '/0/playlist'),
    `${media}?access=unknown`,
  ]) {
    assert.equal(validStreamTarget('livesportpro', 'sp:hotel', eventId, 1, invalid), false);
  }
});

test('LiveSportPro resolves the published hotel choice and opens its HLS playlist', async () => {
  const source = SOURCES.find(row => row.id === 'livesportpro');
  assert.ok(source);
  const collector = createFixtureCollector();
  const listing = collector.parseListings(source, JSON.stringify([event]), at);
  assert.equal(listing.outcome, 'parsed');
  const observation = listing.observations[0];
  const detail = await collector.readHtml(observation.url, new AbortController().signal);
  const players = await collector.resolvePlayers('nascar-cup-202610110021', observation, detail,
    new AbortController().signal, async url => {
      assert.equal(url, `https://api.kultsport.com/api/stream/sp%3Ahotel/${eventId}`);
      return JSON.stringify([stream]);
    });
  assert.equal(players.length, 1);
  const locator = players[0].locator;
  assert.equal(locator.provider, 'catalog-stream');
  assert.ok(locator.provider === 'catalog-stream');
  assert.equal(locator.sourceName, 'sp:hotel');
  assert.equal(locator.streamNo, 1);
  const playback = await catalogStreamProvider(async url => {
    if (url.pathname === '/api/matches/all') return new Response(JSON.stringify([event]), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === `/api/stream/sp%3Ahotel/${eventId}`) return new Response(JSON.stringify([stream]), { headers: { 'content-type': 'application/json' } });
    assert.equal(url.href, media);
    return new Response(playlist, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  }).open(locator, new AbortController().signal, 'probe');
  try {
    const response = await playback.root.read({ signal: new AbortController().signal });
    assert.equal(response.status, 200);
    assert.equal(await new Response(response.body).text(), playlist);
  } finally {
    playback.close();
  }
});

test('hotel HLS resolution still rejects wrong response IDs and source metadata', async () => {
  const source = SOURCES.find(row => row.id === 'livesportpro');
  assert.ok(source);
  for (const invalid of [{ ...stream, id: 'wrong-event' }, { ...stream, source: 'wrong-source' }]) {
    const collector = createFixtureCollector();
    const observation = collector.parseListings(source, JSON.stringify([event]), at).observations[0];
    await assert.rejects(collector.resolvePlayers('nascar-cup-202610110021', observation, JSON.stringify(event),
      new AbortController().signal, async () => JSON.stringify([invalid])), /parser-changed/);
  }
});
