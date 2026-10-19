import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [label = 'sample', duration = '10'] = process.argv.slice(2);
assert.match(label, /^[a-z0-9-]+$/);
const seconds = Number(duration);
assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60);
const targets = await (await fetch('http://127.0.0.1:9321/json/list')).json();
const target = targets.find(target => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(target, 'Start the local Electron app with --remote-debugging-port=9321');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const requests = {};
const errors = [];
let sampling = true;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (sampling && message.method === 'Network.requestWillBeSent') {
    const url = new URL(message.params.request.url);
    if (url.origin === new URL(target.url).origin && url.pathname.startsWith('/api/'))
      requests[url.pathname + (url.searchParams.get('view') === 'room' ? '?view=room' : '')] =
        (requests[url.pathname + (url.searchParams.get('view') === 'room' ? '?view=room' : '')] || 0) + 1;
  }
  if (message.method === 'Runtime.exceptionThrown')
    errors.push(message.params.exceptionDetails.text);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error || message.result.exceptionDetails)
    entry.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
  else entry.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async expression => (await send('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
})).result.value;
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
try {
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Performance.enable');
  const before = await metrics();
  await delay(seconds * 1000);
  const after = await metrics();
  sampling = false;
  const page = await evaluate(`({
    title:document.title, nodes:document.querySelectorAll('*').length,
    tiles:document.querySelectorAll('.game-tile').length,
    scripts:performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script')
      .map(r=>({path:new URL(r.name).pathname,bytes:r.decodedBodySize})),
    buttons:[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0)
      .map(b=>b.getAttribute('aria-label')||b.textContent.trim()).slice(0,35)
  })`);
  const api = await evaluate(`Promise.all(['/api/games','/api/sources','/api/sources?view=room'].map(async path=>{
    const start=performance.now(),response=await fetch(path),text=await response.text(),data=JSON.parse(text);
    return {path,status:response.status,ms:performance.now()-start,bytes:new TextEncoder().encode(text).length,
      games:data.games?.length,sources:data.sources?.length};
  }))`);
  const result = { label, seconds, url:target.url, requests, errors, page, api,
    taskMs:1000*(after.TaskDuration-before.TaskDuration),
    scriptMs:1000*(after.ScriptDuration-before.ScriptDuration),
    layoutMs:1000*(after.LayoutDuration-before.LayoutDuration),
    heapMB:after.JSHeapUsedSize/1024/1024 };
  const directory = resolve('.scratch/performance');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${label}-ui.json`), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  socket.close();
}
