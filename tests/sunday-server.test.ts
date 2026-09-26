import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === './sunday' ? './sunday.ts' : specifier, context);
} });

const event = (id: string, away: string, home: string, date: string) => ({
  id, date, status: { type: { state: 'pre', shortDetail: 'Scheduled' } },
  competitions: [{ competitors: [
    { homeAway: 'away', team: { displayName: away } },
    { homeAway: 'home', team: { displayName: home } },
  ] }],
});

test('source dates survive repeated polls and a failed ESPN division feed', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-26T12:00:00Z') });
  const { getFootballBoard, warmSourceDates } = await import('../lib/sunday-server.ts');
  const sourceUrl = 'https://isportsurge.ws/watch/cfb/stevenson-fdu/446558520';
  const liveUrl = 'https://isportsurge.ws/watch/cfb/northwestern-southwestern/446558521';
  const supplementalUrl = 'https://isportsurge.ws/watch/cfb/kean-western/446558522';
  const listing = `<a class="row MaclariListele" href="${sourceUrl}"><span class="time-badge">Coming Up</span><div class="team-name-event-row"><img alt="Stevenson Mustangs" src="https://cdn.example/a.png"></div><div class="team-name-event-row"><img alt="Fdu Florham Devils" src="https://cdn.example/h.png"></div></a><a class="row MaclariListele" href="${liveUrl}"><span class="time-badge">In Progress</span><div class="team-name-event-row"><img alt="Northwestern Tigers" src="https://cdn.example/a.png"></div><div class="team-name-event-row"><img alt="Southwestern Falcons" src="https://cdn.example/h.png"></div></a><a class="row MaclariListele" href="${supplementalUrl}"><div class="team-name-event-row"><img alt="Kean Cougars" src="https://cdn.example/a.png"></div><div class="team-name-event-row"><img alt="Western Connecticut State Wolves" src="https://cdn.example/h.png"></div></a>`;
  let sourceFetches = 0;
  let failDivision = false;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('group=80')) return Response.json({ content: { sbData: { week: { number: 4 }, events: [event('90', 'Texas Longhorns', 'Tennessee Volunteers', '2026-12-26T18:00Z')] } } });
    if (url.includes('group=81')) return Response.json({ content: { sbData: { week: { number: 4 }, events: [event('90', 'Texas Longhorns', 'Tennessee Volunteers', '2026-12-26T18:00Z')] } } });
    if (url.includes('group=35')) return failDivision ? new Response('unavailable', { status: 503 }) : Response.json({ content: { sbData: { week: { number: 4 }, events: [event('35', 'Kean Cougars', 'Western Connecticut State Wolves', '2026-12-26T19:00Z'), event('36', 'Unmatched Eagles', 'Unmatched Bears', '2026-12-26T20:00Z')] } } });
    if (url.endsWith('/cfb/livestreams2')) return new Response(listing);
    if (url.endsWith('/nfl/livestreams3')) return new Response('<div id="Arama"></div>');
    if (url.includes('/nfl/scoreboard')) return Response.json({ events: [] });
    if (url === sourceUrl || url === liveUrl) {
      sourceFetches++;
      return new Response('<aside class="match-info"><dt>Date:</dt><dd>2026-12-26 12:00ET</dd></aside>');
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const first = await getFootballBoard();
    assert.equal(first.games.length, 4);
    assert.equal(first.games.find(game => game.id === 'ncaaf-36'), undefined);
    assert.equal(first.games.find(game => game.id === 'ncaaf-35')?.sourceUrl, supplementalUrl);
    assert.equal(first.games.find(game => game.id === 'ncaaf-source-446558520')?.date, undefined);
    const warmup = warmSourceDates(first);
    assert.strictEqual(warmSourceDates(first), warmup);
    await warmup;
    const second = await getFootballBoard();
    assert.equal(second.games.find(game => game.id === 'ncaaf-source-446558520')?.date, '2026-12-26T17:00:00.000Z');
    assert.equal(second.games.find(game => game.id === 'ncaaf-source-446558520')?.status, 'pre');
    assert.equal(second.games.find(game => game.id === 'ncaaf-source-446558521')?.status, 'unknown');
    assert.equal(second.games.find(game => game.id === 'ncaaf-source-446558521')?.detail, 'Listed live · score unavailable');
    assert.equal(second.games.find(game => game.id === 'ncaaf-90')?.date, '2026-12-26T18:00Z');
    await warmSourceDates(second);
    assert.equal((await getFootballBoard()).games.find(game => game.id === 'ncaaf-source-446558520')?.date, '2026-12-26T17:00:00.000Z');
    assert.equal(sourceFetches, 2);
    failDivision = true;
    mock.timers.tick(26000);
    const partial = await getFootballBoard();
    assert.equal(partial.games.find(game => game.id === 'ncaaf-35')?.date, '2026-12-26T19:00Z');
    assert.equal(partial.leagues.ncaaf.errors.length, 1);
  } finally {
    mock.timers.reset();
    fetchMock.mock.restore();
  }
});
