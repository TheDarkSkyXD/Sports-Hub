import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { stageNativeArtifact } from './native-artifact-fixture.ts';

const prepare = fileURLToPath(new URL('../scripts/prepare-desktop.mjs', import.meta.url));
const run = promisify(execFile);
const nativePackage = 'node_modules/@img/sharp-win32-x64';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sunday-room-prepare-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^sunday-room-prepare-/);
    await rm(root, { recursive: true, force: true });
  });
  const files: Record<string, string> = {
    '.next/standalone/server.js': '',
    '.next/static/app.js': 'static asset',
    '.next/standalone/lib/football/runtime/worker.ts': '',
    '.next/standalone/lib/football/runtime/schedule-worker.ts': '',
    '.next/standalone/lib/football/runtime/schedule-client.ts': '',
    '.next/standalone/lib/football/runtime/schedule-queue.ts': '',
    '.next/standalone/lib/football/runtime/composition.ts': '',
    '.next/standalone/lib/football/source-registry.json': '[]',
    '.next/standalone/lib/playback/probe.ts': '',
    '.next/standalone/lib/playback/verification-policy.json': '{"concurrency":4}',
    '.next/standalone/lib/sunday.ts': '',
    '.next/standalone/lib/game-timing.ts': '',
    'public/favicon.svg': 'icon',
    'node_modules/hls.js/dist/hls.worker.js': 'self.onmessage = () => postMessage("matched worker");',
    'node_modules/cheerio/index.js': '',
    'node_modules/zod/index.js': '',
    'node_modules/sharp/index.js': '',
    'node_modules/detect-libc/index.js': 'required runtime',
    [`${nativePackage}/lib/sharp.node`]: 'native addon',
    [`${nativePackage}/lib/libvips-42.dll`]: 'vips runtime',
    [`${nativePackage}/lib/libvips-cpp-8.18.6.dll`]: 'vips C++ runtime',
    [`.next/standalone/${nativePackage}/lib/sharp.node`]: 'traced addon',
  };
  for (const name of ['catalog-stream', 'catalog-stream-policy'])
    files[`.next/standalone/lib/playback/providers/${name}.ts`] = '';
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/cheerio': {},
    'node_modules/zod': {},
    'node_modules/sharp': {
      dependencies: { 'detect-libc': '1' },
      optionalDependencies: { '@img/sharp-win32-x64': '1', '@img/sharp-linux-x64': '1' },
    },
    'node_modules/detect-libc': {},
    [nativePackage]: {},
    'node_modules/@img/sharp-linux-x64': {},
  } }));
  stageNativeArtifact(root);
  return root;
}

test('desktop preparation includes Sharp native DLLs and skips uninstalled platform packages', async t => {
  const root = await fixture(t);
  await run(process.execPath, [prepare], { cwd: root, windowsHide: true });
  assert.equal(await readFile(path.join(root, '.next/standalone', nativePackage, 'lib/libvips-42.dll'), 'utf8'),
    'vips runtime');
  assert.equal(await readFile(path.join(root, '.next/standalone', nativePackage, 'lib/libvips-cpp-8.18.6.dll'), 'utf8'),
    'vips C++ runtime');
  assert.equal(await readFile(path.join(root, '.next/standalone/node_modules/detect-libc/index.js'), 'utf8'),
    'required runtime');
});

test('desktop preparation generates and packages the installed HLS worker bytes', async t => {
  const root = await fixture(t);
  await run(process.execPath, [prepare], { cwd: root, windowsHide: true });
  const installed = await readFile(path.join(root, 'node_modules/hls.js/dist/hls.worker.js'));
  assert.deepEqual(await readFile(path.join(root, 'public/generated/hls.worker.js')), installed);
  assert.deepEqual(await readFile(path.join(root, '.next/standalone/public/generated/hls.worker.js')), installed);
});

