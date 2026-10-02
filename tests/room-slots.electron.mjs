import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(process.env.ROOM_APP_ROOT || process.cwd());
const profile = path.join(os.tmpdir(), `sunday-room-slots-${randomUUID()}`);
const games = [0, 1].map(index => ({
  id: String(910001 + index), league: 'nfl',
  name: `Away ${index + 1} at Home ${index + 1}`,
  away: { name: `Away ${index + 1}`, short: `Away ${index + 1}`, abbreviation: `A${index + 1}`, color: 'f97360', score: null },
  home: { name: `Home ${index + 1}`, short: `Home ${index + 1}`, abbreviation: `H${index + 1}`, color: '4f8af7', score: null },
  status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled', redzone: false,
}));
const stale = ['ncaaf-880001', 'ncaaf-880002', 'ncaaf-880003', 'ncaaf-880004'];
let aliases = {};
let desktop;

try {
  desktop = await electron.launch({
    args: [path.join(appRoot, 'desktop/main.cjs'), `--user-data-dir=${profile}`],
    cwd: appRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  await desktop.context().route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, scheduleState: 'ready', revision: 1, aliases, games, updatedAt: new Date().toISOString(),
    leagues: {
      nfl: { week: 3, scoresAt: new Date().toISOString(), sourceAt: null, errors: [] },
      ncaaf: { scoresAt: null, sourceAt: null, errors: [] },
    },
  } }));
  await page.addInitScript(() => {
    const pending = sessionStorage.getItem('room-slot-test:pending');
    if (pending === null) return;
    sessionStorage.removeItem('room-slot-test:pending');
    localStorage.setItem('sunday-room:v1', pending);
  });

  async function restore(slots) {
    await page.evaluate(saved => sessionStorage.setItem('room-slot-test:pending', JSON.stringify({
      slots: saved, selected: saved.filter(Boolean), favorites: [], feeds: {}, layout: 'quad', volume: 70, spoilers: false,
    })), slots);
    await page.reload();
    await page.locator('.center-game').first().getByRole('button').last().waitFor();
  }

  await restore(stale);
  await page.waitForFunction(() => document.querySelector('.count-badge')?.textContent?.trim() === '0 / 4');
  assert.equal(await page.locator('.game-tile').count(), 0, 'Stale saved IDs should have no visible tiles');
  assert.equal(await page.locator('.count-badge').innerText(), '0 / 4');
  await page.locator('.center-game').first().getByRole('button', { name: 'Add game' }).click();
  try {
    await page.locator('.game-tile').first().waitFor({ timeout: 2500 });
  } catch {
    const toast = await page.locator('.toast').allInnerTexts();
    throw new Error(`Add game left zero visible tiles; toast: ${toast.join(' | ') || '(none)'}`);
  }
  assert.equal(await page.locator('.game-tile').count(), 1);
  assert.equal(await page.locator('.count-badge').innerText(), '1 / 4');
  await page.waitForFunction(id => {
    const saved = JSON.parse(localStorage.getItem('sunday-room:v1') || '{}');
    return JSON.stringify(saved.slots) === JSON.stringify([id, null, null, null]);
  }, games[0].id);
  await page.reload();
  await page.locator(`.game-tile[data-game-id="${games[0].id}"][data-slot-index="0"]`).waitFor();
  assert.equal(await page.locator('.count-badge').innerText(), '1 / 4');

  aliases = { 'source-910002': games[1].id };
  await restore([stale[0], 'source-910002', stale[1], games[0].id]);
  await page.waitForFunction(() => document.querySelector('.count-badge')?.textContent?.trim() === '2 / 4');
  await page.locator(`.game-tile[data-game-id="${games[1].id}"][data-slot-index="1"]`).waitFor();
  assert.equal(await page.locator(`.game-tile[data-game-id="${games[0].id}"][data-slot-index="3"]`).count(), 1);
  assert.equal(await page.locator('.count-badge').innerText(), '2 / 4');
  await page.waitForFunction(ids => {
    const saved = JSON.parse(localStorage.getItem('sunday-room:v1') || '{}');
    return JSON.stringify(saved.slots) === JSON.stringify([null, ids[1], null, ids[0]]) &&
      JSON.stringify(saved.selected) === JSON.stringify([ids[1], ids[0]]);
  }, games.map(game => game.id));
  await page.reload();
  await page.locator(`.game-tile[data-game-id="${games[1].id}"][data-slot-index="1"]`).waitFor();
  assert.equal(await page.locator(`.game-tile[data-game-id="${games[0].id}"][data-slot-index="3"]`).count(), 1);
  console.log('Electron room slots: stale IDs cleared, add persisted, aliases and surviving positions preserved.');
} finally {
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-slots-[0-9a-f-]{36}$/);
  await rm(profile, { recursive: true, force: true });
}
