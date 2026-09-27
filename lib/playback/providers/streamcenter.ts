import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText, sanitizedRead, type PlaybackProvider, type ProviderPlayback, type ProviderResource, type ResourceKind } from '../provider.ts';
import { parseStreamcenterPlayer } from './streamcenter-player.ts';

type StreamcenterLocator = Extract<CandidateLocator,{provider:'streamcenter'}>;
type MediaSession = { stream: string; host: string; referer: string; fetcher: typeof fetch };
const mediaHosts=new Set(['edgestream1.pro','edgestream3.pro','edgestream4.pro','edgestream5.pro','edgestream6.pro']);
const headers={Origin:'https://streame.center'};
const sourcePath=/^\/api\/stream-link\/iframe\/event-espn-league-football-college-football-(\d{5,12})\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const playerPath=/^\/embed\/ch\d{1,4}\.php$/;

function exactHttps(value: string): URL | null {
  try {
    const address=new URL(value);
    const authority=/^https:\/\/([^/?#]+)/.exec(value)?.[1];
    return authority===address.hostname && !address.port && !address.username && !address.password && !address.hash ? address : null;
  } catch { return null; }
}

export function validStreamcenterResourceUrl(value: string, session: Pick<MediaSession,'stream'|'host'>, kind: ResourceKind): boolean {
  const url=exactHttps(value);
  if (!url || url.hostname!==session.host || !mediaHosts.has(url.hostname)) return false;
  if (kind==='playlist') {
    if (url.pathname!==`/hls/${session.stream}.m3u8`) return false;
    if ([...url.searchParams.keys()].sort().join(',')!=='e,st') return false;
    const expiry=url.searchParams.get('e') || '';
    const signature=url.searchParams.get('st') || '';
    return /^\d{10,13}$/.test(expiry) && /^[A-Za-z0-9_-]{16,512}$/.test(signature) && Number(expiry)>Date.now()/1000;
  }
  return !url.search && new RegExp(`^/hls/${session.stream}-[0-9]{1,16}\\.ts$`).test(url.pathname);
}

export function streamcenterResource(url: string, session: MediaSession, kind: ResourceKind): ProviderResource | null {
  if (!validStreamcenterResourceUrl(url,session,kind)) return null;
  return {
    kind,identity:url,
    async read({signal,range}) {
      const response=await session.fetcher(url,{cache:'no-store',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),
        headers:{...headers,Referer:session.referer,...(range?{Range:range}:{})}});
      return sanitizedRead(response);
    },
    resolve(reference,expected) {
      try { return streamcenterResource(new URL(reference,url).href,session,expected); } catch { return null; }
    },
  };
}

export function streamcenterProvider(fetcher: typeof fetch = fetch): PlaybackProvider<StreamcenterLocator> {
  return {
    provider:'streamcenter',
    async open(locator,signal): Promise<ProviderPlayback> {
      const publicUrl=`https://streamcenter.st/api/stream-link/iframe/event-espn-league-football-college-football-${locator.eventId}/${locator.linkId}`;
      if (!sourcePath.test(new URL(publicUrl).pathname)) throw new Error('Unsupported Streamcenter link');
      const active=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
      const source=await fetcher(publicUrl,{cache:'no-store',redirect:'manual',signal:active,headers:{Accept:'text/html'}});
      const location=source.headers.get('location');
      await source.body?.cancel();
      const player=location && exactHttps(new URL(location,publicUrl).href);
      if (source.status!==302 || !player || player.hostname!=='streame.center' || !playerPath.test(player.pathname) || player.search) {
        throw new Error('Streamcenter link did not publish a supported player');
      }
      const playerResponse=await fetcher(player.href,{cache:'no-store',redirect:'manual',signal:active,headers:{Accept:'text/html'}});
      const playerHtml=await boundedText(playerResponse);
      const published=parseStreamcenterPlayer(playerHtml);
      if (!published) throw new Error('Streamcenter player did not publish HLS');
      const {stream,url:hls}=published;
      const hlsResponse=await fetcher(hls,{cache:'no-store',redirect:'manual',signal:active,
        headers:{Accept:'text/html',Referer:player.href}});
      const hlsHtml=await boundedText(hlsResponse);
      const literal=/\bconst\s+streamUrl\s*=\s*("(?:[^"\\]|\\.)*")/.exec(hlsHtml)?.[1];
      let manifest: string;
      try { manifest=JSON.parse(literal || 'null') as string; } catch { throw new Error('Streamcenter HLS source changed'); }
      const address=exactHttps(manifest);
      if (!address) throw new Error('Streamcenter HLS source changed');
      const mediaSession={stream,host:address.hostname,referer:hls,fetcher};
      const root=streamcenterResource(manifest,mediaSession,'playlist');
      if (!root) throw new Error('Streamcenter HLS source is unsupported');
      return {root,close() {}};
    },
  };
}
