import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--port', '--seconds', '--output', '--check', '--streams'].includes(key) && value, 'Expected named measurement options');
  options.set(key, value);
}
const port = Number(options.get('--port') ?? 9321);
const seconds = Number(options.get('--seconds') ?? 10);
const streamCount = Number(options.get('--streams') ?? 4);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 300);
assert.ok(Number.isInteger(streamCount) && streamCount >= 1 && streamCount <= 4);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
assert.ok(target, 'The local Electron watch room must be running');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const result = JSON.parse(event.data);
  const entry = pending.get(result.id);
  if (!entry) return;
  pending.delete(result.id);
  clearTimeout(entry.timer);
  if (result.error) entry.reject(new Error(result.error.message));
  else entry.resolve(result.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const run = promisify(execFile);
async function processes() {
  const projectPath = resolve('.desktop-runtime/electron/electron.exe').replaceAll("'", "''");
  const script = `$ids=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${projectPath}' } | Select-Object -ExpandProperty ProcessId); @(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{id=$_.Id;bytes=$_.WorkingSet64;cpuSeconds=$_.CPU} }) | ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  return JSON.parse(stdout);
}
async function videos() {
  const result = await command('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify([...document.querySelectorAll('video')].map(video => {
    let fiber=video[Object.keys(video).find(key=>key.startsWith('__reactFiber$'))],hls;
    while(fiber&&!hls){
      let hook=fiber.memoizedState;
      while(hook){
        const ref=hook.memoizedState?.current;
        if(ref?.config&&ref?.streamController){hls=ref;break;}
        hook=hook.next;
      }
      fiber=fiber.return;
    }
    const transmuxer=hls?.streamController?.transmuxer;
    return {
    currentTime:video.currentTime,paused:video.paused,readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,
    frames:video.getVideoPlaybackQuality().totalVideoFrames,dropped:video.getVideoPlaybackQuality().droppedVideoFrames,
    behind:video.buffered.length?Math.max(0,video.currentTime-video.buffered.start(0)):0,
    ahead:video.buffered.length?Math.max(0,video.buffered.end(video.buffered.length-1)-video.currentTime):0,
    hls:hls?{version:hls.constructor.version,workerPathConfigured:!!hls.config.workerPath,
      workerActive:!!transmuxer?.workerContext,inlineTransmuxer:!!transmuxer?.transmuxer}:null
  }}))` });
  assert.ok(!result.exceptionDetails, 'Could not inspect Electron video playback');
  return JSON.parse(result.result.value);
}
try {
  const before = { processes: await processes(), videos: await videos() };
  if(options.get('--check')==='worker'){
    assert.equal(before.videos.length,streamCount,'Worker check requires the intended room workload');
    for(const [index,video] of before.videos.entries()){
      assert.ok(video.hls?.workerPathConfigured&&video.hls.workerActive&&!video.hls.inlineTransmuxer,
        `Stream ${index+1} must transmux in the installed local worker`);
    }
  }
  await command('Runtime.evaluate',{expression:`(()=>{
    const proto=HTMLVideoElement.prototype,original=proto.requestVideoFrameCallback;
    const measurement={original,callbacks:0};
    proto.requestVideoFrameCallback=function(callback){
      return original.call(this,(...args)=>{measurement.callbacks++;callback(...args);});
    };
    window.__playbackResourceMeasurement=measurement;
  })()`});
  await command('Profiler.enable');
  await command('Profiler.start');
  const started = performance.now();
  const targetSamples = [];
  while (performance.now() - started < seconds * 1000) {
    await delay(Math.min(2000, seconds * 1000 - (performance.now() - started)));
    const { targetInfos } = await command('Target.getTargets');
    targetSamples.push(targetInfos.map(item => ({ type: item.type, url: item.url.split('?')[0] })));
  }
  const after = { processes: await processes(), videos: await videos() };
  const elapsedSeconds = (performance.now() - started) / 1000;
  const { profile } = await command('Profiler.stop');
  const measured=await command('Runtime.evaluate',{returnByValue:true,expression:'window.__playbackResourceMeasurement.callbacks'});
  const previous = new Map(before.processes.map(item => [item.id, item]));
  const cpuCorePercent = after.processes.reduce((sum, item) => sum +
    (previous.has(item.id) ? 100 * (item.cpuSeconds - previous.get(item.id).cpuSeconds) / elapsedSeconds : 0), 0);
  const result = { at: new Date().toISOString(), elapsedSeconds, cpuCorePercent,frameCallbacks:measured.result.value,
    workingSetMB: after.processes.reduce((sum, item) => sum + item.bytes / 1048576, 0), before, after, targetSamples };
  if (options.has('--output')) {
    const output = resolve(options.get('--output'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await writeFile(`${output}.cpuprofile`, JSON.stringify(profile));
  }
  console.log(JSON.stringify({ cpuCorePercent, workingSetMB: result.workingSetMB, frameCallbacks:result.frameCallbacks,videos: after.videos }));
  if (options.get('--check') === 'buffer'||options.get('--check')==='worker') {
    assert.equal(before.videos.length, streamCount, 'Verify the initial room workload');
    assert.equal(after.videos.length, streamCount, 'The measured room workload must remain unchanged');
    for (const [index, video] of after.videos.entries()) {
      assert.ok(!video.paused && video.readyState >= 2 && video.width > 0, `Stream ${index + 1} must be playing`);
      assert.ok(video.currentTime > before.videos[index].currentTime + seconds / 2, `Stream ${index + 1} must advance`);
      assert.ok(video.behind <= 35, `Stream ${index + 1} retains ${video.behind.toFixed(1)}s of played video, exceeding 35s`);
    }
  }
  if(options.get('--check')==='worker'){
    for(const [index,video] of after.videos.entries()){
      assert.ok(video.hls?.workerActive&&!video.hls.inlineTransmuxer,`Stream ${index+1} must retain its worker`);
      assert.equal(video.width,before.videos[index].width,`Stream ${index+1} width must remain unchanged`);
      assert.equal(video.height,before.videos[index].height,`Stream ${index+1} height must remain unchanged`);
    }
    assert.ok(result.frameCallbacks<=streamCount*(6+6*Math.ceil(seconds/60)),
      `Playback evidence must sleep between reporting windows, observed ${result.frameCallbacks} callbacks`);
  }
  if (['buffer','sources','worker'].includes(options.get('--check'))) {
    assert.ok(targetSamples.some(items => items.some(item => item.type === 'page' && item.url.startsWith('https://'))),
      'Source observations must run alongside playback');
    const trackers = new Set(['https://pxdrop.lijit.com/a/t_.htm', 'https://t.sharethis.com/a/t_.htm',
      'https://tags.crwdcntrl.net/lt/shared/2/lt.iframe.html']);
    assert.ok(targetSamples.every(items => items.every(item => !trackers.has(item.url))),
      'Source checking must not load the tracking frame documents');
  }
} finally {
  await command('Runtime.evaluate',{expression:`(()=>{
    const measurement=window.__playbackResourceMeasurement;
    if(measurement){HTMLVideoElement.prototype.requestVideoFrameCallback=measurement.original;
      delete window.__playbackResourceMeasurement;}
  })()`}).catch(()=>{});
  socket.close();
}
