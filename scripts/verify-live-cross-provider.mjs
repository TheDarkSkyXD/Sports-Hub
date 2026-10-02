import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from './electron-runtime.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = path.resolve('work/cross-provider-electron');
await mkdir(directory, { recursive: true });
const gameId = process.argv[2] || process.env.VERIFY_GAME_ID;
assert(gameId && /^ncaaf-\d+$/.test(gameId), 'Pass a current college game ID, for example node scripts/verify-live-cross-provider.mjs ncaaf-401856699');
const result = { at: new Date().toISOString(), gameId, mode: 'Real Electron, local production routes, live upstream media', sessions: [], playback: [], revoked: [] };
const roots = new Map();
const families = new Set();
let app;
let current;
let page;
const family = id => id.startsWith('streamcenter') ? 'streamcenter' : id.startsWith('gooz') ? 'gooz' : id.split('-')[0];

try {
  app = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.resolve('desktop/main.cjs'), `--user-data-dir=${path.join(directory, 'profile')}`],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 120000,
  });
  page = await app.firstWindow({ timeout: 120000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 120000 });
  result.origin = new URL(page.url()).origin;
  result.electron = await app.evaluate(() => process.versions.electron);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/index.m3u8')) roots.set(`${url.searchParams.get('candidate')}:${url.searchParams.get('generation')}`, url.href);
  });
  page.on('response', async response => {
    try {
      if (new URL(response.url()).pathname !== '/api/playback' || response.request().method() === 'DELETE') return;
      const body = await response.json();
      if (body.session?.gameId !== gameId) return;
      current = body;
      const command = response.request().postDataJSON();
      const entry = { candidate: body.session.candidateId, generation: body.session.generation, requestedCandidate: command.candidateId, failure: command.failure };
      result.sessions.push(entry);
      console.log(JSON.stringify({ stage: 'session', ...entry }));
    } catch {}
  });
  let game;
  for (let attempt = 0; attempt < 60; attempt++) {
    const board = await (await page.request.get(`${result.origin}/api/games`)).json();
    game = board.games.find(value => value.id === gameId);
    if (game?.sourceUrl || game?.lifecycle === 'final') break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert(game, 'The requested game exists on the current ESPN board');
  assert.notEqual(game.lifecycle, 'final', 'Live playback verification requires a nonfinal game');
  result.game = { name: game.name, lifecycle: game.lifecycle, date: game.date };
  for (const button of (await page.locator('.game-tile').getByRole('button', { name: /^Remove / }).all()).reverse()) await button.click();
  const opened = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/playback' && response.request().method() === 'POST' && response.status() === 200 && (await response.json()).session.gameId === gameId, { timeout: 90000 });
  await page.getByTitle(`Add ${game.name}`, { exact: true }).click();
  current = await (await opened).json();
  const tile = page.locator('.game-tile').filter({ has: page.getByRole('button', { name: `Remove ${game.name}`, exact: true }) });
  await tile.locator('video').waitFor({ timeout: 120000 });
  const discoveryStarted = Date.now();
  while (!current.candidates.some(candidate => family(candidate.id) === 'streamcenter')) {
    assert(Date.now() - discoveryStarted < 360000, 'Automatic discovery supplies the second provider within six minutes');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  result.discoveryWaitMs = Date.now() - discoveryStarted;
  console.log(JSON.stringify({ stage: 'providers-discovered', candidates: current.candidates.map(candidate => candidate.id), waitedMs: result.discoveryWaitMs }));
  const snapshot = () => tile.locator('video').evaluate(video => ({ label: video.getAttribute('aria-label'), src: video.getAttribute('src'), time: video.currentTime, ready: video.readyState, width: video.videoWidth, height: video.videoHeight, paused: video.paused }));
  for (let attempt = 0; attempt < 12 && families.size < 2; attempt++) {
    assert(current, 'The UI received a real playback session');
    const selected = { ...current.session };
    const label = current.candidates.find(candidate => candidate.id === selected.candidateId)?.label;
    try {
      await page.waitForFunction(label => {
        const video = document.querySelector('.game-tile video');
        return video?.getAttribute('aria-label') === label && video.readyState >= 2 && video.videoWidth > 0 && !video.paused && video.currentTime > 2;
      }, label, { timeout: 45000 });
      assert.equal(current.session.candidateId, selected.candidateId);
      assert.equal(current.session.generation, selected.generation);
      const before = await snapshot();
      await page.waitForFunction(({ label, time }) => {
        const video = document.querySelector('.game-tile video');
        return video?.getAttribute('aria-label') === label && video.currentTime > time + 3;
      }, { label, time: before.time }, { timeout: 15000 });
      assert.equal(current.session.candidateId, selected.candidateId);
      assert.equal(current.session.generation, selected.generation);
      const after = await snapshot();
      const provider = family(selected.candidateId);
      assert(roots.has(`${selected.candidateId}:${selected.generation}`), 'Decoded video correlates with the selected generation manifest');
      result.playback.push({ provider, candidate: selected.candidateId, generation: selected.generation, before, after });
      families.add(provider);
      await page.screenshot({ path: path.join(directory, `${provider}-${selected.generation}.png`) });
      console.log(JSON.stringify({ stage: 'decoded', provider, candidate: selected.candidateId, generation: selected.generation, before: before.time, after: after.time }));
    } catch (error) {
      result.playback.push({ candidate: selected.candidateId, generation: selected.generation, error: error.message });
    }
    if (families.size >= 2) break;
    const previous = { ...current.session };
    const index = current.candidates.findIndex(candidate => candidate.id === previous.candidateId);
    const next = current.candidates[(index + 1) % current.candidates.length];
    assert(next && next.id !== previous.candidateId, 'At least two candidate servers exist');
    const changed = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== '/api/playback' || response.request().method() !== 'PATCH' || response.status() !== 200) return false;
      return response.request().postDataJSON().candidateId === next.id && (await response.json()).session.candidateId === next.id;
    }, { timeout: 30000 });
    await tile.getByRole('button', { name: 'Switch server', exact: true }).click();
    const body = await (await changed).json();
    current = body;
    assert(body.session.generation > previous.generation);
    const oldRoot = roots.get(`${previous.candidateId}:${previous.generation}`);
    if (oldRoot) {
      const response = await page.request.get(oldRoot);
      result.revoked.push({ candidate: previous.candidateId, generation: previous.generation, status: response.status() });
      assert.equal(response.status(), 410, 'Switching revokes the previous generation');
    }
  }
  assert(families.has('gooz') && families.has('streamcenter'), 'Both provider families decoded advancing video in the custom player');
  {
    const failureStart = result.sessions.length;
    const failing = { ...current.session };
    const failingProvider = family(failing.candidateId);
    const alternatives = current.candidates.filter(candidate => family(candidate.id) !== failingProvider).map(candidate => candidate.label);
    await page.route('**/api/stream/**', route => family(current.session.candidateId) === failingProvider ? route.abort('failed') : route.continue());
    await page.waitForFunction(labels => {
      const video = document.querySelector('.game-tile video');
      return video && labels.includes(video.getAttribute('aria-label')) && video.readyState >= 2 && video.videoWidth > 0 && !video.paused && video.currentTime > 2;
    }, alternatives, { timeout: 150000 });
    assert.notEqual(family(current.session.candidateId), failingProvider);
    const recovered = { ...current.session };
    const before = await snapshot();
    await page.waitForFunction(({ label, time }) => {
      const video = document.querySelector('.game-tile video');
      return video?.getAttribute('aria-label') === label && video.currentTime > time + 3;
    }, { label: before.label, time: before.time }, { timeout: 15000 });
    assert.equal(current.session.candidateId, recovered.candidateId);
    assert.equal(current.session.generation, recovered.generation);
    const recovery = result.sessions.slice(failureStart).filter(entry => entry.failure);
    assert(recovery.some(entry => entry.candidate === failing.candidateId && entry.generation > failing.generation), 'Automatic recovery refreshes the current provider first');
    assert(recovery.some(entry => family(entry.candidate) !== failingProvider), 'Automatic recovery advances to another provider');
    result.automaticRecovery = { stimulus: `Controlled request failure for ${failingProvider} local media routes; no mocked media or API responses`, from: failing.candidateId, to: recovered.candidateId, before, after: await snapshot(), sessions: recovery };
    await page.unrouteAll({ behavior: 'wait' });
    await page.screenshot({ path: path.join(directory, 'automatic-recovery.png') });
    console.log(JSON.stringify({ stage: 'automatic-recovery', from: failing.candidateId, to: recovered.candidateId }));
  }
  const last = { ...current.session };
  const closed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/playback' && response.request().method() === 'DELETE' && response.status() === 204);
  await tile.getByRole('button', { name: `Remove ${game.name}`, exact: true }).click();
  await closed;
  const lastRoot = roots.get(`${last.candidateId}:${last.generation}`);
  assert(lastRoot);
  result.removalStatus = (await page.request.get(lastRoot)).status();
  assert.equal(result.removalStatus, 410, 'Removing the tile revokes its media access');
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.error = error.message;
  console.log(JSON.stringify({ stage: 'failed', error: error.message }));
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  if (app) await app.close();
}
if (!result.pass) process.exitCode = 1;
