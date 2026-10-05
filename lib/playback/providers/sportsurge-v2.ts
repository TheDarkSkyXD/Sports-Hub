import { load } from 'cheerio';
import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText, type PlaybackProvider, type ProviderPlayback } from '../provider.ts';
import { observedPublicPage, get, hlsUrl, publicHttpsRequest, resource, sportsurgeUrl, type Requester } from './public-page.ts';
export { isPublicAddress, publicHttpsRequest, sportsurgeUrl } from './public-page.ts';

type SportsurgeLocator = Extract<CandidateLocator, { provider: 'sportsurge-v2' }>;
const MAX_PAGE_BYTES = 1024 * 1024;
const STATIC_LOOKUP_MS = 25000;
const MAX_PAGE_HOPS = 2;

function sportspatrikaPlayer(url: URL): boolean {
  return url.origin === 'https://embed.sportspatrika.com' && url.pathname === '/live/embed.php' &&
    /^\?ch=es[0-9]+$/.test(url.search);
}

function aianimalvibesPlayer(url: URL): boolean {
  return url.origin === 'https://ch.aianimalvibes.com' && /^\/football\/[0-9]{1,10}$/.test(url.pathname) &&
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
      const staticSignal = AbortSignal.any([signal,AbortSignal.timeout(STATIC_LOOKUP_MS)]);
      try {
        const visited = new Set<string>();
        for (let hop = 0; hop <= MAX_PAGE_HOPS; hop++) {
          if (visited.has(page.href)) break;
          visited.add(page.href);
          const { url, response } = await get(page.href, staticSignal, requester);
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
          const sources = pageSources(html, url);
          if (sources.media.length) return { root: resource(sources.media[0], url, 'playlist', requester), close() {} };
          if (sources.frames.length !== 1) break;
          if (sportspatrikaPlayer(sources.frames[0]) || aianimalvibesPlayer(sources.frames[0]))
            browserDestination = sources.frames[0];
          page = sources.frames[0];
        }
        throw new Error('Sportsurge destination did not publish supported HLS');
      } catch (error) {
        if (signal.aborted) throw error;
        const observed = await observedPublicPage(browserDestination, signal, purpose);
        if (observed) return observed;
        throw error;
      }
    },
  };
}
