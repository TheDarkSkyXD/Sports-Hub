import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import type { League, MissingPlayerReason, Observation, ResolvedPlayer } from '../shared.ts';
import type { ListingSource } from '../domain/ports.ts';
import { PartialListingReadError } from '../domain/ports.ts';
import { parsePlayers } from '../../sunday.ts';
import { parseStreamcenterPlayer } from '../../playback/providers/streamcenter-player.ts';
import { validEventPagePair } from '../../playback/providers/event-page-policy.ts';
import { SWAC_CATALOG_URL, parseSwacEvent, swacApiUrl, swacProgramId, swacProgramUrl } from '../../playback/providers/swac-catalog.ts';
import { TvappMatch, catalogTeams, preferredCatalogTeams, tvappIdentity, tvappStreams } from '../../playback/providers/tvapp-catalog.ts';
import {enrichLiveTvObservation,liveTvPlayers,parseLiveTvListings} from './livetv.ts';
import {nflstreamsPlayers,parseNflstreamsListings} from './nflstreams.ts';
import {buffstreamPlayers} from './buffstream.ts';

const TVAPP_API = 'https://api-backups.handleapi.win/matches/sport/american-football';
const TVAPP_BASKETBALL_API = 'https://api-backups.handleapi.win/matches/sport/basketball';
const TVAPP_HOCKEY_API = 'https://api-backups.handleapi.win/matches/sport/hockey';
const TVAPP_BASEBALL_API = 'https://api-backups.handleapi.win/matches/sport/baseball';
const PPV_API = 'https://api.ppv.st/api/streams';
const STREAMCENTER_CATALOG = 'https://streamcenter.st/game-cards/embed?sport=football';
const STREAMCENTER_BASKETBALL = 'https://streamcenter.st/game-cards/embed?sport=basketball';
const STREAMCENTER_HOCKEY = 'https://streamcenter.st/game-cards/embed?sport=hockey';
const STREAMCENTER_BASEBALL = 'https://streamcenter.st/game-cards/embed?sport=baseball';
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
  {id:'tvapp',name:'TVApp',url:TVAPP_API,family:'tvapp',kind:'catalog',parserVersion:4,publicUrls:[
    'https://tvapp1.pk/cfb-streams','https://tvapp1.pk/nfl-streams',
    'https://thetvapp67.st/cfb-streams','https://thetvapp67.st/nfl-streams',
  ]},
  {id:'tvapp-nba',name:'TVApp Basketball',url:TVAPP_BASKETBALL_API,family:'tvapp',kind:'catalog',parserVersion:4,publicUrls:[]},
  {id:'tvapp-nhl',name:'TVApp Hockey',url:TVAPP_HOCKEY_API,family:'tvapp',kind:'catalog',parserVersion:4,publicUrls:[]},
  {id:'tvapp-mlb',name:'TVApp Baseball',url:TVAPP_BASEBALL_API,family:'tvapp',kind:'catalog',parserVersion:4,publicUrls:[]},
  {id:'ppv',name:'PPV',url:PPV_API,family:'ppv',kind:'catalog',publicUrls:['https://ppv.st/#26']},
  {id:'methstreams-f1',name:'Methstreams Motorsports',url:'https://methstreams.st/F1',family:'motorsports'},
  {id:'crackstreams-f1',name:'Crackstreams Motorsports',url:'https://crackstreams.st/F1',family:'motorsports'},
  {id:'streamcenter',name:'Streamcenter',url:STREAMCENTER_CATALOG,family:'streamcenter',publicUrls:['https://streame.center/']},
  {id:'streamcenter-nba',name:'Streamcenter Basketball',url:STREAMCENTER_BASKETBALL,family:'streamcenter',publicUrls:['https://streame.center/']},
  {id:'streamcenter-nhl',name:'Streamcenter Hockey',url:STREAMCENTER_HOCKEY,family:'streamcenter',publicUrls:['https://streame.center/']},
  {id:'streamcenter-mlb',name:'Streamcenter Baseball',url:STREAMCENTER_BASEBALL,family:'streamcenter',publicUrls:['https://streame.center/']},
  {id:'sportsurge-v2',name:'Sportsurge v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog',publicUrls:[
    'https://v2.sportsurge.net/watch-cfb-streams/','https://v2.sportsurge.net/watch-nfl-streams/',
  ]},
  {id:'swac',name:'SWAC TV',url:SWAC_CATALOG_URL,family:'swac',kind:'catalog',publicUrls:['https://tv.swac.org/']},
  {id:'vipbox-nba',url:'https://vipbox.fm/basketball-schedule',family:'vipbox'},
  {id:'strikeout-nba',url:'https://strikeout.im/nba',family:'vipbox'},
  {id:'methstreams-nba',url:'https://methstreams.st/NBA',family:'event'},
  {id:'crackstreams-nba',url:'https://crackstreams.st/NBA',family:'event'},
  {id:'buffstream-nba',url:'https://ms.buffstream.io/nba-streams-live-15',family:'buffstream'},
  {id:'vipbox-nhl',url:'https://vipbox.fm/hockey-schedule',family:'vipbox'},
  {id:'strikeout-nhl',url:'https://strikeout.im/nhl',family:'vipbox'},
  {id:'methstreams-nhl',url:'https://methstreams.st/NHL',family:'event'},
  {id:'crackstreams-nhl',url:'https://crackstreams.st/NHL',family:'event'},
  {id:'buffstream-nhl',url:'https://ms.buffstream.io/nhl-streams-live-29',family:'buffstream'},
  {id:'strikeout-mlb',url:'https://strikeout.im/mlb',family:'vipbox'},
  {id:'methstreams-mlb',url:'https://methstreams.st/MLB',family:'event'},
  {id:'crackstreams-mlb',url:'https://crackstreams.st/MLB',family:'event'},
  {id:'buffstream-mlb',url:'https://ms.buffstream.io/mlb-streams-live-29',family:'buffstream'},
  {id:'mlbbox-mlb',name:'MLBBox',url:'https://mlbbox.me/mlb-streams',family:'vipbox'},
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
      url.hostname === 'ppv.st' && (/^\/live\/(?:cfb|nfl|nba|wnba|nhl|mlb)\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+$/.test(url.pathname)||
        /^\/live\/f1\/\d{4}\/[a-z0-9-]+\/(?:fp[123]|sprint-q|sprint|qualifying|race)$/.test(url.pathname)));
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
    const events = parsed.data.streams.filter(group => group.category === 'American Football' || group.category === 'Basketball' || group.category === 'Ice Hockey' || group.category === 'Baseball' || group.category === 'Motorsports')
      .flatMap(group => group.streams).filter(value => {
        const event = PpvEvent.safeParse(value);
        return event.success && event.data.uri_name === path;
      });
    if (events.length !== 1) throw new Error('parser-changed');
    return JSON.stringify(events[0]);
  }
  if (url === 'https://isportsurge.ws/index6') {
    const results=await Promise.allSettled([
      readPage('https://isportsurge.ws/nfl/livestreams3',signal),
      readPage('https://isportsurge.ws/cfb/livestreams2',signal),
      readPage('https://isportsurge.ws/nba/livestreams3',signal),
      readPage('https://isportsurge.ws/nhl/livestreams3',signal),
      readPage('https://isportsurge.ws/mlb/livestreams2',signal),
    ]);
    if(signal.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError');
    const pages=results.flatMap(result=>result.status==='fulfilled'?[load(result.value)('body').html()||'']:[]);
    if(results.every(result=>result.status==='fulfilled'))return `<main>${pages.join('')}</main>`;
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason instanceof Error?result.reason:new Error('unavailable')]:[]);
    const retryAfterMs=Math.max(0,...errors.map(error=>error instanceof SourceFetchError?error.retryAfterMs||0:0));
    const failure=errors.find(error=>error.message==='http-429'||error.message==='rate-limited')||errors[0];
    if(!pages.length)throw new SourceFetchError(failure.message,retryAfterMs);
    throw new PartialListingReadError(`<main>${pages.join('')}</main>`,failure,retryAfterMs);
  }
  return readPage(url,signal,url === TVAPP_API || url === TVAPP_BASKETBALL_API || url === TVAPP_HOCKEY_API || url === TVAPP_BASEBALL_API || url === PPV_API || url === SWAC_CATALOG_URL ? 'application/json' : 'text/html');
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

