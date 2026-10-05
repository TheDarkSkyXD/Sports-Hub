import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import type { League, MissingPlayerReason, Observation, ResolvedPlayer } from '../shared.ts';
import type { ListingSource } from '../domain/ports.ts';
import { parsePlayers } from '../../sunday.ts';
import { parseStreamcenterPlayer } from '../../playback/providers/streamcenter-player.ts';
import { validEventPagePair } from '../../playback/providers/event-page-policy.ts';
import { SWAC_CATALOG_URL, parseSwacEvent, swacApiUrl, swacProgramId, swacProgramUrl } from '../../playback/providers/swac-catalog.ts';
import {enrichLiveTvObservation,liveTvPlayers,parseLiveTvListings} from './livetv.ts';
import {nflstreamsPlayers,parseNflstreamsListings} from './nflstreams.ts';
import {buffstreamPlayers} from './buffstream.ts';

const TVAPP_API = 'https://api-backups.handleapi.win/matches/sport/american-football';
const PPV_API = 'https://api.ppv.st/api/streams';
const STREAMCENTER_CATALOG = 'https://streamcenter.st/game-cards/embed?sport=football';
export const SOURCES = [
  {id:'sportsurge',url:'https://isportsurge.ws/index6',family:'sportsurge'},
  {id:'crackstreams-cfb',url:'https://ws.crackstreams.me/cfb-streams-live42',family:'buffstream'},
  {id:'buffstream-cfb',url:'https://ms.buffstream.io/cfb-streams-live-26',family:'buffstream'},
  {id:'livetv',name:'LiveTV',url:'https://livetv.sx/enx/allupcomingsports/27/',family:'livetv'},
  {id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'},
  {id:'vipbox-nfl',url:'https://vipbox.fm/nfl-schedule',family:'vipbox'},
  {id:'vipboxtv-cfb',url:'https://www.vipboxtv.sk/ncaaf-stream',family:'vipbox'},
  {id:'strikeout-nfl',name:'Strikeout NFL',url:'https://strikeout.im/nfl',family:'vipbox'},
  {id:'strikeout-cfb',url:'https://strikeout.im/ncaaf',family:'vipbox'},
  {id:'nflstreams',name:'NFLStreams',url:'https://nflstreams.org/',family:'nflstreams',parserVersion:4},
  {id:'streameast',name:'StreamEast',url:'https://v2.streameast.ga/cfb-streams/',family:'streameast',kind:'browser-catalog',publicUrls:[
    'https://v2.streameast.ga/cfb-streams/','https://v2.streameast.ga/nfl-streams/',
  ]},
  {id:'buffstream-nfl',url:'https://ms.buffstream.io/nfl-streams-live-31',family:'buffstream'},
  {id:'methstreams',url:'https://methstreams.st/NFL',family:'event'},
  {id:'crackstreams-st',name:'Crackstreams NFL',url:'https://crackstreams.st/NFL',family:'event'},
  {id:'tvapp',name:'TVApp',url:TVAPP_API,family:'tvapp',kind:'catalog',publicUrls:[
    'https://tvapp1.pk/cfb-streams','https://tvapp1.pk/nfl-streams',
    'https://thetvapp67.st/cfb-streams','https://thetvapp67.st/nfl-streams',
  ]},
  {id:'ppv',name:'PPV',url:PPV_API,family:'ppv',kind:'catalog',publicUrls:['https://ppv.st/#26']},
  {id:'streamcenter',name:'Streamcenter',url:STREAMCENTER_CATALOG,family:'streamcenter',publicUrls:['https://streame.center/']},
  {id:'sportsurge-v2',name:'Sportsurge v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog',publicUrls:[
    'https://v2.sportsurge.net/watch-cfb-streams/','https://v2.sportsurge.net/watch-nfl-streams/',
  ]},
  {id:'swac',name:'SWAC TV',url:SWAC_CATALOG_URL,family:'swac',kind:'catalog',publicUrls:['https://tv.swac.org/']},
] as const;
const vipboxSourceIds = new Set<string>(SOURCES.filter(source => source.family === 'vipbox').map(source => source.id));
function vipboxMatchupTitle(sourceId:string,title:string):string {
  return sourceId==='vipbox-nfl'||sourceId==='strikeout-nfl'
    ?title.replace(/^MNF with Peyton and Eli-/,''):title;
}
export class SourceFetchError extends Error {
  readonly retryAfterMs?: number;
  constructor(message:string,retryAfterMs?:number) { super(message); this.retryAfterMs=retryAfterMs; }
}
const hosts = new Set<string>(SOURCES.map(source => new URL(source.url).hostname));
hosts.add('gooz.aapmains.net');
hosts.add('streame.center');
export function allowedDiscoveryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if(url.hostname==='ott.gideo.video')return value===SWAC_CATALOG_URL || /^[a-f0-9]{32}$/.test(url.searchParams.get('VideoID') || '') && value===swacApiUrl('getVideo',url.searchParams.get('VideoID') || '');
    if(url.hostname==='tv.swac.org')return swacProgramId(value)!==null;
    return hosts.has(url.hostname) || !url.search && !url.hash && (
      url.hostname === 'tvapp1.pk' && /^\/watch\/[a-zA-Z0-9-]{1,120}$/.test(url.pathname) ||
      url.hostname === 'ppv.st' && /^\/live\/(?:cfb|nfl)\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+$/.test(url.pathname));
  } catch { return false; }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0,24);
