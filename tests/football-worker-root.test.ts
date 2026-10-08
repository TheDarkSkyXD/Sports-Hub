import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the worker stores browser data under the supplied project root', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'football-worker-root-'));
  const rootDir = join(cwd, 'app');
  const script = `
    import { Worker } from 'node:worker_threads';
    const worker = new Worker(process.argv[1], {
      workerData: { rootDir: process.argv[2], browserCollectorsAvailable: false },
      execArgv: ['--experimental-strip-types'],
    });
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('message', message => {
      if (message.id === 1) {
        if (message.reply.kind !== 'sources') process.exitCode = 1;
        worker.postMessage({ id: 2, command: { kind: 'stop' } });
      } else if (message.id === 2 && message.reply.kind !== 'ok') process.exitCode = 1;
    });
    worker.postMessage({ id: 1, command: { kind: 'sources' } });
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      resolve('lib/football/runtime/worker.ts'), rootDir], { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(existsSync(join(rootDir, '.desktop-runtime', 'football.sqlite')), true);
    assert.equal(existsSync(join(cwd, '.desktop-runtime', 'football.sqlite')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
