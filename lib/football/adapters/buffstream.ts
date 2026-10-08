import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import type {Observation,ResolvedPlayer} from '../shared.ts';
import {validEventPagePair} from '../../playback/providers/event-page-policy.ts';

export function buffstreamPlayers(gameId:string,observation:Observation,html:string):ResolvedPlayer[] {
  const league=observation.sourceId==='buffstream-nfl'&&observation.league==='nfl'?'NFL':
    (observation.sourceId==='buffstream-cfb'||observation.sourceId==='crackstreams-cfb')&&observation.league==='ncaaf'?'CFB':null;
  if(!league||!observation.teams||
    !observation.url.startsWith(`https://ms.buffstream.io/${league.toLowerCase()}-streams/`))return [];
  const $=load(html);
  const canonical=$('link[rel="canonical"]').attr('href');
  if(canonical!==observation.url&&canonical!==observation.url.replace(/^https:/,'http:'))return [];
  const slug=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const teams=observation.teams.map(slug);
  const players=new Map<string,ResolvedPlayer>();
  $('iframe[src]').each((_i,node)=>{
    const serverUrl=$(node).attr('src')||'';
    if(!validEventPagePair(observation.url,serverUrl))return;
    const path=new URL(serverUrl).pathname;
    const number=/\/american-football\/(.+)-stream-([12])$/.exec(path);
    if(!number||![`${teams[0]}-vs-${teams[1]}`,`${teams[1]}-vs-${teams[0]}`].includes(number[1]))return;
    const id=createHash('sha256').update(JSON.stringify([gameId,observation.url,serverUrl])).digest('hex').slice(0,24);
    players.set(serverUrl,{id:`event-page:${id}`,label:`Buffstream ${league} · Server ${number[2]}`,
      locator:{provider:'event-page',gameId,eventUrl:observation.url,serverUrl}});
  });
  return [...players.values()];
}
