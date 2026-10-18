import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext,runInNewContext } from 'node:vm';
import test from 'node:test';
import {load} from 'cheerio';

const observerFile = new URL('../desktop/sportsurge-observer.cjs', import.meta.url);
const observerRequire = createRequire(observerFile);
const source = readFileSync(observerFile, 'utf8');
const loadSlot = runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout,setInterval,clearInterval){
  ${source}
  return createObserverSlot;
})`);

type RequestHook = (details: unknown, callback: (result: unknown) => void) => void;

function createObserverHarness(mainFrame: { framesInSubtree: unknown[] },
  frameLookup: () => object | null = () => null) {
  let tick: (() => void) | undefined;
  let deadline:(()=>void)|undefined;
  let fallbackDeadline:(()=>void)|undefined;
  const windows: FakeWindow[] = [];
  let beforeRequest: RequestHook | undefined;
  let beforeSendHeaders: RequestHook | undefined;
  let headersReceived: RequestHook | undefined;
  class FakeWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame,
      setWebRTCIPHandlingPolicy() {}, setAudioMuted() {},
      setWindowOpenHandler() {},
    });
    constructor(options:{webPreferences:{disableDialogs:boolean}}) { super();assert.equal(options.webPreferences.disableDialogs,true); windows.push(this); }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const sourceSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    webRequest: {
      onBeforeRequest(callback: RequestHook) { beforeRequest = callback; },
      onBeforeSendHeaders(callback: RequestHook) { beforeSendHeaders = callback; },
      onHeadersReceived(callback: RequestHook) { headersReceived = callback; },
    },
  };
  const createSlot = loadSlot(
    (id: string) => id === 'electron'
      ? { BrowserWindow: FakeWindow, session: { fromPartition: () => sourceSession },
        webFrameMain: { fromId: frameLookup } }
      : observerRequire(id),
    { exports: {} }, {},
    (callback:()=>void,ms:number) => {if(ms===20000)deadline=callback;if(ms===1000)fallbackDeadline=callback;return 0;}, () => {}, (callback: () => void) => { tick = callback; return 0; }, () => {},
  );
  return {
    observer: createSlot(0),
    tick() { assert.equal(typeof tick, 'function'); tick?.(); },
    deadline(){assert.ok(deadline);deadline();},
    fallbackDeadline(){assert.ok(fallbackDeadline);fallbackDeadline();},
    window() { const window = windows.at(-1); assert.ok(window); return window; },
    request(details: unknown, expected = { cancel: false }) {
      assert.ok(beforeRequest);
      const decisions: unknown[] = [];
      beforeRequest(details, result => { decisions.push(result); });
      assert.deepEqual(decisions, [expected]);
    },
    sendHeaders(details: unknown) {
      assert.ok(beforeSendHeaders);
      beforeSendHeaders(details, () => {});
    },
    receiveHeaders(details: unknown) {
      assert.ok(headersReceived);
      const decisions:unknown[]=[];
      headersReceived(details, decision => {decisions.push(decision);});
      assert.deepEqual(decisions,[{cancel:false}]);
    },
  };
}

test('capture without replayable HLS retains only the uniquely selected known player document',async()=>{
  const url='https://embed.st/embed/basketball/game/1';
  const root={url:'https://ppv.st/events/game',isDestroyed:()=>false,framesInSubtree:[] as unknown[],
    executeJavaScript:async()=>({kind:'frame',url})};
  const child={url,parent:root,isDestroyed:()=>false,executeJavaScript:async()=>({kind:'media',sources:[]})};
  const ad={url:'https://other.example/ad',parent:root,isDestroyed:()=>false,
    executeJavaScript:async()=>({kind:'media',sources:['https://other.example/ad.m3u8']})};
  root.framesInSubtree=[root,child,ad];
  const harness=createObserverHarness(root),operation=harness.observer.observe(root.url,'probe');
  assert.ok(operation);harness.deadline();
  const result=await operation.promise;
  assert.deepEqual(result.player,{url,referer:root.url});
  assert.equal(result.kind,'incomplete');assert.equal(result.url,undefined);
});

test('a hung selected-player script cannot hold capture capacity beyond its bounded final inspection',async()=>{
  const root={url:'https://embed.st/embed/basketball/game/1',isDestroyed:()=>false,framesInSubtree:[] as unknown[],
    executeJavaScript:()=>new Promise(()=>{})};
  root.framesInSubtree=[root];
  const harness=createObserverHarness(root),operation=harness.observer.observe(root.url,'probe');assert.ok(operation);
  try{
    harness.deadline();harness.fallbackDeadline();
    const result=await operation.promise;assert.equal(result.kind,'incomplete');assert.equal(result.player,undefined);
    assert.equal(harness.window().isDestroyed(),true);
  }finally{operation.cancel();}
});

test('the observer cancels the shared ad document and admits neighboring player requests', async () => {
  const harness = createObserverHarness({ framesInSubtree: [] });
  const operation = harness.observer.observe('https://embed.st/embed/golf/2120/2', 'probe');
  assert.ok(operation);
  operation.start();
  const cases: { url: string; resourceType: string; cancel: boolean }[] = [
    { url: 'https://embed.st/ad.html', resourceType: 'subFrame', cancel: true },
    { url: 'https://embed.st/ad.html?slot=2', resourceType: 'subFrame', cancel: true },
    { url: 'https://pxdrop.lijit.com/a/t_.htm', resourceType: 'subFrame', cancel: true },
    { url: 'https://t.sharethis.com/a/t_.htm?slot=2', resourceType: 'subFrame', cancel: true },
    { url: 'https://tags.crwdcntrl.net/lt/shared/2/lt.iframe.html', resourceType: 'subFrame', cancel: true },
    { url: 'https://pxdrop.lijit.com/a/player.htm', resourceType: 'subFrame', cancel: true },
    { url: 'https://t.sharethis.com/a/t_.htm', resourceType: 'media', cancel: true },
    { url: 'https://other.example/a/t_.htm', resourceType: 'subFrame', cancel: false },
    { url: 'https://rockystream.st/', resourceType: 'subFrame', cancel: false },
    { url: 'https://embed.st/embed/ingest/game/1/', resourceType: 'subFrame', cancel: false },
    { url: 'https://embed.st/cdn-cgi/challenge-platform/test', resourceType: 'subFrame', cancel: false },
    { url: 'https://media.example/playlist.m3u8', resourceType: 'media', cancel: false },
    { url: 'https://embed.st/ad.html', resourceType: 'media', cancel: true },
    { url: 'https://embed.st/ad.htmlx', resourceType: 'subFrame', cancel: true },
    { url: 'https://ads.embed.st/ad.html', resourceType: 'subFrame', cancel: true },
    { url: 'https://other.example/ad.html', resourceType: 'subFrame', cancel: false },
  ];
  for (const [index, request] of cases.entries())
    harness.request({ id: index, url: request.url, resourceType: request.resourceType },
      { cancel: request.cancel });
  harness.request({ id: 20, url: 'https://embed.st/embed/golf/2120/2', resourceType: 'mainFrame' });
  harness.request({ id: 21, url: 'https://embed.st/ad.html', resourceType: 'mainFrame' }, { cancel: true });
  operation.cancel();
  assert.equal(await operation.promise, null);
  harness.request({ id: 22, url: 'https://embed.st/ad.html', resourceType: 'subFrame' }, { cancel: true });

  const adDocument = harness.observer.observe('https://embed.st/ad.html', 'probe');
  assert.ok(adDocument);
  harness.request({ id: 23, url: 'https://embed.st/ad.html', resourceType: 'mainFrame' },{cancel:true});
  adDocument.cancel();
  assert.equal(await adDocument.promise, null);
});

test('a canceled ad document cannot provide media evidence', async () => {
  const player = {
    url: 'https://player.example/watch',
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve({kind:'media',sources:['https://media.example/live.m3u8']}),
  };
  const harness = createObserverHarness({ framesInSubtree: [player] });
  const operation = harness.observer.observe('https://embed.st/embed/golf/2120/2', 'probe');
  assert.ok(operation);
  operation.start();
  harness.request({ id: 1, url: 'https://embed.st/ad.html', resourceType: 'subFrame' }, { cancel: true });
  harness.sendHeaders({ id: 1, url: 'https://embed.st/ad.html', requestHeaders: {
    referer: player.url, 'user-agent': 'Observer test',
  }, initiatorOrigin: 'https://player.example' });
  harness.receiveHeaders({ id: 1, url: 'https://embed.st/ad.html', statusCode: 200, responseHeaders: {
    'content-type': ['application/vnd.apple.mpegurl'],
  } });
  await new Promise(resolve => setImmediate(resolve));

  const mediaUrl = 'https://media.example/live.m3u8';
  harness.request({ id: 2, url: mediaUrl, resourceType: 'media' });
  harness.sendHeaders({ id: 2, url: mediaUrl, requestHeaders: {
    referer: player.url, 'user-agent': 'Observer test',
  }, initiatorOrigin: 'https://player.example' });
  harness.receiveHeaders({ id: 2, url: mediaUrl, statusCode: 200, responseHeaders: {
    'content-type': ['application/vnd.apple.mpegurl'],
  } });
  assert.equal((await operation.promise)?.url, mediaUrl);
});

test('the observer keeps scanning one live player while Electron tears down sibling iframes', async () => {
  let playerChecks = 0;
  const player = {
    url: 'https://ch.aianimalvibes.com/football/728',
    isDestroyed: () => false,
    executeJavaScript: () => { playerChecks++; return Promise.resolve(false); },
  };
  const destroyed = {
    isDestroyed: () => true,
    get url(): string { throw new Error('destroyed frame URL accessed'); },
  };
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [null, destroyed, player] };
  const harness = createObserverHarness(mainFrame);
  const operation = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  assert.doesNotThrow(() => harness.tick());
  assert.equal(playerChecks, 1);

  const secondPlayer = { ...player, executeJavaScript: () => Promise.resolve(false) };
  mainFrame.framesInSubtree = [null, player, secondPlayer];
  harness.tick();
  assert.equal(playerChecks, 1);
  operation.cancel();
  assert.equal(await operation.promise, null);
});

test('a removed sibling does not break selected StreamEast player uniqueness', async () => {
  const playerUrl = 'https://dlive.sx/stream/stream-44.php';
  const selected: { parent?: object; url: string; isDestroyed: () => boolean } = {
    url: playerUrl, isDestroyed: () => false,
  };
  const destroyed: { parent: object | null; url: string; isDestroyed: () => boolean } = {
    parent: null, url: playerUrl, isDestroyed: () => true,
  };
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [null, destroyed, selected] };
  selected.parent = mainFrame;
  destroyed.parent = mainFrame;
  const harness = createObserverHarness(mainFrame, () => selected);
  const selection: { playerUrl: string; playerFrame?: object } = { playerUrl };
  const operation = harness.observer.observe('https://v2.streameast.ga/nfl/falcons-vs-saints-1/2',
    'probe', undefined, selection);
  assert.ok(operation);
  harness.window().webContents.emit('did-frame-navigate', {}, playerUrl, 200, '', false, 1, 2);
  assert.equal(selection.playerFrame, selected);
  operation.cancel();
  assert.equal(await operation.promise, null);

  const second = { parent: mainFrame, url: playerUrl, isDestroyed: () => false };
  mainFrame.framesInSubtree = [null, selected, second];
  const secondSelection: { playerUrl: string; playerFrame?: object } = { playerUrl };
  const another = harness.observer.observe('https://v2.streameast.ga/nfl/falcons-vs-saints-1/2',
    'probe', undefined, secondSelection);
  assert.ok(another);
  harness.window().webContents.emit('did-frame-navigate', {}, playerUrl, 200, '', false, 1, 2);
  assert.equal(secondSelection.playerFrame, undefined);
  assert.deepEqual(await another.promise, {kind:'incomplete',phase:'ownership',reason:'ambiguous-player',retryAfterMs:30000});
});

test('a media probe finds the valid player next to a removed iframe', async () => {
  const mediaUrl = 'https://player.example/live.m3u8';
  const player = {
    url: 'https://player.example/watch',
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve({kind:'media',sources:[mediaUrl]}),
  };
  const harness = createObserverHarness({ framesInSubtree: [null, player] });
  const operation = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  harness.request({ id: 1, url: mediaUrl, resourceType: 'media' });
  harness.sendHeaders({ id: 1, url: mediaUrl, requestHeaders: {
    referer: player.url, 'user-agent': 'Observer test', cookie: 'session=published-player',
  }, initiatorOrigin: 'https://player.example' });
  harness.receiveHeaders({ id: 1, url: mediaUrl, statusCode: 200, responseHeaders: {
    'content-type': ['application/vnd.apple.mpegurl'],
  } });
  const result = await operation.promise;
  assert.equal(result?.url, mediaUrl);
  assert.equal(result?.referer, player.url);
  assert.equal(result?.mediaCookie, 'session=published-player');
});

test('only exact fxtrend PPV servers can continue past 32 frames and capture published media',async()=>{
  const mediaUrl='https://player.example/live.m3u8';
  const source='https://fxtrend.st/event/ppv-golden-state-warriors-vs-portland-trail-blazers/vertex/1';
  const observe=async(page:string,expectMedia:boolean)=>{
    const player={url:'https://player.example/watch',isDestroyed:()=>false,
      executeJavaScript:()=>Promise.resolve({kind:'media',sources:[mediaUrl]})};
    const ads=Array.from({length:32},(_,index)=>({url:`https://ads.example/frame-${index}`,
      isDestroyed:()=>false,executeJavaScript:()=>Promise.resolve(false)}));
    const harness=createObserverHarness({framesInSubtree:[player,...ads]});
    const operation=harness.observer.observe(page,'probe');
    assert.ok(operation);
    operation.start();
    harness.window().webContents.emit('frame-created');
    if(expectMedia){
      harness.request({id:1,url:mediaUrl,resourceType:'media'});
      harness.sendHeaders({id:1,url:mediaUrl,requestHeaders:{
        referer:player.url,'user-agent':'Observer test',
      },initiatorOrigin:'https://player.example'});
      harness.receiveHeaders({id:1,url:mediaUrl,statusCode:200,responseHeaders:{
        'content-type':['application/vnd.apple.mpegurl'],
      }});
      assert.equal((await operation.promise)?.url,mediaUrl,page);
    }else{
      const result=await Promise.race([operation.promise,
        new Promise(resolve=>setTimeout(()=>resolve('still observing'),50))]);
      operation.cancel();
      assert.deepEqual(result,{kind:'incomplete',phase:'capture',reason:'frame-budget',retryAfterMs:30000},page);
    }
  };
  for(const type of ['core/1','vector/1','vertex/1','hotel/2'])
    await observe(source.replace('vertex/1',type),true);
  for(const page of [
    'https://example.com/event',source.replace('fxtrend.st','ads.example'),
    source.replace('https:','http:'),source.replace('fxtrend.st','fxtrend.st:8443'),
    `${source}?ad=1`,`${source}#player`,source.replace('vertex/1','vertex/0'),
    source.replace('vertex/1','vertex/1000'),source.replace('vertex/1','admin/1'),
  ])await observe(page,false);
});

