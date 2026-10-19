import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext,runInThisContext} from 'node:vm';
import test from 'node:test';
import verificationPolicy from '../lib/playback/verification-policy.json' with {type:'json'};

const file=new URL('../desktop/isolated-player.cjs',import.meta.url);
const localRequire=createRequire(file);
const target={sessionId:'d03a2653-5d97-4453-8e6b-681861777337',candidateId:'selected',gameId:'nba-123',generation:2};
const player={url:'https://embed.st/embed/basketball/game/1',referer:'https://ppv.st/events/game'};
const hasKind=(value:unknown,kind:'decoded'|'failed')=>typeof value==='object'&&value!==null&&'kind' in value&&value.kind===kind;
function ipcHarness(){
  const handlers=new Map<string,(event:object,value?:unknown)=>Promise<unknown>>();
  const ipcMain={handle:(name:string,handler:(event:object,value?:unknown)=>Promise<unknown>)=>{assert.equal(handlers.has(name),false);handlers.set(name,handler);},
    removeHandler:(name:string)=>{handlers.delete(name);}};
  return {handlers,ipcMain};
}
function harness({purpose='viewing',load,chromeLoad,onLoad,ipc,evaluate}:{purpose?:'viewing'|'verification';load?:Promise<void>;chromeLoad?:Promise<void>;ipc?:ReturnType<typeof ipcHarness>;evaluate?:(source:string)=>unknown;
  onLoad?:(layout:{bounds:object;visible:boolean})=>void}={}){
  const sessions:Session[]=[];
  const views:View[]=[];
  let valid=true;
  let authorize:Promise<boolean>|undefined;
  let poll:(()=>void)|undefined;
  const states:unknown[]=[];
  const scripts:{source:string;gesture:boolean}[]=[];
  const chromeStates:unknown[]=[];
  const gestures:{source:string;gesture:boolean}[]=[];
  const {handlers,ipcMain}=ipc??ipcHarness();
  let presentation:unknown;
  let commandResult:Promise<{kind:'control';result:{kind:'applied'};presentation:unknown}>|undefined;
  let sample={kind:'video',time:1,frames:10,width:320,height:180,playing:true};
  const child={url:'https://xstream.st/fslivepro.php?stream=F128',parent:null as object|null,isDestroyed:()=>false,
    executeJavaScript:async(source:string,gesture=false)=>{scripts.push({source,gesture});if(evaluate)return evaluate(source);return source.includes('"command":')?
      commandResult??{kind:'control',result:{kind:'applied'},presentation}:{...sample,...(presentation?{presentation}:{})};}};
  const main={url:player.url,framesInSubtree:[child],isDestroyed:()=>false,
    executeJavaScript:async()=>({kind:'frame',url:child.url})};
  child.parent=main;
  class Session extends EventEmitter {
    cookies:string[]=[];workers=true;cleanup:Promise<void>|undefined;
    history:string[]=[];
    serviceWorkers={getAllRunning:()=>this.workers?{1:{scope:'old-player'}}:{}};
    request:((details:object,callback:(result:object)=>void)=>void)|null=null;
    permission:((contents:object,name:string,callback:(allowed:boolean)=>void)=>void)|null=null;
    webRequest={onBeforeRequest:(hook:typeof this.request)=>{this.request=hook;}};
    setPermissionRequestHandler(hook:typeof this.permission){this.permission=hook;}
    setPermissionCheckHandler(){}
    async clearStorageData(){this.history.push('storage');this.cookies=[];this.workers=false;}
    async clearAuthCache(){this.history.push('auth');}
    async clearCache(){this.history.push('cache');}
    async closeAllConnections(){this.history.push('connections');await this.cleanup;}
  }
  class View {
    bounds={x:0,y:0,width:0,height:0};visible=false;closed=false;policy='';loaded='';muted=true;background='';focuses=0;
    prefs:Record<string,unknown>;
    webContents=Object.assign(new EventEmitter(),{
      isDestroyed:()=>this.closed,
      mainFrame:{url:'about:blank'},
      setWebRTCIPHandlingPolicy:(value:string)=>{this.policy=value;},
      setAudioMuted:(value:boolean)=>{this.muted=value;},
      setWindowOpenHandler:(handler:()=>object)=>{assert.deepEqual(handler(),{action:'deny'});},
      loadURL:async(url:string)=>{this.loaded=url;this.webContents.mainFrame.url=url;if(this.prefs.preload)await chromeLoad;
        else{assert.equal(this.policy,'disable_non_proxied_udp');onLoad?.(this);await load;}},
      executeJavaScript:async()=>null,
      send:(_channel:string,value:unknown)=>{chromeStates.push(value);},
      setBackgroundColor:(value:string)=>{this.background=value;},
      close:()=>{this.closed=true;this.webContents.emit('destroyed');},
      focus:()=>{this.focuses++;},
    });
    constructor(prefs:Record<string,unknown>){this.prefs=prefs;if(!prefs.preload)this.webContents.mainFrame=main;views.push(this);}
    setBounds(value:typeof this.bounds){this.bounds=value;}
    setBackgroundColor(value:string){this.background=value;}
    setVisible(value:boolean){this.visible=value;}
  }
  const children:View[]=[];
  const hostContents=Object.assign(new EventEmitter(),{session:{},mainFrame:{url:'http://127.0.0.1:9000/'},isDestroyed:()=>false,
    executeJavaScript:async(source:string,gesture:boolean)=>{gestures.push({source,gesture});return true;},send(_channel:string,value:unknown){states.push(value);}});
  const host=Object.assign(new EventEmitter(),{webContents:hostContents,isDestroyed:()=>false,
    getContentBounds:()=>({x:0,y:0,width:900,height:600}),
    contentView:{addChildView(view:View){const prior=children.indexOf(view);if(prior>=0)children.splice(prior,1);children.push(view);},
      removeChildView(view:View){const prior=children.indexOf(view);if(prior>=0)children.splice(prior,1);}},
  });
  const factory=runInThisContext(`(function(require,module,setInterval,clearInterval){${readFileSync(file,'utf8')};return module.exports;})`)(
    (id:string)=>id==='electron'?{ipcMain}:localRequire(id),{exports:{}},(callback:()=>void)=>{poll=callback;return 1;},()=>{},
  ).createIsolatedPlayers({
    authorizeTarget:async()=>authorize??valid,
    createSession:()=>{const value=new Session();sessions.push(value);return value;},
    createView:(preferences:Record<string,unknown>)=>new View(preferences),
    createProxy:()=>({credentials:{username:'fixture',password:'fixture'},start:async()=>{},stop(){}}),
  });
  factory.registerHost(host,'http://127.0.0.1:9000',purpose);
  const event={sender:hostContents,senderFrame:hostContents.mainFrame};
  return {factory,host,event,sessions,views,states,child,main,scripts,chromeStates,gestures,children,handlers,
    async ready(view:View){return handlers.get('sunday-player-controls:ready')?.({sender:view.webContents,senderFrame:view.webContents.mainFrame});},
    async dispatch(view:View,value:unknown){const handler=handlers.get('sunday-player-controls:dispatch');assert.ok(handler);return handler({sender:view.webContents,senderFrame:view.webContents.mainFrame},value);},
    setPresentation(value:unknown){presentation=value;},
    pendingControl(value:NonNullable<typeof commandResult>){commandResult=value;},
    async advance(time:number,frames:number){sample={...sample,time,frames};poll?.();for(let turn=0;turn<12;turn++)await Promise.resolve();},
    pendingAuthorization(value:Promise<boolean>){authorize=value;},invalidate(){valid=false;}};
}

