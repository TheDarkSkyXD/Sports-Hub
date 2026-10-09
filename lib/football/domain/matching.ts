import { isRaceGame, isWrestlingGame, isWrestlingLeague, isMatchupGame, isMotorsportsLeague, type Game, type Match, type MatchupGame, type Observation, type RaceGame, type WrestlingGame, type SourceEventBinding } from '../shared.ts';
import { wrestlingEventKey, wrestlingShowKey } from './wrestling-events.ts';
import { COLLEGE_TEAM_CATALOG } from './college-teams.generated.ts';
import { feedEligible } from './feed-eligibility.ts';
import { sourceCoverage } from '../source-registry.ts';

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

export function createObservationMatcher(games: readonly Game[], mode: 'current' | 'inventory-live' = 'current'): (observation: Observation, now: number) => Match {
  const identity = (game: MatchupGame, team: MatchupGame['home']) => `${game.league}:${team.id || normalizedName(team.name)}`;
  const aliases = (game: MatchupGame, team: MatchupGame['home']) => new Set([...(game.league === 'ncaaf' ? collegeAliases.get(team.id || '') || [] : []), ...[team.name, team.short, team.abbreviation, ...(team.aliases || [])].map(normalizedName).filter(Boolean)]);
  const matchups=games.filter(isMatchupGame);
  const races=games.filter(isRaceGame);
  const wrestling=games.filter(isWrestlingGame);
  const liveOwners = new Map<string,Set<string>>();
  const gameAliases = new Map<MatchupGame,[Set<string>,Set<string>]>();
  for (const game of matchups) {
    const pair: [Set<string>,Set<string>] = [aliases(game,game.home),aliases(game,game.away)];
    gameAliases.set(game,pair);
    for (const [index,team] of [game.home,game.away].entries()) for (const alias of pair[index]) {
      const key = `${game.league}:${alias}`;
      const owners = liveOwners.get(key) || new Set<string>();
      owners.add(identity(game,team));
      liveOwners.set(key,owners);
    }
  }
  const names = (game: MatchupGame, team: MatchupGame['home'], index: 0 | 1) => new Set([...(gameAliases.get(game)?.[index] || [])].filter(alias => {
    const owner = identity(game,team);
    const live = liveOwners.get(`${game.league}:${alias}`);
    const catalog = game.league === 'ncaaf' ? collegeOwners.get(alias) : undefined;
    return (!live || live.size === 1 && live.has(owner)) && (!catalog || catalog.size === 1 && catalog.has(owner));
  }));
  const prepared=matchups.map((game,index)=>({game,index,home:names(game,game.home,0),away:names(game,game.away,1),
    homeId:identity(game,game.home),awayId:identity(game,game.away),date:game.date ? Date.parse(game.date) : NaN}));
  const homeByAlias=new Map<string,typeof prepared>();
  const awayByAlias=new Map<string,typeof prepared>();
  const collegeByTeam=new Map<string,typeof prepared>();
  const add=(index:Map<string,typeof prepared>,key:string,row:typeof prepared[number])=>{
    const rows=index.get(key)||[];
    rows.push(row);
    index.set(key,rows);
  };
  for(const row of prepared) {
    for(const alias of row.home)add(homeByAlias,alias,row);
    for(const alias of row.away)add(awayByAlias,alias,row);
    if(row.game.league==='ncaaf'&&collegeAliases.has(row.game.home.id||'')&&collegeAliases.has(row.game.away.id||'')) {
      add(collegeByTeam,row.homeId,row);
      if(row.awayId!==row.homeId)add(collegeByTeam,row.awayId,row);
    }
  }
  return (observation,now) => {
    if(observation.league&&isMotorsportsLeague(observation.league))return matchRaceObservation(observation,races,now,mode);
    if(observation.league&&isWrestlingLeague(observation.league))return matchWrestlingObservation(observation,wrestling,now,mode);
    if (!observation.teams) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
    const stale=now-observation.observedAt>30*60_000;
    if (observation.observedAt > now + 60_000 || stale && mode==='current')
      return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]};
    const [first,second]=observation.teams.map(normalizedName);
    if (!first || !second || first===second) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
    const strictRows=new Set<typeof prepared[number]>();
    for(const row of homeByAlias.get(first)||[])if((!observation.league||row.game.league===observation.league)&&row.away.has(second))strictRows.add(row);
    for(const row of awayByAlias.get(first)||[])if((!observation.league||row.game.league===observation.league)&&row.home.has(second))strictRows.add(row);
    const strict=[...strictRows].sort((left,right)=>left.index-right.index);
    const anchored=(anchorName:string,otherName:string):typeof prepared=>{
      const anchorOwners=collegeOwners.get(anchorName),otherOwners=collegeOwners.get(otherName);
      const activeAnchor=liveOwners.get(`ncaaf:${anchorName}`),activeOther=liveOwners.get(`ncaaf:${otherName}`);
      if(!anchorOwners||anchorOwners.size!==1||!otherOwners||otherOwners.size<=1||
        !activeAnchor||activeAnchor.size!==1||!activeOther||
        [...activeOther].some(owner=>!otherOwners.has(owner)))return [];
      const anchorId=anchorOwners.values().next().value;
      if(!anchorId||!activeAnchor.has(anchorId))return [];
      return (collegeByTeam.get(anchorId)||[]).filter(row=>
        row.homeId===anchorId&&otherOwners.has(row.awayId)&&activeOther.has(row.awayId)||
        row.awayId===anchorId&&otherOwners.has(row.homeId)&&activeOther.has(row.homeId));
    };
    const contextual=observation.league==='nfl'||observation.league==='nba'||observation.league==='wnba'||observation.league==='nhl'||observation.league==='mlb'?[]:
      [...new Set([...anchored(first,second),...anchored(second,first)])].sort((left,right)=>left.index-right.index);
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
function matchWrestlingObservation(observation:Observation,games:WrestlingGame[],now:number,
  mode:'current'|'inventory-live'):Match {
  const stale=now-observation.observedAt>30*60_000;
  if(observation.observedAt>now+60_000||stale&&mode==='current')
    return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]};
  if(observation.teams||observation.kickoff===null||!observation.league||!isWrestlingLeague(observation.league))
    return {kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:[]};
  const league=observation.league,kickoff=observation.kickoff,key=wrestlingEventKey(league,observation.title,kickoff);
  const show=wrestlingShowKey(league,observation.title);
  if(!key||!show)return {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]};
  const sameTitle=games.filter(game=>game.league===league&&wrestlingShowKey(game.league,game.name)===show);
  const dated=sameTitle.filter(game=>wrestlingEventKey(game.league,game.name,Date.parse(game.date))===key&&
    Math.abs(Date.parse(game.date)-kickoff)<=90*60_000);
  if(dated.length!==1){
    const conflicts=sameTitle.filter(game=>wrestlingEventKey(game.league,game.name,Date.parse(game.date))===key||
      Math.abs(Date.parse(game.date)-kickoff)<=90*60_000);
    return {kind:'unmatched',reason:dated.length?'ambiguous-matchup':conflicts.length?'conflicting-date':'unknown-teams',
      possibleGameIds:(dated.length?dated:conflicts).map(game=>game.id)};
  }
  const game=dated[0];
  if(stale&&game.lifecycle!=='live')return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[game.id]};
  if(game.lifecycle==='final')return {kind:'unmatched',reason:'finished-game',possibleGameIds:[game.id]};
  return {kind:'matched',gameId:game.id};
}
function raceSessionInTitle(title:string,session:RaceGame['race']['session'],league:RaceGame['league']):boolean {
  const value=title.toLowerCase();
  const sprintQual=/sprint[\s-]*(?:qualifying|quali|q\b|shootout)/.test(value);
  if(session==='sprint-qualifying')return sprintQual;
  if(session==='sprint')return !sprintQual&&/\bsprint\b/.test(value);
  if(session==='qualifying')return !sprintQual&&/\b(?:qualifying|quali)\b/.test(value);
  if(session==='practice')return /\b(?:free\s+)?practice\b/.test(value)&&
    !/\bpractice\s*[1-4]\b|\bfp[1-4]\b/.test(value);
  if(session.startsWith('practice-')){
    if(!/\b(?:free\s+)?practice\b|\bfp[1-4]\b/.test(value))return false;
    const number=/\b(?:practice\s*|fp)([1-4])\b/.exec(value)?.[1];
    return number?session===`practice-${number}`:league==='f1';
  }
  return !/\b(?:practice|qualifying|quali|sprint|fp[123])\b/.test(value)&&
    (league!=='f1'||/\brace\b/.test(value));
}
function matchRaceObservation(observation:Observation,games:RaceGame[],now:number,mode:'current'|'inventory-live'):Match {
  const stale=now-observation.observedAt>30*60_000;
  if(observation.observedAt>now+60_000||stale&&mode==='current')return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]};
  if(observation.teams||observation.kickoff===null)return {kind:'unmatched',reason:'unverified-race',possibleGameIds:[]};
  const kickoff=observation.kickoff;
  const title=normalizedName(observation.title);
  const dated=games.filter(game=>game.league===observation.league&&
    title.includes(normalizedName(game.race.round))&&
    raceSessionInTitle(observation.title,game.race.session,game.league)&&
    Math.abs(Date.parse(game.date)-kickoff)<=(game.league==='nascar-cup'||game.league==='nascar-truck'?90:20)*60_000);
  if(dated.length!==1)return {kind:'unmatched',reason:dated.length?'ambiguous-race':'unknown-race',possibleGameIds:dated.map(game=>game.id)};
  const game=dated[0];
  if(stale&&game.lifecycle!=='live')return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[game.id]};
  if(game.lifecycle==='final')return {kind:'unmatched',reason:'finished-game',possibleGameIds:[game.id]};
  return {kind:'matched',gameId:game.id};
}

