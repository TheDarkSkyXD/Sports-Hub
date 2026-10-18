import type {CandidateSummary,League,MediaPhase,SourcesSnapshot,StreameastCatalogView} from '../lib/football/shared.ts';
import { relativeStartDay } from '../lib/game-timing.ts';

export function createInventoryEventTimeFormatter(timeZone:string) {
  const clock=new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  const dated=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',month:'short',day:'numeric',
    hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  return (date:string|null|undefined,now:number):string=>{
    const start=date?Date.parse(date):NaN;
    if(!Number.isFinite(start))return 'Start time not confirmed';
    const day=relativeStartDay({start,now,timeZone});
    return day?`${day}, ${clock.format(start)}`:dated.format(start);
  };
}

export function scopedSourceLinks(links:SourcesSnapshot['sources'][number]['links'],
  knownLeagues:ReadonlyMap<string,League|undefined>,scope:League|'all') {
  const classified:typeof links=[];
  const unclassified:typeof links=[];
  const otherEvents:typeof links=[];
  for(const link of links) {
    const continuous=link.gameId===null&&/\b24\s*(?:\/|x|-)\s*7\b/i.test(link.title);
    const league=continuous?null:(link.gameId?knownLeagues.get(link.gameId):undefined)??link.league;
    if(continuous)unclassified.push(link);
    else if(league===null){if(scope==='all')otherEvents.push(link);}
    else if(scope==='all'||league===scope)classified.push(link);
  }
  return {links:classified,unclassifiedLinks:unclassified,otherEventLinks:otherEvents};
}

export function sourceListingUrls(source:Pick<SourcesSnapshot['sources'][number],'publicUrls'|'scopes'>,league:League|'all'):string[] {
  const scoped=source.scopes.find(scope=>scope.league===league)?.publicUrls;
  const urls=league==='all'?[...source.publicUrls,...source.scopes.flatMap(scope=>scope.publicUrls)]:
    scoped?.length?scoped:source.publicUrls;
  return [...new Set(urls)];
}

const duration=(milliseconds:number)=>{
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
};
const phaseLabel:Record<MediaPhase,string>={resolution:'finding the source',activation:'starting the player',capture:'finding the video',
  ownership:'checking the selected player',replay:'reading the stream',decode:'decoding video'};

export function candidateEvidence(candidate:CandidateSummary,now:number):string {
  switch(candidate.availability.kind) {
    case 'unknown':return 'Waiting for first playback check';
    case 'checking':{
      const progress=candidate.availability.progress;
      switch(progress.kind) {
        case 'queued':return 'Playback check scheduled';
        case 'active':return `Checking playback · ${duration(now-progress.since)} elapsed`;
        case 'deferred':return `${progress.reason==='capacity'?'Waiting for a playback check':`Check incomplete${progress.phase?` while ${phaseLabel[progress.phase]}`:''}`} · ${progress.retryAt>now?
          `Retrying in ${duration(progress.retryAt-now)}`:'Retry due'}`;
        default:{const exhaustive:never=progress;return exhaustive;}
      }
    }
    case 'playable':return 'Working · Video playback confirmed';
    case 'unavailable':{
      const label={
        upstream:'Source media unavailable',unsupported:'Player unsupported',blocked:'Source denied media access','not-found':'Source media not found',
        'invalid-media':'No valid video returned',timeout:'Media check timed out',playback:'Playback failed','no-feed':'No feed available from source',
      }[candidate.availability.reason];
      return candidate.availability.retryAt>now?`${label} · Waiting ${duration(candidate.availability.retryAt-now)} for next check`:
        `${label} · Check due`;
    }
    default:{const exhaustive:never=candidate.availability;return exhaustive;}
  }
}

type Listing=StreameastCatalogView['games'][number];
type Collected=Extract<Listing['detail'],{kind:'collected'}>;

export function retainedStreameastDetail(current:Listing,history:readonly Listing[]):Collected|null {
  if(!current.gameId||current.detail.kind==='collected')return null;
  let newest:Collected|null=null;
  for(const prior of history) {
    const detail=prior.detail;
    if(prior.id!==current.id||prior.url!==current.url||prior.league!==current.league||
      prior.gameId!==current.gameId||detail.kind!=='collected')continue;
    if(!newest||detail.at>newest.at)newest=detail;
  }
  return newest;
}
