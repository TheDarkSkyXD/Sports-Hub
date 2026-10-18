import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require=createRequire(import.meta.url);
const {DesktopNsisUpdater}=require('../desktop/nsis-updater.cjs');
const feed='https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
const sha512=Buffer.alloc(64,1).toString('base64');
function updater(){
 const value=new DesktopNsisUpdater(undefined,{version:'1.0.6',name:'Sunday Room',isPackaged:true,whenReady:async()=>{},onQuit(){},quit(){}});
 value.logger={info(){},warn(){},error(){},debug(){}};value.setFeedURL({provider:'generic',url:feed});return value;
}
test('updater disables web installers and rejects non-repository update feeds',()=>{
 const value=updater();assert.equal(value.disableWebInstaller,true);
 assert.throws(()=>value.setFeedURL({provider:'generic',url:'https://untrusted.example/releases/latest/download'}),/repository/i);
});
for(const kind of ['foreign installer','web package'])test('updater rejects '+kind+' before cached download execution',async()=>{
 const value=updater();let executed=false;
 value.executeDownload=async()=>{executed=true;return [];};
 const url=kind==='foreign installer'?'https://untrusted.example/evil.exe':feed+'/Sunday-Room-1.0.7-Setup-x64.exe';
 const file={url:new URL(url),info:{url,sha512},...(kind==='web package'?{packageInfo:{path:'https://untrusted.example/package.7z'}}:{})};
 await assert.rejects(()=>value.doDownloadUpdate({updateInfoAndProvider:{info:{version:'1.0.7',files:[file.info]},provider:{resolveFiles:()=>[file]}},requestHeaders:{},cancellationToken:{}}),/installer|repository|package/i);
 assert.equal(executed,false);
});
test('install refuses unadmitted cached files before launching any process',async()=>{
 const value=updater();let spawned=0;value.spawnLog=async()=>{spawned++;return true;};
 value.downloadedUpdateHelper={file:'C:\\outside\\evil.exe',packageFile:null,downloadedFileInfo:{sha512}};
 await assert.rejects(()=>value.doInstall({isSilent:true,isForceRunAfter:false}),/installer|cache|admitted/i);
 assert.equal(spawned,0);
});
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
const {GitHubUpdateExecutor}=require('../desktop/update-network.cjs');
function network(){
 let before:((details:{id:number;url:string;method:string},callback:(value:{cancel:boolean})=>void)=>void)|undefined;
 const requests:EventEmitter[]=[];
 const executor=new GitHubUpdateExecutor({getSession:()=>({webRequest:{onBeforeRequest(hook:typeof before){before=hook;}}}),request:()=>{
  const request=Object.assign(new EventEmitter(),{abort(){request.emit('abort');},end(){queueMicrotask(()=>{const response=Object.assign(Readable.from(['version: 1.0.7']),{statusCode:200,headers:{}});request.emit('response',response);});}});requests.push(request);return request;
 }});
 executor.setFeed(feed);
 const options=(url:string)=>{const parsed=new URL(url);return {protocol:parsed.protocol,hostname:parsed.hostname,path:parsed.pathname+parsed.search,method:'GET'};};
 function allowed(id:number,url:string){let cancelled=true;before?.({id,url,method:'GET'},value=>{cancelled=value.cancel;});return !cancelled;}
 function open(url:string){const config=options(url),request=executor.createRequest(config,()=>{});return {config,request};}
 function redirect(current:ReturnType<typeof open>,url:string){let error:Error|undefined,next:ReturnType<typeof open>|undefined;
  executor.addRedirectHandlers(current.request,current.config,(value:Error)=>{error=value;},0,(config:ReturnType<typeof options>)=>{next={config,request:executor.createRequest(config,()=>{})};});
  current.request.emit('redirect',302,'GET',url);if(error)throw error;assert.ok(next);return next;
 }
 return {executor,open,redirect,allowed,requests};
}
test('updater preserves exact signed CDN Location only through admitted recreated GitHub requests',()=>{
 const n=network(),first=n.open(feed+'/latest.yml?noCache=abc123');
 assert.equal(n.allowed(1,feed+'/latest.yml?noCache=abc123'),true);
 const second=n.redirect(first,'https://github.com/TheDarkSkyXD/Sports-Hub/releases/download/v1.0.7/latest.yml');
 assert.equal(n.allowed(2,'https://github.com/TheDarkSkyXD/Sports-Hub/releases/download/v1.0.7/latest.yml'),true);
 const location='https://release-assets.githubusercontent.com/github-production-release-asset/123/asset?sig=a%2Bb%3D&jwt=signed';
 const third=n.redirect(second,location);assert.equal(third.config.path,new URL(location).pathname+new URL(location).search);
 assert.equal(n.allowed(3,location),true);assert.equal(n.allowed(4,location),false);
 assert.equal(n.allowed(3,location+'&extra=1'),false);third.request.emit('abort');assert.equal(n.allowed(3,location),false);
 assert.throws(()=>n.open(location),/repository/i);
});
for(const destination of ['http://github.com/TheDarkSkyXD/Sports-Hub/releases/download/v1.0.7/latest.yml','https://github.com/other/repo/releases/download/v1.0.7/latest.yml','https://github.com/TheDarkSkyXD/Sports-Hub/blob/main/evil.exe','https://release-assets.githubusercontent.com.evil.example/asset'])test('updater rejects a foreign redirect '+destination,()=>{
 const n=network();assert.throws(()=>n.redirect(n.open(feed+'/latest.yml'),destination),/repository/i);assert.equal(n.requests.length,1);
});
test('changing repository revokes outstanding updater request permits and redirect provenance',()=>{
 const n=network(),first=n.open(feed+'/latest.yml');n.executor.setFeed('https://github.com/owner/fork/releases/latest/download');
 assert.equal(n.allowed(1,feed+'/latest.yml'),false);assert.throws(()=>n.redirect(first,'https://release-assets.githubusercontent.com/asset'),/repository/i);
 assert.throws(()=>n.open(feed+'/latest.yml'),/repository/i);
 assert.doesNotThrow(()=>n.open('https://github.com/owner/fork/releases/latest/download/latest.yml'));
});
test('updater session denies unrelated requests and header destination overrides',()=>{
 const n=network();n.open(feed+'/latest.yml');assert.equal(n.allowed(1,'https://untrusted.example/evil.exe'),false);
 assert.throws(()=>n.executor.createRequest({protocol:'https:',hostname:'github.com',path:'/TheDarkSkyXD/Sports-Hub/releases/latest/download/latest.yml',headers:{Host:'untrusted.example'}},()=>{}),/repository/i);
});

