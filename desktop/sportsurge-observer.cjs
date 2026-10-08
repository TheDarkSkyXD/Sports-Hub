const { BrowserWindow, session, webFrameMain } = require('electron');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const http = require('node:http');
const net = require('node:net');
const { createObservedMedia } = require('./observed-media.cjs');
const { handleCertificateIssuerRequest } = require('./certificate-issuer-proxy.cjs');
const { eventUrl:streameastEventUrl,serverUrl:streameastServerUrl,publishedFreePlayer } = require('./streameast-catalog.cjs');

const OBSERVE_MS = 20000;
const OBSERVER_SLOTS = 4;
const MAX_REQUESTS = 300;
const MAX_CONNECTS = 100;
const MAX_FRAMES = 32;
const SPORTSPATRIKA_MAX_FRAMES = 64;
const NFLSTREAMS_MAX_FRAMES = 64;
const TVAPP_EMBED_MAX_FRAMES = 64;
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
  if (typeof value !== 'string' || value.length > 2048) return null;
  const transport = value.split('#',1)[0];
  if (transport.startsWith('wss://')) return publicUrl(`https://${transport.slice(6)}`);
  return publicUrl(transport);
}

function isOfflinePlayerState(state) {
  return state.readyState !== 'loading' && !state.hasVideo && state.title === 'Stream is Offline' &&
    state.status === 'Offline' && state.description.startsWith('The stream is currently offline.');
}

function isNetworkErrorPlayerState(state) {
  return state.readyState === 'complete' && !state.hasVideo && state.title === 'Technical Issue' &&
    state.errorVisible && state.errorHeading === 'Network Error' &&
    state.errorDescription.startsWith('We are having trouble connecting to the server. Please reload the page.');
}

function liveFramesInSubtree(mainFrame) {
  return mainFrame.framesInSubtree.filter(frame => frame && !frame.isDestroyed());
}

