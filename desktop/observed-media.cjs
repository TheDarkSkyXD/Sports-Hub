const { net: chromiumNet, session } = require('electron');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { handleCertificateIssuerRequest } = require('./certificate-issuer-proxy.cjs');

const MAX_BYTES = 64 * 1024 * 1024;
const IDLE_MS = 5 * 60000;
const CLEANUP_DEADLINE_MS = 5000;
const CLEANUP_RETRY_MS = 100;
const CLEANUP_PASSES = 3;

function capturedCookies(header) {
  if (typeof header !== 'string' || !/^[\x20-\x7e]{1,8192}$/.test(header)) return [];
  const values = header.split(';');
  if (values.length > 32) return [];
  return values.flatMap(part => {
    const pair = part.trim();
    const equal = pair.indexOf('=');
    if (equal < 1) return [];
    const name = pair.slice(0,equal), value = pair.slice(equal+1);
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name) && value.length <= 4096 ? [{name,value}] : [];
  });
}

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
  let stopped = false;

  function cleaning(partition, generation) {
    return partition.state === 'cleaning' && partition.generation === generation;
  }

  function quarantine(partition, generation, error) {
    if (!cleaning(partition, generation)) return;
    partition.state = 'quarantined';
    clearTimeout(partition.retryTimer);
    clearTimeout(partition.deadlineTimer);
    console.error('Observed media session cleanup failed:', error);
  }

  async function cleanupPartition(partition, generation, pass) {
    if (!cleaning(partition, generation)) return;
    try {
      await partition.session.closeAllConnections();
      if (!cleaning(partition, generation)) return;
      await partition.session.clearAuthCache();
      if (!cleaning(partition, generation)) return;
      await partition.session.clearStorageData({storages:['cookies']});
      if (!cleaning(partition, generation)) return;
      clearTimeout(partition.deadlineTimer);
      partition.state = 'free';
    } catch (error) {
      if (!cleaning(partition, generation)) return;
      if (pass >= CLEANUP_PASSES) { quarantine(partition, generation, error); return; }
      const remaining = partition.cleanupDeadline - Date.now();
      if (remaining <= 0) { quarantine(partition, generation, error); return; }
      partition.retryTimer = setTimeout(() => {
        partition.retryTimer = null;
        void cleanupPartition(partition, generation, pass + 1);
      }, Math.min(CLEANUP_RETRY_MS, remaining));
      partition.retryTimer.unref();
    }
  }

  function beginCleanup(partition, generation) {
    partition.state = 'cleaning';
    partition.cleanupDeadline = Date.now() + CLEANUP_DEADLINE_MS;
    partition.deadlineTimer = setTimeout(() =>
      quarantine(partition, generation, new Error('cleanup timed out')), CLEANUP_DEADLINE_MS);
    partition.deadlineTimer.unref();
    void cleanupPartition(partition, generation, 1);
  }

  function close(id) {
    const entry = capabilities.get(id);
    if (!entry) return;
    capabilities.delete(id);
    clearTimeout(entry.timer);
    for (const request of entry.requests) request.abort();
    for (const socket of entry.sockets) socket.destroy();
    entry.proxy.close(() => {});
    beginCleanup(entry.partition, entry.generation);
  }

  function touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => close(entry.id), idleMs);
    entry.timer.unref();
  }

  async function register({ url, userAgent, origin, requestReferer, mediaCookie }) {
    if (stopped) return null;
    const root = validateUrl(url);
    if (!root) throw new Error('Observed media URL is invalid');
    let partition = partitions.find(item => item.state === 'free');
    if (!partition) {
      if (partitions.length >= 32) return null;
      partition = { session: sessions.fromPartition(`${partitionPrefix}-${partitions.length}`),
        state: 'free', generation: 0, retryTimer: null, deadlineTimer: null };
      partitions.push(partition);
    }
    partition.state = 'leased';
    const generation = ++partition.generation;
    const id = randomUUID();
    const secret = randomUUID();
    const authorization = Buffer.from(`Basic ${Buffer.from(`media:${secret}`).toString('base64')}`);
    const mediaSession = partition.session;
    const entry = { id, partition, generation, cookieOrigin: root.origin,
      session: mediaSession, sockets: new Set(), requests: new Set(), proxy: null, timer: null, issuerRequests: 0,
      headers: { 'User-Agent': userAgent, Accept: '*/*', ...(origin ? { Origin: origin } : {}),
        ...(requestReferer ? { Referer: requestReferer } : {}) }, secret };
    mediaSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mediaSession.setPermissionCheckHandler(() => false);
    mediaSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = allowedMediaUrl(details.url, validateUrl);
      callback({ cancel: !capabilities.has(id) || !allowed });
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
      if (stopped || !capabilities.has(id)) return null;
      await mediaSession.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>' });
      if (stopped || !capabilities.has(id)) return null;
      for (const {name,value} of capturedCookies(mediaCookie)) {
        await mediaSession.cookies.set({url:root.href,name,value,path:'/',secure:true});
        if (stopped || !capabilities.has(id)) return null;
      }
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
    const observedOrigin = url.origin === entry.cookieOrigin;
    const request = network.request({ url: url.href, session: entry.session, method: 'GET', redirect: 'manual',
      useSessionCookies: observedOrigin, referrerPolicy: observedOrigin ? 'unsafe-url' : 'strict-origin-when-cross-origin' });
    entry.requests.add(request);
    for (const [name, value] of Object.entries(entry.headers)) {
      if (name === 'Referer') {
        const referer = new URL(value);
        request.setHeader(name,observedOrigin || url.origin === referer.origin ? value : `${referer.origin}/`);
      } else request.setHeader(name, value);
    }
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

  return { register, read, close, stop() {
    if (stopped) return;
    stopped = true;
    for (const id of capabilities.keys()) close(id);
    for (const partition of partitions) {
      if (partition.state !== 'cleaning') continue;
      clearTimeout(partition.retryTimer);
      clearTimeout(partition.deadlineTimer);
      partition.state = 'quarantined';
    }
  } };
}

module.exports = { createObservedMedia, allowedMediaUrl };
