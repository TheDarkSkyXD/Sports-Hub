import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText, ProviderDeferredError, type PlaybackProvider, type ProviderPlayback, type ProviderResource, type ResourceKind } from '../provider.ts';
import { parseStreamcenterPlayer } from './streamcenter-player.ts';
import { edgestreamResource, publishedManifest, validEdgestreamResourceUrl, type MediaSession } from './edgestream.ts';
import {scopedFetch,timedFetch} from '../probe-capacity.ts';
import {selectedStreamcenterGroup,selectedStreamcenterPlayer,streamcenterIdentity} from './streamcenter-api.ts';
import {observedPublicPage} from './public-page.ts';

type StreamcenterLocator = Extract<CandidateLocator,{provider:'streamcenter'}>;

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
    async open(locator,signal,purpose='playback'): Promise<ProviderPlayback> {
      const identity=streamcenterIdentity(locator);
      const json=async(url:string):Promise<unknown>=>{
        const response=await timedFetch(fetcher,url,{cache:'no-store',redirect:'manual',signal,headers:{Accept:'application/json'}},10000);
        if(response.status===429){
          const retry=response.headers.get('Retry-After')?.trim();
          const delay=retry?(/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()):NaN;
          await response.body?.cancel();
          throw new ProviderDeferredError(Number.isFinite(delay)&&delay>=0?Math.min(120000,Math.max(2000,delay)):30000,'resolution');
        }
        if(!/application\/json/i.test(response.headers.get('content-type')||'')){
          await response.body?.cancel();throw new Error('StreamCenter API response changed');
        }
        return JSON.parse(await boundedText(response,2*1024*1024));
      };
      selectedStreamcenterGroup(await json(identity.catalog),locator);
      const player=selectedStreamcenterPlayer(await json(identity.streams),locator);
      const playerResponse=await timedFetch(fetcher,player.href,{cache:'no-store',redirect:'manual',signal,headers:{Accept:'text/html'}},10000);
      const playerHtml=await boundedText(playerResponse);
      const published=parseStreamcenterPlayer(playerHtml);
      if(!published){const observed=await observedPublicPage(player,signal,purpose);if(observed)return observed;throw new Error('Streamcenter player did not publish HLS');}
      const {stream,url:hls}=published;
      const hlsResponse=await timedFetch(fetcher,hls,{cache:'no-store',redirect:'manual',signal,
        headers:{Accept:'text/html',Referer:player.href}},10000);
      const hlsHtml=await boundedText(hlsResponse);
      const manifest=publishedManifest(hlsHtml);
      if(!manifest){const observed=await observedPublicPage(new URL(hls),signal,purpose);if(observed)return observed;throw new Error('Streamcenter HLS source changed');}
      const address=exactHttps(manifest);
      if (!address) throw new Error('Streamcenter HLS source changed');
      const mediaSession={stream,host:address.hostname,referer:hls,fetcher};
      const root=streamcenterResource(manifest,mediaSession,'playlist');
      if (!root) throw new Error('Streamcenter HLS source is unsupported');
      return {root,player:{url:hls,referer:player.href},close() {}};
    },
  };
}
