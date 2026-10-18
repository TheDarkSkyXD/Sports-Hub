import { lookup } from 'node:dns/promises';
import { load } from 'cheerio';
import { boundedText, ProviderCapacityError, ProviderDeferredError, ProviderNoFeedError, sanitizedRead, type PlayerDocument,type ProviderPlayback, type ProviderResource, type ResourceKind } from '../provider.ts';
import type { MediaPhase } from '../../football/shared.ts';
import { wrapDlivePixelResource } from './streameast-pixel.ts';
import {probeFetch,probeHttpResponse,probeObserverLease,releaseObserverAfterClose} from '../probe-capacity.ts';

import {directPublicHttpsRequest,publicHttpsUrl as sportsurgeUrl,type ContinuousRead} from '../public-http.ts';
export {isPublicAddress,publicHttpsUrl as sportsurgeUrl} from '../public-http.ts';
export type Requester = (url: URL, signal: AbortSignal, headers: Headers, timeoutMs?: number,continuous?:ContinuousRead) => Promise<Response>;

const MAX_PAGE_BYTES = 1024 * 1024;
const HEADER_WAIT_MS = 10000;
const RESOURCE_READ_MS = 30000;
const MAX_REDIRECTS = 3;

function continuousRead():ContinuousRead{
  const buckets=Array<number>(60).fill(0);
  let second=Math.floor(Date.now()/1000),bytes=0,active=0;
  return {
    received(amount){
      const current=Math.floor(Date.now()/1000);
      for(let elapsed=second+1;elapsed<=Math.min(current,second+60);elapsed++){
        const index=elapsed%60;bytes-=buckets[index];buckets[index]=0;
      }
      second=current;bytes+=amount;buckets[current%60]+=amount;
      return bytes<=128*1024*1024;
    },
    acquire(){
      if(active>=4)throw new ProviderCapacityError();
      active++;let released=false;
      return ()=>{if(!released){released=true;active--;}};
    },
  };
}


export function publicHttpsRequest(url:URL,signal:AbortSignal,headers:Headers,
  resolveAddresses:(host:string)=>Promise<ReadonlyArray<{address:string;family:number}>>=host=>lookup(host,{all:true}),
  timeoutMs=10000,continuous?:ContinuousRead):Promise<Response> {
  return probeHttpResponse(signal,active=>directPublicHttpsRequest(url,active,headers,resolveAddresses,timeoutMs,continuous),continuous?undefined:timeoutMs);
}

