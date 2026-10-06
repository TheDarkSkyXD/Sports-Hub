import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import { boundedText, ProviderDeferredError, sanitizedRead, type ProviderPlayback, type ProviderResource, type ResourceKind } from '../provider.ts';

export type Requester = (url: URL, signal: AbortSignal, headers: Headers, timeoutMs?: number) => Promise<Response>;

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const HEADER_WAIT_MS = 10000;
const RESOURCE_READ_MS = 30000;
const MAX_REDIRECTS = 3;
const blockedV4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const number = ((parts[0] * 0x1000000) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
    return !blockedV4.some(([base, bits]) => (number >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (family === 6) {
    const value = address.toLowerCase();
    return /^[23][0-9a-f]{0,3}:/.test(value) && !/^2001:db8:/i.test(value) &&
      !/^2001:0:/i.test(value) && !/^2002:/i.test(value);
  }
  return false;
}

export function sportsurgeUrl(value: string): URL | null {
  try {
    const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
    const url = new URL(value);
    if (!authority || authority.toLowerCase() !== url.host || url.href.length > 2048 ||
      url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '8443' || url.hash ||
      url.hostname.endsWith('.') || isIP(url.hostname) || url.hostname.startsWith('[') ||
      !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

export async function publicHttpsRequest(url: URL, signal: AbortSignal, headers: Headers,
  resolveAddresses: (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>> = host => lookup(host, { all: true }),
  timeoutMs = 10000): Promise<Response> {
  if (!sportsurgeUrl(url.href)) throw new Error('Unsupported provider URL');
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(HEADER_WAIT_MS)]);
  const addresses = await new Promise<ReadonlyArray<{ address: string; family: number }>>((resolve, reject) => {
    if (dnsSignal.aborted) { reject(dnsSignal.reason); return; }
    const onAbort = () => reject(dnsSignal.reason);
    dnsSignal.addEventListener('abort', onAbort, { once: true });
    resolveAddresses(url.hostname).then(resolve, reject).finally(() => dnsSignal.removeEventListener('abort', onAbort));
  });
  if (!addresses.length || addresses.some(item => item.family !== isIP(item.address) || !isPublicAddress(item.address)))
    throw new Error('Provider resolved to a private address');
  const address = addresses.find(item => item.family === 4) || addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method: 'GET', headers: Object.fromEntries(headers), signal,
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, incoming => {
      clearTimeout(headerTimer);
      incoming.on('error', reject);
      try {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') responseHeaders.set(key, value);
          else if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
        }
        const length = Number(responseHeaders.get('content-length'));
        if (Number.isFinite(length) && length > MAX_MEDIA_BYTES) throw new Error('Provider response is too large');
        const status = incoming.statusCode || 502;
        if (status === 204 || status === 205 || status === 304) {
          incoming.destroy();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        const bodyTimer = setTimeout(() => outgoing.destroy(new Error('Provider response timed out')), timeoutMs);
        incoming.once('close', () => clearTimeout(bodyTimer));
        const iterator = incoming[Symbol.asyncIterator]();
        let received = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) { controller.close(); return; }
              received += next.value.byteLength;
              if (received > MAX_MEDIA_BYTES) throw new Error('Provider response is too large');
              controller.enqueue(new Uint8Array(next.value));
            } catch (error) { incoming.destroy(); controller.error(error); }
          },
          cancel() { incoming.destroy(); },
        });
        resolve(new Response(body, { status, headers: responseHeaders }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    const headerTimer = setTimeout(() => outgoing.destroy(new Error('Provider response timed out')), HEADER_WAIT_MS);
    outgoing.on('error', error => { clearTimeout(headerTimer); reject(error); });
    outgoing.end();
  });
}

export async function get(value: string, signal: AbortSignal, requester: Requester, referer?: URL, range?: string,
  timeoutMs?: number, userAgent='Mozilla/5.0'): Promise<{ url: URL; response: Response }> {
  let url = sportsurgeUrl(value);
  if (!url) throw new Error('Unsupported provider URL');
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const headers = new Headers({ 'User-Agent': userAgent, Accept: '*/*' });
    if (referer) {
      headers.set('Referer', referer.href);
      headers.set('Origin', referer.origin);
    }
    if (range) headers.set('Range', range);
    const response = await requester(url, signal, headers, timeoutMs);
    if (response.status < 300 || response.status > 399) return { url, response };
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Provider redirect has no location');
    url = sportsurgeUrl(new URL(location, url).href);
    if (!url) throw new Error('Provider redirect is unsafe');
  }
  throw new Error('Provider redirected too many times');
}

export function hlsUrl(url: URL, response: Response): boolean {
  const type = response.headers.get('content-type') || '';
  return /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i.test(type) ||
    (!/text\/html/i.test(type) && /\.m3u8$/i.test(url.pathname));
}

