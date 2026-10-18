import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createReadStream, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { stageNativeArtifact } from './native-artifact-fixture.ts';

const require = createRequire(import.meta.url);
const { sourceIdentity } = require('../desktop/source-identity.cjs');
const { buildDirectory, completeArtifact, reusableArtifact } = require('../desktop/compiled-artifact.cjs');

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'sunday-compiled-artifact-'));
  stageNativeArtifact(root);
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
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(served, 'escape'), 'junction');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await unlink(path.join(served, 'escape'));
  assert.equal((await reusableArtifact(root, 'source-one'))?.entry, target.entry);
  const manifestPath = path.join(served, '.sunday-room-complete.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 1 }));
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(await reusableArtifact(root, 'source-two'), null);
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'changed');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await rm(path.join(served, distDir, 'static', 'app.js'));
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'asset');
  assert.equal(manifest.sourceId, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'different-build');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'source-one');
  await writeFile(manifestPath, 'null');
  assert.equal(await reusableArtifact(root, 'source-one'), null);
  await writeFile(manifestPath, JSON.stringify({ version: 1, sourceId: 'source-one', distDir, files: null }));
  assert.equal(await reusableArtifact(root, 'source-one'), null);
});

test('artifact verification reads independent files while another read waits, with bounded open streams', async t => {
  const root = await fixture(t);
  const distDir = buildDirectory('abcd');
  await file(root, `${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'asset');
  await file(root, `${distDir}/standalone/public/favicon.svg`, 'icon');
  await file(root, `${distDir}/standalone/server.cjs`, 'server');
  for (let index = 0; index < 20; index++)
    await file(root, `${distDir}/standalone/public/asset-${index}.js`, `asset ${index}`);
  await completeArtifact(root, distDir, 'source-one');

  const pending: (() => void)[] = [];
  let released = false;
  let active = 0;
  let peak = 0;
  const source = readFileSync(new URL('../desktop/compiled-artifact.cjs', import.meta.url), 'utf8');
  const instrumented: { reusableArtifact: typeof reusableArtifact } = runInNewContext(
    `(function(require) { const module = { exports: {} }; ${source}\nreturn module.exports; })`,
  )((name: string) => {
    if (name === 'node:fs/promises') return {
      ...fsPromises,
      readFile: async (...args: Parameters<typeof readFileSync>) => readFileSync(...args),
      readdir: async (...args: Parameters<typeof readdirSync>) => readdirSync(...args),
      realpath: async (...args: Parameters<typeof realpathSync>) => realpathSync(...args),
      stat: async (...args: Parameters<typeof statSync>) => statSync(...args),
    };
    if (name === 'node:fs') return {
      createReadStream(filename: string) {
        const stream = new PassThrough();
        active++;
        peak = Math.max(peak, active);
        stream.once('end', () => { active--; });
        const resume = () => createReadStream(filename).pipe(stream);
        if (released) resume();
        else pending.push(resume);
        return stream;
      },
    };
    return require(name);
  });
  const validation = instrumented.reusableArtifact(root, 'source-one');
  try {
    await setImmediate();
    assert.ok(active > 1, 'An independent file must start before the stalled read finishes');
    assert.ok(active <= 4, 'Artifact verification must bound simultaneous file reads');
  } finally {
    released = true;
    for (const resume of pending) resume();
    await validation;
  }
  assert.equal((await validation)?.entry, path.join(root, distDir, 'standalone', 'server.cjs'));
  assert.ok(peak <= 4, 'Artifact verification must keep its bound for the entire payload');
});

test('a missing artifact file stops queued reads and waits for active readers before returning a cache miss', async t => {
  const root = await fixture(t);
  const distDir = buildDirectory('abcd');
  await file(root, `${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'asset');
  await file(root, `${distDir}/standalone/server.cjs`, 'server');
  for (let index = 0; index < 20; index++)
    await file(root, `${distDir}/standalone/public/asset-${index}.js`, `asset ${index}`);
  await completeArtifact(root, distDir, 'source-one');

  const readers: { stream: PassThrough; filename: string }[] = [];
  let released = false;
  let finished = false;
  const source = readFileSync(new URL('../desktop/compiled-artifact.cjs', import.meta.url), 'utf8');
  const instrumented: { reusableArtifact: typeof reusableArtifact } = runInNewContext(
    `(function(require) { const module = { exports: {} }; ${source}\nreturn module.exports; })`,
  )((name: string) => {
    if (name === 'node:fs/promises') return {
      ...fsPromises,
      readFile: async (...args: Parameters<typeof readFileSync>) => readFileSync(...args),
      readdir: async (...args: Parameters<typeof readdirSync>) => readdirSync(...args),
      realpath: async (...args: Parameters<typeof realpathSync>) => realpathSync(...args),
      stat: async (...args: Parameters<typeof statSync>) => statSync(...args),
    };
    if (name === 'node:fs') return {
      createReadStream(filename: string) {
        const stream = new PassThrough();
        readers.push({ stream, filename });
        if (released) stream.end(readFileSync(filename));
        return stream;
      },
    };
    return require(name);
  });
  const validation = instrumented.reusableArtifact(root, 'source-one').then((result: unknown) => {
    finished = true;
    return result;
  });
  try {
    await setImmediate();
    assert.equal(readers.length, 4);
    readers[0].stream.destroy(Object.assign(new Error('File no longer exists'), { code: 'ENOENT' }));
    await setImmediate();
    readers[1].stream.end(readFileSync(readers[1].filename));
    await setImmediate();
    assert.equal(readers.length, 4, 'Workers must not dequeue another file after a failed read');
    assert.equal(finished, false, 'A cache miss must wait for the remaining active file reads');
  } finally {
    released = true;
    for (const { stream, filename } of readers)
      if (!stream.destroyed && !stream.writableEnded) stream.end(readFileSync(filename));
    await validation;
  }
  assert.equal(await validation, null);
});

test('artifact verification advances independent files while one file metadata lookup waits', async t => {
  const root = await fixture(t);
  const distDir = buildDirectory('abcd');
  await file(root, `${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/BUILD_ID`, 'source-one');
  await file(root, `${distDir}/standalone/${distDir}/static/app.js`, 'asset');
  await file(root, `${distDir}/standalone/public/favicon.svg`, 'icon');
  await file(root, `${distDir}/standalone/server.cjs`, 'server');
  await completeArtifact(root, distDir, 'source-one');

  const gate = Promise.withResolvers<void>();
  let blocked = false;
  let started = 0;
  const source = readFileSync(new URL('../desktop/compiled-artifact.cjs', import.meta.url), 'utf8');
  const instrumented: { reusableArtifact: typeof reusableArtifact } = runInNewContext(
    `(function(require) { const module = { exports: {} }; ${source}\nreturn module.exports; })`,
  )((name: string) => {
    if (name === 'node:fs/promises') return {
      ...fsPromises,
      readFile: async (...args: Parameters<typeof readFileSync>) => readFileSync(...args),
      readdir: async (...args: Parameters<typeof readdirSync>) => readdirSync(...args),
      realpath: async (...args: Parameters<typeof realpathSync>) => {
        const target = realpathSync(...args);
        if (!blocked && statSync(args[0]).isFile()) {
          blocked = true;
          await gate.promise;
        }
        return target;
      },
      stat: async (...args: Parameters<typeof statSync>) => statSync(...args),
    };
    if (name === 'node:fs') return {
      createReadStream(filename: string) { started++; return createReadStream(filename); },
    };
    return require(name);
  });
  const validation = instrumented.reusableArtifact(root, 'source-one');
  try {
    await setImmediate();
    assert.equal(blocked, true);
    assert.ok(started > 0, 'An independent file must advance before the metadata lookup finishes');
  } finally {
    gate.resolve();
    await validation;
  }
  assert.equal((await validation)?.entry, path.join(root, distDir, 'standalone', 'server.cjs'));
});
