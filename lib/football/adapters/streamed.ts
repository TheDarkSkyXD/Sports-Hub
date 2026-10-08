import { z } from 'zod';
import type { MissingPlayerReason, Observation, ResolvedPlayer } from '../shared.ts';
import type { ListingResult } from '../domain/ports.ts';
import { streamApiUrl, streamedEventUrl, validStreamTarget } from '../../playback/providers/catalog-stream-policy.ts';
import {playerId} from './player-id.ts';

const Ref=z.object({source:z.string().min(1).max(40),id:z.string().min(1).max(160)});
const Event=z.object({id:z.string().min(1).max(160),title:z.string().min(1),category:z.string(),date:z.number().int(),
  teams:z.object({home:z.object({name:z.string().min(1)}),away:z.object({name:z.string().min(1)})}).nullish(),
  sources:z.array(Ref)});
const Stream=z.object({id:z.string(),streamNo:z.number().int().positive(),embedUrl:z.string().url(),source:z.string().optional()});
type CatalogEvent=z.infer<typeof Event>;
type Variant='streamed'|'livesportpro';

function validId(id:string):boolean { return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(id); }
function eventIdentity(event:CatalogEvent,variant:Variant,observation:Observation):boolean {
  const teams=event.teams?[event.teams.home.name,event.teams.away.name]:null;
  return validId(event.id)&&observation.url===streamedEventUrl(variant,event.id)&&
    observation.title===event.title&&observation.kickoff===event.date&&
    observation.teams?.join('|')===(teams?.join('|')??undefined);
}

export function parseStreamedCatalog(sourceId:string,body:string,now:number,variant:Variant):ListingResult {
  let input:unknown;
  try { input=JSON.parse(body); } catch { return {outcome:'parser-changed',observations:[]}; }
  const parsed=z.array(Event).safeParse(input);
  if(!parsed.success)return {outcome:'parser-changed',observations:[]};
  const observations:Observation[]=[];
  const seen=new Map<string,string>();
  for(const event of parsed.data){
    if(event.date<Date.UTC(2000,0,1)||event.date>now+7*86400000)continue;
    if(!validId(event.id))continue;
    const teams:Observation['teams']=event.teams?[event.teams.home.name,event.teams.away.name]:null;
    const key=JSON.stringify([event.title,event.date,teams]);
    if(seen.has(event.id)&&seen.get(event.id)!==key)return {outcome:'parser-changed',observations:[]};
    if(seen.has(event.id))continue;
    seen.set(event.id,key);
    const title=event.title.trim();
    const league=event.category==='motor-sports'&&/^(?:Formula 1|F1)\b/i.test(title)?'f1':
      event.category==='motor-sports'&&/MotoGP/i.test(title)?'motogp':
      event.category==='motor-sports'&&/(?:Supercars|Super Formula|ELMS|Moto2|Moto3)/i.test(title)?'motorsport':null;
    if(!teams&&!league)continue;
    observations.push({id:`${sourceId}:${event.id}`,sourceId,url:streamedEventUrl(variant,event.id),title,
      teams,league,kickoff:event.date,rawTime:new Date(event.date).toISOString(),observedAt:now,parserVersion:1});
  }
  return {outcome:observations.length?'parsed':'empty',observations};
}

export function selectStreamedEvent(body:string,variant:Variant,eventId:string):string {
  const parsed=z.array(Event).safeParse(JSON.parse(body));
  if(!parsed.success)throw new Error('parser-changed');
  const matches=parsed.data.filter(event=>event.id===eventId&&validId(event.id));
  if(matches.length!==1)throw new Error('parser-changed');
  return JSON.stringify(matches[0]);
}

export function streamedMissingReason(observation:Observation,body:string,variant:Variant):MissingPlayerReason {
  let input:unknown;
  try{input=JSON.parse(body);}catch{return 'parser-changed';}
  const parsed=Event.safeParse(input);
  if(!parsed.success)return 'parser-changed';
  if(!eventIdentity(parsed.data,variant,observation))return 'conflicting-game';
  if(parsed.data.sources.length)return 'unsupported-player';
  return observation.kickoff!==null&&observation.kickoff>observation.observedAt?'not-yet-published':'no-published-player';
}

export async function streamedPlayers(gameId:string,observation:Observation,body:string,signal:AbortSignal,
  read:(url:string,signal:AbortSignal)=>Promise<string>,variant:Variant):Promise<ResolvedPlayer[]> {
  const event=Event.safeParse(JSON.parse(body));
  if(!event.success||!eventIdentity(event.data,variant,observation))return [];
  const refs=event.data.sources;
  if(refs.length>24||new Set(refs.map(ref=>`${ref.source}/${ref.id}`)).size!==refs.length)throw new Error('parser-changed');
  const pages=new Map<string,ResolvedPlayer>();
  for(let offset=0;offset<refs.length;offset+=4){
    const batch=refs.slice(offset,offset+4);
    signal.throwIfAborted();
    const controller=new AbortController();
    const onAbort=()=>controller.abort(signal.reason);
    signal.addEventListener('abort',onAbort,{once:true});
    let responses:{ref:z.infer<typeof Ref>;streams:z.infer<typeof Stream>[]}[];
    try{
      const settled=await Promise.allSettled(batch.map(async ref=>{
        try{
          const url=streamApiUrl(variant,ref.source,ref.id);
          const parsed=z.array(Stream).safeParse(JSON.parse(await read(url,controller.signal)));
          if(!parsed.success)throw new Error('parser-changed');
          return {ref,streams:parsed.data};
        }catch(error){controller.abort(error);throw error;}
      }));
      signal.throwIfAborted();
      const failed=settled.find(result=>result.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
      responses=settled.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
    }finally{
      signal.removeEventListener('abort',onAbort);
      controller.abort();
    }
    signal.throwIfAborted();
    for(const {ref,streams} of responses){
      for(const stream of streams){
        if(stream.id!==ref.id||variant==='streamed'&&stream.source!==ref.source)throw new Error('parser-changed');
        if(!validStreamTarget(variant,ref.source,ref.id,stream.streamNo,stream.embedUrl))continue;
        pages.set(`${ref.source}:${ref.id}:${stream.streamNo}`,{id:playerId('catalog-stream',[gameId,variant,event.data.id,ref.source,ref.id,stream.streamNo]),
          label:`${variant==='streamed'?'Streamed':'LiveSportPro'} · ${ref.source} ${stream.streamNo}`,
          locator:{provider:'catalog-stream',gameId,source:variant,eventUrl:observation.url,eventId:event.data.id,sourceName:ref.source,
            sourceId:ref.id,streamNo:stream.streamNo,kickoff:event.data.date,title:event.data.title,
            teams:event.data.teams?[event.data.teams.home.name,event.data.teams.away.name]:null}});
      }
    }
  }
  return [...pages.values()];
}
