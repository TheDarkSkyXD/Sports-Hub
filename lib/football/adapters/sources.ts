import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import type { Candidate, League, Observation } from '../shared.ts';
import type { ListingSource } from '../domain/ports.ts';
import { parsePlayers } from '../../sunday.ts';
import { parseStreamcenterPlayer } from '../../playback/providers/streamcenter-player.ts';

const TVAPP_API = 'https://api-backups.handleapi.win/matches/sport/american-football';
const PPV_API = 'https://api.ppv.st/api/streams';
const STREAMCENTER_CATALOG = 'https://streamcenter.st/game-cards/embed?sport=football';
export const SOURCES = [
  {id:'sportsurge',url:'https://isportsurge.ws/index6',family:'sportsurge'},
  {id:'crackstreams-cfb',url:'https://ws.crackstreams.me/cfb-streams-live42',family:'buffstream'},
  {id:'buffstream-cfb',url:'https://ms.buffstream.io/cfb-streams/',family:'buffstream'},
  {id:'livetv',url:'https://livetv.sx/enx/allupcomingsports/27/',family:'unknown'},
  {id:'vipbox-cfb',url:'https://vipbox.lc/ncaaf-schedule',family:'vipbox'},
  {id:'vipbox-nfl',url:'https://vipbox.lc/nfl-schedule',family:'vipbox'},
  {id:'crackstreams-nfl',url:'https://ws.crackstreams.me/nfl-streams-live52',family:'buffstream'},
  {id:'vipboxtv-cfb',url:'https://www.vipboxtv.sk/ncaaf-stream',family:'vipbox'},
  {id:'strikeout-nfl',url:'https://strikeout.im/nfl',family:'vipbox'},
  {id:'strikeout-football',url:'https://strikeout.im/football',family:'vipbox'},
  {id:'strikeout-cfb',url:'https://strikeout.im/ncaaf',family:'vipbox'},
  {id:'nflhunter',url:'https://nflhunter.com/home-1/',family:'unknown'},
  {id:'nflstreams',url:'https://nflstreams.org/',family:'unknown'},
  {id:'streameast',name:'StreamEast',url:'https://v2.streameast.ga/cfb-streams/',family:'streameast',kind:'browser-catalog',publicUrls:[
    'https://v2.streameast.ga/cfb-streams/','https://v2.streameast.ga/nfl-streams/',
  ]},
  {id:'buffstream-nfl',url:'https://ms.buffstream.io/nfl-streams-live-31',family:'buffstream'},
  {id:'methstreams',url:'https://methstreams.st/NFL',family:'event'},
  {id:'crackstreams-st',url:'https://crackstreams.st/NFL',family:'event'},
  {id:'tvapp',name:'TVApp',url:TVAPP_API,family:'tvapp',kind:'catalog',publicUrls:[
    'https://tvapp1.com/cfb-streams','https://tvapp1.com/nfl-streams',
    'https://thetvapp67.st/cfb-streams','https://thetvapp67.st/nfl-streams',
  ]},
  {id:'ppv',name:'PPV',url:PPV_API,family:'ppv',kind:'catalog',publicUrls:['https://ppv.st/#26']},
  {id:'streamcenter',name:'Streamcenter',url:STREAMCENTER_CATALOG,family:'streamcenter',publicUrls:['https://streame.center/']},
  {id:'sportsurge-v2',name:'Sportsurge v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog',publicUrls:[
    'https://v2.sportsurge.net/watch-cfb-streams/','https://v2.sportsurge.net/watch-nfl-streams/',
  ]},
] as const;
const vipboxSourceIds = new Set<string>(SOURCES.filter(source => source.family === 'vipbox').map(source => source.id));
export class SourceFetchError extends Error {
  readonly retryAfterMs?: number;
  constructor(message:string,retryAfterMs?:number) { super(message); this.retryAfterMs=retryAfterMs; }
}
const hosts = new Set<string>(SOURCES.map(source => new URL(source.url).hostname));
hosts.add('gooz.aapmains.net');
hosts.add('streame.center');
export function allowedDiscoveryUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && hosts.has(url.hostname) && !url.username && !url.password && !url.port; } catch { return false; }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0,24);
export async function readHtml(url: string, signal: AbortSignal): Promise<string> {
  if (url === 'https://isportsurge.ws/index6') {
    await readPage(url,signal);
    const pages: string[] = [];
    for (const category of ['https://isportsurge.ws/nfl/livestreams3','https://isportsurge.ws/cfb/livestreams2']) {
      const html = await readPage(category,signal);
      pages.push(load(html)('body').html() || '');
    }
    return `<main>${pages.join('')}</main>`;
  }
  return readPage(url,signal,url === TVAPP_API || url === PPV_API ? 'application/json' : 'text/html');
}