test('a disposed native frame tree ends a media probe without an unhandled rejection', async () => {
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [] };
  Object.defineProperty(mainFrame, 'framesInSubtree', {
    get() { throw new Error('native frame tree disposed'); },
  });
  const harness = createObserverHarness(mainFrame);
  const operation = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  const mediaUrl = 'https://player.example/live.m3u8';
  harness.request({ id: 1, url: mediaUrl, resourceType: 'media' });
  harness.sendHeaders({ id: 1, url: mediaUrl, requestHeaders: {
    referer: 'https://player.example/watch', 'user-agent': 'Observer test',
  }, initiatorOrigin: 'https://player.example' });
  harness.receiveHeaders({ id: 1, url: mediaUrl, statusCode: 200, responseHeaders: {
    'content-type': ['application/vnd.apple.mpegurl'],
  } });
  assert.deepEqual(await operation.promise, {kind:'incomplete',phase:'ownership',reason:'frame-detached',retryAfterMs:30000});
});

test('a verified offline selected player is a completed no-feed observation', async () => {
  const player = {
    url: 'https://posamari.me/sd0embed/NFL',
    isDestroyed: () => false,
    executeJavaScript: (code: string) => Promise.resolve(code.includes('readyState:document.readyState') ? {
      readyState: 'complete', hasVideo: false, title: 'Stream is Offline', status: 'Offline',
      description: 'The stream is currently offline. Please try again later.',
    } : false),
  };
  const harness = createObserverHarness({framesInSubtree:[player]});
  const operation = harness.observer.observe('https://vipbox.fm/live/nfl/test-game-1','probe');
  assert.ok(operation);
  operation.start();
  harness.tick();
  assert.deepEqual(await operation.promise,{kind:'no-feed',phase:'activation',reason:'offline'});
});