export function matchObservation(observation: Observation, games: Game[], now: number): Match {
  return createObservationMatcher(games)(observation,now);
}

export function detailCandidateGameIds(result:Match):readonly string[] {
  if(result.kind==='matched')return [result.gameId];
  return result.reason==='unverified-kickoff'||result.reason==='unverified-contextual-kickoff'
    ?result.possibleGameIds:[];
}

export type SourceEventEvidence = {
  undated: 'none' | 'published-listing' | 'live-claim' | 'retained-live-detail';
  externalGameId: string | null;
};

export type SourceEventDecision =
  | {kind:'matched';gameId:string;match:Extract<Match,{kind:'matched'}>}
  | {kind:'possible';gameIds:string[];reason:string;match:Extract<Match,{kind:'unmatched'}>}
  | {kind:'rejected';reason:string;match:Extract<Match,{kind:'unmatched'}>};

export function createSourceEventMatcher(games:readonly Game[],mode:'current'|'inventory-live'='current') {
  const prepared=new Map<string,ReturnType<typeof createObservationMatcher>>();
  const byId=new Map(games.map(game=>[game.id,game]));
  return (observation:Observation,evidence:SourceEventEvidence,now:number):SourceEventDecision=>{
    const declared=sourceCoverage(observation.sourceId);
    const leagues=declared.length?declared:observation.league?[observation.league]:
      [...new Set(games.map(game=>game.league))];
    const key=[...leagues].sort().join(',');
    let match=prepared.get(key);
    if(!match){
      match=createObservationMatcher(games.filter(game=>leagues.includes(game.league)),mode);
      prepared.set(key,match);
    }
    let result=match(observation,now);
    const fresh=now-observation.observedAt<30*60_000&&observation.observedAt<=now+60_000;
    if(result.kind==='unmatched'&&observation.kickoff===null&&
      result.reason==='unverified-kickoff'&&result.possibleGameIds.length===1&&
      (evidence.undated==='retained-live-detail'||fresh)){
      const game=byId.get(result.possibleGameIds[0]);
      if(game&&game.lifecycle!=='final'&&observation.league===game.league&&
        (evidence.undated==='published-listing'&&feedEligible(game,now)||
          evidence.undated==='retained-live-detail'&&(game.lifecycle==='live'||fresh)&&feedEligible(game,now)||
          evidence.undated==='live-claim'&&feedEligible(game,now)&&game.date!==undefined&&
            Math.abs(Date.parse(game.date)-now)<=30*60_000))
        result={kind:'matched',gameId:game.id};
    }
    if(evidence.externalGameId!==null&&
      (result.kind==='matched'&&result.gameId!==evidence.externalGameId||
        result.kind==='unmatched'&&result.possibleGameIds.length>0&&
          !result.possibleGameIds.includes(evidence.externalGameId)))
      result={kind:'unmatched',reason:'conflicting-game-id',possibleGameIds:result.kind==='matched'?[result.gameId]:result.possibleGameIds};
    if(result.kind==='matched')return {kind:'matched',gameId:result.gameId,match:result};
    if(result.possibleGameIds.length&&result.reason!=='finished-game'&&result.reason!=='conflicting-game-id')
      return {kind:'possible',gameIds:result.possibleGameIds,reason:result.reason,match:result};
    return {kind:'rejected',reason:result.reason,match:result};
  };
}

