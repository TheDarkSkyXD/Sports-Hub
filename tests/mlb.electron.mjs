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
const output = path.join(root, '.scratch', 'mlb');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-mlb-'));
const failures = [];
let desktop;
let page;
try {
  await mkdir(output, { recursive: true });
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), '--dev', `--user-data-dir=${profile}`],
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
    if (board.scheduleState === 'ready' && board.leagues.mlb?.scoresAt && board.games.some(game => game.league === 'mlb')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < scheduleDeadline);
  assert.ok(board.leagues.mlb?.scoresAt, 'The real ESPN MLB schedule must load');
  const baseballGames = board.games.filter(game => game.league === 'mlb');
  assert.ok(baseballGames.length > 0, 'The live board must contain real MLB games');
  assert.ok(baseballGames.every(game => /^mlb-\d+$/.test(game.id) && !game.redzone && !game.down && !game.possession));
  const removeGames = page.getByRole('button', { name: /^Remove / });
  await removeGames.first().waitFor();
  while (await removeGames.count()) {
    await removeGames.first().click();
  }
  await page.getByRole('button', { name: 'Baseball', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.center-game').length > 0 &&
    [...document.querySelectorAll('.center-game')].every(card => /^mlb-/.test(card.dataset.gameId)));
  assert.equal(await page.getByRole('tab', { name: 'Red zone games' }).count(), 0);
  assert.equal(await page.locator('#smart-focus').count(), 0);
  await page.getByRole('button', { name: 'Game schedule', exact: true }).click();
  await page.locator('.schedule-card').first().waitFor();
  const scheduleLabels = await page.locator('.schedule-card .league-tag').allTextContents();
  assert.ok(scheduleLabels.length > 0 && scheduleLabels.every(label => label === 'MLB'));
  await page.screenshot({ path: path.join(output, 'electron-baseball-schedule.png') });
  await page.getByRole('button', { name: 'Watch room', exact: true }).click();
  const game = baseballGames.find(item => item.lifecycle === 'live') ?? baseballGames.find(item => item.lifecycle === 'scheduled');
  assert.ok(game, 'A real MLB game must be available to add to the room');
  await page.locator(`.center-game[data-game-id="${game.id}"]`).getByRole('button', { name: 'Add game', exact: true }).click();
  await page.getByRole('button', { name: `Remove ${game.name}`, exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'electron-baseball-room.png') });
  let inventory;
  const mlbSourceIds = ['tvapp-mlb', 'streamcenter-mlb', 'strikeout-mlb', 'methstreams-mlb',
    'crackstreams-mlb', 'buffstream-mlb', 'mlbbox-mlb'];
  const sourceDeadline = Date.now() + 120_000;
  do {
    const response = await page.request.get(new URL('/api/sources', page.url()).href);
    assert.equal(response.status(), 200);
    inventory = await response.json();
    if (mlbSourceIds.every(id => inventory.sources.find(source => source.id === id)?.lastAttempt) &&
      inventory.games.some(row => row.gameId.startsWith('mlb-') && row.candidates.length)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < sourceDeadline);
  const listings = inventory.games.filter(row => row.gameId.startsWith('mlb-') && row.sourceLinks.length);
  await writeFile(path.join(output, 'electron-board.json'), JSON.stringify(board, null, 2));
  await writeFile(path.join(output, 'electron-sources.json'), JSON.stringify(inventory, null, 2));
  for (const id of mlbSourceIds) {
    assert.ok(inventory.sources.find(source => source.id === id)?.lastAttempt, `${id} must finish an initial catalog check`);
  }
  assert.ok(listings.length > 0, 'Existing providers must publish links matched to real MLB games');
  assert.ok(listings.some(row => row.candidates.length > 0), 'An MLB listing must publish a compatible player route');
  await page.getByRole('button', { name: 'Room settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  await page.getByRole('tab', { name: 'MLB', exact: true }).click();
  assert.ok(await page.getByText(/Showing \d+ of \d+ MLB sources/).isVisible());
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  const listedGames = page.getByRole('region', { name: 'MLB games with listed sources', exact: true });
  await listedGames.waitFor();
  await listedGames.locator('details').first().locator('summary').click();
  const visibleLink = await listedGames.getByRole('link').first().getAttribute('href');
  assert.ok(listings.some(row => row.sourceLinks.some(link => link.url === visibleLink)),
    'The MLB inventory must display a provider link matched by the live source pipeline');
  await page.screenshot({ path: path.join(output, 'electron-baseball-sources.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const mediaPath = path.join(output, 'mlb-player-fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  await desktop.context().route('http://localhost:9999/mlb.mp4', route => route.fulfill({ body: media, contentType: 'video/mp4' }));
  await page.getByRole('button', { name: `Feed settings for ${game.name}`, exact: true }).click();
  await page.getByLabel('Feed name', { exact: true }).fill('MLB player check');
  await page.getByLabel('Video URL', { exact: true }).fill('http://localhost:9999/mlb.mp4');
  await page.getByRole('button', { name: 'Connect feed', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.videoWidth === 640 && video.currentTime > 0), null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(output, 'electron-baseball-player.png') });
  await page.reload();
  await page.getByRole('button', { name: `Remove ${game.name}`, exact: true }).waitFor();
  assert.deepEqual(failures, [], 'The Electron renderer must have no uncaught errors');
  const result = {
    mlbGames: baseballGames.length,
    matchedMlbGames: listings.length,
    mlbLinks: listings.reduce((sum, row) => sum + row.sourceLinks.length, 0),
    mlbCandidates: listings.reduce((sum, row) => sum + row.candidates.length, 0),
    sourceIds: [...new Set(listings.flatMap(row => row.sourceLinks.map(link => link.sourceId)))],
    sources: inventory.sources.filter(source => mlbSourceIds.includes(source.id)).map(source => ({
      id: source.id, outcome: source.lastAttempt.outcome, listings: source.listingCount, matchedGames: source.matchedGameCount,
    })),
    selectedGame: { id: game.id, name: game.name }, scoresAt: board.leagues.mlb.scoresAt,
    checks: ['real MLB schedule', 'Baseball filters room and schedule', 'football controls hidden',
      'add MLB game', 'MLB source inventory', 'local video decodes through MLB playback session', 'room persists after reload'],
  };
  await writeFile(path.join(output, 'electron-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'electron-failure.png') }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-mlb-/);
  await rm(profile, { recursive: true, force: true });
}
