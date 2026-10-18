import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 9331);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Expected the local Electron main inspector port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
assert.equal(targets.length, 1, 'Expected one local Electron main inspector');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);

async function verifyOwnership(root) {
  const require = process.mainModule.require.bind(process.mainModule);
  const { BrowserWindow, session } = process.mainModule.require('electron');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const { selectedPlayerEvidence } = require(path.join(root, 'desktop/sportsurge-observer.cjs'));
  const fixture = path.join(root, '.desktop-runtime/media-audit-fixes/native-media');
  await fs.mkdir(fixture, { recursive: true });
  await execFile(require(path.join(root, 'node_modules/ffmpeg-static')), [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-sc_threshold', '0',
    '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(fixture, 'segment-%03d.ts'), path.join(fixture, 'fixture.m3u8'),
  ], { windowsHide: true, timeout: 20_000 });
  const requests = [];
  const concealedVideo='<div id="player"><video src="https://ads.example/advert.mp4" style="width:640px;height:360px"></video></div>';
  const concealments={
    dialog:`<dialog>${concealedVideo}</dialog>`,details:`<details>${concealedVideo}</details>`,template:`<template>${concealedVideo}</template>`,
    inline:`<div style="display:none">${concealedVideo}</div>`,css:`<style>#player{display:none}</style>${concealedVideo}`,
    script:`${concealedVideo}<script>document.querySelector('#player').hidden=true</script>`,
  };
  const ownSession = session.fromPartition(`ownership-verification-${require('node:crypto').randomUUID()}`);
  ownSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ownSession.setPermissionCheckHandler(() => false);
  await ownSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    requests.push(url.href);
    const headers = { 'access-control-allow-origin': '*' };
    if (url.hostname !== 'media-fixture.example' && url.hostname !== 'ads.example') return new Response('', { status: 404 });
    if (url.pathname === '/hls.js') return new Response(await fs.readFile(path.join(root, 'node_modules/hls.js/dist/hls.js')), { headers: { ...headers, 'content-type': 'text/javascript' } });
    if (url.pathname === '/game.m3u8') return new Response(await fs.readFile(path.join(fixture, 'fixture.m3u8')), { headers: { ...headers, 'content-type': 'application/vnd.apple.mpegurl' } });
    if (/^\/segment-\d{3}\.ts$/.test(url.pathname)) return new Response(await fs.readFile(path.join(fixture, url.pathname.slice(1))), { headers: { ...headers, 'content-type': 'video/mp2t' } });
    if (url.pathname === '/player') return new Response(`<!doctype html><html><body>
      <div id="player"><video muted autoplay style="width:640px;height:360px"></video></div>
      <script src="/hls.js"></script><script>
      window.hls = new Hls(); hls.attachMedia(document.querySelector('video'));
      hls.loadSource('https://media-fixture.example/game.m3u8');
      hls.on(Hls.Events.MANIFEST_PARSED, () => document.querySelector('video').play());
      fetch('https://ads.example/ad.m3u8');
      </script></body></html>`, { headers: { ...headers, 'content-type': 'text/html' } });
    if (url.pathname === '/iframes') return new Response(`<!doctype html><html><body>
      <div id="player"><iframe src="https://media-fixture.example/frame" style="width:640px;height:360px"></iframe></div>
      <iframe src="https://ads.example/frame" style="width:640px;height:360px"></iframe>
      <iframe src="https://ads.example/hidden-frame" style="width:1px;height:1px"></iframe>
      </body></html>`, { headers: { ...headers, 'content-type': 'text/html' } });
    if(url.pathname.startsWith('/concealed/'))return new Response(`<!doctype html><body>${concealments[url.pathname.split('/').at(-1)]}<iframe src="https://media-fixture.example/actual-player" style="width:640px;height:360px"></iframe>`,{headers:{...headers,'content-type':'text/html'}});
    return new Response('', { status: 404, headers });
  });
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
    session: ownSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const inspect = () => window.webContents.executeJavaScript(`(${selectedPlayerEvidence.toString()})()`);
  const sample = () => window.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('video');
    return { time: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames,
      width: video.videoWidth, height: video.videoHeight, currentSrc: video.currentSrc,
      paused: video.paused, error: video.error?.code ?? null };
  })()`);
  try {
    await window.loadURL('https://media-fixture.example/player');
    let before;
    const deadline = Date.now() + 15_000;
    do {
      before = await sample();
      if (before.width > 0 && before.frames > 0) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    const media = await inspect();
    await new Promise(resolve => setTimeout(resolve, 2200));
    const after = await sample();
    await window.webContents.executeJavaScript(`document.querySelector('#player').style.opacity = '0'`);
    const hiddenAncestor = await inspect();
    await window.webContents.executeJavaScript(`document.querySelector('#player').style.cssText = 'height:1px;overflow:hidden'`);
    const clippedAncestor = await inspect();
    await window.loadURL('https://media-fixture.example/iframes');
    const iframe = await inspect();
    await window.webContents.executeJavaScript(`document.querySelector('#player').insertAdjacentHTML('beforeend', '<iframe src="https://media-fixture.example/second" style="width:640px;height:360px"></iframe>')`);
    const ambiguous = await inspect();
    const concealmentCensus={},nativeVisibility={};
    for(const kind of Object.keys(concealments)){
      await window.loadURL('https://media-fixture.example/concealed/'+kind);
      concealmentCensus[kind]=await inspect();
      nativeVisibility[kind]=await window.webContents.executeJavaScript(`[...document.querySelectorAll('video')].map(video=>({checkVisibility:video.checkVisibility({checkOpacity:true,checkVisibilityCSS:true,contentVisibilityAuto:true}),rect:{width:video.getBoundingClientRect().width,height:video.getBoundingClientRect().height}}))`);
    }
    return { media, before, after, hiddenAncestor, clippedAncestor, iframe, ambiguous, concealmentCensus, nativeVisibility, requests };
  } finally {
    window.destroy();
    ownSession.protocol.unhandle('https');
    await ownSession.closeAllConnections();
  }
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error('Native ownership verification timed out')), 55_000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolveResult(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${verifyOwnership.toString()})(${JSON.stringify(resolve('.'))})`,
      awaitPromise: true, returnByValue: true,
    } }));
  });
  const output = resolve(process.argv[3] ?? '.desktop-runtime/media-audit-fixes/native-ownership.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  assert.deepEqual(result.media.sources, ['https://media-fixture.example/game.m3u8']);
  assert.equal(result.media.kind, 'media');
  assert.ok(result.before.currentSrc.startsWith('blob:'), 'The real Hls.js player must use MSE');
  assert.equal(result.after.width, 320);
  assert.equal(result.after.height, 180);
  assert.equal(result.after.error, null);
  assert.equal(result.after.paused, false);
  assert.ok(result.after.time - result.before.time >= 1.8 && result.after.frames > result.before.frames, 'The owned HLS player must keep decoding video');
  assert.ok(result.requests.includes('https://ads.example/ad.m3u8'), 'The unrelated ad request must have occurred');
  assert.equal(result.hiddenAncestor, null, 'An opaque child inside a transparent parent must not count as the visible player');
  assert.equal(result.clippedAncestor, null, 'A full-size child clipped to one pixel must not count as the visible player');
  assert.deepEqual(result.iframe, { kind: 'frame', url: 'https://media-fixture.example/frame' });
  assert.equal(result.ambiguous, null);
  for(const [kind,evidence] of Object.entries(result.concealmentCensus)){
    assert.ok(evidence===null||evidence.kind==='frame'&&evidence.url==='https://media-fixture.example/actual-player',`${kind} cannot promote concealed ad media`);
  }
} finally {
  socket.close();
}
