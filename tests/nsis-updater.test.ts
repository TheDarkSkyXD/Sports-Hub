import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
const require = createRequire(import.meta.url);
const { DesktopNsisUpdater } = require('../desktop/nsis-updater.cjs');
function setup(t:TestContext) {
 const events:string[]=[];let onQuit=(code:number)=>{assert.equal(code,0);};
 const cache=mkdtempSync(path.join(tmpdir(),'sunday-update-'));
 t.after(()=>rmSync(cache,{recursive:true,force:true}));
 const app=Object.assign(new EventEmitter(),{version:'1.0.6',name:'Sunday Room',isPackaged:true,appUpdateConfigPath:path.join(cache,'app-update.yml'),userDataPath:cache,baseCachePath:cache,
  whenReady:async()=>{},onQuit:(handler:typeof onQuit)=>{onQuit=handler;},quit:()=>{const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};app.emit('before-quit',event);if(event.defaultPrevented)return;events.push('app quit');onQuit(0);app.emit('quit',0);}});
 const updater=new DesktopNsisUpdater(undefined,app,()=>events.push('before-quit-for-update'));
 updater.logger={info(){},warn(){},error(){},debug(){}};
 const feed='https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
 updater.setFeedURL({provider:'generic',url:feed});
 const name='Sunday-Room-1.0.7-Setup-x64.exe',bytes=Buffer.from('local installer fixture'),sha512=createHash('sha512').update(bytes).digest('base64');
 const release=updater.httpExecutor.admitRelease({version:'1.0.7'},[{url:new URL(feed+'/'+name),info:{sha512}}]);
 const pending=path.join(cache,'pending');mkdirSync(pending);const installer=path.join(pending,name);writeFileSync(installer,bytes);
 updater.downloadedUpdateHelper={file:installer,cacheDirForPendingUpdate:pending,packageFile:null,downloadedFileInfo:{fileName:name,sha512,isAdminRightsRequired:false}};
 updater.installDirectory='D:\\Apps\\Sunday Room';return {updater,events,app,installer,release};
}
function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
test('explicit install validates the full installer, waits for launch and keeps install directory last',async t=>{
 const {updater,events,installer}=setup(t),started=gate(),launch=gate();
 const calls:{file:string;args:string[]}[]=[];
 updater.spawnLog=async(file:string,args:string[])=>{calls.push({file,args});started.resolve();await launch.promise;return true;};
 const install=updater.quitAndInstall(true,true);await started.promise;await updater.quitAndInstall(true,true);
 assert.deepEqual(events,[]);assert.deepEqual(calls,[{file:installer,args:['--updated','/S','--force-run','/D=D:\\Apps\\Sunday Room']}]);
 launch.resolve();await install;assert.deepEqual(events,['before-quit-for-update','app quit']);
});
test('installer launch failure keeps Electron open and allows Retry',async t=>{
 const {updater,events}=setup(t);let attempts=0;
 updater.spawnLog=async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('missing installer'),{code:'ENOENT'});return true;};
 await assert.rejects(()=>updater.quitAndInstall(true,true),/missing installer/);assert.deepEqual(events,[]);assert.equal(updater.quitAndInstallCalled,false);
 await updater.quitAndInstall(true,true);assert.equal(attempts,2);assert.deepEqual(events,['before-quit-for-update','app quit']);
});
test('access denied falls back to elevate and still waits for its launch',async t=>{
 const previous=Reflect.get(process,'resourcesPath');Reflect.set(process,'resourcesPath','C:\\Program Files\\Sunday Room\\resources');
 try{
 const {updater,events,installer}=setup(t),started=gate(),launch=gate(),calls:{file:string;args:string[]}[]=[];
 updater.spawnLog=async(file:string,args:string[])=>{calls.push({file,args});if(calls.length===1)throw Object.assign(new Error('access denied'),{code:'EACCES'});started.resolve();await launch.promise;return true;};
 const install=updater.quitAndInstall(true,true);await started.promise;assert.equal(calls.length,2);assert.match(calls[1].file,/elevate\.exe$/);assert.equal(calls[1].args[0],installer);assert.equal(calls[1].args.at(-1),'/D=D:\\Apps\\Sunday Room');assert.deepEqual(events,[]);
 launch.resolve();await install;assert.deepEqual(events,['before-quit-for-update','app quit']);
 }finally{if(previous===undefined)Reflect.deleteProperty(process,'resourcesPath');else Reflect.set(process,'resourcesPath',previous);}
});
test('ordinary quit remains silent and does not force a relaunch',async t=>{
 const {updater,app,events}=setup(t),started=gate(),exited=gate(),calls:string[][]=[];app.once('quit',()=>exited.resolve());
 updater.spawnLog=async(_file:string,args:string[])=>{calls.push(args);started.resolve();return true;};updater.addQuitHandler();app.quit();await started.promise;await exited.promise;
 assert.deepEqual(calls,[['--updated','/S','/D=D:\\Apps\\Sunday Room']]);assert.deepEqual(events,['app quit']);
});
for(const mode of ['explicit','on quit'])test('modified cached installer cannot launch '+mode,async t=>{
 const {updater,app,events,installer}=setup(t);writeFileSync(installer,'tampered');let calls=0;const rejected=gate();
 updater.spawnLog=async()=>{calls++;return true;};updater.logger={error(){rejected.resolve();},info(){},warn(){},debug(){}};
 if(mode==='explicit')await assert.rejects(()=>updater.quitAndInstall(true,true),/SHA512/);else{updater.addQuitHandler();app.quit();await rejected.promise;}
 assert.equal(calls,0);assert.deepEqual(events,[]);
});

test('ordinary quit keeps the process alive until validation and asynchronous installer launch settle',async t=>{
 const {updater,app,events}=setup(t),started=gate(),acknowledged=gate(),exited=gate();
 app.once('quit',()=>exited.resolve());updater.spawnLog=async()=>{started.resolve();await acknowledged.promise;return true;};
 updater.addQuitHandler();app.quit();await started.promise;
 app.quit();const exitedBeforeAcknowledgement=events.includes('app quit');acknowledged.resolve();await exited.promise;
 assert.equal(exitedBeforeAcknowledgement,false);assert.deepEqual(events,['app quit']);
});

test('automatic install waits for an earlier prevented shutdown and retries a failed launch',async t=>{
 const {updater,app,events}=setup(t),cleanup=gate(),failed=gate(),exited=gate();let stopped=false,attempts=0;
 app.on('before-quit',(event:{preventDefault():void})=>{if(stopped)return;event.preventDefault();void cleanup.promise.then(()=>{stopped=true;app.quit();});});
 app.once('quit',()=>exited.resolve());updater.logger={error(){failed.resolve();},info(){},warn(){},debug(){}};
 updater.spawnLog=async()=>{assert.equal(stopped,true);attempts++;if(attempts===1)throw new Error('launch failed');return true;};
 updater.addQuitHandler();app.quit();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(attempts,0);assert.deepEqual(events,[]);
 cleanup.resolve();await failed.promise;assert.deepEqual(events,[]);assert.equal(updater.quitAndInstallCalled,false);
 app.quit();await exited.promise;assert.equal(attempts,2);assert.deepEqual(events,['app quit']);
});
