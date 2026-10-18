import { load } from 'cheerio';
import { publishedFootballMatchup } from './sportsurge-matchup.ts';
import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText,ProviderDeferredError, type PlaybackProvider, type ProviderPlayback } from '../provider.ts';
import { observedPublicPage, get, hlsUrl, publicHttpsRequest, resource, sportsurgeUrl, type Requester } from './public-page.ts';
export { isPublicAddress, publicHttpsRequest, sportsurgeUrl } from './public-page.ts';

type SportsurgeLocator = Extract<CandidateLocator, { provider: 'sportsurge-v2' }>;
type PageIdentity={identity:ReturnType<typeof publishedFootballMatchup>;dates:string[]};
const MAX_PAGE_BYTES = 1024 * 1024;
const STATIC_LOOKUP_MS = 10000;
const MAX_PAGE_HOPS = 2;

class ConflictingMatchupError extends Error {}

function pageFrames(html: string, base: URL): URL[] {
  const $ = load(html);
  const frames: URL[] = [];
  const published=$('iframe[src]');
  if(published.length!==1)return frames;
  const value=published.attr('src');
  if(value){
    try {
      const url = sportsurgeUrl(new URL(value, base).href);
      if (url)frames.push(url);
    } catch {}
  }
  return frames;
}

export function sportsurgeV2Provider(requester: Requester = (url, signal, headers, timeoutMs,continuous) =>
  publicHttpsRequest(url, signal, headers, undefined, timeoutMs,continuous),
  observe:typeof observedPublicPage=observedPublicPage): PlaybackProvider<SportsurgeLocator> {
  return {
    provider: 'sportsurge-v2',
    async open(locator, signal, purpose = 'playback'): Promise<ProviderPlayback> {
      const destination = sportsurgeUrl(locator.url);
      if (!destination) throw new Error('Unsupported Sportsurge destination');
      let page = destination;
      const dudestreamEntry = destination.origin === 'https://dudestream1.com' && !destination.search &&
        /^\/[a-z0-9]{7,32}$/.test(destination.pathname);
      let dudestreamCandidate: {parent:URL;server:URL}|null = null;
      let verifiedDudestream: {parent:URL;server:URL}|null = null;
      let matched=false;
      let unverifiedDate=false;
      const pages=new Map<string,PageIdentity>();
      const expectedDate=locator.expectedMatchup?.kickoff===undefined?null:new Date(locator.expectedMatchup.kickoff).toISOString().slice(0,10);
      const acceptIdentity=({identity,dates}:PageIdentity)=>{
        if(identity==='conflicting')throw new ConflictingMatchupError('Sportsurge provider published a conflicting matchup');
        if(expectedDate&&dates.some(date=>date!==expectedDate))throw new ConflictingMatchupError('Sportsurge provider published a conflicting event date');
        if(dates.length&&!expectedDate)unverifiedDate=true;
        if(identity==='matches'&&(!dates.length||expectedDate))matched=true;
      };
      const staticDeadline=Date.now()+STATIC_LOOKUP_MS;
      const staticSignal=AbortSignal.any([signal,AbortSignal.timeout(STATIC_LOOKUP_MS)]);
      try {
        const visited = new Set<string>();
        for (let hop = 0; hop <= MAX_PAGE_HOPS; hop++) {
          if (visited.has(page.href)) break;
          visited.add(page.href);
          const remaining=staticDeadline-Date.now();
          if(remaining<=0)throw new Error('Static provider lookup deadline reached');
          const { url, response } = await get(page.href, staticSignal, requester,undefined,undefined,remaining);
          if (hlsUrl(url, response)) {
            await response.body?.cancel();
            if(hop===0)return { root: resource(url, page, 'playlist', requester), close() {} };
            break;
          }
          const type = response.headers.get('content-type') || '';
          if (type && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) {
            await response.body?.cancel();
            throw new Error('Sportsurge destination did not publish HLS');
          }
          const html = await boundedText(response, MAX_PAGE_BYTES);
          const $ = load(html);
          const headlines=[$('title').first().text().trim(),$('h1').first().text().trim()];
          const identities=headlines.map(headline=>publishedFootballMatchup(locator.expectedMatchup,headline));
          const dates=[...headlines.flatMap(headline=>headline.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[]),
            ...$('time[datetime]').map((_index,node)=>$(node).attr('datetime')?.slice(0,10)).get()]
            .filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date));
          const identity=identities.includes('conflicting')?'conflicting':identities.includes('matches')?'matches':'unknown';
          const evidence={identity,dates} satisfies PageIdentity;
          pages.set(url.href,evidence);
          if(hop===0||dudestreamCandidate?.server.href===url.href)acceptIdentity(evidence);
          const frames = pageFrames(html, url);
          if(hop===0&&dudestreamEntry&&url.origin==='https://dudestream1.com'&&
            /^\/cfb[1-9]\d{0,2}\/$/.test(url.pathname)&&!url.search&&
            $('link[rel="canonical"]').length===1&&$('link[rel="canonical"]').attr('href')===url.href&&
            frames.length===1){
            const server=frames[0];
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
          if (frames.length !== 1) break;
          page = frames[0];
        }
        throw new Error('Sportsurge destination did not publish supported HLS');
      } catch (error) {
        if (signal.aborted||error instanceof ConflictingMatchupError) throw error;
        const observed = await observe(verifiedDudestream?.server||destination, signal, purpose,
          verifiedDudestream?.parent);
        if(observed){
          try{
            if(observed.player)for(const url of new Set([observed.player.url,observed.player.referer])){
              const evidence=pages.get(url);if(evidence)acceptIdentity(evidence);
            }
          }catch(error){observed.close();throw error;}
          if((!matched||unverifiedDate)&&observed.player){
            if(!observed.root){observed.close();throw new ProviderDeferredError(30000,'ownership','unverified');}
            return {root:observed.root,timings:observed.timings,close:()=>observed.close()};
          }
          return observed;
        }
        throw error;
      }
    },
  };
}
