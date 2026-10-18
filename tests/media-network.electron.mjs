import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const targets = await (await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length, 1, 'Expected the existing local Electron main inspector');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);

async function verifyNetwork(root) {
  const require = process.mainModule.require.bind(process.mainModule);
  const { BrowserWindow, session } = process.mainModule.require('electron');
  const { join } = require('node:path');
  const { lookup } = require('node:dns/promises');
  const net = require('node:net');
  const { createNetworkBudget, createPinnedProxy, pinnedAddress, sourceRequestAllowed } = require(join(root, 'desktop/source-network.cjs'));
  const ownSession = session.fromPartition(`network-verification-${require('node:crypto').randomUUID()}`);
  const requests = [], resolutions = [], connections = [];
  const limits = [];
  const budget = createNetworkBudget({ onLimit: reason => limits.push(reason) });
  const proxy = createPinnedProxy({ session: ownSession, getBudget: () => budget,
    pinAddress: (host, active) => pinnedAddress(host, active, async (name, options) => {
      resolutions.push(name);
      return name === 'private-audit.example' ? [{ address: '127.0.0.1', family: 4 }] : lookup(name, options);
    }),
    connect(options) { connections.push({ host: options.host, port: options.port }); return net.connect(options); },
  });
  ownSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ownSession.setPermissionCheckHandler(() => false);
  ownSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = sourceRequestAllowed(details) && budget.request();
    requests.push({ url: details.url, type: details.resourceType, allowed });
    callback({ cancel: !allowed });
  });
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: ownSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('login', (event, _details, authInfo, callback) => {
    if (!authInfo.isProxy || authInfo.host !== '127.0.0.1') return;
    event.preventDefault(); callback(proxy.credentials.username, proxy.credentials.password);
  });
  let timer;
  try {
    await proxy.start();
    await window.loadURL('about:blank');
    const denied = await window.webContents.executeJavaScript(`Promise.all([
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
      'http://127.0.0.1:65500/private',
      'https://private-audit.example/private',
    ].map(async url => { try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return {url,status:r.status}; }
      catch(error) { return {url,error:error.name}; } }))`);
    const publicPage = await Promise.race([
      window.loadURL('https://example.com').then(() => ({ url: window.webContents.getURL(), error: null }),
        error => ({ url: window.webContents.getURL(), error: error.message })),
      new Promise(resolve => { timer = setTimeout(() => {
        window.webContents.stop(); resolve({ url: window.webContents.getURL(), error: 'Public page timed out' });
      }, 15_000); }),
    ]);
    return { denied, publicPage, requests, resolutions, connections, limits };
  } finally {
    clearTimeout(timer);
    budget.close(); proxy.stop(); window.destroy();
    ownSession.webRequest.onBeforeRequest(null);
    await ownSession.closeAllConnections();
    await ownSession.clearStorageData();
  }
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error('Native network verification timed out')), 40_000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolveResult(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${verifyNetwork.toString()})(${JSON.stringify(resolve('.'))})`, awaitPromise: true, returnByValue: true,
    } }));
  });
  const output = resolve(process.argv[2] ?? '.desktop-runtime/media-audit-fixes/native-network.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  const ad = result.requests.find(request => request.url.includes('adsbygoogle.js'));
  assert.equal(ad?.allowed, false, 'The maintained filter must block the real Chromium ad-script request');
  assert.ok(result.denied.every(request => request.error), 'Ad and private requests must fail');
  assert.ok(result.resolutions.includes('private-audit.example'), 'The proxy must check DNS for the syntactically public private destination');
  assert.ok(result.connections.every(connection => connection.host !== '127.0.0.1'), 'Private DNS must never reach a socket connection');
  assert.ok(result.requests.some(request => request.url === 'https://example.com/' && request.allowed), 'Public page navigation must be admitted');
  assert.equal(result.publicPage.error, null, 'A real public HTTPS page must load through the pinned proxy');
  assert.equal(result.publicPage.url, 'https://example.com/');
  assert.deepEqual(result.limits, []);
} finally {
  socket.close();
}
