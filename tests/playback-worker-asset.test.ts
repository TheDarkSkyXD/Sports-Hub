import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const prepare = fileURLToPath(new URL('../scripts/prepare-playback-worker.mjs', import.meta.url));
const installed = fileURLToPath(new URL('../node_modules/hls.js/dist/hls.worker.js', import.meta.url));
const run = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'sunday-playback-worker-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^sunday-playback-worker-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('worker preparation copies the actual installed standalone worker and preserves unchanged output', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'node_modules/hls.js/dist/hls.worker.js');
  const target = path.join(root, 'public/generated/hls.worker.js');
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(installed, source);
  await writeFile(target, 'stale older worker');
  await run(process.execPath, [prepare], { cwd: root, windowsHide: true });
  assert.deepEqual(await readFile(target), await readFile(installed));
  const previous = await stat(target);
  await run(process.execPath, [prepare], { cwd: root, windowsHide: true });
  assert.equal((await stat(target)).mtimeMs, previous.mtimeMs);
  await writeFile(source, 'new installed package bytes');
  await run(process.execPath, [prepare], { cwd: root, windowsHide: true });
  assert.equal(await readFile(target, 'utf8'), 'new installed package bytes');
});

test('worker preparation fails when the installed package has no standalone worker', async t => {
  const root = await fixture(t);
  await assert.rejects(run(process.execPath, [prepare], { cwd: root, windowsHide: true }), /ENOENT.*hls\.worker\.js/s);
  await assert.rejects(stat(path.join(root, 'public/generated/hls.worker.js')), { code: 'ENOENT' });
});
