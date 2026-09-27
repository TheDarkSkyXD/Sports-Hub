import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { chromium, _electron as electron } from 'playwright';

const desktop = process.argv.includes('--desktop');
let origin = process.env.PLAYER_BASE_URL || 'http://127.0.0.1:3100';
const artifacts = path.resolve(`work/player-verification${desktop ? '-electron' : ''}`);
const media = path.join(artifacts, 'media');
await mkdir(media, { recursive: true });
await promisify(execFile)(ffmpeg, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '90', '-map', '0:v', '-map', '1:a', '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-sc_threshold', '0',
  '-b:v:0', '350k', '-s:v:0', '640x360', '-b:v:1', '140k', '-s:v:1', '320x180',
  '-c:a', 'aac', '-b:a', '32k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(media, 'level_%v_%03d.ts'),
  '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0 v:1,a:1', path.join(media, 'level_%v.m3u8'),
], { windowsHide: true });

const games = Array.from({ length: 4 }, (_, i) => ({
  id: String(910001 + i), league: 'nfl', name: `Away ${i + 1} at Home ${i + 1}`,
  away: { name: `Away ${i + 1}`, short: `Away ${i + 1}`, abbreviation: `A${i + 1}`, color: 'f97360', score: '14' },
  home: { name: `Home ${i + 1}`, short: `Home ${i + 1}`, abbreviation: `H${i + 1}`, color: '4f8af7', score: '10' },
  status: 'in', detail: 'Q2 08:45', redzone: false,
}));
const results = [];
const desktopApp = desktop ? await electron.launch({
  args: [path.resolve('desktop/main.cjs'), `--user-data-dir=${path.join(artifacts, 'profile')}`],
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
}) : null;
const desktopPage = desktopApp ? await desktopApp.firstWindow() : null;
if (desktopPage) {
  await desktopPage.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  origin = new URL(desktopPage.url()).origin;
  await desktopApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => {
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  }));
}
const browser = desktopApp ? null : await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const seededContexts = new WeakSet();

async function screenshot(page, name, fullPage = false) {
  const target = path.join(artifacts, name);
  if (desktopApp) {
    const png = await desktopApp.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      return image.toPNG().toString('base64');
    });
    await writeFile(target, Buffer.from(png, 'base64'));
  } else await page.screenshot({ path: target, fullPage });
}

