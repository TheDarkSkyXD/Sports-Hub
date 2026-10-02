import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(process.env.ROOM_APP_ROOT || process.cwd());
const temporary = path.join(os.tmpdir(), `sunday-room-autoplay-${randomUUID()}`);
const media = path.join(temporary, 'media');
await mkdir(media, { recursive: true });
await promisify(execFile)(ffmpeg, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24',
  '-c:a', 'aac', '-b:a', '32k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(media, 'segment_%03d.ts'), path.join(media, 'index.m3u8'),
], { windowsHide: true });

const games = Array.from({ length: 6 }, (_, index) => ({
  id: String(930001 + index), league: 'nfl', name: `Away ${index + 1} at Home ${index + 1}`,
  away: { name: `Away ${index + 1}`, short: `Away ${index + 1}`, abbreviation: `A${index + 1}`, color: 'f97360', score: null },
  home: { name: `Home ${index + 1}`, short: `Home ${index + 1}`, abbreviation: `H${index + 1}`, color: '4f8af7', score: null },
  status: index >= 4 ? 'post' : 'pre', lifecycle: index === 4 ? 'final' : index === 5 ? 'unknown' : 'scheduled',
  detail: index >= 4 ? 'Final' : 'Scheduled', redzone: false,
  date: new Date(Date.now() + 86400000).toISOString(),
  ...([0, 3, 5].includes(index) ? { sourceUrl: `https://isportsurge.ws/watch/nfl/fixture/${930001 + index}` } : {}),
  ...(index === 4 ? { finalObservedAt: Date.now(), graceEndsAt: Date.now() + 300000 } : {}),
}));
const candidates = gameId => [0, 1].map(index => ({
  id: `fixture-${gameId}-${index}`, gameId, label: index ? 'Backup 1' : 'Primary',
  sourceIds: ['fixture'], observedAt: Date.now(),
  availability: { kind: 'playable', proof: 'media', checkedAt: Date.now(), expiresAt: Date.now() + 600000 },
}));
let revision = 1;
let delayedPlayable = false;
let desktop;
const sessions = new Map();
const opens = [];
const selections = [];
const errors = [];

