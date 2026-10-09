import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {activeCollectorAddon} from '../scripts/build-rust-collector.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const helper=pathToFileURL(path.join(root,'scripts/build-rust-collector.mjs')).href;
const bridge=path.join(root,'native/collector/bridge.cjs');

async function withArtifact(run:(directory:string)=>Promise<void>) {
  const directory=await mkdtemp(path.join(tmpdir(),'sports-hub-native-artifact-'));
  try {
    for(const relative of ['native/collector/src','native/collector/Cargo.toml','native/collector/Cargo.lock',
      'native/collector/build.rs','scripts/build-rust-collector.mjs','lib/football/source-registry.json',
      'lib/football/domain/college-teams.generated.ts','lib/football/domain/college-teams.coverage.json'])
      await cp(path.join(root,relative),path.join(directory,relative),{recursive:true});
    const artifact=await activeCollectorAddon(root);
    const stage=path.join(directory,'.desktop-runtime/rust-collector-addon');
    for(const [source,name] of [[artifact.binary,artifact.filename],[artifact.registry,'source-registry.json'],
      [artifact.manifestFile,'active.json']])
      await cp(source,path.join(stage,name),{recursive:true});
    await run(directory);
  } finally {
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('sports-hub-native-artifact-'));
    await rm(resolved,{recursive:true,force:true});
  }
}

function node(directory:string,code:string) {
  return execFileSync(process.execPath,['--input-type=module','-e',code],{
    cwd:directory,encoding:'utf8',timeout:10_000,windowsHide:true,
    env:{...process.env,PATH:'',SUNDAY_ROOM_COLLECTOR_DIR:path.join(directory,'.desktop-runtime/rust-collector-addon')},
  }).trim();
}

test('an unchanged Rust collector starts with neither Cargo nor rustc on PATH',async()=>{
  await withArtifact(async directory=>{
    const manifestPath=path.join(directory,'.desktop-runtime/rust-collector-addon/active.json');
    const before=await readFile(manifestPath,'utf8');
    const actual=node(directory,`
      import {ensureCollectorAddon} from ${JSON.stringify(helper)};
      const active=await ensureCollectorAddon(${JSON.stringify(directory)});
      console.log(JSON.stringify({filename:active.filename,sourceKey:active.sourceKey}));
    `);
    const manifest=JSON.parse(before);
    assert.deepEqual(JSON.parse(actual),{filename:manifest.filename,sourceKey:manifest.sourceKey});
    assert.equal(await readFile(manifestPath,'utf8'),before);
  });
});

test('changed collector inputs cannot silently reuse a compiled addon',async()=>{
  await withArtifact(async directory=>{
    const input=path.join(directory,'native/collector/src/lib.rs');
    await writeFile(input,`${await readFile(input,'utf8')}\n`);
    const actual=node(directory,`
      import assert from 'node:assert/strict';
      import {ensureCollectorAddon} from ${JSON.stringify(helper)};
      await assert.rejects(ensureCollectorAddon(${JSON.stringify(directory)}),error=>error.code==='ENOENT');
      console.log('rebuild-required');
    `);
    assert.equal(actual,'rebuild-required');
  });
});

test('missing and corrupt native artifacts fail before any collector can run',async()=>{
  await withArtifact(async directory=>{
    const stage=path.join(directory,'.desktop-runtime/rust-collector-addon');
    const manifest=JSON.parse(await readFile(path.join(stage,'active.json'),'utf8'));
    const binary=path.join(stage,manifest.filename);
    await writeFile(binary,'corrupt-native-artifact');
    const actual=node(directory,`
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      const {createNativeCollector}=createRequire(import.meta.url)(${JSON.stringify(bridge)});
      assert.throws(()=>createNativeCollector(),/artifact missing or stale/);
      console.log('corrupt-rejected');
    `);
    assert.equal(actual,'corrupt-rejected');
    await rm(binary);
    await assert.rejects(activeCollectorAddon(directory),{code:'ENOENT'});
    await rm(path.join(stage,'active.json'));
    assert.equal(node(directory,`
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      const {createNativeCollector}=createRequire(import.meta.url)(${JSON.stringify(bridge)});
      assert.throws(()=>createNativeCollector(),/manifest missing/);
      console.log('missing-rejected');
    `),'missing-rejected');
  });
});