async function openRoom({ live = false, provider = false, manyQualities = false, providerFailure, waitingForLive = false, delayedBackup = false, offlineStart = false, holdHeartbeat = false } = {}) {
  const context = desktopApp ? desktopApp.context() : await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.unrouteAll({ behavior: 'wait' });
  let roomGames = games.map((g, index) => provider ? { ...g, status: waitingForLive && index === 0 ? 'pre' : g.status, sourceUrl: waitingForLive && index === 1 ? undefined : `https://isportsurge.ws/watch/nfl/test-game/${g.id}` } : g);
  const manifestRequests = new Set();
  const indexRequests = new Set();
  const sessions = new Map();
  const sessionCounts = { opened: 0, closed: 0, failures: 0, lateSwitches: 0 };
  let markHeartbeat;
  let releaseHeartbeat;
  const heartbeatObserved = new Promise(resolve => { markHeartbeat = resolve; });
  const heartbeatGate = new Promise(resolve => { releaseHeartbeat = resolve; });
  let heartbeatHeld = false;
  let backupAvailable = !delayedBackup;
  let fixtureOffline = offlineStart;
  const candidatesFor = (gameId, manual) => manual ? [] : [0, ...(backupAvailable ? [1] : [])].map(index => ({
    id: `gooz-${gameId}-${index}`, gameId, playerId: String(57000 + index),
    url: `https://gooz.aapmains.net/new-stream-embed/${57000 + index}`,
    label: index ? 'Backup' : 'Primary', sourceIds: ['fixture'], observedAt: Date.now(),
  }));
  const publicSession = session => ({ id: session.id, gameId: session.gameId, candidateId: session.candidateId, generation: session.generation, state: session.state, graceEndsAt: session.graceEndsAt });
  let finishFailures;
  const finalFailure = new Promise(resolve => { finishFailures = resolve; });
  await context.route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, revision: 1, aliases: {},
    games: roomGames,
    updatedAt: new Date().toISOString(), leagues: {
      nfl: { week: 3, scoresAt: new Date().toISOString(), sourceAt: null, errors: [] },
      ncaaf: { scoresAt: null, sourceAt: null, errors: [] },
    },
  } }));
  await context.route('**/api/playback?*', route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'DELETE') {
      const session = sessions.get(url.searchParams.get('session'));
      if (session) {
        sessions.delete(session.id);
        sessions.delete(session.requestId);
        sessionCounts.closed += 1;
      }
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405 });
  });
  await context.route('**/api/playback', async route => {
    const body = route.request().postDataJSON();
    if (route.request().method() === 'POST') {
      const { gameId, manual } = body;
      const key = body.requestId;
      if (!key) return route.fulfill({ status: 400, json: { error: 'Missing request id.' } });
      let session = sessions.get(key);
      if (!session) {
        session = { id: randomUUID(), requestId: key, gameId, candidateId: manual ? 'manual' : `gooz-${gameId}-0`, generation: 0, state: 'active', graceEndsAt: null };
        sessions.set(key, session);
        sessions.set(session.id, session);
        sessionCounts.opened += 1;
      }
      return route.fulfill({ json: { session: publicSession(session), candidates: candidatesFor(gameId, manual) } });
    }
    const session = sessions.get(body.sessionId);
    if (!session || body.generation !== session.generation) return route.fulfill({ status: 410, json: { error: 'Playback session ended.' } });
    if (holdHeartbeat && session.gameId === games[0].id && !heartbeatHeld && !body.failure && !body.retry && !body.candidateId) {
      heartbeatHeld = true;
      markHeartbeat();
      await heartbeatGate;
    }
    if (providerFailure === 'late' && session.exhausted && backupAvailable && !body.failure && !body.retry && !body.candidateId) {
      session.candidateId = `gooz-${session.gameId}-1`;
      session.generation += 1;
      session.failures = 0;
      session.exhausted = false;
      sessionCounts.lateSwitches += 1;
    }
    if (body.retry) { session.generation += 1; session.failures = 0; }
    else if (body.failure) {
      sessionCounts.failures += 1;
      session.failures = (session.failures || 0) + 1;
      if (providerFailure === 'late' && session.failures > 1 && !backupAvailable) {
        session.exhausted = true;
        return route.fulfill({ status: 503, json: { error: 'Available streams failed. Choose Try again when ready.' } });
      }
      if (session.failures > 1 && session.candidateId.endsWith('-1')) return route.fulfill({ status: 503, json: { error: 'Available streams are cooling down.' } });
      if (session.failures > 1 && backupAvailable) { session.candidateId = `gooz-${session.gameId}-1`; session.failures = 0; }
      session.generation += 1;
    } else if (body.candidateId && body.candidateId !== session.candidateId) { session.candidateId = body.candidateId; session.generation += 1; session.failures = 0; }
    return route.fulfill({ json: { session: publicSession(session), candidates: candidatesFor(session.gameId, session.candidateId === 'manual') } });
  });
  async function serveMedia(route, file) {
    let body = await readFile(path.join(media, file));
    if (manyQualities && file === 'master.m3u8') {
      body = Buffer.from(body.toString() + [500000, 650000, 800000].map(bandwidth => `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=640x360\nlevel_0.m3u8\n`).join(''));
    }
    if (live && file.endsWith('.m3u8')) {
      body = Buffer.from(body.toString().replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '').replace('#EXT-X-ENDLIST', ''));
    }
    await route.fulfill({ body, contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
  }
  await context.route('**/__player_fixture__/**', route => serveMedia(route, path.basename(new URL(route.request().url()).pathname)));
  await context.route('**/api/stream/**', route => {
    const url = new URL(route.request().url());
    const file = path.basename(url.pathname);
    if (url.pathname === `/api/stream/${games[0].id}/index.m3u8`) indexRequests.add(url.href);
    if (fixtureOffline && url.pathname === `/api/stream/${games[0].id}/index.m3u8`) return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: 'Offline fixture playlist' });
    if (providerFailure && url.pathname === `/api/stream/${games[0].id}/index.m3u8`) {
      manifestRequests.add(url.href);
      if (providerFailure === 'unavailable' || providerFailure === 'late' && url.searchParams.get('candidate')?.endsWith('-0') || Number(url.searchParams.get('generation')) < 2) {
        const response = route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: 'Expired provider playlist' });
        if (url.searchParams.get('candidate')?.endsWith('-1') && url.searchParams.get('generation') === '3') response.then(finishFailures);
        return response;
      }
    }
    return serveMedia(route, file === 'index.m3u8' ? 'master.m3u8' : file);
  });
  if (!seededContexts.has(context)) {
    await context.addInitScript(games => {
      const provider = new URL(location.href).searchParams.get('playerFixture') === 'provider';
      localStorage.setItem('sunday-room:v1', JSON.stringify({
        selected: games.map(g => g.id), favorites: [], layout: 'quad', volume: 70, spoilers: false,
        feeds: provider ? {} : Object.fromEntries(games.map((g, i) => [g.id, {
          url: `${location.origin}/__player_fixture__/master.m3u8?tile=${i}`, label: `Test stream ${i + 1}`,
        }])),
      }));
    }, games);
    seededContexts.add(context);
  }
  if (offlineStart) await context.addInitScript(() => {
    if (new URL(location.href).searchParams.has('offlineFixture')) Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  });
  const page = desktopPage || await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1100 });
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/?playerFixture=${provider ? 'provider' : 'direct'}${offlineStart ? '&offlineFixture=1' : ''}`);
  await page.locator('.game-tile').first().waitFor();
  if (!provider) await page.waitForFunction(() => document.querySelectorAll('video').length === 4 && [...document.querySelectorAll('video')].every(v => v.readyState >= 2));
  return { context, page, pageErrors, manifestRequests, indexRequests, finalFailure, sessionCounts, heartbeatObserved, releaseHeartbeat,
    publishBackup: () => { backupAvailable = true; },
    restoreOnline: async () => { fixtureOffline = false; await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })); },
    publishLiveGames: () => { roomGames = games.map(g => ({ ...g, sourceUrl: `https://isportsurge.ws/watch/nfl/test-game/${g.id}` })); },
    finishGame: () => { roomGames = roomGames.map((g, index) => index === 0 ? { ...g, status: 'post', detail: 'Final' } : index === 1 ? { ...g, sourceUrl: undefined } : g); },
    expireGame: () => { roomGames = roomGames.map((g, index) => index === 0 ? { ...g, status: 'post', lifecycle: 'final', detail: 'Final', sourceUrl: undefined, graceEndsAt: Date.now() + 1500 } : g); },
  };
}

