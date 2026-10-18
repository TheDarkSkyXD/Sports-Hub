import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { CandidateLocator } from '../lib/football/shared.ts';
import { StreameastEventSchema } from '../lib/football/shared.ts';
import { streameastCandidates } from '../lib/football/domain/streameast-catalog.ts';
import { persistableLocator } from '../lib/playback/persistent-locator.ts';
import { streameastServerUrl } from '../lib/playback/providers/streameast-server.ts';
import { observedStreameastServerPage } from '../lib/playback/providers/public-page.ts';

const require = createRequire(import.meta.url);
const { belongsToSelectedStreameastPlayer, allowsSelectedStreameastNavigation } =
  require('../desktop/sportsurge-observer.cjs');

test('a published free-page server retains a generic track event bound to a NASCAR race', () => {
  const event = StreameastEventSchema.parse({
    id: 'motorsport:46620', league: 'motorsport', title: 'Charlotte Motor Speedway', teams: null,
    kickoff: 1791745200000, espnEventId: null,
    url: 'https://v2.streameast.ga/other-events/charlotte-motor-speedway-1791745200/',
    detail: { kind: 'collected', at: 1791739500000, servers: [{
      id: '1', label: 'Stream 1', availability: { kind: 'free-page' },
      url: 'https://v2.streameast.ga/other-events/charlotte-motor-speedway-1791745200/1',
    }] },
  });
  for (const gameId of ['nascar-cup-202610110021', 'nascar-truck-202610110022']) {
    const [candidate] = streameastCandidates(event, gameId);
    assert.ok(candidate);
    assert.equal(candidate.locator.provider, 'streameast-server');
    if (candidate.locator.provider !== 'streameast-server') assert.fail('Expected the published server choice');
    const locator = candidate.locator;
    assert.equal(streameastServerUrl(locator)?.href, `${event.url}1`);
    assert.equal(persistableLocator(locator), true);
    for (const changed of [
      { gameId: 'f1-202610110021' },
      { gameId: 'nascar-xfinity-202610110021' },
      { gameId: 'nascar-cup-bad' },
      { gameId: '' },
      { sourceEventId: 'nascar-cup:46620' },
      { sourceEventId: 'motorsport:bad' },
      { eventUrl: event.url.replace('/other-events/', '/nfl/') },
      { eventUrl: event.url.replace('-1791745200/', '/') },
      { eventUrl: event.url.replace('-1791745200/', '-1791745200000/') },
      { eventUrl: event.url.replace('v2.streameast.ga', 'v2.streameast.ga.evil.test') },
      { eventUrl: `${event.url}?date=1791831600` },
      { eventUrl: `${event.url}#player` },
    ]) assert.equal(streameastServerUrl({ ...locator, ...changed }), null, JSON.stringify(changed));
  }
});

test('StreamEast server locators persist only exact public game and numeric choice identities', () => {
  const original: Extract<CandidateLocator, { provider: 'streameast-server' }> = {
    provider: 'streameast-server', gameId: '401872979', sourceEventId: 'nfl:46236',
    eventUrl: 'https://v2.streameast.ga/nfl/atlanta-falcons-vs-new-orleans-saints-1/', serverId: '2',
  };
  assert.equal(persistableLocator(original), true);
  assert.equal(streameastServerUrl(original)?.href, `${original.eventUrl}2`);
  const college = { ...original, gameId: 'ncaaf-401872979', sourceEventId: 'ncaaf:46236',
    eventUrl: original.eventUrl.replace('/nfl/', '/cfb/') };
  assert.equal(persistableLocator(college), true);
  for (const changed of [
    { eventUrl: original.eventUrl.replace('/nfl/', '/cfb/') },
    { eventUrl: original.eventUrl.replace('v2.streameast.ga', 'example.com') },
    { eventUrl: `${original.eventUrl}?token=secret` },
    { eventUrl: original.eventUrl.replace('https:', 'http:') },
    { eventUrl: original.eventUrl.replace('v2.streameast.ga', 'user:password@v2.streameast.ga') },
    { eventUrl: `${original.eventUrl}2` },
    { sourceEventId: 'ncaaf:46236' },
    { gameId: 'ncaaf-401872979' },
    { serverId: '2?token=secret' },
    { serverId: '0' },
    { serverId: '20000' },
  ]) assert.equal(persistableLocator({ ...original, ...changed }), false, JSON.stringify(changed));
});

test('only the originally selected root frame owns StreamEast media and navigation', () => {
  const main: { framesInSubtree: object[] } = { framesInSubtree: [] };
  const selected = { parent: main, url: 'https://dlive.sx/stream/stream-44.php' };
  const nested = { parent: selected, url: 'https://player.example/live' };
  const sibling = { parent: main, url: selected.url };
  main.framesInSubtree = [selected, nested, sibling];
  const current = { window: { webContents: { mainFrame: main } },
    selection: { playerUrl: selected.url, playerFrame: selected } };
  assert.equal(belongsToSelectedStreameastPlayer(selected, current), true);
  assert.equal(belongsToSelectedStreameastPlayer(nested, current), true);
  assert.equal(belongsToSelectedStreameastPlayer(sibling, current), false);
  assert.equal(allowsSelectedStreameastNavigation(selected, selected.url, current), true);
  assert.equal(allowsSelectedStreameastNavigation(selected, 'https://ad.example/redirect', current), false);
  assert.equal(allowsSelectedStreameastNavigation(sibling, selected.url, current), false);
  selected.url = 'https://ad.example/redirect';
  assert.equal(belongsToSelectedStreameastPlayer(selected, current), false);
  selected.url = current.selection.playerUrl;
  main.framesInSubtree = [sibling];
  assert.equal(belongsToSelectedStreameastPlayer(selected, current), false);
  assert.equal(belongsToSelectedStreameastPlayer(sibling, current), false);
});

test('an aborted selected server request never starts a browser observation', async () => {
  const oldOrigin = process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const oldToken = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN = 'http://127.0.0.1:9';
  process.env.SUNDAY_ROOM_CONTROL_TOKEN = 'test-control';
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(observedStreameastServerPage({
      serverUrl: new URL('https://v2.streameast.ga/nfl/atlanta-falcons-vs-new-orleans-saints-1/2'),
      eventUrl: new URL('https://v2.streameast.ga/nfl/atlanta-falcons-vs-new-orleans-saints-1/'),
      sourceEventId: 'nfl:46236', serverId: '2',
    }, controller.signal, 'probe'), { name: 'AbortError' });
  } finally {
    if (oldOrigin === undefined) delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN = oldOrigin;
    if (oldToken === undefined) delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN = oldToken;
  }
});
