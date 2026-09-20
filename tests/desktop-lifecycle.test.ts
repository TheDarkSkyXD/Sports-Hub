import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';

const desktopRequire = createRequire(new URL('../desktop/main.cjs', import.meta.url));
const source = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');

// Exercise the real main-process lifecycle without opening Electron or a server.
function desktopHarness(fetcher: typeof fetch) {
  const messages: unknown[] = [];
  const channels: string[] = [];
  const views: FakeView[] = [];
  const windowState={visible:true,minimized:false,fullscreen:false};
  const handlers=new Map<string,(event:unknown,value:unknown)=>unknown>();
  const ipcMain=Object.assign(new EventEmitter(),{handle:(channel:string,handler:(event:unknown,value:unknown)=>unknown)=>{handlers.set(channel,handler);}});
  const hostContents={mainFrame:{url:'http://127.0.0.1:51931/'},getURL:()=>hostContents.mainFrame.url,getZoomFactor:()=>1,send:(channel:string,value?:unknown)=>{channels.push(channel);messages.push(value);}};
  class FakeContents extends EventEmitter {
    destroyed = false;
    scripts: string[] = [];
    media: {ready:number;time:number;paused:boolean;error?:boolean;ended?:boolean} | null = null;
    audioMuted=true;
    evaluate: ((script:string)=>unknown) | null = null;
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; }
    setAudioMuted(muted:boolean) {this.audioMuted=muted;}
    setWindowOpenHandler() {}
    async loadURL() {}
    async executeJavaScript(script: string) { this.scripts.push(script);return this.evaluate?this.evaluate(script):script.includes('ready:v.readyState')?this.media:null; }
  }
  class FakeView {
    webContents = new FakeContents();
    constructor() { views.push(this); }
    setBackgroundColor() {}
    setVisible() {}
    setBounds() {}
  }
  const app = Object.assign(new EventEmitter(), {
    setName() {}, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), quit() {},
  });
  const context = createContext({
    require: (name: string) => name === 'electron' ? { app, WebContentsView: FakeView,ipcMain } : desktopRequire(name),
    __dirname: fileURLToPath(new URL('../desktop/', import.meta.url)),
    process: { env: {} }, AbortController, AbortSignal, URL,
    fetch: fetcher,
    hostWindow: { isDestroyed: () => false, isVisible:()=>windowState.visible, isMinimized:()=>windowState.minimized,isFullScreen:()=>windowState.fullscreen,setFullScreen:(value:boolean)=>{windowState.fullscreen=value;},getContentSize:()=>[1200,800], contentView: { addChildView() {}, removeChildView() {} }, webContents:hostContents },
  });
  runInContext(source, context);
  runInContext("win=hostWindow;origin='http://127.0.0.1:51931'", context);
  return { run: (script: string) => runInContext(script, context), views, messages,windowState,channels,ipcMain,hostContents,invoke:(channel:string,event:unknown,value:unknown)=>handlers.get(channel)!(event,value) };
}

test('closing a pending desktop player aborts its lookup without creating a late view', async () => {
  let signal: AbortSignal | undefined;
  const harness = desktopHarness((_input, options) => new Promise((_resolve, reject) => {
    signal = options?.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  const opening = harness.run("openPlayer('401872935')") as Promise<unknown>;
  harness.run("closePlayer('401872935')");
  await assert.rejects(opening, /Playback cancelled/);
  assert.ok(signal?.aborted);
  assert.equal(harness.views.length, 0);
  assert.equal(harness.messages.length, 0);
});

test('late events from a replaced desktop player cannot fail its replacement', async () => {
  const harness = desktopHarness(async () => Response.json({ players: [{ label: 'Primary', url: 'https://gooz.aapmains.net/new-stream-embed/123' }] }));
  await harness.run("openPlayer('401872935')");
  const old = harness.views[0].webContents;
  await harness.run("openPlayer('401872935')");
  old.emit('did-fail-load', {}, -2, 'Failed', '', true);
  old.emit('render-process-gone');
  old.emit('did-finish-load');
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.run("players.get('401872935').failed"), false);
  assert.equal(harness.views.length, 2);
});

test('one frozen frame on the final backup cannot restart an endless server cycle', async () => {
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'},{label:'Backup',url:'https://gooz.aapmains.net/new-stream-embed/456'}]}));
  await harness.run("openPlayer('401872935',1,1)");
  harness.run("players.get('401872935').visible=true");
  harness.views[0].webContents.media={ready:4,time:10,paused:false};
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(harness.run("players.get('401872935').attempt"),1);
  harness.run("players.get('401872935').health.lastProgress=Date.now()-26000");
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(harness.run("players.get('401872935').failed"),true);
  assert.equal(harness.views.length,1);
});

test('a provider reload can report playing again after its new media starts',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'}]}));
  await harness.run("openPlayer('401872935')");
  harness.run("players.get('401872935').visible=true");
  harness.views[0].webContents.media={ready:4,time:10,paused:false};
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal((harness.messages.at(-1) as {state:string}).state,'playing');
  harness.views[0].webContents.emit('did-finish-load');
  assert.equal((harness.messages.at(-1) as {state:string}).state,'ready');
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal((harness.messages.at(-1) as {state:string}).state,'playing');
});

test('master controls do not resume failed or recovering hidden players',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'}]}));
  await harness.run("openPlayer('401872935')");
  harness.run("failPlayer('401872935',players.get('401872935'),'Unavailable')");
  const scripts=harness.views[0].webContents.scripts;
  assert.equal(scripts.at(-1),"document.querySelector('video')?.pause()");
  const before=scripts.length;
  await harness.run("applyControl('401872935',players.get('401872935'))");
  assert.equal(scripts.length,before);
  harness.run("players.get('401872935').failed=false;players.get('401872935').recovering=true");
  await harness.run("applyControl('401872935',players.get('401872935'))");
  assert.equal(scripts.length,before);
});

