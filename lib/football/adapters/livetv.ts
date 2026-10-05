import {load} from 'cheerio';
import {z} from 'zod';
import type {ListingSource} from '../domain/ports.ts';
import type {Observation, ResolvedPlayer} from '../shared.ts';
import {validEventPagePair} from '../../playback/providers/event-page-policy.ts';

const eventPath=/^\/enx\/eventinfo\/([1-9]\d{0,19})_[a-z0-9_]*\/$/;
const isoTime=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BroadcastEvent=z.object({
  '@type':z.literal('BroadcastEvent'),url:z.string().min(1),name:z.string().min(1),startDate:z.string().regex(isoTime),
  broadcastOfEvent:z.object({'@type':z.literal('SportsEvent'),name:z.string().min(1),
    competitor:z.tuple([z.object({name:z.string().min(1)}),z.object({name:z.string().min(1)})])}),
});

function eventId(value:string):string|null {
  try {
    const url=new URL(value);
    if(value!==url.href||url.protocol!=='https:'||url.hostname!=='livetv.sx'||url.username||url.password||url.port||url.search||url.hash)return null;
    return eventPath.exec(url.pathname)?.[1]||null;
  }catch{return null;}
}

function teamIdentity(names:readonly string[]):string {
  return names.map(name=>name.toLowerCase().replace(/\s+/g,' ').trim()).sort().join('|');
}

function titleTeams(value:string):[string,string]|null {
  const parts=value.split(/\s*[-–—]\s*/).map(part=>part.replace(/\s+/g,' ').trim());
  return parts.length===2&&parts.every(Boolean)?[parts[0],parts[1]]:null;
}

export function parseLiveTvListings(source:ListingSource,html:string,now:number):{observations:Observation[];outcome:'parsed'|'empty'|'parser-changed'} {
  const $=load(html);
  const observations=new Map<string,Observation>();
  let conflicting=false;
  $('a[href]').each((_index,node)=>{
    const anchor=$(node);
    const row=anchor.closest('tr');
    const marker=row.find('img[alt]').first().attr('alt')||'';
    const league=marker==='USA. NFL'?'nfl':marker==='NCAA'?'ncaaf':null;
    if(!league)return;
    const href=anchor.attr('href')||'';
    const match=eventPath.exec(href);
    const teams=titleTeams(anchor.text());
    if(!match||!teams)return;
    const url=new URL(href,source.url).href;
    const id=`${source.id}:${match[1]}`;
    const prior=observations.get(id);
    if(prior){if(prior.url!==url||teamIdentity(prior.teams||[])!==teamIdentity(teams))conflicting=true;return;}
    observations.set(id,{id,sourceId:source.id,url,title:teams.join(' vs '),teams,
      league,kickoff:null,rawTime:'',observedAt:now,parserVersion:2});
  });
  if(conflicting)return {observations:[],outcome:'parser-changed'};
  const rows=[...observations.values()];
  return {observations:rows,outcome:rows.length?'parsed':/no (?:upcoming )?(?:matches|broadcasts|events)/i.test($('body').text())?'empty':'parser-changed'};
}

function detailEvent(observation:Observation,html:string):{kickoff:number;rawTime:string}|null {
  const id=eventId(observation.url);
  if(!id||!observation.teams)return null;
  const $=load(html);
  const canonicalValue=$('link[rel="canonical"]').first().attr('href')||'';
  const ogValue=$('meta[property="og:url"]').first().attr('content')||'';
  let canonical:string,og:string;
  try {canonical=new URL(canonicalValue,observation.url).href;og=new URL(ogValue,observation.url).href;}catch{return null;}
  if(!canonicalValue||!ogValue||eventId(canonical)!==id||og!==canonical)return null;
  const events=$('script[type="application/ld+json"]').toArray().flatMap(node=>{
    try {const parsed=BroadcastEvent.safeParse(JSON.parse($(node).text()));return parsed.success?[parsed.data]:[];}catch{return [];}
  });
  const matching=events.filter(event=>{
    let eventUrl:string;
    try {eventUrl=new URL(event.url,observation.url).href;}catch{return false;}
    const named=titleTeams(event.name),nested=titleTeams(event.broadcastOfEvent.name);
    return eventUrl===canonical&&named&&nested&&teamIdentity(named)===teamIdentity(observation.teams||[])&&
      teamIdentity(nested)===teamIdentity(observation.teams||[])&&
      teamIdentity(event.broadcastOfEvent.competitor.map(team=>team.name))===teamIdentity(observation.teams||[]);
  });
  if(matching.length!==1)return null;
  const kickoff=Date.parse(matching[0].startDate);
  return Number.isFinite(kickoff)?{kickoff,rawTime:matching[0].startDate}:null;
}

export function enrichLiveTvObservation(observation:Observation,html:string):Observation {
  const detail=detailEvent(observation,html);
  return detail?{...observation,kickoff:detail.kickoff,rawTime:detail.rawTime}:observation;
}

export function liveTvPlayers(gameId:string,observation:Observation,html:string):ResolvedPlayer[] {
  const detail=detailEvent(observation,html);
  if(!detail||detail.kickoff!==observation.kickoff)return [];
  const $=load(html);
  const players=new Map<string,ResolvedPlayer>();
  $('a[href]').each((_index,node)=>{
    const href=$(node).attr('href')||'';
    let url:string;
    try {url=new URL(href,observation.url).href;}catch{return;}
    if(!validEventPagePair(observation.url,url)||players.has(url))return;
    const id=new URL(url).searchParams.get('c');
    if(!id)return;
    players.set(url,{id:`livetv:${eventId(observation.url)}:${id}`,label:`LiveTV · Server ${players.size+1}`,
      locator:{provider:'event-page',gameId,eventUrl:observation.url,serverUrl:url}});
  });
  return [...players.values()];
}
