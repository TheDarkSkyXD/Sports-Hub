import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevelopmentElectron } from './electron-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.join(root, 'desktop', 'main.cjs');

try {
  const executablePath = await prepareDevelopmentElectron();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executablePath, [main, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