export function createFinishedGameMatcher(games:readonly Game[]) {
  const match=createObservationMatcher(games,'inventory-live');
  const finalIds=new Set(games.filter(game=>game.lifecycle==='final').map(game=>game.id));
  return {
    finishedGameId(observation:Observation,now:number,expectedGameId?:string):string|null {
      if(observation.kickoff===null)return null;
      const result=match({...observation,observedAt:now},now);
      return result.kind==='unmatched'&&result.reason==='finished-game'&&result.possibleGameIds.length===1&&
        (!expectedGameId||result.possibleGameIds[0]===expectedGameId)?result.possibleGameIds[0]:null;
    },
    finishedBoundEvent(observation:Observation,eventId:string,bindings:readonly SourceEventBinding[]):string|null {
      if(observation.kickoff!==null)return null;
      const teams=observation.teams;
      if(!teams)return null;
      const pair=(teams:readonly string[])=>teams.map(normalizedName).sort().join('|');
      const binding=bindings.find(row=>row.sourceId===observation.sourceId&&row.eventId===eventId&&
        row.url===observation.url&&row.league===observation.league&&pair(row.teams)===pair(teams));
      if(!binding||!finalIds.has(binding.gameId))return null;
      const current=match(observation,observation.observedAt);
      return current.kind==='unmatched'&&current.possibleGameIds.length===1&&
        current.possibleGameIds[0]===binding.gameId?binding.gameId:null;
    },
  };
}

