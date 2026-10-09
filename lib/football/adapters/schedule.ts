import { parseScoreboard, scoreboardFeedData, scoreboardWeek } from '../../sunday.ts';
import { GameSchema, isRaceGame, isWrestlingGame, isWrestlingLeague } from '../shared.ts';
import { wrestlingEventKey } from '../domain/wrestling-events.ts';
import type { Game, MatchupGame, Observation, SeasonMembership } from '../shared.ts';
import type { ScheduleResult, ScheduleSource } from '../domain/ports.ts';
import { recordFinal } from '../domain/lifecycle.ts';
import { digest, parseListings, readHtml, SOURCES } from './sources.ts';

export const SCHEDULES = [
  {id:'nfl',league:'nfl',path:'nfl',group:null},
  {id:'fbs',league:'ncaaf',path:'college-football',group:'80'},
  {id:'fcs',league:'ncaaf',path:'college-football',group:'81'},
  {id:'nba',league:'nba',sport:'basketball',path:'nba',group:null},
  {id:'wnba',league:'wnba',sport:'basketball',path:'wnba',group:null},
  {id:'ncaab',league:'ncaab',sport:'basketball',path:'mens-college-basketball',group:'50'},
  {id:'nhl',league:'nhl',sport:'hockey',path:'nhl',group:null},
  {id:'ncaah',league:'ncaah',sport:'hockey',path:'mens-college-hockey',group:null},
  {id:'ncaawh',league:'ncaawh',sport:'hockey',path:'womens-college-hockey',group:null},
  {id:'mlb',league:'mlb',sport:'baseball',path:'mlb',group:null},
  {id:'f1',league:'f1',sport:'racing',path:'f1',group:null},
  {id:'nascar-cup',league:'nascar-cup',sport:'racing',path:'nascar-premier',group:null},
  {id:'nascar-truck',league:'nascar-truck',sport:'racing',path:'nascar-truck',group:null},
  {id:'motogp',league:'motogp',sport:'racing',path:'source-motogp',group:null},
  {id:'motorsport',league:'motorsport',sport:'racing',path:'source-motorsport',group:null},
  {id:'wwe',league:'wwe',path:'source-wwe',group:null},
  {id:'tna',league:'tna',path:'source-tna',group:null},
] as const;

type FutureDay = { date: string; games: Game[]; expiresAt: number };
export type ScheduleDayCache=Map<string,FutureDay>;
const futureDays = new WeakMap<AbortSignal,ScheduleDayCache>();
const FUTURE_TTL_MS = 300000;
const FUTURE_CONCURRENCY = 3;
const LISTING_TTL_MS=60_000;
export type ScheduleListingCache={snapshot?:{at:number;observations:Observation[]};
  read?:{at:number;controller:AbortController;consumers:Set<AbortSignal>;promise:Promise<Observation[]>}};
const directListingReads=new WeakMap<AbortSignal,{at:number;promise:Promise<Observation[]>}>();

export type SchedulePriority='current'|'history'|'retry'|'future';
export type SchedulePermit=<T>(url:string,priority:SchedulePriority,signal:AbortSignal,task:()=>Promise<T>)=>Promise<T>;
export type ScheduleListingReader=(url:string,signal:AbortSignal)=>Promise<string>;
const directPermit:SchedulePermit=(_url,_priority,_signal,task)=>task();

function validKickoff(date: string | undefined): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date)) return false;
  const time = Date.parse(date);
  const day = date.slice(0,10);
  const calendar = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && time >= Date.UTC(2000,0,1) && time < Date.UTC(2100,0,1) && Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0,10) === day;
}