function mediaFixture(rejections=0){
  let plays=0;
  const video={tagName:'VIDEO',isConnected:true,parentElement:null,paused:true,seeking:false,readyState:4,ended:false,
    currentTime:1,frames:10,videoWidth:320,videoHeight:180,duration:Infinity,volume:0,muted:true,controls:true,
    style:{setProperty(){}},checkVisibility:()=>true,getBoundingClientRect:()=>({left:0,top:0,right:640,bottom:360}),
    getVideoPlaybackQuality:()=>({totalVideoFrames:video.frames,droppedVideoFrames:0}),
    async play(){plays++;if(rejections-->0)throw new DOMException('Fixture play interrupted','AbortError');video.paused=false;},
    pause(){video.paused=true;},requestPictureInPicture:async()=>{page.pictureInPictureElement=video;}};
  const page={documentElement:{inert:false},pictureInPictureEnabled:true,pictureInPictureElement:null as typeof video|null,
    async exitPictureInPicture(){page.pictureInPictureElement=null;},
    querySelectorAll:(selector:string)=>selector.startsWith('#')?[]:[video]};
  const h=harness({evaluate:source=>runInNewContext(source,{document:page,window:{},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})})});
  return {...h,video,page,plays:()=>plays};
}

async function sampleMedia(h:ReturnType<typeof mediaFixture>,tick:(ms:number)=>void,count:number,moving=false){
  for(let sample=0;sample<count;sample++){
    tick(500);
    if(moving){h.video.currentTime+=0.5;h.video.frames+=12;}
    await h.advance(h.video.currentTime,h.video.frames);
  }
}

async function provedMedia(h:ReturnType<typeof mediaFixture>,tick:(ms:number)=>void){
  const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
  await h.factory.update(h.event,{capability,playing:true,visible:true,bounds:{x:0,y:0,width:640,height:360}});await h.advance(1,10);
  await sampleMedia(h,tick,5,true);
  assert.equal(h.states.some(state=>hasKind(state,'decoded')),true,'The freeze test requires actual advancing-video proof first');
  assert.equal(h.views[0].visible,true);
  return capability;
}

for(const frozen of ['time-and-frames','frames'] as const)test(`proved native ${frozen} freeze fails once after fifteen seconds`,async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=mediaFixture(),tick=(ms:number)=>context.mock.timers.tick(ms);
  try{
    const capability=await provedMedia(h,tick);
    for(let sample=0;sample<29;sample++){
      if(frozen==='frames')h.video.currentTime+=0.5;
      await sampleMedia(h,tick,1);
    }
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    if(frozen==='frames')h.video.currentTime+=0.5;
    await sampleMedia(h,tick,1);
    assert.deepEqual(h.states.filter(state=>hasKind(state,'failed')),[{capability,kind:'failed',reason:'upstream'}]);
    assert.equal(h.views[0].closed,true);
    await sampleMedia(h,tick,4);
    assert.equal(h.states.filter(state=>hasKind(state,'failed')).length,1);
    assert.equal(h.views.length,1,'Native freeze recovery must not allocate its own replacement player');
  }finally{await h.factory.stop();}
});

