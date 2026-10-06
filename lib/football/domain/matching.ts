import type { Game, Match, Observation, SourceEventBinding } from '../shared.ts';
import { COLLEGE_TEAM_CATALOG } from './college-teams.generated.ts';

export function normalizedName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\band\b/g, '&').replace(/[^a-z0-9]/g, '');
}

const collegeAliases = new Map<string, readonly string[]>();
const collegeOwners = new Map<string, Set<string>>();
for (const team of COLLEGE_TEAM_CATALOG) {
  const aliases = [...new Set(team.aliases.map(normalizedName).filter(Boolean))];
  collegeAliases.set(team.id,aliases);
  for (const alias of aliases) {
    const owners = collegeOwners.get(alias) || new Set<string>();
    owners.add(`ncaaf:${team.id}`);
    collegeOwners.set(alias,owners);
  }
}

export function createObservationMatcher(games: Game[], mode: 'current' | 'inventory-live' = 'current'): (observation: Observation, now: number) => Match {
  const identity = (game: Game, team: Game['home']) => `${game.league}:${team.id || normalizedName(team.name)}`;
  const aliases = (game: Game, team: Game['home']) => new Set([...(game.league === 'ncaaf' ? collegeAliases.get(team.id || '') || [] : []), ...[team.name, team.short, team.abbreviation, ...(team.aliases || [])].map(normalizedName).filter(Boolean)]);
  const liveOwners = new Map<string,Set<string>>();
  const gameAliases = new Map<Game,[Set<string>,Set<string>]>();
  for (const game of games) {
    const pair: [Set<string>,Set<string>] = [aliases(game,game.home),aliases(game,game.away)];
    gameAliases.set(game,pair);
    for (const [index,team] of [game.home,game.away].entries()) for (const alias of pair[index]) {
      const key = `${game.league}:${alias}`;
      const owners = liveOwners.get(key) || new Set<string>();
      owners.add(identity(game,team));
      liveOwners.set(key,owners);
    }
  }
  const names = (game: Game, team: Game['home'], index: 0 | 1) => new Set([...(gameAliases.get(game)?.[index] || [])].filter(alias => {
    const owner = identity(game,team);
    const live = liveOwners.get(`${game.league}:${alias}`);
    const catalog = game.league === 'ncaaf' ? collegeOwners.get(alias) : undefined;
    return (!live || live.size === 1 && live.has(owner)) && (!catalog || catalog.size === 1 && catalog.has(owner));
  }));
  const prepared=games.map(game=>({game,home:names(game,game.home,0),away:names(game,game.away,1),
    date:game.date ? Date.parse(game.date) : NaN}));
  return (observation,now) => {
    if (!observation.teams) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
    const stale=now-observation.observedAt>30*60_000;
    if (observation.observedAt > now + 60_000 || stale && mode==='current')
      return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]};
    const [first,second]=observation.teams.map(normalizedName);
    if (!first || !second || first===second) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
    const strict=prepared.filter(({game,home,away})=>{
      if (observation.league && game.league!==observation.league) return false;
      return home.has(first) && away.has(second) || home.has(second) && away.has(first);
    });
    const anchored=(anchorName:string,otherName:string,anchorId:string,otherId:string):boolean=>{
      const anchorOwners=collegeOwners.get(anchorName),otherOwners=collegeOwners.get(otherName);
      const activeAnchor=liveOwners.get(`ncaaf:${anchorName}`),activeOther=liveOwners.get(`ncaaf:${otherName}`);
      return !!anchorOwners&&anchorOwners.size===1&&anchorOwners.has(anchorId)&&
        !!otherOwners&&otherOwners.size>1&&otherOwners.has(otherId)&&
        !!activeAnchor&&activeAnchor.size===1&&activeAnchor.has(anchorId)&&
        !!activeOther&&activeOther.has(otherId)&&[...activeOther].every(owner=>otherOwners.has(owner));
    };
    const contextual=observation.league==='nfl'?[]:prepared.filter(({game})=>{
      if(game.league!=='ncaaf'||!collegeAliases.has(game.home.id||'')||!collegeAliases.has(game.away.id||''))return false;
      const home=identity(game,game.home),away=identity(game,game.away);
      return anchored(first,second,home,away)||anchored(second,first,away,home)||
        anchored(first,second,away,home)||anchored(second,first,home,away);
    });
    const possible=[...new Map([...strict,...contextual].map(row=>[row.game.id,row])).values()];
    const ids=[...new Set(possible.map(({game})=>game.id))];
    if (observation.kickoff===null) return {kind:'unmatched',reason:!ids.length?'unknown-teams':
      ids.length===1&&possible[0].game.lifecycle==='final'?'finished-game':contextual.length?'unverified-contextual-kickoff':'unverified-kickoff',possibleGameIds:ids};
    const kickoff=observation.kickoff;
    const dated=possible.filter(({date})=>Number.isFinite(date) && Math.abs(date-kickoff)<=3*60*60_000);
    if (dated.length!==1) return {kind:'unmatched',reason:dated.length?'ambiguous-matchup':possible.length?'conflicting-date':'unknown-teams',possibleGameIds:ids};
    const game=dated[0].game;
    if (stale && game.lifecycle!=='live')
      return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[game.id]};
    if (game.lifecycle==='final') return {kind:'unmatched',reason:'finished-game',possibleGameIds:[game.id]};
    return {kind:'matched',gameId:game.id};
  };
}

