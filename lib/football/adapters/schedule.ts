import { parseScoreboard, scoreboardFeedData, scoreboardWeek } from '../../sunday.ts';
import { GameSchema } from '../shared.ts';
import type { Game, SeasonMembership } from '../shared.ts';
import type { ScheduleResult, ScheduleSource } from '../domain/ports.ts';
import { recordFinal } from '../domain/lifecycle.ts';

export const SCHEDULES = [
  {id:'nfl',league:'nfl',path:'nfl',group:null},
  {id:'fbs',league:'ncaaf',path:'college-football',group:'80'},
  {id:'fcs',league:'ncaaf',path:'college-football',group:'81'},
  {id:'nba',league:'nba',sport:'basketball',path:'nba',group:null},
  {id:'wnba',league:'wnba',sport:'basketball',path:'wnba',group:null},
  {id:'ncaab',league:'ncaab',sport:'basketball',path:'mens-college-basketball',group:'50'},
] as const;

type FutureDay = { date: string; games: Game[]; expiresAt: number };
const futureDays = new WeakMap<AbortSignal, Map<string, FutureDay>>();
const FUTURE_TTL_MS = 300000;
const FUTURE_CONCURRENCY = 3;

function validKickoff(date: string | undefined): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date)) return false;
  const time = Date.parse(date);
  const day = date.slice(0,10);
  const calendar = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && time >= Date.UTC(2000,0,1) && time < Date.UTC(2100,0,1) && Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0,10) === day;
}

function sameTeams(a: Pick<Game,'home' | 'away'>, b: Pick<Game,'home' | 'away'>): boolean {
  const same = (left: Game['home'], right: Game['home']) => left.id && right.id ? left.id === right.id : left.name === right.name;
  return same(a.home,b.home) && same(a.away,b.away);
}