for(const stalled of ['buffering','rejected-resume'] as const)test(`proved native ${stalled} enters recovery after fifteen seconds`,async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=mediaFixture(),tick=(ms:number)=>context.mock.timers.tick(ms);
  try{
    const capability=await provedMedia(h,tick);
    if(stalled==='buffering')h.video.readyState=1;
    else{
      h.video.pause();
      h.video.play=async()=>{throw new DOMException('Fixture resume interrupted','AbortError');};
    }
    await sampleMedia(h,tick,29);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    await sampleMedia(h,tick,1);
    assert.deepEqual(h.states.filter(state=>hasKind(state,'failed')),[{capability,kind:'failed',reason:'upstream'}]);
    assert.equal(h.views[0].closed,true);
  }finally{await h.factory.stop();}
});

test('healthy native frames and media advancement keep a proved player alive',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=mediaFixture(),tick=(ms:number)=>context.mock.timers.tick(ms);
  try{
    await provedMedia(h,tick);await sampleMedia(h,tick,34,true);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    assert.equal(h.views[0].closed,false);
  }finally{await h.factory.stop();}
});

for(const inactive of ['paused','hidden','pip','ended','seeking'] as const)test(`native ${inactive} state resets post-proof freeze timing`,async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=mediaFixture(),tick=(ms:number)=>context.mock.timers.tick(ms);
  try{
    const capability=await provedMedia(h,tick);
    await sampleMedia(h,tick,20);
    if(inactive==='paused')await h.factory.update(h.event,{capability,playing:false});
    else if(inactive==='hidden')await h.factory.update(h.event,{capability,visible:false});
    else if(inactive==='pip')h.page.pictureInPictureElement=h.video;
    else{h.video[inactive]=true;if(inactive==='ended')h.video.pause();}
    await sampleMedia(h,tick,34);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    assert.equal(h.views[0].closed,false);
    if(inactive==='paused')await h.factory.update(h.event,{capability,playing:true});
    else if(inactive==='hidden')await h.factory.update(h.event,{capability,visible:true});
    else if(inactive==='pip')h.page.pictureInPictureElement=null;
    else h.video[inactive]=false;
    await h.advance(h.video.currentTime,h.video.frames);
    await sampleMedia(h,tick,1,true);await sampleMedia(h,tick,29);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false,'Returning to active playback starts a fresh freeze interval');
    await sampleMedia(h,tick,1);
    assert.deepEqual(h.states.filter(state=>hasKind(state,'failed')),[{capability,kind:'failed',reason:'upstream'}]);
  }finally{await h.factory.stop();}
});

test('a native sampler gap does not count as fifteen seconds of observed freeze',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=mediaFixture(),tick=(ms:number)=>context.mock.timers.tick(ms);
  try{
    const capability=await provedMedia(h,tick);await sampleMedia(h,tick,20);
    tick(20_000);await h.advance(h.video.currentTime,h.video.frames);
    await sampleMedia(h,tick,29);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    await sampleMedia(h,tick,1);
    assert.deepEqual(h.states.filter(state=>hasKind(state,'failed')),[{capability,kind:'failed',reason:'upstream'}]);
  }finally{await h.factory.stop();}
});

test('native viewer freeze recovery does not replace the startup proof deadline',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=mediaFixture(),tick=(ms:number)=>context.mock.timers.tick(ms);
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,playing:true,visible:true});await sampleMedia(h,tick,34);
    assert.equal(h.states.some(state=>hasKind(state,'decoded')),false);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    assert.equal(h.views[0].closed,false);
  }finally{await h.factory.stop();}
});

test('native playback resumes an unsolicited pause without overriding an explicit pause',async()=>{
  const h=mediaFixture();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);
    assert.equal(h.video.paused,false);
    h.video.pause();await h.advance(1,10);
    assert.equal(h.video.paused,false,'A provider pause must resume while playback is requested');
    await h.factory.update(h.event,{capability,playing:false});await h.advance(1,10);await h.advance(1,10);
    assert.equal(h.video.paused,true,'An explicit pause must survive later samples');
    assert.equal(h.plays(),2);
  }finally{await h.factory.stop();}
});

test('an unfocused player resumes an unsolicited pause while partly below the host',async()=>{
  const h=mediaFixture();
  h.video.getBoundingClientRect=()=>{
    const {width,height}=h.views[0].bounds;
    return {left:0,top:0,right:width,bottom:height};
  };
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:343,height:193},visible:true,playing:true,focused:false});
    await h.advance(1,10);
    assert.equal(h.video.paused,false);
    await h.factory.update(h.event,{capability,bounds:{x:0,y:532,width:343,height:193}});
    await h.advance(1,10);
    h.video.pause();await h.advance(1,10);
    assert.equal(h.views[0].visible,true);
    assert.equal(h.video.paused,false,'A partially visible tile must retain playback reconciliation');
    assert.equal(h.plays(),2);
    assert.equal(h.video.controls,false);
  }finally{await h.factory.stop();}
});

test('native playback retries a rejected play without a new layout command',async()=>{
  const h=mediaFixture(1);
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,playing:true});
    await h.advance(1,10);await h.advance(1,10);
    assert.equal(h.video.paused,false);
    assert.equal(h.plays(),2);
  }finally{await h.factory.stop();}
});

test('native playback does not restart an ended video during pause reconciliation',async()=>{
  const h=mediaFixture();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);
    h.video.ended=true;h.video.pause();await h.advance(1,10);
    assert.equal(h.video.paused,true);
    assert.equal(h.plays(),1);
  }finally{await h.factory.stop();}
});