test('the current published SD0 offline document completes without waiting for the capture timeout',async()=>{
  const select=load(readFileSync(new URL('./fixtures/sd0-offline-20261018.html',import.meta.url),'utf8'));
  const document={title:select('title').text(),readyState:'complete',querySelector(selector:string){
    const node=select(selector).first();return node.length?{textContent:node.text()}:null;
  },querySelectorAll:()=>[]};
  const player={url:'https://dervlin.me/sd0embed/american-football?pid=10&v=fhdnfl3&player=jw',isDestroyed:()=>false,
    executeJavaScript:async(code:string)=>runInNewContext(code,{document})};
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe('https://strikeout.im/nfl/2/philadelphia-eagles-vs-carolina-panthers-stream','probe');
  assert.ok(operation);operation.start();harness.tick();
  try{
    const result=await Promise.race([operation.promise,new Promise(resolve=>setTimeout(()=>resolve('still observing'),50))]);
    assert.deepEqual(result,{kind:'no-feed',phase:'activation',reason:'offline'});
  }finally{operation.cancel();}
});

test('a selected player network error keeps the observation incomplete', async () => {
  const player = {
    url: 'https://posamari.me/sd0embed/NFL',
    isDestroyed: () => false,
    executeJavaScript: (code: string) => Promise.resolve(code.includes('readyState:document.readyState') ? {
      readyState: 'complete', hasVideo: false, title: 'Technical Issue',
      errorVisible: true, errorHeading: 'Network Error',
      errorDescription: 'We are having trouble connecting to the server. Please reload the page.',
    } : false),
  };
  const harness = createObserverHarness({framesInSubtree:[player]});
  const operation = harness.observer.observe('https://vipbox.fm/live/nfl/test-game-1','probe');
  assert.ok(operation);
  operation.start();
  harness.tick();
  assert.deepEqual(await operation.promise,
    {kind:'incomplete',phase:'activation',reason:'player-network-error',retryAfterMs:30000});
});

