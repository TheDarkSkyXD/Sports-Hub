import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import type {ListingSource} from '../domain/ports.ts';
import type {Observation,ResolvedPlayer} from '../shared.ts';
import {validEventPagePair} from '../../playback/providers/event-page-policy.ts';

const teamPath=/^\/teams\/[a-z0-9]+(?:-[a-z0-9]+)*-live\/$/;
const identity=(names:readonly string[])=>names.map(name=>name.toLowerCase().replace(/[^a-z0-9]/g,'')).join('|');
const slug=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);

function teamUrl(value:string,base:string):string|null {
  try{
    const url=new URL(value,base);
    return url.protocol==='https:'&&url.hostname==='nflstreams.org'&&!url.username&&!url.password&&!url.port&&
      !url.search&&!url.hash&&teamPath.test(url.pathname)?url.href:null;
  }catch{return null;}
}

function publishedTime(raw:string,dates:string[]):{kickoff:number;rawTime:string}|null {
  if(!/^\d{13}$/.test(raw)||dates.length===0)return null;
  const kickoff=Number(raw);
  if(!Number.isSafeInteger(kickoff)||kickoff<Date.UTC(2020,0,1)||kickoff>Date.UTC(2100,0,1) ||
    dates.some(date=>!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date)||Date.parse(date)!==kickoff))return null;
  return {kickoff,rawTime:dates[0]};
}

export function parseNflstreamsListings(source:ListingSource,html:string,now:number):
  {observations:Observation[];outcome:'parsed'|'empty'|'parser-changed'} {
  const $=load(html);
  const observations=new Map<string,Observation>();
  let conflicting=false;
  $('.fixture_main_container').each((_i,node)=>{
    const card=$(node);
    const anchors=card.find('a[href]').not('.home_watch_btn,.home_hd_btn').toArray()
      .filter(anchor=>teamUrl($(anchor).attr('href')||'',source.url));
    const watch=card.find('a.home_watch_btn[href]');
    const times=card.find('[datetime],[data-datetime]').map((_j,item)=>
      $(item).attr('datetime')||$(item).attr('data-datetime')||'').get();
    const time=publishedTime(card.attr('data-kickoff-ts')||'',times);
    const espnId=card.attr('data-espn-id')||'';
    if(anchors.length!==2||watch.length!==1||!time||!/^\d{5,12}$/.test(espnId)){
      conflicting=true;return;
    }
    const teams=anchors.map(anchor=>$(anchor).find('span').not('.mobile-abbr').first().text().replace(/\s+/g,' ').trim());
    const urls=anchors.map(anchor=>teamUrl($(anchor).attr('href')||'',source.url));
    const url=teamUrl(watch.attr('href')||'',source.url);
    if(!teams.every(Boolean)||!url||!urls.includes(url)||
      card.attr('data-away-slug')!==slug(teams[0])||card.attr('data-home-slug')!==slug(teams[1])){
      conflicting=true;return;
    }
    const id=`${source.id}:${digest(url)}`;
    const observation:Observation={id,sourceId:source.id,url,title:teams.join(' vs '),teams:[teams[0],teams[1]],
      league:'nfl',kickoff:time.kickoff,rawTime:time.rawTime,observedAt:now,parserVersion:2};
    const previous=observations.get(id);
    if(previous && (previous.kickoff!==observation.kickoff||identity(previous.teams||[])!==identity(teams))){
      conflicting=true;return;
    }
    observations.set(id,observation);
  });
  if(conflicting)return {observations:[],outcome:'parser-changed'};
  const values=[...observations.values()];
  return {observations:values,outcome:values.length?'parsed':/no (?:live )?(?:games|matches) (?:available|scheduled)/i.test($('body').text())?'empty':'parser-changed'};
}

function activeDetail(observation:Observation,html:string):ReturnType<typeof load>|null {
  if(!observation.teams||observation.kickoff===null||!teamUrl(observation.url,observation.url))return null;
  const $=load(html);
  if($('link[rel="canonical"]').attr('href')!==observation.url||
    $('meta[property="og:url"]').attr('content')!==observation.url)return null;
  const active=$('.home__team-fixture-matche.fixture-active');
  if(active.length!==1||teamUrl(active.attr('href')||'',observation.url)!==observation.url||
    active.attr('data-away-slug')!==slug(observation.teams[0])||
    active.attr('data-home-slug')!==slug(observation.teams[1])||
    !/^\d{5,12}$/.test(active.attr('data-espn-id')||''))return null;
  const dates=active.find('[datetime],[data-datetime]').map((_i,node)=>
    $(node).attr('datetime')||$(node).attr('data-datetime')||'').get();
  if(publishedTime(active.attr('data-kickoff-ts')||'',dates)?.kickoff!==observation.kickoff)return null;
  return $;
}

export function nflstreamsPlayers(gameId:string,observation:Observation,html:string):ResolvedPlayer[] {
  const $=activeDetail(observation,html);
  if(!$)return [];
  const players=new Map<number,ResolvedPlayer>();
  let conflicting=false;
  $('.theatre1 a[data-tab]').each((_i,node)=>{
    const anchor=$(node);
    const match=/^player([1-6])$/.exec(anchor.attr('data-tab')||'');
    if(!match)return;
    const number=Number(match[1]);
    if(anchor.text().replace(/\s+/g,' ').trim()!==`Link ${number}`){conflicting=true;return;}
    const scripts=$(`#tab-${number} script[type="text/template"]`);
    if(scripts.length!==1){conflicting=true;return;}
    const iframe=load(scripts.html()||'')('iframe[src]');
    if(iframe.length!==1){conflicting=true;return;}
    const serverUrl=iframe.attr('src')||'';
    if(!validEventPagePair(observation.url,serverUrl)){conflicting=true;return;}
    const player:ResolvedPlayer={id:`event-page:${digest(JSON.stringify([gameId,observation.url,serverUrl]))}`,
      label:`NFLStreams · Link ${number}`,locator:{provider:'event-page',gameId,eventUrl:observation.url,serverUrl}};
    const previous=players.get(number);
    if(previous && previous.locator.provider==='event-page' && previous.locator.serverUrl!==serverUrl){conflicting=true;return;}
    players.set(number,player);
  });
  return conflicting?[]:[...players.values()];
}
