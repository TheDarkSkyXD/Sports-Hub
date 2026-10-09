import type { CandidateLocator } from '../../football/shared.ts';
import {scopedFetch,timedFetch} from '../probe-capacity.ts';
import { boundedText, type PlaybackProvider, type ProviderPlayback } from '../provider.ts';
import { edgestreamResource, publishedManifest } from './edgestream.ts';

type StreameastLocator=Extract<CandidateLocator,{provider:'streameast'}>;

export function parseStreameastPlayer(html:string):{stream:string;url:string}|null {
  const matches=[...html.matchAll(/<iframe\b[^>]*\bsrc=["']((?:https:)?\/\/streame\.center\/stream-east\/hls\.php\?stream=[A-Za-z0-9]{1,40})["'][^>]*>/gi)];
  if(matches.length!==1)return null;
  const url=new URL(matches[0][1], 'https://streame.center');
  if(url.origin!=='https://streame.center'||url.pathname!=='/stream-east/hls.php'||[...url.searchParams.keys()].join(',')!=='stream')return null;
  const stream=url.searchParams.get('stream')||'';
  return /^[A-Za-z0-9]{1,40}$/.test(stream)?{stream,url:url.href}:null;
}

export function streameastProvider(fetcher:typeof fetch=scopedFetch):PlaybackProvider<StreameastLocator> {
  return {provider:'streameast',async open(locator,signal):Promise<ProviderPlayback> {
    const player=`https://streame.center/stream-east/ch${locator.channelId}.php`;
    const playerResponse=await timedFetch(fetcher,player,{cache:'no-store',redirect:'manual',signal,headers:{Accept:'text/html'}},10000);
    const playerHtml=await boundedText(playerResponse);
    const published=parseStreameastPlayer(playerHtml);
    if(!published)throw new Error('StreamEast player did not publish supported HLS');
    const hlsResponse=await timedFetch(fetcher,published.url,{cache:'no-store',redirect:'manual',signal,
      headers:{Accept:'text/html',Referer:player}},10000);
    const hlsHtml=await boundedText(hlsResponse);
    const manifest=publishedManifest(hlsHtml);
    if(!manifest)throw new Error('StreamEast HLS source changed');
    const address=new URL(manifest);
    const root=edgestreamResource(manifest,{stream:published.stream,host:address.hostname,referer:published.url,fetcher},'playlist');
    if(!root)throw new Error('StreamEast HLS source is unsupported');
    return {root,close(){}};
  }};
}
