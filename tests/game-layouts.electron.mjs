import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = process.cwd();
const profile = path.join(os.tmpdir(), `sunday-room-layouts-${randomUUID()}`);
const output = path.join(root, '.scratch', 'game-layouts');
const games = Array.from({ length: 4 }, (_, index) => ({
  id: String(910001 + index), league: 'nfl', name: `Away ${index + 1} at Home ${index + 1}`,
  away: { name: `Away ${index + 1}`, short: `Away ${index + 1}`, abbreviation: `A${index + 1}`, color: 'f97360', score: null },
  home: { name: `Home ${index + 1}`, short: `Home ${index + 1}`, abbreviation: `H${index + 1}`, color: '4f8af7', score: null },
  status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled', redzone: false,
}));
const layouts = { quad: 4, focus: 4, duo: 2, single: 1 };
let desktop;
try {
  await mkdir(output, { recursive: true });
  const mediaPath = path.join(output, 'fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), '--dev', `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  });
  const page = await desktop.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 });
  await desktop.context().route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, scheduleState: 'ready', revision: 1, aliases: {}, games, updatedAt: new Date().toISOString(),
    leagues: { nfl: { week: 3, scoresAt: null, sourceAt: null, errors: [] }, ncaaf: { scoresAt: null, sourceAt: null, errors: [] } },
  } }));
  await desktop.context().route('**/api/sources', route => route.fulfill({ status: 204 }));
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
  await desktop.context().route('http://localhost:9999/**', route => route.fulfill({ body: media, contentType: 'video/mp4' }));
  await page.addInitScript(() => {
    const saved = sessionStorage.getItem('layout-test:pending');
    if (saved) {
      sessionStorage.removeItem('layout-test:pending');
      localStorage.setItem('sunday-room:v1', saved);
    }
  });
  async function restore({ layout, count, withFeed = false, scoreboard = false }) {
    await page.evaluate(saved => sessionStorage.setItem('layout-test:pending', JSON.stringify(saved)), {
      slots: games.map((game, index) => index < count ? game.id : null), layout,
      favorites: [], feeds: withFeed ? { [games[0].id]: { url: 'http://localhost:9999/fixture.mp4', label: 'Layout fixture' } } : {},
      volume: 0, spoilers: false, showGameDayHeader: scoreboard,
    });
    await page.reload();
    await page.waitForFunction(expected => document.querySelector('.app.desktop') &&
      document.querySelector(`.game-grid.${expected}`) && document.querySelectorAll('.center-game').length === 4, layout);
    if (withFeed) await page.waitForFunction(() => document.querySelector('video')?.videoWidth === 640);
  }

  async function check(layout, label) {
    const capacity = layouts[layout];
    const updatePopup = page.getByRole('complementary', { name: 'Software update' });
    if (await updatePopup.isVisible()) await updatePopup.getByRole('button', { name: 'Dismiss', exact: true }).click();
    const geometry = await page.locator('.game-grid').evaluate(grid => {
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        cells: [...grid.children].map(cell => ({ ...bounds(cell), slot: cell.getAttribute('data-slot-index'),
          content: [...cell.querySelectorAll('.tile-top,.tile-score,.tile-bottom,video')].map(bounds),
          screen: cell.querySelector('.tile-screen') ? bounds(cell.querySelector('.tile-screen')) : null,
          slateContent: [...cell.querySelectorAll('.matchup .team-badge,.screen-caption')].map(bounds).filter(rect => rect.width && rect.height),
        })),
      };
    });
    await page.screenshot({ path: path.join(output, `${label.replaceAll(/[^a-zA-Z0-9]+/g, '-')}.png`) });
    assert.equal(geometry.cells.length, capacity, `${label}: each layout must render all ${capacity} squares`);
    assert.equal(new Set(geometry.cells.map(cell => cell.slot)).size, capacity, `${label}: each square needs its own room slot`);
    for (const cell of geometry.cells) {
      assert.ok(cell.width > 120 && cell.height > 100, `${label}: square is too small`);
      assert.ok(cell.right <= geometry.viewport.width + 1, `${label}: square must fit the window width`);
      for (const content of cell.content) {
        assert.ok(content.right <= cell.right + 1 && content.bottom <= cell.bottom + 1, `${label}: tile content must fit its square`);
      }
      if (cell.screen) {
        assert.ok(cell.screen.height >= 40, `${label}: square must leave room for the matchup`);
        assert.ok(Math.abs(cell.screen.width - cell.screen.height * 16 / 9) <= 1, `${label}: player must use a 16:9 frame`);
        for (const content of cell.slateContent) {
          assert.ok(content.y >= cell.screen.y - 1 && content.bottom <= cell.screen.bottom + 1,
            `${label}: matchup and status must fit the screen`);
        }
      }
      if (layout !== 'focus' || cell !== geometry.cells[0]) {
        const peers = layout === 'focus' ? geometry.cells.slice(1) : geometry.cells;
        const row = peers.filter(other => Math.abs(other.y - cell.y) < 1);
        assert.ok(row.every(other => Math.abs(other.height - cell.height) < 2), `${label}: occupied and empty squares must align`);
      }
    }
    if (layout === 'focus') {
      const [lead, ...secondary] = geometry.cells;
      assert.ok(secondary.every(cell => lead.width * lead.height > cell.width * cell.height), `${label}: focused square must be larger`);
    }
    for (let index = 0; index < capacity; index++) {
      const cell = page.locator('.game-grid').locator(':scope > *').nth(index);
      await cell.scrollIntoViewIfNeeded();
      const reachable = await cell.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.top < innerHeight && rect.bottom > 0;
      });
      assert.ok(reachable, `${label}: every square must be reachable by scrolling`);
    }
    await page.locator('.room-toolbar').scrollIntoViewIfNeeded();
    console.log(`PASS ${label}: ${capacity} squares align and remain reachable`);
  }

  const sizes = process.argv.includes('--modes-only') ? [] : [{ width: 1500, height: 1000 }, { width: 1000, height: 700 }, { width: 900, height: 650 }];
  for (const size of sizes) {
    await desktop.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows().find(window => window.getTitle().startsWith('Sunday Room'))?.setContentSize(bounds.width, bounds.height);
    }, size);
    for (const [layout, capacity] of Object.entries(layouts)) {
      for (const count of new Set([0, 1, capacity])) {
        await restore({ layout, count });
        await check(layout, `${layout}, ${count} games, ${size.width}x${size.height}`);
      }
      await restore({ layout, count: 1, withFeed: true });
      await check(layout, `${layout}, native feed, ${size.width}x${size.height}`);
    }
  }
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.getTitle().startsWith('Sunday Room'))?.setContentSize(900, 650);
  });
  for (const [layout, capacity] of Object.entries(layouts)) {
    for (const count of [0, capacity]) {
      await restore({ layout, count, scoreboard: true });
      await check(layout, `${layout}, ${count} games, scoreboard, 900x650`);
      await page.getByRole('button', { name: 'Theater mode', exact: true }).click();
      await check(layout, `${layout}, ${count} games, theater, 900x650`);
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.waitForFunction(() => document.fullscreenElement !== null);
      await check(layout, `${layout}, ${count} games, fullscreen, 900x650`);
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await page.waitForFunction(() => document.fullscreenElement === null);
    }
  }
} finally {
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-layouts-[0-9a-f-]{36}$/);
  await rm(profile, { recursive: true, force: true });
}
