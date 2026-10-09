import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const now = Date.now();
const game = index => ({
  id: String(index), league: 'nfl', lifecycle: 'scheduled', status: 'pre',
  name: `Fixture ${index}`, date: new Date(now + 60_000).toISOString(), detail: 'Scheduled', redzone: false,
  away: { id: `away-${index}`, name: `Away ${index}`, short: `Away ${index}`, abbreviation: `A${index}`, color: '203731', score: null, record: '0-0' },
  home: { id: `home-${index}`, name: `Home ${index}`, short: `Home ${index}`, abbreviation: `H${index}`, color: '0b162a', score: null, record: '0-0' },
});
const board = {
  schemaVersion: 2, revision: 1, updatedAt: new Date(now).toISOString(), scheduleState: 'ready',
  aliases: {}, finishedGameRetentionMinutes: 120, feedCheckIntervalMinutes: 5,
  leagues: { nfl: { week: 4, scoresAt: new Date(now).toISOString(), sourceAt: null, errors: [] } },
  games: [game(1), game(2), game(3)],
};
const playable = {
  id: 'working', gameId: '1', label: 'Working', sourceIds: [], observedAt: now,
  availability: { kind: 'playable', checkedAt: now, proof: 'media' },
};
const pending = gameId => ({
  id: `pending-${gameId}`, gameId, label: 'Pending', sourceIds: [], observedAt: now,
  availability: { kind: 'checking', progress: { kind: 'queued', since: now } },
});
const sources = {
  at: now, revision: 1, windowStartAt: now - 60_000, lastDiscoveryAt: null,
  browserCollectorsAvailable: false, scheduleScopes: [{ league: 'nfl', read: { kind: 'complete', checkedAt: now } }],
  sportsurgeV2: { current: null, lastComplete: null, previous: null },
  streameast: { current: null, lastComplete: null, previous: null }, sources: [],
  games: [
    { gameId: '1', name: 'Fixture 1', sourceCount: 0, uniqueFeedCount: 0, league: 'nfl', date: new Date(now).toISOString(),
      feeds: { kind: 'feeds', discovered: 1, mediaVerified: 1, decoded: 0, checking: 1 }, freeChoiceCount: 1, workingChoiceCount: 1,
      sharedRoutes: [], candidates: [playable, pending('1')], sourceLinks: [] },
    { gameId: '2', name: 'Fixture 2', sourceCount: 0, uniqueFeedCount: 0, league: 'nfl', date: new Date(now).toISOString(),
      feeds: { kind: 'feeds', discovered: 0, mediaVerified: 0, decoded: 0, checking: 1 }, freeChoiceCount: 0, workingChoiceCount: 0,
      sharedRoutes: [], candidates: [pending('2')], sourceLinks: [] },
    { gameId: '3', name: 'Fixture 3', sourceCount: 0, uniqueFeedCount: 0, league: 'nfl', date: new Date(now).toISOString(),
      feeds: { kind: 'feeds', discovered: 0, mediaVerified: 0, decoded: 0, checking: 1 }, freeChoiceCount: 0, workingChoiceCount: 0,
      sharedRoutes: [], candidates: [pending('3')], sourceLinks: [] },
  ],
};

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
try {
  const page = await browser.newPage();
  const advance = async milliseconds => {
    await page.clock.runFor(milliseconds);
    await new Promise(resolve => setTimeout(resolve, 200));
  };
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    localStorage.setItem('sunday-room:v1', JSON.stringify({ slots: ['1', null, null, null], layout: 'duo' }));
    window.sourceReads = [];
    window.priorityPosts = 0;
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (new URL(input instanceof Request ? input.url : input.toString(), location.href).pathname === '/api/sources') {
        if (init?.method === 'POST') window.priorityPosts++;
        else window.sourceReads.push(Date.now());
      }
      return original(input, init);
    };
  });
  await page.route('**/api/games', route => route.fulfill({ json: board }));
  await page.route('**/api/sources', route => route.fulfill({ json: sources }));
  await page.goto(process.env.PLAYER_BASE_URL || 'http://127.0.0.1:3000');
  await advance(1000);
  await page.waitForFunction(() => window.sourceReads.length >= 1 && window.priorityPosts >= 1);
  await page.clock.fastForward(91_000);
  await advance(1000);
  const countAfterStartup = await page.evaluate(() => window.sourceReads.length);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterStartup);
  await advance(27_000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterStartup + 1);
  const postsBeforeSelection = await page.evaluate(() => window.priorityPosts);
  await page.locator('.center-game[data-game-id="3"]').getByRole('button', { name: 'Add game' }).click();
  await page.waitForFunction(before => window.priorityPosts > before, postsBeforeSelection);
  const countBeforeSelection = await page.evaluate(() => window.sourceReads.length);
  await advance(30_000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countBeforeSelection + 1);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countBeforeSelection + 2);
  sources.games[2].candidates[0].availability = { kind: 'unknown' };
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countBeforeSelection + 3);
  sources.games[2].candidates[0].availability = { kind: 'checking', progress: { kind: 'active', since: now } };
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countBeforeSelection + 4);
  sources.games[2].candidates[0].availability = { kind: 'unavailable', checkedAt: now, retryAt: now + 300_000, reason: 'no-feed' };
  await advance(3000);
  const countAfterFailure = await page.evaluate(() => window.sourceReads.length);
  assert.equal(countAfterFailure, countBeforeSelection + 5);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterFailure);
  await advance(27_000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterFailure + 1);
  sources.games[2].candidates[0].availability = { kind: 'checking', progress: { kind: 'deferred', since: now, retryAt: now + 300_000 } };
  await advance(30_000);
  const countAfterDeferred = await page.evaluate(() => window.sourceReads.length);
  assert.equal(countAfterDeferred, countAfterFailure + 2);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterDeferred);
  const selectedRow = sources.games.pop();
  await advance(27_000);
  const countAfterMissingRow = await page.evaluate(() => window.sourceReads.length);
  assert.equal(countAfterMissingRow, countAfterDeferred + 1);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterMissingRow);
  selectedRow.candidates = [];
  selectedRow.feeds = { kind: 'incomplete', reason: 'schedule' };
  selectedRow.sourceLinks = [{ sourceId: 'sportsurge', title: 'Fixture 3 listing', url: 'https://example.invalid/game/3',
    observedAt: now, freshness: 'fresh', evidence: { kind: 'pending' } }];
  sources.scheduleScopes = [{ league: 'nfl', read: { kind: 'incomplete', reason: 'stale', checkedAt: now } }];
  sources.games.push(selectedRow);
  await advance(27_000);
  const countAfterStaleSchedule = await page.evaluate(() => window.sourceReads.length);
  assert.equal(countAfterStaleSchedule, countAfterMissingRow + 1);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterStaleSchedule);
  selectedRow.feeds = { kind: 'incomplete', reason: 'details' };
  sources.scheduleScopes = [{ league: 'nfl', read: { kind: 'complete', checkedAt: now } }];
  await advance(27_000);
  const countAfterFreshSchedule = await page.evaluate(() => window.sourceReads.length);
  assert.equal(countAfterFreshSchedule, countAfterStaleSchedule + 1);
  await advance(3000);
  assert.equal(await page.evaluate(() => window.sourceReads.length), countAfterFreshSchedule + 1);
  await page.close();

  const finalBoard = structuredClone(board);
  Object.assign(finalBoard.games[2], { lifecycle: 'final', status: 'post', detail: 'Final', graceEndsAt: now + 600_000 });
  const finalSources = structuredClone(sources);
  finalSources.games[2].candidates = [{ ...pending('3'), availability: { kind: 'unknown' } }];
  finalSources.games[2].feeds = { kind: 'feeds', discovered: 0, mediaVerified: 0, decoded: 0, checking: 1 };
  finalSources.games[2].sourceLinks = [];
  const finalPage = await browser.newPage();
  const advanceFinal = async milliseconds => {
    await finalPage.clock.runFor(milliseconds);
    await new Promise(resolve => setTimeout(resolve, 200));
  };
  await finalPage.clock.install({ time: now });
  await finalPage.addInitScript(() => {
    localStorage.setItem('sunday-room:v1', JSON.stringify({ slots: ['3', null, null, null], layout: 'duo' }));
    window.sourceReads = [];
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (new URL(input instanceof Request ? input.url : input.toString(), location.href).pathname === '/api/sources' &&
          (!init?.method || init.method === 'GET')) window.sourceReads.push(Date.now());
      return original(input, init);
    };
  });
  await finalPage.route('**/api/games', route => route.fulfill({ json: finalBoard }));
  await finalPage.route('**/api/sources', route => route.fulfill({ json: finalSources }));
  await finalPage.goto(process.env.PLAYER_BASE_URL || 'http://127.0.0.1:3000');
  await advanceFinal(1000);
  await finalPage.waitForFunction(() => window.sourceReads.length >= 1);
  await finalPage.locator('.game-tile[data-game-id="3"]').waitFor();
  await finalPage.clock.fastForward(91_000);
  await advanceFinal(1000);
  const countWhileFinal = await finalPage.evaluate(() => window.sourceReads.length);
  await advanceFinal(3000);
  assert.equal(await finalPage.evaluate(() => window.sourceReads.length), countWhileFinal);
  await advanceFinal(27_000);
  assert.equal(await finalPage.evaluate(() => window.sourceReads.length), countWhileFinal + 1);
  Object.assign(finalBoard.games[2], { lifecycle: 'live', status: 'in', detail: 'Q1 10:00' });
  await finalPage.getByRole('button', { name: 'Game schedule' }).click();
  await finalPage.locator('.schedule-toolbar').getByRole('button', { name: 'Refresh' }).click();
  await finalPage.getByText('Q1 10:00', { exact: true }).first().waitFor();
  await finalPage.getByRole('button', { name: 'Watch room' }).click();
  const countBeforeLive = await finalPage.evaluate(() => window.sourceReads.length);
  await advanceFinal(30_000);
  assert.equal(await finalPage.evaluate(() => window.sourceReads.length), countBeforeLive + 1);
  await advanceFinal(3000);
  assert.equal(await finalPage.evaluate(() => window.sourceReads.length), countBeforeLive + 2);
  console.log(JSON.stringify({ startupReads: countAfterStartup, unrelatedPendingDelayMs: 30_000, selectedPendingDelayMs: 3000, selectedFailedDelayMs: 30_000, selectedDeferredDelayMs: 30_000, missingRowDelayMs: 30_000, staleSchedulePendingLinkDelayMs: 30_000, freshSchedulePendingLinkDelayMs: 3000, retainedFinalUnknownDelayMs: 30_000, returnedLiveUnknownDelayMs: 3000 }));
} finally {
  await browser.close();
}
