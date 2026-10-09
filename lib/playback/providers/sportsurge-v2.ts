import { load } from 'cheerio';
import { publishedFootballMatchup } from './sportsurge-matchup.ts';
import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText, type PlaybackProvider, type ProviderPlayback } from '../provider.ts';
import { observedPublicPage, get, hlsUrl, publicHttpsRequest, resource, sportsurgeUrl, type Requester } from './public-page.ts';
export { isPublicAddress, publicHttpsRequest, sportsurgeUrl } from './public-page.ts';

type SportsurgeLocator = Extract<CandidateLocator, { provider: 'sportsurge-v2' }>;
const MAX_PAGE_BYTES = 1024 * 1024;
const STATIC_LOOKUP_MS = 25000;
const MAX_PAGE_HOPS = 2;

class ConflictingMatchupError extends Error {}

function sportspatrikaPlayer(url: URL): boolean {
  return url.origin === 'https://embed.sportspatrika.com' && url.pathname === '/live/embed.php' &&
    /^\?ch=es[0-9]+$/.test(url.search);
}

function aianimalvibesPlayer(url: URL): boolean {
  return url.origin === 'https://ch.aianimalvibes.com' && /^\/(?:football|cfb)\/[0-9]{1,10}$/.test(url.pathname) &&
    !url.search && !url.hash;
}

function pageSources(html: string, base: URL): { media: URL[]; frames: URL[] } {
  const $ = load(html);
  const media: URL[] = [];
  const frames: URL[] = [];
  function add(value: string, target: URL[]) {
    try {
      const url = sportsurgeUrl(new URL(value, base).href);
      if (url && /\.m3u8$/i.test(url.pathname) && target === media) target.push(url);
      if (url && target === frames) target.push(url);
    } catch {}
  }
  for (const element of $('video[src], source[src], [data-hls], [data-stream-url]').toArray()) {
    const node = $(element);
    for (const name of ['src', 'data-hls', 'data-stream-url']) {
      const value = node.attr(name);
      if (value) add(value, media);
    }
  }
  for (const match of html.matchAll(/\b(?:file|source|src|hlsUrl|streamUrl)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
    let value = match[1].slice(1, -1);
    if (match[1].startsWith('"')) {
      try { value = JSON.parse(match[1]); } catch { continue; }
    }
    add(value, media);
  }
  for (const element of $('iframe[src]').toArray()) {
    const value = $(element).attr('src');
    if (value) add(value, frames);
  }
  return { media, frames };
}

export function sportsurgeV2Provider(requester: Requester = (url, signal, headers, timeoutMs) =>
  publicHttpsRequest(url, signal, headers, undefined, timeoutMs)): PlaybackProvider<SportsurgeLocator> {
  return {
    provider: 'sportsurge-v2',
    async open(locator, signal, purpose = 'playback'): Promise<ProviderPlayback> {
      const destination = sportsurgeUrl(locator.url);
      if (!destination) throw new Error('Unsupported Sportsurge destination');
      let page = destination;
      let browserDestination = destination;
      const dudestreamEntry = destination.origin === 'https://dudestream1.com' && !destination.search &&
        /^\/[a-z0-9]{7,32}$/.test(destination.pathname);
      let dudestreamCandidate: {parent:URL;server:URL}|null = null;
      let verifiedDudestream: {parent:URL;server:URL}|null = null;
      try {
        const visited = new Set<string>();
        for (let hop = 0; hop <= MAX_PAGE_HOPS; hop++) {
          if (visited.has(page.href)) break;
          visited.add(page.href);
          const { url, response } = await get(page.href, signal, requester,undefined,undefined,STATIC_LOOKUP_MS);
          if (hlsUrl(url, response)) {
            await response.body?.cancel();
            return { root: resource(url, page, 'playlist', requester), close() {} };
          }
          const type = response.headers.get('content-type') || '';
          if (type && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) {
            await response.body?.cancel();
            throw new Error('Sportsurge destination did not publish HLS');
          }
          const html = await boundedText(response, MAX_PAGE_BYTES);
          const $ = load(html);
          const identity = publishedFootballMatchup(locator.expectedMatchup,$('title').first().text().trim());
          if(identity==='conflicting')
            throw new ConflictingMatchupError('Sportsurge provider published a conflicting matchup');
          const sources = pageSources(html, url);
          if(hop===0&&dudestreamEntry&&url.origin==='https://dudestream1.com'&&
            /^\/cfb[1-9]\d{0,2}\/$/.test(url.pathname)&&!url.search&&
            $('link[rel="canonical"]').length===1&&$('link[rel="canonical"]').attr('href')===url.href&&
            $('iframe[src]').length===1&&sources.frames.length===1){
            const server=sources.frames[0];
            const pair=server.origin==='https://embedsports.me'&&!server.search&&
              /^\/american-football\/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$/.exec(server.pathname);
            if(pair){
              const matchup=publishedFootballMatchup(locator.expectedMatchup,
                `${pair[1].replaceAll('-',' ')} vs ${pair[2].replaceAll('-',' ')}`);
              if(matchup==='conflicting')throw new ConflictingMatchupError('Sportsurge provider published a conflicting matchup');
              if(identity==='matches'&&matchup==='matches')dudestreamCandidate={parent:url,server};
            }
          }
          if(dudestreamCandidate&&url.href===dudestreamCandidate.server.href&&identity==='matches')
            verifiedDudestream=dudestreamCandidate;
          if (sources.media.length) return { root: resource(sources.media[0], url, 'playlist', requester), close() {} };
          if (sources.frames.length !== 1) break;
          if (sportspatrikaPlayer(sources.frames[0]) || aianimalvibesPlayer(sources.frames[0]))
            browserDestination = sources.frames[0];
          page = sources.frames[0];
        }
        throw new Error('Sportsurge destination did not publish supported HLS');
      } catch (error) {
        if (signal.aborted||error instanceof ConflictingMatchupError) throw error;
        const observed = await observedPublicPage(verifiedDudestream?.server||browserDestination, signal, purpose,
          verifiedDudestream?.parent);
        if (observed) return observed;
        throw error;
      }
    },
  };
}
