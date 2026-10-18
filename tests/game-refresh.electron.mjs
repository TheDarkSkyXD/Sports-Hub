import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const port = Number(process.env.ELECTRON_INSPECT_PORT ?? 9331);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'node');
assert.ok(target, 'The development Electron main inspector must be running');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const expression = `
(async () => {
  const require = process.mainModule.require.bind(process.mainModule);
  const { BrowserWindow } = require('electron');
  const { createServer } = require('node:http');
  const { createPlaybackVerifier } = require(${JSON.stringify(resolve('desktop/playback-verifier.cjs'))});
  const held = new Set();
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/stream/')) {
      held.add(response);
      response.on('close', () => held.delete(response));
      return;
    }
    if (request.url === '/api/games') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ games: [{ id: 'refresh-proof' }] }));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<script>const jobs=new Map();window.__sundayVerify={assign(id,url){const controller=new AbortController();fetch(url,{signal:controller.signal}).catch(()=>{});return new Promise(resolve=>jobs.set(id,{controller,resolve}));},cancel(id){const job=jobs.get(id);job?.controller.abort();job?.resolve({kind:"deferred"});jobs.delete(id);return Promise.resolve();}};</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const room = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const verifier = createPlaybackVerifier();
  verifier.configure(origin);
  try {
    await room.loadURL(origin);
    const operations = Array.from({ length: 6 }, (_, index) => verifier.verify({
      gameId: 'refresh-proof', gameDay: 0, candidateId: 'feed-' + index,
      sessionId: 'refresh-session-' + index, generation: 0,
    }, new AbortController().signal));
    const deadline = Date.now() + 10000;
    while (held.size < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (held.size !== 6) throw new Error('Expected six active verification requests, got ' + held.size);
    const read = () => room.webContents.executeJavaScript('(async()=>{try{const response=await fetch("/api/games",{signal:AbortSignal.timeout(1000)});return {status:response.status,body:await response.json()};}catch(error){return {error:error.name};}})()');
    const during = await read();
    verifier.stop();
    await Promise.all(operations.map(operation => operation?.result));
    const after = await read();
    return { during, after };
  } finally {
    verifier.stop();
    room.destroy();
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})()`;
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron refresh check timed out')), 20000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  console.log(JSON.stringify(result));
  const expected = { status: 200, body: { games: [{ id: 'refresh-proof' }] } };
  assert.deepEqual(result.after, expected, 'Game refresh must recover after verification stops');
  assert.deepEqual(result.during, expected, 'Background verification must not block game refresh');
  console.log('PASS: Game refresh succeeds while six background verification requests remain open.');
} finally {
  socket.close();
}