test('a frame disposed after script execution ends its observation and leaves the slot reusable', async () => {
  let urlReads = 0;
  const detached = {
    get url() {
      if (++urlReads > 1) throw new Error('native frame disposed');
      return 'https://player.example/watch';
    },
    isDestroyed: () => false,
    executeJavaScript: async () => ({kind:'media',sources:['https://player.example/live.m3u8']}),
  };
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [detached] };
  const harness = createObserverHarness(mainFrame);
  const mediaUrl = 'https://player.example/live.m3u8';
  const observeMedia = () => {
    harness.request({ id: 1, url: mediaUrl, resourceType: 'media' });
    harness.sendHeaders({ id: 1, url: mediaUrl, frame: detached, requestHeaders: {
      referer: 'https://player.example/watch', 'user-agent': 'Observer test',
    }, initiatorOrigin: 'https://player.example' });
    harness.receiveHeaders({ id: 1, url: mediaUrl, statusCode: 200, responseHeaders: {
      'content-type': ['application/vnd.apple.mpegurl'],
    } });
  };
  const first = harness.observer.observe('https://example.com/event', 'probe');
  assert.ok(first);
  try {
    observeMedia();
    const result = await Promise.race([
      first.promise,
      new Promise(resolve => setTimeout(() => resolve('stalled'), 100)),
    ]);
    assert.deepEqual(result,{kind:'incomplete',phase:'ownership',reason:'script-failed',retryAfterMs:30000});
    mainFrame.framesInSubtree = [{
      url: 'https://player.example/watch', isDestroyed: () => false,
      executeJavaScript: async () => ({kind:'media',sources:['https://player.example/live.m3u8']}),
    }];
    const second = harness.observer.observe('https://example.com/event', 'probe');
    assert.ok(second);
    harness.request({ id: 2, url: mediaUrl, resourceType: 'media' });
    harness.sendHeaders({ id: 2, url: mediaUrl, requestHeaders: {
      referer: 'https://player.example/watch', 'user-agent': 'Observer test',
    }, initiatorOrigin: 'https://player.example' });
    harness.receiveHeaders({ id: 2, url: mediaUrl, statusCode: 200, responseHeaders: {
      'content-type': ['application/vnd.apple.mpegurl'],
    } });
    const secondResult = await Promise.race([
      second.promise,
      new Promise(resolve => setTimeout(() => resolve('stalled'), 100)),
    ]);
    assert.equal(secondResult?.url, mediaUrl);
  } finally {
    first.cancel();
    harness.observer.stop();
  }
});


