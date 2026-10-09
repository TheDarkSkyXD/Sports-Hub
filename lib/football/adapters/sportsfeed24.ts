import { z } from 'zod';
import type { MissingPlayerReason, Observation, ResolvedPlayer } from '../shared.ts';
import type { ListingResult } from '../domain/ports.ts';
import { validEventPagePair } from '../../playback/providers/event-page-policy.ts';
import {playerId} from './player-id.ts';

const Link=z.object({websiteLink:z.string(),streamer:z.string().optional()});
const Game=z.object({teamA:z.string().min(1),teamB:z.string().min(1),matchDate:z.string(),sourceLink:z.string().url(),
  streamerLinks:z.array(Link).optional(),player2:z.string().optional(),websiteLink:z.string().optional()});
const Category=z.object({categoryName:z.string(),subCategories:z.array(z.object({subCategoryName:z.string(),games:z.array(Game)}))});
const Detail=z.object({game:Game});

export function parseSportsfeed24Category(body:string):z.infer<typeof Category> {
  let input:unknown;
  try{input=JSON.parse(body);}catch{throw new Error('parser-changed');}
  const parsed=Category.safeParse(input);
  if(!parsed.success)throw new Error('parser-changed');
  return parsed.data;
}

function eventUrl(value:string):boolean {
  try {
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&!url.search&&
      ['totalsportek1.is','links.totalsportek1.is'].includes(url.hostname)&&
      /^\/(?:game\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/\d{1,10}\/$/.test(url.pathname)&&value===url.href;
  } catch { return false; }
}
export function sportsfeed24EventUrl(teamA:string,teamB:string):string {
  return `https://sportsfeed24.st/fixture/${encodeURIComponent(teamA)}-vs-${encodeURIComponent(teamB)}`;
}

function leagueFor(category:string,teamA:string):Observation['league'] {
  const label=category.toLowerCase();
  if(label==='nfl')return 'nfl';
  if(label==='nba')return 'nba';
  if(label==='wnba')return 'wnba';
  if(label==='nhl')return 'nhl';
  if(label==='mlb')return 'mlb';
  if(label==='f1'&&/^F1\b/i.test(teamA))return 'f1';
  if(label==='f1'&&/^NASCAR\b/i.test(teamA))return /\bCup\b/i.test(teamA)?'nascar-cup':
    /\bTruck\b/i.test(teamA)?'nascar-truck':'motorsport';
  if(label==='motogp'&&/MotoGP/i.test(teamA))return 'motogp';
  return null;
}

function kickoff(value:string):number|null {
  if(!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))return null;
  const at=Date.parse(value);
  return Number.isFinite(at)&&at>=Date.UTC(2000,0,1)&&at<Date.UTC(2100,0,1)?at:null;
}

export function parseSportsfeed24(body:string,now:number):ListingResult {
  let input:unknown;
  try {input=JSON.parse(body);}catch{return {outcome:'parser-changed',observations:[]};}
  const envelope=z.object({categories:z.array(Category),complete:z.boolean()}).safeParse(input);
  const categories=z.array(Category).safeParse(envelope.success?envelope.data.categories:input);
  if(!categories.success)return {outcome:'parser-changed',observations:[]};
  const rows=new Map<string,Observation>();
  for(const category of categories.data)for(const group of category.subCategories)for(const game of group.games){
    const at=kickoff(game.matchDate);
    const league=leagueFor(group.subCategoryName,game.teamA);
    if(!at||at>now+7*86400000||!eventUrl(game.sourceLink)||
      /^(?:live|network|redzone)$/i.test(game.teamB)&&!['f1','nascar-cup','nascar-truck','motogp','motorsport'].includes(league||''))continue;
    const id=`sportsfeed24:${new URL(game.sourceLink).pathname.match(/\/(\d+)\/$/)?.[1]}`;
    const observation:Observation={id,sourceId:'sportsfeed24',url:sportsfeed24EventUrl(game.teamA,game.teamB),
      title:`${game.teamA} vs ${game.teamB}`,teams:league&&['f1','nascar-cup','nascar-truck','motogp','motorsport'].includes(league)?null:[game.teamA,game.teamB],
      league,kickoff:at,rawTime:game.matchDate,observedAt:now,parserVersion:1};
    const previous=rows.get(id);
    if(previous&&(previous.title!==observation.title||previous.url!==observation.url||
      previous.kickoff===null||Math.abs(previous.kickoff-at)>60*60_000))return {outcome:'parser-changed',observations:[]};
    if(!previous||group.subCategoryName.toLowerCase()===category.categoryName.toLowerCase())rows.set(id,observation);
  }
  const observations=[...rows.values()];
  return {outcome:observations.length?'parsed':'empty',observations};
}

export function sportsfeed24Players(gameId:string,observation:Observation,body:string):ResolvedPlayer[] {
  let input:unknown;
  try {input=JSON.parse(body);}catch{throw new Error('parser-changed');}
  const parsed=Detail.safeParse(input);
  if(!parsed.success)throw new Error('parser-changed');
  const event=parsed.data.game;
  if(!eventUrl(event.sourceLink)||observation.id!==`sportsfeed24:${new URL(event.sourceLink).pathname.match(/\/(\d+)\/$/)?.[1]}`||
    observation.url!==sportsfeed24EventUrl(event.teamA,event.teamB)||observation.kickoff===null||
    kickoff(event.matchDate)===null||Math.abs(kickoff(event.matchDate)!-observation.kickoff)>60*60_000||
    `${event.teamA} vs ${event.teamB}`!==observation.title)return [];
  const players=new Map<string,ResolvedPlayer>();
  const links=[...(event.streamerLinks||[]).map(row=>row.websiteLink),event.player2,event.websiteLink].filter((row):row is string=>!!row);
  for(const url of links){
    if(!validEventPagePair(observation.url,url))continue;
    players.set(url,{id:playerId('event-page',[gameId,'sportsfeed24',observation.url,url]),label:`SportsFeed24 · Player ${players.size+1}`,
      locator:{provider:'event-page',gameId,eventUrl:observation.url,serverUrl:url}});
  }
  return [...players.values()];
}

export function sportsfeed24MissingReason(observation:Observation,body:string):MissingPlayerReason {
  let input:unknown;
  try{input=JSON.parse(body);}catch{return 'parser-changed';}
  const parsed=Detail.safeParse(input);
  if(!parsed.success)return 'parser-changed';
  const game=parsed.data.game;
  if(!eventUrl(game.sourceLink)||observation.id!==`sportsfeed24:${new URL(game.sourceLink).pathname.match(/\/(\d+)\/$/)?.[1]}`||
    observation.url!==sportsfeed24EventUrl(game.teamA,game.teamB)||`${game.teamA} vs ${game.teamB}`!==observation.title)
    return 'conflicting-game';
  if((game.streamerLinks?.length||0)>0||game.player2||game.websiteLink)return 'unsupported-player';
  return observation.kickoff!==null&&observation.kickoff>observation.observedAt?'not-yet-published':'no-published-player';
}