test('native PiP pauses survive exit until the renderer acknowledges their playback state',async()=>{
  const h=mediaFixture();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);
    h.page.pictureInPictureElement=h.video;h.video.pause();
    await h.advance(1,10);await h.advance(1,10);
    assert.equal(h.video.paused,true,'Automatic resume must not override native PiP controls');
    h.page.pictureInPictureElement=null;
    await h.advance(1,10);await h.advance(1,10);
    await h.factory.update(h.event,{capability,playing:true,volume:0.5});await h.advance(1,10);
    assert.equal(h.video.paused,true,'A stale layout must not undo the PiP pause after exit');
    assert.equal(h.plays(),1);
    await h.factory.update(h.event,{capability,playing:false});await h.advance(1,10);
    assert.equal(h.video.paused,true);
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);
    assert.equal(h.video.paused,false);
    assert.equal(h.plays(),2);
  }finally{await h.factory.stop();}
});

test('a control-path PiP exit preserves an unsampled pause until the renderer acknowledges it',async()=>{
  const h=mediaFixture();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);
    h.page.pictureInPictureElement=h.video;await h.advance(1,10);
    h.video.pause();
    assert.equal((await h.factory.control(h.event,{capability,command:{kind:'set-picture-in-picture',active:false}})).kind,'applied');
    assert.equal(h.page.pictureInPictureElement,null);
    await h.advance(1,10);await h.advance(1,10);
    assert.equal(h.video.paused,true,'PiP control publication must preserve the pause before sampling');
    assert.equal(h.plays(),1);
    await h.factory.update(h.event,{capability,playing:false});await h.advance(1,10);
    assert.equal(h.video.paused,true);
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);
    assert.equal(h.video.paused,false);
    assert.equal(h.plays(),2);
  }finally{await h.factory.stop();}
});

test('playback intent is applied once while presentation snapshots publish only changes',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    const presentation={playing:true,playback:'live',pip:{kind:'available',active:false},quality:{kind:'unavailable'}};
    h.setPresentation(presentation);
    await h.factory.update(h.event,{capability,playing:true});await h.advance(1,10);await h.advance(2,20);
    assert.equal(h.scripts.filter(script=>script.source.includes('"playing":true')).length,1);
    assert.deepEqual(h.states,[{capability,kind:'presentation',presentation}]);
    h.setPresentation({...presentation,playing:false});await h.advance(2,20);
    assert.equal(h.states.length,2);
    await h.factory.update(h.event,{capability,volume:0.5,playing:true});await h.advance(2,20);
    assert.equal(h.scripts.filter(script=>script.source.includes('"playing":true')).length,1);
  }finally{await h.factory.stop();}
});

test('explicit picture in picture reaches only the selected final frame with a user gesture',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    const result=await h.factory.control(h.event,{capability,command:{kind:'set-picture-in-picture',active:true}});
    assert.deepEqual(result,{kind:'applied'});
    assert.equal(h.scripts.filter(script=>script.gesture).length,1);
    assert.equal(h.scripts.find(script=>script.gesture)?.source.includes('"command":{"kind":"set-picture-in-picture","active":true}'),true);
    await assert.rejects(h.factory.control(h.event,{capability,command:{kind:'set-picture-in-picture',active:'yes'}}));
    h.child.parent={};
    assert.deepEqual(await h.factory.control(h.event,{capability,command:{kind:'set-picture-in-picture',active:true}}),{kind:'unavailable',reason:'no-selected-video'});
  }finally{await h.factory.stop();}
});

test('a dormant selected-player capability creates no renderer or network session',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    assert.match(capability,/^[a-f0-9-]{36}$/);
    assert.equal(h.views.length,0);assert.equal(h.sessions.length,0);
    await assert.rejects(h.factory.offer({target,player:{...player,url:'https://ppv.st/events/game'}}));
    await assert.rejects(h.factory.offer({target,player:{...player,url:'https://embed.st.evil.example/embed/basketball/game/1'}}));
  }finally{h.factory.stop();}
});

test('only a registered host main frame can mount; the player is sandboxed without preload',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await assert.rejects(h.factory.mount({...h.event,senderFrame:{}},{capability}));
    await h.factory.mount(h.event,{capability});
    assert.equal(h.views.length,1);
    const view=h.views[0];
    assert.equal(view.prefs.disableDialogs,true);assert.equal(view.prefs.sandbox,true);assert.equal(view.prefs.contextIsolation,true);
    assert.equal(view.prefs.nodeIntegration,false);assert.equal(view.prefs.preload,undefined);
    assert.equal(view.loaded,player.url);
    const decisions:object[]=[];
    h.sessions[0].request?.({url:'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',resourceType:'script'},value=>decisions.push(value));
    h.sessions[0].request?.({url:'http://127.0.0.1/private',resourceType:'xhr'},value=>decisions.push(value));
    assert.deepEqual(decisions,[{cancel:true},{cancel:true}]);
    let denied=false;
    h.sessions[0].permission?.({},'media',allowed=>{denied=!allowed;});assert.equal(denied,true);
  }finally{h.factory.stop();}
});

