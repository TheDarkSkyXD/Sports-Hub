import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 9321);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Expected an Electron debugging port');
const policy = JSON.parse(await readFile(new URL('../lib/playback/verification-policy.json', import.meta.url), 'utf8'));
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const room = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(room, 'The local Electron watch room must be running');
const verifier = targets.find(target => target.type === 'page' && target.url === new URL('/internal/playback-verifier', room.url).href);

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron inspection timed out')), 15_000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result.exceptionDetails) {
          reject(new Error(message.error?.message ?? message.result.exceptionDetails.text));
        } else resolve(message.result.result.value);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    socket.close();
  }
}

const [inventory, players] = await Promise.all([
  evaluate(room, `fetch('/api/sources').then(async response => {
    if (!response.ok) throw new Error('Source inventory is unavailable');
    const snapshot = await response.json();
    const candidates = snapshot.games.flatMap(game => game.candidates);
    return { at: snapshot.at, games: snapshot.games.length, candidates: candidates.length,
      checks:snapshot.checks?{active:snapshot.checks.active,limit:snapshot.checks.limit,queued:snapshot.checks.queued,completed:snapshot.checks.completed}:null,
      activeRows: snapshot.games.flatMap(game => game.candidates.filter(candidate => candidate.availability.kind === 'checking' && candidate.availability.progress.kind === 'active').map(candidate => ({gameId:game.gameId,id:candidate.id,sourceIds:candidate.sourceIds,progress:candidate.availability.progress}))),
      active: candidates.filter(candidate => candidate.availability.kind === 'checking' && candidate.availability.progress.kind === 'active').length,
      queued: candidates.filter(candidate => candidate.availability.kind === 'checking' && candidate.availability.progress.kind === 'queued').length,
      playable: candidates.filter(candidate => candidate.availability.kind === 'playable').length };
  })`),
  verifier ? evaluate(verifier, `({ assignments:document.querySelector('main')?.children.length??0, mounted: document.querySelectorAll('video').length,
    decoded: [...document.querySelectorAll('video')].filter(video => video.videoWidth > 0 && video.videoHeight > 0).length })`) : { mounted: 0, decoded: 0 },
]);
const result = { at: new Date().toISOString(), limit: policy.concurrency, inventory, players };
if (process.argv.includes('--viewer')) {
  const sample = () => evaluate(room, `[...document.querySelectorAll('video')].map(video => ({
    time: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames,
    width: video.videoWidth, height: video.videoHeight, ready: video.readyState, paused: video.paused,
    error: video.error?.code ?? null }))`);
  const before = await sample();
  await new Promise(resolve => setTimeout(resolve, 2500));
  const after = await sample();
  result.viewer = { before, after };
}
const output = resolve(process.argv[3] ?? '.desktop-runtime/media-audit-fixes/checker-capacity.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if(result.viewer){
  const {before,after}=result.viewer;
  assert.ok(before.length > 0, 'Open a feed in the Electron watch room before checking playback');
  for (const [index, previous] of before.entries()) {
    const current = after[index];
    assert.ok(current && current.width > 0 && current.height > 0 && current.ready >= 2 && !current.paused && current.error === null,
      `Viewer ${index + 1} must decode video without a media error`);
    assert.ok(current.time - previous.time >= 2 && current.frames > previous.frames,
      `Viewer ${index + 1} must keep presenting advancing video while checks run`);
  }
}
assert.ok(inventory.checks,'The current source snapshot must report physical checker work');
assert.equal(inventory.checks.limit,policy.concurrency);
assert.ok(inventory.checks.active <= policy.concurrency, `Physical checks ${inventory.checks.active} exceed the overall limit ${policy.concurrency}`);
assert.ok((players.assignments??0) <= policy.concurrency, `Rendered verification assignments ${players.assignments} exceed the overall limit ${policy.concurrency}`);
assert.ok(players.mounted <= policy.concurrency, `Mounted verification players ${players.mounted} exceed the overall limit ${policy.concurrency}`);
