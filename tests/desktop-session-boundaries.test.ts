import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import test from 'node:test';

const require=createRequire(new URL('../desktop/main.cjs',import.meta.url));
class SourceSession extends EventEmitter{
  request:((contents:object,permission:string,callback:(allowed:boolean)=>void,details?:{isMainFrame:boolean;requestingUrl:string})=>void)|undefined;
  check:((contents?:object,permission?:string,origin?:string,details?:{isMainFrame:boolean;requestingUrl?:string})=>boolean)|undefined;
  device:(()=>boolean)|undefined;
  display:((request:object,callback:(streams:object)=>void)=>void)|undefined;
  setPermissionRequestHandler(callback:typeof this.request){this.request=callback;}
  setPermissionCheckHandler(callback:typeof this.check){this.check=callback;}
  setDevicePermissionHandler(callback:typeof this.device){this.device=callback;}
  setDisplayMediaRequestHandler(callback:typeof this.display){this.display=callback;}
}
function bootstrap(){
  const defaultSession=new SourceSession();
  const app=Object.assign(new EventEmitter(),{commandLine:{appendSwitch(){}},isPackaged:false,isReady:()=>false,enableSandbox(){},setName(){},setAppUserModelId(){},getPath:()=>path.resolve('.desktop-runtime/feed-isolation'),requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),quit(){}});
  runInNewContext(readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8'),{
    require:(id:string)=>id==='electron'?{app,autoUpdater:new EventEmitter(),session:{defaultSession}}:id.startsWith('./')&&id!=='./security.cjs'?{}:require(id),
    __dirname:path.resolve('desktop'),process:{platform:'win32',env:{},argv:[]},URL,console,
  });
  app.emit('ready');return {app,defaultSession};
}
for(const role of ['default','verifier','observed-media','future','electron-updater'])test('the application denies file downloads and permissions for '+role+' sessions',()=>{
  const {app,defaultSession}=bootstrap(),source=role==='default'?defaultSession:new SourceSession();
  if(role!=='default')app.emit('session-created',source);
  let prevented=0,cancelled=0;
  source.emit('will-download',{preventDefault(){prevented++;}},{cancel(){cancelled++;}});
  assert.equal(prevented,1);assert.equal(cancelled,1);
  assert.equal(source.check?.(),false);assert.equal(source.device?.(),false);
  let granted=true;source.request?.({},'geolocation',allowed=>{granted=allowed;});assert.equal(granted,false);
  let streams:object|null=null;source.display?.({},value=>{streams=value;});assert.deepEqual(streams,{});
});

test('every new web contents denies popups and webview attachment',()=>{
  const {app}=bootstrap();let popup:(()=>object)|undefined;
  const contents=Object.assign(new EventEmitter(),{setWindowOpenHandler(handler:()=>object){popup=handler;}});
  app.emit('web-contents-created',{},contents);
  assert.deepEqual(popup?.(),{action:'deny'});
  let prevented=0;contents.emit('will-attach-webview',{preventDefault(){prevented++;}});assert.equal(prevented,1);
});
const {allowedProjectLink}=require('../desktop/security.cjs');
test('only selected project repository and release pages can open outside the trusted room',()=>{
 const feed='https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
 for(const url of ['https://github.com/TheDarkSkyXD/Sports-Hub','https://github.com/TheDarkSkyXD/Sports-Hub/releases','https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v1.0.12'])assert.equal(allowedProjectLink(url,[feed]),true,url);
 for(const url of ['https://untrusted.example/','https://github.com/other/repo','https://github.com/TheDarkSkyXD/Sports-Hub/releases/download/v1.0.12/installer.exe','https://github.com/TheDarkSkyXD/Sports-Hub?redirect=https://untrusted.example','https://github.com.evil.example/TheDarkSkyXD/Sports-Hub','file:///C:/Windows/System32/cmd.exe','ms-settings:','https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v1.0.12#anything'])assert.equal(allowedProjectLink(url,[feed]),false,url);
 assert.equal(allowedProjectLink('https://github.com/owner/fork/releases/tag/v1.0.1',[feed,'https://github.com/owner/fork/releases/latest/download']),true);
});

const {createIsolatedPlayers}=require('../desktop/isolated-player.cjs');
test('registered viewing main frame can request fullscreen and sanitized clipboard writes only',async()=>{
 const {defaultSession}=bootstrap(),origin='http://127.0.0.1:9000';
 const contents=Object.assign(new EventEmitter(),{mainFrame:{url:origin+'/'},isDestroyed:()=>false});
 const window=Object.assign(new EventEmitter(),{webContents:contents,isDestroyed:()=>false});
 const players=createIsolatedPlayers({authorizeTarget:async()=>false});players.registerHost(window,origin,'viewing');
 const details={isMainFrame:true,requestingUrl:origin+'/'};
 const request=(permission:string,metadata=details,sender:object=contents)=>{let allowed=false;defaultSession.request?.(sender,permission,value=>{allowed=value;},metadata);return allowed;};
 assert.equal(request('fullscreen'),true);assert.equal(request('clipboard-sanitized-write'),true);
 assert.equal(defaultSession.check?.(contents,'clipboard-sanitized-write',origin,details),true);
 for(const permission of ['automatic-fullscreen','clipboard-read','media','geolocation','usb','openExternal']){
  assert.equal(request(permission),false);assert.equal(defaultSession.check?.(contents,permission,origin,details),false);
 }
 assert.equal(request('fullscreen',{...details,isMainFrame:false}),false);
 assert.equal(request('fullscreen',{...details,requestingUrl:'https://source.example/'}),false);
 assert.equal(request('fullscreen',details,{mainFrame:{url:origin+'/'},isDestroyed:()=>false}),false);
 contents.mainFrame.url='https://source.example/';assert.equal(request('fullscreen'),false);
 contents.mainFrame.url=origin+'/';window.emit('closed');assert.equal(request('fullscreen'),false);
 await players.stop();
});
test('verification hosts and stopped host registries never grant UI permissions',async()=>{
 const {defaultSession}=bootstrap(),origin='http://127.0.0.1:9001';
 const contents=Object.assign(new EventEmitter(),{mainFrame:{url:origin+'/'},isDestroyed:()=>false});
 const window=Object.assign(new EventEmitter(),{webContents:contents,isDestroyed:()=>false});
 const players=createIsolatedPlayers({authorizeTarget:async()=>false});players.registerHost(window,origin,'verification');
 function allowed(){let result=false;defaultSession.request?.(contents,'fullscreen',value=>{result=value;},{isMainFrame:true,requestingUrl:origin+'/'});return result;}
 assert.equal(allowed(),false);players.registerHost(window,origin,'viewing');assert.equal(allowed(),true);
 players.registerHost(window,origin,'verification');assert.equal(allowed(),false);
 players.registerHost(window,origin,'viewing');await players.stop();assert.equal(allowed(),false);
});
