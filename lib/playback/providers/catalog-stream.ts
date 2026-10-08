import { z } from 'zod';
import type { CandidateLocator } from '../../football/shared.ts';
import type { PlaybackProvider, ProviderPlayback, ProviderResource } from '../provider.ts';
import { boundedText } from '../provider.ts';
import { get, observedPublicPage, publicHttpsRequest, resource, type Requester } from './public-page.ts';
import { streamApiUrl, streamedEventUrl, validLiveRelay, validStreamReference, validStreamTarget } from './catalog-stream-policy.ts';

type Locator=Extract<CandidateLocator,{provider:'catalog-stream'}>;
const Ref=z.object({source:z.string(),id:z.string()});
const Event=z.object({id:z.string(),title:z.string(),date:z.number().int(),
  teams:z.object({home:z.object({name:z.string()}),away:z.object({name:z.string()})}).nullish(),sources:z.array(Ref)});
const Stream=z.object({id:z.string(),streamNo:z.number().int().positive(),embedUrl:z.string().url(),source:z.string().optional(),relayUrl:z.string().url().optional()});
type Observe=(destination:URL,signal:AbortSignal,purpose:'playback'|'probe')=>Promise<ProviderPlayback|null>;

export function durableCatalogStream(locator:Locator):boolean {
  return validStreamReference(locator.sourceName,locator.sourceId)&&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(locator.eventId)&&
    locator.eventUrl===streamedEventUrl(locator.source,locator.eventId)&&locator.kickoff>=Date.UTC(2000,0,1)&&
    locator.kickoff<Date.UTC(2100,0,1)&&locator.streamNo<=100;
}

export function catalogStreamProvider(requester:Requester=(url,signal,headers,timeoutMs)=>
  publicHttpsRequest(url,signal,headers,undefined,timeoutMs),observe:Observe=observedPublicPage):PlaybackProvider<Locator> {
  async function json(url:string,signal:AbortSignal):Promise<unknown>{
    const result=await get(url,signal,requester);
    if(result.url.href!==url||!/application\/json/i.test(result.response.headers.get('content-type')||'')){
      await result.response.body?.cancel();throw new Error('Catalog stream response changed');
    }
    return JSON.parse(await boundedText(result.response,2*1024*1024));
  }
  return {provider:'catalog-stream',async open(locator,signal,purpose='playback'){
    if(!durableCatalogStream(locator))throw new Error('Unsupported catalog stream');
    const catalogUrl=locator.source==='streamed'?'https://streamed.st/api/matches/all':'https://api.kultsport.com/api/matches/all';
    const catalog=z.array(Event).safeParse(await json(catalogUrl,signal));
    if(!catalog.success)throw new Error('Catalog stream changed');
    const matches=catalog.data.filter(event=>event.id===locator.eventId);
    if(matches.length!==1)throw new Error('Catalog stream event changed');
    const event=matches[0],teams=event.teams?[event.teams.home.name,event.teams.away.name]:null;
    if(event.title!==locator.title||event.date!==locator.kickoff||
      (teams?.join('|')??null)!==(locator.teams?.join('|')??null)||
      !event.sources.some(ref=>ref.source===locator.sourceName&&ref.id===locator.sourceId))
      throw new Error('Catalog stream event changed');
    const streamUrl=streamApiUrl(locator.source,locator.sourceName,locator.sourceId);
    const parsed=z.array(Stream).safeParse(await json(streamUrl,signal));
    if(!parsed.success)throw new Error('Catalog stream players changed');
    const selected=parsed.data.filter(stream=>stream.id===locator.sourceId&&stream.streamNo===locator.streamNo&&
      (locator.source!=='streamed'||stream.source===locator.sourceName)&&
      validStreamTarget(locator.source,locator.sourceName,locator.sourceId,stream.streamNo,stream.embedUrl));
    if(selected.length!==1)throw new Error('Catalog stream selection changed');
    signal.throwIfAborted();
    const destination=new URL(selected[0].embedUrl);
    if(destination.pathname.endsWith('.m3u8')){
      let active=resource(destination,new URL(catalogUrl),'playlist',requester);
      const relay=selected[0].relayUrl;
      const root:ProviderResource={kind:'playlist',identity:destination.href,
        async read(input){
          try{return await active.read(input);}catch(error){
            if(input.signal.aborted||!relay||!validLiveRelay(relay,destination.href))throw error;
            active=resource(new URL(relay),new URL(catalogUrl),'playlist',requester);
            return active.read(input);
          }
        },
        resolve(reference,expected){return active.resolve(reference,expected);},
      };
      return {root,close(){}};
    }
    const playback=await observe(destination,signal,purpose);
    if(!playback)throw new Error('Catalog stream did not publish supported media');
    return playback;
  }};
}
