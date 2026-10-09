import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const picomatch = require('next/dist/compiled/picomatch');

test('custom desktop build traces its own Turbo chunks while excluding prior builds', async () => {
  const current = '.desktop-runtime/local-builds/aabbcc';
  const previous = process.env.SUNDAY_ROOM_NEXT_DIST_DIR;
  process.env.SUNDAY_ROOM_NEXT_DIST_DIR = current;
  let config;
  try { config = (await import('../next.config.ts')).default; }
  finally {
    if (previous === undefined) delete process.env.SUNDAY_ROOM_NEXT_DIST_DIR;
    else process.env.SUNDAY_ROOM_NEXT_DIST_DIR = previous;
  }

  const excludes = config.outputFileTracingExcludes?.['/*'];
  assert.ok(excludes);
  const ignored = picomatch(excludes, { dot: true, contains: true });
  assert.equal(ignored(`${current}/chunks/[turbopack]_runtime.js`), false);
  assert.equal(ignored(`${current}/server/app/page.js`), false);
  assert.equal(ignored('.desktop-runtime/local-builds/old-build/chunks/[turbopack]_runtime.js'), true);
  assert.equal(ignored('.desktop-runtime/electron/Sunday Room.exe'), true);
  assert.equal(ignored('dist-electron/win-unpacked/Sunday Room.exe'), true);
});