function playerBox(width=640,height=360,left=0,top=0){return {width,height,left,top,right:left+width,bottom:top+height};}
const playerStyle=()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'});
type LayoutNode={parentElement:LayoutNode|null;getBoundingClientRect:()=>ReturnType<typeof playerBox>;style:ReturnType<typeof playerStyle>};
function playerDocument(source:string,kind:'video'|'iframe'='video',width=640){
  const layout:LayoutNode={parentElement:null,getBoundingClientRect:()=>playerBox(width),style:playerStyle()};
  const element={...layout,tagName:kind.toUpperCase(),currentSrc:source,src:source,isConnected:true,
    checkVisibility:()=>true,
    getAttribute:(name:string)=>name==='src'?source:null,
    querySelectorAll:()=>[],contains:(other:unknown)=>other===element};
  return {element,page:{baseURI:'https://player.example/watch',querySelectorAll:(selector:string)=>
    selector==='#player, .player, .jwplayer, .video-js'?[]:selector==='video, iframe'||selector===kind?[element]:[]},
    style:(node:LayoutNode)=>node.style};
}
function scriptedPlayer(source:string){
  const dom=playerDocument(source);
  return {url:'https://player.example/watch',isDestroyed:()=>false,executeJavaScript:async(code:string)=>
    runInNewContext(code,{document:dom.page,getComputedStyle:dom.style,window:{},URL})};
}
function emitMedia(harness:ReturnType<typeof createObserverHarness>,id:number,url:string,frame:object){
  harness.request({id,url,resourceType:'media'});
  harness.sendHeaders({id,url,frame,requestHeaders:{referer:'https://player.example/watch','user-agent':'Observer test'},initiatorOrigin:'https://player.example'});
  harness.receiveHeaders({id,url,statusCode:200,responseHeaders:{'content-type':['application/vnd.apple.mpegurl']}});
}

