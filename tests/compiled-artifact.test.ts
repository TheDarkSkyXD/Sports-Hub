import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sourceIdentity } = require('../desktop/source-identity.cjs');
const { buildDirectory, completeArtifact, reusableArtifact } = require('../desktop/compiled-artifact.cjs');

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'sunday-compiled-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(root: string, name: string, contents: string) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test('source identity changes for edits, additions, and removals', async t => {
  const root = await fixture(t);
  await file(root, 'app/page.tsx', 'first');
  const first = await sourceIdentity(root);
  await file(root, 'app/page.tsx', 'second');
  const edited = await sourceIdentity(root);
  assert.notEqual(edited, first);
  await file(root, 'app/untracked.tsx', 'new');
  const added = await sourceIdentity(root);
  assert.notEqual(added, edited);
  await rm(path.join(root, 'app/untracked.tsx'));
  assert.equal(await sourceIdentity(root), edited);
});

test('a completed standalone is reused only while its payload and source match', async t => {
  const root = await fixture(t);
  const distDir = buildDirectory('abcd');
  const served = path.join(root, distDir, 'standalone');
  await file(root, `${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'asset');
  await file(root, `${distDir}/standalone/public/favicon.svg`, 'icon');
  await file(root, `${distDir}/standalone/server.cjs`, 'server');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  const target = await completeArtifact(root, distDir, 'source-one');
  assert.equal(target.entry, path.join(served, 'server.cjs'));
  assert.equal((await reusableArtifact(root, 'source-one'))?.entry, target.entry);
  assert.equal(await reusableArtifact(root, 'source-two'), null);
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'changed');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await rm(path.join(served, distDir, 'static', 'app.js'));
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'asset');
  const manifestPath = path.join(served, '.sunday-room-complete.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceId, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'different-build');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'source-one');
  await writeFile(manifestPath, 'null');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await writeFile(manifestPath, JSON.stringify({ version: 1, sourceId: 'source-one', distDir, files: null }));
  assert.equal(await reusableArtifact(root, 'source-one'), null);
});