export async function readHtml(url: string, signal: AbortSignal): Promise<string> {
  const swacId=swacProgramId(url);
  if(swacId)return readPage(swacApiUrl('getVideo',swacId),signal,'application/json');
  if (allowedDiscoveryUrl(url) && new URL(url).hostname === 'ppv.st') {
    const body = await readPage(PPV_API,signal,'application/json');
    const parsed = PpvCatalog.safeParse(JSON.parse(body));
    if (!parsed.success) throw new Error('parser-changed');
    const path = new URL(url).pathname.slice('/live/'.length);
    const events = parsed.data.streams.filter(group => group.category === 'American Football')
      .flatMap(group => group.streams).filter(value => {
        const event = PpvEvent.safeParse(value);
        return event.success && event.data.uri_name === path;
      });
    if (events.length !== 1) throw new Error('parser-changed');
    return JSON.stringify(events[0]);
  }
  if (url === 'https://isportsurge.ws/index6') {
    await readPage(url,signal);
    const pages: string[] = [];
    for (const category of ['https://isportsurge.ws/nfl/livestreams3','https://isportsurge.ws/cfb/livestreams2']) {
      const html = await readPage(category,signal);
      pages.push(load(html)('body').html() || '');
    }
    return `<main>${pages.join('')}</main>`;
  }
  return readPage(url,signal,url === TVAPP_API || url === PPV_API || url === SWAC_CATALOG_URL ? 'application/json' : 'text/html');
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
  if (source.family === 'swac') {
    if(!Array.isArray(input))return invalid();
    for(const value of input){
      const parsed=parseSwacEvent(value);
      if(!parsed || parsed.kickoff>now+7*86400000 || parsed.kickoff<now-12*3600000)continue;
      const {event,teams,kickoff}=parsed;
      if(!add({id:`${source.id}:${event.id}`,sourceId:source.id,url:swacProgramUrl(event.id),title:teams.join(' vs '),teams,
        league:'ncaaf',kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:now,parserVersion:1}))return invalid();
    }
  } else if (source.family === 'tvapp') {
    if (!Array.isArray(input)) return invalid();
    for (const value of input) {
      const result = TvappMatch.safeParse(value);
      if (!result.success) return invalid();
      const match = result.data;
      if (match.id === 'ppv-nfl-network' && match.title === 'NFL Network' && match.date === 0) continue;
      if (match.date < Date.UTC(2000,0,1) || match.date >= Date.UTC(2100,0,1)) return invalid();
      if (match.date > now+7*86400000) continue;
      const title = match.title.replace(/\s+/g,' ').trim();
      const structured: [string,string] | null = match.teams
        ? [match.teams.home.name.trim(),match.teams.away.name.trim()]
        : null;
      const teams = preferredCatalogTeams(title,structured);
      if (!teams && !catalogTeams(title)) continue;
      const slug = match.id.startsWith('ppv-') || /^\d+$/.test(match.id) ? match.id : /-(\d+)$/.exec(match.id)?.[1];
      if (!slug || !/^[a-zA-Z0-9-]{1,120}$/.test(slug)) return invalid();
      const url = `https://tvapp1.pk/watch/${slug}`;
      const rawTime = new Date(match.date).toISOString();
      if (!add({id:`${source.id}:${digest(match.id)}`,sourceId:source.id,url,title,teams,
        league:null,kickoff:match.date,rawTime,observedAt:now,parserVersion:2})) return invalid();
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
        league,kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:now,parserVersion:2})) return invalid();
    }
  } else return {observations:[],outcome:'unsupported'};
  const observations = [...byId.values()];
  return {observations,outcome:observations.length ? 'parsed' : 'empty'};
}