const PpvEvent = z.object({
  id:z.number().int().positive(),name:z.string().min(1),tag:z.string(),
  uri_name:z.string(),starts_at:z.number().int(),
});
const PpvCatalog = z.object({
  success:z.literal(true),streams:z.array(z.object({category:z.string(),streams:z.array(z.unknown())})),
});

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
      if ((match.id === 'ppv-nfl-network' && match.title === 'NFL Network' ||
        match.id === 'ppv-nhl-network' && match.title === 'NHL Network' ||
        match.id === 'nflstreams_live' && match.title === 'NFL Streams Schedule') && match.date === 0) continue;
      const category=source.id==='tvapp-nba'?'basketball':source.id==='tvapp-nhl'?'hockey':source.id==='tvapp-mlb'?'baseball':'american-football';
      if(match.category!==category)continue;
      if(source.id==='tvapp-nhl'&&(match.id.startsWith('live_ncaa-women_')||match.id.startsWith('live_college_')))continue;
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
      const league:League|null=source.id==='tvapp-mlb'?'mlb':null;
      if (!add({id:`${source.id}:${digest(match.id)}`,sourceId:source.id,url,title,teams,
        league,kickoff:match.date,rawTime,observedAt:now,parserVersion:3})) return invalid();
    }
  } else if (source.family === 'ppv') {
    const result = PpvCatalog.safeParse(input);
    if (!result.success) return invalid();
    const groups = result.data.streams.filter(group => group.category === 'American Football' || group.category === 'Basketball' || group.category === 'Ice Hockey' || group.category === 'Baseball' || group.category === 'Motorsports');
    if (!groups.length || new Set(groups.map(group=>group.category)).size!==groups.length) return invalid();
    for (const value of groups.flatMap(group=>group.streams)) {
      const result = PpvEvent.safeParse(value);
      if (!result.success) return invalid();
      const event = result.data;
      const league = event.tag === 'College Football' ? 'ncaaf' : event.tag === 'NFL' ? 'nfl' : event.tag === 'NBA' ? 'nba' : event.tag === 'WNBA' ? 'wnba' : event.tag === 'NHL' ? 'nhl' : event.tag === 'MLB' ? 'mlb' : event.tag === 'Formula 1' ? 'f1' : null;
      if (!league || !event.uri_name.startsWith(`${league === 'ncaaf' ? 'cfb' : league}/`)) continue;
      if (!/^(?:cfb|nfl|nba|wnba|nhl|mlb)\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+$/.test(event.uri_name)&&
        !/^f1\/\d{4}\/[a-z0-9-]+\/(?:fp[123]|sprint-q|sprint|qualifying|race)$/.test(event.uri_name)) return invalid();
      if (event.starts_at <= 0) continue;
      const kickoff = event.starts_at*1000;
      if (kickoff < Date.UTC(2000,0,1) || kickoff >= Date.UTC(2100,0,1)) return invalid();
      if (kickoff > now+7*86400000) continue;
      const title = event.name.replace(/\s+/g,' ').trim();
      const pair = catalogTeams(title);
      const teams: [string,string] | null = league==='f1'?null:pair && /\s+at\s+/i.test(title) ? [pair[1],pair[0]] : pair;
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
  if(source.family==='motorsports')return parseMotorsportsListings(source,html,now);
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
      /^\/(?:nfl|cfb|nba|nhl|mlb)-streams\/[a-z0-9-]+-live-stream$/.test(publishedUrl.pathname)) {
      publishedUrl.protocol = 'https:';
      url = publishedUrl.href;
    }
    if (!allowedDiscoveryUrl(url)) return;
    const path = new URL(url).pathname;
    if(source.id==='buffstream-cfb'&&!path.startsWith('/cfb-streams/')||
      source.id==='buffstream-nfl'&&!path.startsWith('/nfl-streams/')||
      source.id==='buffstream-nba'&&!path.startsWith('/nba-streams/')||
      source.id==='buffstream-nhl'&&!path.startsWith('/nhl-streams/')||
      source.id==='buffstream-mlb'&&!path.startsWith('/mlb-streams/')||
      source.id==='vipbox-nhl'&&!path.startsWith('/onair/nhl/')||
      source.id==='strikeout-nhl'&&!path.startsWith('/nhl/')||
      source.id==='strikeout-mlb'&&!path.startsWith('/mlb/')||
      source.id==='mlbbox-mlb'&&!/^\/mlb\/[a-z0-9-]+-stream$/.test(path)||
      (source.id==='methstreams-nhl'||source.id==='crackstreams-nhl'||source.id==='methstreams-mlb'||source.id==='crackstreams-mlb')&&!path.startsWith('/event/'))return;
    if (/^\/(?:nfl|cfb|nba|nhl|mlb)\/livestreams\d*\/?$/i.test(path)) return;
    if (!/\/(?:watch\/(?:nfl|cfb|nba(?:-preseason)?|nhl|mlb-playoffs)\/|onair\/(?:nfl|ncaaf|nba|nhl)\/|(?:nfl|cfb|nba|nhl|mlb|college-football)\/.*(?:live|stream)|(?:nfl|cfb|nba|nhl|mlb)-streams\/.+-live-stream|event\/)/i.test(path)) return;
    const row = source.family === 'sportsurge' ? anchor : anchor.closest('tr,[data-start],article,li,.event,.match,.card').first();
    const container = row.length ? row : anchor;
    const title = (source.id==='mlbbox-mlb' ? anchor.find('h2').first().text() : anchor.text()).replace(/\s+/g,' ').trim().slice(0,300);
    const imageNames = anchor.find('.team-name-event-row img[alt]').map((_i,img) => $(img).attr('alt')).get();
    const textTime = /\d{4}-\d{2}-\d{2}(?:,\s*[a-z]+)?(?:\s*-\s*|[ T])\d{1,2}:\d{2}\s*(?:AM|PM)?\s*ET\b/i.exec(title)?.[0] || '';
    const cleaned = title.replace(textTime,'').replace(/\d{1,2}:\d{2}\s*UTC.*$/i,'')
      .replace(/(?:Live)?Watch\s*→?\s*$/i,'').replace(/^\s*(?:\d{1,2}:\d{2}\s*)?/,'').replace(/\s*\bCH\s*\d+\s*$/i,'');
    const matchupTitle = vipboxMatchupTitle(source.id,
      source.id==='methstreams-mlb'||source.id==='crackstreams-mlb'
        ? cleaned.replace(/\s*\((?:ALDS|NLDS|ALCS|NLCS|World Series) Game \d+\)\s*$/i,'') : cleaned);
    const pair = matchupTitle.split(/\s+(?:vs\.?|versus|at|@)\s+/i).map(value => value.replace(/^#?\d+\s+/,'').trim());
    const structuredNames = source.family === 'event'
      ? anchor.find('.ev-side .nm-l').map((_i,node) => $(node).text().trim()).get() : [];
    const rowTeams = source.family === 'buffstream' ? container.find('a[href]').toArray().flatMap(node => {
      const teamAnchor = $(node);
      const href = teamAnchor.attr('href') || '';
      return /^https?:\/\/ms\.buffstream\.io\/(?:nfl|cfb|nba|nhl|mlb)-streams\/[a-z0-9-]+-live-stream$/.test(href)
        ? [teamAnchor.text().replace(/\s+Live Stream\s*$/i,'').trim()] : [];
    }) : [];
    const fullNames = structuredNames.length ? structuredNames : rowTeams.length === 2 ? rowTeams : [];
    const teams: Observation['teams'] = fullNames.length === 2 && fullNames.every(Boolean)
      ? [fullNames[0],fullNames[1]] : fullNames.length ? null : imageNames.length === 2
      ? [imageNames[0],imageNames[1]] : pair.length === 2 && pair.every(Boolean) ? [pair[0],pair[1]] : null;
    const buffstreamDatedTime=source.id==='buffstream-nhl'||source.id==='buffstream-mlb' ? container.find('h4').toArray().map(node=>$(node).text().trim()).join(' ') : '';
    const rawTime = container.attr('datetime') || container.find('[datetime]').first().attr('datetime') ||
      container.attr('data-utc') || container.find('[data-utc]').first().attr('data-utc') ||
      container.attr('data-start') || container.find('[data-start]').first().attr('data-start') ||
      container.attr('content') || container.find('[content]').first().attr('content') || buffstreamDatedTime || textTime ||
      (source.family==='buffstream'?container.find('td').toArray().map(cell=>$(cell).text().trim())
        .find(text=>/^(?:0?[1-9]|1[0-2]):[0-5]\d\s*(?:am|pm)\s*ET$/i.test(text))||'':'');
    const inferredLeague: League | null = /\/(?:watch\/cfb|cfb|ncaaf|college-football)(?:\/|-)/i.test(path) ? 'ncaaf' : /\/(?:watch\/nfl|nfl)(?:\/|-)/i.test(path) ? 'nfl' : /\/(?:watch\/nba|nba)(?:\/|-)/i.test(path) ? 'nba' : /\/(?:watch\/nhl|nhl)(?:\/|-)/i.test(path) ? 'nhl' : /\/(?:watch\/mlb-playoffs|mlb)(?:\/|-)/i.test(path) ? 'mlb' : null;
    const section = source.family === 'event' ? anchor.closest('section.lg').attr('id') || '' : '';
    const hockeyEvent=source.id==='methstreams-nhl'||source.id==='crackstreams-nhl';
    const baseballEvent=source.id==='methstreams-mlb'||source.id==='crackstreams-mlb';
    const hockeyLeague:League|null=/^g-lg-nhl-\d{8}$/.test(section)?'nhl':null;
    if(hockeyEvent&&!hockeyLeague)return;
    if(baseballEvent&&!/^g-cat-mlb-\d{8}$/.test(section))return;
    const league = hockeyEvent?hockeyLeague:baseballEvent||source.id.endsWith('-mlb')?'mlb':source.id.endsWith('-nhl')?'nhl':/college-football/.test(section)?'ncaaf':source.family === 'event' ? null : inferredLeague;
    const id = `${source.id}:${digest(url)}`;
    const numeric = /^\/watch\/(nfl|cfb|nba|nhl)\/[^/]+\/(\d+)$/.exec(path);
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
    observations.set(id,{id,sourceId:source.id,url,title:matchupTitle!==cleaned ? cleaned : teams ? teams.join(' vs ') : title,teams,league,rawTime,kickoff,observedAt:now,parserVersion:2,legacyId:numeric && numeric[1]!=='nba' && numeric[1]!=='nhl' ? `${numeric[1] === 'cfb' ? 'ncaaf-' : ''}source-${numeric[2]}` : undefined});
  });
  const values = [...observations.values()];
  const knownEmpty = /no matches available right now|sorry, no games scheduled on this date|no (?:live )?(?:games|events) (?:available|scheduled|found)/i.test($('body').text());
  const vipboxCollegeEmpty = source.id==='vipbox-cfb' && $('meta[property="og:url"]').first().attr('content')===source.url &&
    (/^No Match'?s Today for NCAAF$/i.test($('h3.card-header').first().text().replace(/\s+/g,' ').trim()) ||
      /Not able to find any match\/event on NCAAF today\./i.test($('body').text()));
  return {observations:values,outcome:values.length ? 'parsed' : knownEmpty||vipboxCollegeEmpty ? 'empty' : source.family === 'unknown' ? 'unsupported' : 'parser-changed'};
}