test('metadata fetch retains the installed HTTP executor promise and body parsing API',async()=>{
 const n=network();const body=await n.executor.request({protocol:'https:',hostname:'github.com',path:'/TheDarkSkyXD/Sports-Hub/releases/latest/download/latest.yml',method:'GET'});
 assert.equal(body,'version: 1.0.7');
});
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const {DownloadedUpdateHelper}=require('electron-updater/out/DownloadedUpdateHelper');
for(const condition of ['valid','traversal','same-instance tampering','symlink'])test('cached update admission: '+condition,async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'update-admission-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const value=updater(),helper=new DownloadedUpdateHelper(root);value.downloadedUpdateHelper=helper;
 const pending=helper.cacheDirForPendingUpdate;mkdirSync(pending);const name='Sunday-Room-1.0.7-Setup-x64.exe',file=path.join(pending,name),bytes=Buffer.from('admitted file');
 const checksum=createHash('sha512').update(bytes).digest('base64'),info={version:'1.0.7'},fileInfo={url:new URL(feed+'/'+name),info:{url:name,sha512:checksum}};
 writeFileSync(file,bytes);writeFileSync(path.join(pending,'update-info.json'),JSON.stringify({fileName:condition==='traversal'?'../outside.exe':name,sha512:checksum}));
 writeFileSync(path.join(root,'outside.exe'),bytes);
 await value.getOrCreateDownloadHelper();
 if(condition==='same-instance tampering'){
  await helper.setDownloadedFile(file,null,info,fileInfo,name,false);writeFileSync(file,'tampered after successful download');
 }
 if(condition==='symlink'){
  const fs=await import('node:fs');fs.unlinkSync(file);
  try{fs.symlinkSync(path.join(root,'outside.exe'),file,'file');}catch(error){if(error instanceof Error&&'code' in error&&error.code==='EPERM'){t.skip('Windows user lacks symlink privilege');return;}throw error;}
 }
 const result=await helper.validateDownloadedPath(file,info,fileInfo,value.logger);
 assert.equal(result,condition==='valid'?file:null);
});
test('metadata cannot retarget a previously approved checksum outside the repository',()=>{
 const n=network(),name='Sunday-Room-1.0.7-Setup-x64.exe';
 n.executor.admitRelease({version:'1.0.7'},[{url:new URL(feed+'/'+name),info:{sha512}}]);
 assert.throws(()=>n.executor.admitRelease({version:'1.0.7'},[{url:new URL('https://untrusted.example/'+name),info:{sha512}}]),/repository/i);
});
test('upload finish and close preserve the request permit until response termination',()=>{
 const n=network(),url=feed+'/latest.yml',current=n.open(url);
 current.request.emit('finish');current.request.emit('close');
 assert.equal(n.allowed(71,url),true);
 const response=new EventEmitter();current.request.emit('response',response);
 response.emit('aborted');assert.equal(n.allowed(71,url),false);
});
