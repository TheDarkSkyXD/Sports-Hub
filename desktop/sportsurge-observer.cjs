const { BrowserWindow, session } = require('electron');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const http = require('node:http');
const net = require('node:net');

const OBSERVE_MS = 20000;
const OBSERVER_SLOTS = 4;
const MAX_REQUESTS = 300;
const MAX_CONNECTS = 100;
const MAX_FRAMES = 32;
const MAX_BYTES = 24 * 1024 * 1024;
const blockedV4 = [
  [0x00000000,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],
  [0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],
  [0xc0586300,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],
  [0xcb007100,24],[0xe0000000,4],[0xf0000000,4],
];

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const value = ((parts[0] * 0x1000000) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
    return !blockedV4.some(([base,bits]) => (value >>> (32-bits)) === (base >>> (32-bits)));
  }
  if (family === 6) return /^[23][0-9a-f]{0,3}:/.test(address.toLowerCase()) &&
    !/^2001:(?:db8|0):/i.test(address) && !/^2002:/i.test(address);
  return false;
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '8443') || url.hash ||
      url.href.length > 2048 || net.isIP(url.hostname) || !url.hostname.includes('.') ||
      url.hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function publicNetworkUrl(value) {
  if (typeof value === 'string' && value.startsWith('wss://')) return publicUrl(`https://${value.slice(6)}`);
  return publicUrl(value);
}

async function pinnedAddress(host) {
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise((_,reject) => setTimeout(() => reject(new Error('dns-timeout')), 3000)),
  ]);
  if (!addresses.length || addresses.some(item => item.family !== net.isIP(item.address) || !publicAddress(item.address)))
    throw new Error('private-address');
  return addresses.find(item => item.family === 4) || addresses[0];
}

function authorized(value, expected) {
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left,right);
}

