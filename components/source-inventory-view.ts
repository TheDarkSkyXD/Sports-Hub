import type {CandidateSummary,StreameastCatalogView} from '../lib/football/shared.ts';

const duration=(milliseconds:number)=>{
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
};

export function candidateEvidence(candidate:CandidateSummary,now:number):string {
  switch(candidate.availability.kind) {
    case 'unknown':return 'Media not checked yet';
    case 'checking':{
      const progress=candidate.availability.progress;
      switch(progress.kind) {
        case 'queued':return 'Queued for media check · Waiting for a checker slot';
        case 'active':return `Checking media · ${duration(now-progress.since)} elapsed`;
        case 'deferred':return `Check incomplete${progress.phase?` during ${progress.phase}`:''} · Retrying in ${duration(progress.retryAt-now)}`;
        default:{const exhaustive:never=progress;return exhaustive;}
      }
    }
    case 'playable':return candidate.availability.proof==='decoded'?'Working · Playback decoded':'Media verified · Playback not yet confirmed';
    case 'unavailable':{
      const label={
        upstream:'Source media unavailable',unsupported:'Player unsupported',
        'invalid-media':'No valid video returned',timeout:'Media check timed out',playback:'Playback failed','no-feed':'No feed available from source',
      }[candidate.availability.reason];
      return candidate.availability.retryAt>now?`${label} · Waiting ${duration(candidate.availability.retryAt-now)} for next check`:
        `${label} · Check due · Waiting for a checker slot`;
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
