import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = process.cwd();
const profile = path.join(os.tmpdir(), `sunday-room-fullscreen-${randomUUID()}`);
const output = path.join(root, '.scratch', 'fullscreen-layouts');
const games = Array.from({ length: 4 }, (_, index) => ({
  id: String(910001 + index), league: 'nfl', name: `Away ${index + 1} at Home ${index + 1}`,
  away: { name: `Away ${index + 1}`, short: `Away ${index + 1}`, abbreviation: `A${index + 1}`, color: 'f97360', score: null },
  home: { name: `Home ${index + 1}`, short: `Home ${index + 1}`, abbreviation: `H${index + 1}`, color: '4f8af7', score: null },
  status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled', redzone: false,
}));
let desktop;
const results = [];
try {
  await mkdir(output, { recursive: true });
  const mediaPath = path.join(output, 'fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=640x360:rate=24', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-c', 'copy',
    '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(output, 'fixture-%03d.ts'),
    path.join(output, 'fixture.m3u8')], { windowsHide: true });
  desktop = await electron.launch({ executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), `--user-data-dir=${profile}`], cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')) });
  const page = await desktop.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 });
  let provider = false;
  await desktop.context().route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, scheduleState: 'ready', revision: 1, aliases: {},
    games: games.map(game => provider ? { ...game, sourceUrl: 'https://gooz.aapmains.net/new-stream-embed/57000' } : game),
    updatedAt: new Date().toISOString(),
    leagues: { nfl: { week: 3, scoresAt: null, sourceAt: null, errors: [] }, ncaaf: { scoresAt: null, sourceAt: null, errors: [] } },
  } }));
  await desktop.context().route('**/api/sources', route => route.fulfill({ status: 204 }));
  const sessions = new Map();
  await desktop.context().route('**/api/playback?*', route => route.fulfill({ status: 204 }));
  await desktop.context().route('**/api/playback', route => {
    const body = route.request().postDataJSON();
    let session = sessions.get(body.sessionId);
    if (route.request().method() === 'POST') {
      session = { id: randomUUID(), gameId: body.gameId, candidateId: body.manual ? 'manual' : `fixture-${body.gameId}`, generation: 0, state: 'active', graceEndsAt: null };
      sessions.set(session.id, session);
    }
    const candidates = session.candidateId === 'manual' ? [] : [{
      id: `fixture-${session.gameId}`, gameId: session.gameId, playerId: '57000',
      url: 'https://gooz.aapmains.net/new-stream-embed/57000', label: 'Primary', sourceIds: ['fixture'], observedAt: Date.now(),
      availability: { kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}, checkedAt: Date.now() },
    }];
    return route.fulfill({ json: { session, candidates } });
  });
  await desktop.context().route('http://localhost:9999/**', route => route.fulfill({ body: media, contentType: 'video/mp4' }));
  await desktop.context().route('**/api/stream/**', async route => {
    const filename = path.basename(new URL(route.request().url()).pathname);
    const body = await readFile(path.join(output, filename === 'index.m3u8' ? 'fixture.m3u8' : filename));
    return route.fulfill({ body, contentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
  });
  await page.addInitScript(() => {
    const saved = sessionStorage.getItem('fullscreen-test:pending');
    if (saved) { sessionStorage.removeItem('fullscreen-test:pending'); localStorage.setItem('sunday-room:v1', saved); }
  });
  const windowHandle = await desktop.browserWindow(page);
  async function observe(layout, mode) {
    const popup = page.getByRole('complementary', { name: 'Software update' });
    if (await popup.isVisible()) await popup.getByRole('button', { name: 'Dismiss', exact: true }).click();
    const result = await page.locator('.game-tile').evaluateAll(tiles => ({ viewport: [innerWidth, innerHeight], tiles: tiles.map(tile => {
      const video = tile.querySelector('video');
      const screen = tile.querySelector('.tile-screen');
      const bounds = element => { const r = element.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      const [width, height] = bounds(video);
      const ratio = video.videoWidth / video.videoHeight;
      const renderedWidth = Math.min(width, height * ratio);
      const renderedHeight = Math.min(height, width / ratio);
      return { card: bounds(tile), screen: bounds(screen), video: [width, height], rendered: [Math.round(renderedWidth), Math.round(renderedHeight)],
        unusedFooterSpace: Math.round(tile.getBoundingClientRect().bottom - tile.querySelector('.tile-bottom').getBoundingClientRect().bottom),
        serverBar: !!tile.querySelector('.provider-controls'), playing: !video.paused && video.readyState >= 2,
        occupancy: Math.round(renderedWidth * renderedHeight / (width * height) * 100), fit: getComputedStyle(video).objectFit };
    }) }));
    results.push({ layout, mode, ...result });
    for (const [index, tile] of result.tiles.entries()) {
      if (Math.abs(tile.screen[0] - tile.screen[1] * 16 / 9) > 2) failures.push(`${layout} ${mode} game ${index + 1}: player frame is ${tile.screen.join('x')}, expected 16:9`);
      if (Math.abs(tile.video[0] - tile.video[1] * 16 / 9) > 2) failures.push(`${layout} ${mode} game ${index + 1}: video surface is ${tile.video.join('x')}, expected 16:9`);
      if (tile.fit !== 'contain') failures.push(`${layout} ${mode} square ${index + 1}: video must preserve its original proportions`);
      if (tile.unusedFooterSpace > 2) failures.push(`${layout} ${mode} game ${index + 1}: card has ${tile.unusedFooterSpace}px of unused height below its footer`);
      if (!tile.playing) failures.push(`${layout} ${mode} square ${index + 1}: video must keep playing`);
    }
    await page.screenshot({ path: path.join(output, `${layout}-${mode}.png`) });
    console.log(`${layout} ${mode}: ${result.tiles.map(tile => `${tile.video.join('x')} player`).join(', ')}`);
    return result;
  }
  const failures = [];
  for (const layout of ['quad', 'focus', 'duo', 'single']) {
    provider = false;
    await windowHandle.evaluate(win => { win.setFullScreen(false); win.unmaximize(); win.setContentSize(1500, 1000); });
    await page.evaluate(saved => sessionStorage.setItem('fullscreen-test:pending', JSON.stringify(saved)), {
      slots: [null, null, null, null], layout, favorites: [],
      feeds: Object.fromEntries(games.map(game => [game.id, { url: 'http://localhost:9999/fixture.mp4', label: 'Aspect ratio fixture' }])),
      volume: 0, spoilers: false, showGameDayHeader: false,
    });
    await page.reload();
    for (const game of games.slice(0, { quad: 4, focus: 4, duo: 2, single: 1 }[layout])) {
      await page.locator(`.center-game[data-game-id="${game.id}"]`).getByRole('button', { name: 'Add game', exact: true }).click();
      await page.locator(`.game-tile[data-game-id="${game.id}"]`).waitFor();
    }
    await page.locator('.room-toolbar').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: { quad: 'Four games', focus: 'Focus view', duo: 'Two games', single: 'Single game' }[layout], exact: true }).click();
    try {
      await page.waitForFunction(expected => document.querySelector('.app.desktop') && document.querySelector(`.game-grid.${expected}`) &&
        [...document.querySelectorAll('video')].length > 0 && [...document.querySelectorAll('video')].every(video => video.videoWidth === 640), layout);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `${layout}-manual-failed.png`) });
      console.log(JSON.stringify({ layout, manualError: await page.locator('.tile-screen').allInnerTexts() }));
      throw error;
    }
    const normal = await observe(layout, 'normal');
    await windowHandle.evaluate(win => win.maximize());
    await page.waitForFunction(() => innerWidth > 1500);
    const maximized = await observe(layout, 'maximized');
    await windowHandle.evaluate(win => win.setFullScreen(true));
    const appFullscreen = await observe(layout, 'app-fullscreen');
    for (const [mode, geometry] of [['maximized', maximized], ['app-fullscreen', appFullscreen]]) {
      if (geometry.viewport[1] >= normal.viewport[1] && geometry.tiles[0].rendered[0] <= normal.tiles[0].rendered[0]) {
        failures.push(`${layout} ${mode}: larger window must increase the picture size`);
      }
    }
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('viewing-room'));
    await observe(layout, 'room-fullscreen');
    await page.locator('.game-tile').last().scrollIntoViewIfNeeded();
    const lastCard = await page.locator('.game-tile').last().boundingBox();
    assert.ok(lastCard.y < (await page.evaluate(() => innerHeight)) && lastCard.y + lastCard.height > 0, `${layout}: last square must be reachable by scrolling`);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    await page.locator('.game-tile').first().locator('.native-player').hover();
    await page.screenshot({ path: path.join(output, `${layout}-stream-controls.png`) });
    await page.getByRole('button', { name: 'Fullscreen stream', exact: true }).first().press('Enter');
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('native-player'));
    const stream = await page.locator('.native-player:fullscreen video').evaluate(video => ({
      width: video.clientWidth, height: video.clientHeight, viewport: [innerWidth, innerHeight], fit: getComputedStyle(video).objectFit,
    }));
    assert.deepEqual([stream.width, stream.height], stream.viewport, `${layout}: stream fullscreen must fill the viewport`);
    assert.equal(stream.fit, 'contain', `${layout}: stream fullscreen must preserve video proportions`);
    await page.getByRole('button', { name: 'Exit fullscreen stream', exact: true }).press('Enter');
    await page.waitForFunction(() => document.fullscreenElement === null);
    provider = true;
    await page.evaluate(saved => sessionStorage.setItem('fullscreen-test:pending', JSON.stringify(saved)), {
      slots: games.map(game => game.id), layout, favorites: [], feeds: {}, volume: 0, spoilers: false, showGameDayHeader: false,
    });
    await page.reload();
    try {
      await page.waitForFunction(expected => document.querySelector(`.game-grid.${expected}`) &&
        [...document.querySelectorAll('video')].length > 0 && [...document.querySelectorAll('video')].every(video => video.videoWidth === 640), layout);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `${layout}-provider-failed.png`) });
      console.log(JSON.stringify({ providerError: await page.locator('.tile-screen').allInnerTexts() }));
      throw error;
    }
    const providerNative = await observe(layout, 'provider-app-fullscreen');
    for (const tile of providerNative.tiles) {
      assert.ok(tile.serverBar, `${layout}: provider fixture must include the server controls`);
    }
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('viewing-room'));
    await observe(layout, 'provider-room-fullscreen');
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement === null);
  }
  console.log(failures.length ? failures.join('\n') : 'PASS 16:9 players after adding games, fullscreen, scrolling, playback, and server controls in all four layouts');
  assert.deepEqual(failures, [], 'Players must use a 16:9 frame after adding a game');
} finally {
  await writeFile(path.join(output, 'geometry.json'), JSON.stringify(results, null, 2));
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-fullscreen-[0-9a-f-]{36}$/);
  await rm(profile, { recursive: true, force: true });
}