test('statuses retain their originating request ID across replacements and automatic fallback',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'},{label:'Backup',url:'https://gooz.aapmains.net/new-stream-embed/456'}]}));
  await harness.run("openPlayer('401872935',0,0,'first-request')");
  harness.views[0].webContents.emit('did-finish-load');
  const queuedOldStatus=harness.messages.at(-1) as {requestId:string};
  await harness.run("openPlayer('401872935',1,0,'second-request')");
  harness.views[1].webContents.emit('did-finish-load');
  assert.equal(queuedOldStatus.requestId,'first-request');
  assert.equal((harness.messages.at(-1) as {requestId:string}).requestId,'second-request');
  await harness.run("recoverPlayer('401872935',players.get('401872935'))");
  assert.equal(harness.run("players.get('401872935').requestId"),'second-request');
  harness.views[2].webContents.emit('did-finish-load');
  assert.equal((harness.messages.at(-1) as {requestId:string}).requestId,'second-request');
});

test('invalid playback request IDs are rejected before fetching',async()=>{
  let lookups=0;
  const harness=desktopHarness(async()=>{lookups+=1;return Response.json({players:[]});});
  await assert.rejects(harness.run("openPlayer('401872935',0,0,123)"),/Invalid playback request/);
  await assert.rejects(harness.run("openPlayer('401872935',0,0,'x'.repeat(101))"),/Invalid playback request/);
  assert.equal(lookups,0);
});

test('minimized and hidden windows do not spend a stream recovery budget',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'}]}));
  await harness.run("openPlayer('401872935')");
  harness.run("players.get('401872935').visible=true;players.get('401872935').health.lastProgress=Date.now()-60000");
  harness.windowState.minimized=true;
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(harness.run("players.get('401872935').failed"),false);
  assert.equal(harness.views[0].webContents.scripts.length,0);
  harness.windowState.minimized=false;harness.windowState.visible=false;
  harness.run("players.get('401872935').health.lastProgress=Date.now()-60000");
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(harness.run("players.get('401872935').failed"),false);
  harness.windowState.visible=true;
  harness.run("players.get('401872935').health.lastProgress=Date.now()-60000;resetPlaybackGrace()");
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(harness.run("players.get('401872935').failed"),false);
  assert.equal(harness.views.length,1);
});

test('room audio selection releases the provider video mute and still honors master mute',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'}]}));
  await harness.run("openPlayer('401872935')");
  const video={muted:true,volume:1,play:async()=>{},pause:()=>{}};
  const contents=harness.views[0].webContents;
  contents.evaluate=script=>runInNewContext(script,{document:{querySelector:()=>video}});
  harness.run("players.get('401872935').visible=true;control.audio='401872935'");
  await harness.run("applyControl('401872935',players.get('401872935'))");
  assert.equal(video.muted,false);
  assert.equal(video.volume,0.7);
  assert.equal(contents.audioMuted,false);
  harness.run('control.muted=true');
  await harness.run("applyControl('401872935',players.get('401872935'))");
  assert.equal(contents.audioMuted,true);
});

