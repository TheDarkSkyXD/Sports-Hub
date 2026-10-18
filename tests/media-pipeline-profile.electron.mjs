import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const seconds = Number(process.argv[2] ?? 10);
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 30, 'Profile for 5 to 30 seconds');
const [mainTargets, pageTargets] = await Promise.all([9331, 9321].map(async port =>
  (await fetch(`http://127.0.0.1:${port}/json/list`)).json()));
const room = pageTargets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(mainTargets[0] && room, 'The local Electron app must already be running');

async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    command(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

const connections = await Promise.all([mainTargets[0], room].map(attach));
const [main, renderer] = connections;
const metrics = async () => {
  const result = await main.command('Runtime.evaluate', { returnByValue: true, expression:
    "process.mainModule.require('electron').app.getAppMetrics().map(({pid,type,cpu,memory,serviceName})=>({pid,type,cpu,memory,serviceName}))" });
  assert.ok(!result.exceptionDetails, 'Native process metrics must be readable');
  return result.result.value;
};
const summarize = profile => {
  const counts = new Map();
  for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return profile.nodes.map(node => ({
    function: node.callFrame.functionName, url: node.callFrame.url,
    line: node.callFrame.lineNumber + 1, samples: counts.get(node.id) ?? 0,
  })).filter(node => node.samples > 0).sort((a, b) => b.samples - a.samples).slice(0, 20);
};

try {
  await Promise.all(connections.map(async connection => {
    await connection.command('Profiler.enable');
    await connection.command('Profiler.start');
  }));
  const before = await metrics();
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const after = await metrics();
  const profiles = await Promise.all(connections.map(connection => connection.command('Profiler.stop')));
  const inventory = await renderer.command('Runtime.evaluate', { returnByValue: true, awaitPromise: true,
    expression: `fetch('/api/sources').then(r=>r.json()).then(s=>({games:s.games.length,candidates:s.games.reduce((n,g)=>n+g.candidates.length,0),counts:s.games.flatMap(g=>g.candidates).reduce((o,c)=>{const k=c.availability.kind;o[k]=(o[k]||0)+1;return o},{})}))` });
  assert.ok(!inventory.exceptionDetails, 'Source inventory must be readable');
  const beforeIds = new Set(before.map(process => process.pid));
  const afterIds = new Set(after.map(process => process.pid));
  const turnover = { started: after.filter(process => !beforeIds.has(process.pid)).map(({ pid, type }) => ({ pid, type })),
    departed: before.filter(process => !afterIds.has(process.pid)).map(({ pid, type }) => ({ pid, type })) };
  const result = { at: new Date().toISOString(), seconds, before, after, turnover,
    inventory: inventory.result.value, main: summarize(profiles[0].profile), renderer: summarize(profiles[1].profile) };
  const output = resolve(process.argv[3] ?? '.desktop-runtime/media-audit-fixes/pipeline-profile.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  for (const [index, name] of ['main', 'renderer'].entries()) {
    await writeFile(`${output}.${name}.cpuprofile`, JSON.stringify(profiles[index].profile));
  }
  console.log(JSON.stringify({ seconds, inventory: result.inventory,
    processCount: after.length, started: turnover.started.length, departed: turnover.departed.length,
    processes: after.map(process => ({ pid: process.pid, type: process.type,
      cpu: process.cpu.percentCPUUsage, workingSetMB: process.memory.workingSetSize / 1024,
      serviceName: process.serviceName })).sort((a, b) => b.cpu - a.cpu),
    main: result.main.slice(0, 5), renderer: result.renderer.slice(0, 5) }));
} finally {
  await Promise.allSettled(connections.map(connection => connection.command('Profiler.disable')));
  for (const connection of connections) connection.close();
}
