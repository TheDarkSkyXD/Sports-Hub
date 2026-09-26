import type { Game, Match, Observation } from '../shared.ts';

export function normalizedName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function matchObservation(observation: Observation, games: Game[], now: number): Match {
  if (!observation.teams) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
  if (observation.observedAt > now + 60_000 || now - observation.observedAt > 30 * 60_000) return {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]};
  const [first, second] = observation.teams.map(normalizedName);
  if (!first || !second || first === second) return {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]};
  const identity = (game: Game, team: Game['home']) => `${game.league}:${team.id || normalizedName(team.name)}`;
  const aliases = (team: Game['home']) => new Set([team.name, team.short, team.abbreviation, ...(team.aliases || [])].map(normalizedName).filter(Boolean));
  const owners = new Map<string,Set<string>>();
  for (const game of games) for (const team of [game.home,game.away]) {
    for (const alias of aliases(team)) {
      const key = `${game.league}:${alias}`;
      if (!owners.has(key)) owners.set(key,new Set());
      owners.get(key)?.add(identity(game,team));
    }
  }
  const names = (game: Game, team: Game['home']) => new Set([...aliases(team)].filter(alias => owners.get(`${game.league}:${alias}`)?.size === 1));
  const possible = games.filter(game => {
    if (observation.league && game.league !== observation.league) return false;
    const home = names(game,game.home), away = names(game,game.away);
    return home.has(first) && away.has(second) || home.has(second) && away.has(first);
  });
  const ids = [...new Set(possible.map(game => game.id))];
  if (observation.kickoff === null) return {kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:ids};
  const kickoff = observation.kickoff;
  const dated = possible.filter(game => game.date && Number.isFinite(Date.parse(game.date)) && Math.abs(Date.parse(game.date) - kickoff) <= 3 * 60 * 60_000);
  if (dated.length !== 1) return {kind:'unmatched',reason:dated.length ? 'ambiguous-matchup' : possible.length ? 'conflicting-date' : 'unknown-teams',possibleGameIds:ids};
  const game = dated[0];
  if (game.lifecycle === 'final') return {kind:'unmatched',reason:'finished-game',possibleGameIds:[game.id]};
  return {kind:'matched',gameId:game.id};
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