test('a visible selected video cannot claim unrelated same-frame HLS',async()=>{
  const media='https://cdn.example/game.m3u8',player=scriptedPlayer(media);
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe(player.url,'probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    emitMedia(harness,1,'https://secondary.example/stream.m3u8',player);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(result,'pending');
    emitMedia(harness,2,media,player);
    assert.equal((await operation.promise)?.url,media);
  }finally{operation.cancel();}
});

for(const status of [404,410,403,429,500])test(`an owned manifest HTTP ${status} releases capture without waiting for its deadline`,async()=>{
  const url='https://cdn.example/game.m3u8',player=scriptedPlayer(url);
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe('https://event.example/watch','probe');assert.ok(operation);operation.start();
  try{
    harness.request({id:1,url,resourceType:'xhr'});
    harness.sendHeaders({id:1,url,frame:player,requestHeaders:{referer:player.url,'user-agent':'Observer test'},initiatorOrigin:'https://player.example'});
    harness.receiveHeaders({id:1,url,statusCode:status,responseHeaders:{'content-type':['application/vnd.apple.mpegurl']}});
    const result=await Promise.race([operation.promise,new Promise(resolve=>setTimeout(()=>resolve('still observing'),50))]);
    assert.deepEqual(result,{kind:'incomplete',phase:'capture',reason:'upstream-http',retryAfterMs:30000});
  }finally{operation.cancel();}
});

test('an unrelated failed manifest cannot end a selected player check',async()=>{
  const media='https://cdn.example/game.m3u8',advert='https://cdn.example/advert.m3u8',player=scriptedPlayer(media);
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe('https://event.example/watch','probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    harness.request({id:1,url:advert,resourceType:'xhr'});
    harness.sendHeaders({id:1,url:advert,frame:player,requestHeaders:{referer:player.url,'user-agent':'Observer test'},initiatorOrigin:'https://player.example'});
    harness.receiveHeaders({id:1,url:advert,statusCode:404,responseHeaders:{'content-type':['application/vnd.apple.mpegurl']}});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(result,'pending');
    emitMedia(harness,2,media,player);assert.equal((await operation.promise)?.url,media);
  }finally{operation.cancel();}
});

test('viewer capture permits the selected player to recover from a failed manifest',async()=>{
  const dom=playerDocument('https://cdn.example/stale.m3u8');
  const player={url:'https://player.example/watch',isDestroyed:()=>false,executeJavaScript:async(code:string)=>
    runInNewContext(code,{document:dom.page,getComputedStyle:dom.style,window:{},URL})};
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe('https://event.example/watch','playback');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    const url=dom.element.currentSrc;
    harness.request({id:1,url,resourceType:'xhr'});
    harness.sendHeaders({id:1,url,frame:player,requestHeaders:{referer:player.url,'user-agent':'Observer test'},initiatorOrigin:'https://player.example'});
    harness.receiveHeaders({id:1,url,statusCode:404,responseHeaders:{'content-type':['application/vnd.apple.mpegurl']}});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(result,'pending');
    dom.element.currentSrc='https://cdn.example/recovered.m3u8';
    emitMedia(harness,2,dom.element.currentSrc,player);assert.equal((await operation.promise)?.url,dom.element.currentSrc);
  }finally{operation.cancel();}
});

test('an ad child with a large video cannot claim the selected parent player',async()=>{
  const media='https://cdn.example/game.m3u8',ad='https://secondary.example/stream.m3u8';
  const parentDom=playerDocument('https://player.example/watch','iframe');
  const parent={url:'https://event.example/watch',isDestroyed:()=>false,framesInSubtree:[] as object[],
    executeJavaScript:async(code:string)=>runInNewContext(code,{document:parentDom.page,getComputedStyle:parentDom.style,window:{},URL})};
  const player={...scriptedPlayer(media),parent};
  const advertisement={...scriptedPlayer(ad),url:'https://ads.example/frame',parent};
  parent.framesInSubtree=[parent,player,advertisement];
  const harness=createObserverHarness(parent);
  const operation=harness.observer.observe(parent.url,'probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    emitMedia(harness,1,ad,advertisement);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(result,'pending');
    emitMedia(harness,2,media,player);assert.equal((await operation.promise)?.url,media);
  }finally{operation.cancel();}
});


for(const provider of ['jw','hls','clappr','videojs'])test(provider+' evidence must bind its source to the selected video',async()=>{
  const media='https://cdn.example/game.m3u8',dom=playerDocument('blob:https://player.example/video');
  const container={contains:(element:unknown)=>element===dom.element};
  const api=provider==='jw'?{jwplayer:()=>({getContainer:()=>container,getConfig:()=>({}),getPlaylistItem:()=>({file:media})})}:
    provider==='hls'?{hls:{media:dom.element,url:media}}:
    provider==='clappr'?{player:{options:{source:media},core:{activePlayback:{el:dom.element}}}}:
    {videojs:{getPlayers:()=>({main:{el:()=>container,currentSource:()=>({src:media})}})}};
  const player={url:'https://player.example/watch',isDestroyed:()=>false,executeJavaScript:async(code:string)=>
    runInNewContext(code,{document:dom.page,getComputedStyle:dom.style,window:api,URL})};
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe(player.url,'probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    emitMedia(harness,1,'https://secondary.example/stream.m3u8',player);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(result,'pending');
    emitMedia(harness,2,media,player);assert.equal((await operation.promise)?.url,media);
  }finally{operation.cancel();}
});

