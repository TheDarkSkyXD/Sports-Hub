import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const appRoot = path.resolve(process.env.ROOM_APP_ROOT || process.cwd());
const profile = path.join(os.tmpdir(), `sunday-room-slots-${randomUUID()}`);
const games = [0, 1, 2, 3, 4].map(index => ({
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
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(appRoot, 'desktop/main.cjs'), `--user-data-dir=${profile}`],
    cwd: appRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  });
  let page;
  for (let attempt = 0; attempt < 300; attempt++) {
    page = desktop.windows().find(candidate => candidate.url().startsWith('http://127.0.0.1:'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(page, 'Local app window must open');
  await page.setViewportSize({ width: 1440, height: 1400 });
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  await desktop.context().route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, revision: 1, aliases, games, updatedAt: new Date().toISOString(),
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

  async function restore(slots, layout = 'quad', withFeeds = false) {
    await page.evaluate(saved => sessionStorage.setItem('room-slot-test:pending', JSON.stringify({
      slots: saved.slots, selected: saved.slots.filter(Boolean), favorites: [],
      feeds: Object.fromEntries(saved.feedIds.map(id => [id, { url: 'http://localhost:9999/fixture.mp4', label: 'Fixture' }])),
      layout: saved.layout, volume: 70, spoilers: false,
    })), { slots, layout, feedIds: withFeeds ? games.slice(0, 4).map(game => game.id) : [] });
    await page.reload();
    await page.locator('.center-game').first().getByRole('button').last().waitFor();
    await page.getByRole('button', { name: { quad: 'Four games', focus: 'Focus view', duo: 'Two games', single: 'Single game' }[layout] }).waitFor();
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem('sunday-room:v1') || '{}').layout === expected, layout);
  }

  async function expectSlots(slots, layout) {
    try {
      await page.waitForFunction(expected => {
        const saved = JSON.parse(localStorage.getItem('sunday-room:v1') || '{}');
        return JSON.stringify(saved.slots) === JSON.stringify(expected.slots) && saved.layout === expected.layout;
      }, { slots, layout });
    } catch (error) {
      const actual = await page.evaluate(() => ({ saved: JSON.parse(localStorage.getItem('sunday-room:v1') || '{}'), tiles: [...document.querySelectorAll('.game-tile')].map(tile => ({ id: tile.getAttribute('data-game-id'), slot: tile.getAttribute('data-slot-index') })) }));
      throw new Error(`Expected ${JSON.stringify({ slots, layout })}, found ${JSON.stringify(actual)}`, { cause: error });
    }
    assert.equal(await page.locator('.game-grid').getAttribute('class'), `game-grid ${layout}`);
  }

  const center = id => page.locator(`.center-game[data-game-id="${id}"]`);
  const tile = id => page.locator(`.game-tile[data-game-id="${id}"]`);
  const grip = id => tile(id).locator('.tile-drag-grip');
  const dragCenter = (id, target) => center(id).dragTo(target, { sourcePosition: { x: 24, y: 70 } });

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

  aliases = {};
  const [a, b, c, d, e] = games.map(game => game.id);

  await restore([a, null, b, null]);
  await dragCenter(d, page.locator('.quad-empty[data-slot-index="1"]'));
  await expectSlots([a, d, b, null], 'quad');
  await grip(a).dragTo(tile(b));
  await expectSlots([b, d, a, null], 'quad');
  await grip(d).dragTo(page.locator('.game-center'));
  await expectSlots([b, null, a, null], 'quad');

  for (const layout of ['focus', 'duo']) {
    await restore([null, null, null, null], layout);
    await dragCenter(c, page.locator('.room-empty'));
    await expectSlots([c, null, null, null], layout);
    assert.equal(await tile(c).getAttribute('data-slot-index'), '0');
    await grip(c).dragTo(page.locator('.game-center'));
    await expectSlots([null, null, null, null], layout);
  }

  await restore([null, a, null, b], 'focus');
  await dragCenter(c, tile(a));
  await expectSlots([null, c, null, b], 'focus');
  assert.equal(await tile(c).getAttribute('data-slot-index'), '1');
  assert.match(await tile(c).getAttribute('class'), /focused/);
  await dragCenter(d, page.locator('.add-tile'));
  await expectSlots([d, c, null, b], 'focus');
  await grip(c).dragTo(tile(b));
  await expectSlots([d, b, null, c], 'focus');
  assert.match(await tile(b).getAttribute('class'), /focused/);
  assert.equal(await tile(c).getAttribute('data-slot-index'), '3');
  await page.reload();
  await expectSlots([d, b, null, c], 'focus');

  await restore([null, a, null, null], 'duo');
  await dragCenter(e, page.locator('.add-tile'));
  await expectSlots([e, a, null, null], 'duo');
  await restore([a, b, c, d], 'duo');
  await dragCenter(c, tile(b));
  await expectSlots([a, c, b, d], 'duo');
  assert.equal(await tile(c).getAttribute('data-slot-index'), '1');
  assert.equal(await tile(b).count(), 0, 'Swapped selected game stays hidden in duo');
  await dragCenter(e, tile(a));
  await expectSlots([e, c, b, d], 'duo');
  assert.match(await tile(e).getAttribute('class'), /focused/);

  await restore([null, null, null, null], 'single');
  await dragCenter(e, page.locator('.room-empty'));
  await expectSlots([e, null, null, null], 'single');
  await dragCenter(a, tile(e));
  await expectSlots([a, null, null, null], 'single');
  assert.match(await tile(a).getAttribute('class'), /focused/);
  await grip(a).dragTo(page.locator('.game-center'));
  await expectSlots([null, null, null, null], 'single');
  await page.reload();
  await expectSlots([null, null, null, null], 'single');

  await restore([a, b, c, d], 'single');
  await dragCenter(c, tile(a));
  await expectSlots([c, b, a, d], 'single');
  assert.equal(await tile(c).getAttribute('data-slot-index'), '0');
  assert.equal(await tile(a).count(), 0, 'Swapped selected game stays hidden in single view');
  await page.reload();
  await expectSlots([c, b, a, d], 'single');
  assert.equal(await tile(a).count(), 0, 'Hidden selected game remains after reload');

  await restore([a, null, null, null], 'duo');
  await page.evaluate(id => {
    const target = document.querySelector('.game-tile');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-sunday-room-game', id);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, e);
  await expectSlots([a, null, null, null], 'duo');
  assert.equal(await tile(a).evaluate(element => element.classList.contains('drop-hover')), false);
  await page.evaluate(id => {
    const source = document.querySelector(`.center-game[data-game-id="${id}"]`);
    const target = document.querySelector('.game-tile');
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, e);
  await expectSlots([a, null, null, null], 'duo');
  assert.equal(await tile(a).evaluate(element => element.classList.contains('drop-hover')), false);

  const sessions = new Map();
  await desktop.context().route('**/api/playback?*', route => route.fulfill({ status: 204 }));
  await desktop.context().route('**/api/playback', route => {
    const body = route.request().postDataJSON();
    let session = sessions.get(body.sessionId);
    if (route.request().method() === 'POST') {
      session = { id: randomUUID(), gameId: body.gameId, candidateId: 'manual', generation: 0, state: 'active', graceEndsAt: null };
      sessions.set(session.id, session);
    }
    return route.fulfill({ json: { session, candidates: [] } });
  });
  await desktop.context().route('http://localhost:9999/**', route => route.fulfill({ status: 200, body: '', contentType: 'video/mp4' }));
  const audibleVideos = () => page.locator('.game-tile').evaluateAll(tiles => tiles.filter(tile => tile.querySelector('video')?.muted === false).map(tile => tile.getAttribute('data-game-id')));
  for (const layout of ['single', 'duo', 'quad']) {
    await restore([a, b, c, d], layout, true);
    await tile(a).locator('video').waitFor();
    await tile(a).locator('.audio-focus').click();
    await page.waitForFunction(id => document.querySelector(`.game-tile[data-game-id="${id}"] video`)?.muted === false, a);
    assert.deepEqual(await audibleVideos(), [a]);
    await center(c).dragTo(tile(a), { sourcePosition: { x: 24, y: 70 }, targetPosition: { x: 30, y: 15 } });
    await expectSlots([c, b, a, d], layout);
    const expectedAudible = layout === 'quad' ? a : c;
    await tile(c).locator('video').waitFor();
    await page.waitForFunction(id => {
      const audible = [...document.querySelectorAll('.game-tile')].filter(tile => tile.querySelector('video')?.muted === false);
      return audible.length === 1 && audible[0].getAttribute('data-game-id') === id;
    }, expectedAudible);
    assert.deepEqual(await audibleVideos(), [expectedAudible]);
    assert.equal(await tile(a).count(), layout === 'quad' ? 1 : 0);
  }
  console.log('Electron room slots: native drag add, replace, swap, remove, and persistence passed in every layout.');
} finally {
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-slots-[0-9a-f-]{36}$/);
  await rm(profile, { recursive: true, force: true });
}
