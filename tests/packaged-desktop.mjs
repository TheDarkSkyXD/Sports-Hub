import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { extractFile, listPackage } from '@electron/asar';
import { assertDesktopBranding } from './desktop-branding.mjs';

const unpackedPath = path.resolve(process.argv[2] ?? 'dist-electron/win-unpacked');
assert.ok(existsSync(path.join(unpackedPath, 'Sunday Room.exe')), `Missing packaged app: ${unpackedPath}`);
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const packagedVersion = JSON.parse(extractFile(path.join(unpackedPath, 'resources/app.asar'), 'package.json').toString()).version;
assert.equal(packagedVersion, expectedVersion, 'Packaged app is stale. Rebuild it before verification.');
const serverVersion = JSON.parse(await readFile(path.join(unpackedPath, 'resources/server/package.json'), 'utf8')).version;
assert.equal(serverVersion, expectedVersion, 'Packaged server is stale. Rebuild it before verification.');

const scratch = await mkdtemp(path.join(tmpdir(), 'sunday-room-packaged-'));
const appPath = path.join(scratch, 'app');
const executablePath = path.join(appPath, 'Sunday Room.exe');
let desktop;
let origin;
let passed = false;
try {
  await cp(unpackedPath, appPath, { recursive: true, dereference: true });
  assert.ok(existsSync(path.join(appPath, 'resources/server/node_modules/next/package.json')), 'Traced Next.js dependency is absent from packaged resources');
  assert.ok(!existsSync(path.join(appPath, 'resources/server/dist-electron')),
    'Packaged server resources must not embed a previous build output');
  assert.ok(!existsSync(path.join(appPath, 'resources/server/work')),
    'Packaged server resources must not embed local verification scratch');
  assert.ok(!existsSync(path.join(appPath, 'resources/server/.desktop-runtime')),
    'Packaged server resources must not embed the development Electron runtime');

  // electron-updater is a runtime dependency loaded at startup. A build that packaged
  // without it opened a window titled "Error" and served nothing, which the assertions
  // below could only report as a bare timeout. Checking the asar first turns that into a
  // message naming the module that is missing.
  const packaged = new Set(
    listPackage(path.join(unpackedPath, 'resources', 'app.asar'))
      .map(entry => String(entry).replace(/\\/g, '/').replace(/^\//, '')),
  );
  for (const dependency of [
    'electron-updater/out/main.js',
    'builder-util-runtime/out/httpExecutor.js',
    'builder-util-runtime/out/xml.js',
    'fs-extra/lib/index.js',
    'graceful-fs/graceful-fs.js',
    'jsonfile/index.js',
    'universalify/index.js',
    'lodash.escaperegexp/index.js',
    'js-yaml/index.js',
    'lazy-val/out/main.js',
    'lodash.isequal/index.js',
    'semver/functions/lt.js',
    'debug/src/index.js',
    'ms/index.js',
    'sax/lib/sax.js',
  ]) {
    assert.ok(packaged.has(`node_modules/${dependency}`),
      `${dependency} is loaded at startup and must be packaged. electron-updater walks its own dependency graph from a production dependency, so do not hand-list these in electron-builder.yml.`);
  }

  desktop = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(scratch, 'profile')}`],
    cwd: scratch,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  const windowDeadline = Date.now() + 90_000;
  let page;
  while (!page && Date.now() < windowDeadline) {
    page = desktop.windows().find(candidate => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(candidate.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'Packaged app window did not reach its loopback origin');
  await page.getByRole('button', { name: 'Watch room' }).waitFor();
  assert.match(await page.title(), /Sunday Room/);
  assert.equal(await page.evaluate(() => typeof window.sundayDesktop), 'object');
  // The bridge handshake. This file is plain node and cannot import the zod schema, so
  // the assertion is structural: a nine-tag state and a command array.
  assert.equal(await page.evaluate(() => typeof window.sundayDesktop.subscribe), 'function');
  const updateStatus = await page.evaluate(() => window.sundayDesktop.get());
  assert.ok(updateStatus && typeof updateStatus === 'object');
  assert.ok(['unsupported', 'idle', 'checking', 'current', 'available', 'downloading', 'ready', 'installing', 'failed']
    .includes(updateStatus.state.kind), `Unexpected update state: ${updateStatus.state.kind}`);
  assert.ok(Array.isArray(updateStatus.commands), 'commands must be an array');
  assert.ok(updateStatus.commands.every(command => ['check', 'download', 'install'].includes(command)),
  'the packaged app must not offer a cancel it cannot honour');

// electron-updater is a runtime dependency loaded at startup, and a build that packaged
// without it produced an app that opened a window titled "Error" and served nothing.
// `files` in electron-builder.yml lists its load graph by hand, so this requires it from
// inside the packaged main process, which is the only place the failure shows up.
// electron-updater is a runtime dependency loaded at startup, and a build that packaged
// without it produced an app that opened a window titled "Error" and served nothing. The
// evaluated main-process scope has `process` but no `require`, so the lookup goes through
// `process.mainModule`, which is `main.cjs` itself and resolves from the asar.
const updaterLoads = await desktop.evaluate(() => {
  const resolveFrom = process.mainModule?.require?.bind(process.mainModule) ?? null;
  if (!resolveFrom) return { ok: false, message: 'the main module exposes no require' };
  try {
    const loaded = resolveFrom('electron-updater');
    return { ok: true, hasNsisUpdater: typeof loaded.NsisUpdater === 'function' };
  } catch (error) {
    return { ok: false, message: String(error.message).slice(0, 200) };
  }
});
assert.ok(updaterLoads.ok, `the packaged app cannot load electron-updater: ${updaterLoads.message}`);
assert.ok(updaterLoads.hasNsisUpdater,
  'electron-updater must export NsisUpdater, which is what main.cjs constructs');
  assert.equal(typeof updateStatus.currentVersion, 'string');
  assert.equal(updateStatus.currentVersion, expectedVersion);
  assert.match(updateStatus.source.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download$/,
  'the packaged app must report the feed URL it checks');
assert.equal(updateStatus.source.editable, false,
  'an installed app keeps its feed, so nothing can point it at another repository');
// The schedule is what makes a release reach people who already have the app open, so it
// ships on rather than opt-in. An updater nobody hears from is not one.
assert.equal(updateStatus.preferences.autoCheckEnabled, true,
  'an installed app checks in the background by default');
assert.ok(['hourly', 'daily', 'weekly'].includes(updateStatus.preferences.checkFrequency),
  `the schedule must be a preset, got: ${updateStatus.preferences.checkFrequency}`);
  const runtime = await desktop.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, executablePath: process.execPath }));
  assert.equal(runtime.packaged, true);
  assert.equal(path.normalize(runtime.executablePath), executablePath,
    'Packaged verification must run outside the checkout so dependencies cannot fall back to node_modules');
  assert.equal(path.normalize(runtime.resourcesPath), path.normalize(path.join(path.dirname(executablePath), 'resources')));
  console.log(`Packaged verification executable: ${runtime.executablePath}`);
  await assertDesktopBranding(desktop, path.resolve('work/electron-release/branding'));

  origin = new URL(page.url()).origin;
  const staticAsset = await page.locator('script[src^="/_next/static/"]').first().getAttribute('src');
  assert.ok(staticAsset, 'No Next static script was loaded');
  const staticResponse = await page.request.get(new URL(staticAsset, origin).href);
  assert.equal(staticResponse.status(), 200);
  const faviconResponse = await page.request.get(`${origin}/favicon.svg`);
  assert.equal(faviconResponse.status(), 200);

  let board;
  const scheduleDeadline = Date.now() + 120_000;
  do {
    const gamesResponse = await page.request.get(`${origin}/api/games`, { timeout: 15_000 });
    board = await gamesResponse.json();
    assert.equal(gamesResponse.status(), 200, `Packaged game data must load: ${JSON.stringify(board)}`);
    assert.ok(Array.isArray(board.games), 'Packaged game data must contain a games array');
    if (board.scheduleState === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < scheduleDeadline);
  assert.equal(board.scheduleState, 'ready', 'Packaged game schedule must finish loading');
  assert.ok(Object.values(board.leagues).some(league => typeof league.scoresAt === 'string'),
    'Packaged schedule must retrieve data from at least one league');
  console.log(`Packaged schedule ready with ${board.games.length} games.`);
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
  if (passed) {
    assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
    assert.match(path.basename(scratch), /^sunday-room-packaged-/);
    await rm(scratch, { recursive: true, force: true });
  }
  else console.error(`Packaged app profile retained at ${scratch}`);
}
