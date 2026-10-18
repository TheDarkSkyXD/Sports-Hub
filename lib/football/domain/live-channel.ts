import type {DetailEvidence,Game,Match,Observation} from '../shared.ts';
import {ACTIVE_DISCOVERY_MS,COLLECTION_SETTLE_MS,detailIdentityMatches} from './source-policy.ts';
import {feedEligible} from './feed-eligibility.ts';

function liveChannelGame(observation:Observation,result:Match,freshGames:readonly Game[],now:number):Game|null {
  if(!(observation.sourceId==='buffstream-nfl'&&observation.league==='nfl'||
      observation.sourceId==='buffstream-cfb'&&observation.league==='ncaaf'||
      observation.sourceId==='buffstream-nba'&&observation.league==='nba'||
      observation.sourceId==='buffstream-nhl'&&observation.league==='nhl'||
      observation.sourceId==='buffstream-mlb'&&observation.league==='mlb')||observation.kickoff!==null||
    result.kind!=='unmatched'||!(result.reason==='unverified-kickoff'||
      observation.sourceId==='buffstream-cfb'&&result.reason==='unverified-contextual-kickoff')||result.possibleGameIds.length!==1||
    observation.observedAt>now+60_000)return null;
  const clock=/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(am|pm)\s*ET$/i.exec(observation.rawTime.trim());
  if(!clock)return null;
  const game=freshGames.find(game=>game.id===result.possibleGameIds[0]);
  if(!game||!feedEligible(game,now)||!game.date)return null;
  const kickoff=Date.parse(game.date);
  if(!Number.isFinite(kickoff))return null;
  const hour=Number(clock[1])%12+(clock[3].toLowerCase()==='pm'?12:0);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(kickoff);
  const sourceMinutes=hour*60+Number(clock[2]);
  const gameMinutes=Number(parts.find(part=>part.type==='hour')?.value)*60+
    Number(parts.find(part=>part.type==='minute')?.value);
  const difference=Math.abs(sourceMinutes-gameMinutes);
  return (observation.sourceId==='buffstream-nfl'||observation.sourceId==='buffstream-nba'||observation.sourceId==='buffstream-nhl'||observation.sourceId==='buffstream-mlb'?difference===0:
    Math.min(difference,1440-difference)<=60)?game:null;
}

export function provisionalLiveChannel(observation:Observation,result:Match,freshGames:readonly Game[],now:number):Game|null {
  if(now-observation.observedAt>=ACTIVE_DISCOVERY_MS)return null;
  return liveChannelGame(observation,result,freshGames,now);
}

export function resolvedLiveChannelMatch(observation:Observation,result:Match,freshGames:readonly Game[],detail:DetailEvidence|undefined,now:number,
  options?:{retainedPublication:boolean}):Match {
  const game=liveChannelGame(observation,result,freshGames,now);
  const owned=game&&detail?.event?.gameId===game.id&&detail.event.date===(game.date??null);
  if(!game||detail?.outcome!=='resolved'||detail.observationId!==observation.id||
    now-observation.observedAt>=ACTIVE_DISCOVERY_MS&&(!owned||now-observation.observedAt>ACTIVE_DISCOVERY_MS+COLLECTION_SETTLE_MS)||
    !detailIdentityMatches(detail.identity,observation)||now-detail.at>=30*60_000&&
      !(options?.retainedPublication&&now-detail.at<=60*60_000&&owned)||detail.at>now+60_000||
    !detail.players.length||!detail.players.every(player=>player.locator.provider==='event-page'&&
      player.locator.gameId===game.id&&player.locator.eventUrl===observation.url))return result;
  return {kind:'matched',gameId:game.id};
}