const streamcenterLink = /^\/api\/stream-link\/iframe\/event-espn-league-(football-college-football|basketball-(?:nba|wnba)|hockey-nhl|baseball-mlb)-(\d{5,12})\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

function parseStreamcenterListings(source: ListingSource, html: string, now: number): ReturnType<typeof parseListings> {
  const $ = load(html);
  const observations: Observation[] = [];
  let invalid = false;
  $('article.game-card-row').each((_index,element) => {
    const card = $(element);
    const label=card.find('.game-card-league').text().trim();
    const league=label==='NCAA Football'?'ncaaf':label==='NBA'?'nba':label==='WNBA'?'wnba':label==='NHL'?'nhl':label==='MLB'?'mlb':null;
    if (!league || (source.id==='streamcenter-nhl') !== (league==='nhl') ||
      (source.id==='streamcenter-mlb') !== (league==='mlb') ||
      (source.id==='streamcenter-nba') !== (league==='nba'||league==='wnba')) return;
    const teams = card.find('.game-card-team[title]').map((_i,node) => $(node).attr('title')?.trim()).get();
    const rawTime = card.find('time[datetime]').first().attr('datetime') || '';
    const kickoff = parseKickoff(rawTime);
    if (teams.length !== 2 || !kickoff) { invalid=true; return; }
    card.find('a.game-card-open-link[href]').each((_i,node) => {
      const href = $(node).attr('href') || '';
      const match = streamcenterLink.exec(href);
      if (!match || match[1] !== (league==='ncaaf'?'football-college-football':league==='nhl'?'hockey-nhl':league==='mlb'?'baseball-mlb':`basketball-${league}`)) { invalid=true; return; }
      const url = new URL(href,'https://streamcenter.st').href;
      observations.push({id:`${source.id}:${digest(href)}`,sourceId:source.id,url,
        title:`${teams[0]} vs ${teams[1]}`,teams:[teams[0],teams[1]],league,kickoff,rawTime,
        observedAt:now,parserVersion:2});
    });
  });
  if (invalid) return {observations:[],outcome:'parser-changed'};
  return {observations,outcome:observations.length ? 'parsed' : $('article.game-card-row').length ? 'empty' : 'parser-changed'};
}
function parseMotorsportsListings(source:ListingSource,html:string,now:number):ReturnType<typeof parseListings> {
  const $=load(html),observations:Observation[]=[];
  const seen=new Set<string>();
  $('a.ev[data-start][href]').each((_index,node)=>{
    const row=$(node),title=(row.attr('title')||row.find('.ev-t').text()).replace(/\s+/g,' ').trim();
    const section=row.closest('section.lg').attr('id')||'';
    const league:League|null=/^g-lg-f1-\d{8}$/.test(section)?'f1':
      /^g-lg-nascar-truck-\d{8}$/.test(section)?'nascar-truck':
      /^g-lg-nascar-premier-\d{8}$/.test(section)?'nascar-cup':
      /^g-cat-motogp-\d{8}$/.test(section)?'motogp':
      /^g-cat-motorsport-\d{8}$/.test(section)?'motorsport':null;
    if(!league||!title)return;
    let url:URL;
    try{url=new URL(row.attr('href')||'',source.url);}catch{return;}
    if(url.hostname!==new URL(source.url).hostname||!/^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname)||
      url.search||url.hash||!allowedDiscoveryUrl(url.href))return;
    const rawTime=row.attr('data-start')||'';
    const kickoff=parseKickoff(rawTime);
    if(kickoff===null||seen.has(url.href))return;
    seen.add(url.href);
    observations.push({id:`${source.id}:${digest(url.href)}`,sourceId:source.id,url:url.href,title,teams:null,league,
      kickoff,rawTime,observedAt:now,parserVersion:2});
  });
  return {observations,outcome:observations.length?'parsed':$('a.ev[data-start]').length?'empty':'parser-changed'};
}

