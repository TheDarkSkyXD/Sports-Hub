import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import test from 'node:test';
import {z} from 'zod';

const require=createRequire(import.meta.url);
const manifest=z.object({dependencies:z.record(z.string(),z.string()).optional()});

test('the desktop allowlist packages the actual filter dependency graph and offline matcher',()=>{
  const config=z.object({files:z.array(z.string())}).parse(require('js-yaml').load(readFileSync('electron-builder.yml','utf8')));
  const directory=mkdtempSync(join(tmpdir(),'source-filter-package-'));
  const pending=['@ghostery/adblocker','ipaddr.js'].map(name=>require.resolve(name+'/package.json'));
  const copied=new Set<string>();
  try{
    while(pending.length){
      const file=pending.pop();assert.ok(file);
      if(copied.has(file))continue;copied.add(file);
      const source=dirname(file),entry=relative(resolve('.'),source).replaceAll('\\','/');
      assert.ok(config.files.some(pattern=>pattern.endsWith('/**')&&(entry===pattern.slice(0,-3)||entry.startsWith(pattern.slice(0,-2)))),'Missing packaged dependency '+entry);
      const destination=join(directory,entry);mkdirSync(dirname(destination),{recursive:true});cpSync(source,destination,{recursive:true});
      for(const name of Object.keys(manifest.parse(JSON.parse(readFileSync(file,'utf8'))).dependencies??{}))
        pending.push(createRequire(file).resolve(name+'/package.json'));
    }
    assert.ok(config.files.includes('desktop/**'));
    mkdirSync(join(directory,'desktop'),{recursive:true});
    for(const file of ['source-adblock.cjs','source-network.cjs','certificate-issuer-proxy.cjs','filters'])
      cpSync(join('desktop',file),join(directory,'desktop',file),{recursive:true});
    const bundled=createRequire(join(directory,'desktop','verify.cjs'))('./source-network.cjs');
    assert.equal(bundled.sourceRequestAllowed({url:'https://googleads.g.doubleclick.net/pagead/ads',resourceType:'script'},'https://player.example/watch'),false);
    assert.equal(bundled.sourceRequestAllowed({url:'https://media.example/index.m3u8',resourceType:'media'}),true);
    assert.equal(bundled.publicAddress('2001:20::1'),false);
    assert.ok(copied.size>=13);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
