import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const now = Date.now();
const productBoard = {
  schemaVersion: 2, revision: 1, updatedAt: new Date(now).toISOString(), scheduleState: 'ready',
  aliases: {}, finishedGameRetentionMinutes: 120, feedCheckIntervalMinutes: 5,
  leagues: {}, games: [],
};
const sourcesSnapshot = {
  at: now, revision: 1, windowStartAt: now - 60_000, lastDiscoveryAt: null,
  browserCollectorsAvailable: false,
  scheduleScopes: [{ league: 'nfl', read: { kind: 'complete', checkedAt: now } }],
  sportsurgeV2: { current: null, lastComplete: null, previous: null },
  streameast: { current: null, lastComplete: null, previous: null },
  sources: [],
  games: [{
    gameId: '401', name: 'Fixture game', sourceCount: 0, uniqueFeedCount: 0,
    league: 'nfl', date: new Date(now).toISOString(),
    feeds: { kind: 'feeds', discovered: 0, mediaVerified: 0, decoded: 0, checking: 1 },
    freeChoiceCount: 0, workingChoiceCount: 0, sharedRoutes: [], sourceLinks: [],
    candidates: [{
      id: 'pending', gameId: '401', label: 'Pending check', sourceIds: [], observedAt: now,
      availability: { kind: 'checking', progress: { kind: 'queued', since: now } },
    }],
  }],
};

const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('sunday-room:v1', JSON.stringify({ slots: [null, null, null, null], layout: 'duo' }));
    window.sourceReads = [];
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (new URL(input instanceof Request ? input.url : input.toString(), location.href).pathname === '/api/sources' &&
          (!init?.method || init.method === 'GET')) window.sourceReads.push(init?.cache ?? 'default');
      return original(input, init);
    };
  });
  await page.route('**/api/games', route => route.fulfill({ json: productBoard }));
  await page.route('**/api/sources', route => route.fulfill({ json: sourcesSnapshot }));
  await page.goto(process.env.PLAYER_BASE_URL || 'http://127.0.0.1:3000');
  await page.locator('.game-grid.duo').waitFor();
  assert.equal(await page.locator('.source-inventory').count(), 0);
  await page.getByRole('button', { name: 'Room settings' }).click();
  assert.equal(await page.locator('.source-inventory').count(), 0);
  await page.getByRole('tab', { name: 'Sources' }).click();
  await page.locator('.source-inventory').waitFor();
  await page.waitForFunction(() => window.sourceReads.filter(cache => cache === 'no-store').length >= 2,
    null, { timeout: 8000 });
  assert.equal(await page.locator('.source-inventory').count(), 1);
  await page.getByRole('tab', { name: 'General' }).click();
  assert.equal(await page.locator('.source-inventory').count(), 0);
  const hiddenReads = await page.evaluate(() => window.sourceReads.filter(cache => cache === 'no-store').length);
  await page.waitForTimeout(3500);
  assert.equal(await page.evaluate(() => window.sourceReads.filter(cache => cache === 'no-store').length), hiddenReads);
  await page.getByRole('tab', { name: 'Sources' }).click();
  await page.locator('.source-inventory').waitFor();
  await page.getByRole('button', { name: 'Close' }).click();
  assert.equal(await page.locator('.source-inventory').count(), 0);
  const closedReads = await page.evaluate(() => window.sourceReads.filter(cache => cache === 'no-store').length);
  await page.waitForTimeout(3500);
  assert.equal(await page.evaluate(() => window.sourceReads.filter(cache => cache === 'no-store').length), closedReads);
  assert.equal(await page.locator('.game-grid.duo').count(), 1);
  await page.getByRole('button', { name: 'Room settings' }).click();
  await page.locator('.source-inventory').waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Sources' }).getAttribute('data-state'), 'active');
  assert.equal(await page.locator('.source-inventory').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: Sources mounts and polls only while selected in Settings; the room layout and selected Settings tab survive closing.');
} finally {
  await browser.close();
}
