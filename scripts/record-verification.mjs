import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

const command = process.argv.slice(2);
if (command.length === 0) {
  process.stderr.write('Usage: node scripts/record-verification.mjs <command> [args...]\n');
  process.exit(2);
}

const cwd = process.cwd();
const startedAt = new Date().toISOString();
const runs = path.join(cwd, '.desktop-runtime', 'verification-runs');
await mkdir(runs, { recursive: true });
const directory = await mkdtemp(path.join(runs, `${startedAt.replace(/[:.]/g, '-')}-`));
const output = createWriteStream(path.join(directory, 'output.log'), { flags: 'wx' });
const outputFinished = finished(output).then(() => null, error => error.message);
const executable = command[0] === 'node' ? process.execPath : command[0];
const child = spawn(executable, command.slice(1), {
  cwd,
  env: process.env,
  shell: false,
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  output.write(chunk);
});
child.stderr.on('data', chunk => {
  process.stderr.write(chunk);
  output.write(chunk);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

let spawnError = null;
child.once('error', error => { spawnError = error.message; });
const { exitCode, signal } = await new Promise(resolve => {
  child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
});
output.end();
const recordingError = await outputFinished;
const result = {
  command,
  cwd,
  startedAt,
  endedAt: new Date().toISOString(),
  exitCode,
  signal,
  spawnError,
  recordingError,
};
await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stderr.write(`Verification evidence: ${path.relative(cwd, directory)}\n`);
process.exitCode = recordingError || spawnError ? 1 : exitCode ?? 1;
