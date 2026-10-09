import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-source-'));
let desktop;
try {
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), '--dev', `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  const deadline = Date.now() + 90_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'Source desktop window must open');
  await page.getByRole('button', { name: 'Watch room' }).waitFor();
  const runtime = await desktop.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(runtime.packaged, false);
  assert.equal(path.normalize(runtime.appPath), path.join(root, 'desktop'));
  let board;
  const scheduleDeadline = Date.now() + 120_000;
  do {
    const response = await page.request.get(new URL('/api/games', page.url()).href, { timeout: 15_000 });
    board = await response.json();
    assert.equal(response.status(), 200, `Source game data must load: ${JSON.stringify(board)}`);
    assert.ok(Array.isArray(board.games));
    if (board.scheduleState === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < scheduleDeadline);
  assert.equal(board.scheduleState, 'ready', 'Source game schedule must finish loading');
  assert.ok(Object.values(board.leagues).some(league => typeof league.scoresAt === 'string'),
    'Source schedule must retrieve data from at least one league');
  console.log('PASS source Electron window and game-data API.');
} finally {
  await desktop?.close();
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-source-/);
  await rm(profile, { recursive: true, force: true });
}
