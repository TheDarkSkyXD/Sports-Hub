const { net: chromiumNet, session } = require('electron');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { handleCertificateIssuerRequest } = require('./certificate-issuer-proxy.cjs');

const MAX_BYTES = 64 * 1024 * 1024;
const IDLE_MS = 5 * 60000;

function allowedMediaUrl(value, validateUrl) {
  const url = typeof value === 'string' && validateUrl(value);
  return url || null;
}

function validRange(value) {
  if (value === undefined) return true;
  const match = typeof value === 'string' && /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return false;
  return !match[1] ? BigInt(match[2]) > 0n : !match[2] || BigInt(match[1]) <= BigInt(match[2]);
}

function createObservedMedia({ pinAddress, validateUrl, network = chromiumNet, sessions = session, idleMs = IDLE_MS }) {
  const capabilities = new Map();
  const partitions = [];
  const partitionPrefix = `observed-media-${randomUUID()}`;

  function close(id) {
    const entry = capabilities.get(id);
    if (!entry) return;
    capabilities.delete(id);
    clearTimeout(entry.timer);
    for (const request of entry.requests) request.abort();
    for (const socket of entry.sockets) socket.destroy();
    entry.proxy.close(() => {});
    void entry.session.closeAllConnections().then(() => entry.session.clearAuthCache())
      .then(() => { entry.partition.busy = false; }).catch(() => {});
  }

  function touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => close(entry.id), idleMs);
    entry.timer.unref();
  }

  async function register({ url, userAgent, origin, requestReferer }) {
    const root = validateUrl(url);
    if (!root) throw new Error('Observed media URL is invalid');
    let partition = partitions.find(item => !item.busy);
    if (!partition) {
      if (partitions.length >= 32) return null;
      partition = { session: sessions.fromPartition(`${partitionPrefix}-${partitions.length}`), busy: false };
      partitions.push(partition);
    }
    partition.busy = true;
    const id = randomUUID();
    const secret = randomUUID();
    const authorization = Buffer.from(`Basic ${Buffer.from(`media:${secret}`).toString('base64')}`);
    const mediaSession = partition.session;
    const entry = { id, partition,
      session: mediaSession, sockets: new Set(), requests: new Set(), proxy: null, timer: null, issuerRequests: 0,
      headers: { 'User-Agent': userAgent, Accept: '*/*', ...(origin ? { Origin: origin } : {}),
        ...(requestReferer ? { Referer: requestReferer } : {}) }, secret };
    mediaSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mediaSession.setPermissionCheckHandler(() => false);
    mediaSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !capabilities.has(id) || !allowedMediaUrl(details.url, validateUrl) });
    });
    const proxy = http.createServer((request, response) => {
      void handleCertificateIssuerRequest(request,response,{
        authorization:authorization.toString(),pinAddress,
        isActive:()=>capabilities.has(id),
        admit:()=>++entry.issuerRequests<=8,
      });
    });
    entry.proxy = proxy;
    proxy.on('connect', async (request, client, head) => {
      client.on('error', () => {});
      const supplied = Buffer.from(request.headers['proxy-authorization'] || '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="observed-media"\r\nConnection: close\r\n\r\n');
        return;
      }
      const target = /^([^:]+):(443|8443)$/.exec(request.url || '');
      const destination = target && validateUrl(`https://${target[1]}:${target[2]}/`);
      if (!capabilities.has(id) || !destination || entry.sockets.size >= 32) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      entry.sockets.add(client);
      client.once('close', () => entry.sockets.delete(client));
      let address;
      try { address = await pinAddress(destination.hostname, () => capabilities.has(id)); }
      catch { client.destroy(); return; }
      if (!capabilities.has(id) || client.destroyed) { client.destroy(); return; }
      const remote = net.connect({ host: address.address, family: address.family, port: Number(target[2]) });
      entry.sockets.add(remote);
      const cleanup = () => { client.destroy(); remote.destroy(); entry.sockets.delete(remote); };
      remote.on('error', cleanup);
      remote.once('close', cleanup);
      client.once('close', cleanup);
      remote.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
    });
    capabilities.set(id, entry);
    try {
      await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
      await mediaSession.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>' });
      touch(entry);
      return id;
    } catch (error) { close(id); throw error; }
  }

  function read(id, value, range, response) {
    const entry = capabilities.get(id);
    const url = entry && allowedMediaUrl(value, validateUrl);
    if (!url || !validRange(range)) {
      response.writeHead(404); response.end(); return;
    }
    if (entry.requests.size >= 8) { response.writeHead(429); response.end(); return; }
    touch(entry);
    const request = network.request({ url: url.href, session: entry.session, method: 'GET', redirect: 'manual', useSessionCookies: false });
    entry.requests.add(request);
    for (const [name, value] of Object.entries(entry.headers)) request.setHeader(name, value);
    if (range) request.setHeader('Range', range);
    request.on('login', (authInfo, callback) => {
      if (authInfo.isProxy && authInfo.host === '127.0.0.1') callback('media', entry.secret);
      else callback();
    });
    const timer = setTimeout(() => request.abort(), 30000);
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      entry.requests.delete(request);
      return true;
    };
    const fail = () => {
      if (!finish()) return;
      if (!response.headersSent) { response.writeHead(502); response.end(); }
      else response.destroy();
    };
    response.once('close', () => { finish(); request.abort(); });
    request.on('error', fail);
    request.on('abort', fail);
    request.on('redirect', (status, _method, location) => {
      if (!finish()) return;
      response.writeHead(status, { Location: location }); response.end(); request.abort();
    });
    request.on('response', incoming => {
      const headers = {};
      for (const name of ['content-type', 'content-range', 'accept-ranges', 'location']) {
        const value = incoming.headers[name];
        if (value) headers[name] = value;
      }
      response.writeHead(incoming.statusCode, headers);
      let bytes = 0;
      incoming.on('error', fail);
      incoming.on('data', chunk => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { request.abort(); return; }
        touch(entry);
        if (!response.write(chunk)) { incoming.pause(); response.once('drain', () => incoming.resume()); }
      });
      incoming.on('end', () => { if (finish()) response.end(); });
    });
    request.end();
  }

  return { register, read, close, stop() { for (const id of capabilities.keys()) close(id); } };
}

module.exports = { createObservedMedia, allowedMediaUrl };