test('a blob video without selected player API evidence cannot claim a requested manifest',async()=>{
  const media='https://cdn.example/game.m3u8',dom=playerDocument('blob:https://player.example/video');
  const player={url:'https://player.example/watch',isDestroyed:()=>false,executeJavaScript:async(code:string)=>
    runInNewContext(code,{document:dom.page,getComputedStyle:dom.style,window:{hls:{media:{},url:media}},URL})};
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe(player.url,'probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    emitMedia(harness,1,media,player);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(result,'pending');
    dom.element.currentSrc='https://cdn.example/owned.m3u8';
    emitMedia(harness,2,dom.element.currentSrc,player);assert.equal((await operation.promise)?.url,dom.element.currentSrc);
  }finally{operation.cancel();}
});


test('an internally large video cannot bypass a hidden parent iframe',async()=>{
  const media='https://cdn.example/game.m3u8',parentDom=playerDocument('https://player.example/watch','iframe',1);
  const videoDom=playerDocument(media);
  const parent={url:'https://event.example/watch',isDestroyed:()=>false,framesInSubtree:[] as object[],
    executeJavaScript:async(code:string)=>runInNewContext(code,{document:parentDom.page,getComputedStyle:parentDom.style,window:{},URL})};
  const player={url:'https://player.example/watch',parent,isDestroyed:()=>false,executeJavaScript:async(code:string)=>
    runInNewContext(code,{document:videoDom.page,getComputedStyle:videoDom.style,window:{},URL})};
  parent.framesInSubtree=[parent,player];
  const harness=createObserverHarness(parent),operation=harness.observer.observe(parent.url,'probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    emitMedia(harness,1,media,player);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(result,'pending');
    parentDom.element.getBoundingClientRect=()=>playerBox();videoDom.element.currentSrc='https://cdn.example/visible.m3u8';
    emitMedia(harness,2,videoDom.element.currentSrc,player);assert.equal((await operation.promise)?.url,videoDom.element.currentSrc);
  }finally{operation.cancel();}
});

test('duplicate sibling iframe addresses cannot claim the primary player identity',async()=>{
  const media='https://cdn.example/game.m3u8',ad='https://secondary.example/stream.m3u8',parentDom=playerDocument('https://player.example/watch','iframe');
  const parent={url:'https://event.example/watch',isDestroyed:()=>false,framesInSubtree:[] as object[],
    executeJavaScript:async(code:string)=>runInNewContext(code,{document:parentDom.page,getComputedStyle:parentDom.style,window:{},URL})};
  const player={...scriptedPlayer(media),parent},advertisement={...scriptedPlayer(ad),parent};
  parent.framesInSubtree=[parent,player,advertisement];
  const harness=createObserverHarness(parent),operation=harness.observer.observe(parent.url,'probe');assert.ok(operation);operation.start();
  let result:unknown='pending';void operation.promise.then((value:unknown)=>{result=value;});
  try{
    emitMedia(harness,1,ad,advertisement);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(result,'pending');
    parent.framesInSubtree=[parent,player];emitMedia(harness,2,media,player);assert.equal((await operation.promise)?.url,media);
  }finally{operation.cancel();}
});


test('the observer applies maintained ad filters inside its network listener',async()=>{
  const harness=createObserverHarness({framesInSubtree:[]});
  const operation=harness.observer.observe('https://player.example/watch','probe');assert.ok(operation);operation.start();
  try{
    harness.request({id:1,url:'https://googleads.g.doubleclick.net/pagead/ads',resourceType:'script',referrer:'https://player.example/watch'},{cancel:true});
    harness.request({id:2,url:'https://player.example/hls.min.js',resourceType:'script'});
  }finally{operation.cancel();await operation.promise;}
});

