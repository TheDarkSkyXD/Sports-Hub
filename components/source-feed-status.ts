import type { CandidateSummary, LinkEvidence } from '../lib/football/shared.ts';

type FeedStatus = {kind:'available'|'checking';count:number} |
  {kind:'unavailable';checkedAt:number;retryAt:number};

export function groupedListingEvidence(rows:LinkEvidence[]):LinkEvidence|null {
  if(!rows.length)return null;
  const collected=rows.filter(row=>row.kind==='collected');
  if(collected.length!==rows.length)return null;
  return {kind:'collected',checkedAt:Math.max(...collected.map(row=>row.checkedAt)),
    candidateIds:[...new Set(collected.flatMap(row=>row.candidateIds))]};
}

export function collectedFeedStatus(evidence:Extract<LinkEvidence,{kind:'collected'}>,candidates:CandidateSummary[]):FeedStatus {
  const byId=new Map(candidates.map(candidate=>[candidate.id,candidate.availability]));
  let available=0,checking=0,checkedAt=0,retryAt=Infinity;
  for(const id of new Set(evidence.candidateIds)) {
    const state=byId.get(id);
    if(state?.kind==='playable')available++;
    else if(state?.kind==='unavailable') {
      checkedAt=Math.max(checkedAt,state.checkedAt);
      retryAt=Math.min(retryAt,state.retryAt);
    } else checking++;
  }
  if(available)return {kind:'available',count:available};
  if(checking||!evidence.candidateIds.length)return {kind:'checking',count:checking};
  return {kind:'unavailable',checkedAt,retryAt};
}
