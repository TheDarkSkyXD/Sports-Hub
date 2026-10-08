import { z } from 'zod';
import type { MissingPlayerReason, Observation, ResolvedPlayer } from '../shared.ts';
import type { ListingResult } from '../domain/ports.ts';
import { validEventPagePair } from '../../playback/providers/event-page-policy.ts';
import {playerId} from './player-id.ts';

const Stream=z.object({id:z.string(),manifest_url:z.string().url(),format:z.string()});
const Event=z.object({event_key:z.string(),title:z.string().min(1),start:z.string(),kickoffMs:z.number().int(),
  category:z.string(),teams:z.object({home:z.object({name:z.string().min(1)}),away:z.object({name:z.string().min(1)})}).nullish(),
  streams:z.array(Stream)});
const Catalog=z.object({scraped_at:z.string(),days:z.array(z.object({date:z.string(),events:z.array(Event)}))});
type BiteEvent=z.infer<typeof Event>;

function eventUrl(key:string):string|null {
  return /^fg-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)?`https://sportsbite.org/event/${key}`:null;
}

function league(event:BiteEvent):Observation['league'] {
  if(event.category!=='motor-sports')return null;
  if(/^(?:F1|Formula 1|Singapore Grand Prix)\b/i.test(event.title))return 'f1';
  if(/MotoGP/i.test(event.title))return 'motogp';
  if(/^NASCAR\b/i.test(event.title))return /\bCup\b/i.test(event.title)?'nascar-cup':
    /\bTruck\b/i.test(event.title)?'nascar-truck':'motorsport';
  if(/(?:Supercars|Super Formula|ELMS|Moto2|Moto3)/i.test(event.title))return 'motorsport';
  return null;
}

export function parseSportsbite(body:string,now:number):ListingResult {
  let input:unknown;
  try {input=JSON.parse(body);}catch{return {outcome:'parser-changed',observations:[]};}
  const parsed=Catalog.safeParse(input);
  if(!parsed.success)return {outcome:'parser-changed',observations:[]};
  const scrapedAt=Date.parse(parsed.data.scraped_at);
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.data.scraped_at)||
    !Number.isFinite(scrapedAt)||scrapedAt>now+60_000||now-scrapedAt>=30*60_000)
    return {outcome:'parser-changed',observations:[]};
  const seen=new Map<string,string>(),observations:Observation[]=[];
  for(const day of parsed.data.days)for(const event of day.events){
    if(event.kickoffMs<Date.UTC(2000,0,1)||event.kickoffMs>now+7*86400000)continue;
    const url=eventUrl(event.event_key);
    if(!url||Date.parse(event.start)!==event.kickoffMs)return {outcome:'parser-changed',observations:[]};
    const teams:Observation['teams']=event.teams?[event.teams.home.name,event.teams.away.name]:null;
    const race=league(event);
    if(!teams&&!race)continue;
    const key=JSON.stringify([event.title,event.kickoffMs,teams]);
    if(seen.has(event.event_key)&&seen.get(event.event_key)!==key)return {outcome:'parser-changed',observations:[]};
    if(seen.has(event.event_key))continue;
    seen.set(event.event_key,key);
    observations.push({id:`sportsbite:${event.event_key}`,sourceId:'sportsbite',url,title:event.title,
      teams,league:race,kickoff:event.kickoffMs,rawTime:event.start,observedAt:now,parserVersion:1});
  }
  return {outcome:observations.length?'parsed':'empty',observations};
}

export function selectSportsbiteEvent(body:string,key:string):string {
  const parsed=Catalog.safeParse(JSON.parse(body));
  if(!parsed.success)throw new Error('parser-changed');
  const matches=parsed.data.days.flatMap(day=>day.events).filter(event=>event.event_key===key);
  if(matches.length!==1)throw new Error('parser-changed');
  return JSON.stringify(matches[0]);
}

export function sportsbitePlayers(gameId:string,observation:Observation,body:string):ResolvedPlayer[] {
  const parsed=Event.safeParse(JSON.parse(body));
  if(!parsed.success)throw new Error('parser-changed');
  const event=parsed.data;
  const teams=event.teams?[event.teams.home.name,event.teams.away.name]:null;
  if(eventUrl(event.event_key)!==observation.url||observation.title!==event.title||
    observation.kickoff!==event.kickoffMs||observation.teams?.join('|')!==(teams?.join('|')??undefined))return [];
  const players=new Map<string,ResolvedPlayer>();
  for(const stream of event.streams){
    if(stream.format!=='iframe'||!/^fg-[a-z0-9-]+$/.test(stream.id)||
      !validEventPagePair(observation.url,stream.manifest_url))continue;
    players.set(stream.manifest_url,{id:playerId('event-page',[gameId,'sportsbite',event.event_key,stream.id,stream.manifest_url]),
      label:`SportsBite · ${players.size+1}`,
      locator:{provider:'event-page',gameId,eventUrl:observation.url,serverUrl:stream.manifest_url}});
  }
  return [...players.values()];
}

export function sportsbiteMissingReason(observation:Observation,body:string):MissingPlayerReason {
  let input:unknown;
  try{input=JSON.parse(body);}catch{return 'parser-changed';}
  const parsed=Event.safeParse(input);
  if(!parsed.success)return 'parser-changed';
  const event=parsed.data;
  if(eventUrl(event.event_key)!==observation.url||event.title!==observation.title||
    event.kickoffMs!==observation.kickoff)return 'conflicting-game';
  if(event.streams.length)return 'unsupported-player';
  return observation.kickoff!==null&&observation.kickoff>observation.observedAt?'not-yet-published':'no-published-player';
}
