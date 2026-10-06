import type { CandidateLocator } from '../../football/shared.ts';
import type { PlaybackProvider, ProviderPlayback } from '../provider.ts';
import { boundedText } from '../provider.ts';
import { get, observedPublicPage, publicHttpsRequest, type Requester } from './public-page.ts';
import { tvappIdentity, tvappStreams } from './tvapp-catalog.ts';

type TvappLocator = Extract<CandidateLocator,{provider:'tvapp'}>;
const CATALOG='https://api-backups.handleapi.win/matches/sport/american-football';

async function publicJson(url:string,referer:URL,signal:AbortSignal,requester:Requester):Promise<unknown> {
  const result=await get(url,signal,requester,referer);
  if(result.url.href!==url || !/application\/json/i.test(result.response.headers.get('content-type')||'')) {
    await result.response.body?.cancel();
    throw new Error('TVApp catalog response changed');
  }
  return JSON.parse(await boundedText(result.response));
}

type Observe=(destination:URL,signal:AbortSignal,purpose:'playback'|'probe')=>Promise<ProviderPlayback|null>;
export function tvappProvider(requester:Requester=(url,signal,headers,timeoutMs)=>
  publicHttpsRequest(url,signal,headers,undefined,timeoutMs),observe:Observe=observedPublicPage):PlaybackProvider<TvappLocator> {
  return {provider:'tvapp',async open(locator,signal,purpose='playback') {
    const eventUrl=new URL(locator.eventUrl);
    if(eventUrl.origin!=='https://tvapp1.pk'||eventUrl.search||eventUrl.hash||
      !/^\/watch\/[a-zA-Z0-9-]{1,120}$/.test(eventUrl.pathname))throw new Error('Unsupported TVApp watch page');
    const catalog=await publicJson(CATALOG,eventUrl,signal,requester);
    if(!Array.isArray(catalog))throw new Error('TVApp catalog changed');
    const found=catalog.flatMap(value=>{
      const item=tvappIdentity(value);
      if(!item||item.watchUrl!==locator.eventUrl||item.title!==locator.title||
        item.kickoff!==locator.kickoff||item.teams.join('|')!==locator.teams.join('|')||
        !item.sources.some(source=>source.source===locator.source&&source.id===locator.sourceId))return [];
      return [item];
    });
    if(found.length!==1)throw new Error('TVApp matchup changed');
    const rowUrl=`https://api-backups.handleapi.win/streams/${locator.source}/${locator.sourceId}`;
    const rows=await publicJson(rowUrl,eventUrl,signal,requester);
    const streams=tvappStreams(rows,locator.source,locator.sourceId);
    if(!streams)throw new Error('TVApp streams changed');
    const expected=`https://embed.st/embed/${locator.source}/${locator.sourceId}/${locator.streamNo}`;
    const selected=streams.filter(row=>row.streamNo===locator.streamNo&&row.embedUrl===expected);
    if(selected.length!==1)throw new Error('TVApp selected stream changed');
    const playback=await observe(new URL(expected),signal,purpose);
    if(!playback)throw new Error('TVApp selected stream did not publish supported media');
    return playback;
  }};
}
