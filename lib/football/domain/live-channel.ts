import type {DetailEvidence,Game,Match,Observation} from '../shared.ts';
import {detailIdentity} from './source-policy.ts';

export function provisionalLiveChannel(observation:Observation,result:Match,freshGames:readonly Game[],now:number):Game|null {
  if(!(observation.sourceId==='buffstream-nfl'&&observation.league==='nfl'||
      observation.sourceId==='buffstream-cfb'&&observation.league==='ncaaf')||observation.kickoff!==null||
    result.kind!=='unmatched'||result.reason!=='unverified-kickoff'||result.possibleGameIds.length!==1||
    now-observation.observedAt>=30*60_000||observation.observedAt>now+60_000)return null;
  const clock=/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(am|pm)\s*ET$/i.exec(observation.rawTime.trim());
  if(!clock)return null;
  const game=freshGames.find(game=>game.id===result.possibleGameIds[0]);
  if(!game||game.lifecycle!=='live'||game.finalObservedAt!==undefined||!game.date)return null;
  const kickoff=Date.parse(game.date);
  if(!Number.isFinite(kickoff))return null;
  const hour=Number(clock[1])%12+(clock[3].toLowerCase()==='pm'?12:0);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(kickoff);
  const sourceMinutes=hour*60+Number(clock[2]);
  const gameMinutes=Number(parts.find(part=>part.type==='hour')?.value)*60+
    Number(parts.find(part=>part.type==='minute')?.value);
  const difference=Math.abs(sourceMinutes-gameMinutes);
  return (observation.sourceId==='buffstream-nfl'?difference===0:
    Math.min(difference,1440-difference)<=60)?game:null;
}

export function resolvedLiveChannelMatch(observation:Observation,result:Match,freshGames:readonly Game[],detail:DetailEvidence|undefined,now:number):Match {
  const game=provisionalLiveChannel(observation,result,freshGames,now);
  if(!game||detail?.outcome!=='resolved'||detail.observationId!==observation.id||
    detail.identity!==detailIdentity(observation)||now-detail.at>=30*60_000||detail.at>now+60_000||
    !detail.players.length||!detail.players.every(player=>player.locator.provider==='event-page'&&
      player.locator.gameId===game.id&&player.locator.eventUrl===observation.url))return result;
  return {kind:'matched',gameId:game.id};
}