test('partly visible players keep their viewport; occlusion hides and mutes the native view',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await h.factory.mount(h.event,{capability});
    for(const bounds of [{x:800,y:500,width:400,height:300},{x:-100,y:-50,width:400,height:300}]){
      await h.factory.update(h.event,{capability,bounds,visible:true,playing:true,audible:true,volume:0.5,focused:true});
      assert.deepEqual(h.views[0].bounds,bounds);
      assert.equal(h.views[0].visible,true);assert.equal(h.views[0].muted,false);
    }
    await h.factory.update(h.event,{capability,visible:false});
    assert.equal(h.views[0].visible,false);assert.equal(h.views[0].muted,true);
    for(const bounds of [{x:900,y:0,width:400,height:300},{x:0,y:600,width:400,height:300},
      {x:-400,y:0,width:400,height:300},{x:0,y:-300,width:400,height:300}]){
      await h.factory.update(h.event,{capability,bounds,visible:true});
      assert.equal(h.views[0].visible,false);assert.equal(h.views[0].muted,true);
    }
  }finally{h.factory.stop();}
});

test('a pending mount applies its requested visible bounds before navigating the player',async()=>{
  const bounds={x:10,y:20,width:640,height:360};
  const h=harness({onLoad:layout=>{assert.deepEqual(layout.bounds,bounds);assert.equal(layout.visible,true);}});
  try{
    const capability=await h.factory.offer({target,player});
    const authorization=Promise.withResolvers<boolean>();h.pendingAuthorization(authorization.promise);
    const mounting=h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds,visible:true,playing:true,audible:false,volume:0});
    authorization.resolve(true);
    await mounting;
  }finally{await h.factory.stop();}
});

test('release destroys the session and revocation prevents a stale generation from mounting',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await h.factory.mount(h.event,{capability});
    h.factory.release(h.event,{capability});
    assert.equal(h.views[0].closed,true);
    h.invalidate();
    await assert.rejects(h.factory.mount(h.event,{capability}));
    h.factory.revoke(capability);
    await assert.rejects(h.factory.mount(h.event,{capability}));
  }finally{h.factory.stop();}
});

test('host destruction disposes mounted players without affecting another host',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await h.factory.mount(h.event,{capability});
    h.host.emit('closed');assert.equal(h.views[0].closed,true);
    await assert.rejects(h.factory.mount(h.event,{capability}));
  }finally{h.factory.stop();}
});

test('decoded evidence follows the selected nested frame and rejects a changed parent edge',async context=>{
  context.mock.timers.enable({apis:['Date']});
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await h.factory.mount(h.event,{capability});
    await h.advance(1,10);
    context.mock.timers.tick(2100);await h.advance(3.1,73);
    assert.equal(h.states.length,1);
    assert.deepEqual(h.states[0],{capability,kind:'decoded',proof:{kind:'advancing-video',version:1,
      startupMs:2100,observedMs:2100,mediaAdvanceMs:2100,presentedFrames:64}});
    h.child.parent={};
    context.mock.timers.tick(60_000);await h.advance(64,1900);
    context.mock.timers.tick(2100);await h.advance(66.1,1963);
    assert.equal(h.states.length,1);
  }finally{h.factory.stop();}
});

test('a verification player with no owned media progress fails after twelve seconds',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=harness({purpose:'verification'});
  try{
    const capability=await h.factory.offer({target:{...target,purpose:'verification'},player});
    await h.factory.mount(h.event,{capability});
    await h.advance(1,10);
    context.mock.timers.tick(6000);await h.advance(1,10);
    context.mock.timers.tick(5999);await h.advance(1,10);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    context.mock.timers.tick(1);
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.deepEqual(h.states.slice(0,2),[
      {capability,kind:'failed',reason:'upstream'},
      {capability,kind:'ended'},
    ]);
    assert.equal(h.views[0].closed,true);
  }finally{await h.factory.stop();}
});

test('late owned media advancement keeps verification alive for full playback proof',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=harness({purpose:'verification'});
  try{
    const capability=await h.factory.offer({target:{...target,purpose:'verification'},player});
    await h.factory.mount(h.event,{capability});
    await h.advance(1,10);
    context.mock.timers.tick(5500);await h.advance(1,10);
    context.mock.timers.tick(6000);await h.advance(1.5,20);
    context.mock.timers.tick(500);
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    context.mock.timers.tick(2100);await h.advance(3.6,73);
    assert.equal(h.states.some(state=>hasKind(state,'decoded')),true);
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    context.mock.timers.tick(12000);
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
  }finally{await h.factory.stop();}
});

test('viewing players do not use the verification no-progress cutoff',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await h.factory.mount(h.event,{capability});
    await h.advance(1,10);
    context.mock.timers.tick(12000);
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
    assert.equal(h.views[0].closed,false);
  }finally{await h.factory.stop();}
});

test('verification timeout covers hung navigation and late completion stays inert',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const loading=Promise.withResolvers<void>();
  const h=harness({purpose:'verification',load:loading.promise});
  try{
    const capability=await h.factory.offer({target:{...target,purpose:'verification'},player});
    const mounting=h.factory.mount(h.event,{capability});
    for(let turn=0;turn<100&&h.views[0]?.loaded!==player.url;turn++)await Promise.resolve();
    assert.equal(h.views.length,1);
    assert.equal(h.views[0].loaded,player.url);
    context.mock.timers.tick(12000);
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.deepEqual(h.states.slice(0,2),[
      {capability,kind:'failed',reason:'upstream'},
      {capability,kind:'ended'},
    ]);
    assert.equal(h.views[0].closed,true);
    loading.resolve();
    await assert.rejects(mounting);
    assert.equal(h.states.length,2);
  }finally{await h.factory.stop();}
});

