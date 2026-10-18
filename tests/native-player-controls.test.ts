import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);
const {nativePlayerControls}=require('../desktop/player-controls.cjs');
function fixture(){
  const video={paused:false,duration:Infinity,videoHeight:540,disablePictureInPicture:false,requestPictureInPicture:async()=>{page.pictureInPictureElement=video;}};
  const page={pictureInPictureEnabled:true,pictureInPictureElement:null as object|null,exitPictureInPicture:async()=>{page.pictureInPictureElement=null;}};
  const hls={media:video,levels:[{height:216,bitrate:200000,details:{live:true}},{height:360,bitrate:500000}],manualLevel:-1,
    get currentLevel(){return this.manualLevel;},set currentLevel(value:number){this.manualLevel=value;}};
  return {video,page,hls,scope:{hls}};
}
test('owned HLS quality commands select real levels, reject stale options and preserve auto',async()=>{
  const h=fixture();
  const initial=nativePlayerControls(h.video,h.page,h.scope);
  assert.equal(initial.playback,'live');assert.equal(initial.playing,true);
  assert.deepEqual(initial.quality.options.map((option:{height:number})=>option.height),[216,360]);
  const selection={kind:'level',id:initial.quality.options[1].id};
  assert.equal((await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-quality',selection})).result.kind,'applied');
  assert.equal(h.hls.manualLevel,1);
  h.hls.levels=[{height:720,bitrate:1000000}];
  assert.deepEqual((await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-quality',selection})).result,{kind:'unavailable',reason:'stale-quality'});
  assert.equal(h.hls.manualLevel,1);
});
test('Clappr ownership beats a JW stub and unusable single-level metadata stays fixed',()=>{
  const h=fixture();
  const playback={el:h.video,levels:[{id:0,level:{},label:'NaNKbps'}],currentLevel:-1,getPlaybackType:()=> 'live'};
  const presentation=nativePlayerControls(h.video,h.page,{__wasm_player:{core:{activePlayback:playback}},player:{tagName:'DIV'},jwplayer:()=>({})});
  assert.deepEqual(presentation.quality,{kind:'fixed',label:'540p'});
  assert.equal(presentation.playback,'live');
});
test('unrelated player globals cannot receive controls; PiP is an explicit action',async()=>{
  const h=fixture();h.hls.media={...h.video};
  assert.deepEqual(nativePlayerControls(h.video,h.page,h.scope).quality,{kind:'unavailable'});
  assert.equal(h.page.pictureInPictureElement,null);
  const result=await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-picture-in-picture',active:true});
  assert.equal(result.result.kind,'applied');assert.equal(h.page.pictureInPictureElement,h.video);
  assert.deepEqual(result.presentation.pip,{kind:'available',active:true});
  h.video.paused=true;
  await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-picture-in-picture',active:false});
  assert.equal(h.video.paused,true);assert.equal(h.page.pictureInPictureElement,null);
});
test('JW quality catalogs stay stable across equivalent API records and expire with their adapter',async()=>{
  const h=fixture();
  const player={getContainer:()=>({contains:(value:object)=>value===h.video}),getQualityLevels:()=>[{label:'216p',height:216},{label:'360p',height:360}],
    getCurrentQuality:()=>0,setCurrentQuality(index:number){assert.equal(index,1);}};
  const scope={jwplayer:()=>player};
  const first=nativePlayerControls(h.video,h.page,scope);
  const next=nativePlayerControls(h.video,h.page,scope);
  assert.deepEqual(next.quality.options,first.quality.options);
  const selection={kind:'level',id:first.quality.options[1].id};
  assert.equal((await nativePlayerControls(h.video,h.page,scope,{kind:'set-quality',selection})).result.kind,'applied');
  scope.jwplayer=()=>({...player});
  assert.equal((await nativePlayerControls(h.video,h.page,scope,{kind:'set-quality',selection})).result.kind,'unavailable');
});
test('quality options from a replaced document cannot select its new player',async()=>{
  const original=fixture(),replacement=fixture();
  const before=nativePlayerControls(original.video,original.page,original.scope);
  nativePlayerControls(replacement.video,replacement.page,replacement.scope);
  const result=await nativePlayerControls(replacement.video,replacement.page,replacement.scope,{kind:'set-quality',selection:{kind:'level',id:before.quality.options[0].id}});
  assert.deepEqual(result.result,{kind:'unavailable',reason:'stale-quality'});
  assert.equal(replacement.hls.manualLevel,-1);
});
test('repeated quality choices leave the running HLS buffer untouched',async()=>{
  const h=fixture();
  let changes=0;
  Object.defineProperty(h.hls,'currentLevel',{get:()=>h.hls.manualLevel,set:(index:number)=>{changes++;h.hls.manualLevel=index;}});
  const initial=nativePlayerControls(h.video,h.page,h.scope);
  const auto=await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-quality',selection:{kind:'auto'}});
  assert.equal(auto.result.kind,'applied');assert.equal(changes,0);
  const selection={kind:'level',id:initial.quality.options[1].id};
  await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-quality',selection});
  assert.equal(h.hls.manualLevel,1);assert.equal(changes,1);
  const repeated=await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-quality',selection});
  assert.equal(repeated.result.kind,'applied');assert.equal(changes,1);
  await nativePlayerControls(h.video,h.page,h.scope,{kind:'set-quality',selection:{kind:'auto'}});
  assert.equal(h.hls.manualLevel,-1);assert.equal(changes,2);
});
