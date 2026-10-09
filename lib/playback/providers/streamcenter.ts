import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText, type PlaybackProvider, type ProviderPlayback, type ProviderResource, type ResourceKind } from '../provider.ts';
import { parseStreamcenterPlayer } from './streamcenter-player.ts';
import { edgestreamResource, publishedManifest, validEdgestreamResourceUrl, type MediaSession } from './edgestream.ts';
import {scopedFetch,timedFetch} from '../probe-capacity.ts';

type StreamcenterLocator = Extract<CandidateLocator,{provider:'streamcenter'}>;
const sourcePath=/^\/api\/stream-link\/iframe\/event-espn-league-(?:football-college-football|basketball-(?:nba|wnba)|hockey-nhl|baseball-mlb)-(\d{5,12})\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const playerPath=/^\/embed\/ch\d{1,4}\.php$/;

function exactHttps(value: string): URL | null {
  try {
    const address=new URL(value);
    const authority=/^https:\/\/([^/?#]+)/.exec(value)?.[1];
    return authority===address.hostname && !address.port && !address.username && !address.password && !address.hash ? address : null;
  } catch { return null; }
}

export function validStreamcenterResourceUrl(value: string, session: Pick<MediaSession,'stream'|'host'>, kind: ResourceKind): boolean {
  return validEdgestreamResourceUrl(value,session,kind);
}

export function streamcenterResource(url: string, session: MediaSession, kind: ResourceKind): ProviderResource | null {
  return edgestreamResource(url,session,kind);
}

export function streamcenterProvider(fetcher: typeof fetch = scopedFetch): PlaybackProvider<StreamcenterLocator> {
  return {
    provider:'streamcenter',
    async open(locator,signal): Promise<ProviderPlayback> {
      const publicUrl=`https://streamcenter.st/api/stream-link/iframe/event-espn-league-${locator.league==='nba'?'basketball-nba':locator.league==='wnba'?'basketball-wnba':locator.league==='nhl'?'hockey-nhl':locator.league==='mlb'?'baseball-mlb':'football-college-football'}-${locator.eventId}/${locator.linkId}`;
      if (!sourcePath.test(new URL(publicUrl).pathname)) throw new Error('Unsupported Streamcenter link');
      const source=await timedFetch(fetcher,publicUrl,{cache:'no-store',redirect:'manual',signal,headers:{Accept:'text/html'}},10000);
      const location=source.headers.get('location');
      await source.body?.cancel();
      const player=location && exactHttps(new URL(location,publicUrl).href);
      if (source.status!==302 || !player || player.hostname!=='streame.center' || !playerPath.test(player.pathname) || player.search) {
        throw new Error('Streamcenter link did not publish a supported player');
      }
      const playerResponse=await timedFetch(fetcher,player.href,{cache:'no-store',redirect:'manual',signal,headers:{Accept:'text/html'}},10000);
      const playerHtml=await boundedText(playerResponse);
      const published=parseStreamcenterPlayer(playerHtml);
      if (!published) throw new Error('Streamcenter player did not publish HLS');
      const {stream,url:hls}=published;
      const hlsResponse=await timedFetch(fetcher,hls,{cache:'no-store',redirect:'manual',signal,
        headers:{Accept:'text/html',Referer:player.href}},10000);
      const hlsHtml=await boundedText(hlsResponse);
      const manifest=publishedManifest(hlsHtml);
      if (!manifest) throw new Error('Streamcenter HLS source changed');
      const address=exactHttps(manifest);
      if (!address) throw new Error('Streamcenter HLS source changed');
      const mediaSession={stream,host:address.hostname,referer:hls,fetcher};
      const root=streamcenterResource(manifest,mediaSession,'playlist');
      if (!root) throw new Error('Streamcenter HLS source is unsupported');
      return {root,close() {}};
    },
  };
}