test('closing a host during authorization prevents any late renderer or session allocation',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player}),pending=Promise.withResolvers<boolean>();
    h.pendingAuthorization(pending.promise);
    const mounting=h.factory.mount(h.event,{capability});
    h.host.emit('closed');pending.resolve(true);
    await assert.rejects(mounting);
    assert.equal(h.views.length,0);assert.equal(h.sessions.length,0);
  }finally{h.factory.stop();}
});

test('host cleanup never reads BrowserWindow.webContents after Electron destroys its native object',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});
    await h.factory.mount(h.event,{capability});
    Object.defineProperty(h.host,'webContents',{get(){throw new Error('Object has been destroyed');}});
    assert.doesNotThrow(()=>h.host.emit('closed'));
    assert.equal(h.views[0].closed,true);
  }finally{h.factory.stop();}
});

test('a nested frame loads only through the unique selected parent iframe edge',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    const decisions:object[]=[];
    h.sessions[0].request?.({url:'https://other.example/other-player',resourceType:'subFrame',frame:{parent:h.main}},value=>decisions.push(value));
    h.sessions[0].request?.({url:h.child.url,resourceType:'subFrame',frame:h.child},value=>decisions.push(value));
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.deepEqual(decisions,[{cancel:true},{cancel:false}]);
  }finally{h.factory.stop();}
});

test('released players reuse a bounded session only after cookies, workers, auth and cache are cleared',async()=>{
  const h=harness();
  try{
    const first=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability:first});
    h.sessions[0].cookies=['old-game=private'];h.sessions[0].workers=true;
    await h.factory.release(h.event,{capability:first});
    const next=await h.factory.offer({target:{...target,generation:3},player});await h.factory.mount(h.event,{capability:next});
    assert.equal(h.sessions.length,1);
    assert.deepEqual(h.sessions[0].cookies,[]);assert.equal(h.sessions[0].workers,false);
    assert.deepEqual(h.sessions[0].history,['connections','auth','storage','cache']);
    assert.equal(h.views[1].prefs.session,h.sessions[0]);
  }finally{h.factory.stop();}
});

test('pending cleanup consumes its pool slot and never allocates an unbounded replacement',async()=>{
  const h=harness();
  try{
    const capabilities=[];
    const limit=verificationPolicy.concurrency+4;
    for(let generation=0;generation<limit;generation++){
      const capability=await h.factory.offer({target:{...target,generation},player});capabilities.push(capability);
      await h.factory.mount(h.event,{capability});
    }
    const gate=Promise.withResolvers<void>();h.sessions[0].cleanup=gate.promise;
    const release=h.factory.release(h.event,{capability:capabilities[0]});
    const next=await h.factory.offer({target:{...target,generation:9},player});
    await assert.rejects(h.factory.mount(h.event,{capability:next}),{name:'PlayerCapacityError'});
    assert.equal(h.sessions.length,limit);gate.resolve();await release;
    await h.factory.mount(h.event,{capability:next});assert.equal(h.sessions.length,limit);
  }finally{h.factory.stop();}
});

test('release during authorization cancels a pending mount without allocating a late player',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player}),pending=Promise.withResolvers<boolean>();
    h.pendingAuthorization(pending.promise);
    const mounting=h.factory.mount(h.event,{capability});
    await h.factory.release(h.event,{capability});pending.resolve(true);
    await assert.rejects(mounting);
    assert.equal(h.views.length,0);assert.equal(h.sessions.length,0);
  }finally{h.factory.stop();}
});

test('releasing an isolated view preserves application-wide session download protection',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    let blocked=0;h.sessions[0].on('will-download',()=>{blocked++;});
    await h.factory.release(h.event,{capability});h.sessions[0].emit('will-download');
    assert.equal(blocked,1);
  }finally{h.factory.stop();}
});

function snapshotBinding(value:unknown){
  assert.ok(value&&typeof value==='object'&&'binding'in value&&typeof value.binding==='string');
  return value.binding;
}

test('focused native controls use one lazy local overlay with the host session',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    assert.equal(h.views.length,1);
    const layout={capability,bounds:{x:10,y:20,width:640,height:360},visible:true,focused:true,playing:true,audible:true,volume:0.5,
      controls:{label:'Race',fullscreen:false}};
    await h.factory.update(h.event,layout);
    assert.equal(h.views.length,2);
    const chrome=h.views[1];
    assert.equal(chrome.loaded,'http://127.0.0.1:9000/player-controls');
    assert.equal(chrome.prefs.session,h.host.webContents.session);
    assert.match(String(chrome.prefs.preload),/player-controls-preload\.cjs$/);
    assert.equal(h.views[0].prefs.preload,undefined);
    assert.equal(h.sessions.length,1);
    assert.equal(chrome.background,'#00000000');
    assert.deepEqual(chrome.bounds,layout.bounds);assert.equal(chrome.visible,false);
    const snapshot=await h.ready(chrome),binding=snapshotBinding(snapshot);
    assert.equal(chrome.visible,true);
    assert.deepEqual(snapshot,{binding,label:'Race',playing:true,audible:true,volume:50,fullscreen:false,presentation:null});
    const publications=h.chromeStates.length,focuses=chrome.focuses;
    await h.factory.update(h.event,layout);
    assert.equal(h.chromeStates.length,publications);assert.equal(chrome.focuses,focuses);
    const next=await h.factory.offer({target:{...target,generation:3},player});await h.factory.mount(h.event,{capability:next});
    assert.equal(h.children.at(-1),chrome);
    await h.factory.update(h.event,{...layout,capability:next,controls:{label:'Football',fullscreen:false}});
    assert.equal(h.views.length,3);
    assert.notEqual(snapshotBinding(await h.ready(chrome)),binding);
    await h.factory.update(h.event,{capability:next,visible:false});
    assert.equal(chrome.visible,false);assert.equal(await h.ready(chrome),null);
  }finally{await h.factory.stop();}
});

