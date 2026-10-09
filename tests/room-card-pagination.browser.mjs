import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const now = Date.now();
const game = index => ({
  id: String(index), league: 'nfl', lifecycle: 'scheduled', status: 'pre',
  name: `Fixture ${String(index).padStart(3, '0')}`,
  date: new Date(now + index * 60_000).toISOString(), detail: 'Scheduled', redzone: false,
  away: { id: `away-${index}`, name: `Away ${index}`, short: `Away ${index}`, abbreviation: `A${index}`, color: '203731', score: null, record: '0-0' },
  home: { id: `home-${index}`, name: `Home ${index}`, short: `Home ${index}`, abbreviation: `H${index}`, color: '0b162a', score: null, record: '0-0' },
});
const board = {
  schemaVersion: 2, revision: 1, updatedAt: new Date(now).toISOString(), scheduleState: 'ready',
  aliases: {}, finishedGameRetentionMinutes: 120, feedCheckIntervalMinutes: 5,
  leagues: { nfl: { week: 4, scoresAt: new Date(now).toISOString(), sourceAt: null, errors: [] } },
  games: Array.from({ length: 407 }, (_, index) => game(index + 1)),
};
const sources = {
  at: now, revision: 1, windowStartAt: now - 60_000, lastDiscoveryAt: null,
  browserCollectorsAvailable: false, scheduleScopes: [{ league: 'nfl', read: { kind: 'complete', checkedAt: now } }],
  sportsurgeV2: { current: null, lastComplete: null, previous: null },
  streameast: { current: null, lastComplete: null, previous: null }, sources: [], games: [],
};

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sunday-room:v1', JSON.stringify({ slots: [null, null, null, null], layout: 'duo' })));
  await page.route('**/api/games', route => route.fulfill({ json: board }));
  await page.route('**/api/sources', route => route.fulfill({ json: sources }));
  await page.goto(process.env.PLAYER_BASE_URL || 'http://127.0.0.1:3000');
  await page.locator('.center-game').first().waitFor();
  assert.equal(await page.locator('.center-game').count(), 40);
  assert.match(await page.locator('.center-heading').innerText(), /407 matchups/);
  const initialNodes = await page.locator('*').count();
  await page.getByRole('button', { name: /Show more games \(40 of 407\)/ }).click();
  assert.equal(await page.locator('.center-game').count(), 80);
  for (let count = 120; count <= 440; count += 40) {
    await page.getByRole('button', { name: /Show more games/ }).click();
    await page.waitForFunction(expected => document.querySelectorAll('.center-game').length === expected, Math.min(count, 407));
  }
  const expandedNodes = await page.locator('*').count();
  assert.equal(await page.locator('.center-game').count(), 407);
  await page.locator('#game-search').fill('Fixture 407');
  assert.equal(await page.locator('.center-game').count(), 1);
  assert.equal(await page.locator('.center-game').getAttribute('data-game-id'), '407');
  await page.locator('.center-game').getByRole('button', { name: 'Add game' }).click();
  assert.equal(await page.locator('.game-tile[data-game-id="407"]').count(), 1);
  await page.getByRole('button', { name: 'Clear search' }).click();
  assert.equal(await page.locator('.center-game').count(), 40);
  await page.locator('.center-game[data-game-id="1"]').dragTo(page.locator('.add-tile').first());
  assert.equal(await page.locator('.game-tile[data-game-id="1"]').count(), 1);
  await page.getByRole('tab', { name: 'Live' }).click();
  assert.equal(await page.locator('.center-game').count(), 0);
  await page.getByRole('tab', { name: 'All games' }).click();
  assert.equal(await page.locator('.center-game').count(), 40);
  await page.getByRole('button', { name: 'Game schedule' }).click();
  await page.locator('.schedule-card').first().waitFor();
  assert.equal(await page.locator('.schedule-card').count(), 40);
  assert.match(await page.locator('.schedule-toolbar').innerText(), /407 matchups/);
  await page.getByRole('button', { name: /Show more games \(40 of 407\)/ }).click();
  assert.equal(await page.locator('.schedule-card').count(), 80);
  await page.getByRole('button', { name: 'NFL', exact: true }).click();
  assert.equal(await page.locator('.schedule-card').count(), 40);
  await page.getByRole('button', { name: 'Watch room' }).click();
  assert.equal(await page.locator('.game-tile[data-game-id="407"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cards: board.games.length, initialCenterCards: 40, initialScheduleCards: 40, initialNodes, expandedNodes }));
} finally {
  await browser.close();
}