function sameTeams(a: Pick<MatchupGame,'home' | 'away'>, b: Pick<MatchupGame,'home' | 'away'>): boolean {
  const same = (left: MatchupGame['home'], right: MatchupGame['home']) => left.id && right.id ? left.id === right.id : left.name === right.name;
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

export async function readSchedule(partition: ScheduleSource, now: number, signal: AbortSignal, onCurrent?: (result: ScheduleResult) => void,
  permit:SchedulePermit=directPermit,sharedCache?:ScheduleDayCache,listingCache?:ScheduleListingCache,
  listingReader:ScheduleListingReader=readHtml): Promise<ScheduleResult> {
  if(partition.league==='motogp'||partition.league==='motorsport'||isWrestlingLeague(partition.league))
    return readListingSchedule(partition,now,signal,onCurrent,permit,listingCache,listingReader);
  const date = (time: number) => new Date(time).toISOString().slice(0,10).replaceAll('-','');
  const today = date(now);
  const lastFutureDate = date(now + 7*24*3600000);
  let cache=sharedCache??futureDays.get(signal);
  if(!cache){cache=new Map();futureDays.set(signal,cache);}
  for (const [key, entry] of cache) {
    if (entry.date <= today || entry.date > lastFutureDate) cache.delete(key);
  }
  const futureDates = Array.from({length:7},(_,index) => date(now + (index+1)*24*3600000));
  const keyFor = (day: string) => `${partition.sport ?? 'football'}|${partition.path}|${partition.group ?? ''}|${day}`;
  const cached = futureDates.map(day => cache.get(keyFor(day)));
  const games = new Map<string,Game>();
  const horizonErrors: string[] = [];
  const fetchDay = async (day: string, priority:SchedulePriority, withWeek = false): Promise<{games:Game[];week?:number}> => {
    const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${partition.sport ?? 'football'}/${partition.path}/scoreboard`);
    const limit = partition.league === 'ncaab' ? 500 : 200;
    url.searchParams.set('limit',String(limit));
    url.searchParams.set('dates',day);
    if (partition.group) url.searchParams.set('groups',partition.group);
    const request = (requestPriority:SchedulePriority) => permit(url.href,requestPriority,signal,async () => {
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
      if ((partition.sport==='racing'?input.events.some((event:unknown)=>!event||typeof event!=='object'||!('competitions' in event)||!Array.isArray(event.competitions)||
        daily.filter(game=>game.league===partition.league&&'race' in game&&game.race.eventId===('id' in event?event.id:undefined)).length!==event.competitions.length):
        daily.length !== input.events.length) || new Set(daily.map(game => game.id)).size !== daily.length) throw new Error('schedule-incomplete-or-duplicate');
      return {games:daily,week:withWeek ? scoreboardWeek(input) : undefined};
    });
    try {return await request(priority);}
    catch(error) {
      if(signal.aborted||priority!=='current'||!(error instanceof DOMException&&error.name==='TimeoutError')&&!(error instanceof TypeError))throw error;
      return request('retry');
    }
  };
  const addGames = (daily: Game[], futureDate?: string) => {
    for (const game of daily) {
      const previous = games.get(game.id);
      if (previous) {
        if (previous.league!==game.league || isRaceGame(previous)&&isRaceGame(game)&&
          (previous.race.eventId!==game.race.eventId||previous.race.session!==game.race.session||previous.date!==game.date) ||
          !isRaceGame(previous)&&!isRaceGame(game)&&!isWrestlingGame(previous)&&!isWrestlingGame(game)&&
          (previous.home.id!==game.home.id||previous.away.id!==game.away.id)) {
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
      const supplemental=await permit(url,'current',signal,async()=>{
        const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{'User-Agent':'SundayRoom/1.0',Accept:'application/json'}});
        if (!response.ok) { await response.body?.cancel(); throw new Error(`cdn-http-${response.status}`); }
        return parseScoreboard(scoreboardFeedData(await response.json() as unknown,'cdn'),'ncaaf');
      });
      for (const extra of supplemental) {
        const game = games.get(extra.id);
        if (game && 'home' in game && 'home' in extra && !validKickoff(game.date) && validKickoff(extra.date) && sameTeams(game,extra)) games.set(game.id,GameSchema.parse({...game,date:extra.date}));
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
  };
  const yesterday=date(now-24*3600000);
  type History={kind:'complete';games:Game[]}|{kind:'failed';code:string};
  let history:History|undefined;
  const currentRead=fetchDay(today,'current',true);
  const historyRead=fetchDay(yesterday,'history').then(value=>{history={kind:'complete',games:value.games} as const;},error=>{
    history={kind:'failed',code:signal.aborted?'aborted':error instanceof DOMException&&error.name==='TimeoutError'?'timeout':
      error instanceof Error&&/^http-\d{3}$/.test(error.message)?error.message:'history-unavailable'} as const;
  });
  const current = await currentRead;
  if(history?.kind==='complete')addGames(history.games);
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
    ...(history?.kind==='complete'?{}:{historyErrors:[`${yesterday}:${history?.kind==='failed'?history.code:'pending'}`]}),
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
        const daily = (await fetchDay(day,'future')).games;
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
  await Promise.all([historyRead,...Array.from({length:FUTURE_CONCURRENCY},() => worker())]);
  horizonErrors.push(...failures.filter((failure): failure is string => failure !== undefined));
  games.clear();
  if(history?.kind==='complete')addGames(history.games);
  addGames(currentGames);
  for (let index = 0; index < refreshed.length; index++) {
    const daily = refreshed[index] ?? cached[index]?.games;
    if (daily) addGames(daily,futureDates[index]);
  }
  await supplementDates();
  return result();
}
function numericIdentity(value:string):string {
  return String(parseInt(digest(value).slice(0,12),16));
}
async function readListingSchedule(partition:ScheduleSource,now:number,signal:AbortSignal,
  onCurrent?: (result:ScheduleResult)=>void,permit:SchedulePermit=directPermit,cache?:ScheduleListingCache,
  listingReader:ScheduleListingReader=readHtml):Promise<ScheduleResult> {
  if(signal.aborted)throw signal.reason;
  const read=(active:AbortSignal)=>isWrestlingLeague(partition.league)
    ?readWrestlingListings(now,active,partition.league==='wwe',permit,listingReader)
    :readMotorsportsListings(now,active,permit,listingReader);
  if(!cache) {
    if(isWrestlingLeague(partition.league))return listingScheduleFromObservations(partition,now,await read(signal),onCurrent);
    let direct=directListingReads.get(signal);
    if(!direct||direct.at!==now){direct={at:now,promise:readMotorsportsListings(now,signal,permit,listingReader)};directListingReads.set(signal,direct);}
    return listingScheduleFromObservations(partition,now,await direct.promise,onCurrent);
  }
  let observations=cache.snapshot&&now-cache.snapshot.at<LISTING_TTL_MS?cache.snapshot.observations:undefined;
  if(!observations) {
    if(!cache.read||cache.read.at!==now) {
      const controller=new AbortController();
      const consumers=new Set<AbortSignal>();
      const promise=read(controller.signal).then(value=>{
        cache.snapshot={at:Date.now(),observations:value};
        return value;
      }).finally(()=>{if(cache.read?.promise===promise)cache.read=undefined;});
      cache.read={at:now,controller,consumers,promise};
    }
    const active=cache.read;
    active.consumers.add(signal);
    let rejectAbort:(reason:unknown)=>void=()=>{};
    const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const onAbort=()=>{active.consumers.delete(signal);if(!active.consumers.size)active.controller.abort();rejectAbort(signal.reason);};
    signal.addEventListener('abort',onAbort,{once:true});
    try {observations=await Promise.race([active.promise,aborted]);}
    finally {signal.removeEventListener('abort',onAbort);active.consumers.delete(signal);}
  }
  return listingScheduleFromObservations(partition,now,observations,onCurrent);
}
function listingScheduleFromObservations(partition:ScheduleSource,now:number,observations:Observation[],
  onCurrent?: (result:ScheduleResult)=>void):ScheduleResult {
  const unique=new Map<string,Game>();
  for(const observation of observations){
    if(observation.league!==partition.league||observation.kickoff===null||
      observation.kickoff<now-24*3600_000||observation.kickoff>now+7*24*3600_000)continue;
    const title=observation.title;
    if(isWrestlingLeague(partition.league)){
      const key=wrestlingEventKey(partition.league,title,observation.kickoff);
      if(!key)continue;
      const eventId=numericIdentity(key);
      const status=observation.kickoff>now?'pre':'unknown';
      const game=GameSchema.parse({id:`${partition.league}-${eventId}`,league:partition.league,name:title,
        date:new Date(observation.kickoff).toISOString(),wrestling:{eventId},status,
        lifecycle:status==='pre'?'scheduled':'unknown',detail:status==='pre'?'Scheduled':'Status unavailable',
        partitions:[partition.id]});
      const previous=unique.get(game.id);
      if(previous&&Math.abs(Date.parse(previous.date||'')-Date.parse(game.date||''))>90*60_000)
        throw new Error('source-schedule-conflicting-event');
      unique.set(game.id,game);
      continue;
    }
    const practice=/\b(?:free\s+)?practice\s*([1-4])\b|\bfp([1-4])\b/i.exec(title);
    const practiceNumber=practice?.[1]||practice?.[2];
    const session=/sprint[\s-]*(?:qualifying|quali|shootout)/i.test(title)?'sprint-qualifying':
      /\bsprint\b/i.test(title)?'sprint':/\bqualifying\b|\bquali\b/i.test(title)?'qualifying':
      practiceNumber==='2'?'practice-2':practiceNumber==='3'?'practice-3':practiceNumber==='4'?'practice-4':
      practiceNumber==='1'?'practice-1':/\bpractice\b/i.test(title)?'practice':'race';
    const round=title.replace(/\s*[-—]\s*(?:free\s+)?(?:practice\s*[1-4]?|sprint(?:\s+qualifying)?|qualifying|race)$/i,'').trim();
    const eventId=numericIdentity(`${partition.league}|${round}`);
    const sessionId=numericIdentity(`${partition.league}|${title}|${observation.kickoff}`);
    const status=observation.kickoff>now?'pre':'unknown';
    const lifecycle=observation.kickoff>now?'scheduled':'unknown';
    const game=GameSchema.parse({id:`${partition.league}-${sessionId}`,league:partition.league,name:title,
      date:new Date(observation.kickoff).toISOString(),race:{eventId,sessionId,session,round},status,lifecycle,
      detail:status==='pre'?'Scheduled':'Status unavailable',partitions:[partition.id]});
    unique.set(game.id,game);
  }
  const result={games:[...unique.values()],at:Date.now(),league:partition.league};
  onCurrent?.(result);
  return result;
}
async function readWrestlingListings(now:number,signal:AbortSignal,includePpv:boolean,permit:SchedulePermit,
  listingReader:ScheduleListingReader):Promise<Observation[]> {
  const sources=SOURCES.filter(source=>source.id==='streamed'||source.id==='livesportpro'||includePpv&&source.id==='ppv');
  const settled=await Promise.allSettled(sources.map(async source=>{
    let html:string;
    try{html=await permit(source.url,'current',signal,()=>listingReader(source.url,signal));}
    catch(error){
      if(signal.aborted||!(error instanceof DOMException&&error.name==='TimeoutError'))throw error;
      html=await permit(source.url,'retry',signal,()=>listingReader(source.url,signal));
    }
    const result=parseListings(source,html,now);
    if(result.outcome==='parser-changed'||result.outcome==='unsupported')throw new Error('source-schedule-unavailable');
    return result.observations.filter(row=>row.league==='wwe'||row.league==='tna');
  }));
  if(signal.aborted)throw signal.reason;
  const results=settled.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
  if(!results.length)throw new Error('source-schedule-unavailable');
  return results.flat();
}
async function readMotorsportsListings(now:number,signal:AbortSignal,permit:SchedulePermit,
  listingReader:ScheduleListingReader):Promise<Observation[]> {
  const sources=SOURCES.filter(source=>source.family==='motorsports');
  const results=await Promise.allSettled(sources.map(async source=>{
    let html:string;
    try{html=await permit(source.url,'current',signal,()=>listingReader(source.url,signal));}
    catch(error){
      if(signal.aborted||!(error instanceof DOMException&&error.name==='TimeoutError'))throw error;
      html=await permit(source.url,'retry',signal,()=>listingReader(source.url,signal));
    }
    return parseListings(source,html,now);
  }));
  if(signal.aborted)throw signal.reason??new DOMException('Aborted','AbortError');
  const collected=results.flatMap(result=>result.status==='fulfilled'&&result.value.outcome!=='parser-changed'?[result.value]:[]);
  if(!collected.length)throw new Error('source-schedule-unavailable');
  return collected.flatMap(result=>result.observations);
}
