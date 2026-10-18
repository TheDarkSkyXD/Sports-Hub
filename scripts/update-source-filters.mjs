import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {FiltersEngine} from '@ghostery/adblocker';
import packageInfo from '@ghostery/adblocker/package.json' with {type:'json'};

const directory=new URL('../desktop/filters/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
if(packageInfo.version!==manifest.engineVersion)throw new Error('Filter engine version changed. Refresh the source filters.');
const refresh=process.argv.includes('--refresh'),check=process.argv.includes('--check');
if(refresh&&check)throw new Error('Choose either --refresh or --check.');
const sha256=body=>createHash('sha256').update(body).digest('hex');
const inputs=[];
for(const list of manifest.lists){
  const file=new URL(`${list.name}.txt.gz`,directory);
  let body;
  if(refresh){
    const response=await fetch(list.url,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Filter download failed: ${list.name}`);
    body=Buffer.from(await response.arrayBuffer());
    const version=/^! Version: (.+)$/m.exec(body.toString())?.[1]?.trim();
    const commit=/^! Commit: (.+)$/m.exec(body.toString())?.[1]?.trim();
    if(!version||!commit||body.length>8*1024*1024)throw new Error(`Invalid filter list: ${list.name}`);
    Object.assign(list,{version,commit,sha256:sha256(body)});
    await writeFile(file,gzipSync(body,{level:9}));
  }else body=gunzipSync(await readFile(file));
  if(sha256(body)!==list.sha256)throw new Error(`Filter snapshot hash mismatch: ${list.name}`);
  inputs.push(body.toString());
}
const engine=FiltersEngine.parse(inputs.join('\n'),{loadCosmeticFilters:false,loadGenericCosmeticsFilters:false,
  loadCSPFilters:false,enableHtmlFiltering:false,enableInMemoryCache:false,enableCompression:true});
const binary=engine.serialize(),file=new URL('network.bin',directory);
if(check){
  if(!Buffer.from(binary).equals(await readFile(file)))throw new Error('Source filter bundle is stale. Run node scripts/update-source-filters.mjs.');
}else{
  await writeFile(file,binary);
  manifest.binarySha256=sha256(binary);
  await writeFile(new URL('manifest.json',directory),JSON.stringify(manifest,null,2)+'\n');
}
console.log(`Source network filters ${check?'verified':'compiled'} (${binary.length} bytes).`);
