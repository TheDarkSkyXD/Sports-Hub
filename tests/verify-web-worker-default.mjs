import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const launcher = join(resolve(import.meta.dirname, '..'), 'scripts', 'web-server.mjs');

for (const mode of ['dev', 'start']) {
  const result = spawnSync(process.execPath, [launcher, mode], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, `${mode} must reject standalone web startup`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /standalone web launcher is retired/);
  assert.match(result.stderr, /npm start/);
  assert.match(result.stderr, /npm run dev/);
}

console.log('Standalone web startup rejects dev and start with Electron launch guidance.');
