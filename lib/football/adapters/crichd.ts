import { load } from 'cheerio';
import type { MissingPlayerReason, Observation, ResolvedPlayer } from '../shared.ts';
import type { ListingResult } from '../domain/ports.ts';
import { validEventPagePair } from '../../playback/providers/event-page-policy.ts';
import {playerId} from './player-id.ts';

function eventUrl(value:string):boolean {
  try {
    const url=new URL(value);
    return value===url.href&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&
      ['crichd.pk','m.crichd.pk'].includes(url.hostname)&&/^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname);
  }catch{return false;}
}

function eventLeague(title:string):Observation['league'] {
  if(/^MotoGP\b/i.test(title))return 'motogp';
  if(/^(?:Formula 1|F1)\b/i.test(title))return 'f1';
  if(/^NASCAR\b/i.test(title))return 'nascar-cup';
  return null;
}

function rowTitle(value:string):{title:string;teams:Observation['teams'];league:Observation['league']}|null {
  const title=value.replace(/\s+/g,' ').trim();
  const pair=title.split(/\s+(?:vs\.?|at)\s+/i);
  const teams:Observation['teams']=pair.length===2&&pair.every(Boolean)?[pair[0],pair[1]]:null;
  const league=eventLeague(title);
  return teams||league?{title,teams,league}:null;
}

export function parseCrichdListings(body:string,now:number):ListingResult {
  const $=load(body);
  if(!$('body').length||!$('.data-countdown[data-start]').length)return {outcome:'parser-changed',observations:[]};
  const observations:Observation[]=[];
  const seen=new Map<string,string>();
  $('a[href*="/event/"]').each((_i,node)=>{
    const anchor=$(node),url=anchor.attr('href')||'';
    if(!eventUrl(url))return;
    const countdown=anchor.find('.data-countdown[data-start]').first();
    const rawTime=countdown.attr('data-start')||'';
    const kickoff=Date.parse(rawTime);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(rawTime)||
      !Number.isFinite(kickoff)||kickoff<Date.UTC(2000,0,1)||kickoff>now+7*86400000)return;
    const names=anchor.find('.flex-col.justify-center').first().children('div').map((_index,row)=>
      $(row).text().replace(/\s+/g,' ').trim()).get();
    const title=names.length===2&&names.every(Boolean)?`${names[0]} vs ${names[1]}`:
      anchor.find('.flex-col.justify-center').first().text().trim().split(/\n/)[0]?.trim()||'';
    const parsed=names.length===2&&names.every(Boolean)&&!/(?:Live|MotoGP|Formula 1|F1)$/.test(names[1])?
      {title,teams:[names[0],names[1]] as [string,string],league:null}:rowTitle(names[0]||title);
    if(!parsed)return;
    const id=`crichd:${new URL(url).pathname.slice('/event/'.length)}`;
    const key=JSON.stringify([title,kickoff,url]);
    if(seen.has(id)&&seen.get(id)!==key){seen.set(id,'conflict');return;}
    if(seen.has(id))return;
    seen.set(id,key);
    observations.push({id,sourceId:'crichd',url,title:parsed.title,teams:parsed.teams,league:parsed.league,
      kickoff,rawTime,observedAt:now,parserVersion:1});
  });
  if([...seen.values()].includes('conflict'))return {outcome:'parser-changed',observations:[]};
  return {outcome:observations.length?'parsed':'empty',observations};
}

function detailIdentity(observation:Observation,$:ReturnType<typeof load>):boolean {
  const countdown=$('.data-countdown[data-start]').first();
  const kickoff=Date.parse(countdown.attr('data-start')||'');
  const heading=$('h1').first().text().replace(/\s+Live Streaming Online - Crichd$/,'').trim();
  const teams=countdown.parent().find('.flex-col.items-center > div').map((_i,node)=>$(node).text().trim()).get();
  return eventUrl(observation.url)&&kickoff===observation.kickoff&&(observation.teams?
    teams.length===2&&teams.join('|')===observation.teams.join('|'):
    heading===observation.title);
}

export function crichdMissingReason(observation:Observation,body:string):MissingPlayerReason {
  const $=load(body);
  if(!$('h1').length||!$('.data-countdown[data-start]').length)return 'parser-changed';
  if(!detailIdentity(observation,$))return 'conflicting-game';
  if($('a[href]').toArray().some(node=>$(node).text().trim()==='Watch'))return 'unsupported-player';
  return observation.kickoff!==null&&observation.kickoff>observation.observedAt?'not-yet-published':'no-published-player';
}

export function crichdPlayers(gameId:string,observation:Observation,body:string):ResolvedPlayer[] {
  const $=load(body);
  if(!detailIdentity(observation,$))return [];
  const players=new Map<string,ResolvedPlayer>();
  $('a[href]').each((_i,node)=>{
    const url=$(node).attr('href')||'';
    if($(node).text().trim()!=='Watch'||!validEventPagePair(observation.url,url))return;
    players.set(url,{id:playerId('event-page',[gameId,'crichd',observation.url,url]),label:`CricHD · Link ${players.size+1}`,
      locator:{provider:'event-page',gameId,eventUrl:observation.url,serverUrl:url}});
  });
  return [...players.values()];
}