function dudestreamCfbEmbeddedPair(event,server) {
  return !!event && !!server && event.origin === 'https://dudestream1.com' && !event.search &&
    /^\/cfb[1-9]\d{0,2}\/$/.test(event.pathname) && server.origin === 'https://embedsports.me' && !server.search &&
    /^\/american-football\/[a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*-stream-[12]$/.test(server.pathname);
}

function offlinePlayerFrame(source, frames, embeddedEventUrl) {
  const sourceUrl = publicUrl(source);
  if (!sourceUrl || sourceUrl.search || sourceUrl.port) return null;
  const direct = sourceUrl.hostname === 'vipbox.fm' && /^\/live\/(?:nfl|ncaaf)\/[a-z0-9]+(?:-[a-z0-9]+)*-[1-9]\d{0,3}$/.test(sourceUrl.pathname) ||
    sourceUrl.hostname === 'strikeout.im' && /^\/(?:nfl|college-football)\/[1-9]\d{0,3}\/[a-z0-9]+(?:-[a-z0-9]+)*-stream$/.test(sourceUrl.pathname) ||
    sourceUrl.hostname === 'www.vipboxtv.sk' && /^\/cfb\/[1-9]\d{0,3}\/stream-[a-z0-9]+(?:-[a-z0-9]+)*-live$/.test(sourceUrl.pathname);
  const embedded = embeddedEventUrl ? publicUrl(embeddedEventUrl) : null;
  const team = embedded?.hostname === 'ms.buffstream.io' && !embedded.search && !embedded.port ?
    /^\/(?:nfl|cfb)-streams\/([a-z0-9]+(?:-[a-z0-9]+)*)-live-stream$/.exec(embedded.pathname)?.[1] : null;
  const pair = sourceUrl.hostname === 'embedsports.me' ?
    /^\/american-football\/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$/.exec(sourceUrl.pathname) : null;
  const dudestream = dudestreamCfbEmbeddedPair(embedded,sourceUrl);
  const selected = embeddedEventUrl ? !!pair && (dudestream || !!team && (team === pair[1] || team === pair[2])) : direct;
  if (!selected) return null;
  const players = frames.filter(frame => {
    try {
      const url = new URL(frame.url);
      const owned = !embeddedEventUrl || (dudestream ? belongsToDudestreamPage(frame,source,embeddedEventUrl) :
        belongsToEmbeddedServer(frame,source));
      return url.protocol === 'https:' && url.pathname === '/sd0embed/NFL' &&
        ['fallafar.me','posamari.me','dervlin.me','ninguno.cc','lonpapil.eu'].includes(url.hostname) &&
        owned;
    }
    catch { return false; }
  });
  return players.length === 1 ? players[0] : null;
}

function activatePublishedJwVideo(page = document, computedStyle = getComputedStyle) {
  const videos = page.querySelectorAll('video');
  const buttons = page.querySelectorAll('.jw-icon-playback[role="button"][aria-label="Play"]');
  if (videos.length !== 1 || buttons.length !== 1) return false;
  const video = videos[0];
  if (!video.paused) return false;
  const rect = video.getBoundingClientRect(), style = computedStyle(video);
  if (rect.width < 240 || rect.height < 135 || style.display === 'none' || style.visibility === 'hidden') return false;
  video.muted = true;
  buttons[0].click();
  void video.play().catch(() => {});
  return true;
}

function belongsToEmbeddedServer(frame,serverUrl) {
  try {
    for(let current=frame;current;current=current.parent){
      if(current.isDestroyed())return false;
      if(current.url===serverUrl)return true;
    }
  } catch { return false; }
  return false;
}

function belongsToDudestreamPage(frame,serverUrl,eventUrl) {
  try {
    for(let current=frame;current;current=current.parent){
      if(current.isDestroyed())return false;
      if(current.url===serverUrl)return current.parent?.url===eventUrl&&!current.parent.isDestroyed();
    }
  } catch {}
  return false;
}

function sportspatrikaEntry(value) {
  const url = publicUrl(value);
  return !!url && url.origin === 'https://embed.sportspatrika.com' && url.pathname === '/live/embed.php' &&
    /^\?ch=es[0-9]+$/.test(url.search);
}

function belongsToSelectedStreameastPlayer(frame,current) {
  if(!current.selection?.playerUrl||!current.selection.playerFrame||!frame)return false;
  try {
    const main=current.window.webContents.mainFrame;
    let root=frame;
    while(root.parent&&root.parent!==main)root=root.parent;
    return root===current.selection.playerFrame&&root.parent===main&&
      root.url===current.selection.playerUrl&&main.framesInSubtree.includes(root);
  } catch{return false;}
}

function selectedWikisportJwFrame(current,frames) {
  try {
    const selection=current?.selection;
    if(selection?.kind!=='streameast-server'||
      !selection.playerUrl||!selection.playerFrame||
      current.url!==`${selection.eventUrl}${selection.serverId}`)return null;
    const rootUrl=publicUrl(selection.playerUrl);
    if(!rootUrl||rootUrl.origin!=='https://wikisport.info'||rootUrl.port||rootUrl.search||
      !/^\/ch\/[1-9]\d{0,3}\.php$/.test(rootUrl.pathname))return null;
    const main=current.window?.webContents?.mainFrame;
    const root=selection.playerFrame;
    if(!main||main.url!==current.url||root.isDestroyed()||root.parent!==main||
      root.url!==selection.playerUrl||!frames.includes(root)||!main.framesInSubtree.includes(root))return null;
    const players=frames.filter(frame=>{
      if(frame.parent!==root)return false;
      const url=publicUrl(frame.url);
      return !!url&&url.origin==='https://xstream.st'&&!url.port&&
        url.pathname==='/fslivepro.php'&&url.searchParams.size===1&&
        /^[-_a-zA-Z0-9]{1,40}$/.test(url.searchParams.get('stream')||'');
    });
    if(players.length!==1)return null;
    const player=players[0];
    if(player.isDestroyed()||!main.framesInSubtree.includes(player)||
      !belongsToSelectedStreameastPlayer(player,current))return null;
    return player;
  } catch { return null; }
}

function allowsSelectedStreameastNavigation(frame,target,current) {
  try {
    if(frame.parent!==current.window.webContents.mainFrame)return true;
    return target===current.selection?.playerUrl &&
      (!current.selection.playerFrame||frame===current.selection.playerFrame);
  } catch{return false;}
}

function recognizedDlivePixelTransport(evidence) {
  if (!evidence || evidence.loaderConfigured !== true) return false;
  const player = publicUrl(evidence.playerUrl);
  const frame = publicUrl(evidence.frameUrl);
  const jw = publicUrl(evidence.jwSource);
  const observed = publicUrl(evidence.observedUrl);
  return !!player && !!frame && !!jw && !!observed &&
    player.origin === 'https://dlive.sx' && !player.port && !player.search &&
    /^\/stream\/stream-[1-9][0-9]{0,3}\.php$/.test(player.pathname) &&
    frame.origin === 'https://dembed.top' && !frame.port &&
    !jw.port && !jw.search && /\/index\.m3u8$/.test(jw.pathname) &&
    observed.origin === jw.origin && observed.pathname === jw.pathname &&
    (!observed.search || /^\?_=[0-9]{10,16}$/.test(observed.search));
}

function tvappEmbedEntry(value) {
  const url = publicUrl(value);
  return !!url && url.origin === 'https://embed.st' && !url.search && !url.port &&
    /^\/embed\/[a-z0-9-]{1,32}\/[a-zA-Z0-9_-]{1,120}\/[1-9][0-9]{0,2}$/.test(url.pathname);
}

function aianimalvibesPlayer(value) {
  const url = publicUrl(value);
  return !!url && url.origin === 'https://ch.aianimalvibes.com' &&
    /^\/(?:football|cfb)\/[0-9]{1,10}$/.test(url.pathname) && !url.search && !url.port;
}

function createNavigationPolicy(value,allowStreameastServer=false) {
  const initial = new URL(value);
  const event = ['https://streameast.ga','https://v2.streameast.ga'].includes(initial.origin) &&
    !initial.search && !initial.hash &&
    ( /^\/(?:cfb|nfl)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(initial.pathname) ||
      allowStreameastServer && /^\/(?:cfb|nfl)\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{1,4}$/.test(initial.pathname));
  const canonical = event ? `https://v2.streameast.ga${initial.pathname}` : null;
  const mygoodstreamShort = initial.origin === 'https://mygoodstream.pw' &&
    /^\/short\/[A-Za-z0-9]{8,32}$/.test(initial.pathname);
  const providerRedirect = !initial.search && !initial.hash && !initial.port ?
    initial.origin === 'https://dudestream1.com' && /^\/[a-z0-9]{16,32}$/.test(initial.pathname)
      ? target => target.origin === initial.origin && target.pathname === '/nfl2/' :
    mygoodstreamShort
      ? target => target.origin === 'https://v2.mygoodstream.pw' && /^\/watch\/[a-f0-9]{24}$/.test(target.pathname) :
    initial.origin === 'https://shd247.world' && /^\/live-go-streaming-[0-9]+\.html$/.test(initial.pathname)
      ? target => target.origin === 'https://streamhd247.click' && target.pathname === initial.pathname : null : null;
  let current = value;
  let phase = value === canonical ? 'canonical' : 'initial';
  return target => {
    if (target === current) return true;
    const url = publicUrl(target);
    if (!url || url.port) return false;
    if (providerRedirect) {
      if (mygoodstreamShort && phase === 'canonical' && !url.search &&
        url.origin === 'https://v2.mygoodstream.pw' &&
        url.pathname === new URL(current).pathname.slice('/watch'.length)) {
        current = target;
        phase = 'complete';
        return true;
      }
      if (phase !== 'initial' || url.search || !providerRedirect(url)) return false;
      current = target;
      phase = mygoodstreamShort ? 'canonical' : 'complete';
      return true;
    }
    if (!event) return false;
    const handoff = url.origin === 'https://auth.streamea.st' && url.pathname === '/SsoHandoff.php' &&
      [...url.searchParams.keys()].sort().join(',') === 'h,p' &&
      url.searchParams.get('h') === 'v2.streameast.ga' && url.searchParams.get('p') === initial.pathname;
    const connect = url.origin === 'https://v2.streameast.ga' && url.pathname === '/connect.php' &&
      [...url.searchParams.keys()].join(',') === 'redirect' && url.searchParams.get('redirect') === initial.pathname;
    if ((phase === 'initial' || phase === 'canonical') && handoff) phase = 'handoff';
    else if (phase === 'handoff' && connect) phase = 'connect';
    else if (phase === 'initial' && target === canonical) phase = 'canonical';
    else if ((phase === 'handoff' || phase === 'connect') && target === canonical) phase = 'complete';
    else return false;
    current = target;
    return true;
  };
}

async function pinnedAddress(host,isActive = () => true) {
  if (!isActive()) throw new Error('dns-inactive');
  const addresses = await Promise.race([
    lookup(host,{all:true}),
    new Promise((_,reject) => setTimeout(() => reject(new Error('dns-timeout')),3000)),
  ]);
  if (!isActive()) throw new Error('dns-inactive');
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

  proxy = http.createServer((request,response) => {
    const current = active;
    void handleCertificateIssuerRequest(request,response,{
      authorization:proxyAuthorization,pinAddress:pinnedAddress,
      isActive:()=>!!current && active===current,
      admit:()=>++current.issuerRequests<=8,
    });
  });
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
    try { address = await pinnedAddress(url.hostname,() => active === current); }
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
    if(current?.selection && details.resourceType==='subFrame'){
      let parent='';
      try {parent=details.frame?.parent?.url||'';}catch{}
      if(!current.selection.playerUrl||parent===current.url && details.url!==current.selection.playerUrl){
        callback({cancel:true});
        return;
      }
    }
    if(current?.embeddedEventUrl && details.resourceType==='subFrame'){
      let parent='';
      try { parent=details.frame?.parent?.url||''; } catch {}
      if(parent===current.embeddedEventUrl && details.url!==current.url){
        callback({cancel:true});
        return;
      }
    }
    const url = publicNetworkUrl(details.url);
    const localPdfObject = details.resourceType === 'object' &&
      details.url.startsWith('data:application/pdf;base64,') && details.url.length <= 1024 &&
      typeof details.initiatorOrigin === 'string' &&
      publicUrl(`${details.initiatorOrigin}/`)?.origin === details.initiatorOrigin;
    if (!current || !url && !localPdfObject ||
      (details.url.startsWith('wss://') && details.resourceType !== 'webSocket') ||
      ['image','font','ping','cspReport'].includes(details.resourceType) ||
      (details.resourceType === 'mainFrame' && !current.navigation(details.url)) || ++current.requests > MAX_REQUESTS) {
      if (current && details.resourceType === 'mainFrame' && url) debug('main frame rejected',url.origin,url.pathname);
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
      requestReferer:referer,origin:header('origin'),
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
      if(current.selection&&!belongsToSelectedStreameastPlayer(candidate.frame,current)){
        callback({cancel:false});
        return;
      }
      if(current.embeddedEventUrl && !belongsToEmbeddedServer(candidate.frame,current.url)){
        callback({cancel:false});
        return;
      }
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
            let subtree;
            try { subtree = liveFramesInSubtree(current.window.webContents.mainFrame); }
            catch { endActive(current,null); return; }
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
            const visible = frames.filter((frame,index) => results[index]?.status === 'fulfilled' && results[index].value &&
              !frames[index].isDestroyed() && frames[index].url === urls[index] &&
              current.window.webContents.mainFrame.framesInSubtree.includes(frames[index]) &&
              (!current.selection || belongsToSelectedStreameastPlayer(frames[index],current)) &&
              (!current.embeddedEventUrl || belongsToEmbeddedServer(frames[index],current.url)));
            if (visible.length === 1) {
              const playerFrame = visible[0];
              const playerUrl = playerFrame.url;
              let transport;
              if (current.selection?.playerUrl?.startsWith('https://dlive.sx/stream/')) {
                try {
                  const jw = await playerFrame.executeJavaScript(`(() => {
                    if (typeof window.jwplayer !== 'function') return null;
                    const player = window.jwplayer();
                    const config = player?.getConfig?.();
                    const item = player?.getPlaylistItem?.();
                    return { jwSource: typeof config?.file === 'string' && config.file === item?.file ? config.file : null,
                      loaderConfigured: typeof LiveLoader === 'function' && config?.hlsjsConfig?.loader === LiveLoader };
                  })()`);
                  if (recognizedDlivePixelTransport({playerUrl:current.selection.playerUrl,
                    frameUrl:playerFrame.url,jwSource:jw?.jwSource,observedUrl:candidate.url,
                    loaderConfigured:jw?.loaderConfigured})) transport='dlive-pixel-gzip-ts';
                } catch {}
              }
              let stillOwned = false;
              try {
                stillOwned = active === current && !playerFrame.isDestroyed() && playerFrame.url === playerUrl &&
                  current.window.webContents.mainFrame.framesInSubtree.includes(playerFrame) &&
                  (!current.selection || belongsToSelectedStreameastPlayer(playerFrame,current)) &&
                  (!current.embeddedEventUrl || belongsToEmbeddedServer(playerFrame,current.url));
              } catch {}
              if (!stillOwned) return;
              endActive(current,{ url: candidate.url, referer: refererUrl.href,
                userAgent: candidate.userAgent,requestReferer:candidate.requestReferer,origin:candidate.origin,
                ...(transport ? {transport} : {}) });
              return;
            }
            if (Date.now()+500 < current.deadline) {
              const timer = setTimeout(() => { current.probeTimers.delete(timer); runProbe(); },500);
              current.probeTimers.add(timer);
            }
          };
          const runProbe = () => { void probe().catch(error => {
            debug('media probe failed',error?.message);
            endActive(current,null);
          }); };
          runProbe();
        }
      }
    }
    callback({ cancel: false });
  });
  function observe(url,purpose,embeddedEventUrl,selection) {
    if (active) return null;
    const window = new BrowserWindow({ show: false, webPreferences: {
      partition, contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    } });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigation = createNavigationPolicy(embeddedEventUrl||url,!!selection);
    for (const name of ['will-navigate','will-redirect']) window.webContents.on(name,(event,target) => {
      if (event.isMainFrame !== false && !navigation(event.url || target)) {
        const blocked = publicUrl(event.url || target);
        debug('navigation rejected',blocked?.origin,blocked?.pathname);
        event.preventDefault();
      }
    });
    if(selection)window.webContents.on('will-frame-navigate',event=>{
      if(event.isMainFrame||!event.frame)return;
      if(!current||!allowsSelectedStreameastNavigation(event.frame,event.url,current))event.preventDefault();
    });
    window.webContents.on('login',(event,_details,authInfo,callback) => {
      debug('login',authInfo.isProxy,authInfo.host);
      if (!authInfo.isProxy || authInfo.host !== '127.0.0.1') return;
      event.preventDefault();
      callback('observer',proxySecret);
    });
    let current;
    const promise = new Promise(resolve => {
      current = { window, url, embeddedEventUrl, selection, navigation, purpose, resolve, sockets: new Set(), requests: 0, proxyRequests: 0, tunnels: 0, bytes: 0,
        issuerRequests:0,
        frameLimit:embeddedEventUrl && new URL(embeddedEventUrl).hostname==='nflstreams.org' ? NFLSTREAMS_MAX_FRAMES :
          sportspatrikaEntry(url) ? SPORTSPATRIKA_MAX_FRAMES :
            tvappEmbedEntry(url) ? TVAPP_EMBED_MAX_FRAMES : MAX_FRAMES,
        deadline: Date.now()+OBSERVE_MS, probeKeys: new Set(), probeTimers: new Set(),
        timer: setTimeout(() => endActive(current,null),OBSERVE_MS) };
      active = current;
      current.playerTimer = setInterval(() => {
        if (active !== current || current.playerActivated) return;
        let frames;
        try { frames = liveFramesInSubtree(window.webContents.mainFrame); }
        catch { endActive(current,null); return; }
        const offline = offlinePlayerFrame(current.url,frames,current.embeddedEventUrl);
        if (offline && !offline.isDestroyed()) {
          const frame = offline, url = frame.url;
          void frame.executeJavaScript(`({title:document.title,readyState:document.readyState,
            hasVideo:!!document.querySelector('video'),
            status:document.querySelector('.banner-container .status-text')?.textContent.trim() || '',
            description:document.querySelector('.banner-container .description')?.textContent.trim() || '',
            errorVisible:(()=>{const error=document.querySelector('.error-state');if(!error)return false;
              const rect=error.getBoundingClientRect(),style=getComputedStyle(error);
              return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';})(),
            errorHeading:document.querySelector('.error-state > h2')?.textContent.trim() || '',
            errorDescription:document.querySelector('.error-state > p')?.textContent.trim() || ''})`).then(state => {
            if (active === current && !frame.isDestroyed() && frame.url === url &&
              current.window.webContents.mainFrame.framesInSubtree.includes(frame) &&
              (!current.embeddedEventUrl || belongsToEmbeddedServer(frame,current.url)) &&
              (isOfflinePlayerState(state) || isNetworkErrorPlayerState(state))) {
              debug('player explicitly unavailable');
              endActive(current,null);
            }
          }).catch(() => {});
          if (!current.playerActivating) {
            current.playerActivating = true;
            void frame.executeJavaScript(`(${activatePublishedJwVideo.toString()})()`)
              .then(activated => {
                if (active !== current) return;
                if (frame.isDestroyed() || frame.url !== url ||
                  !current.window.webContents.mainFrame.framesInSubtree.includes(frame) ||
                  current.embeddedEventUrl && !belongsToEmbeddedServer(frame,current.url)) {
                  current.playerActivating = false;
                  return;
                }
                if (activated) { current.playerActivated = true; debug('activated published SD0 player'); }
                else current.playerActivating = false;
              }).catch(() => { if (active === current) current.playerActivating = false; });
          }
        }
        const selectedJw=selectedWikisportJwFrame(current,frames);
        if(selectedJw&&!current.playerActivating) {
          const frame=selectedJw, url=frame.url;
          current.playerActivating=true;
          void frame.executeJavaScript(`(() => location.href===${JSON.stringify(url)}&&
            (${activatePublishedJwVideo.toString()})())()`)
            .then(activated=>{
              if(active!==current)return;
              let stillSelected=false;
              try {stillSelected=!frame.isDestroyed()&&frame.url===url&&
                selectedWikisportJwFrame(current,liveFramesInSubtree(window.webContents.mainFrame))===frame;}
              catch {}
              if(activated&&stillSelected) {
                current.playerActivated=true;
                debug('activated selected Wikisport JW player');
              } else current.playerActivating=false;
            }).catch(()=>{if(active===current)current.playerActivating=false;});
        }
        const aianimalvibesFrames = frames.filter(frame => aianimalvibesPlayer(frame.url));
        if (aianimalvibesFrames.length > 1) return;
        const player = aianimalvibesFrames[0] || frames.find(frame => {
          try { return new URL(frame.url).hostname === 'nfl.earnsphere.site'; }
          catch { return false; }
        });
        if (!player || player.isDestroyed()) return;
        const aianimalvibes = aianimalvibesFrames.length === 1;
        const expectedUrl = JSON.stringify(player.url);
        void player.executeJavaScript(`(() => {
          if (${aianimalvibes} && location.href !== ${expectedUrl}) return false;
          if (${aianimalvibes} &&
            (document.querySelectorAll('video').length !== 1 ||
              document.querySelectorAll('button[aria-label="playpause"]').length !== 1)) return false;
          const video = document.querySelector('video');
          const button = document.querySelector('button[aria-label="playpause"]');
          if ((!${aianimalvibes} && document.title !== 'LIVE NFL') || !video || !button || !video.paused) return false;
          const rect = video.getBoundingClientRect();
          if (rect.width < 240 || rect.height < 135) return false;
          if (${aianimalvibes}) {
            const videoStyle = getComputedStyle(video);
            if (videoStyle.display === 'none' || videoStyle.visibility === 'hidden') return false;
          }
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
        if (frames > current.frameLimit) { debug('too many frames',frames); endActive(current,null); }
      });
      if(selection)window.webContents.on('did-frame-navigate',(_event,navigatedUrl,_code,_status,isMainFrame,processId,routingId)=>{
        if(active!==current||isMainFrame||!current.selection.playerUrl||
          navigatedUrl!==current.selection.playerUrl)return;
        const frame=webFrameMain.fromId(processId,routingId);
        try {
          const main=window.webContents.mainFrame;
          if(!frame||frame.parent!==main||current.selection.playerFrame||
            liveFramesInSubtree(main).filter(item=>item.parent===main&&item.url===navigatedUrl).length!==1){
            endActive(current,null);return;
          }
          current.selection.playerFrame=frame;
        } catch {endActive(current,null);}
      });
      if(selection)window.webContents.on('dom-ready',()=>{
        if(active!==current||window.webContents.getURL()!==url||current.selection.playerUrl)return;
        void window.webContents.mainFrame.executeJavaScript('document.documentElement.outerHTML').then(html=>{
          if(active!==current||window.webContents.getURL()!==url)return;
          const event={id:selection.sourceEventId,url:selection.eventUrl};
          const player=publishedFreePlayer(html,event,url);
          if(player.kind!=='page'){endActive(current,null);return;}
          current.selection.playerUrl=player.url;
          const expected=JSON.stringify(player.url),page=JSON.stringify(url);
          return window.webContents.mainFrame.executeJavaScript(`(() => {
            if(location.href!==${page})return false;
            const roots=document.querySelectorAll('#se-player-root.se-player');
            if(roots.length!==1)return false;
            const frames=roots[0].querySelectorAll(':scope > iframe[src]');
            if(frames.length!==1||frames[0].src!==${expected})return false;
            for(const frame of document.querySelectorAll('iframe'))if(frame!==frames[0])frame.remove();
            const selected=frames[0].cloneNode(false);
            frames[0].replaceWith(selected);
            return true;
          })()`).then(valid=>{if(active===current&&!valid)endActive(current,null);});
        }).catch(()=>{if(active===current)endActive(current,null);});
      });
      if(embeddedEventUrl)window.webContents.on('dom-ready',()=>{
        if(active!==current||window.webContents.getURL()!==embeddedEventUrl)return;
        const selectedUrl=JSON.stringify(url),eventUrl=JSON.stringify(embeddedEventUrl);
        const isNfl=new URL(embeddedEventUrl).hostname==='nflstreams.org';
        const isDudestream=new URL(embeddedEventUrl).hostname==='dudestream1.com';
        void window.webContents.executeJavaScript(`(() => {
          if(location.href!==${eventUrl})return false;
          if(${isNfl}){
            if(document.querySelector('.home__team-fixture-matche.fixture-active')?.href!==${eventUrl})return false;
          }else{
            const canonical=document.querySelector('link[rel="canonical"]')?.href;
            if(!canonical)return false;
            if(${isDudestream}&&canonical!==${eventUrl})return false;
            const canonicalUrl=new URL(canonical),eventUrl=new URL(${eventUrl});
            if(!['http:','https:'].includes(canonicalUrl.protocol)||canonicalUrl.hostname!==eventUrl.hostname||
              canonicalUrl.pathname!==eventUrl.pathname||canonicalUrl.search||canonicalUrl.hash)return false;
          }
          const matches=[];
          for(const script of document.querySelectorAll(${isNfl?"'.theatre1 script[type=\"text/template\"]'":"'script[type=\"text/template\"]'"})){
            const frames=new DOMParser().parseFromString(script.textContent,'text/html').querySelectorAll('iframe[src]');
            if(frames.length===1&&frames[0].getAttribute('src')===${selectedUrl})matches.push(frames[0].getAttribute('src'));
          }
          for(const frame of document.querySelectorAll(${isNfl?"'.theatre1 iframe[src]'":"'iframe[src]'"})){
            if(frame.getAttribute('src')===${selectedUrl})matches.push(frame.getAttribute('src'));
          }
          if(matches.length!==1)return false;
          for(const frame of document.querySelectorAll('iframe'))frame.remove();
          const frame=document.createElement('iframe');
          frame.src=matches[0];frame.width='800';frame.height='450';
          document.body.prepend(frame);
          return true;
        })()`).then(selected=>{if(active===current&&!selected)endActive(current,null);}).catch(()=>{
          if(active===current)endActive(current,null);
        });
      });
      window.on('closed',() => { if (active === current) { debug('window closed'); endActive(current,null); } });
    });
    return { promise, cancel: () => endActive(current,null),
      start: () => { if (active === current) void window.loadURL(embeddedEventUrl||url).catch(() => {}); } };
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
  const media = createObservedMedia({ pinAddress:pinnedAddress,validateUrl:publicUrl });
  const service = http.createServer(async (request,response) => {
    const release = request.method === 'DELETE' && /^\/media\/([a-f0-9-]{36})$/.exec(request.url || '');
    if (!release && (request.method !== 'POST' || !['/observe','/media'].includes(request.url))) { response.writeHead(404); response.end(); return; }
    if (!authorized(request.headers['x-sunday-control-token'],controlToken)) { response.writeHead(401); response.end(); return; }
    if (release) { media.close(release[1]); response.writeHead(204); response.end(); return; }
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
      if (request.url === '/media') {
        media.read(input?.capability,input?.url,input?.range,response);
        return;
      }
      const url = typeof input?.url === 'string' && publicUrl(input.url);
      const purpose = input?.purpose === undefined ? 'playback' : input.purpose;
      const embeddedEvent = input?.embeddedEventUrl === undefined ? undefined :
        typeof input.embeddedEventUrl === 'string' && publicUrl(input.embeddedEventUrl);
      const rawSelection=input?.selection;
      let selection;
      if(rawSelection?.kind==='streameast-server'&&
        typeof rawSelection.eventUrl==='string'&&typeof rawSelection.sourceEventId==='string'&&
        typeof rawSelection.serverId==='string'){
        const match=/^(ncaaf|nfl):(\d{1,12})$/.exec(rawSelection.sourceEventId);
        const league=match?.[1];
        const sourceEvent={id:rawSelection.sourceEventId,url:rawSelection.eventUrl,league};
        const original=league&&streameastEventUrl(rawSelection.eventUrl,league);
        const server=original&&streameastServerUrl(`${original}${rawSelection.serverId}`,sourceEvent);
        if(original===rawSelection.eventUrl&&server?.url===url?.href&&server.id===rawSelection.serverId)
          selection={kind:'streameast-server',eventUrl:original,sourceEventId:sourceEvent.id,
            serverId:server.id};
      }
      if (!url || purpose !== 'probe' && purpose !== 'playback' ||
        input?.embeddedEventUrl !== undefined && !embeddedEvent ||
        rawSelection!==undefined && !selection || selection && embeddedEvent ||
        embeddedEvent && !(
          embeddedEvent.hostname==='nflstreams.org'&&url.hostname==='piratecat.store'||
          embeddedEvent.hostname==='ms.buffstream.io'&&url.hostname==='embedsports.me'||
          dudestreamCfbEmbeddedPair(embeddedEvent,url))) {
        response.writeHead(400); response.end(); return;
      }
      for (const slot of slots) {
        operation = slot.observe(url.href,purpose,embeddedEvent?.href,selection);
        if (operation) break;
      }
      if (!operation && purpose === 'playback') {
        const victim = slots.find(slot => slot.preemptProbe());
        if (victim) operation = victim.observe(url.href,purpose,embeddedEvent?.href,selection);
      }
      if (!operation) { response.writeHead(429); response.end(); return; }
      await pinnedAddress((embeddedEvent||url).hostname,() => !closed);
      if (closed) return;
      operation.start();
      const result = await operation.promise;
      response.off('close',onClose);
      if (closed) return;
      if (result?.deferred) { response.writeHead(503); response.end(); return; }
      if (result === null) { response.writeHead(404); response.end(); return; }
      const capability = await media.register(result);
      if (!capability) { response.writeHead(503); response.end(); return; }
      if (response.destroyed) { media.close(capability); return; }
      response.writeHead(200,{ 'content-type':'application/json', 'cache-control':'no-store' });
      response.end(JSON.stringify({url:result.url,referer:result.referer,userAgent:result.userAgent,capability,
        ...(result.transport ? {transport:result.transport} : {})}));
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
    media.stop();
    if (service.listening) service.close();
    for (const slot of slots) slot.stop();
  }
  return { start, stop };
}

module.exports = { createSportsurgeObserver, createNavigationPolicy, publicNetworkUrl, isOfflinePlayerState, isNetworkErrorPlayerState, offlinePlayerFrame, activatePublishedJwVideo, aianimalvibesPlayer, belongsToSelectedStreameastPlayer, selectedWikisportJwFrame, allowsSelectedStreameastNavigation, recognizedDlivePixelTransport };
