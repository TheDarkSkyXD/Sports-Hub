import type { CandidateLocator } from '../football/shared.ts';
import { validEventPagePair } from './providers/event-page-policy.ts';
import { sportsurgeUrl } from './providers/public-page.ts';

function durableSportsurgeQuery(url: URL): boolean {
  const params = url.searchParams;
  if (params.toString() !== url.search.slice(1)) return false;
  const keys = [...params.keys()].sort().join(',');
  if (url.origin === 'https://live.embedca.st' && url.pathname === '/live.php')
    return keys === 'ch' && /^es\d{1,6}$/.test(params.get('ch') || '');
  return url.origin === 'https://sportsupa.st' && url.pathname === '/event/' && keys === 'id,sno,src' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*-\d{1,12}$/.test(params.get('id') || '') &&
    params.get('src') === 'best' && /^[1-9]\d{0,3}$/.test(params.get('sno') || '');
}

export function persistableLocator(locator: CandidateLocator): boolean {
  if (locator.provider === 'event-page') return validEventPagePair(locator.eventUrl, locator.serverUrl);
  if (locator.provider === 'tvapp') {
    const url=sportsurgeUrl(locator.eventUrl);
    return !!url&&url.href===locator.eventUrl&&url.hostname==='tvapp1.pk'&&!url.search&&!url.hash&&
      /^\/watch\/[a-zA-Z0-9-]{1,120}$/.test(url.pathname);
  }
  if (locator.provider !== 'sportsurge-v2') return true;
  const url = sportsurgeUrl(locator.url);
  return !!url && url.href === locator.url && !url.port && (!url.search || durableSportsurgeQuery(url)) && !url.hash && !url.pathname.includes('%') &&
    !/\.(?:m3u8?|mpd|mp4|m4s|ts|aac|mp3|webm|key)(?:$|\/)/i.test(url.pathname) &&
    !/(?:^|\/)(?:hls|dash|media|manifest|playlist|segments?|videoplayback)(?:[/.]|$)/i.test(url.pathname);
}
