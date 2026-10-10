import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.scratch', 'combat-sports');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-combat-'));
const failures = [];
let runtimeLogs = '';
let desktop;
let page;
try {
  await mkdir(output, { recursive: true });
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), ...(process.argv.includes('--compiled') ? [] : ['--dev']), `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  for (const stream of [desktop.process().stdout, desktop.process().stderr]) {
    stream?.on('data', chunk => { runtimeLogs = (runtimeLogs + chunk.toString()).slice(-200_000); });
  }
  const deadline = Date.now() + 90_000;
  while (!page && Date.now() < deadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The source Electron window must open');
  page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('button', { name: 'Watch room', exact: true }).waitFor({ timeout: 90_000 });
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
    if (board.scheduleState === 'ready' && ['ufc', 'boxing'].every(league =>
      board.leagues[league]?.scoresAt && board.games.some(game => game.league === league))) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  } while (Date.now() < scheduleDeadline);
  await writeFile(path.join(output, 'live-board.json'), JSON.stringify(board, null, 2));
  const combatGames = board.games.filter(game => game.league === 'ufc' || game.league === 'boxing');
  for (const league of ['ufc', 'boxing']) {
    assert.ok(board.leagues[league]?.scoresAt, `The real ${league} schedule must load`);
    assert.ok(combatGames.some(game => game.league === league), `The real board must include ${league} cards`);
  }
  assert.ok(combatGames.every(game => game.combat?.eventId && !('home' in game) && !('away' in game)),
    'Combat cards must have event identity without fabricated teams');
  await page.getByRole('button', { name: 'Combat Sports', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.center-game').length > 0 &&
    [...document.querySelectorAll('.center-game')].every(card => /^(ufc|boxing)-/.test(card.dataset.gameId)));
  assert.equal(await page.getByRole('tab', { name: 'Red zone games' }).count(), 0);
  assert.equal(await page.locator('#smart-focus').count(), 0);
  const ufc = combatGames.find(game => game.league === 'ufc' && game.lifecycle !== 'final');
  const boxing = combatGames.find(game => game.league === 'boxing' && game.lifecycle !== 'final');
  assert.ok(ufc && boxing, 'Both sports need a current or upcoming card for the live Electron check');
  await page.locator('#game-search').fill(ufc.name);
  await page.waitForFunction(id => {
    const cards = [...document.querySelectorAll('.center-game')];
    return cards.length === 1 && cards[0].dataset.gameId === id;
  }, ufc.id);
  await page.locator('#game-search').fill('');
  while (await page.locator('.game-grid button[aria-label^="Remove "]').count()) {
    await page.locator('.game-grid button[aria-label^="Remove "]').first().click();
  }
  for (const game of [ufc, boxing]) {
    await page.locator(`.center-game[data-game-id="${game.id}"]`).getByRole('button', { name: /Add (game|event|card)/ }).click();
    await page.getByRole('button', { name: `Remove ${game.name}`, exact: true }).waitFor();
  }
  assert.equal(await page.locator('.game-grid .team-badge').count(), 0);
  await page.screenshot({ path: path.join(output, 'electron-combat-room.png') });
  await page.getByRole('button', { name: 'Game schedule', exact: true }).click();
  await page.locator('.schedule-card').first().waitFor();
  const labels = await page.locator('.schedule-card .league-tag').allTextContents();
  assert.ok(labels.includes('UFC') && labels.includes('Boxing'));
  assert.ok(labels.every(label => label === 'UFC' || label === 'Boxing'));
  assert.equal(await page.locator('.schedule-matchup').count(), 0);
  await page.screenshot({ path: path.join(output, 'electron-combat-schedule.png') });
  await page.getByRole('button', { name: 'Watch room', exact: true }).click();
  let inventory;
  const sourceDeadline = Date.now() + 90_000;
  do {
    const response = await page.request.get(new URL('/api/sources', page.url()).href);
    assert.equal(response.status(), 200);
    inventory = await response.json();
    const listed = inventory.games.filter(row => /^(ufc|boxing)-/.test(row.gameId) && row.sourceLinks.length);
    if (listed.length && listed.every(row => row.sourceLinks.every(link => link.evidence.kind !== 'pending'))) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  } while (Date.now() < sourceDeadline);
  await writeFile(path.join(output, 'live-sources.json'), JSON.stringify(inventory, null, 2));
  const sourceGames = inventory.games.filter(row => /^(ufc|boxing)-/.test(row.gameId));
  assert.ok(sourceGames.some(row => row.sourceLinks.length > 0), 'Existing providers must publish links matched to real combat cards');
  assert.ok(sourceGames.every(row => row.sourceLinks.every(link => link.evidence.kind !== 'pending')),
    'Matched combat listings must complete their source detail checks');
  await page.screenshot({ path: path.join(output, 'electron-combat-room.png') });
  await page.getByRole('button', { name: 'Room settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  for (const label of ['UFC', 'Boxing']) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    assert.ok(await page.getByText(new RegExp(`Showing \\d+ of \\d+ ${label} sources`)).isVisible());
  }
  await page.screenshot({ path: path.join(output, 'electron-combat-sources.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const mediaPath = path.join(output, 'combat-player-fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  await desktop.context().route('http://localhost:9999/combat.mp4', route => route.fulfill({ body: media, contentType: 'video/mp4' }));
  await page.getByRole('button', { name: `Feed settings for ${ufc.name}`, exact: true }).click();
  await page.getByLabel('Feed name', { exact: true }).fill('Combat player check');
  await page.getByLabel('Video URL', { exact: true }).fill('http://localhost:9999/combat.mp4');
  await page.getByRole('button', { name: 'Connect feed', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video =>
    video.videoWidth === 640 && video.currentTime > 0), null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(output, 'electron-combat-player.png') });
  await page.reload();
  for (const game of [ufc, boxing]) {
    await page.getByRole('button', { name: `Remove ${game.name}`, exact: true }).waitFor();
  }
  assert.deepEqual(failures, [], 'The Electron renderer must have no uncaught errors');
  const result = {
    runtime: process.argv.includes('--compiled') ? 'compiled' : 'development',
    cards: combatGames.map(game => ({ id: game.id, league: game.league, name: game.name, status: game.status })),
    sourceLinks: sourceGames.reduce((sum, row) => sum + row.sourceLinks.length, 0),
    candidates: sourceGames.reduce((sum, row) => sum + row.candidates.length, 0),
    decodedCandidates: sourceGames.reduce((sum, row) => sum + row.candidates.filter(candidate => candidate.availability.kind === 'playable').length, 0),
    sourceEvidence: sourceGames.flatMap(row => row.sourceLinks.map(link => ({
      gameId: row.gameId, sourceId: link.sourceId, evidence: link.evidence,
    }))),
    checks: ['live UFC schedule', 'live source-backed Boxing schedule', 'Combat Sports filters room and schedule',
      'card search', 'football controls hidden', 'add both sports', 'real matched source links', 'UFC and Boxing source tabs',
      'local test video decodes in a real combat playback session', 'room persists after reload'],
  };
  await writeFile(path.join(output, 'electron-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'electron-failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'electron-runtime.log'), runtimeLogs).catch(() => {});
  await desktop?.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-combat-/);
  await rm(profile, { recursive: true, force: true });
}