export function parseListings(source: ListingSource, html: string, now: number): { observations: Observation[]; outcome: 'parsed' | 'empty' | 'unsupported' | 'parser-changed' } {
  if (source.kind === 'catalog') return parseCatalog(source,html,now);
  if (source.family === 'livetv') return parseLiveTvListings(source,html,now);
  if (source.id === 'nflstreams') return parseNflstreamsListings(source,html,now);
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
    const publishedUrl = new URL(url);
    if (source.family === 'buffstream' && publishedUrl.protocol === 'http:' &&
      publishedUrl.hostname === 'ms.buffstream.io' && !publishedUrl.username && !publishedUrl.password &&
      !publishedUrl.port && !publishedUrl.search && !publishedUrl.hash &&
      /^\/(?:nfl|cfb)-streams\/[a-z0-9-]+-live-stream$/.test(publishedUrl.pathname)) {
      publishedUrl.protocol = 'https:';
      url = publishedUrl.href;
    }
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
    const matchupTitle = vipboxMatchupTitle(source.id,cleaned);
    const pair = matchupTitle.split(/\s+(?:vs\.?|versus|at|@)\s+/i).map(value => value.replace(/^#?\d+\s+/,'').trim());
    const structuredNames = source.family === 'event'
      ? anchor.find('.ev-side .nm-l').map((_i,node) => $(node).text().trim()).get() : [];
    const rowTeams = source.family === 'buffstream' ? container.find('a[href]').toArray().flatMap(node => {
      const teamAnchor = $(node);
      const href = teamAnchor.attr('href') || '';
      return /^https?:\/\/ms\.buffstream\.io\/(?:nfl|cfb)-streams\/[a-z0-9-]+-live-stream$/.test(href)
        ? [teamAnchor.text().replace(/\s+Live Stream\s*$/i,'').trim()] : [];
    }) : [];
    const fullNames = structuredNames.length ? structuredNames : rowTeams.length === 2 ? rowTeams : [];
    const teams: Observation['teams'] = fullNames.length === 2 && fullNames.every(Boolean)
      ? [fullNames[0],fullNames[1]] : fullNames.length ? null : imageNames.length === 2
      ? [imageNames[0],imageNames[1]] : pair.length === 2 && pair.every(Boolean) ? [pair[0],pair[1]] : null;
    const rawTime = container.attr('datetime') || container.find('[datetime]').first().attr('datetime') ||
      container.attr('data-utc') || container.find('[data-utc]').first().attr('data-utc') ||
      container.attr('data-start') || container.find('[data-start]').first().attr('data-start') ||
      container.attr('content') || container.find('[content]').first().attr('content') || textTime ||
      (source.id==='buffstream-nfl'?container.find('td').toArray().map(cell=>$(cell).text().trim())
        .find(text=>/^(?:0?[1-9]|1[0-2]):[0-5]\d\s*(?:am|pm)\s*ET$/i.test(text))||'':'');
    const inferredLeague: League | null = /\/(?:watch\/cfb|cfb|ncaaf|college-football)(?:\/|-)/i.test(path) ? 'ncaaf' : /\/(?:watch\/nfl|nfl)(?:\/|-)/i.test(path) ? 'nfl' : null;
    const section = source.family === 'event' ? anchor.closest('section.lg').attr('id') || '' : '';
    const league = /college-football/.test(section) ? 'ncaaf' : source.family === 'event' ? null : inferredLeague;
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
    observations.set(id,{id,sourceId:source.id,url,title:matchupTitle!==cleaned ? cleaned : teams ? teams.join(' vs ') : title,teams,league,rawTime,kickoff,observedAt:now,parserVersion:2,legacyId:numeric ? `${numeric[1] === 'cfb' ? 'ncaaf-' : ''}source-${numeric[2]}` : undefined});
  });
  const values = [...observations.values()];
  const knownEmpty = /no matches available right now|sorry, no games scheduled on this date|no (?:live )?(?:games|events) (?:available|scheduled|found)/i.test($('body').text());
  const vipboxCollegeEmpty = source.id==='vipbox-cfb' && $('meta[property="og:url"]').first().attr('content')===source.url &&
    (/^No Match'?s Today for NCAAF$/i.test($('h3.card-header').first().text().replace(/\s+/g,' ').trim()) ||
      /Not able to find any match\/event on NCAAF today\./i.test($('body').text()));
  return {observations:values,outcome:values.length ? 'parsed' : knownEmpty||vipboxCollegeEmpty ? 'empty' : source.family === 'unknown' ? 'unsupported' : 'parser-changed'};
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
        observedAt:now,parserVersion:2});
    });
  });
  if (invalid) return {observations:[],outcome:'parser-changed'};
  return {observations,outcome:observations.length ? 'parsed' : $('article.game-card-row').length ? 'empty' : 'parser-changed'};
}