export function enrichObservation(observation: Observation, html: string): Observation {
  if(observation.sourceId==='livetv')return enrichLiveTvObservation(observation,html);
  if(observation.sourceId==='nflstreams')return observation;
  if(['buffstream-nfl','buffstream-cfb','buffstream-nba','buffstream-nhl','buffstream-mlb'].includes(observation.sourceId))return observation;
  if (['streamcenter','streamcenter-nba','streamcenter-nhl','streamcenter-mlb','ppv','tvapp','tvapp-nba','tvapp-nhl','tvapp-mlb','swac'].includes(observation.sourceId)) return observation;
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
    sourceId.startsWith('strikeout-') ? /^Live (.*?) Streams Online$/i.exec(title)?.[1] :
    sourceId==='mlbbox-mlb' ? /^MLB Live: (.*?) Online$/i.exec(title)?.[1] : undefined;
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
  offers:z.object({price:z.union([z.string(),z.number()])}),sport:z.string().optional(),
});
const ChannelTeam = z.object({name:z.string()});
const ChannelEvent = z.union([
  ChannelEventBase.extend({homeTeam:ChannelTeam,awayTeam:ChannelTeam}),
  ChannelEventBase.extend({performer:z.array(ChannelTeam).length(1),homeTeam:z.never().optional(),awayTeam:z.never().optional()}),
]);

