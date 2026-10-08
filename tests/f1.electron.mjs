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
const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null;
const output = path.join(root, '.scratch', 'f1');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-f1-'));
const failures = [];
let desktop;
let page;

async function pollApi(endpoint, accepts, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let data;
  do {
    const response = await page.request.get(new URL(endpoint, page.url()).href);
    assert.equal(response.status(), 200, `${endpoint} must respond successfully`);
    data = await response.json();
    if (accepts(data)) return data;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  await writeFile(path.join(output, `${endpoint.replaceAll('/', '-')}-failure.json`), JSON.stringify(data, null, 2));
  throw new Error(`${endpoint} did not satisfy its live F1 check. ${JSON.stringify(data?.games?.filter(game => game.gameId?.startsWith('f1-')) ?? data).slice(0,2000)}`);
}

try {
  await mkdir(output, { recursive: true });
  desktop = await electron.launch({
    executablePath: packagedExecutable ?? await prepareDevelopmentElectron(),
    args: [...(packagedExecutable ? [] : [path.join(root, 'desktop/main.cjs')]), `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), Boolean(packagedExecutable));
  const deadline = Date.now() + 90_000;
  while (!page && Date.now() < deadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The native Electron room window must open');
  page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('button', { name: 'Watch room', exact: true }).waitFor();
  const window = await desktop.browserWindow(page);
  await window.evaluate(native => {
    native.setContentSize(1500, 1000);
    native.webContents.setAudioMuted(true);
    native.showInactive();
  });
  await window.dispose();

  const series = ['f1', 'nascar-cup', 'nascar-truck', 'motogp', 'motorsport'];
  const board = await pollApi('/api/games', data => data.scheduleState === 'ready' &&
    data.leagues.f1?.scoresAt && series.every(league => data.games.some(game => game.league === league)));
  const allRaces = board.games.filter(game => series.includes(game.league));
  const races = allRaces.filter(game => game.league === 'f1');
  for (const league of series) assert.ok(allRaces.some(game => game.league === league), `The real board must contain ${league} events`);
  assert.ok(allRaces.every(game => !game.home && !game.away && !game.redzone && !game.down && !game.possession));
  assert.equal(new Set(races.map(game => game.id)).size, races.length, 'F1 session IDs must be unique');
  await page.getByRole('button', { name: 'Motorsports', exact: true }).click();
  await page.waitForFunction(series => {
    const cards = [...document.querySelectorAll('.center-game')];
    return series.every(league => cards.some(card => card.dataset.gameId.startsWith(`${league}-`))) &&
      cards.every(card => /^(?:f1|nascar-cup|nascar-truck|motogp|motorsport)-/.test(card.dataset.gameId));
  }, series, { timeout: 60_000 });
  for (const league of series) assert.ok(await page.locator(`.center-game[data-game-id^="${league}-"]`).count() > 0, `${league} must appear under Motorsports`);
  for (const logo of ['f1.png', 'nascar-cup.png', 'nascar-truck.png', 'motogp.png', 'motorsport.svg']) {
    const image = page.locator(`.center-game img[src$="/series-logos/${logo}"]`).first();
    await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(logo => [...document.querySelectorAll('.center-game img')].some(image =>
      image.getAttribute('src').endsWith(logo) && image.complete && image.naturalWidth > 0), logo);
  }
  assert.equal(await page.getByRole('tab', { name: 'Red zone games' }).count(), 0);
  assert.equal(await page.locator('#smart-focus').count(), 0);
  assert.equal(await page.locator('.center-game .center-team').count(), 0, 'Race cards must have no opposing teams');
  await page.screenshot({ path: path.join(output, 'electron-motorsports-room.png') });

  await page.getByRole('button', { name: 'Game schedule', exact: true }).click();
  await page.locator('.schedule-card').first().waitFor();
  const labels = await page.locator('.schedule-card .league-tag').allTextContents();
  assert.ok(labels.length > 0 && labels.every(label => ['F1', 'NASCAR Cup', 'NASCAR Trucks', 'MotoGP', 'Motorsport'].includes(label)));
  assert.equal(await page.locator('.schedule-card .team-badge').count(), 0, 'Race schedules must have no opposing team badges');
  await page.screenshot({ path: path.join(output, 'electron-motorsports-schedule.png') });

  const sourceIds = ['ppv', 'methstreams-f1', 'crackstreams-f1'];
  const inventory = await pollApi('/api/sources', data => sourceIds.every(sourceId =>
    data.sources.some(source => source.id === sourceId && source.lastAttempt)));
  const listed = inventory.games.filter(row => races.some(game => game.id === row.gameId));
  const sourceAttempts = inventory.sources.filter(source => sourceIds.includes(source.id)).map(source =>
    ({ id: source.id, ...source.lastAttempt }));
  assert.ok(listed.some(row => row.sourceLinks.length > 0) || sourceAttempts.every(attempt => attempt.outcome === 'failed'),
    'Published F1 links must match, or every unavailable provider must report its failure');
  for (const sourceId of sourceIds) {
    assert.ok(inventory.sources.some(source => source.id === sourceId), `${sourceId} must be registered`);
  }
  if (inventory.sources.find(source => source.id === 'ppv').lastAttempt.outcome === 'parsed') {
    for (const race of races) {
      const row = listed.find(game => game.gameId === race.id);
      assert.ok(row?.sourceLinks.some(link => link.sourceId === 'ppv'), `${race.name} must match its published PPV session`);
    }
  }

  await page.getByRole('button', { name: 'Room settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  await page.getByRole('tab', { name: 'F1', exact: true }).click();
  await page.getByText(/Showing \d+ of \d+ F1 sources/).waitFor();
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await page.getByRole('region', { name: 'F1 games with listed sources', exact: true }).or(
    page.getByText('No F1 games currently have matched source links.', { exact: true })).waitFor();
  await page.screenshot({ path: path.join(output, 'electron-motorsports-sources.png') });
  for (const label of ['NASCAR Cup', 'NASCAR Trucks', 'MotoGP', 'Motorsport']) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    await page.getByRole('region', { name: `${label} games with listed sources`, exact: true }).or(
      page.getByText(`No ${label} games currently have matched source links.`, { exact: true })).waitFor();
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Watch room', exact: true }).click();
  const race = races.find(game => game.lifecycle === 'live') ?? races.find(game => game.lifecycle === 'scheduled');
  assert.ok(race, 'A real upcoming F1 session must be available to add');
  const occupied = page.locator('.tile-actions button[aria-label^="Remove "]');
  if (await occupied.count() === 4) await occupied.first().click();
  await page.locator(`.center-game[data-game-id="${race.id}"]`).getByRole('button', { name: 'Add game', exact: true }).click();
  await page.getByRole('button', { name: `Remove ${race.name}`, exact: true }).waitFor();

  const mediaPath = path.join(output, 'f1-player-check.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-movflags', '+faststart', mediaPath], { windowsHide: true });
  const media = await readFile(mediaPath);
  await desktop.context().route('http://localhost:9999/f1.mp4', route => route.fulfill({ body: media, contentType: 'video/mp4' }));
  await page.getByRole('button', { name: `Feed settings for ${race.name}`, exact: true }).click();
  await page.getByLabel('Feed name', { exact: true }).fill('F1 player check');
  await page.getByLabel('Video URL', { exact: true }).fill('http://localhost:9999/f1.mp4');
  await page.getByRole('button', { name: 'Connect feed', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.videoWidth === 640 && video.currentTime > 0), null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(output, 'electron-motorsports-player.png') });
  await page.reload();
  await page.getByRole('button', { name: `Remove ${race.name}`, exact: true }).waitFor();
  assert.deepEqual(failures, [], 'The Electron renderer must have no uncaught errors');
  const result = {
    packaged: Boolean(packagedExecutable),
    seriesCounts: Object.fromEntries(series.map(league => [league, allRaces.filter(game => game.league === league).length])),
    linkedSeriesCounts: Object.fromEntries(series.map(league => [league, inventory.games.filter(row =>
      row.sourceLinks.length > 0 && allRaces.some(game => game.league === league && game.id === row.gameId)).length])),
    sourceAttempts,
    liveSourceVerification: listed.some(row => row.sourceLinks.length > 0) ? 'published F1 links observed' : 'inconclusive: all three providers failed',
    sessions: races.map(game => ({ id: game.id, name: game.name, date: game.date,
      links: listed.find(row => row.gameId === game.id)?.sourceLinks.map(link => ({ source: link.sourceId, url: link.url })) })),
    scoresAt: board.leagues.f1.scoresAt,
    candidateCount: listed.reduce((total, row) => total + row.candidates.length, 0),
    checks: ['real ESPN F1 sessions', 'Motorsports room and schedule filters', 'race cards without team scores',
      'source inventory for all five series and reported provider outcomes', 'add race session',
      'local video decodes in native Electron', 'race selection persists after reload'],
    remotePlayback: 'Upcoming session links checked. Remote live broadcast decoding is unverified.',
  };
  await writeFile(path.join(output, 'electron-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'electron-failure.png') }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-f1-/);
  await rm(profile, { recursive: true, force: true });
}
