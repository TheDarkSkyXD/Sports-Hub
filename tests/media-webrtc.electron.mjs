import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const targets = await (await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length, 1, 'Expected the running local Electron main inspector');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);

async function verifyWebRTC(root) {
  const require = process.mainModule.require.bind(process.mainModule);
  const { BrowserWindow, session } = process.mainModule.require('electron');
  const { createSourcePageReader } = require(require('node:path').join(root, 'desktop/source-page-reader.cjs'));
  const receiver = require('node:dgram').createSocket('udp4');
  const packets = [];
  receiver.on('message', packet => packets.push(packet.toString('hex')));
  await new Promise(resolve => receiver.bind(0, '127.0.0.1', resolve));
  const port = receiver.address().port;
  const readers = [];
  const probe = async window => {
    const start = packets.length;
    const policy = window.webContents.getWebRTCIPHandlingPolicy();
    await window.webContents.executeJavaScript(`(async()=>{
      const peer = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});
      try {
        peer.createDataChannel('network-verification');
        await peer.setLocalDescription(await peer.createOffer());
        await new Promise(resolve=>setTimeout(resolve,3000));
      } finally { peer.close(); }
    })()`);
    return { policy, packets: packets.length - start };
  };
  const read = async forceDefault => {
    const loaded = Promise.withResolvers();
    let source;
    function FixtureWindow(options) {
      source = new BrowserWindow(options);
      if (forceDefault) {
        const setPolicy = source.webContents.setWebRTCIPHandlingPolicy.bind(source.webContents);
        source.webContents.setWebRTCIPHandlingPolicy = () => setPolicy('default');
      }
      const load = source.loadURL.bind(source);
      source.loadURL = () => load('about:blank').then(loaded.resolve, loaded.reject);
      return source;
    }
    const reader = createSourcePageReader({ BrowserWindow: FixtureWindow, session });
    readers.push(reader);
    const pending = reader.read('https://dudestream1.com/category/nba/', new AbortController().signal);
    await loaded.promise;
    try { return await probe(source); }
    finally { reader.stop(); await pending; }
  };
  try {
    const unrestricted = await read(true);
    const acquisition = await read(false);
    return { unrestricted, acquisition, totalPackets: packets.length };
  } finally {
    for (const reader of readers) reader.stop();
    receiver.close();
  }
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error('Native WebRTC verification timed out')), 15_000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolveResult(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${verifyWebRTC.toString()})(${JSON.stringify(resolve('.'))})`, awaitPromise: true, returnByValue: true,
    } }));
  });
  const output = resolve(process.argv[2] ?? '.desktop-runtime/media-audit-fixes/native-webrtc.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  assert.equal(result.acquisition.packets, 0, 'The actual source reader must block WebRTC UDP outside the pinned proxy');
  assert.ok(result.unrestricted.packets > 0, 'The native control must demonstrate loopback STUN traffic');
  assert.equal(result.acquisition.policy, 'disable_non_proxied_udp');
} finally {
  socket.close();
}