async function revealControls(page) {
  const controls = page.getByRole('group', { name: 'Focused stream controls', exact: true });
  await controls.scrollIntoViewIfNeeded();
  const bounds = await controls.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + 12, bounds.y + bounds.height - 16);
  await page.mouse.move(bounds.x + 24, bounds.y + bounds.height - 16);
}

try {
  const { context, page, pageErrors, sessionCounts, expireGame } = await openRoom();
  assert.equal(sessionCounts.opened, 4);
  assert.equal(sessionCounts.closed, 0);
  assert.equal(await page.locator('video').count(), 4);
  assert.deepEqual(await page.locator('video').evaluateAll(videos => videos.map(v => v.paused)), [false, false, false, false]);
  results.push('Four real HLS streams decode and play.');
  if (desktopApp) {
    const before = await page.locator('video').first().evaluate(video => video.currentTime);
    const wakes = await desktopApp.evaluate(async ({ BrowserWindow, powerMonitor }) => {
      const original = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (...args) => { if (String(args[0]).endsWith('/api/games')) requests += 1; return original(...args); };
      const window = BrowserWindow.getAllWindows()[0];
      try {
        window.minimize();
        powerMonitor.emit('resume');
        await new Promise(resolve => setTimeout(resolve, 1500));
        window.restore();
        return requests;
      } finally { globalThis.fetch = original; }
    });
    assert.ok(wakes >= 1);
    await page.waitForFunction(previous => document.querySelector('video')?.currentTime > previous, before);
    results.push('Minimized Electron wakes its board refresh and keeps custom video advancing.');
  }

  const controls = page.getByRole('group', { name: 'Focused stream controls', exact: true });
  assert.equal(await controls.count(), 1);
  assert.equal(await page.locator('.game-tile').first().getByRole('group', { name: 'Focused stream controls', exact: true }).count(), 1);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="Focused stream controls"]')).opacity === '0');
  await page.locator('video').first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="Focused stream controls"]')).opacity === '1');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="Focused stream controls"]')).opacity === '0', {}, { timeout: 5000 });
  await revealControls(page);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="Focused stream controls"]')).opacity === '1');
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="Focused stream controls"]')).opacity === '0');
  await page.locator('video').first().hover();
  results.push('Focused controls appear on mouse movement, hide after three idle seconds, and hide when the pointer leaves.');
  await revealControls(page);
  await controls.getByRole('button', { name: 'Pause stream', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('video').paused);
  assert.deepEqual(await page.locator('video').evaluateAll(videos => videos.map(v => v.paused)), [true, false, false, false]);
  await revealControls(page);
  await controls.getByRole('button', { name: 'Play stream', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('video').paused);
  assert.deepEqual(await page.locator('video').evaluateAll(videos => videos.map(v => v.paused)), [false, false, false, false]);
  results.push('Custom player pause and play affect only the focused stream.');

  const firstVideo = await page.locator('video').first().elementHandle();
  const beforeFocus = await firstVideo.evaluate(v => v.currentTime);
  await page.locator('.audio-focus').nth(1).click();
  assert.equal(await controls.count(), 1);
  assert.equal(await page.locator('.game-tile').nth(1).getByRole('group', { name: 'Focused stream controls', exact: true }).count(), 1);
  assert.equal(await firstVideo.evaluate(v => v.isConnected && v.currentTime >= 0), true);
  assert.ok(await firstVideo.evaluate(v => v.currentTime) >= beforeFocus);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => !v.muted).length === 1);
  assert.deepEqual(await page.locator('video').evaluateAll(videos => videos.map(v => v.muted)), [true, false, true, true]);
  await controls.getByRole('slider', { name: 'Stream volume', exact: true }).press('Home');
  await controls.getByRole('slider', { name: 'Stream volume', exact: true }).press('ArrowRight');
  await page.waitForFunction(() => Math.abs(document.querySelectorAll('video')[1].volume - 0.01) < 0.001);
  results.push('Focus moves the controls without reloading media and keeps one audible stream; volume changes the media volume.');

  await revealControls(page);

  await controls.getByRole('button', { name: 'Video quality', exact: true }).click();
  await page.getByRole('button', { name: /^180p/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('video')[1].videoHeight === 180);
  await revealControls(page);
  await controls.getByRole('button', { name: 'Video quality', exact: true }).click();
  await page.getByRole('button', { name: /^360p/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('video')[1].videoHeight === 360);
  await revealControls(page);
  await controls.getByRole('button', { name: 'Video quality', exact: true }).click();
  await page.getByRole('button', { name: /^Auto/ }).click();
  results.push('Manual 180p and 360p selections change decoded video resolution; Auto remains selectable.');

  await revealControls(page);

  await controls.getByRole('button', { name: 'Fullscreen stream', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('native-player'));
  await controls.getByRole('button', { name: /Exit fullscreen/ }).hover();
  await screenshot(page, 'fullscreen.png');
  await revealControls(page);
  await controls.getByRole('button', { name: /Exit fullscreen/ }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  results.push('Stream fullscreen contains both the video and its custom controls.');

  await controls.getByRole('button', { name: 'Fullscreen stream', exact: true }).press('Enter');
  await page.locator('video').nth(1).click();
  await page.keyboard.press('3');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('.game-tile').nth(2).getByRole('group', { name: 'Focused stream controls', exact: true }).count(), 1);
  results.push('Changing focus exits the old stream fullscreen and reveals the new controls.');

  const pip = controls.getByRole('button', { name: 'Picture in picture', exact: true });
  if (await pip.count()) {
    await revealControls(page);
    await pip.click();
    await page.waitForFunction(() => !!document.pictureInPictureElement);
    await page.evaluate(() => document.pictureInPictureElement.pause());
    await controls.getByRole('button', { name: 'Play stream', exact: true }).waitFor();
    await revealControls(page);
    await controls.getByRole('button', { name: 'Play stream', exact: true }).click();
    await page.waitForFunction(() => !document.pictureInPictureElement.paused);
    await revealControls(page);
    await controls.getByRole('button', { name: 'Pause stream', exact: true }).click();
    await page.evaluate(() => document.pictureInPictureElement.play());
    await controls.getByRole('button', { name: 'Pause stream', exact: true }).waitFor();
    assert.deepEqual(await page.locator('video').evaluateAll(videos => videos.map(v => v.paused)), [false, false, false, false]);
    await revealControls(page);
    await controls.getByRole('button', { name: 'Exit picture in picture', exact: true }).click();
    await page.waitForFunction(() => !document.pictureInPictureElement);
    results.push('Picture-in-picture opens; media play/pause events keep the custom controls synchronized.');
  }

  await page.getByRole('button', { name: 'Single game', exact: true }).click();
  await revealControls(page);
  await controls.getByRole('button', { name: 'Pause stream', exact: true }).click();
  await controls.getByRole('button', { name: 'Play stream', exact: true }).waitFor();
  assert.equal(await page.locator('video').count(), 1);
  await revealControls(page);
  await controls.getByRole('button', { name: 'Play stream', exact: true }).click();
  await page.getByRole('button', { name: 'Four games', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('video').length === 4 && [...document.querySelectorAll('video')].every(v => v.readyState >= 2 && !v.paused));
  results.push('Custom playback controls work in single-game layout and restore the four-stream layout.');

  await page.locator('.audio-focus').first().click();
  await page.evaluate(() => scrollTo(0, 0));
  await screenshot(page, 'desktop.png', true);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, 'mobile.png', true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await controls.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  results.push('Focused controls fit a 390px viewport without horizontal page overflow.');
  assert.deepEqual(pageErrors, []);
  await page.setViewportSize({ width: 1440, height: 1100 });
  const closedBeforeExpiration = sessionCounts.closed;
  expireGame();
  await page.getByRole('button', { name: 'Refresh game data', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('video').length === 3);
  await page.waitForFunction(() => document.querySelectorAll('.game-tile')[0]?.textContent?.includes('Game stream ended'));
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (sessionCounts.closed > closedBeforeExpiration) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error('Manual session did not close at deadline')); }
    }, 20);
  });
  assert.equal(sessionCounts.closed, closedBeforeExpiration + 1);
  assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('sunday-room:v1')).feeds))[games[0].id]);
  results.push('A manual feed stops at the final-game deadline, closes its session, and stays saved in preferences.');
  if (!desktopApp) await context.close();

  const liveRoom = await openRoom({ live: true });
  const liveControls = liveRoom.page.getByRole('group', { name: 'Focused stream controls', exact: true });
  const goLive = liveControls.getByRole('button', { name: /LIVE/ });
  await goLive.waitFor();
  await liveControls.getByRole('slider', { name: /^Seek / }).press('Home');
  await liveRoom.page.waitForFunction(() => document.querySelector('video').currentTime < 10);
  await revealControls(liveRoom.page);
  await goLive.click();
  await liveRoom.page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v.seekable.length && v.currentTime >= v.seekable.end(v.seekable.length - 1) - 10;
  });
  await liveControls.locator('button.at-live:disabled').waitFor();
  assert.equal(await goLive.isDisabled(), true);
  assert.deepEqual(liveRoom.pageErrors, []);
  results.push('A live HLS manifest exposes DVR seeking and Go Live returns to the safe live position.');
  if (!desktopApp) await liveRoom.context.close();

  const providerRoom = await openRoom({ provider: true });
  const firstTile = providerRoom.page.locator('.game-tile').first();
  await providerRoom.page.waitForFunction(() => document.querySelectorAll('video').length === 4 && [...document.querySelectorAll('video')].every(video => video.readyState >= 2 && !video.paused));
  assert.equal(await providerRoom.page.getByRole('button', { name: 'Play game', exact: true }).count(), 0);
  results.push('Restored live provider games start automatically without a Play game click.');
  const providerControls = providerRoom.page.getByRole('group', { name: 'Focused stream controls', exact: true });
  await revealControls(providerRoom.page);
  await providerControls.getByRole('button', { name: 'Video quality', exact: true }).click();
  await providerRoom.page.getByRole('button', { name: /^180p/ }).click();
  await providerRoom.page.waitForFunction(() => document.querySelector('video').videoHeight === 180);
  await revealControls(providerRoom.page);
  await providerControls.getByRole('button', { name: 'Pause stream', exact: true }).click();
  const backupLoaded = providerRoom.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/stream/${games[0].id}/index.m3u8` && url.searchParams.get('candidate')?.endsWith('-1') && response.ok();
  });
  await firstTile.getByRole('button', { name: 'Switch server', exact: true }).click();
  await backupLoaded;
  await providerRoom.page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  assert.equal(await firstTile.locator('video').evaluate(v => v.paused), true);
  await revealControls(providerRoom.page);
  await providerControls.getByRole('button', { name: 'Video quality', exact: true }).click();
  assert.match(await providerRoom.page.getByRole('button', { name: /^Auto/ }).getAttribute('class'), /selected/);
  assert.equal(await firstTile.getByText('Connecting to your feed…', { exact: true }).count(), 0);
  assert.deepEqual(providerRoom.pageErrors, []);
  results.push('Listed provider playback uses the shared controls; server changes preserve pause and reset quality to Auto.');
  if (!desktopApp) await providerRoom.context.close();

  const discoveredRoom = await openRoom({ provider: true, delayedBackup: true });
  const discoveredTile = discoveredRoom.page.locator('.game-tile').first();
  await discoveredRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  assert.equal(await discoveredTile.getByRole('button', { name: 'Switch server', exact: true }).isDisabled(), true);
  discoveredRoom.publishBackup();
  const refreshedPrimary = discoveredRoom.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/stream/${games[0].id}/index.m3u8` && url.searchParams.get('generation') === '1';
  });
  await discoveredTile.locator('video').dispatchEvent('ended');
  await refreshedPrimary;
  await discoveredTile.getByRole('button', { name: 'Switch server', exact: true }).waitFor({ state: 'visible' });
  await discoveredRoom.page.waitForFunction(() => !document.querySelector('.game-tile .provider-controls button')?.disabled && document.querySelector('video')?.readyState >= 2);
  const discoveredBackup = discoveredRoom.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/stream/${games[0].id}/index.m3u8` && url.searchParams.get('candidate')?.endsWith('-1') && response.ok();
  });
  await discoveredTile.locator('video').dispatchEvent('error');
  await discoveredBackup;
  await discoveredRoom.page.waitForFunction(() => document.querySelector('.game-tile video')?.readyState >= 2 && document.querySelector('.game-tile video')?.currentTime > 0);
  assert.equal(discoveredRoom.sessionCounts.failures, 2);
  assert.deepEqual(discoveredRoom.pageErrors, []);
  results.push('A live provider EOS retries; a backup discovered after open reaches the player on PATCH and plays after primary failure.');
  if (!desktopApp) await discoveredRoom.context.close();

  const heartbeatRoom = await openRoom({ provider: true, holdHeartbeat: true });
  await heartbeatRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  await Promise.race([
    heartbeatRoom.heartbeatObserved,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Provider heartbeat did not start')), 36000)),
  ]);
  const recoveredAfterHeartbeat = heartbeatRoom.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/stream/${games[0].id}/index.m3u8` && url.searchParams.get('generation') === '1';
  });
  await heartbeatRoom.page.locator('.game-tile video').first().dispatchEvent('error');
  heartbeatRoom.releaseHeartbeat();
  await recoveredAfterHeartbeat;
  assert.equal(heartbeatRoom.sessionCounts.failures, 1);
  assert.deepEqual(heartbeatRoom.pageErrors, []);
  results.push('A media failure during an in-flight heartbeat is queued and recovers after the heartbeat finishes.');
  if (!desktopApp) await heartbeatRoom.context.close();

  const selectionRoom = await openRoom({ provider: true, holdHeartbeat: true });
  await selectionRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  await Promise.race([
    selectionRoom.heartbeatObserved,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Provider heartbeat did not start')), 36000)),
  ]);
  const selectedBackup = selectionRoom.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/stream/${games[0].id}/index.m3u8` && url.searchParams.get('candidate')?.endsWith('-1') && response.ok();
  });
  await selectionRoom.page.locator('.game-tile').first().getByRole('combobox', { name: 'Choose listed server' }).selectOption(`gooz-${games[0].id}-1`);
  await selectionRoom.page.locator('.game-tile video').first().dispatchEvent('error');
  selectionRoom.releaseHeartbeat();
  await selectedBackup;
  await selectionRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && document.querySelector('video')?.currentTime > 0);
  assert.equal(selectionRoom.sessionCounts.failures, 0);
  assert.deepEqual(selectionRoom.pageErrors, []);
  results.push('Explicit server selection outranks a concurrent media failure during an in-flight heartbeat.');
  if (!desktopApp) await selectionRoom.context.close();

  const offlineRoom = await openRoom({ provider: true, offlineStart: true });
  await offlineRoom.page.waitForFunction(() => document.querySelector('.game-tile video') !== null);
  await offlineRoom.page.waitForTimeout(22000);
  assert.equal(offlineRoom.sessionCounts.failures, 0);
  assert.equal(offlineRoom.indexRequests.size, 1);
  await offlineRoom.restoreOnline();
  await offlineRoom.page.waitForFunction(() => document.querySelector('.game-tile video')?.readyState >= 2 && document.querySelector('.game-tile video')?.currentTime > 0, { timeout: 20000 });
  assert.equal(offlineRoom.sessionCounts.failures, 0);
  assert.deepEqual(offlineRoom.pageErrors, []);
  results.push('An offline fatal playlist and startup timeout wait for connectivity, then reload without penalizing the source.');
  if (!desktopApp) await offlineRoom.context.close();

  const deferredRoom = await openRoom({ provider: true });
  await deferredRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  const deferredControls = deferredRoom.page.getByRole('group', { name: 'Focused stream controls', exact: true });
  await revealControls(deferredRoom.page);
  await deferredControls.getByRole('button', { name: 'Pause stream', exact: true }).click();
  await deferredRoom.page.locator('video').first().dispatchEvent('error');
  await deferredRoom.page.waitForTimeout(2200);
  assert.equal(deferredRoom.sessionCounts.failures, 0);
  await revealControls(deferredRoom.page);
  await deferredControls.getByRole('button', { name: 'Play stream', exact: true }).click();
  await deferredRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  await deferredRoom.page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await deferredRoom.page.locator('video').first().dispatchEvent('error');
  await deferredRoom.page.waitForTimeout(2200);
  assert.equal(deferredRoom.sessionCounts.failures, 0);
  await deferredRoom.page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }));
  await deferredRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  await deferredRoom.page.evaluate(() => {
    const until = performance.now() + 6500;
    while (performance.now() < until) {}
    document.querySelector('video').dispatchEvent(new Event('error'));
  });
  await deferredRoom.page.waitForTimeout(2200);
  assert.equal(deferredRoom.sessionCounts.failures, 0);
  assert.deepEqual(deferredRoom.pageErrors, []);
  results.push('Paused, hidden, and wake-from-sleep media faults reload locally without marking the provider failed.');
  if (!desktopApp) await deferredRoom.context.close();

  const stallRoom = await openRoom({ provider: true });
  await stallRoom.page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  const stallControls = stallRoom.page.getByRole('group', { name: 'Focused stream controls', exact: true });
  await revealControls(stallRoom.page);
  await stallControls.getByRole('button', { name: 'Pause stream', exact: true }).click();
  await stallRoom.page.waitForTimeout(17000);
  assert.equal(stallRoom.indexRequests.size, 1);
  await revealControls(stallRoom.page);
  await stallControls.getByRole('button', { name: 'Play stream', exact: true }).click();
  await stallRoom.page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const video = document.querySelector('video');
    const actual = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    const frozen = video.currentTime;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => frozen, set: value => actual.set.call(video, value) });
  });
  await stallRoom.page.waitForTimeout(17000);
  assert.equal(stallRoom.indexRequests.size, 1);
  const recoveredFromStall = stallRoom.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/stream/${games[0].id}/index.m3u8` && url.searchParams.get('generation') === '1';
  }, { timeout: 25000 });
  await stallRoom.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }));
  await recoveredFromStall;
  assert.deepEqual(stallRoom.pageErrors, []);
  results.push('A paused or offline stream does not fail over; a live video that stops advancing refreshes once.');
  if (!desktopApp) await stallRoom.context.close();

  const recoveryRoom = await openRoom({ provider: true, providerFailure: 'recover' });
  await recoveryRoom.page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video?.readyState >= 2 && !video.paused && video.currentTime > 0;
  });
  assert.equal(recoveryRoom.manifestRequests.size, 3);
  assert.deepEqual([...recoveryRoom.manifestRequests].map(url => new URL(url).searchParams.get('generation')), ['0', '1', '2']);
  assert.deepEqual(recoveryRoom.pageErrors, []);
  results.push('Expired provider playlists refresh once and recover on a backup server.');
  if (!desktopApp) await recoveryRoom.context.close();

  const unavailableRoom = await openRoom({ provider: true, providerFailure: 'unavailable' });
  await unavailableRoom.finalFailure;
  await unavailableRoom.page.getByText("Feed couldn't play", { exact: true }).waitFor();
  assert.equal(unavailableRoom.manifestRequests.size, 4);
  assert.deepEqual(unavailableRoom.pageErrors, []);
  results.push('Unavailable providers refresh, try the backup, and expose a retry control after exhaustion.');
  if (!desktopApp) await unavailableRoom.context.close();

  const lateRoom = await openRoom({ provider: true, providerFailure: 'late', delayedBackup: true });
  await lateRoom.page.getByText('Available streams failed. Choose Try again when ready.', { exact: true }).waitFor();
  assert.equal(lateRoom.sessionCounts.failures, 2);
  lateRoom.publishBackup();
  await lateRoom.page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video?.readyState >= 2 && !video.paused && video.currentTime > 0;
  }, null, { timeout: 45000 });
  assert.equal(lateRoom.sessionCounts.lateSwitches, 1);
  assert.equal(lateRoom.sessionCounts.failures, 2);
  assert.deepEqual(lateRoom.pageErrors, []);
  results.push('A newly listed backup starts through the normal heartbeat after the first server exhausts.');
  if (!desktopApp) await lateRoom.context.close();

  const scheduledRoom = await openRoom({ provider: true, waitingForLive: true });
  await scheduledRoom.page.waitForFunction(() => document.querySelectorAll('video').length === 2 && [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
  assert.equal(await scheduledRoom.page.locator('.game-tile').nth(0).getByRole('button', { name: 'Play game', exact: true }).count(), 1);
  assert.equal(await scheduledRoom.page.locator('.game-tile').nth(1).getByRole('button', { name: 'Stream not listed yet', exact: true }).count(), 1);
  await scheduledRoom.page.locator('.audio-focus').nth(2).click();
  await revealControls(scheduledRoom.page);
  await scheduledRoom.page.getByRole('button', { name: 'Pause stream', exact: true }).click();
  scheduledRoom.publishLiveGames();
  await scheduledRoom.page.getByRole('button', { name: 'Refresh game data', exact: true }).click();
  await scheduledRoom.page.waitForFunction(() => document.querySelectorAll('video').length === 4 && [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
  assert.deepEqual(await scheduledRoom.page.locator('video').evaluateAll(videos => videos.map(video => video.paused)), [false, false, true, false]);
  await revealControls(scheduledRoom.page);
  await scheduledRoom.page.getByRole('button', { name: 'Play stream', exact: true }).click();
  await scheduledRoom.page.waitForFunction(() => [...document.querySelectorAll('video')].every(video => !video.paused));
  await scheduledRoom.page.getByRole('button', { name: 'Remove Away 1 at Home 1', exact: true }).click();
  assert.equal(await scheduledRoom.page.locator('video').count(), 3);
  await scheduledRoom.page.getByTitle('Add Away 1 at Home 1', { exact: true }).click();
  await scheduledRoom.page.waitForFunction(() => document.querySelectorAll('video').length === 4 && [...document.querySelectorAll('video')].every(video => video.readyState >= 2 && !video.paused));
  assert.deepEqual(scheduledRoom.pageErrors, []);
  results.push('Live status and newly listed sources auto-connect; focused pause survives refresh, and re-added live games auto-start.');
  const continuedVideos = await scheduledRoom.page.locator('video').elementHandles();
  scheduledRoom.finishGame();
  await scheduledRoom.page.getByRole('button', { name: 'Refresh game data', exact: true }).click();
  await scheduledRoom.page.getByText('Final', { exact: true }).first().waitFor();
  for (const video of continuedVideos) assert.equal(await video.evaluate(element => element.isConnected && !element.paused), true);
  results.push('Started streams keep playing when scores mark a game final or its directory link disappears.');
  if (!desktopApp) await scheduledRoom.context.close();

  const qualityRoom = await openRoom({ manyQualities: true });
  await qualityRoom.page.locator('video').first().hover();
  await qualityRoom.page.getByRole('button', { name: 'Video quality', exact: true }).click();
  const qualityMenu = qualityRoom.page.getByRole('dialog', { name: 'Playback quality', exact: true });
  const qualityOptions = qualityMenu.getByRole('button');
  assert.equal(await qualityOptions.count(), 6);
  const heading = qualityMenu.getByText('Quality', { exact: true });
  const headingBefore = await heading.boundingBox();
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await qualityOptions.nth(index).evaluate(button => {
      const rect = button.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && [rect.top + 2, rect.bottom - 2].every(y => button.contains(document.elementFromPoint(rect.x + rect.width / 2, y)));
    }), true, `Quality option ${index + 1} is fully visible before scrolling`);
  }
  await qualityOptions.nth(3).hover();
  await qualityRoom.page.mouse.wheel(0, 300);
  await qualityRoom.page.waitForFunction(() => {
    const menu = document.querySelector('[aria-label="Playback quality"]');
    const last = menu?.querySelector('button:last-child');
    if (!last) return false;
    const rect = last.getBoundingClientRect();
    return last.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2));
  });
  assert.deepEqual(await heading.boundingBox(), headingBefore);
  await screenshot(qualityRoom.page, 'quality-menu.png');
  assert.deepEqual(qualityRoom.pageErrors, []);
  results.push('Four quality options are fully visible; the Quality heading stays fixed while the options scroll.');
  if (!desktopApp) await qualityRoom.context.close();
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  await rm(path.join(artifacts, 'failure.json'), { force: true });
  console.log(results.join('\n'));
} catch (error) {
  const pages = desktopApp ? desktopApp.context().pages() : browser.contexts().flatMap(context => context.pages());
  for (const page of pages) {
    const state = await page.evaluate(() => ({
      url: location.href, text: document.body.innerText,
      videos: [...document.querySelectorAll('video')].map(v => ({
        source: v.currentSrc, ready: v.readyState, paused: v.paused, time: v.currentTime, error: v.error?.message,
      })),
    })).catch(() => null);
    await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ completed: results, state }, null, 2));
  }
  throw error;
} finally {
  await browser?.close();
  await desktopApp?.close();
  if (desktopApp) {
    let stopped = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); }
      catch { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(stopped, true, 'Electron shutdown must stop its local Next server');
  }
}
