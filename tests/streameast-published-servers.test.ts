import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { streameastCandidates } from '../lib/football/domain/streameast-catalog.ts';
import { StreameastCatalogSchema } from '../lib/football/shared.ts';

const require = createRequire(import.meta.url);
const { runStreameastSweep } = require('../desktop/streameast-sweep.cjs');
const { publishedFreePlayer } = require('../desktop/streameast-catalog.cjs');
const eventUrl = 'https://v2.streameast.ga/nfl/atlanta-falcons-vs-new-orleans-saints-1/';
const at = Date.parse('2026-10-06T01:10:00Z');
const kickoff = Math.floor(at / 1000);
const players = [
  'https://streame.center/stream-east/ch30.php',
  'https://dlive.sx/stream/stream-44.php',
  'https://flyembed.click/embed/17.php',
  'https://fsportshdz.xyz/embed/new-orleans-saints-live-streams.php',
  'https://dlive.sx/stream/stream-111.php',
];
const freeRows = (active?:number) => players.map((_,index) => {
  const id = index + 1;
  return `<a class="stream-alt-item${active === id ? ' active' : ''}" href="${eventUrl}${id}">
    <span class="stream-alt-name">Server ${id}</span><span class="stream-alt-free-badge">Free</span></a>`;
}).join('');
const serverPage = (id:number) => `<main class="streameast-video-page"><div class="se-board" data-match-id="46236"></div>
  <div class="stream-alt-list">${freeRows(id)}</div>
  <div id="se-player-root" class="se-player"><iframe src="${players[id - 1]}"></iframe></div></main>`;

test('the live StreamEast game retains each published free server as a game-bound choice', async () => {
  const category = `<article class="m-card" data-match-id="46236"
    data-team-names="Atlanta Falcons|New Orleans Saints" data-time="${kickoff}"
    data-espn-path="football/nfl" data-espn-event-id="401872979">
    <a class="m-card__link" aria-label="Atlanta Falcons vs New Orleans Saints" href="${eventUrl}"></a></article>`;
  const empty = '<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">No CFB games available</h2></div>';
  const detail = `<main class="streameast-video-page"><div class="se-board" data-match-id="46236"></div>
    <div class="stream-alt-list">${freeRows()}</div></main>`;
  const visited: string[] = [];
  const raw:unknown = await runStreameastSweep({
    now: () => at, signal: new AbortController().signal,
    runId: '11111111-1111-4111-8111-111111111111', send: async () => {},
    read: async (url:string,page:string) => {
      visited.push(`${page}:${url}`);
      if (page === 'category') return url.endsWith('/nfl-streams/') ? category : empty;
      if (page === 'detail') return detail;
      const id = Number(url.slice(eventUrl.length));
      if (page !== 'server' || !Number.isInteger(id) || id < 1 || id > players.length) throw new Error('Unexpected server read');
      return serverPage(id);
    },
  });
  const catalog = StreameastCatalogSchema.parse(raw);
  const event = catalog.events.find(row => row.url === eventUrl);
  assert.ok(event);
  assert.equal(catalog.state.kind, 'complete');
  assert.deepEqual(visited.filter(row => row.startsWith('server:')).map(row => row.slice(-1)), ['1','2','3','4','5']);
  assert.deepEqual(streameastCandidates(event, '401872979').map(candidate => candidate.label), [
    'StreamEast · Server 1', 'StreamEast · Server 2', 'StreamEast · Server 3',
    'StreamEast · Server 4', 'StreamEast · Server 5',
  ]);
});

test('a selected StreamEast page requires one exact same-game free player root', () => {
  const event = { id: 'nfl:46236', url: eventUrl };
  const selected = `${eventUrl}2`;
  const original = serverPage(2);
  assert.equal(publishedFreePlayer(original,event,selected).kind,'page');
  const invalid = [
    original.replace('data-match-id="46236"','data-match-id="99999"'),
    original.replace('<div class="se-board" data-match-id="46236"></div>',
      '<div class="se-board" data-match-id="46236"></div><div class="se-board" data-match-id="46236"></div>'),
    original.replace('stream-alt-item active','stream-alt-item active stream-alt-item-pro'),
    original.replace('Server 2</span><span class="stream-alt-free-badge">Free</span>',
      'Server 2</span><span class="stream-alt-pro-icon">Pro</span>'),
    original.replace(`class="stream-alt-item" href="${eventUrl}3"`,
      `class="stream-alt-item active" href="${eventUrl}3"`),
    original.replace('</main>','<div id="se-player-root" class="se-player"></div></main>'),
    original.replace(`href="${selected}"`,`href="${eventUrl}3"`),
    original.replace(players[1],'https://unrelated.example/embed/44.php'),
  ];
  for(const [index,page] of invalid.entries())assert.equal(publishedFreePlayer(page,event,selected).kind,'unsupported',String(index));
});
