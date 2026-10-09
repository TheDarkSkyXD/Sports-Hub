import { load } from 'cheerio';
import type { CandidateLocator } from '../../football/shared.ts';
import {scopedFetch,timedFetch} from '../probe-capacity.ts';
import { boundedText, sanitizedRead, type PlaybackProvider, type ProviderResource, type ResourceKind } from '../provider.ts';

type WikisportLocator=Extract<CandidateLocator,{provider:'wikisport'}>;
type MediaSession={stream:string;host:string;referer:string;fetcher:typeof fetch};
const mediaHosts=new Set(['instreams.live','instreams.pro']);

function exactHttps(value:string):URL|null {
  try {
    const url=new URL(value);
    return /^https:\/\/([^/?#]+)/.exec(value)?.[1]===url.hostname && !url.port && !url.username && !url.password && !url.hash ? url:null;
  } catch{return null;}
}

function publishedPlayer(html:string):{stream:string;url:string}|null {
  const $=load(html);
  const players=$('iframe[src]').toArray().flatMap(node=>{
    const url=exactHttps($(node).attr('src') || '');
    if(!url || url.origin!=='https://in-stream.click' || url.pathname!=='/fslive.php' ||
      [...url.searchParams.keys()].join(',')!=='stream')return [];
    const stream=url.searchParams.get('stream') || '';
    return /^[A-Za-z0-9_-]{1,40}$/.test(stream)?[{stream,url:url.href}]:[];
  });
  return players.length===1?players[0]:null;
}

function publishedManifests(html:string,stream:string):string[] {
  const id=/\bconst\s+streamId\s*=\s*("(?:[^"\\]|\\.)*")\s*;/.exec(html)?.[1];
  const array=/\bconst\s+streamUrls\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html)?.[1];
  try {
    if(JSON.parse(id || 'null')!==stream)return [];
    const values:unknown=JSON.parse(array || 'null');
    return Array.isArray(values) && values.length<=8 && values.every((value):value is string=>typeof value==='string') ? values:[];
  } catch{return [];}
}

function mediaResource(value:string,session:MediaSession,kind:ResourceKind):ProviderResource|null {
  const url=exactHttps(value);
  if(!url || !mediaHosts.has(url.hostname) || url.hostname!==session.host ||
    [...url.searchParams.keys()].sort().join(',')!=='e,st')return null;
  const expiry=url.searchParams.get('e') || '';
  const signature=url.searchParams.get('st') || '';
  if(!/^\d{10,13}$/.test(expiry) || Number(expiry)<=Date.now()/1000 || !/^[A-Za-z0-9_-]{16,512}$/.test(signature))return null;
  if(kind==='playlist' ? url.pathname!==`/live/${session.stream}/index.m3u8` :
    !new RegExp(`^/live/${session.stream}/[0-9]{1,16}\\.ts$`).test(url.pathname))return null;
  return {kind,identity:url.href,
    async read({signal,range}) {
      const response=await timedFetch(session.fetcher,url.href,{cache:'no-store',redirect:'manual',signal,
        headers:{Origin:'https://in-stream.click',Referer:session.referer,...(range?{Range:range}:{})}},10000);
      return sanitizedRead(response);
    },
    resolve(reference,expected) {
      try{return mediaResource(new URL(reference,url).href,session,expected);}catch{return null;}
    },
  };
}

export function wikisportProvider(fetcher:typeof fetch=scopedFetch):PlaybackProvider<WikisportLocator> {
  return {provider:'wikisport',async open(locator,signal) {
    const wrapper=`https://wikisport.info/${locator.section}/${locator.playerId}.php`;
    const response=await timedFetch(fetcher,wrapper,{cache:'no-store',redirect:'manual',signal,headers:{Accept:'text/html'}},15000);
    const player=publishedPlayer(await boundedText(response));
    if(!player)throw new Error('Wikisport player did not publish supported HLS');
    const bootstrap=await timedFetch(fetcher,player.url,{cache:'no-store',redirect:'manual',signal,
      headers:{Accept:'text/html',Referer:wrapper}},15000);
    const manifests=publishedManifests(await boundedText(bootstrap),player.stream);
    for(const manifest of manifests) {
      const address=exactHttps(manifest);
      if(!address)continue;
      const root=mediaResource(manifest,{stream:player.stream,host:address.hostname,referer:player.url,fetcher},'playlist');
      if(!root)continue;
      try {
        const response=await root.read({signal});
        await response.body?.cancel();
        if(response.status===200)return {root,close(){}};
      } catch {signal.throwIfAborted();}
    }
    throw new Error('Wikisport HLS source changed');
  }};
}
