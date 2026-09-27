import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const unpackedPath = path.resolve('dist-electron/win-unpacked');
assert.ok(existsSync(path.join(unpackedPath, 'Sunday Room.exe')), `Missing packaged app: ${unpackedPath}`);

const scratch = await mkdtemp(path.join(tmpdir(), 'sunday-room-packaged-'));
const appPath = path.join(scratch, 'app');
const executablePath = path.join(appPath, 'Sunday Room.exe');
let desktop;
let origin;
let passed = false;
try {
  await cp(unpackedPath, appPath, { recursive: true });
  assert.ok(existsSync(path.join(appPath, 'resources/server/node_modules/next/package.json')), 'Traced Next.js dependency is absent from packaged resources');
  desktop = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(scratch, 'profile')}`],
    cwd: scratch,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  const page = await desktop.firstWindow({ timeout: 90_000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  await page.getByRole('button', { name: 'Watch room' }).waitFor();
  assert.match(await page.title(), /Sunday Room/);
  assert.equal(await page.evaluate(() => typeof window.sundayDesktop), 'object');
  const runtime = await desktop.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }));
  assert.equal(runtime.packaged, true);
  assert.equal(path.normalize(runtime.resourcesPath), path.normalize(path.join(path.dirname(executablePath), 'resources')));

  origin = new URL(page.url()).origin;
  const staticAsset = await page.locator('script[src^="/_next/static/"]').first().getAttribute('src');
  assert.ok(staticAsset, 'No Next static script was loaded');
  const staticResponse = await page.request.get(new URL(staticAsset, origin).href);
  assert.equal(staticResponse.status(), 200);
  const faviconResponse = await page.request.get(`${origin}/favicon.svg`);
  assert.equal(faviconResponse.status(), 200);

  const gamesResponse = await page.request.get(`${origin}/api/games`);
  assert.equal(gamesResponse.status(), 200);
  const apiResponse = await page.request.post(`${origin}/api/playback`, { data: { kind: 'open', gameId: '' } });
  assert.equal(apiResponse.status(), 400);
  assert.deepEqual(await apiResponse.json(), { error: 'Invalid playback request.' });
  await mkdir(path.resolve('work/electron-release'), { recursive: true });
  await page.screenshot({ path: path.resolve('work/electron-release/packaged-smoke.png') });
  console.log(`Packaged app served its window, preload, static asset, and API from ${origin}`);
  passed = true;
} finally {
  if (desktop) await desktop.close();
  if (origin) {
    let stopped = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await fetch(origin, { signal: AbortSignal.timeout(500) }); }
      catch { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(stopped, 'Local server remained open after the desktop app closed');
  }
  if (passed) await rm(scratch, { recursive: true, force: true });
  else console.error(`Packaged app profile retained at ${scratch}`);
}
