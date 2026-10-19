const { net: chromiumNet, session } = require('electron');
const { randomUUID } = require('node:crypto');
const {sourceRequestAllowed,createNetworkBudget,createPinnedProxy}=require('./source-network.cjs');
const {decodeWrappedMedia,isWrappedMediaPrefix,MAX_INPUT_BYTES}=require('./wrapped-media.cjs');
const verificationPolicy=require('../lib/playback/verification-policy.json');

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
    entry.network.close();
    entry.proxy.stop();
    beginCleanup(entry.partition, entry.generation);
  }

  function touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => close(entry.id), idleMs);
    entry.timer.unref();
  }

  async function register({ url, kind, userAgent, origin, requestReferer, mediaCookie }) {
    if (stopped) return null;
    const root = validateUrl(url);
    if (!root) throw new Error('Observed media URL is invalid');
    let partition = partitions.find(item => item.state === 'free');
    if (!partition) {
      if (partitions.length >= verificationPolicy.concurrency+4) return null;
      partition = { session: sessions.fromPartition(`${partitionPrefix}-${partitions.length}`,{cache:false}),
        state: 'free', generation: 0, retryTimer: null, deadlineTimer: null };
      partitions.push(partition);
    }
    partition.state = 'leased';
    const generation = ++partition.generation;
    const id = randomUUID();
    const mediaSession = partition.session;
    const entry = { id, partition, generation, cookieOrigin: root.origin,progressiveUrl:['progressive','flv','mpegts'].includes(kind)?root.href:null,
      session: mediaSession, requests: new Set(), proxy: null, timer: null,
      headers: { 'User-Agent': userAgent, Accept: '*/*', ...(origin ? { Origin: origin } : {}),
        ...(requestReferer ? { Referer: requestReferer } : {}) } };
    mediaSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mediaSession.setPermissionCheckHandler(() => false);
    mediaSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = allowedMediaUrl(details.url, validateUrl);
      callback({ cancel: !capabilities.has(id) || !allowed ||
        !sourceRequestAllowed(details,entry.headers.Referer) || !entry.network.request() });
    });
    entry.network=createNetworkBudget({mode:'playback',onLimit:()=>close(id)});
    entry.proxy=createPinnedProxy({session:mediaSession,pinAddress,getBudget:()=>capabilities.has(id)?entry.network:null});
    capabilities.set(id, entry);
    try {
      await entry.proxy.start();
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
    const progressive=url.href===entry.progressiveUrl;
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
      if (authInfo.isProxy && authInfo.host === '127.0.0.1') callback(entry.proxy.credentials.username,entry.proxy.credentials.password);
      else callback();
    });
    let timer;
    const armTimer=()=>{clearTimeout(timer);timer=setTimeout(()=>request.abort(),30000);};
    armTimer();
    const decoding=new AbortController();
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      decoding.abort();
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
      for (const name of ['content-type', 'content-range', 'accept-ranges', 'location',...(progressive?['content-length']:[])]) {
        const value = incoming.headers[name];
        if (value) headers[name] = value;
      }
      let bytes = 0,mode=!progressive&&incoming.statusCode===200&&!range?(/image\/(?:png|webp)/i.test(headers['content-type']||'')?'wrapped':'probe'):'stream';
      const chunks=[];
      const forward=chunk=>{
        if(!response.headersSent)response.writeHead(incoming.statusCode,headers);
        if(!response.write(chunk)){
          if(progressive)clearTimeout(timer);
          incoming.pause();response.once('drain',()=>{if(finished)return;if(progressive)armTimer();incoming.resume();});
        }else if(progressive)armTimer();
      };
      const flush=()=>{for(const chunk of chunks)forward(chunk);chunks.length=0;};
      incoming.on('error', fail);
      incoming.on('data', chunk => {
        if (finished) return;
        bytes += chunk.length;
        if (!progressive&&bytes > MAX_BYTES) { request.abort(); return; }
        touch(entry);
        if(mode==='stream'){forward(chunk);return;}
        chunks.push(chunk);
        if(mode==='probe'&&bytes>=12){mode=isWrappedMediaPrefix(Buffer.concat(chunks,bytes))?'wrapped':'stream';if(mode==='stream')flush();}
        if(mode==='wrapped'&&bytes>MAX_INPUT_BYTES){if(finish()){response.writeHead(422);response.end();request.abort();}}
      });
      incoming.on('end', async() => {
        if(finished)return;
        if(mode==='probe'){mode=isWrappedMediaPrefix(Buffer.concat(chunks,bytes))?'wrapped':'stream';if(mode==='stream')flush();}
        if(mode==='stream'){if(finish()){if(!response.headersSent)response.writeHead(incoming.statusCode,headers);response.end();}return;}
        try{
          const body=Buffer.concat(chunks,bytes),decoded=await decodeWrappedMedia(body,decoding.signal);
          if(finished)return;
          if(decoded!==body){headers['content-type']='video/mp2t';headers['content-length']=String(decoded.length);delete headers['content-range'];delete headers['accept-ranges'];delete headers['content-encoding'];}
          if(finish()){response.writeHead(incoming.statusCode,headers);response.end(decoded);}
        }catch{if(finish()){response.writeHead(422);response.end();request.abort();}}
      });
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
