import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const profile = await mkdtemp(path.join(tmpdir(), 'sunday-desktop-crash-'));
let app;
try {
  app = await electron.launch({
    args: [path.resolve('desktop/main.cjs'), `--user-data-dir=${profile}`],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  });
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  const origin = new URL(page.url()).origin;
  const pid = app.process().pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  let stopped = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); }
    catch { stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(stopped, true, 'Next server must exit after its Electron parent crashes');
  console.log('Electron crash released its local server.');
} finally {
  await app?.close().catch(() => {});
  const target = path.resolve(profile);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.match(path.basename(target), /^sunday-desktop-crash-/);
  await rm(target, { recursive: true, force: true });
}
