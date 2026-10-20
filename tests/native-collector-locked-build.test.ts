import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {activeCollectorAddon} from '../scripts/build-rust-collector.mjs';

test('staging an identical loaded addon preserves its bytes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sports-hub-locked-addon-'));
  const artifact=await activeCollectorAddon();
  const staged=path.join(directory,artifact.filename);
  try {
    await cp(artifact.binary,staged);
    const helper=pathToFileURL(path.resolve('scripts/build-rust-collector.mjs')).href;
    execFileSync(process.execPath,['--input-type=module','-e',`
      import {createRequire} from 'node:module';
      import {stageCollectorBinary} from ${JSON.stringify(helper)};
      createRequire(import.meta.url)(${JSON.stringify(staged)});
      await stageCollectorBinary(${JSON.stringify(artifact.binary)},${JSON.stringify(staged)},${JSON.stringify(artifact.binarySha256)});
    `],{encoding:'utf8',windowsHide:true,timeout:10000});
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    await rm(directory,{recursive:true,force:true});
  }
});
