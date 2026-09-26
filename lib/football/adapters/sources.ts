import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { Candidate, League, Observation } from '../shared.ts';
import { parsePlayers } from '../../sunday.ts';

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
  {id:'streameast',url:'https://v2.streameast.ga/nfl-streams/',family:'unknown'},
  {id:'buffstream-nfl',url:'https://ms.buffstream.io/nfl-streams-live-31',family:'buffstream'},
  {id:'methstreams',url:'https://methstreams.st/NFL',family:'event'},
  {id:'crackstreams-st',url:'https://crackstreams.st/NFL',family:'event'},
] as const;
export type Source = typeof SOURCES[number];
export class SourceFetchError extends Error {
  readonly retryAfterMs?: number;
  constructor(message:string,retryAfterMs?:number) { super(message); this.retryAfterMs=retryAfterMs; }
}
const hosts = new Set<string>(SOURCES.map(source => new URL(source.url).hostname));
hosts.add('gooz.aapmains.net');
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
  return readPage(url,signal);
}

async function readPage(url: string, signal: AbortSignal): Promise<string> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedDiscoveryUrl(url)) throw new Error('unsupported-discovery-address');
    const response = await fetch(url,{redirect:'manual',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{'User-Agent':'SundayRoom/1.0',Accept:'text/html'}});
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

export function parseListings(source: Source, html: string, now: number): { observations: Observation[]; outcome: 'parsed' | 'empty' | 'unsupported' | 'parser-changed' } {
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

export function enrichObservation(observation: Observation, html: string): Observation {
  const $ = load(html);
  $('script,style').remove();
  const text = $('body').text().replace(/\s+/g,' ');
  const time = $('[datetime]').first().attr('datetime') || $('[data-utc]').first().attr('data-utc') || /\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}\s*(?:AM|PM)?\s*ET\b/i.exec(text)?.[0] || observation.rawTime;
  return {...observation,rawTime:time,kickoff:parseKickoff(time)};
}

export function compatiblePlayers(gameId: string, observation: Observation, html: string, now: number): Candidate[] {
  return parsePlayers(html).map(player => ({id:`gooz-${player.id}`,gameId,playerId:player.id,url:player.url,label:player.label,sourceIds:[observation.sourceId],observedAt:now}));
}