test('pause reaches video elements created or replaced after the original control message',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'}]}));
  await harness.run("openPlayer('401872935')");
  const contents=harness.views[0].webContents;
  let video:{volume:number;muted:boolean;paused:boolean;play:()=>Promise<void>;pause:()=>void}|null=null;
  contents.evaluate=script=>runInNewContext(script,{document:{querySelector:()=>video}});
  harness.run("control.playing=false;control.audio='401872935';players.get('401872935').visible=true");
  await harness.run("applyControl('401872935',players.get('401872935'))");
  assert.equal(contents.audioMuted,true);
  harness.run('installIPC()');
  harness.ipcMain.emit('room:layout',{sender:harness.hostContents,senderFrame:harness.hostContents.mainFrame},[{id:'401872935',x:0,y:0,width:640,height:360,hidden:false}]);
  assert.equal(contents.audioMuted,true);
  const autoplayVideo=()=>({volume:1,muted:false,paused:false,async play(){this.paused=false;},pause(){this.paused=true;}});
  video=autoplayVideo();
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(video.paused,true);
  assert.equal(video.volume,0.7);
  video=autoplayVideo();
  harness.run("players.get('401872935').visible=false");
  await harness.run("checkPlayer('401872935',players.get('401872935'))");
  assert.equal(video.paused,true);
  assert.equal(harness.run("players.get('401872935').failed"),false);
});

test('Escape dismisses an open room overlay before normal fullscreen exit is allowed',()=>{
  const harness=desktopHarness(async()=>Response.json({players:[]}));
  harness.run('installIPC()');
  const event={sender:harness.hostContents,senderFrame:harness.hostContents.mainFrame};
  const value={audio:'',muted:false,playing:true,volume:70,overlayOpen:true};
  harness.ipcMain.emit('room:controls',event,value);
  const press=(type:string,key:string)=>harness.run(`var prevented=0;handleRoomInput({preventDefault(){prevented++}},${JSON.stringify({type,key})});prevented`);
  assert.equal(press('keyDown','Escape'),1);
  assert.equal(harness.channels.at(-1),'room:overlay-escape');
  const sent=harness.channels.length;
  assert.equal(press('keyUp','Escape'),0);
  assert.equal(press('keyDown','f'),0);
  harness.ipcMain.emit('room:controls',event,{...value,overlayOpen:false});
  assert.equal(press('keyDown','Escape'),0);
  assert.equal(harness.channels.length,sent);
  harness.ipcMain.emit('room:controls',event,value);
  harness.hostContents.mainFrame.url='https://example.com/';
  assert.equal(press('keyDown','Escape'),0);
  assert.equal(harness.channels.length,sent);
});

test('room controls require a boolean overlay state from the trusted room',()=>{
  const harness=desktopHarness(async()=>Response.json({players:[]}));
  harness.run('installIPC()');
  const event={sender:harness.hostContents,senderFrame:harness.hostContents.mainFrame};
  const value={audio:'',muted:false,playing:true,volume:70};
  for(const overlayOpen of [undefined,'true',1,null]){
    harness.ipcMain.emit('room:controls',event,{...value,overlayOpen});
    assert.equal(harness.run('control.overlayOpen'),false);
  }
  harness.ipcMain.emit('room:controls',{sender:{},senderFrame:{}},{...value,overlayOpen:true});
  assert.equal(harness.run('control.overlayOpen'),false);
  harness.ipcMain.emit('room:controls',event,{...value,overlayOpen:true});
  assert.equal(harness.run('control.overlayOpen'),true);
});

test('preload overlay Escape subscription removes its exact listener on cleanup',()=>{
  const ipcRenderer=Object.assign(new EventEmitter(),{invoke:async()=>{},send:()=>{}});
  let api: {onOverlayEscape:(callback:()=>void)=>()=>void} | undefined;
  runInNewContext(readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_name:string,value:typeof api)=>{api=value;}}}),
  });
  let calls=0;
  const unsubscribe=api!.onOverlayEscape(()=>{calls++;});
  ipcRenderer.emit('room:overlay-escape',{});
  assert.equal(calls,1);
  unsubscribe();
  ipcRenderer.emit('room:overlay-escape',{});
  assert.equal(calls,1);
  assert.equal(ipcRenderer.listenerCount('room:overlay-escape'),0);
});