test('overlay rejects stale bindings, source senders, wrong frames, and routes',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    const layout={capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,playing:true,
      controls:{label:'Race',fullscreen:false}};
    await h.factory.update(h.event,layout);
    assert.equal(h.views.length,2);
    const chrome=h.views[1],binding=snapshotBinding(await h.ready(chrome));
    await h.dispatch(chrome,{binding,action:{kind:'set-playing',playing:false}});
    assert.deepEqual(h.states.at(-1),{capability,kind:'action',action:{kind:'set-playing',playing:false}});
    const handler=h.handlers.get('sunday-player-controls:dispatch');assert.ok(handler);
    await assert.rejects(handler({sender:h.views[0].webContents,senderFrame:h.views[0].webContents.mainFrame},{binding,action:{kind:'focus-player'}}));
    await assert.rejects(handler({sender:chrome.webContents,senderFrame:{}},{binding,action:{kind:'focus-player'}}));
    await assert.rejects(h.dispatch(chrome,{binding,action:{kind:'set-volume',volume:101}}));
    const previousUrl=chrome.webContents.mainFrame.url;chrome.webContents.mainFrame.url=`${previousUrl}?other=1`;
    await assert.rejects(h.dispatch(chrome,{binding,action:{kind:'focus-player'}}));chrome.webContents.mainFrame.url=previousUrl;
    const next=await h.factory.offer({target:{...target,generation:3},player});await h.factory.mount(h.event,{capability:next});
    await h.factory.update(h.event,{...layout,capability:next});
    const before=h.states.length;
    await assert.rejects(h.dispatch(chrome,{binding,action:{kind:'set-playing',playing:false}}));
    assert.equal(h.states.length,before);
    const pending=Promise.withResolvers<boolean>();h.pendingAuthorization(pending.promise);
    const command=h.dispatch(chrome,{binding:snapshotBinding(await h.ready(chrome)),action:{kind:'set-quality',selection:{kind:'auto'}}});
    await h.factory.update(h.event,{capability:next,visible:false});pending.resolve(true);
    await assert.rejects(command);
    assert.equal(h.scripts.some(script=>script.source.includes('"command":')),false);
  }finally{await h.factory.stop();}
});

test('overlay quality uses the selected frame and fullscreen uses a trusted host gesture',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}});
    assert.equal(h.views.length,2);
    const chrome=h.views[1],binding=snapshotBinding(await h.ready(chrome));
    assert.deepEqual(await h.dispatch(chrome,{binding,action:{kind:'set-quality',selection:{kind:'auto'}}}),{kind:'applied'});
    assert.deepEqual(h.states.at(-1),{capability,kind:'action',action:{kind:'set-quality',selection:{kind:'auto'}}});
    assert.equal(h.scripts.some(script=>script.source.includes('"command":{"kind":"set-quality"')),true);
    await h.dispatch(chrome,{binding,action:{kind:'set-fullscreen',fullscreen:true}});
    assert.equal(h.gestures.at(-1)?.gesture,true);assert.equal(h.gestures.at(-1)?.source.includes('sunday-player-controls-action'),true);
    h.views[0].webContents.emit('focus');assert.equal(chrome.focuses>0,true);
    await h.factory.release(h.event,{capability});assert.equal(chrome.visible,false);assert.equal(await h.ready(chrome),null);
    h.host.emit('closed');assert.equal(chrome.closed,true);
  }finally{await h.factory.stop();}
  assert.equal(h.handlers.size,0);
});

test('verification never allocates a controls overlay',async()=>{
  const h=harness({purpose:'verification'});
  try{
    const capability=await h.factory.offer({target:{...target,purpose:'verification'},player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}});
    assert.equal(h.views.length,1);assert.equal(h.handlers.size,0);
  }finally{await h.factory.stop();}
});

test('an overlay command result cannot publish into a later focused binding',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    const layout={capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}};
    await h.factory.update(h.event,layout);
    const chrome=h.views[1],binding=snapshotBinding(await h.ready(chrome));
    const pending=Promise.withResolvers<{kind:'control';result:{kind:'applied'};presentation:unknown}>();h.pendingControl(pending.promise);
    const command=h.dispatch(chrome,{binding,action:{kind:'set-quality',selection:{kind:'auto'}}});
    for(let turn=0;turn<30&&!h.scripts.some(script=>script.source.includes('"command":'));turn++)await Promise.resolve();
    assert.equal(h.scripts.some(script=>script.source.includes('"command":')),true);
    const next=await h.factory.offer({target:{...target,generation:3},player});await h.factory.mount(h.event,{capability:next});
    await h.factory.update(h.event,{...layout,capability:next,controls:{label:'Football',fullscreen:false}});
    pending.resolve({kind:'control',result:{kind:'applied'},presentation:{playing:false}});
    await assert.rejects(command);
    assert.equal(h.states.some(state=>typeof state==='object'&&state!==null&&'kind'in state&&state.kind==='presentation'),false);
    assert.equal(snapshotBinding(await h.ready(chrome))===binding,false);
  }finally{await h.factory.stop();}
});