export function resource(value: URL, referer: URL, kind: ResourceKind, requester: Requester, userAgent='Mozilla/5.0'): ProviderResource {
  let current = value;
  const hockeySegment=/^\/([a-z]+-[a-z]+)\/[a-z0-9]{32}\/[1-9]\d*\.ts$/i.exec(value.pathname);
  const hockeyCredentials=/^\?(?:e=\d{10}&st=[A-Za-z0-9_-]{22}|st=[A-Za-z0-9_-]{22}&e=\d{10})$/.test(value.search);
  const identity=kind==='media'&&value.origin==='https://hls.hockey.do'&&!value.username&&!value.password&&
    !value.port&&!value.hash&&hockeySegment?.[1].length===12&&hockeyCredentials?
    `${value.origin}${value.pathname}`:value.href;
  return {
    kind, identity,
    async read({ signal, range }) {
      const readSignal = kind === 'playlist' ? AbortSignal.any([signal, AbortSignal.timeout(HEADER_WAIT_MS)]) : signal;
      const result = await get(current.href, readSignal, requester, referer, range,
        kind === 'media' ? RESOURCE_READ_MS : undefined, userAgent);
      current = result.url;
      if (kind === 'playlist' && !hlsUrl(current, result.response)) {
        await result.response.body?.cancel();
        throw new Error('Provider did not return HLS');
      }
      return sanitizedRead(result.response);
    },
    resolve(reference, expected) {
      try {
        const child = sportsurgeUrl(new URL(reference, current).href);
        return child ? resource(child, referer, expected, requester, userAgent) : null;
      } catch { return null; }
    },
  };
}

type PublicObservation={kind:'page';destination:URL;embeddedEvent?:URL}|{kind:'streameast-server';
  serverUrl:URL;eventUrl:URL;sourceEventId:string;serverId:string};

async function observedPublicRequest(request:PublicObservation, signal: AbortSignal,
  purpose: 'playback' | 'probe'): Promise<ProviderPlayback | null> {
  const destination=request.kind==='page'?request.destination:request.serverUrl;
  const origin = process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const token = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if (!origin || !token || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) {
    if (purpose === 'probe') throw new ProviderDeferredError(30000);
    return null;
  }
  const response = await fetch(`${origin}/observe`, {
    method: 'POST', cache: 'no-store', redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    headers: { 'Content-Type': 'application/json', 'x-sunday-control-token': token },
    body: JSON.stringify(request.kind==='page' ?
      {url:destination.href,purpose,embeddedEventUrl:request.embeddedEvent?.href} :
      {url:destination.href,purpose,selection:{kind:'streameast-server',eventUrl:request.eventUrl.href,
        sourceEventId:request.sourceEventId,serverId:request.serverId}}),
  });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 || response.status === 503) throw new ProviderDeferredError(2000);
    throw new Error('Browser observer failed');
  }
  const value: unknown = JSON.parse(await boundedText(response, 8192));
  if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string' ||
    !('referer' in value) || typeof value.referer !== 'string' ||
    !('userAgent' in value) || typeof value.userAgent !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(value.userAgent) ||
    !('capability' in value) || typeof value.capability !== 'string' || !/^[a-f0-9-]{36}$/.test(value.capability)) throw new Error('Browser observation was invalid');
  const media = sportsurgeUrl(value.url);
  const referer = sportsurgeUrl(value.referer);
  if (!media || !referer) throw new Error('Browser observation was unsafe');
  const capability = value.capability;
  let closed = false;
  const requester:Requester = async (url, active, headers) => {
    if (closed) throw new Error('Observed media session is closed');
    return fetch(`${origin}/media`, {
      method:'POST',cache:'no-store',redirect:'manual',signal:active,
      headers:{'Content-Type':'application/json','x-sunday-control-token':token},
      body:JSON.stringify({capability,url:url.href,range:headers.get('range') ?? undefined}),
    });
  };
  return {root:resource(media,referer,'playlist',requester,value.userAgent),close(){
    if (closed) return;
    closed = true;
    void fetch(`${origin}/media/${capability}`,{method:'DELETE',redirect:'manual',
      signal:AbortSignal.timeout(5000),headers:{'x-sunday-control-token':token}}).then(response=>response.body?.cancel()).catch(()=>{});
  }};
}

export function observedPublicPage(destination: URL, signal: AbortSignal,
  purpose: 'playback' | 'probe',embeddedEvent?:URL): Promise<ProviderPlayback | null> {
  return observedPublicRequest({kind:'page',destination,embeddedEvent},signal,purpose);
}

export function observedStreameastServerPage(choice:{serverUrl:URL;eventUrl:URL;sourceEventId:string;serverId:string},
  signal:AbortSignal,purpose:'playback'|'probe'):Promise<ProviderPlayback|null> {
  return observedPublicRequest({kind:'streameast-server',...choice},signal,purpose);
}

export async function publishedPublicVideo(destination: URL, parent: URL, signal: AbortSignal,
  requester:Requester=(url,active,headers,timeoutMs)=>publicHttpsRequest(url,active,headers,undefined,timeoutMs)): Promise<ProviderPlayback | null> {
  const active=AbortSignal.any([signal,AbortSignal.timeout(HEADER_WAIT_MS)]);
  const response=await requester(destination,active,new Headers({
    'User-Agent':'Mozilla/5.0',Accept:'text/html,application/vnd.apple.mpegurl',Referer:parent.href,Origin:parent.origin,
  }));
  if (hlsUrl(destination,response)) {
    await response.body?.cancel();
    return {root:resource(destination,parent,'playlist',requester),close(){}};
  }
  if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    return null;
  }
  const $=load(await boundedText(response,MAX_PAGE_BYTES));
  const videos=$('#player video, .player video').toArray();
  if (videos.length!==1) return null;
  const values=$(videos[0]).find('source[src]').map((_index,node)=>$(node).attr('src')).get();
  const own=$(videos[0]).attr('src');
  if (own) values.push(own);
  if (values.length!==1) return null;
  let media:URL;
  try { media=new URL(values[0],destination); } catch { return null; }
  if (!sportsurgeUrl(media.href) || !/\.m3u8$/i.test(media.pathname)) return null;
  return {root:resource(media,destination,'playlist',requester),close(){}};
}