test('desktop preparation removes traced collector history while preserving the active standalone collector', async t => {
  const root = await fixture(t);
  const distDir = '.desktop-runtime/local-builds/abcd';
  const output = path.join(root, distDir);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(path.join(root, '.next'), output, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const sourceCache = path.join(root, '.desktop-runtime/rust-collector-addon');
  await writeFile(path.join(sourceCache, 'collector-old.node'), 'historical collector');
  const originalFiles = (await readdir(sourceCache)).sort();
  const originalBytes = await Promise.all(originalFiles.map(name => readFile(path.join(sourceCache, name))));
  const standalone = path.join(output, 'standalone');
  const tracedCache = path.join(standalone, '.desktop-runtime/rust-collector-addon');
  await cp(sourceCache, tracedCache, { recursive: true });
  const chunk = path.join(standalone, distDir, 'chunks/current.js');
  await mkdir(path.dirname(chunk), { recursive: true });
  await writeFile(chunk, 'current server chunk');

  await run(process.execPath, [prepare, distDir], { cwd: root, windowsHide: true });

  const collector = path.join(standalone, 'native/collector');
  const manifest = JSON.parse(await readFile(path.join(sourceCache, 'active.json'), 'utf8'));
  const historicalBinary = Buffer.concat([await readFile(path.join(collector, manifest.filename)), Buffer.from('historical build')]);
  const historicalName = `collector-${createHash('sha256').update(historicalBinary).digest('hex')}.node`;
  await writeFile(path.join(collector, historicalName), historicalBinary);
  await run(process.execPath, [prepare, distDir], { cwd: root, windowsHide: true });

  await assert.rejects(lstat(tracedCache), { code: 'ENOENT' });
  assert.deepEqual((await readdir(sourceCache)).sort(), originalFiles);
  assert.deepEqual(await Promise.all(originalFiles.map(name => readFile(path.join(sourceCache, name)))), originalBytes);
  assert.equal(await readFile(chunk, 'utf8'), 'current server chunk');
  assert.deepEqual((await readdir(collector)).sort(), ['active.json', 'bridge.cjs', manifest.filename, 'source-registry.json'].sort());
  for (const name of ['active.json', manifest.filename, 'source-registry.json'])
    assert.deepEqual(await readFile(path.join(collector, name)), await readFile(path.join(sourceCache, name)));
  const loaded = await run(process.execPath, ['--input-type=module', '-e', `
    import {createRequire} from 'node:module';
    const {createNativeCollector}=createRequire(import.meta.url)(${JSON.stringify(path.join(collector, 'bridge.cjs'))});
    console.log(createNativeCollector(true).digest('abc'));
  `], { cwd: tmpdir(), windowsHide: true, env: { ...process.env, SUNDAY_ROOM_COLLECTOR_DIR: collector } });
  assert.equal(loaded.stdout.trim(), 'ba7816bf8f01cfea414140de');
});

for (const relative of ['.desktop-runtime/rust-collector-addon', 'native/collector'])
test(`desktop preparation refuses to prune ${relative} redirected into the source checkout`, async t => {
  const root = await fixture(t);
  const sourceCache = path.join(root, '.desktop-runtime/rust-collector-addon');
  const names = (await readdir(sourceCache)).sort();
  const original = await Promise.all(names.map(name => readFile(path.join(sourceCache, name))));
  const traced = path.join(root, '.next/standalone', relative);
  await mkdir(path.dirname(traced), { recursive: true });
  await symlink(sourceCache, traced, 'junction');
  await assert.rejects(run(process.execPath, [prepare], { cwd: root, windowsHide: true }),
    /Collector staging directory leaves its standalone output/);
  assert.deepEqual(await Promise.all(names.map(name => readFile(path.join(sourceCache, name)))), original);
});

test('desktop preparation fails when a required Sharp dependency is absent', async t => {
  const root = await fixture(t);
  const missing = path.join(root, 'node_modules/detect-libc/index.js');
  await rm(missing);
  await rmdir(path.dirname(missing));
  await assert.rejects(run(process.execPath, [prepare], { cwd: root, windowsHide: true }),
    /ENOENT.*detect-libc/s);
});

test('desktop preparation rejects a standalone worker without its source registry',async t=>{
  const root=await fixture(t);
  await rm(path.join(root,'.next/standalone/lib/football/source-registry.json'));
  await assert.rejects(run(process.execPath,[prepare],{cwd:root,windowsHide:true}),/ENOENT.*source-registry\.json/s);
});

test('desktop preparation rejects a playback worker without its verification policy',async t=>{
  const root=await fixture(t);
  await rm(path.join(root,'.next/standalone/lib/playback/verification-policy.json'));
  await assert.rejects(run(process.execPath,[prepare],{cwd:root,windowsHide:true}),/ENOENT.*verification-policy\.json/s);
});

test('packaged standalone preserves the generated ES module server across preparation', async t => {
  const root = await fixture(t);
  const standalone = path.join(root, '.next/standalone');
  await writeFile(path.join(standalone, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(standalone, 'server.js'),
    'import path from "node:path"; console.log(process.env.SUNDAY_ROOM_COLLECTOR_DIR, path.basename(import.meta.dirname));');
  const env = { ...process.env };
  delete env.SUNDAY_ROOM_COLLECTOR_DIR;
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(process.execPath, [prepare], { cwd: root, windowsHide: true });
    const launched = await run(process.execPath, [path.join(standalone, 'server.js')], { cwd: tmpdir(), env, windowsHide: true });
    assert.equal(launched.stdout.trim(), `${path.join(standalone, 'native', 'collector')} standalone`);
  }
});

for(const aliasTarget of ['source','owned','outside'])test(`custom standalone checks ${aliasTarget} traced aliases before running ESM workers`, async t => {
  const root = await fixture(t);
  const distDir = '.desktop-runtime/local-builds/1234abcd';
  const source = path.join(root, '.next');
  const output = path.join(root, distDir);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(source, output, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const standalone = path.join(output, 'standalone');
  await writeFile(path.join(standalone, 'server.js'), 'const path = require("node:path"); console.log(process.env.SUNDAY_ROOM_COLLECTOR_DIR, path.basename(__dirname));');
  const workerFile = path.join(standalone, 'lib/football/runtime/worker.ts');
  await writeFile(workerFile, 'import { parentPort } from "node:worker_threads"; parentPort?.postMessage("standalone ready");');
  await mkdir(path.join(standalone, 'node_modules/sharp'), { recursive: true });
  await writeFile(path.join(standalone, 'node_modules/sharp/index.js'), 'traced sharp');
  await writeFile(path.join(root, 'node_modules/sharp/index.js'), 'source sharp');
  const alias = path.join(standalone, distDir, 'node_modules/sharp-20c6a5da84e2135f');
  await mkdir(path.dirname(alias), { recursive: true });
  const target=aliasTarget==='source'?path.join(root,'node_modules/sharp'):
    aliasTarget==='owned'?path.join(standalone,'node_modules/sharp'):path.join(root,'public');
  await symlink(target,alias,'junction');

  if(aliasTarget==='outside'){
    await assert.rejects(run(process.execPath,[prepare,distDir],{cwd:root,windowsHide:true}),/Unowned standalone package alias/);
    return;
  }

  await run(process.execPath, [prepare, distDir], { cwd: root, windowsHide: true });
  const env = { ...process.env };
  delete env.SUNDAY_ROOM_COLLECTOR_DIR;
  const launched = await run(process.execPath, [path.join(standalone, 'server.cjs')], { cwd: tmpdir(), env, windowsHide: true });
  assert.equal(launched.stdout.trim(), `${path.join(standalone, 'native', 'collector')} standalone`);
  const packaged = await run(process.execPath, [path.join(standalone, 'server.js')], { cwd: tmpdir(), env, windowsHide: true });
  assert.equal(packaged.stdout.trim(), launched.stdout.trim());
  await run(process.execPath, [prepare, distDir], { cwd: root, windowsHide: true });
  const repeated = await run(process.execPath, [path.join(standalone, 'server.cjs')], { cwd: tmpdir(), env, windowsHide: true });
  assert.equal(repeated.stdout.trim(), launched.stdout.trim());

  assert.equal((await lstat(alias)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(root, 'node_modules/sharp/index.js'), 'utf8'), 'source sharp');
  assert.equal(await readFile(path.join(alias, 'index.js'), 'utf8'), 'source sharp');
  await writeFile(path.join(root, 'node_modules/sharp/index.js'), 'changed source sharp');
  assert.equal(await readFile(path.join(alias, 'index.js'), 'utf8'), 'source sharp');
  assert.equal(await readFile(path.join(standalone, 'package.json'), 'utf8'),
    await readFile(path.join(root, 'package.json'), 'utf8'));
  const worker = new Worker(workerFile);
  await new Promise<void>((resolve, reject) => {
    worker.once('message', message => {
      if (message === 'standalone ready') resolve();
      else reject(new Error(`Unexpected worker response: ${message}`));
    });
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`Worker exited before replying: ${code}`)));
  });
});