export function enrichObservation(observation: Observation, html: string): Observation {
  if(observation.sourceId==='livetv')return enrichLiveTvObservation(observation,html);
  if(observation.sourceId==='nflstreams')return observation;
  if(observation.sourceId==='buffstream-nfl')return observation;
  if (['streamcenter','ppv','tvapp','swac'].includes(observation.sourceId)) return observation;
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

const PpvPlayer = z.object({
  id:z.number().int().positive(),name:z.string(),tag:z.string(),uri_name:z.string(),
  iframe:z.string().url().optional(),source_tag:z.string().optional(),
  premium:z.boolean().optional(),paid:z.boolean().optional(),
});
const PpvPlayerEvent = PpvPlayer.extend({starts_at:z.number().int().positive(),substreams:z.array(PpvPlayer).default([])});
function goozPlayers(html:string):ResolvedPlayer[] {
  const $ = load(html);
  $('script,style').remove();
  return parsePlayers($.html())
    .map(player => ({id:`gooz-${player.id}`,locator:{provider:'gooz',playerId:player.id},label:player.label}));
}

function vipboxPageTeams(sourceId:string,html:string):[string,string] | null {
  const $ = load(html);
  const title = $('h1').first().text().replace(/\s+/g,' ').trim();
  const matchup = sourceId.startsWith('vipbox-') ? /^(.*?) Streaming Online$/i.exec(title)?.[1] :
    sourceId.startsWith('vipboxtv-') ? /^Watch (.*?) Online$/i.exec(title)?.[1] :
    sourceId.startsWith('strikeout-') ? /^Live (.*?) Streams Online$/i.exec(title)?.[1] : undefined;
  const teams = matchup ? vipboxMatchupTitle(sourceId,matchup).split(/\s+vs\.?\s+/i).map(value=>value.trim()) : null;
  return teams?.length === 2 && teams.every(Boolean) ? [teams[0],teams[1]] : null;
}

function eventPagePlayer(gameId:string,eventUrl:string,serverUrl:string,label:string):ResolvedPlayer | null {
  return validEventPagePair(eventUrl,serverUrl) ? {
    id:`event-page:${digest(JSON.stringify([gameId,eventUrl,serverUrl]))}`,label,
    locator:{provider:'event-page',gameId,eventUrl,serverUrl},
  } : null;
}

const ChannelEventBase = z.object({
  '@type':z.literal('SportsEvent'),url:z.string().url(),name:z.string(),startDate:z.string(),
  offers:z.object({price:z.union([z.string(),z.number()])}),
});
const ChannelTeam = z.object({name:z.string()});
const ChannelEvent = z.union([
  ChannelEventBase.extend({homeTeam:ChannelTeam,awayTeam:ChannelTeam}),
  ChannelEventBase.extend({performer:z.array(ChannelTeam).length(1),homeTeam:z.never().optional(),awayTeam:z.never().optional()}),
]);

export function missingPlayerReason(observation:Observation,html:string):MissingPlayerReason {
  if(!['tvapp','methstreams','crackstreams-st','sportsurge','livetv'].includes(observation.sourceId))return 'no-compatible-media';
  const $=load(html);
  $('script,style,noscript').remove();
  const text=$('body').text().replace(/\s+/g,' ').trim();
  if(observation.sourceId==='livetv')return !$('a[href]').toArray().some(node=>
    /webplayer\.php/i.test($(node).attr('href')||''))&&
    /Live streams will be available approximately 30 minutes before the broadcast's start\./i.test(text)?
      'not-yet-published':'no-compatible-media';
  if(/(?:this |the )?stream (?:will be|is going to be) available (?:shortly|soon)|stream (?:has not|hasn't) started yet/i.test(text))return 'not-yet-published';
  if(/no channels? (?:is |are )?available/i.test(text))return 'no-published-player';
  if(observation.sourceId==='sportsurge'&&$('iframe').length===1&&
    $('iframe').attr('src')==='https://gooz.aapmains.net/new-stream-embed/'&&
    !$('video[src],audio[src],source[src]').length&&!/\bchangeStream\s*\(\s*['"]?\d+/.test(html))return 'no-published-player';
  return 'no-compatible-media';
}

export function compatiblePlayers(gameId: string, observation: Observation, html: string): ResolvedPlayer[] {
  if(observation.sourceId==='livetv')return liveTvPlayers(gameId,observation,html);
  if(observation.sourceId==='nflstreams')return nflstreamsPlayers(gameId,observation,html);
  if(observation.sourceId==='buffstream-nfl')return buffstreamPlayers(gameId,observation,html);
  if(observation.sourceId==='swac'){
    let input:unknown;
    try{input=JSON.parse(html);}catch{return [];}
    const parsed=parseSwacEvent(input);
    if(!parsed || observation.url!==swacProgramUrl(parsed.event.id) || observation.kickoff!==parsed.kickoff ||
      observation.title!==parsed.teams.join(' vs ') || observation.teams?.join('|')!==parsed.teams.join('|'))return [];
    return [{id:`swac:${parsed.event.id}`,locator:{provider:'swac',eventId:parsed.event.id},label:'SWAC TV'}];
  }
  if (observation.sourceId === 'tvapp') {
    if(missingPlayerReason(observation,html)==='not-yet-published')return [];
    const $=load(html);
    if(!observation.teams || observation.kickoff===null || $('link[rel="canonical"]').attr('href')!==observation.url ||
      $('meta[property="og:url"]').attr('content')!==observation.url ||
      $('meta[property="og:title"]').attr('content')!==`${observation.title} - Live Stream Free in HD | TheTVApp` ||
      !$('meta[name="description"]').attr('content')?.startsWith(`Watch ${observation.title} live stream free in HD on TheTVApp.`) ||
      $('#player-frame').length!==1)return [];
    const player=eventPagePlayer(gameId,observation.url,observation.url,'TVApp');
    return player?[player]:[];
  }
  if (observation.sourceId === 'methstreams' || observation.sourceId === 'crackstreams-st') {
    const $ = load(html);
    const host=observation.sourceId==='methstreams'?'methstreams.st':'crackstreams.st';
    if(new URL(observation.url).hostname!==host || !observation.teams || observation.kickoff===null ||
      $('link[rel="canonical"]').attr('href')!==observation.url || $('meta[property="og:url"]').attr('content')!==observation.url)return [];
    const events=$('script[type="application/ld+json"]').toArray().flatMap(node=>{
      try {const parsed=ChannelEvent.safeParse(JSON.parse($(node).text()));return parsed.success?[parsed.data]:[];}catch{return [];}
    });
    const identity=(teams:readonly string[])=>teams.map(team=>team.toLowerCase().replace(/\s+/g,' ').trim()).sort().join('|');
    const event=events.find(value=>{
      const namedTeams=catalogTeams(value.name);
      if(value.url!==observation.url || Date.parse(value.startDate)!==observation.kickoff || !namedTeams ||
        identity(namedTeams)!==identity(observation.teams || []))return false;
      return 'performer' in value
        ? value.performer?.[0]?.name===value.name
        : identity([value.homeTeam.name,value.awayTeam.name])===identity(observation.teams || []);
    });
    if(!event)return [];
    const players=new Map<string,ResolvedPlayer>();
    $('a.sl-row[href]').each((_index,node)=>{
      const row=$(node),label=row.find('.sl-nm').text().trim();
      if(!label || !row.attr('aria-label')?.startsWith(`Watch ${event.name} on ${label} `))return;
      const url=row.attr('href') || '';
      const player=eventPagePlayer(gameId,observation.url,url,`${observation.sourceId==='methstreams'?'Methstreams':'Crackstreams'} · ${label}`);
      if(player)players.set(url,player);
    });
    return [...players.values()];
  }
  if (observation.sourceId === 'streamcenter') {
    const path = new URL(observation.url).pathname;
    const link = streamcenterLink.exec(path);
    if (!link || gameId !== `ncaaf-${link[1]}`) return [];
    if (!parseStreamcenterPlayer(html)) return [];
    return [{id:`streamcenter-${link[1]}-${link[2]}`,
      locator:{provider:'streamcenter',eventId:link[1],linkId:link[2]},label:'Streamcenter'}];
  }
  if (observation.sourceId === 'ppv') {
    let input:unknown;
    try {input = JSON.parse(html);} catch {return [];}
    const parsed = PpvPlayerEvent.safeParse(input);
    if (!parsed.success) return [];
    const event = parsed.data;
    const expected = `https://ppv.st/live/${event.uri_name}`;
    if (observation.url !== expected || observation.kickoff !== event.starts_at*1000 ||
      !['College Football','NFL'].includes(event.tag)) return [];
    const pages = new Map<string,ResolvedPlayer>();
    for (const row of [event,...event.substreams]) {
      if (!row.iframe || row.tag !== event.tag || row.name !== event.name ||
        row.iframe !== `https://embedindia.st/embed/${row.uri_name}`) continue;
      const player = eventPagePlayer(gameId,observation.url,row.iframe,`PPV · ${row.source_tag || 'Server'}`);
      if (player) pages.set(row.iframe,player);
    }
    return [...pages.values()];
  }
  if (vipboxSourceIds.has(observation.sourceId)) {
    const generic = goozPlayers(html);
    const $ = load(html);
    const config = $('script').map((_index,node) => $(node).html()).get()
      .find(value => /\bconst\s+siteConfig\s*=\s*\{/.test(value || '')) || '';
    const kickoff = parseKickoff(/"event_start_ts"\s*:\s*(\d{10}(?:\d{3})?)\b/.exec(config)?.[1] || '');
    $('script,style').remove();
    const teams = vipboxPageTeams(observation.sourceId,html);
    const identity = (names:readonly string[]) => names.map(value=>value.toLowerCase().replace(/\s+/g,' ').trim()).sort().join('|');
    if ($('meta[property="og:url"]').first().attr('content') !== observation.url ||
      !/"loaded_page"\s*:\s*"stream"/.test(config) || kickoff === null || kickoff !== observation.kickoff ||
      !teams || !observation.teams || identity(teams) !== identity(observation.teams)) return generic;
    const pages = new Map<string,ResolvedPlayer>();
    $('[data-uri]').each((_i,node) => {
      const row = $(node);
      const label = row.text().replace(/\s+/g,' ').trim();
      let url:string;
      try {url = new URL(row.attr('data-uri') || '',observation.url).href;} catch {return;}
      const source = SOURCES.find(source=>source.id === observation.sourceId);
      const sourceName = source && 'name' in source ? source.name : observation.sourceId.replace(/-/g,' ');
      const player = eventPagePlayer(gameId,observation.url,url,`${sourceName} · ${label}`);
      if (player) pages.set(url,player);
    });
    return [...pages.values(),...generic];
  }
  return goozPlayers(html);
}