export function missingPlayerReason(observation:Observation,html:string):MissingPlayerReason {
  if(!['tvapp','tvapp-nba','tvapp-nhl','tvapp-mlb','methstreams','methstreams-nba','methstreams-nhl','methstreams-mlb','crackstreams-st','crackstreams-nba','crackstreams-nhl','crackstreams-mlb','methstreams-f1','crackstreams-f1','sportsurge','livetv'].includes(observation.sourceId))return 'no-compatible-media';
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
  if(['buffstream-nfl','buffstream-cfb','buffstream-nba','buffstream-nhl','buffstream-mlb','crackstreams-cfb'].includes(observation.sourceId))return buffstreamPlayers(gameId,observation,html);
  if(observation.sourceId==='swac'){
    let input:unknown;
    try{input=JSON.parse(html);}catch{return [];}
    const parsed=parseSwacEvent(input);
    if(!parsed || observation.url!==swacProgramUrl(parsed.event.id) || observation.kickoff!==parsed.kickoff ||
      observation.title!==parsed.teams.join(' vs ') || observation.teams?.join('|')!==parsed.teams.join('|'))return [];
    return [{id:`swac:${parsed.event.id}`,locator:{provider:'swac',eventId:parsed.event.id},label:'SWAC TV'}];
  }
  if (observation.sourceId === 'tvapp' || observation.sourceId === 'tvapp-nba' || observation.sourceId === 'tvapp-nhl' || observation.sourceId === 'tvapp-mlb') {
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
  if (observation.sourceId === 'methstreams' || observation.sourceId === 'methstreams-nba' || observation.sourceId === 'methstreams-nhl' || observation.sourceId === 'methstreams-mlb' || observation.sourceId === 'methstreams-f1' || observation.sourceId === 'crackstreams-st' || observation.sourceId === 'crackstreams-nba' || observation.sourceId === 'crackstreams-nhl' || observation.sourceId === 'crackstreams-mlb' || observation.sourceId === 'crackstreams-f1') {
    const $ = load(html);
    const host=observation.sourceId.startsWith('methstreams')?'methstreams.st':'crackstreams.st';
    if(new URL(observation.url).hostname!==host || (!observation.teams&&observation.league!=='f1'&&observation.league!=='nascar-cup'&&observation.league!=='nascar-truck'&&observation.league!=='motogp'&&observation.league!=='motorsport') || observation.kickoff===null ||
      $('link[rel="canonical"]').attr('href')!==observation.url || $('meta[property="og:url"]').attr('content')!==observation.url)return [];
    const events=$('script[type="application/ld+json"]').toArray().flatMap(node=>{
      try {const parsed=ChannelEvent.safeParse(JSON.parse($(node).text()));return parsed.success?[parsed.data]:[];}catch{return [];}
    });
    const identity=(teams:readonly string[])=>teams.map(team=>team.toLowerCase().replace(/\s+/g,' ').trim()).sort().join('|');
    const event=events.find(value=>{
      if(!observation.teams)return value.url===observation.url&&Date.parse(value.startDate)===observation.kickoff&&
        value.name===observation.title&&'performer' in value&&value.performer?.[0]?.name===value.name&&
        (observation.league==='f1'?value.sport==='Formula 1':observation.league==='motogp'?value.sport==='MotoGP':
          observation.league==='nascar-cup'?value.sport==='NASCAR Cup Series':
          observation.league==='nascar-truck'?value.sport==='NASCAR Truck Series':value.sport==='Motorsport');
      const namedTeams=catalogTeams(observation.league==='mlb'
        ?value.name.replace(/\s*\((?:ALDS|NLDS|ALCS|NLCS|World Series) Game \d+\)\s*$/i,'')
        :value.name);
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
      const player=eventPagePlayer(gameId,observation.url,url,`${observation.sourceId.startsWith('methstreams')?'Methstreams':'Crackstreams'} · ${label}`);
      if(player)players.set(url,player);
    });
    return [...players.values()];
  }
  if (observation.sourceId === 'streamcenter' || observation.sourceId === 'streamcenter-nba' || observation.sourceId === 'streamcenter-nhl' || observation.sourceId === 'streamcenter-mlb') {
    const path = new URL(observation.url).pathname;
    const link = streamcenterLink.exec(path);
    if (!link || gameId !== `${link[1]==='football-college-football'?'ncaaf':link[1]==='hockey-nhl'?'nhl':link[1]==='baseball-mlb'?'mlb':link[1].slice('basketball-'.length)}-${link[2]}`) return [];
    if (!parseStreamcenterPlayer(html)) return [];
    return [{id:`streamcenter-${link[2]}-${link[3]}`,
      locator:{provider:'streamcenter',eventId:link[2],linkId:link[3],...(link[1]==='basketball-nba'?{league:'nba' as const}:link[1]==='basketball-wnba'?{league:'wnba' as const}:link[1]==='hockey-nhl'?{league:'nhl' as const}:link[1]==='baseball-mlb'?{league:'mlb' as const}:{})},label:'Streamcenter'}];
  }
  if (observation.sourceId === 'ppv') {
    let input:unknown;
    try {input = JSON.parse(html);} catch {return [];}
    const parsed = PpvPlayerEvent.safeParse(input);
    if (!parsed.success) return [];
    const event = parsed.data;
    const expected = `https://ppv.st/live/${event.uri_name}`;
    if (observation.url !== expected || observation.kickoff !== event.starts_at*1000 ||
      !['College Football','NFL','NBA','WNBA','NHL','MLB','Formula 1'].includes(event.tag)) return [];
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
      !teams || !observation.teams || identity(teams) !== identity(observation.teams))
      return observation.sourceId==='mlbbox-mlb'?[]:generic;
    const pages = new Map<string,ResolvedPlayer>();
    if(observation.sourceId==='mlbbox-mlb'){
      $('textarea').each((_i,node)=>{
        const embed=/<iframe\b[^>]*\bsrc=['"](https:\/\/embedsports\.me\/baseball\/[a-z0-9-]+)['"][^>]*>/i.exec($(node).text())?.[1];
        if(!embed)return;
        const player=eventPagePlayer(gameId,observation.url,embed,'MLBBox');
        if(player)pages.set(embed,player);
      });
    }
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

export async function tvappPlayers(gameId:string,observation:Observation,html:string,_signal:AbortSignal,
  _read:(url:string,signal:AbortSignal)=>Promise<string>=readPage):Promise<ResolvedPlayer[]> {
  if(!['tvapp','tvapp-nba','tvapp-nhl','tvapp-mlb'].includes(observation.sourceId)||!observation.teams||observation.kickoff===null||
    compatiblePlayers(gameId,observation,html).length!==1)return [];
  const teams=observation.teams,kickoff=observation.kickoff;
  const signal=_signal,read=_read;
  const catalog:unknown=JSON.parse(await read(observation.sourceId==='tvapp-nba'?TVAPP_BASKETBALL_API:
    observation.sourceId==='tvapp-nhl'?TVAPP_HOCKEY_API:observation.sourceId==='tvapp-mlb'?TVAPP_BASEBALL_API:TVAPP_API,signal));
  if(!Array.isArray(catalog))throw new Error('parser-changed');
  const matching=catalog.flatMap(value=>{
    const event=tvappIdentity(value);
    return event&&event.watchUrl===observation.url&&event.title===observation.title&&
      event.kickoff===kickoff&&event.teams.join('|')===teams.join('|')?[event]:[];
  });
  if(matching.length!==1)return [];
  const refs=matching[0].sources;
  if(new Set(refs.map(ref=>`${ref.source}:${ref.id}`)).size!==refs.length)return [];
  const streams=(await Promise.all(refs.map(async ref=>{
    const rows:unknown=JSON.parse(await read(`https://api-backups.handleapi.win/streams/${ref.source}/${ref.id}`,signal));
    const parsed=tvappStreams(rows,ref.source,ref.id);
    if(!parsed)throw new Error('parser-changed');
    return parsed;
  }))).flat();
  signal.throwIfAborted();
  const seen=new Set<string>();
  let hdCount=0,sdCount=0;
  return [...streams.filter(row=>row.hd),...streams.filter(row=>!row.hd)].flatMap(row=>{
    const key=`${row.source}:${row.id}:${row.streamNo}`;
    if(seen.has(key))return [];
    seen.add(key);
    return [{id:`tvapp:${digest(JSON.stringify([gameId,observation.url,key]))}`,
      label:`TVApp · Premium ${row.hd?++hdCount:++sdCount} ${row.hd?'HD':'SD'}`,
      locator:{provider:'tvapp' as const,gameId,eventUrl:observation.url,
        source:row.source,sourceId:row.id,streamNo:row.streamNo,
        kickoff,title:observation.title,teams}}];
  });
}