try {
  desktop = await electron.launch({
    args: [path.join(appRoot, 'desktop/main.cjs'), `--user-data-dir=${path.join(temporary, 'profile')}`],
    cwd: appRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  const hiddenWindow = await desktop.evaluateHandle(({ BrowserWindow }) => new BrowserWindow({ show: false }));
  const window = await desktop.browserWindow(page);
  await window.evaluate(window => {
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  assert.equal(await window.evaluate(window => window.isVisible()), true);
  await window.dispose();
  assert.equal(await hiddenWindow.evaluate(window => window.isVisible()), false,
    'Preparing the game window must keep background collector windows hidden.');
  page.on('pageerror', error => errors.push(error.message));
  const context = desktop.context();
  await context.route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, scheduleState: 'ready', revision, aliases: {}, games, updatedAt: new Date().toISOString(),
    leagues: {
      nfl: { week: 3, scoresAt: new Date().toISOString(), sourceAt: null, errors: [] },
      ncaaf: { scoresAt: null, sourceAt: null, errors: [] },
    },
  } }));
  await context.route('**/api/sources', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 204 });
    return route.fulfill({ json: {
      at: Date.now(), revision, windowStartAt: Date.now(), lastDiscoveryAt: null, browserCollectorsAvailable: true,
      sportsurgeV2: { current: null, lastComplete: null, previous: null },
      streameast: { current: null, lastComplete: null, previous: null }, sources: [],
      games: games.map((game, index) => ({
        gameId: game.id, name: game.name, sourceCount: index === 2 ? 0 : 1,
        uniqueFeedCount: index === 2 ? 0 : 2, sourceLinks: [],
        candidates: index === 2 ? [] : index === 1 && !delayedPlayable
          ? [{ ...candidates(game.id)[0], availability: { kind: 'checking' } }]
          : candidates(game.id),
      })),
    } });
  });
  await context.route('**/api/playback?*', route => route.fulfill({ status: 204 }));
  await context.route('**/api/playback', route => {
    const body = route.request().postDataJSON();
    let session;
    if (route.request().method() === 'POST') {
      opens.push(body);
      session = { id: randomUUID(), gameId: body.gameId,
        candidateId: body.initialCandidateId || `fixture-${body.gameId}-0`, generation: 0, state: 'active', graceEndsAt: null };
      sessions.set(session.id, session);
    } else {
      session = sessions.get(body.sessionId);
      if (!session) return route.fulfill({ status: 410, json: { error: 'Playback session ended.' } });
      if (body.candidateId && body.candidateId !== session.candidateId) {
        selections.push(body);
        session.candidateId = body.candidateId;
        session.generation++;
      }
    }
    return route.fulfill({ json: { session, candidates: candidates(session.gameId) } });
  });
  await context.route('**/api/stream/**', async route => {
    const filename = path.basename(new URL(route.request().url()).pathname);
    const body = await readFile(path.join(media, filename));
    return route.fulfill({ body, contentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
  });
  await page.addInitScript(() => {
    const pending = sessionStorage.getItem('autoplay-test:pending');
    if (pending === null) return;
    sessionStorage.removeItem('autoplay-test:pending');
    localStorage.setItem('sunday-room:v1', pending);
  });

  async function reset() {
    await page.evaluate(() => sessionStorage.setItem('autoplay-test:pending', JSON.stringify({
      slots: [null, null, null, null], selected: [], favorites: [], feeds: {}, layout: 'quad', volume: 70, spoilers: false,
    })));
    await page.reload();
    await page.locator('.center-game').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.quad-empty').length === 4 && JSON.parse(localStorage.getItem('sunday-room:v1')).selected.length === 0);
    opens.length = 0;
    selections.length = 0;
  }
  const tile = index => page.locator(`.game-tile[data-game-id="${games[index].id}"]`);
  async function add(index, center = false) {
    if (center) await page.locator(`.center-game[data-game-id="${games[index].id}"]`).getByRole('button', { name: 'Add game', exact: true }).click();
    else await page.getByTitle(`Add ${games[index].name}`, { exact: true }).click();
    await tile(index).waitFor();
  }
  async function playing(index) {
    try {
      await page.waitForFunction(id => {
        const video = document.querySelector(`.game-tile[data-game-id="${id}"] video`);
        return video && video.readyState >= 2 && !video.paused && video.currentTime > 0;
      }, games[index].id, { timeout: 8000 });
    } catch (error) {
      throw new Error(`Adding ${games[index].name} should automatically play its stream. Actual tile: ${await tile(index).innerText()}`, { cause: error });
    }
    assert.equal(await tile(index).getByRole('button', { name: 'Play game', exact: true }).count(), 0);
    assert.equal(await tile(index).locator('video').evaluate(video => video.videoHeight), 180);
  }
  async function publishSources() {
    revision++;
    const read = page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Remove Away 3 at Home 3', exact: true }).click();
    await add(2);
    assert.equal((await (await read).json()).revision, revision);
  }

  await reset();
  await add(0, true);
  await playing(0);
  assert.equal(await tile(0).locator('video').evaluate(video => video.muted), false);
  assert.deepEqual(opens.map(({ gameId, manual }) => ({ gameId, manual })), [{ gameId: '930001', manual: false }]);
  console.log('Electron automatically plays a scheduled game with an active source when added.');

  await add(1);
  assert.equal(await tile(1).locator('video').count(), 0);
  assert.match(await tile(1).innerText(), /Checking listed servers|No verified stream yet/);
  await add(2);
  assert.equal(await tile(2).locator('video').count(), 0);
  assert.equal(await tile(2).getByRole('button', { name: /No verified stream|Checking listed servers/ }).count(), 0,
    'Games without sources should present a status rather than a disabled play button.');
  await tile(0).locator('.audio-focus').click();
  const muted = await tile(0).locator('video').evaluate(video => video.muted);
  assert.equal(muted, false);
  delayedPlayable = true;
  await publishSources();
  await playing(1);
  assert.equal(await tile(0).locator('video').evaluate(video => video.muted), false);
  assert.equal(await tile(1).locator('video').evaluate(video => video.muted), true);
  console.log('Electron starts a newly verified candidate without changing the selected audio stream.');

  await tile(1).locator('.audio-focus').click();
  await tile(1).hover();
  await tile(1).getByRole('button', { name: 'Pause stream', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`.game-tile[data-game-id="${id}"] video`).paused, games[1].id);
  const opensBefore = opens.length;
  await publishSources();
  const before = await tile(0).locator('video').evaluate(video => video.currentTime);
  await page.waitForFunction(({ id, before }) => document.querySelector(`.game-tile[data-game-id="${id}"] video`).currentTime > before + 0.5,
    { id: games[0].id, before });
  assert.equal(await tile(1).locator('video').evaluate(video => video.paused), true);
  assert.equal(opens.length, opensBefore);
  await tile(1).getByRole('button', { name: 'Play stream', exact: true }).click();
  await playing(1);
  const backupLoaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/stream/930002/index.m3u8' && url.searchParams.get('candidate') === 'fixture-930002-1' && response.ok();
  });
  await tile(1).getByRole('combobox', { name: 'Choose listed server' }).selectOption('fixture-930002-1');
  await backupLoaded;
  await playing(1);
  assert.equal(selections.at(-1).candidateId, 'fixture-930002-1');
  console.log('Electron preserves an explicit pause across source updates and plays a manually selected server.');

  await reset();
  const drag = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(`.center-game[data-game-id="${games[3].id}"]`).dispatchEvent('dragstart', { dataTransfer: drag });
  await page.locator('.quad-empty').nth(2).dispatchEvent('dragover', { dataTransfer: drag });
  await page.locator('.quad-empty').nth(2).dispatchEvent('drop', { dataTransfer: drag });
  await page.locator(`.center-game[data-game-id="${games[3].id}"]`).dispatchEvent('dragend', { dataTransfer: drag });
  await playing(3);
  assert.equal(await tile(3).getAttribute('data-slot-index'), '2');
  assert.equal(await tile(3).locator('video').evaluate(video => video.muted), false);
  console.log('Electron plays an active source after dragging a game into an empty square.');

  await add(4);
  assert.match(await tile(4).innerText(), /Final/);
  assert.equal(await tile(4).locator('video').count(), 0);
  assert.equal(opens.some(open => open.gameId === games[4].id), false);
  await add(5);
  assert.match(await tile(5).innerText(), /Final/);
  assert.equal(await tile(5).locator('video').count(), 0);
  assert.equal(opens.some(open => open.gameId === games[5].id), false);
  assert.deepEqual(errors, []);
  assert.equal(await hiddenWindow.evaluate(window => window.isVisible()), false,
    'Background collector windows must stay hidden throughout the test.');
  await hiddenWindow.dispose();
  console.log('Electron keeps final games informational and reports no runtime errors.');
} finally {
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporary), /^sunday-room-autoplay-[0-9a-f-]{36}$/);
  await rm(temporary, { recursive: true, force: true });
}