function createObserverSlot(index) {
  const debug = (...parts) => { if (process.env.SUNDAY_ROOM_OBSERVER_DEBUG === '1') console.error('[observer]',index,...parts); };
  const proxySecret = randomUUID();
  const proxyAuthorization = `Basic ${Buffer.from(`observer:${proxySecret}`).toString('base64')}`;
  const partition = `sportsurge-observer-${index}-${randomUUID()}`;
  const sourceSession = session.fromPartition(partition);
  sourceSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  sourceSession.setPermissionCheckHandler(() => false);
  sourceSession.on('will-download',event => event.preventDefault());
  let active;
  let proxy;
  const requests = new Map();
  const owners = new Map();

  function endActive(current,result) {
    if (active !== current) return;
    active = undefined;
    debug('finished',result ? 'media found' : 'no media',current.requests,current.proxyRequests,current.bytes);
    requests.clear();
    owners.clear();
    clearTimeout(current.timer);
    clearInterval(current.playerTimer);
    for (const timer of current.probeTimers) clearTimeout(timer);
    for (const socket of current.sockets) socket.destroy();
    if (!current.window.isDestroyed()) current.window.destroy();
    current.resolve(result);
  }

  proxy = http.createServer((_request,response) => { response.writeHead(405); response.end(); });
  proxy.on('connect',async (request,client,head) => {
    client.on('error',() => {});
    const current = active;
    if (!current || !authorized(request.headers['proxy-authorization'],proxyAuthorization)) {
      debug('proxy auth required',request.url);
      if (!client.destroyed) client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="sportsurge-observer"\r\nConnection: close\r\n\r\n');
      return;
    }
    const match = /^([^:]+):(443|8443)$/.exec(request.url || '');
    const url = match && publicUrl(`https://${match[1]}:${match[2]}/`);
    if (!url || current.tunnels >= 64 || ++current.proxyRequests > MAX_CONNECTS) {
      debug('proxy rejected',request.url,current.tunnels,current.proxyRequests);
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    current.tunnels++;
    current.sockets.add(client);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.tunnels--;
      current.sockets.delete(client);
    };
    client.once('close',release);
    let address;
    try { address = await pinnedAddress(url.hostname); }
    catch (error) { debug('dns rejected',url.hostname,error?.message); if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (active !== current || client.destroyed) { client.destroy(); return; }
    const remote = net.connect({ host: address.address, port: Number(match[2]), family: address.family });
    current.sockets.add(remote);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      release();
      current.sockets.delete(remote);
      client.destroy();
      remote.destroy();
    };
    client.once('error',cleanup);
    remote.once('error',error => { debug('connect failed',url.hostname,error?.message); cleanup(); });
    client.once('close',cleanup);
    remote.once('close',cleanup);
    remote.once('connect',() => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
    remote.on('data',chunk => {
      current.bytes += chunk.length;
      if (current.bytes > MAX_BYTES) endActive(current,null);
    });
  });

  sourceSession.webRequest.onBeforeRequest((details,callback) => {
    const current = active;
    const url = publicNetworkUrl(details.url);
    const localPdfObject = details.resourceType === 'object' &&
      details.url.startsWith('data:application/pdf;base64,') && details.url.length <= 1024 &&
      typeof details.initiatorOrigin === 'string' &&
      publicUrl(`${details.initiatorOrigin}/`)?.origin === details.initiatorOrigin;
    if (!current || !url && !localPdfObject ||
      (details.url.startsWith('wss://') && details.resourceType !== 'webSocket') ||
      ['image','font','ping','cspReport'].includes(details.resourceType) ||
      (details.resourceType === 'mainFrame' && url.href !== current.url) || ++current.requests > MAX_REQUESTS) {
      callback({ cancel: true });
      if (current && current.requests > MAX_REQUESTS) endActive(current,null);
      return;
    }
    owners.set(details.id,current);
    callback({ cancel: false });
  });
  sourceSession.webRequest.onBeforeSendHeaders((details,callback) => {
    const current = active;
    const header = name => Object.entries(details.requestHeaders).find(([key]) => key.toLowerCase() === name)?.[1];
    const referer = header('referer');
    const userAgent = header('user-agent');
    if (current && owners.get(details.id)===current && publicUrl(details.url) &&
      (details.webContentsId === undefined || details.webContentsId === current.window.webContents.id)) requests.set(details.id,{
      operation:current,url:details.url,frame:details.frame,initiatorOrigin:details.initiatorOrigin,
      referer:referer || details.referrer || details.frame?.url,userAgent,
    });
    callback({ requestHeaders: details.requestHeaders });
  });
  sourceSession.webRequest.onHeadersReceived((details,callback) => {
    const candidate = requests.get(details.id);
    requests.delete(details.id);
    owners.delete(details.id);
    const contentType = Object.entries(details.responseHeaders || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.[0] || '';
    const isHls = /\.m3u8(?:$|[?#])/i.test(details.url) || /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/(?:mpegurl|x-mpegurl))/i.test(contentType);
    if (active && candidate?.operation===active && details.statusCode >= 200 && details.statusCode < 300 && isHls) {
      const current = active;
      let refererUrl;
      try {
        const value = new URL(candidate.referer);
        value.hash = '';
        refererUrl = publicUrl(value.href);
      } catch {}
      if (refererUrl && typeof candidate.userAgent === 'string' &&
        /^[\x20-\x7e]{1,512}$/.test(candidate.userAgent)) {
        const frame = candidate.frame;
        const origin = candidate.initiatorOrigin;
        if (!frame && (!origin || origin !== refererUrl.origin)) {
          callback({ cancel: false });
          return;
        }
        const key = `${candidate.url}\n${refererUrl.href}\n${origin || ''}`;
        if (!current.probeKeys.has(key) && current.probeKeys.size < 8) {
          current.probeKeys.add(key);
          const probe = async () => {
            if (active !== current) return;
            const subtree = current.window.webContents.mainFrame.framesInSubtree;
            const frames = frame ? subtree.includes(frame) && !frame.isDestroyed() ? [frame] : [] :
              subtree.filter(item => {
                if (item.isDestroyed()) return false;
                try { return new URL(item.url).origin === origin; } catch { return false; }
              });
            const urls = frames.map(item => item.url);
            const results = await Promise.allSettled(frames.map(item => item.executeJavaScript(`Array.from(document.querySelectorAll('video')).some(video => {
              const rect = video.getBoundingClientRect();
              const style = getComputedStyle(video);
              return rect.width >= 240 && rect.height >= 135 && style.display !== 'none' && style.visibility !== 'hidden';
            })`)));
            if (active !== current) return;
            const visible = results.filter((result,index) => result.status === 'fulfilled' && result.value &&
              !frames[index].isDestroyed() && frames[index].url === urls[index] &&
              current.window.webContents.mainFrame.framesInSubtree.includes(frames[index]));
            if (visible.length === 1) { endActive(current,{ url: candidate.url, referer: refererUrl.href,
              userAgent: candidate.userAgent }); return; }
            if (Date.now()+500 < current.deadline) {
              const timer = setTimeout(() => { current.probeTimers.delete(timer); void probe(); },500);
              current.probeTimers.add(timer);
            }
          };
          void probe();
        }
      }
    }
    callback({ cancel: false });
  });

  function observe(url,purpose) {
    if (active) return null;
    const window = new BrowserWindow({ show: false, webPreferences: {
      partition, contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    } });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate','will-redirect']) window.webContents.on(name,(event,target) => {
      if (target !== url) event.preventDefault();
    });
    window.webContents.on('login',(event,_details,authInfo,callback) => {
      debug('login',authInfo.isProxy,authInfo.host);
      if (!authInfo.isProxy || authInfo.host !== '127.0.0.1') return;
      event.preventDefault();
      callback('observer',proxySecret);
    });
    let current;
    const promise = new Promise(resolve => {
      current = { window, url, purpose, resolve, sockets: new Set(), requests: 0, proxyRequests: 0, tunnels: 0, bytes: 0,
        deadline: Date.now()+OBSERVE_MS, probeKeys: new Set(), probeTimers: new Set(),
        timer: setTimeout(() => endActive(current,null),OBSERVE_MS) };
      active = current;
      current.playerTimer = setInterval(() => {
        if (active !== current || current.playerActivated) return;
        let frames;
        try { frames = window.webContents.mainFrame.framesInSubtree; }
        catch { endActive(current,null); return; }
        const player = frames.find(frame => {
          try { return new URL(frame.url).hostname === 'nfl.earnsphere.site'; }
          catch { return false; }
        });
        if (!player || player.isDestroyed()) return;
        void player.executeJavaScript(`(() => {
          const video = document.querySelector('video');
          const button = document.querySelector('button[aria-label="playpause"]');
          if (document.title !== 'LIVE NFL' || !video || !button || !video.paused) return false;
          const rect = video.getBoundingClientRect();
          if (rect.width < 240 || rect.height < 135) return false;
          video.muted = true;
          button.click();
          void video.play().catch(() => {});
          return true;
        })()`).then(activated => {
          if (activated && active === current) { current.playerActivated = true; debug('activated named player'); }
        }).catch(() => {});
      },500);
      window.webContents.on('frame-created',() => {
        if (active !== current) return;
        let frames;
        try { frames = window.webContents.mainFrame.framesInSubtree.length; }
        catch { endActive(current,null); return; }
        if (frames > MAX_FRAMES) { debug('too many frames',frames); endActive(current,null); }
      });
      window.on('closed',() => { if (active === current) { debug('window closed'); endActive(current,null); } });
    });
    return { promise, cancel: () => endActive(current,null),
      start: () => { if (active === current) void window.loadURL(url).catch(() => {}); } };
  }

  async function start() {
    await new Promise((resolve,reject) => {
      proxy.once('error',reject);
      proxy.listen(0,'127.0.0.1',resolve);
    });
    const proxyPort = proxy.address().port;
    await sourceSession.setProxy({ mode:'fixed_servers', proxyRules:`http://127.0.0.1:${proxyPort}`, proxyBypassRules:'<-loopback>' });
  }
  function stop() {
    if (active) endActive(active,null);
    if (proxy.listening) proxy.close();
  }
  return { start, stop, observe, busy: () => !!active,
    preemptProbe: () => {
      if (!active || active.purpose !== 'probe') return false;
      endActive(active,{ deferred:true });
      return true;
    } };
}

function createSportsurgeObserver({ controlToken, port = 0 }) {
  const slots = Array.from({ length: OBSERVER_SLOTS },(_,index) => createObserverSlot(index));
  const service = http.createServer(async (request,response) => {
    if (request.method !== 'POST' || request.url !== '/observe') { response.writeHead(404); response.end(); return; }
    if (!authorized(request.headers['x-sunday-control-token'],controlToken)) { response.writeHead(401); response.end(); return; }
    let operation;
    let closed = false;
    const onClose = () => { closed = true; operation?.cancel(); };
    response.once('close',onClose);
    let body = '';
    try {
      for await (const chunk of request) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 4096) { response.writeHead(413); response.end(); return; }
      }
      const input = JSON.parse(body);
      const url = typeof input?.url === 'string' && publicUrl(input.url);
      const purpose = input?.purpose === undefined ? 'playback' : input.purpose;
      if (!url || purpose !== 'probe' && purpose !== 'playback') { response.writeHead(400); response.end(); return; }
      for (const slot of slots) {
        operation = slot.observe(url.href,purpose);
        if (operation) break;
      }
      if (!operation && purpose === 'playback') {
        const victim = slots.find(slot => slot.preemptProbe());
        if (victim) operation = victim.observe(url.href,purpose);
      }
      if (!operation) { response.writeHead(429); response.end(); return; }
      await pinnedAddress(url.hostname);
      if (closed) return;
      operation.start();
      const result = await operation.promise;
      response.off('close',onClose);
      if (closed) return;
      if (result?.deferred) { response.writeHead(503); response.end(); return; }
      if (result === null) { response.writeHead(404); response.end(); return; }
      response.writeHead(200,{ 'content-type':'application/json', 'cache-control':'no-store' });
      response.end(JSON.stringify(result));
    } catch {
      operation?.cancel();
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });

  async function start() {
    try {
      for (const slot of slots) await slot.start();
      await new Promise((resolve,reject) => {
        service.once('error',reject);
        service.listen(port,'127.0.0.1',resolve);
      });
      return `http://127.0.0.1:${service.address().port}`;
    } catch (error) { stop(); throw error; }
  }
  function stop() {
    if (service.listening) service.close();
    for (const slot of slots) slot.stop();
  }
  return { start, stop };
}

module.exports = { createSportsurgeObserver };
