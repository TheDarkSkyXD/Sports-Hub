import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.scratch', 'wrestling');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-wrestling-'));
const expectedSources = ['livesportpro', 'ppv', 'streamed'];
const failures = [];
const checks = [];
const startedAt = new Date().toISOString();
let runtimeLogs = '';
let desktop;
let electronProcess;
let electronProcessId;
let page;

function checked(label) {
  checks.push(label);
}

async function logTail(name) {
  const file = await open(path.join(root, '.desktop-runtime', name), 'r').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return null;
  try {
    const stat = await file.stat();
    const size = Math.min(stat.size, 16_000);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, stat.size - size);
    return { modifiedAt: stat.mtime.toISOString(), tail: buffer.toString('utf8', 0, bytesRead) };
  } finally {
    await file.close();
  }
}

try {
  await mkdir(output, { recursive: true });
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), ...(process.argv.includes('--compiled') ? [] : ['--dev']), `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  electronProcess = desktop.process();
  electronProcessId = electronProcess.pid;
  for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
    stream?.on('data', chunk => { runtimeLogs = (runtimeLogs + chunk.toString()).slice(-200_000); });
  }
  const windowDeadline = Date.now() + 90_000;
  while (!page && Date.now() < windowDeadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The Electron window must open');
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
    if (board.scheduleState === 'ready' && board.leagues.wwe?.scoresAt && board.leagues.tna?.scoresAt &&
      board.games.some(game => game.league === 'wwe' && /WWE Friday Night Smackdown/i.test(game.name))) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  } while (Date.now() < scheduleDeadline);
  await writeFile(path.join(output, 'live-board.json'), JSON.stringify(board, null, 2));
  assert.equal(board.scheduleState, 'ready', 'The live schedule must finish loading');
  assert.ok(board.leagues.wwe?.scoresAt, 'The WWE schedule must load');
  assert.ok(board.leagues.tna?.scoresAt, 'The TNA schedule must load, even without a current event');
  const smackdown = board.games.find(game => game.league === 'wwe' && /WWE Friday Night Smackdown/i.test(game.name));
  assert.ok(smackdown, 'The real SmackDown event must be on the board');
  assert.match(smackdown.id, /^wwe-\d+$/);
  assert.equal(smackdown.date, '2026-10-10T00:00:00.000Z');
  assert.ok(smackdown.wrestling?.eventId);
  assert.ok(!('home' in smackdown) && !('away' in smackdown), 'The event must have no invented teams');
  assert.equal(board.games.filter(game => game.id === smackdown.id).length, 1, 'Providers must merge into one SmackDown card');
  checked('real dated teamless SmackDown schedule');

  await page.getByRole('button', { name: 'Wrestling', exact: true }).click();
  await page.waitForFunction(id => [...document.querySelectorAll('.center-game')].some(card => card.dataset.gameId === id), smackdown.id);
  assert.ok((await page.locator('.center-game').evaluateAll(cards => cards.map(card => card.dataset.gameId)))
    .every(id => /^(wwe|tna)-/.test(id)));
  assert.equal(await page.getByRole('tab', { name: 'Red zone games' }).count(), 0);
  assert.equal(await page.locator('#smart-focus').count(), 0);
  await page.locator('#game-search').fill(smackdown.name);
  await page.waitForFunction(id => {
    const cards = [...document.querySelectorAll('.center-game')];
    return cards.length === 1 && cards[0].dataset.gameId === id;
  }, smackdown.id);
  checked('Wrestling room filter, search, and hidden football controls');

  await page.locator('#game-search').fill('');
  while (await page.locator('.game-grid button[aria-label^="Remove "]').count()) {
    await page.locator('.game-grid button[aria-label^="Remove "]').first().click();
  }
  await page.locator(`.center-game[data-game-id="${smackdown.id}"]`).getByRole('button', { name: /Add (game|event|card)/ }).click();
  await page.getByRole('button', { name: `Remove ${smackdown.name}`, exact: true }).waitFor();
  assert.equal(await page.locator('.game-grid .team-badge').count(), 0);
  await page.screenshot({ path: path.join(output, 'electron-wrestling-room.png') });
  await page.reload();
  await page.getByRole('button', { name: `Remove ${smackdown.name}`, exact: true }).waitFor();
  await page.getByRole('button', { name: `Remove ${smackdown.name}`, exact: true }).click();
  await page.getByRole('button', { name: `Remove ${smackdown.name}`, exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Wrestling', exact: true }).click();
  await page.locator(`.center-game[data-game-id="${smackdown.id}"]`).getByRole('button', { name: /Add (game|event|card)/ }).click();
  await page.getByRole('button', { name: `Remove ${smackdown.name}`, exact: true }).waitFor();
  checked('add, persisted reload, remove, and re-add');

  await page.getByRole('button', { name: 'Game schedule', exact: true }).click();
  await page.locator('.schedule-card').first().waitFor();
  const scheduleLabels = await page.locator('.schedule-card .league-tag').allTextContents();
  assert.ok(scheduleLabels.includes('WWE'));
  assert.ok(scheduleLabels.every(label => label === 'WWE' || label === 'TNA'));
  assert.equal(await page.locator('.schedule-matchup').count(), 0);
  assert.ok(await page.locator('.schedule-card').filter({ hasText: smackdown.name }).isVisible());
  await page.screenshot({ path: path.join(output, 'electron-wrestling-schedule.png') });
  await page.getByRole('button', { name: 'Motorsports', exact: true }).click();
  await page.locator('.schedule-card').first().waitFor();
  const motorsportLabels = await page.locator('.schedule-card .league-tag').allTextContents();
  assert.ok(motorsportLabels.length > 0);
  assert.ok(motorsportLabels.every(label => !['WWE', 'TNA'].includes(label)));
  checked('Wrestling and Motorsports schedule isolation');

  await page.getByRole('button', { name: 'Watch room', exact: true }).click();
  await page.getByRole('button', { name: 'Motorsports', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.center-game').length > 0 &&
    [...document.querySelectorAll('.center-game')].every(card =>
      /^(f1|nascar-cup|nascar-truck|motogp|motorsport)-/.test(card.dataset.gameId)));
  checked('Motorsports room isolation');
  await page.getByRole('button', { name: 'Wrestling', exact: true }).click();
  await page.waitForFunction(id => {
    const cards = [...document.querySelectorAll('.center-game')];
    return cards.some(card => card.dataset.gameId === id) &&
      cards.every(card => /^(wwe|tna)-/.test(card.dataset.gameId));
  }, smackdown.id);
  await page.getByRole('button', { name: `Remove ${smackdown.name}`, exact: true }).waitFor();
  checked('SmackDown remains discoverable under Wrestling after switching sports');

  let inventory;
  let sourceGame;
  const sourceDeadline = Date.now() + 120_000;
  do {
    const response = await page.request.get(new URL('/api/sources', page.url()).href);
    assert.equal(response.status(), 200);
    inventory = await response.json();
    sourceGame = inventory.games.find(row => row.gameId === smackdown.id);
    if (sourceGame && expectedSources.every(id => sourceGame.sourceLinks.some(link =>
      link.sourceId === id && link.evidence.kind === 'collected' && link.evidence.candidateIds.length))) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  } while (Date.now() < sourceDeadline);
  await writeFile(path.join(output, 'live-sources.json'), JSON.stringify(inventory, null, 2));
  assert.ok(sourceGame, 'The inventory must include the real SmackDown card');
  assert.deepEqual(sourceGame.sourceLinks.map(link => link.sourceId).sort(), expectedSources,
    'Streamed, LiveSportPro, and PPV must each map exactly one listing to SmackDown');
  for (const link of sourceGame.sourceLinks) {
    assert.match(link.title, /WWE Friday Night Smackdown/i);
    assert.equal(link.evidence.kind, 'collected', `${link.sourceId} detail must resolve`);
    assert.ok(link.evidence.candidateIds.length, `${link.sourceId} detail must name a candidate`);
    assert.ok(sourceGame.candidates.some(candidate => candidate.sourceIds.includes(link.sourceId)),
      `${link.sourceId} must have a real resolved candidate`);
  }
  checked('three exact live source links and resolved candidate records');

  await page.getByRole('button', { name: 'Room settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  for (const label of ['TNA', 'WWE']) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    assert.ok(await page.getByText(new RegExp(`Showing \\d+ of \\d+ ${label} sources`)).isVisible());
    assert.ok(inventory.sources.some(source => source.leagues.includes(label.toLowerCase())),
      `${label} must have an inventory source scope`);
    await page.screenshot({ path: path.join(output, `electron-wrestling-sources-${label.toLowerCase()}.png`) });
  }
  await page.screenshot({ path: path.join(output, 'electron-wrestling-sources.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  checked('WWE and TNA source settings scopes');

  const mediaPath = path.join(output, 'wrestling-player-LOCAL-fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  await desktop.context().route('http://localhost:9999/wrestling-LOCAL-fixture.mp4', route =>
    route.fulfill({ body: media, contentType: 'video/mp4' }));
  await page.getByRole('button', { name: `Feed settings for ${smackdown.name}`, exact: true }).click();
  await page.getByLabel('Feed name', { exact: true }).fill('LOCAL wrestling video fixture');
  await page.getByLabel('Video URL', { exact: true }).fill('http://localhost:9999/wrestling-LOCAL-fixture.mp4');
  await page.getByRole('button', { name: 'Connect feed', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video =>
    video.videoWidth === 640 && video.currentTime > 0), null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(output, 'electron-wrestling-player-LOCAL-fixture.png') });
  checked('local fixture decodes in the real SmackDown room card');

  assert.deepEqual(failures, [], 'The Electron renderer must have no uncaught errors');
  checked('no uncaught renderer errors');
  const result = {
    runtime: process.argv.includes('--compiled') ? 'compiled' : 'development',
    event: { id: smackdown.id, name: smackdown.name, date: smackdown.date, league: smackdown.league },
    sourceLinks: sourceGame.sourceLinks.map(link => ({ sourceId: link.sourceId, title: link.title, url: link.url, evidence: link.evidence })),
    candidates: sourceGame.candidates.filter(candidate => candidate.sourceIds.some(id => expectedSources.includes(id))),
    media: 'LOCAL fixture only; external providers were inspected through their resolved candidate records',
    checks,
    rendererErrors: failures,
  };
  await writeFile(path.join(output, 'electron-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'electron-failure.png') }).catch(() => {});
  let windowUrls;
  try { windowUrls = desktop?.windows().map(window => window.url()) ?? []; }
  catch (windowError) { windowUrls = [`Unavailable: ${windowError}`]; }
  const diagnostics = {
    startedAt,
    windowUrls,
    processId: electronProcessId ?? null,
    processExitCode: electronProcess?.exitCode ?? null,
    processSignal: electronProcess?.signalCode ?? null,
    startupLog: await logTail('startup.log').catch(logError => ({ error: String(logError) })),
    serverLog: await logTail('server.log').catch(logError => ({ error: String(logError) })),
  };
  await writeFile(path.join(output, 'electron-result.json'), JSON.stringify({
    runtime: process.argv.includes('--compiled') ? 'compiled' : 'development',
    error: error instanceof Error ? error.stack : String(error),
    checks,
    rendererErrors: failures,
    diagnostics,
  }, null, 2)).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'electron-runtime.log'), runtimeLogs).catch(() => {});
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-wrestling-/);
  await rm(profile, { recursive: true, force: true });
}