for(const condition of [
  {name:'transparent ancestor',style:{opacity:'0'},box:playerBox()},
  {name:'hidden ancestor',style:{visibility:'hidden'},box:playerBox()},
  {name:'collapsed ancestor',style:{visibility:'collapse'},box:playerBox()},
  {name:'display-none ancestor',style:{display:'none'},box:playerBox()},
  {name:'one-pixel horizontal clip',style:{overflowX:'hidden'},box:playerBox(1)},
  {name:'one-pixel vertical clip',style:{overflowY:'clip'},box:playerBox(640,1)},
  {name:'scrolling clip',style:{overflowY:'scroll'},box:playerBox(640,1)},
  {name:'automatic clip',style:{overflowY:'auto'},box:playerBox(640,1)},
])test('selected player evidence rejects a '+condition.name,()=>{
  const dom=playerDocument('https://media.example/game.m3u8');
  const ancestor:LayoutNode={parentElement:null,getBoundingClientRect:()=>condition.box,style:{...playerStyle(),...condition.style}};
  dom.element.parentElement={parentElement:ancestor,getBoundingClientRect:()=>playerBox(),style:playerStyle()};
  const inspect=observerRequire('./sportsurge-observer.cjs').selectedPlayerEvidence;
  assert.equal(runInNewContext(`(${inspect.toString()})()`,{document:dom.page,getComputedStyle:dom.style,window:{},URL}),null);
});

test('selected player evidence accepts enough unclipped area and offscreen players without a clipping ancestor',()=>{
  const dom=playerDocument('https://media.example/game.m3u8');
  const ancestor:LayoutNode={parentElement:null,getBoundingClientRect:()=>playerBox(240,135),style:{...playerStyle(),overflowX:'hidden',overflowY:'auto'}};
  dom.element.parentElement=ancestor;
  const inspect=observerRequire('./sportsurge-observer.cjs').selectedPlayerEvidence;
  const evidence=()=>runInNewContext(`(${inspect.toString()})()`,{document:dom.page,getComputedStyle:dom.style,window:{},URL});
  assert.equal(evidence()?.kind,'media');
  ancestor.style=playerStyle();dom.element.getBoundingClientRect=()=>playerBox(640,360,0,2000);
  assert.equal(evidence()?.kind,'media');
});

test('body overflow propagated to the viewport preserves visible player ownership',()=>{
  const dom=playerDocument('https://media.example/game.m3u8');
  const root={tagName:'HTML',parentElement:null,clientWidth:640,clientHeight:360,
    getBoundingClientRect:()=>playerBox(640,18),style:{...playerStyle(),contain:'none'}};
  const body={parentElement:root,getBoundingClientRect:()=>playerBox(640,18),
    style:{...playerStyle(),overflowY:'hidden',contain:'none'}};
  dom.element.parentElement=body;
  const page={...dom.page,body,documentElement:root};
  const inspect=observerRequire('./sportsurge-observer.cjs').selectedPlayerEvidence;
  const evidence=()=>runInNewContext(`(${inspect.toString()})()`,{document:page,getComputedStyle:dom.style,window:{},URL});
  assert.deepEqual(JSON.parse(JSON.stringify(evidence())),{
    kind:'media',sources:['https://media.example/game.m3u8'],jwSource:null,loaderConfigured:false,
  });
  root.style.contain='paint';assert.equal(evidence(),null);
  root.style.contain='none';body.style.contain='paint';assert.equal(evidence(),null);
  body.style.contain='none';root.style.overflowY='hidden';assert.equal(evidence(),null);
  root.style.overflowY='visible';dom.element.getBoundingClientRect=()=>playerBox(640,360,0,2000);
  assert.equal(evidence(),null);
});

test('render-skipped selected content cannot claim a media source despite a large layout rectangle',()=>{
  const dom=playerDocument('https://media.example/advert.mp4');
  Object.assign(dom.element,{checkVisibility(options:unknown){assert.deepEqual(JSON.parse(JSON.stringify(options)),{checkOpacity:true,checkVisibilityCSS:true,contentVisibilityAuto:true});return false;}});
  const inspect=observerRequire('./sportsurge-observer.cjs').selectedPlayerEvidence;
  assert.equal(runInNewContext('('+inspect.toString()+')()',{document:dom.page,getComputedStyle:dom.style,window:{},URL}),null);
});

test('browser-owned progressive video is captured explicitly through the selected frame',async()=>{
  const url='https://cdn.example/game.mp4',player=scriptedPlayer(url);
  const harness=createObserverHarness({framesInSubtree:[player]});
  const operation=harness.observer.observe(player.url,'probe');assert.ok(operation);operation.start();
  try{
    harness.request({id:1,url,resourceType:'media'});
    harness.sendHeaders({id:1,url,frame:player,requestHeaders:{referer:player.url,'user-agent':'Observer test'},initiatorOrigin:'https://player.example'});
    harness.receiveHeaders({id:1,url,statusCode:206,responseHeaders:{'content-type':['video/mp4']}});
    const result=await Promise.race([operation.promise,new Promise(resolve=>setTimeout(()=>resolve(null),50))]);
    assert.ok(result&&typeof result==='object'&&'kind'in result);assert.equal(result.kind,'progressive');assert.equal(result.url,url);
  }finally{operation.cancel();}
});