test('native fullscreen IPC validates its sender and reports actual window state',()=>{
  const harness=desktopHarness(async()=>Response.json({players:[]}));
  harness.run('installIPC()');
  const event={sender:harness.hostContents,senderFrame:harness.hostContents.mainFrame};
  assert.throws(()=>harness.invoke('room:set-fullscreen',event,'true'),/Invalid fullscreen request/);
  assert.throws(()=>harness.invoke('room:set-fullscreen',{sender:{},senderFrame:{}},true),/Invalid fullscreen request/);
  assert.equal(harness.windowState.fullscreen,false);
  assert.equal(harness.invoke('room:set-fullscreen',event,true),true);
  assert.equal(harness.windowState.fullscreen,true);
  harness.run('notifyFullscreen(true)');
  assert.equal(harness.channels.at(-1),'room:fullscreen-change');
  assert.equal(harness.messages.at(-1),true);
  assert.equal(harness.invoke('room:set-fullscreen',event,false),false);
  harness.run('notifyFullscreen(false)');
  assert.equal(harness.messages.at(-1),false);
});

test('native fullscreen transition notifications do not read a lagging window state',()=>{
  const harness=desktopHarness(async()=>Response.json({players:[]}));
  // Windows may emit leave-full-screen while isFullScreen still reports true.
  harness.windowState.fullscreen=true;
  harness.run('notifyFullscreen(false)');
  assert.equal(harness.messages.at(-1),false);
  // Enter notifications likewise carry the event state, not the previous state.
  harness.windowState.fullscreen=false;
  harness.run('notifyFullscreen(true)');
  assert.equal(harness.messages.at(-1),true);
});

test('native fullscreen Escape closes the overlay first, then the window fullscreen',()=>{
  const harness=desktopHarness(async()=>Response.json({players:[]}));
  harness.windowState.fullscreen=true;
  harness.run("control.overlayOpen=true;handleRoomInput({preventDefault(){}},{type:'keyDown',key:'Escape'})");
  assert.equal(harness.windowState.fullscreen,true);
  assert.equal(harness.channels.at(-1),'room:overlay-escape');
  harness.run("control.overlayOpen=false;handleRoomInput({preventDefault(){}},{type:'keyDown',key:'Escape'})");
  assert.equal(harness.windowState.fullscreen,false);
});

test('Escape exits native fullscreen when a current visible provider owns keyboard focus',async()=>{
  const harness=desktopHarness(async()=>Response.json({players:[{label:'Primary',url:'https://gooz.aapmains.net/new-stream-embed/123'}]}));
  await harness.run("openPlayer('401872935')");
  const contents=harness.views[0].webContents;
  harness.windowState.fullscreen=true;
  let prevented=false;
  const event={preventDefault(){prevented=true;}};
  contents.emit('before-input-event',event,{type:'keyDown',key:'Escape'});
  assert.equal(prevented,false);
  assert.equal(harness.windowState.fullscreen,true);
  harness.run("players.get('401872935').visible=true");
  contents.emit('before-input-event',event,{type:'keyDown',key:'Escape'});
  assert.equal(prevented,true);
  assert.equal(harness.windowState.fullscreen,false);
  await harness.run("openPlayer('401872935')");
  harness.windowState.fullscreen=true;prevented=false;
  contents.emit('before-input-event',event,{type:'keyDown',key:'Escape'});
  assert.equal(prevented,false);
  assert.equal(harness.windowState.fullscreen,true);
});

test('preload native fullscreen bridge forwards requests and cleans up state listeners',async()=>{
  const requests:unknown[][]=[];
  const ipcRenderer=Object.assign(new EventEmitter(),{invoke:async(...args:unknown[])=>{requests.push(args);return true;},send:()=>{}});
  let api: {setFullscreen:(value:boolean)=>Promise<boolean>;onFullscreenChange:(callback:(value:boolean)=>void)=>()=>void} | undefined;
  runInNewContext(readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_name:string,value:typeof api)=>{api=value;}}}),
  });
  assert.equal(await api!.setFullscreen(true),true);
  assert.deepEqual(requests,[['room:set-fullscreen',true]]);
  const states:boolean[]=[];
  const unsubscribe=api!.onFullscreenChange(value=>states.push(value));
  ipcRenderer.emit('room:fullscreen-change',{},true);
  ipcRenderer.emit('room:fullscreen-change',{},'bad');
  ipcRenderer.emit('room:fullscreen-change',{},false);
  unsubscribe();
  ipcRenderer.emit('room:fullscreen-change',{},true);
  assert.deepEqual(states,[true,false]);
  assert.equal(ipcRenderer.listenerCount('room:fullscreen-change'),0);
});
