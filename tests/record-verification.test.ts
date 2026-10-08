import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const recorder = fileURLToPath(new URL('../scripts/record-verification.mjs', import.meta.url));

test('verification attempts retain separate output and exit evidence', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sunday-room-verification-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const failingCode = 'process.stdout.write("first-out\\n"); process.stderr.write("first-err\\n"); process.exit(13)';
  const failed = spawnSync(process.execPath, [recorder, 'node', '-e', failingCode], { cwd, encoding: 'utf8' });
  assert.equal(failed.status, 13);
  assert.match(failed.stdout, /first-out/);
  assert.match(failed.stderr, /first-err/);

  const passingCode = 'process.stdout.write("second-out\\n")';
  const passed = spawnSync(process.execPath, [recorder, 'node', '-e', passingCode], { cwd, encoding: 'utf8' });
  assert.equal(passed.status, 0);
  assert.match(passed.stdout, /second-out/);

  const runs = path.join(cwd, '.desktop-runtime', 'verification-runs');
  const folders = await readdir(runs);
  assert.equal(folders.length, 2);
  const records = await Promise.all(folders.map(async folder => ({
    result: JSON.parse(await readFile(path.join(runs, folder, 'result.json'), 'utf8')),
    output: await readFile(path.join(runs, folder, 'output.log'), 'utf8'),
  })));
  const failure = records.find(record => record.result.exitCode === 13);
  const success = records.find(record => record.result.exitCode === 0);
  assert.ok(failure);
  assert.ok(success);
  assert.deepEqual(failure.result.command, ['node', '-e', failingCode]);
  assert.equal(failure.result.signal, null);
  assert.ok(Date.parse(failure.result.startedAt) <= Date.parse(failure.result.endedAt));
  assert.match(failure.output, /first-out/);
  assert.match(failure.output, /first-err/);
  assert.doesNotMatch(success.output, /first-out|first-err/);
  assert.match(success.output, /second-out/);
});
