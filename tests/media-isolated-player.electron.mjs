import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';

const fixture = resolve('.desktop-runtime/media-audit-fixes/isolated-media');
await mkdir(fixture, { recursive: true });
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'), [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
  '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-sc_threshold', '0',
  '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', resolve(fixture, 'segment-%03d.ts'), resolve(fixture, 'fixture.m3u8'),
], { windowsHide: true, timeout: 20_000 });
const targets = await (await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length, 1, 'Expected the running local Electron main inspector');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);

async function verifyPlayer(root, fixture) {
  const require = process.mainModule.require.bind(process.mainModule);
  const { BrowserWindow, WebContentsView, session } = process.mainModule.require('electron');
  const { join } = require('node:path');
  const fs = require('node:fs/promises');
  const { createIsolatedPlayers } = require(join(root, 'desktop/isolated-player.cjs'));
  const hostSession = session.fromPartition(`isolated-host-${require('node:crypto').randomUUID()}`);
  hostSession.protocol.handle('http', () => new Response('<!doctype html><title>Native player verification</title><button>Player controls</button>', { headers: { 'content-type': 'text/html' } }));
  const host = new BrowserWindow({ show: false, width: 900, height: 650,
    webPreferences: { session: hostSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const views = [], sessions = [], requests = [], states = [], downloads = [];
  let valid = true;
  let generation = 2;
  const send = host.webContents.send.bind(host.webContents);
  host.webContents.send = (channel, value) => { if (channel === 'sunday-player:state') states.push(value); send(channel, value); };
  const fixtureResponse = async request => {
    const url = new URL(request.url);
    requests.push(url.href);
    const headers = { 'access-control-allow-origin': '*' };
    if (url.href === 'https://embed.st/embed/basketball/game/1') return new Response(`<!doctype html><html><body style="margin:0">
      <h1>Unrelated source content</h1>
      <div id="player"><iframe src="https://media-fixture.example/player" style="width:640px;height:360px;border:0"></iframe></div>
      <iframe id="other" src="https://media-fixture.example/other-player" style="width:640px;height:360px"></iframe>
      <script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
      </body></html>`, { headers: { ...headers, 'content-type': 'text/html' } });
    if (url.href === 'https://media-fixture.example/player') return new Response(`<!doctype html><html><body style="margin:0">
      <div id="player"><video controls muted autoplay style="width:640px;height:360px"></video>
        <button id="provider-controls">Provider controls</button></div>
      <script src="https://media-fixture.example/hls.js"></script><script>
      (() => { const video = document.querySelector('video'); const privatePlayer = new Hls();
        privatePlayer.attachMedia(video); privatePlayer.loadSource('https://media-fixture.example/game.m3u8');
        privatePlayer.on(Hls.Events.MANIFEST_PARSED, () => video.play()); })();
      </script></body></html>`, { headers: { ...headers, 'content-type': 'text/html' } });
    if (url.hostname !== 'media-fixture.example') return new Response('', { status: 404 });
    if (url.pathname === '/hls.js') return new Response(await fs.readFile(join(root, 'node_modules/hls.js/dist/hls.js')), { headers: { ...headers, 'content-type': 'text/javascript' } });
    if (url.pathname === '/game.m3u8') return new Response(await fs.readFile(join(fixture, 'fixture.m3u8')), { headers: { ...headers, 'content-type': 'application/vnd.apple.mpegurl' } });
    if (/^\/segment-\d{3}\.ts$/.test(url.pathname)) return new Response(await fs.readFile(join(fixture, url.pathname.slice(1))), { headers: { ...headers, 'content-type': 'video/mp2t' } });
    if (url.pathname === '/download') return new Response('Fixture download', { headers: { ...headers, 'content-disposition': 'attachment; filename="fixture.txt"' } });
    if (url.pathname === '/worker.js') return new Response(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(clients.claim()));`, { headers: { ...headers, 'content-type': 'text/javascript' } });
    return new Response('', { status: 404 });
  };
  const factory = createIsolatedPlayers({
    authorizeTarget: async target => valid && target.sessionId === 'd03a2653-5d97-4453-8e6b-681861777337' && target.generation === generation,
    createSession() {
      const own = session.fromPartition(`isolated-native-${require('node:crypto').randomUUID()}`);
      own.protocol.handle('https', fixtureResponse); sessions.push(own);
      return own;
    },
    createView(preferences) { const view = new WebContentsView({ webPreferences: preferences }); views.push(view); return view; },
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let timer;
  try {
    await host.loadURL('http://127.0.0.1:9000/');
    factory.registerHost(host, 'http://127.0.0.1:9000', 'viewing');
    const event = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
    const capability = await factory.offer({ target: { sessionId: 'd03a2653-5d97-4453-8e6b-681861777337',
      candidateId: 'selected', gameId: 'nba-123', generation: 2 },
      player: { url: 'https://embed.st/embed/basketball/game/1', referer: 'https://ppv.st/events/game' } });
    const dormant = { views: views.length, sessions: sessions.length };
    let untrustedRejected = false;
    try { await factory.mount({ ...event, senderFrame: {} }, { capability }); } catch { untrustedRejected = true; }
    await Promise.race([factory.mount(event, { capability }), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native player mount timed out')), 12_000);
    })]);
    clearTimeout(timer);
    await factory.update(event, { capability, bounds: { x: 0, y: 0, width: 640, height: 360 }, visible: true,
      playing: true, audible: true, volume: 0.4, focused: false });
    const view = views[0];
    const contents = view.webContents;
    sessions[0].on('will-download', event => downloads.push({ prevented: event.defaultPrevented }));
    const deadline = Date.now() + 12_000;
    while (!states.some(state => state.kind === 'decoded') && Date.now() < deadline) await wait(200);
    const frame = contents.mainFrame.framesInSubtree.find(frame => frame.url === 'https://media-fixture.example/player');
    if (!frame) throw new Error('The selected nested player frame did not load');
    const sample = () => frame.executeJavaScript(`(() => {const video=document.querySelector('video');return {
      time:video.currentTime,frames:video.getVideoPlaybackQuality().totalVideoFrames,width:video.videoWidth,height:video.videoHeight,
      paused:video.paused,volume:video.volume,muted:video.muted,currentSrc:video.currentSrc,
      controls:video.controls,
      providerControlsVisible:document.querySelector('#provider-controls').checkVisibility(),
      node:typeof require,process:typeof process,appBridge:typeof window.sundayDesktop,verifierBridge:typeof window.__sundayVerify,
      exposedHls:typeof window.hls};})()`);
    const before = await sample();
    const interaction = await frame.executeJavaScript(`(() => {
      const video = document.querySelector('video'); video.focus();
      return { pointerTargetsPlayer: document.querySelector('#player').contains(document.elementFromPoint(160, 100)),
        keyboardTargetsVideo: document.activeElement === video };
    })()`);
    const interrupted = await frame.executeJavaScript(`(() => {
      const video=document.querySelector('video');video.pause();return {paused:video.paused,time:video.currentTime};
    })()`);
    const resumeDeadline=Date.now()+3000;
    let recovered=await sample();
    while((recovered.paused||recovered.time-interrupted.time<0.5)&&Date.now()<resumeDeadline){
      await wait(100);recovered=await sample();
    }
    await factory.update(event, { capability, playing: false }); await wait(700);
    const paused = await sample();
    await wait(700);
    const stillPaused=await sample();
    await frame.executeJavaScript(`(() => {
      const video=document.querySelector('video'),play=video.play.bind(video);let attempts=0;
      window.__fixturePlayAttempts=()=>attempts;
      video.play=()=>++attempts===1?Promise.reject(new DOMException('Fixture play interrupted','AbortError')):play();
    })()`);
    await factory.update(event, { capability, playing: true }); await wait(2200);
    const resumed = await sample();
    const playAttempts=await frame.executeJavaScript('window.__fixturePlayAttempts()');
    await factory.update(event, { capability, visible: false });
    const hidden = { visible: view.getVisible(), muted: contents.isAudioMuted() };
    await factory.update(event, { capability, visible: true });
    const restored = { visible: view.getVisible(), muted: contents.isAudioMuted() };
    const size = host.getContentBounds();
    await factory.update(event, { capability, bounds: { x: size.width - 100, y: size.height - 100, width: 400, height: 300 } });
    const clipped = view.getBounds();
    await factory.update(event, { capability, bounds: { x: 0, y: 0, width: 640, height: 360 } });
    const popup = await frame.executeJavaScript(`window.open('https://media-fixture.example/popup','_blank') === null`);
    await contents.executeJavaScript(`location.href='https://media-fixture.example/unrelated-navigation'`); await wait(100);
    const navigation = contents.getURL();
    const otherHidden = await contents.executeJavaScript(`getComputedStyle(document.querySelector('#other')).display === 'none'`);
    const permission = await frame.executeJavaScript(`new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve('allowed'),error=>resolve(error.code===1?'denied':'error')))`);
    await frame.executeJavaScript(`(()=>{const a=document.createElement('a');a.href='https://media-fixture.example/download';a.download='fixture.txt';a.click();})()`); await wait(250);
    await sessions[0].cookies.set({url:'https://media-fixture.example',name:'previousPlayer',value:'fixture',secure:true,sameSite:'no_restriction'});
    const storageBefore = await frame.executeJavaScript(`(async()=>{
      localStorage.setItem('previousPlayer','fixture');
      await navigator.serviceWorker.register('/worker.js');
      await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fixture service worker did not activate')),3000))]);
      return {cookie:document.cookie,local:localStorage.getItem('previousPlayer'),workers:(await navigator.serviceWorker.getRegistrations()).length};
    })()`);
    storageBefore.cookieJar=(await sessions[0].cookies.get({url:'https://media-fixture.example'})).map(cookie=>({name:cookie.name,value:cookie.value}));
    valid = false; factory.revoke(capability); await wait(100);
    const closed = contents.isDestroyed();
    let staleRejected = false;
    try { await factory.mount(event, { capability }); } catch { staleRejected = true; }
    valid = true; generation = 3; await wait(500);
    const next = await factory.offer({ target: { sessionId: 'd03a2653-5d97-4453-8e6b-681861777337',
      candidateId: 'next-selected', gameId: 'nba-123', generation },
      player: { url: 'https://embed.st/embed/basketball/game/1', referer: 'https://ppv.st/events/game' } });
    await factory.mount(event, { capability: next });
    await factory.update(event, { capability: next, bounds: { x: 0, y: 0, width: 640, height: 360 }, visible: true, playing: true, audible: false, volume: 0 });
    const nextContents = views[1].webContents;
    const nextDeadline = Date.now() + 5000;
    let nextFrame;
    while (!nextFrame && Date.now() < nextDeadline) {
      nextFrame = nextContents.mainFrame.framesInSubtree.find(frame => frame.url === 'https://media-fixture.example/player');
      if (!nextFrame) await wait(100);
    }
    if (!nextFrame) throw new Error('The next generation did not load its selected player');
    const storageAfter = await nextFrame.executeJavaScript(`(async()=>({cookie:document.cookie,local:localStorage.getItem('previousPlayer'),workers:(await navigator.serviceWorker.getRegistrations()).length}))()`);
    storageAfter.cookieJar=(await sessions.at(-1).cookies.get({url:'https://media-fixture.example'})).map(cookie=>({name:cookie.name,value:cookie.value}));
    const pool = { sessionAllocations: sessions.length, viewAllocations: views.length };
    const proofDeadline=Date.now()+12000;
    while(!states.some(state=>state.capability===next&&state.kind==='decoded')&&Date.now()<proofDeadline)await wait(100);
    const freezeProved=states.some(state=>state.capability===next&&state.kind==='decoded');
    if(!freezeProved)throw new Error('Native freeze fixture requires advancing-video proof');
    const frozen=await nextFrame.executeJavaScript(`(() => {
      const video=document.querySelector('video');video.playbackRate=0;
      return {paused:video.paused,rate:video.playbackRate,time:video.currentTime,frames:video.getVideoPlaybackQuality().totalVideoFrames};
    })()`);
    const freezeStarted=Date.now(),freezeDeadline=freezeStarted+18000;
    while(!states.some(state=>state.capability===next&&state.kind==='failed')&&Date.now()<freezeDeadline)await wait(100);
    const freeze={proved:freezeProved,frozen,elapsedMs:Date.now()-freezeStarted,
      failures:states.filter(state=>state.capability===next&&state.kind==='failed').map(state=>({kind:state.kind,reason:state.reason})),
      closed:nextContents.isDestroyed(),viewAllocations:views.length};
    factory.revoke(next);
    return { dormant, untrustedRejected, before, interaction, interrupted, recovered, paused, stillPaused, resumed, playAttempts, hidden, restored, clipped, hostSize: size,
      popup, navigation, otherHidden, permission, downloads, closed, staleRejected,
      storageBefore, storageAfter, pool,freeze,
      states: states.map(state => ({ kind: state.kind, ...(state.proof ? { proof: state.proof } : {}),
        ...(state.reason ? { reason: state.reason } : {}) })), requests };
  } catch (error) {
    return { failure: error.message, requests,
      states: states.map(state => ({ kind: state.kind, ...(state.proof ? { proof: state.proof } : {}) })) };
  } finally {
    clearTimeout(timer); factory.stop(); host.destroy(); hostSession.protocol.unhandle('http');
    for (const own of sessions) { own.protocol.unhandle('https'); await own.closeAllConnections(); await own.clearStorageData(); }
  }
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
  });
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error('Native isolated-player verification timed out')), 60_000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data); if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolveResult(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${verifyPlayer.toString()})(${JSON.stringify(resolve('.'))},${JSON.stringify(fixture)})`, awaitPromise: true, returnByValue: true,
    } }));
  });
  const output = resolve(process.argv[2] ?? '.desktop-runtime/media-audit-fixes/native-isolated-player.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  assert.equal(result.failure, undefined, result.failure);
  assert.deepEqual(result.dormant, { views: 0, sessions: 0 });
  assert.equal(result.untrustedRejected, true);
  assert.ok(result.states.some(state => state.kind === 'decoded' && state.proof.mediaAdvanceMs >= 2000 && state.proof.presentedFrames >= 3), 'The runtime must prove advancing decoded video inside the selected iframe');
  assert.equal(result.before.width, 320); assert.equal(result.before.height, 180);
  assert.deepEqual(result.interaction, { pointerTargetsPlayer: false, keyboardTargetsVideo: false }, 'Pointer and keyboard input must not reach the provider player');
  assert.equal(result.before.controls, false, 'The embedded video must not expose native controls');
  assert.equal(result.before.providerControlsVisible, false, 'Provider controls must stay hidden');
  assert.ok(result.before.currentSrc.startsWith('blob:')); assert.equal(result.before.exposedHls, 'undefined');
  for (const name of ['node', 'process', 'appBridge', 'verifierBridge']) assert.equal(result.before[name], 'undefined');
  assert.equal(result.interrupted.paused,true);
  assert.equal(result.recovered.paused,false,'A native provider pause must resume without switching feeds');
  assert.ok(result.recovered.time-result.interrupted.time>=0.5,'Recovered native video must advance');
  assert.equal(result.stillPaused.paused,true,'An explicit pause must survive automatic reconciliation');
  assert.ok(Math.abs(result.stillPaused.time-result.paused.time)<0.1);
  assert.equal(result.paused.paused, true); assert.equal(result.resumed.paused, false);
  assert.equal(result.playAttempts,2,'An interrupted native play must retry without another layout command');
  assert.ok(result.resumed.time - result.paused.time >= 1.8 && result.resumed.frames > result.paused.frames);
  assert.equal(result.resumed.volume, 0.4);
  assert.deepEqual(result.hidden, { visible: false, muted: true }); assert.deepEqual(result.restored, { visible: true, muted: false });
  assert.equal(result.clipped.width, 400); assert.equal(result.clipped.height, 300);
  assert.equal(result.popup, true); assert.equal(result.permission, 'denied');
  assert.equal(result.navigation, 'https://embed.st/embed/basketball/game/1'); assert.equal(result.otherHidden, true);
  assert.ok(result.downloads.length > 0 && result.downloads.every(download => download.prevented), 'Player downloads must be canceled');
  assert.ok(!result.requests.some(url => url.includes('adsbygoogle.js') || url.endsWith('/other-player')), 'Ads and unrelated player iframes must not load');
  assert.equal(result.closed, true); assert.equal(result.staleRejected, true);
  assert.deepEqual(result.storageBefore.cookieJar,[{name:'previousPlayer',value:'fixture'}]);
  assert.equal(result.storageBefore.local, 'fixture'); assert.equal(result.storageBefore.workers, 1);
  assert.deepEqual(result.storageAfter, { cookie: '', local: null, workers: 0, cookieJar: [] });
  assert.deepEqual(result.pool, { sessionAllocations: 1, viewAllocations: 2 });
  assert.equal(result.freeze.proved,true);
  assert.equal(result.freeze.frozen.paused,false,'The freeze fixture must retain playing intent');
  assert.equal(result.freeze.frozen.rate,0);
  assert.deepEqual(result.freeze.failures,[{kind:'failed',reason:'upstream'}],'A sustained native freeze must enter existing feed recovery once');
  assert.equal(result.freeze.closed,true);
  assert.equal(result.freeze.viewAllocations,2,'Native recovery must not allocate an independent replacement player');
} finally { socket.close(); }