test('independent native services share IPC without sharing host bindings or teardown',async()=>{
  const ipc=ipcHarness(),first=harness({ipc}),second=harness({ipc});
  try{
    const left=await first.factory.offer({target,player});await first.factory.mount(first.event,{capability:left});
    const right=await second.factory.offer({target:{...target,generation:3},player});await second.factory.mount(second.event,{capability:right});
    const layout={bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,controls:{label:'Race',fullscreen:false}};
    await first.factory.update(first.event,{capability:left,...layout});
    await second.factory.update(second.event,{capability:right,...layout});
    const firstChrome=first.views[1],secondChrome=second.views[1];
    const binding=snapshotBinding(await second.ready(secondChrome));
    await assert.rejects(first.dispatch(firstChrome,{binding,action:{kind:'focus-player'}}));
    await first.factory.stop();
    assert.equal(firstChrome.closed,true);assert.equal(secondChrome.closed,false);assert.equal(ipc.handlers.size,2);
    await second.dispatch(secondChrome,{binding,action:{kind:'focus-player'}});
    assert.deepEqual(second.states.at(-1),{capability:right,kind:'action',action:{kind:'focus-player'}});
    await second.factory.stop();assert.equal(ipc.handlers.size,0);
  }finally{await first.factory.stop();await second.factory.stop();}
});

test('overlay waits for its transparent document handshake and completed navigation before showing',async()=>{
  const navigation=Promise.withResolvers<void>(),h=harness({chromeLoad:navigation.promise});
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}});
    const chrome=h.views[1];assert.equal(chrome.visible,false);
    const binding=snapshotBinding(await h.ready(chrome));assert.equal(chrome.visible,false);
    await assert.rejects(h.dispatch(chrome,{binding,action:{kind:'focus-player'}}));
    navigation.resolve();for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.equal(chrome.visible,true);
    await h.dispatch(chrome,{binding,action:{kind:'focus-player'}});
  }finally{navigation.resolve();await h.factory.stop();}
});

test('a loaded overlay with no transparent document handshake stays hidden and rejects actions',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}});
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    const chrome=h.views[1];assert.equal(chrome.visible,false);
    const binding=snapshotBinding(h.chromeStates.at(-1));
    await assert.rejects(h.dispatch(chrome,{binding,action:{kind:'focus-player'}}));
    await h.factory.update(h.event,{capability,visible:false});
    assert.equal(await h.ready(chrome),null);assert.equal(chrome.visible,false);
  }finally{await h.factory.stop();}
});

test('local overlay volume actions preserve input order without waiting for source authorization',async()=>{
  const h=harness(),authorization=Promise.withResolvers<boolean>();
  const dispatches:Promise<unknown>[]=[];
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}});
    const chrome=h.views[1],binding=snapshotBinding(await h.ready(chrome));
    h.pendingAuthorization(authorization.promise);
    dispatches.push(h.dispatch(chrome,{binding,action:{kind:'set-volume',volume:20}}));
    dispatches.push(h.dispatch(chrome,{binding,action:{kind:'set-volume',volume:80}}));
    assert.deepEqual(h.states,[
      {capability,kind:'action',action:{kind:'set-volume',volume:20}},
      {capability,kind:'action',action:{kind:'set-volume',volume:80}},
    ]);
    await Promise.all(dispatches);
  }finally{authorization.resolve(true);await Promise.allSettled(dispatches);await h.factory.stop();}
});

test('unfocusing with null controls preserves playback and reuses the overlay on refocus',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    const layout={capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,playing:true,
      controls:{label:'Race',fullscreen:false}};
    await h.factory.update(h.event,layout);
    const source=h.views[0],chrome=h.views[1];await h.ready(chrome);
    await h.factory.update(h.event,{capability,focused:false,controls:null});
    assert.equal(source.closed,false);assert.equal(source.visible,true);assert.equal(chrome.visible,false);
    assert.equal(await h.ready(chrome),null);
    await h.factory.update(h.event,layout);
    assert.equal(source.closed,false);assert.equal(source.visible,true);assert.equal(chrome.visible,true);
    assert.equal(h.views.length,2);assert.equal(h.states.some(state=>hasKind(state,'failed')),false);
  }finally{await h.factory.stop();}
});

test('same-document controls navigation preserves the completed transparency handshake',async()=>{
  const h=harness();
  try{
    const capability=await h.factory.offer({target,player});await h.factory.mount(h.event,{capability});
    await h.factory.update(h.event,{capability,bounds:{x:0,y:0,width:640,height:360},visible:true,focused:true,
      controls:{label:'Race',fullscreen:false}});
    const chrome=h.views[1],binding=snapshotBinding(await h.ready(chrome));assert.equal(chrome.visible,true);
    chrome.webContents.emit('did-start-navigation',{},chrome.loaded,true,true);
    assert.equal(chrome.visible,true);
    await h.dispatch(chrome,{binding,action:{kind:'focus-player'}});
    assert.deepEqual(h.states.at(-1),{capability,kind:'action',action:{kind:'focus-player'}});
    chrome.webContents.emit('did-start-navigation',{},chrome.loaded,false,true);
    assert.equal(chrome.visible,false);
    await assert.rejects(h.dispatch(chrome,{binding,action:{kind:'focus-player'}}));
  }finally{await h.factory.stop();}
});
