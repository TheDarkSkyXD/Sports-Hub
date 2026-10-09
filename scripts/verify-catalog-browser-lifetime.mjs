import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareDevelopmentElectron } from './electron-runtime.mjs';

const executable = await prepareDevelopmentElectron();
const entry = resolve(import.meta.dirname, 'verify-catalog-browser-lifetime.cjs');
const temp = mkdtempSync(join(tmpdir(), 'catalog-lifetime-result-'));
const resultPath = join(temp, 'result.json');
const profilePath = join(temp, 'profile');
mkdirSync(profilePath);
const env = { ...process.env, CATALOG_LIFETIME_RESULT_PATH: resultPath,
  CATALOG_LIFETIME_PROFILE_PATH: profilePath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [entry], { cwd: resolve(import.meta.dirname, '..'), env, windowsHide: true });
child.stdout.on('data', chunk => { process.stdout.write(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); });
const timeout = setTimeout(() => {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill();
}, 90000);
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (status, signal) => resolveExit(signal ? 1 : status));
});
clearTimeout(timeout);
let result;
try { result = JSON.parse(readFileSync(resultPath, 'utf8')); }
catch { result = { pass: false, phase: existsSync(`${resultPath}.phase`) ? readFileSync(`${resultPath}.phase`, 'utf8') : 'Electron did not start' }; }
process.stdout.write(`CATALOG_LIFETIME_RESULT ${JSON.stringify(result)}\n`);
rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
if (code !== 0 || result.pass !== true)
  process.exitCode = 1;