export function mergeSchedulePartitions(partitions: Game[][]): Game[] {
  const merged = new Map<string, Game>();
  const conflicting = new Set<string>();
  for (const games of partitions) for (const game of games) {
    if (conflicting.has(game.id)) continue;
    const previous = merged.get(game.id);
    const identityConflict=previous&&(
      previous.league!==game.league ||
      isRaceGame(previous)&&isRaceGame(game)&&(
        previous.race.eventId!==game.race.eventId||previous.race.sessionId!==game.race.sessionId||
        previous.race.session!==game.race.session||previous.race.round!==game.race.round) ||
      isWrestlingGame(previous)&&isWrestlingGame(game)&&previous.wrestling.eventId!==game.wrestling.eventId ||
      isMatchupGame(previous)&&isMatchupGame(game)&&(
        (previous.home.id || normalizedName(previous.home.name)) !== (game.home.id || normalizedName(game.home.name)) ||
        (previous.away.id || normalizedName(previous.away.name)) !== (game.away.id || normalizedName(game.away.name))) ||
      previous.date&&game.date&&Math.abs(Date.parse(previous.date)-Date.parse(game.date))>3*60*60_000);
    if (identityConflict) {
      merged.delete(game.id);
      conflicting.add(game.id);
      continue;
    }
    merged.set(game.id, {...(previous || game),partitions:[...new Set([...(previous?.partitions || []),...(game.partitions || [])])]});
  }
  return [...merged.values()];
}
