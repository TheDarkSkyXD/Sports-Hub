import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.scratch', 'nhl');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-nhl-'));
const failures = [];
let desktop;
let page;
try {
  await mkdir(output, { recursive: true });
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  const deadline = Date.now() + 90_000;
  while (!page && Date.now() < deadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The source Electron window must open');
  page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('button', { name: 'Watch room', exact: true }).waitFor();
  const nativeWindow = await desktop.browserWindow(page);
  await nativeWindow.evaluate(window => {
    window.setContentSize(1500, 1000);
    window.webContents.setAudioMuted(true);
    window.showInactive();
  });
  await nativeWindow.dispose();
  let board;
  const scheduleDeadline = Date.now() + 120_000;
  do {
    const response = await page.request.get(new URL('/api/games', page.url()).href);
    assert.equal(response.status(), 200);
    board = await response.json();
    if (board.scheduleState === 'ready' && ['nhl', 'ncaah', 'ncaawh'].every(league => board.leagues[league]?.scoresAt && board.games.some(game => game.league === league))) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < scheduleDeadline);
  for (const league of ['nhl', 'ncaah', 'ncaawh']) {
    assert.ok(board.leagues[league]?.scoresAt, `The real ESPN ${league} schedule must load`);
    assert.ok(board.games.some(game => game.league === league), `The board must contain real ${league} games`);
  }
  const hockeyGames = board.games.filter(game => game.league === 'nhl');
  assert.ok(hockeyGames.length > 0, 'The live board must contain real NHL games');
  assert.ok(hockeyGames.every(game => /^nhl-\d+$/.test(game.id) && !game.redzone && !game.down && !game.possession));
  while (await page.locator('.game-grid button[aria-label^="Remove "]').count()) {
    await page.locator('.game-grid button[aria-label^="Remove "]').first().click();
  }
  await page.getByRole('button', { name: 'Hockey', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.center-game').length > 0 &&
    [...document.querySelectorAll('.center-game')].every(card => /^(?:nhl|ncaah|ncaawh)-/.test(card.dataset.gameId)));
  for (const league of ['nhl', 'ncaah', 'ncaawh']) {
    assert.ok(await page.locator(`.center-game[data-game-id^="${league}-"]`).count() > 0, `${league} games must appear under Hockey`);
  }
  assert.equal(await page.getByRole('tab', { name: 'Red zone games' }).count(), 0);
  assert.equal(await page.locator('#smart-focus').count(), 0);
  await page.getByRole('button', { name: 'Game schedule', exact: true }).click();
  await page.locator('.schedule-card').first().waitFor();
  const scheduleLabels = await page.locator('.schedule-card .league-tag').allTextContents();
  assert.ok(scheduleLabels.every(label => ['NHL', 'NCAA Hockey', "NCAA Women's Hockey"].includes(label)));
  for (const label of ['NHL', 'NCAA Hockey', "NCAA Women's Hockey"]) assert.ok(scheduleLabels.includes(label));
  await page.getByRole('button', { name: 'Watch room', exact: true }).click();
  const game = hockeyGames.find(item => item.lifecycle === 'live') ?? hockeyGames.find(item => item.lifecycle === 'scheduled');
  assert.ok(game, 'The room card must correspond to a real scheduled NHL game');
  const card = page.locator(`.center-game[data-game-id="${game.id}"]`);
  const remove = page.getByRole('button', { name: `Remove ${game.name}`, exact: true });
  if (await remove.count()) await remove.click();
  await card.getByRole('button', { name: 'Add game', exact: true }).click();
  await page.getByRole('button', { name: `Remove ${game.name}`, exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'electron-hockey-room.png') });
  let inventory;
  const sourceDeadline = Date.now() + 90_000;
  do {
    const response = await page.request.get(new URL('/api/sources', page.url()).href);
    assert.equal(response.status(), 200);
    inventory = await response.json();
    if (['nhl', 'ncaah', 'ncaawh'].every(league => inventory.games.some(row => row.gameId.startsWith(`${league}-`) && row.sourceLinks.length))) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < sourceDeadline);
  const nhlListings = inventory.games.filter(row => row.gameId.startsWith('nhl-') && row.sourceLinks.length);
  assert.ok(nhlListings.length > 0, 'Existing providers must publish links matched to real NHL games');
  for (const league of ['ncaah', 'ncaawh']) {
    assert.ok(inventory.games.some(row => row.gameId.startsWith(`${league}-`) && row.sourceLinks.length), `Existing providers must match real ${league} games`);
  }
  for (const source of ['tvapp-nhl', 'streamcenter-nhl', 'buffstream-nhl', 'vipbox-nhl', 'strikeout-nhl', 'methstreams-nhl', 'crackstreams-nhl']) {
    assert.ok(inventory.sources.some(row => row.id === source), `${source} must be registered`);
  }
  await page.getByRole('button', { name: 'Room settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  await page.getByRole('tab', { name: 'NHL', exact: true }).click();
  assert.ok(await page.getByText(/Showing \d+ of \d+ NHL sources/).isVisible());
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await page.getByRole('region', { name: 'NHL games with listed sources', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'electron-hockey-sources.png') });
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  for (const label of ['NCAA Hockey', "NCAA Women's Hockey"]) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    assert.ok(await page.getByText(new RegExp(`Showing \\d+ of \\d+ ${label} sources`)).isVisible());
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const mediaPath = path.join(output, 'nhl-player-fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  await desktop.context().route('http://localhost:9999/nhl.mp4', route => route.fulfill({ body: media, contentType: 'video/mp4' }));
  await page.getByRole('button', { name: `Feed settings for ${game.name}`, exact: true }).click();
  await page.getByLabel('Feed name', { exact: true }).fill('NHL player check');
  await page.getByLabel('Video URL', { exact: true }).fill('http://localhost:9999/nhl.mp4');
  await page.getByRole('button', { name: 'Connect feed', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.videoWidth === 640 && video.currentTime > 0), null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(output, 'electron-hockey-player.png') });
  await page.reload();
  await page.getByRole('button', { name: `Remove ${game.name}`, exact: true }).waitFor();
  assert.deepEqual(failures, [], 'The Electron renderer must have no uncaught errors');
  const result = {
    nhlGames: hockeyGames.length,
    ncaaHockeyGames: board.games.filter(game => game.league === 'ncaah').length,
    ncaaWomensHockeyGames: board.games.filter(game => game.league === 'ncaawh').length,
    matchedNhlGames: nhlListings.length,
    matchedNcaaHockeyGames: inventory.games.filter(row => row.gameId.startsWith('ncaah-') && row.sourceLinks.length).length,
    matchedNcaaWomensHockeyGames: inventory.games.filter(row => row.gameId.startsWith('ncaawh-') && row.sourceLinks.length).length,
    nhlLinks: nhlListings.reduce((sum, row) => sum + row.sourceLinks.length, 0),
    nhlCandidates: nhlListings.reduce((sum, row) => sum + row.candidates.length, 0),
    selectedGame: { id: game.id, name: game.name }, scoresAt: board.leagues.nhl.scoresAt,
    checks: ['real NHL and NCAA men and women schedules', 'Hockey filters room and schedule', 'football controls hidden',
      'add NHL game', 'NHL source inventory', 'local video decodes through real NHL playback session', 'room persists after reload'],
  };
  await writeFile(path.join(output, 'electron-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'electron-failure.png') }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-nhl-/);
  await rm(profile, { recursive: true, force: true });
}
