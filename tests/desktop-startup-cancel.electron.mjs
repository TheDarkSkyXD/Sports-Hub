import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-startup-cancel-'));
let desktop;
let child;
let timeout;
try {
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), `--user-data-dir=${profile}`],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    timeout: 90_000,
  });
  child = desktop.process();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(desktop.windows().length, 0, 'Cancel startup before the room window opens');
  await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  const result = await Promise.race([exited, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Electron startup cancellation did not exit. A modal may block shutdown.')), 15_000);
  })]);
  assert.deepEqual(result, { code: 0, signal: null }, 'Startup cancellation must exit normally without a startup-error dialog');
  const output = path.join(root, '.scratch', 'f1');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'startup-cancel-result.json'), JSON.stringify(result, null, 2));
  console.log('PASS native Electron exits normally when startup is cancelled before the room opens.');
} finally {
  clearTimeout(timeout);
  if (child?.exitCode === null) {
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^sunday-room-startup-cancel-/);
  await rm(profile, { recursive: true, force: true });
}