export async function readSeasonMembership(season: number, signal: AbortSignal): Promise<SeasonMembership> {
  if (!Number.isInteger(season) || season < 2000 || season > 2100) throw new Error('invalid-season');
  const teams: SeasonMembership['teams'] = {};
  for (const [group, subdivision] of [[80,'fbs'],[81,'fcs']] as const) {
    const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/types/2/groups/${group}/teams?limit=1000`;
    const response = await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{'User-Agent':'SundayRoom/1.0',Accept:'application/json'}});
    if (!response.ok) { await response.body?.cancel(); throw new Error(`membership-http-${response.status}`); }
    const input: unknown = await response.json();
    if (!input || typeof input !== 'object' ||
      !('count' in input) || !('pageCount' in input) || !('pageIndex' in input) || !('items' in input) ||
      typeof input.count !== 'number' || !Number.isInteger(input.count) || input.count < 1 || input.count > 1000 ||
      input.pageCount !== 1 || input.pageIndex !== 1 || !Array.isArray(input.items) || input.items.length !== input.count) {
      throw new Error('membership-incomplete');
    }
    const ids = new Set<string>();
    for (const item of input.items) {
      if (!item || typeof item !== 'object' || !('$ref' in item) || typeof item.$ref !== 'string') throw new Error('membership-invalid-ref');
      let ref: URL;
      try { ref = new URL(item.$ref); } catch { throw new Error('membership-invalid-ref'); }
      const match = new RegExp(`^/v2/sports/football/leagues/college-football/seasons/${season}/teams/(\\d{1,20})$`).exec(ref.pathname);
      if (ref.hostname !== 'sports.core.api.espn.com' || !['http:','https:'].includes(ref.protocol) || ref.username || ref.password || ref.port || !match || ids.has(match[1])) throw new Error('membership-invalid-ref');
      ids.add(match[1]);
    }
    for (const id of ids) {
      if (teams[id]) throw new Error('membership-overlapping-groups');
      teams[id] = subdivision;
    }
  }
  return {season,at:Date.now(),teams};
}

export async function readSchedule(partition: ScheduleSource, now: number, signal: AbortSignal, onCurrent?: (result: ScheduleResult) => void): Promise<ScheduleResult> {
  const date = (time: number) => new Date(time).toISOString().slice(0,10).replaceAll('-','');
  const today = date(now);
  const lastFutureDate = date(now + 7*24*3600000);
  let cache = futureDays.get(signal);
  if (!cache) {
    cache = new Map();
    futureDays.set(signal,cache);
  }
  for (const [key, entry] of cache) {
    if (entry.date <= today || entry.date > lastFutureDate) cache.delete(key);
  }
  const futureDates = Array.from({length:7},(_,index) => date(now + (index+1)*24*3600000));
  const keyFor = (day: string) => `${partition.sport ?? 'football'}|${partition.path}|${partition.group ?? ''}|${day}`;
  const cached = futureDates.map(day => cache.get(keyFor(day)));
  const games = new Map<string,Game>();
  const horizonErrors: string[] = [];
  const fetchDay = async (day: string, withWeek = false): Promise<{games:Game[];week?:number}> => {
    const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${partition.sport ?? 'football'}/${partition.path}/scoreboard`);
    const limit = partition.league === 'ncaab' ? 500 : 200;
    url.searchParams.set('limit',String(limit));
    url.searchParams.set('dates',day);
    if (partition.group) url.searchParams.set('groups',partition.group);
    const request = async () => {
      const response = await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{'User-Agent':'SundayRoom/1.0',Accept:'application/json'}});
      if (!response.ok) { await response.body?.cancel(); throw new Error(`http-${response.status}`); }
      const input: unknown = await response.json();
      if (!input || typeof input !== 'object' || !('events' in input) || !Array.isArray(input.events)) throw new Error('scoreboard-format-changed');
      if (input.events.length >= limit) throw new Error('schedule-may-be-truncated');
      const daily = parseScoreboard(input,partition.league).map(game => {
        return GameSchema.parse(game.lifecycle === 'final'
          ? recordFinal({...game,partitions:[partition.id]},now)
          : {...game,partitions:[partition.id]});
      });
      if (daily.length !== input.events.length || new Set(daily.map(game => game.id)).size !== daily.length) throw new Error('schedule-incomplete-or-duplicate');
      return {games:daily,week:withWeek ? scoreboardWeek(input) : undefined};
    };
    try {return await request();}
    catch(error) {
      if(signal.aborted||!(error instanceof DOMException&&error.name==='TimeoutError'))throw error;
      return request();
    }
  };
  const addGames = (daily: Game[], futureDate?: string) => {
    for (const game of daily) {
      const previous = games.get(game.id);
      if (previous) {
        if (previous.home.id !== game.home.id || previous.away.id !== game.away.id) {
          if (futureDate) horizonErrors.push(`${futureDate}:schedule-conflicting-event`);
          else throw new Error('schedule-conflicting-event');
        }
        if (!futureDate) games.set(game.id,game);
        continue;
      }
      games.set(game.id,game);
    }
  };
  const supplementDates = async () => {
    if (partition.league !== 'ncaaf' || !partition.group || ![...games.values()].some(game => !validKickoff(game.date))) return;
    try {
      const url = `https://cdn.espn.com/core/college-football/scoreboard?xhr=1&limit=500&group=${partition.group}`;
      const response = await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{'User-Agent':'SundayRoom/1.0',Accept:'application/json'}});
      if (!response.ok) { await response.body?.cancel(); throw new Error(`cdn-http-${response.status}`); }
      const supplemental = parseScoreboard(scoreboardFeedData(await response.json() as unknown,'cdn'),'ncaaf');
      for (const extra of supplemental) {
        const game = games.get(extra.id);
        if (game && !validKickoff(game.date) && validKickoff(extra.date) && sameTeams(game,extra)) games.set(game.id,GameSchema.parse({...game,date:extra.date}));
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
  };
  addGames((await fetchDay(date(now - 24*3600000))).games);
  const current = await fetchDay(today,true);
  addGames(current.games);
  const currentIds = new Set(games.keys());
  for (let index = 0; index < futureDates.length; index++) {
    const entry = cached[index];
    if (!entry) continue;
    addGames(entry.games,futureDates[index]);
  }
  await supplementDates();
  const currentGames = [...games.values()].filter(game => currentIds.has(game.id));
  const result = (): ScheduleResult => ({games:[...games.values()],week:current.week,league:partition.league,at:Date.now(),
    ...(horizonErrors.length ? {horizonErrors:[...new Set(horizonErrors)]} : {})});
  horizonErrors.length = 0;
  onCurrent?.(result());

  const refreshed: Array<Game[] | undefined> = Array.from({length:7});
  const failures: Array<string | undefined> = Array.from({length:7});
  let next = 0;
  const worker = async () => {
    while (next < futureDates.length) {
      const index = next++;
      const day = futureDates[index];
      const entry = cached[index];
      if (entry && entry.expiresAt > now) continue;
      try {
        const daily = (await fetchDay(day)).games;
        refreshed[index] = daily;
        cache.set(keyFor(day),{date:day,games:daily,expiresAt:now+FUTURE_TTL_MS});
      } catch (error) {
        if (signal.aborted) throw error;
        const code = error instanceof Error && (/^http-\d{3}$/.test(error.message) ||
          ['scoreboard-format-changed','schedule-may-be-truncated','schedule-incomplete-or-duplicate'].includes(error.message))
          ? error.message : error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'future-unavailable';
        failures[index] = `${day}:${code}`;
      }
    }
  };
  await Promise.all(Array.from({length:FUTURE_CONCURRENCY},() => worker()));
  horizonErrors.push(...failures.filter((failure): failure is string => failure !== undefined));
  games.clear();
  addGames(currentGames);
  for (let index = 0; index < refreshed.length; index++) {
    const daily = refreshed[index] ?? cached[index]?.games;
    if (daily) addGames(daily,futureDates[index]);
  }
  await supplementDates();
  return result();
}
