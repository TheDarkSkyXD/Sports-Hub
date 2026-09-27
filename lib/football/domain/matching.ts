import type { Game, Match, Observation } from '../shared.ts';
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

export function createObservationMatcher(games: Game[]): (observation: Observation, now: number) => Match {
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
    if (observation.observedAt > now + 60_000 || now - observation.observedAt > 30 * 60_000)
      return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]};
    const [first,second]=observation.teams.map(normalizedName);
    if (!first || !second || first===second) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
    const possible=prepared.filter(({game,home,away})=>{
      if (observation.league && game.league!==observation.league) return false;
      return home.has(first) && away.has(second) || home.has(second) && away.has(first);
    });
    const ids=[...new Set(possible.map(({game})=>game.id))];
    if (observation.kickoff===null) return {kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:ids};
    const kickoff=observation.kickoff;
    const dated=possible.filter(({date})=>Number.isFinite(date) && Math.abs(date-kickoff)<=3*60*60_000);
    if (dated.length!==1) return {kind:'unmatched',reason:dated.length?'ambiguous-matchup':possible.length?'conflicting-date':'unknown-teams',possibleGameIds:ids};
    const game=dated[0].game;
    if (game.lifecycle==='final') return {kind:'unmatched',reason:'finished-game',possibleGameIds:[game.id]};
    return {kind:'matched',gameId:game.id};
  };
}

export function matchObservation(observation: Observation, games: Game[], now: number): Match {
  return createObservationMatcher(games)(observation,now);
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
