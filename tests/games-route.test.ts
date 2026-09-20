import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import * as sunday from '../lib/sunday.ts';

const source = readFileSync(new URL('../app/api/games/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const scoreboard = {
  week: { number: 3 },
  events: [{
    id: 'official-1', name: 'Away at Home', status: { type: { state: 'in', shortDetail: 'Q2' } },
    competitions: [{ competitors: [
      { homeAway: 'away', score: '7', team: { displayName: 'Away', abbreviation: 'AWY' } },
      { homeAway: 'home', score: '14', team: { displayName: 'Home', abbreviation: 'HME' } },
    ] }],
  }],
};
const directory = `<a class="MaclariListele" href="https://isportsurge.ws/watch/nfl/away-home/123"><span class="time-badge">In Progress</span><div class="team-name-event-row"><img alt="Away" src="https://example.com/away.png"></div><div class="team-name-event-row"><img alt="Home" src="https://example.com/home.png"></div></a>`;
const success = (url: string) => url === sunday.SOURCE ? new Response(directory) : Response.json(scoreboard);

// Execute the actual handler with isolated module cache and controlled upstream I/O.
function routeHarness(fetcher: typeof fetch) {
  const exported: { GET?: () => Promise<Response> } = {};
  let now = Date.parse('2026-09-20T17:00:00Z');
  class FrozenDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const context = createContext({
    exports: exported,
    require: (name: string) => {
      if (name !== '@/lib/sunday') throw new Error(`Unexpected route dependency: ${name}`);
      return sunday;
    },
    fetch: fetcher, Response, AbortSignal, Date: FrozenDate,
  });
  runInContext(compiled, context, { filename: 'app/api/games/route.ts' });
  assert.ok(exported.GET);
  return Object.assign(exported.GET, { advanceTime: (milliseconds: number) => { now += milliseconds; } });
}

test('immediate retry refreshes a failed games response without waiting for cache expiry', async () => {
  const calls: string[] = [];
  const GET = routeHarness(async input => {
    const url = String(input);
    calls.push(url);
    return calls.length <= 2 ? new Response('Unavailable', { status: 503 }) : success(url);
  });
  const failedResponse = await GET();
  const failed = await failedResponse.json();
  assert.equal(calls.length, 2);
  assert.equal(failed.games.length, 0);
  assert.equal(failed.errors.length, 2);
  assert.equal(failedResponse.headers.get('Cache-Control'), 'no-store');

  const recoveredResponse = await GET();
  const recovered = await recoveredResponse.json();
  assert.equal(calls.length, 4, 'Retry must perform both upstream requests at the same clock time');
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.games[0].id, 'official-1');
  assert.equal(recovered.games[0].sourceUrl, 'https://isportsurge.ws/watch/nfl/away-home/123');
  assert.equal(recovered.games[0].home.score, '14');
  assert.ok(recovered.scoresAt);
  assert.ok(recovered.sourceAt);
  assert.equal(recovered.updatedAt, failed.updatedAt, 'The clock stayed inside the cache window');
  assert.equal(recoveredResponse.headers.get('Cache-Control'), 'no-store');
});

test('a partially available board can retry its failed source immediately', async () => {
  let calls = 0;
  const GET = routeHarness(async input => {
    calls += 1;
    const url = String(input);
    return calls <= 2 && url === sunday.SOURCE ? new Response('Unavailable', { status: 503 }) : success(url);
  });
  const partial = await (await GET()).json();
  assert.equal(partial.games[0].id, 'official-1');
  assert.equal(partial.games[0].sourceUrl, undefined);
  assert.equal(partial.errors.length, 1);
  const recovered = await (await GET()).json();
  assert.equal(calls, 4);
  assert.deepEqual(recovered.errors, []);
  assert.ok(recovered.games[0].sourceUrl);
});

test('concurrent refresh requests share upstream work and healthy cached responses avoid refetching', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const GET = routeHarness(async input => {
    const url = String(input);
    calls.push(url);
    await pending;
    return success(url);
  });
  const requests = [GET(), GET(), GET()];
  assert.equal(calls.length, 2, 'Concurrent requests share one scores request and one directory request');
  release();
  const responses = await Promise.all(requests);
  const boards = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(boards[1], boards[0]);
  assert.deepEqual(boards[2], boards[0]);
  assert.deepEqual(boards[0].errors, []);

  const cachedResponses = await Promise.all([GET(), GET()]);
  const cached = await Promise.all(cachedResponses.map(response => response.json()));
  assert.equal(calls.length, 2, 'Healthy cache is reused within its freshness window');
  assert.deepEqual(cached[0], boards[0]);
  assert.deepEqual(cached[1], boards[0]);
  for (const response of [...responses, ...cachedResponses]) assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('an empty fresh scoreboard cannot revive cached official scores through a failed directory', async () => {
  let refresh = 0;
  const GET = routeHarness(async input => {
    const url = String(input);
    if (!refresh) return success(url);
    if (refresh === 1 && url !== sunday.SOURCE) return Response.json({ week: { number: 4 }, events: [] });
    return new Response('Unavailable', { status: 503 });
  });
  const original = await (await GET()).json();
  GET.advanceTime(26000);
  refresh = 1;

  const emptyScores = await (await GET()).json();
  assert.equal(emptyScores.games.length, 1);
  assert.equal(emptyScores.games[0].id, 'source-123');
  assert.equal(emptyScores.games[0].status, 'unknown');
  assert.equal(emptyScores.games[0].home.score, null);
  assert.equal(emptyScores.games[0].away.score, null);
  assert.notEqual(emptyScores.scoresAt, original.scoresAt);
  assert.equal(emptyScores.sourceAt, original.sourceAt);
  assert.equal(emptyScores.week, 4);
  assert.equal(emptyScores.errors.length, 1);

  refresh = 2;
  GET.advanceTime(26000);
  const unavailable = await (await GET()).json();
  assert.deepEqual(unavailable.games, emptyScores.games, 'A later outage preserves the last successful empty scoreboard');
  assert.equal(unavailable.scoresAt, emptyScores.scoresAt);
  assert.equal(unavailable.sourceAt, original.sourceAt);
  assert.equal(unavailable.errors.length, 2);
});

test('directory fallback retains links that were absent from the previous official scoreboard', async () => {
  const upcomingDirectory = directory.replaceAll('Away', 'Visitors').replaceAll('Home', 'Hosts').replace('away-home/123', 'visitors-hosts/456');
  const upcomingScoreboard = structuredClone(scoreboard);
  const event = upcomingScoreboard.events[0];
  event.id = 'official-2';
  event.name = 'Visitors at Hosts';
  event.competitions[0].competitors[0].team.displayName = 'Visitors';
  event.competitions[0].competitors[1].team.displayName = 'Hosts';
  let refresh = false;
  const GET = routeHarness(async input => {
    const url = String(input);
    if (url === sunday.SOURCE) return refresh ? new Response('Unavailable', { status: 503 }) : new Response(directory + upcomingDirectory);
    return Response.json(refresh ? upcomingScoreboard : scoreboard);
  });
  const original = await (await GET()).json();
  assert.equal(original.games.length, 1, 'Only the official matchup is shown while scores are available');
  GET.advanceTime(26000);
  refresh = true;

  const updated = await (await GET()).json();
  assert.equal(updated.games[0].id, 'official-2');
  assert.equal(updated.games[0].sourceUrl, 'https://isportsurge.ws/watch/nfl/visitors-hosts/456');
  assert.notEqual(updated.scoresAt, original.scoresAt);
  assert.equal(updated.sourceAt, original.sourceAt);
  assert.equal(updated.errors.length, 1);
});