export async function get(value: string, signal: AbortSignal, requester: Requester, referer?: URL, range?: string,
  timeoutMs?: number, userAgent='Mozilla/5.0',continuous?:ContinuousRead): Promise<{ url: URL; response: Response }> {
  let url = sportsurgeUrl(value);
  if (!url) throw new Error('Unsupported provider URL');
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const headers = new Headers({ 'User-Agent': userAgent, Accept: '*/*' });
    if (referer) {
      headers.set('Referer', referer.href);
      headers.set('Origin', referer.origin);
    }
    if (range) headers.set('Range', range);
    const response = await requester(url, signal, headers, timeoutMs,continuous);
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

export function resource(value: URL, referer: URL, kind: ResourceKind, requester: Requester, userAgent='Mozilla/5.0',mode:'finite'|'progressive'='finite'): ProviderResource {
  let current = value;
  const continuous=mode==='progressive'?continuousRead():undefined;
  const hockeySegment=/^\/([a-z]+-[a-z]+)\/[a-z0-9]{32}\/[1-9]\d*\.ts$/i.exec(value.pathname);
  const hockeyCredentials=/^\?(?:e=\d{10}&st=[A-Za-z0-9_-]{22}|st=[A-Za-z0-9_-]{22}&e=\d{10})$/.test(value.search);
  const identity=kind==='media'&&value.origin==='https://hls.hockey.do'&&!value.username&&!value.password&&
    !value.port&&!value.hash&&hockeySegment?.[1].length===12&&hockeyCredentials?
    `${value.origin}${value.pathname}`:value.href;
  return {
    kind, identity,
    async read({ signal, range }) {
      const result = await get(current.href, signal, requester, referer, range,
        kind === 'media' ? RESOURCE_READ_MS : HEADER_WAIT_MS, userAgent,continuous);
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

function observerPhase(value:unknown):MediaPhase|null {
  return value==='activation'||value==='capture'||value==='ownership'||value==='replay' ? value : null;
}

function observerOutcome(value:unknown):{kind:'no-feed';phase:MediaPhase}|
  {kind:'incomplete';phase:MediaPhase;retryAfterMs:number;reason:'upstream'|'unverified'}|null {
  if (!value || typeof value!=='object' || !('kind' in value) || !('phase' in value)) return null;
  const phase=observerPhase(value.phase);
  if (!phase) return null;
  if (value.kind==='no-feed' && phase==='activation' && 'reason' in value && value.reason==='offline')
    return {kind:'no-feed',phase};
  if (value.kind==='incomplete' && 'retryAfterMs' in value &&
    typeof value.retryAfterMs==='number' && Number.isInteger(value.retryAfterMs) &&
    value.retryAfterMs>=30000 && value.retryAfterMs<=120000) return {kind:'incomplete',phase,retryAfterMs:value.retryAfterMs,
      reason:'reason'in value&&value.reason==='upstream-http'?'upstream':'unverified'};
  return null;
}

function observedPlayer(value:unknown):PlayerDocument|undefined{
  if(!value||typeof value!=='object'||!('player'in value)||!value.player||typeof value.player!=='object'||
    !('url'in value.player)||typeof value.player.url!=='string'||!('referer'in value.player)||typeof value.player.referer!=='string'||
    !(sportsurgeUrl(value.player.url)||/^https:\/\/embed\.st\/embed\/ingest\/[a-zA-Z0-9_-]{1,120}\/[1-9][0-9]{0,2}\/#player=clappr&autoplay=true$/.test(value.player.url))||
    !sportsurgeUrl(value.player.referer))return;
  return {url:value.player.url,referer:value.player.referer};
}

async function observedPublicRequest(request:PublicObservation, signal: AbortSignal,
  purpose: 'playback' | 'probe'): Promise<ProviderPlayback | null> {
  const destination=request.kind==='page'?request.destination:request.serverUrl;
  const origin = process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const token = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if (!origin || !token || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) {
    if (purpose === 'probe') throw new ProviderDeferredError(30000);
    return null;
  }
  const release=purpose==='probe'?await probeObserverLease(signal):()=>{};
  let transferred=false;
  const captureStarted=Date.now();
  try {
  const response = await fetch(`${origin}/observe`, {
    method: 'POST', cache: 'no-store', redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    headers: { 'Content-Type': 'application/json', 'x-sunday-control-token': token },
    body: JSON.stringify(request.kind==='page' ?
      {url:destination.href,purpose,embeddedEventUrl:request.embeddedEvent?.href} :
      {url:destination.href,purpose,selection:{kind:'streameast-server',eventUrl:request.eventUrl.href,
        sourceEventId:request.sourceEventId,serverId:request.serverId}}),
  });
  if (response.status === 404 || response.status === 503) {
    const body=await boundedText(response,1024,true).catch(()=>null);
    let value:unknown=null;
    if(body)try{value=JSON.parse(body);}catch{}
    const outcome=observerOutcome(value);
    if (response.status===404 && outcome?.kind==='no-feed') throw new ProviderNoFeedError(outcome.phase);
    const player=observedPlayer(value);
    if(response.status===503&&outcome?.kind==='incomplete'&&player)return {root:null,player,timings:{captureMs:Math.min(300000,Date.now()-captureStarted)},close(){}};
    if (response.status===503 && outcome?.kind==='incomplete')
      throw new ProviderDeferredError(outcome.retryAfterMs,outcome.phase,outcome.reason);
    if (response.status===404) return null;
    throw new ProviderCapacityError();
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new ProviderCapacityError();
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
  const transport = 'transport' in value ? value.transport : undefined;
  if (transport !== undefined && (request.kind !== 'streameast-server' || transport !== 'dlive-pixel-gzip-ts'))
    throw new Error('Browser observation transport was invalid');
  const capability = value.capability;
  const progressive='kind'in value&&value.kind==='progressive';
  if('kind'in value&&!progressive)throw new Error('Browser observation media kind was invalid');
  let closed = false;
  const requester:Requester = async (url, active, headers, timeoutMs,continuous) => {
    if (closed) throw new Error('Observed media session is closed');
    return probeFetch(fetch,`${origin}/media`, {
      method:'POST',cache:'no-store',redirect:'manual',signal:active,
      headers:{'Content-Type':'application/json','x-sunday-control-token':token},
      body:JSON.stringify({capability,url:url.href,range:headers.get('range') ?? undefined}),
    },continuous?undefined:timeoutMs);
  };
  const root = resource(media,referer,progressive?'media':'playlist',requester,value.userAgent,progressive?'progressive':'finite');
  transferred=true;
  return {root:transport === 'dlive-pixel-gzip-ts' ? wrapDlivePixelResource(root) : root,
    timings:{captureMs:Math.min(300000,Date.now()-captureStarted)},
    ...(observedPlayer(value)?{player:observedPlayer(value)}:{}),close(){
    if (closed) return;
    closed = true;
    releaseObserverAfterClose(async()=>{
      const response=await fetch(`${origin}/media/${capability}`,{method:'DELETE',redirect:'manual',
        signal:AbortSignal.timeout(5000),headers:{'x-sunday-control-token':token}});
      await response.body?.cancel();
      return response.ok||response.status===404;
    },release);
  }};
  } finally {if(!transferred)release();}
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
  const response=await requester(destination,signal,new Headers({
    'User-Agent':'Mozilla/5.0',Accept:'text/html,application/vnd.apple.mpegurl',Referer:parent.href,Origin:parent.origin,
  }),HEADER_WAIT_MS);
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
