import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import * as ResEdit from 'resedit';

const source = (await fs.readFile(new URL('../scripts/electron-runtime.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export async function prepareDevelopmentElectron', 'async function prepareDevelopmentElectron')
  .replaceAll('import.meta.url', 'sourceUrl');

function preparer(root: string, blockDecoder = false, fileDescription = 'Sunday Room'): () => Promise<string> {
  const implementation = source.replace("FileDescription: 'Sunday Room'", `FileDescription: ${JSON.stringify(fileDescription)}`);
  return runInNewContext(`(function() { ${implementation}\nreturn prepareDevelopmentElectron; })()`, {
    ...fs, Buffer, createHash, randomUUID, path, fileURLToPath, promisify,
    sourceUrl: pathToFileURL(path.join(root, 'scripts/electron-runtime.mjs')).href,
    process: { platform: 'win32', execPath: process.execPath, pid: process.pid },
    createRequire: () => (name: string) => {
      assert.equal(name, 'electron');
      return path.join(root, 'distribution/electron.exe');
    },
    execFile: (_executable: string, _args: string[], _options: object, callback: (error: Error | null) => void) => callback(null),
    ResEdit: blockDecoder ? { ...ResEdit, NtExecutable: { from() { throw new Error('PE decoder unavailable'); } } } : ResEdit,
  });
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'sunday-electron-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const icon = await fs.readFile(new URL('../desktop/icons/sunday-room.ico', import.meta.url));
  const executable = ResEdit.NtExecutable.createEmpty();
  const resources = ResEdit.NtExecutableResource.from(executable);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033,
    ResEdit.Data.IconFile.from(icon).icons.map(item => item.data));
  ResEdit.Resource.VersionInfo.create({ lang: 1033,
    fixedInfo: { fileVersionMS: 65536, productVersionMS: 65536 },
    strings: [{ lang: 1033, codepage: 1200, values: {
      FileDescription: 'Electron', ProductName: 'Electron', FileVersion: '1.0.0', ProductVersion: '1.0.0',
    } }],
  }).outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  await fs.mkdir(path.join(root, 'distribution'), { recursive: true });
  await fs.mkdir(path.join(root, 'desktop/icons'), { recursive: true });
  await fs.writeFile(path.join(root, 'distribution/electron.exe'), Buffer.from(executable.generate()));
  await fs.writeFile(path.join(root, 'distribution/icudtl.dat'), 'runtime data');
  await fs.writeFile(path.join(root, 'desktop/icons/sunday-room.ico'), icon);
  return root;
}

test('unchanged branded output starts without PE decoding and still refreshes distribution bytes', async t => {
  const root = await fixture(t);
  const branded = await preparer(root)();
  const original = await fs.readFile(branded);
  await fs.writeFile(path.join(root, '.desktop-runtime/electron/icudtl.dat'), 'changed data');
  assert.equal(await preparer(root, true)(), branded);
  assert.deepEqual(await fs.readFile(branded), original);
  assert.equal(await fs.readFile(path.join(root, '.desktop-runtime/electron/icudtl.dat'), 'utf8'), 'runtime data');
});

test('a changed branded executable is rebuilt instead of trusting its stamp', async t => {
  const root = await fixture(t);
  const prepare = preparer(root);
  const branded = await prepare();
  const original = await fs.readFile(branded);
  await fs.writeFile(branded, Buffer.alloc(original.length));
  assert.equal(await prepare(), branded);
  assert.deepEqual(await fs.readFile(branded), original);
});

test('a branding change rebuilds the executable without changing its source, icon, or preparer version', async t => {
  const root = await fixture(t);
  await preparer(root)();
  const branded = await preparer(root, false, 'Updated Sunday Room')();
  const resources = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(await fs.readFile(branded)));
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  assert.equal(versions[0].getStringValues({ lang: 1033, codepage: 1200 }).FileDescription, 'Updated Sunday Room');
});