async function readPage(url: string, signal: AbortSignal, accept = 'text/html'): Promise<string> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedDiscoveryUrl(url)) throw new Error('unsupported-discovery-address');
    const response = await fetch(url,{redirect:'manual',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{'User-Agent':'SundayRoom/1.0',Accept:accept}});
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect-without-location');
      url = new URL(location,url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+$/.test(header) ? Number(header)*1000 : NaN;
      const date = header ? Date.parse(header)-Date.now() : NaN;
      const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : undefined;
      throw new SourceFetchError(`http-${response.status}`,delay === undefined ? undefined : Math.min(24*3600000,Math.max(0,delay)));
    }
    if (!response.body) throw new Error('empty-response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('response-too-large');
        chunks.push(result.value);
      }
    } catch(error) { await reader.cancel(); throw error; }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('redirect-limit');
}

export function parseKickoff(raw: string): number | null {
  if (/^\d{10}(?:\d{3})?$/.test(raw.trim())) {
    const epoch = Number(raw.trim()) * (raw.trim().length === 10 ? 1000 : 1);
    return Number.isFinite(epoch) && epoch >= Date.UTC(2000,0,1) && epoch < Date.UTC(2100,0,1) ? epoch : null;
  }
  const utc = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/.exec(raw)?.[0];
  if (utc) { const value = Date.parse(utc); return Number.isFinite(value) ? value : null; }
  const eastern = /\b(\d{4})-(\d{2})-(\d{2})(?:,\s*[a-z]+)?(?:\s*-\s*|[ T])(\d{1,2}):(\d{2})\s*(AM|PM)?\s*ET\b/i.exec(raw);
  if (!eastern) return null;
  let hour = Number(eastern[4]);
  if (eastern[6]) hour = hour % 12 + (eastern[6].toUpperCase() === 'PM' ? 12 : 0);
  const naive = Date.UTC(Number(eastern[1]),Number(eastern[2])-1,Number(eastern[3]),hour,Number(eastern[5]));
  const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const matches = [4,5].map(offset => naive + offset * 3600000).filter(value => {
    const parts = Object.fromEntries(formatter.formatToParts(value).map(part => [part.type,part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` === `${eastern[1]}-${eastern[2]}-${eastern[3]} ${String(hour).padStart(2,'0')}:${eastern[5]}`;
  });
  return matches.length === 1 ? matches[0] : null;
}

const CatalogTeams = z.object({home:z.object({name:z.string().min(1)}),away:z.object({name:z.string().min(1)})});
const TvappMatch = z.object({
  id:z.string().min(1),title:z.string().min(1),category:z.literal('american-football'),
  date:z.number().int(),teams:CatalogTeams.nullish(),
});
const PpvEvent = z.object({
  id:z.number().int().positive(),name:z.string().min(1),tag:z.string(),
  uri_name:z.string(),starts_at:z.number().int(),
});
const PpvCatalog = z.object({
  success:z.literal(true),streams:z.array(z.object({category:z.string(),streams:z.array(z.unknown())})),
});

function catalogTeams(title: string): [string,string] | null {
  const parts = title.split(/\s+(?:vs\.?|at|-)\s+/i).map(value => value.trim());
  return parts.length === 2 && parts.every(Boolean) ? [parts[0],parts[1]] : null;
}

function preferredCatalogTeams(title: string, structured: [string,string] | null): [string,string] | null {
  const titled = catalogTeams(title);
  if (!structured || !titled) return titled || structured;
  const related = (left: string, right: string) => {
    const a = left.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const b = right.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    return a.includes(b) || b.includes(a);
  };
  const aligned = related(titled[0],structured[0]) && related(titled[1],structured[1]) ||
    related(titled[0],structured[1]) && related(titled[1],structured[0]);
  if (!aligned) return null;
  return titled.join('').length > structured.join('').length ? titled : structured;
}

function parseCatalog(source: ListingSource, body: string, now: number): ReturnType<typeof parseListings> {
  let input: unknown;
  try { input=JSON.parse(body); } catch { return {observations:[],outcome:'parser-changed'}; }
  const byId = new Map<string,Observation>();
  const add = (observation: Observation): boolean => {
    const previous = byId.get(observation.id);
    if (previous && (previous.title !== observation.title || previous.kickoff !== observation.kickoff ||
      previous.url !== observation.url || previous.teams?.join('|') !== observation.teams?.join('|'))) return false;
    byId.set(observation.id,observation);
    return true;
  };
  const invalid = (): ReturnType<typeof parseListings> => ({observations:[],outcome:'parser-changed'});
  if (source.family === 'tvapp') {
    if (!Array.isArray(input)) return invalid();
    for (const value of input) {
      const result = TvappMatch.safeParse(value);
      if (!result.success) return invalid();
      const match = result.data;
      if (match.id === 'ppv-nfl-network' && match.title === 'NFL Network' && match.date === 0) continue;
      if (match.date < Date.UTC(2000,0,1) || match.date >= Date.UTC(2100,0,1)) return invalid();
      if (match.date > now+7*86400000) continue;
      const slug = match.id.startsWith('ppv-') || /^\d+$/.test(match.id) ? match.id : /-(\d+)$/.exec(match.id)?.[1];
      if (!slug || !/^[a-zA-Z0-9-]{1,120}$/.test(slug)) return invalid();
      const url = `https://tvapp1.com/watch/${slug}`;
      const title = match.title.replace(/\s+/g,' ').trim();
      const structured: [string,string] | null = match.teams
        ? [match.teams.home.name.trim(),match.teams.away.name.trim()]
        : null;
      const teams = preferredCatalogTeams(title,structured);
      const rawTime = new Date(match.date).toISOString();
      if (!add({id:`${source.id}:${digest(match.id)}`,sourceId:source.id,url,title,teams,
        league:null,kickoff:match.date,rawTime,observedAt:now,parserVersion:1})) return invalid();
    }
  } else if (source.family === 'ppv') {
    const result = PpvCatalog.safeParse(input);
    if (!result.success) return invalid();
    const groups = result.data.streams.filter(group => group.category === 'American Football');
    if (groups.length !== 1) return invalid();
    for (const value of groups[0].streams) {
      const result = PpvEvent.safeParse(value);
      if (!result.success) return invalid();
      const event = result.data;
      const league = event.tag === 'College Football' ? 'ncaaf' : event.tag === 'NFL' ? 'nfl' : null;
      if (!league || !event.uri_name.startsWith(`${league === 'ncaaf' ? 'cfb' : 'nfl'}/`)) continue;
      if (!/^(?:cfb|nfl)\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+$/.test(event.uri_name)) return invalid();
      if (event.starts_at <= 0) continue;
      const kickoff = event.starts_at*1000;
      if (kickoff < Date.UTC(2000,0,1) || kickoff >= Date.UTC(2100,0,1)) return invalid();
      if (kickoff > now+7*86400000) continue;
      const title = event.name.replace(/\s+/g,' ').trim();
      const pair = catalogTeams(title);
      const teams: [string,string] | null = pair && /\s+at\s+/i.test(title) ? [pair[1],pair[0]] : pair;
      const url = `https://ppv.st/live/${event.uri_name}`;
      if (!add({id:`${source.id}:${event.id}`,sourceId:source.id,url,title,teams,
        league,kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:now,parserVersion:1})) return invalid();
    }
  } else return {observations:[],outcome:'unsupported'};
  const observations = [...byId.values()];
  return {observations,outcome:observations.length ? 'parsed' : 'empty'};
}

export function parseListings(source: ListingSource, html: string, now: number): { observations: Observation[]; outcome: 'parsed' | 'empty' | 'unsupported' | 'parser-changed' } {
  if (source.kind === 'catalog') return parseCatalog(source,html,now);
  if (source.family === 'streamcenter') return parseStreamcenterListings(source,html,now);
  const $ = load(html);
  const observations = new Map<string,Observation>();
  const conflictingTeamsIds = new Set<string>();
  const conflictingTimeIds = new Set<string>();
  $('script,style,noscript').remove();
  $('a[href]').each((_index,node) => {
    const anchor = $(node);
    let url: string;
    try { url = new URL(anchor.attr('href') || '',source.url).href; } catch { return; }
    if (!allowedDiscoveryUrl(url)) return;
    const path = new URL(url).pathname;
    if (/^\/(?:nfl|cfb)\/livestreams\d*\/?$/i.test(path)) return;
    if (!/\/(?:watch\/(?:nfl|cfb)\/|onair\/(?:nfl|ncaaf)\/|(?:nfl|cfb|college-football)\/.*(?:live|stream)|(?:nfl|cfb)-streams\/.+-live-stream|event\/)/i.test(path)) return;
    const row = source.family === 'sportsurge' ? anchor : anchor.closest('tr,[data-start],article,li,.event,.match,.card').first();
    const container = row.length ? row : anchor;
    const title = anchor.text().replace(/\s+/g,' ').trim().slice(0,300);
    const imageNames = anchor.find('.team-name-event-row img[alt]').map((_i,img) => $(img).attr('alt')).get();
    const textTime = /\d{4}-\d{2}-\d{2}(?:,\s*[a-z]+)?(?:\s*-\s*|[ T])\d{1,2}:\d{2}\s*(?:AM|PM)?\s*ET\b/i.exec(title)?.[0] || '';
    const cleaned = title.replace(textTime,'').replace(/\d{1,2}:\d{2}\s*UTC.*$/i,'')
      .replace(/(?:Live)?Watch\s*→?\s*$/i,'').replace(/^\s*(?:\d{1,2}:\d{2}\s*)?/,'').replace(/\s*\bCH\s*\d+\s*$/i,'');
    const pair = cleaned.split(/\s+(?:vs\.?|versus|at|@)\s+/i).map(value => value.replace(/^#?\d+\s+/,'').trim());
    const teams: Observation['teams'] = imageNames.length === 2 ? [imageNames[0],imageNames[1]] : pair.length === 2 && pair.every(Boolean) ? [pair[0],pair[1]] : null;
    const rawTime = container.attr('datetime') || container.find('[datetime]').first().attr('datetime') ||
      container.attr('data-utc') || container.find('[data-utc]').first().attr('data-utc') ||
      container.attr('data-start') || container.find('[data-start]').first().attr('data-start') ||
      container.attr('content') || container.find('[content]').first().attr('content') || textTime;
    const inferredLeague: League | null = /\/(?:watch\/cfb|cfb|ncaaf|college-football)(?:\/|-)/i.test(path) ? 'ncaaf' : /\/(?:watch\/nfl|nfl)(?:\/|-)/i.test(path) ? 'nfl' : null;
    const league = source.family === 'event' ? null : inferredLeague;
    const id = `${source.id}:${digest(url)}`;
    const numeric = /^\/watch\/(nfl|cfb)\/[^/]+\/(\d+)$/.exec(path);
    const kickoff = parseKickoff(rawTime);
    const previous = observations.get(id);
    if (previous) {
      const conflictingTeams = previous.teams && teams &&
        previous.teams.map(value => value.toLowerCase()).sort().join('|') !== teams.map(value => value.toLowerCase()).sort().join('|');
      const conflictingTime = previous.kickoff !== null && kickoff !== null && Math.abs(previous.kickoff-kickoff)>60_000;
      if (conflictingTeams) conflictingTeamsIds.add(id);
      if (conflictingTime) conflictingTimeIds.add(id);
      observations.set(id,{...previous,teams:conflictingTeamsIds.has(id) ? null : previous.teams || teams,
        title:previous.teams ? previous.title : teams ? teams.join(' vs ') : previous.title,
        rawTime:conflictingTime ? `${previous.rawTime} | ${rawTime}` : previous.kickoff === null && kickoff !== null ? rawTime : previous.rawTime || rawTime,
        kickoff:conflictingTimeIds.has(id) ? null : previous.kickoff ?? kickoff});
      return;
    }
    observations.set(id,{id,sourceId:source.id,url,title:teams ? teams.join(' vs ') : title,teams,league,rawTime,kickoff,observedAt:now,parserVersion:1,legacyId:numeric ? `${numeric[1] === 'cfb' ? 'ncaaf-' : ''}source-${numeric[2]}` : undefined});
  });
  const values = [...observations.values()];
  const knownEmpty = /no matches available right now|sorry, no games scheduled on this date|no (?:live )?(?:games|events) (?:available|scheduled|found)/i.test($('body').text());
  return {observations:values,outcome:values.length ? 'parsed' : knownEmpty ? 'empty' : source.family === 'unknown' ? 'unsupported' : 'parser-changed'};
}

const streamcenterLink = /^\/api\/stream-link\/iframe\/event-espn-league-football-college-football-(\d{5,12})\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

function parseStreamcenterListings(source: ListingSource, html: string, now: number): ReturnType<typeof parseListings> {
  const $ = load(html);
  const observations: Observation[] = [];
  let invalid = false;
  $('article.game-card-row').each((_index,element) => {
    const card = $(element);
    if (card.find('.game-card-league').text().trim() !== 'NCAA Football') return;
    const teams = card.find('.game-card-team[title]').map((_i,node) => $(node).attr('title')?.trim()).get();
    const rawTime = card.find('time[datetime]').first().attr('datetime') || '';
    const kickoff = parseKickoff(rawTime);
    if (teams.length !== 2 || !kickoff) { invalid=true; return; }
    card.find('a.game-card-open-link[href]').each((_i,node) => {
      const href = $(node).attr('href') || '';
      const match = streamcenterLink.exec(href);
      if (!match) { invalid=true; return; }
      const url = new URL(href,'https://streamcenter.st').href;
      observations.push({id:`${source.id}:${digest(href)}`,sourceId:source.id,url,
        title:`${teams[0]} vs ${teams[1]}`,teams:[teams[0],teams[1]],league:'ncaaf',kickoff,rawTime,
        observedAt:now,parserVersion:1});
    });
  });
  if (invalid) return {observations:[],outcome:'parser-changed'};
  return {observations,outcome:observations.length ? 'parsed' : $('article.game-card-row').length ? 'empty' : 'parser-changed'};
}

export function enrichObservation(observation: Observation, html: string): Observation {
  if (observation.sourceId === 'streamcenter') return observation;
  const $ = load(html);
  if (vipboxSourceIds.has(observation.sourceId) && $('meta[property="og:url"]').first().attr('content') === observation.url) {
    const config = $('script').map((_index,node) => $(node).html()).get()
      .find(value => /\bconst\s+siteConfig\s*=\s*\{/.test(value || '')) || '';
    if (/"loaded_page"\s*:\s*"stream"/.test(config)) {
      const rawTime = /"event_start_ts"\s*:\s*(\d{10}(?:\d{3})?)\b/.exec(config)?.[1] || '';
      const kickoff = parseKickoff(rawTime);
      if (kickoff !== null) return {...observation,rawTime,kickoff};
    }
  }
  $('script,style').remove();
  const text = $('body').text().replace(/\s+/g,' ');
  const time = $('[datetime]').first().attr('datetime') || $('[data-utc]').first().attr('data-utc') || /\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}\s*(?:AM|PM)?\s*ET\b/i.exec(text)?.[0] || observation.rawTime;
  return {...observation,rawTime:time,kickoff:parseKickoff(time)};
}

export function compatiblePlayers(gameId: string, observation: Observation, html: string, now: number): Candidate[] {
  if (observation.sourceId === 'streamcenter') {
    const path = new URL(observation.url).pathname;
    const link = streamcenterLink.exec(path);
    if (!link || gameId !== `ncaaf-${link[1]}`) return [];
    if (!parseStreamcenterPlayer(html)) return [];
    return [{id:`streamcenter-${link[1]}-${link[2]}`,gameId,
      locator:{provider:'streamcenter',eventId:link[1],linkId:link[2]},label:'Streamcenter',sourceIds:[observation.sourceId],observedAt:now}];
  }
  return parsePlayers(html).map(player => ({id:`gooz-${player.id}`,gameId,locator:{provider:'gooz' as const,playerId:player.id},
    label:player.label,sourceIds:[observation.sourceId],observedAt:now}));
}
