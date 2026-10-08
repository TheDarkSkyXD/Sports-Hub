import { ScheduleGameSchema, isRaceGame } from './football/shared.ts';
import { gameTiming } from './game-timing.ts';
import type { Team, League, Game, ScheduleGame } from './football/shared.ts';
export type { Team, League, Game, LeagueFeedStatus, Board } from './football/shared.ts';
export type Feed = { url: string; label: string };
export type SourcePlayer = { id: string; label: string; url: string };
export const LEAGUES = {
  nfl: { label: 'NFL' },
  ncaaf: { label: 'NCAA' },
  nba: { label: 'NBA' },
  wnba: { label: 'WNBA' },
  ncaab: { label: 'NCAA BB' },
  nhl: { label: 'NHL' },
  ncaah: { label: 'NCAA Hockey' },
  ncaawh: { label: "NCAA Women's Hockey" },
  mlb: { label: 'MLB' },
  f1: { label: 'F1' },
  'nascar-cup':{label:'NASCAR Cup'},
  'nascar-truck':{label:'NASCAR Trucks'},
  motogp:{label:'MotoGP'},
  motorsport:{label:'Motorsport'},
} satisfies Record<League, { label: string }>;
export function isBasketballLeague(league: League): boolean { return league === 'nba' || league === 'wnba' || league === 'ncaab'; }
export function validGameId(value: unknown): value is string { return typeof value === 'string' && /^(?:\d{1,20}|source-\d{1,20}|redzone|(?:ncaaf|ncaab|nba|wnba|nhl|ncaah|ncaawh|mlb|f1|nascar-cup|nascar-truck|motogp|motorsport)-\d{1,20}|ncaaf-source-\d{1,20})$/.test(value); }
export function parsePlayers(html: string): SourcePlayer[] {
  const embeds = [...html.matchAll(/<iframe\b[^>]*>/gi)].flatMap(([tag]) => {
    const source = tag.match(/(?:^|\s)src\s*=\s*(['"])(https:\/\/gooz\.aapmains\.net\/new-stream-embed\/(\d+))\1/i);
    return source ? [source[3]] : [];
  });
  if (!embeds.length) return [];
  const ids = [...new Set([...embeds, ...[...html.matchAll(/changeStream\((\d+)\)/g)].map(m => m[1])])];
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
export function scoreboardFeedData(data: unknown, format: 'site' | 'cdn'): unknown {
  if (format === 'site') return data;
  const payload = object(object(data)?.content)?.sbData;
  if (!object(payload)) throw new Error('Scoreboard format changed');
  return payload;
}
export function parseScoreboard(data: unknown, league: League = 'nfl'): ScheduleGame[] {
  const events = object(data)?.events;
  if (!Array.isArray(events)) throw new Error('Scoreboard format changed');
  if (league === 'f1'||league==='nascar-cup'||league==='nascar-truck') return parseRaceScoreboard(events,league);
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
      const rawId = text(info.id);
      const id = rawId ? `espn:${league}:${rawId}` : undefined;
      const color = text(info.color), logo = text(info.logo);
      const record = items(item.records).map(object).find(entry => entry?.type === 'total');
      return { id, aliases: [name, text(info.location), text(info.shortDisplayName), text(info.abbreviation)].filter((value): value is string => !!value), name, short: text(info.shortDisplayName) || (league === 'ncaaf' ? name : text(info.name)) || name, abbreviation: text(info.abbreviation) || name.slice(0, 3), color: color && /^[a-f0-9]{6}$/i.test(color) ? color : '566775', logo: logo?.startsWith('https://') ? logo : undefined, score: typeof item.score === 'string' || typeof item.score === 'number' ? String(item.score) : null, record: text(record?.summary) };
    };
    const status = object(event?.status) || object(competition?.status);
    const statusType = object(status?.type);
    const state = statusType?.state;
    const final = statusType?.name === 'STATUS_FINAL' && statusType.completed === true && state === 'post';
    const lifecycle: Game['lifecycle'] = final ? 'final' : state === 'in' && statusType?.completed !== true ? 'live' : statusType?.name === 'STATUS_SCHEDULED' && state === 'pre' ? 'scheduled' : 'unknown';
    const gameStatus: Game['status'] = final ? 'post' : state === 'pre' || state === 'in' ? state : 'unknown';
    const shortDetail = text(statusType?.shortDetail) || 'Status unavailable';
    const detail = statusType?.name === 'STATUS_SCHEDULED' && shortDetail !== 'TBD' && shortDetail !== 'TBA' ? 'Scheduled' : shortDetail;
    const situation = object(competition?.situation);
    const names = items(object(items(competition?.broadcasts)[0])?.names).filter((name): name is string => typeof name === 'string');
    const season = object(event?.season)?.year;
    const noFootballSituation = league === 'nba' || league === 'wnba' || league === 'ncaab' || league === 'nhl' || league === 'ncaah' || league === 'ncaawh' || league === 'mlb';
    return [ScheduleGameSchema.parse({ id: league === 'nfl' ? id : `${league}-${id}`, league, lifecycle, season: typeof season === 'number' ? season : undefined, name: text(event?.name) || `${awayTeam.displayName} at ${homeTeam.displayName}`, date: text(event?.date), home: team(home, homeTeam), away: team(away, awayTeam), status: gameStatus, detail, redzone: !noFootballSituation && situation?.isRedZone === true && gameStatus === 'in', down: noFootballSituation ? undefined : text(situation?.downDistanceText), possession: noFootballSituation ? undefined : situation?.possession === home.id ? text(homeTeam.abbreviation) : situation?.possession === away.id ? text(awayTeam.abbreviation) : undefined, lastPlay: text(object(situation?.lastPlay)?.text), venue: text(object(competition?.venue)?.fullName), broadcast: names.length ? names.join(' / ') : undefined })];
  });
}
const sessions:Record<string,{session:'practice-1'|'practice-2'|'practice-3'|'sprint-qualifying'|'sprint'|'qualifying'|'race';label:string}> = {
  FP1:{session:'practice-1',label:'Practice 1'},FP2:{session:'practice-2',label:'Practice 2'},
  FP3:{session:'practice-3',label:'Practice 3'},SS:{session:'sprint-qualifying',label:'Sprint Qualifying'},
  SR:{session:'sprint',label:'Sprint'},Qual:{session:'qualifying',label:'Qualifying'},Race:{session:'race',label:'Race'},
};
function parseRaceScoreboard(events:unknown[],league:'f1'|'nascar-cup'|'nascar-truck'):ScheduleGame[] {
  return events.flatMap(raw=>{
    const event=object(raw),eventId=text(event?.id),eventName=text(event?.name);
    const circuit=text(object(event?.circuit)?.fullName);
    const round=league==='f1'?text(object(object(event?.circuit)?.address)?.city)||eventName:
      /\bat\s+(.+)$/i.exec(eventName||'')?.[1];
    const season=object(event?.season)?.year;
    if(!eventId||!/^\d{1,20}$/.test(eventId)||!round||!eventName||league==='f1'&&!circuit)return [];
    return items(event?.competitions).flatMap(rawSession=>{
      const competition=object(rawSession),sessionId=text(competition?.id);
      const type=league==='f1'?sessions[text(object(competition?.type)?.abbreviation)||'']:
        {session:'race' as const,label:'Race'};
      const date=text(competition?.date),statusType=object(object(competition?.status)?.type);
      if(!sessionId||!/^\d{1,20}$/.test(sessionId)||!type||!date||!Number.isFinite(Date.parse(date)))return [];
      const state=statusType?.state;
      const final=statusType?.name==='STATUS_FINAL'&&statusType.completed===true&&state==='post';
      const lifecycle=final?'final':state==='in'&&statusType?.completed!==true?'live':statusType?.name==='STATUS_SCHEDULED'&&state==='pre'?'scheduled':'unknown';
      const gameStatus=final?'post':state==='pre'||state==='in'?state:'unknown';
      const broadcasts=items(object(items(competition?.broadcasts)[0])?.names).filter((name):name is string=>typeof name==='string');
      return [ScheduleGameSchema.parse({id:`${league}-${sessionId}`,league,name:league==='f1'?`${eventName} · ${type.label}`:eventName,date,
        race:{eventId,sessionId,session:type.session,round,circuit},season:typeof season==='number'?season:undefined,
        status:gameStatus,lifecycle,detail:final?'Final':lifecycle==='scheduled'?'Scheduled':text(statusType?.shortDetail)||'Status unavailable',
        broadcast:broadcasts.length?broadcasts.join(' / '):undefined})];
    });
  });
}
export function validFeedUrl(input: string): string | null {
  try { const url = new URL(input.trim()); return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function priority(game: Game): number { return (game.status === 'in' ? 100 : game.status === 'pre' ? 30 : 0) + (isRaceGame(game)?0:(game.redzone ? 60 : 0) + (game.status === 'in' && Math.abs(Number(game.home.score) - Number(game.away.score)) <= 8 ? 15 : 0)); }

export function sortGamesForDisplay<T extends Pick<Game, 'date' | 'status' | 'lifecycle'>>(games: readonly T[], now: number): T[] {
  const today = new Date(now).toDateString();
  const ranked = games.map((game, index) => {
    const timing = gameTiming(game, null);
    const start = timing.kind === 'unavailable' ? null : timing.start;
    const isToday = start !== null && new Date(start).toDateString() === today;
    const isFinal = game.lifecycle === 'final' || game.status === 'post';
    const rank = game.status === 'in' ? 0 : isToday ? (isFinal ? 2 : 1) : isFinal ? (start === null ? 6 : 5) : start === null ? 4 : 3;
    return { game, index, rank, start };
  });
  ranked.sort((a, b) => a.rank - b.rank || (a.rank === 5 ? (b.start ?? 0) - (a.start ?? 0) : (a.start ?? Infinity) - (b.start ?? Infinity)) || a.index - b.index);
  return ranked.map(({ game }) => game);
}
