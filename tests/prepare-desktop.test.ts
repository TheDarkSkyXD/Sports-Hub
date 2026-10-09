import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
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
    '.next/standalone/lib/sunday.ts': '',
    '.next/standalone/lib/game-timing.ts': '',
    'public/favicon.svg': 'icon',
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

test('custom standalone materializes traced aliases and runs ESM workers', async t => {
  const root = await fixture(t);
  const distDir = '.desktop-runtime/local-builds/1234abcd';
  const source = path.join(root, '.next');
  const output = path.join(root, distDir);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(source, output, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const standalone = path.join(output, 'standalone');
  const workerFile = path.join(standalone, 'lib/football/runtime/worker.ts');
  await writeFile(workerFile, 'import { parentPort } from "node:worker_threads"; parentPort?.postMessage("standalone ready");');
  await mkdir(path.join(standalone, 'node_modules/sharp'), { recursive: true });
  await writeFile(path.join(standalone, 'node_modules/sharp/index.js'), 'traced sharp');
  await writeFile(path.join(root, 'node_modules/sharp/index.js'), 'source sharp');
  const alias = path.join(standalone, distDir, 'node_modules/sharp-20c6a5da84e2135f');
  await mkdir(path.dirname(alias), { recursive: true });
  await symlink(path.join(root, 'node_modules/sharp'), alias, 'junction');

  await run(process.execPath, [prepare, distDir], { cwd: root, windowsHide: true });

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
