import { validSourcePage } from './sunday.ts';
import type { Game } from './sunday.ts';

function normalizedSource(game: Game): string | null {
  if (!game.sourceUrl) return null;
  try {
    const url = new URL(game.sourceUrl);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return validSourcePage(url.href) ? url.href : null;
  } catch { return null; }
}

function kickoff(game: Game): number | null {
  const time = game.date ? Date.parse(game.date) : NaN;
  return Number.isFinite(time) ? time : null;
}

function sameDate(left: Game, right: Game, requireDates: boolean): boolean {
  const a = kickoff(left), b = kickoff(right);
  if (a === null || b === null) return !requireDates;
  // Accommodate corrected kickoff times without joining rematches in later weeks.
  return Math.abs(a - b) <= 24 * 60 * 60 * 1000;
}

function matchup(game: Game): string {
  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [normalize(game.away.name), normalize(game.home.name)].sort().join('|');
}

/** Match current room IDs after the scoreboard switches between source and official data. */
export function buildGameIdMap(previousGames: readonly Game[], nextGames: readonly Game[]): Map<string, string> {
  const result = new Map<string, string>();
  const nextIds = new Set(nextGames.map(game => game.id));
  for (const previous of previousGames) {
    if (nextIds.has(previous.id)) {
      result.set(previous.id, previous.id);
      continue;
    }
    const source = normalizedSource(previous);
    const sourceMatches = source ? nextGames.filter(game => normalizedSource(game) === source && sameDate(previous, game, false)) : [];
    if (sourceMatches.length === 1) {
      result.set(previous.id, sourceMatches[0].id);
      continue;
    }
    if (sourceMatches.length > 1) continue;
    const key = matchup(previous);
    const matches = nextGames.filter(game => matchup(game) === key && sameDate(previous, game, true));
    if (matches.length === 1) result.set(previous.id, matches[0].id);
  }
  // Newly available games may already appear in pending user actions.
  for (const game of nextGames) if (!result.has(game.id)) result.set(game.id, game.id);
  // Saved fallback selections can predate this browser session's first scoreboard.
  const sourceAliases = new Map<string, Set<string>>();
  for (const game of nextGames) {
    const source = normalizedSource(game);
    const suffix = source?.match(/\/watch\/nfl\/[a-z0-9-]+\/(\d+)$/)?.[1];
    if (!suffix) continue;
    const alias = `source-${suffix}`;
    const candidates = sourceAliases.get(alias) || new Set<string>();
    candidates.add(game.id);
    sourceAliases.set(alias, candidates);
  }
  const previousIds = new Set(previousGames.map(game => game.id));
  for (const [alias, candidates] of sourceAliases) {
    if (candidates.size === 1 && !result.has(alias) && !previousIds.has(alias)) {
      result.set(alias, [...candidates][0]);
    }
  }
  return result;
}

/** Drop expired games and preserve order while collapsing aliases for one event. */
export function remapRoomIds(ids: readonly string[], mapping: ReadonlyMap<string, string>): string[] {
  const result = new Set<string>();
  for (const id of ids) {
    const mapped = mapping.get(id);
    if (mapped) result.add(mapped);
  }
  return [...result];
}

/** Migrate known game settings without deleting saved feeds for archived games. */
export function remapRoomRecord<T>(record: Readonly<Record<string, T>>, mapping: ReadonlyMap<string, string>): Record<string, T> {
  const result = new Map<string, T>();
  for (const [id, value] of Object.entries(record)) {
    const mapped = mapping.get(id);
    if (!mapped || mapped === id) result.set(id, value);
  }
  for (const [id, value] of Object.entries(record)) {
    const mapped = mapping.get(id);
    if (mapped && mapped !== id && !result.has(mapped)) result.set(mapped, value);
  }
  return Object.fromEntries(result);
}
