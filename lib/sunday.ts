import { ScheduleGameSchema } from './football/shared.ts';
import type { Team, League, Game, ScheduleGame } from './football/shared.ts';
export type { Team, League, Game, LeagueFeedStatus, Board } from './football/shared.ts';
export type Feed = { url: string; label: string };
export type SourcePlayer = { id: string; label: string; url: string };
export const LEAGUES = {
  nfl: { label: 'NFL' },
  ncaaf: { label: 'NCAA' },
} satisfies Record<League, { label: string }>;
export function validGameId(value: unknown): value is string { return typeof value === 'string' && /^(?:\d{1,20}|source-\d{1,20}|redzone|ncaaf-\d{1,20}|ncaaf-source-\d{1,20})$/.test(value); }
export function parsePlayers(html: string): SourcePlayer[] {
  const initial = html.match(/<iframe\b[^>]*src="(https:\/\/gooz\.aapmains\.net\/new-stream-embed\/(\d+))"/i);
  if (!initial) return [];
  const ids = [...new Set([initial[2], ...[...html.matchAll(/changeStream\((\d+)\)/g)].map(m => m[1])])];
  return ids.map((id, index) => ({ id, label: index ? `Backup ${index}` : 'Primary', url: `https://gooz.aapmains.net/new-stream-embed/${id}` }));
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function items(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
export function scoreboardWeek(data: unknown): number | undefined {
  const week = object(object(data)?.week)?.number;
  return typeof week === 'number' && Number.isInteger(week) ? week : undefined;
}
export function parseScoreboard(data: unknown, league: League = 'nfl'): ScheduleGame[] {
  const events = object(data)?.events;
  if (!Array.isArray(events)) throw new Error('Scoreboard format changed');
  return events.flatMap((raw): ScheduleGame[] => {
    const event = object(raw);
    const competition = object(items(event?.competitions)[0]);
    const competitors = items(competition?.competitors).map(object).filter((item): item is Record<string, unknown> => item !== null);
    const home = competitors.find(item => item.homeAway === 'home');
    const away = competitors.find(item => item.homeAway === 'away');
    const homeTeam = object(home?.team), awayTeam = object(away?.team);
    const id = text(event?.id);
    if (!id || !/^\d{1,20}$/.test(id) || !text(homeTeam?.displayName) || !text(awayTeam?.displayName) || !home || !away || !homeTeam || !awayTeam) return [];
    const team = (item: Record<string, unknown>, info: Record<string, unknown>): Team => {
      const name = text(info.displayName) || '';
      const color = text(info.color), logo = text(info.logo);
      const record = items(item.records).map(object).find(entry => entry?.type === 'total');
      return { id: text(info.id) ? `espn:${league}:${text(info.id)}` : undefined, aliases: [name, text(info.location), text(info.shortDisplayName), text(info.abbreviation)].filter((value): value is string => !!value), name, short: text(info.shortDisplayName) || (league === 'ncaaf' ? name : text(info.name)) || name, abbreviation: text(info.abbreviation) || name.slice(0, 3), color: color && /^[a-f0-9]{6}$/i.test(color) ? color : '566775', logo: logo?.startsWith('https://') ? logo : undefined, score: typeof item.score === 'string' || typeof item.score === 'number' ? String(item.score) : null, record: text(record?.summary) };
    };
    const status = object(event?.status) || object(competition?.status);
    const statusType = object(status?.type);
    const state = statusType?.state;
    const final = statusType?.name === 'STATUS_FINAL' && statusType.completed === true && state === 'post';
    const lifecycle: Game['lifecycle'] = final ? 'final' : state === 'in' && statusType?.completed !== true ? 'live' : statusType?.name === 'STATUS_SCHEDULED' && state === 'pre' ? 'scheduled' : 'unknown';
    const gameStatus: Game['status'] = final ? 'post' : state === 'pre' || state === 'in' ? state : 'unknown';
    const situation = object(competition?.situation);
    const names = items(object(items(competition?.broadcasts)[0])?.names).filter((name): name is string => typeof name === 'string');
    const season = object(event?.season)?.year;
    return [ScheduleGameSchema.parse({ id: league === 'ncaaf' ? `ncaaf-${id}` : id, league, lifecycle, season: typeof season === 'number' ? season : undefined, name: text(event?.name) || `${awayTeam.displayName} at ${homeTeam.displayName}`, date: text(event?.date), home: team(home, homeTeam), away: team(away, awayTeam), status: gameStatus, detail: text(statusType?.shortDetail) || 'Status unavailable', redzone: situation?.isRedZone === true && gameStatus === 'in', down: text(situation?.downDistanceText), possession: situation?.possession === home.id ? text(homeTeam.abbreviation) : situation?.possession === away.id ? text(awayTeam.abbreviation) : undefined, lastPlay: text(object(situation?.lastPlay)?.text), venue: text(object(competition?.venue)?.fullName), broadcast: names.length ? names.join(' / ') : undefined })];
  });
}
export function validFeedUrl(input: string): string | null {
  try { const url = new URL(input.trim()); return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function priority(game: Game): number { return (game.status === 'in' ? 100 : game.status === 'pre' ? 30 : 0) + (game.redzone ? 60 : 0) + (game.status === 'in' && Math.abs(Number(game.home.score) - Number(game.away.score)) <= 8 ? 15 : 0); }