export function matchObservation(observation: Observation, games: Game[], now: number): Match {
  return createObservationMatcher(games)(observation,now);
}

export function detailCandidateGameIds(result:Match):readonly string[] {
  if(result.kind==='matched')return [result.gameId];
  return result.reason==='unverified-kickoff'||result.reason==='unverified-contextual-kickoff'
    ?result.possibleGameIds:[];
}

export function matchSourceLiveGame(result:Match,games:readonly Game[],now:number):Match {
  if(result.kind!=='unmatched'||result.reason!=='unverified-kickoff'||result.possibleGameIds.length!==1)return result;
  const game=games.find(game=>game.id===result.possibleGameIds[0]);
  return game&&(game.lifecycle==='live'||game.lifecycle==='scheduled'&&game.date!==undefined&&Math.abs(Date.parse(game.date)-now)<=30*60_000)
    ?{kind:'matched',gameId:game.id}:result;
}

export function confirmedFinishedGameId(observation:Observation,games:Game[],now:number,expectedGameId?:string):string|null {
  if(observation.kickoff===null)return null;
  const result=createObservationMatcher(games,'inventory-live')({...observation,observedAt:now},now);
  return result.kind==='unmatched'&&result.reason==='finished-game'&&result.possibleGameIds.length===1&&
    (!expectedGameId||result.possibleGameIds[0]===expectedGameId)?result.possibleGameIds[0]:null;
}

export function confirmedFinishedBoundEvent(observation:Observation,eventId:string,bindings:readonly SourceEventBinding[],games:Game[]):string|null {
  if(observation.kickoff!==null)return null;
  const teams=observation.teams;
  if(!teams)return null;
  const pair=(teams:readonly string[])=>teams.map(normalizedName).sort().join('|');
  const binding=bindings.find(row=>row.sourceId===observation.sourceId&&row.eventId===eventId&&
    row.url===observation.url&&row.league===observation.league&&pair(row.teams)===pair(teams));
  if(!binding||!games.some(game=>game.id===binding.gameId&&game.lifecycle==='final'))return null;
  const current=createObservationMatcher(games,'inventory-live')(observation,observation.observedAt);
  return current.kind==='unmatched'&&current.possibleGameIds.length===1&&
    current.possibleGameIds[0]===binding.gameId?binding.gameId:null;
}

export function mergeSchedulePartitions(partitions: Game[][]): Game[] {
  const merged = new Map<string, Game>();
  const conflicting = new Set<string>();
  for (const games of partitions) for (const game of games) {
    if (conflicting.has(game.id)) continue;
    const previous = merged.get(game.id);
    if (previous && (previous.league !== game.league ||
      (previous.home.id || normalizedName(previous.home.name)) !== (game.home.id || normalizedName(game.home.name)) ||
      (previous.away.id || normalizedName(previous.away.name)) !== (game.away.id || normalizedName(game.away.name)) ||
      (previous.date && game.date && Math.abs(Date.parse(previous.date)-Date.parse(game.date)) > 3 * 60 * 60_000))) {
      merged.delete(game.id);
      conflicting.add(game.id);
      continue;
    }
    merged.set(game.id, {...(previous || game),partitions:[...new Set([...(previous?.partitions || []),...(game.partitions || [])])]});
  }
  return [...merged.values()];
}
