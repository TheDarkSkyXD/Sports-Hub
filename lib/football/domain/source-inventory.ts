import type { Candidate, Game, Observation, SourceAttempt, SourceMatchReason, SourcesSnapshot } from '../shared.ts';
import type { ListingSource } from './ports.ts';
import { createObservationMatcher } from './matching.ts';

type Input = {
  at:number; revision:number; lastDiscoveryAt:number|null; sources:readonly ListingSource[];
  observations:Observation[]; games:Game[]; candidates:ReadonlyMap<string,Candidate[]>;
  attempts:Record<string,SourceAttempt>;
};

function publicObservationUrl(value:string,hosts:Set<string>):string|null {
  try {
    const url=new URL(value);
    if (url.protocol!=='https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) return null;
    if ([...url.searchParams.keys()].some(key=>/^(?:token|access_token|auth|authorization|key|signature|sig|st|x-amz-.+)$/i.test(key))) return null;
    if (/(?:^#|[&?])(?:token|access_token|auth|authorization|key|signature|sig|st|x-amz-[^=]+)=/i.test(url.hash)) return null;
    return url.href;
  } catch {return null;}
}

function sourceReason(reason:string):SourceMatchReason {
  switch(reason) {
    case 'not-a-matchup': case 'unknown-teams': case 'unverified-kickoff':
    case 'ambiguous-matchup': case 'conflicting-date': case 'finished-game': return reason;
    default: return 'other';
  }
}

export function sourceInventory(input:Input):SourcesSnapshot {
  const {at,sources,games,candidates}=input;
  const windowStartAt=at-30*60_000;
  const gameById=new Map(games.map(game=>[game.id,game]));
  const sourceById=new Map(sources.map(source=>[source.id,source]));
  const publicHosts=new Set(sources.flatMap(source=>[source.url,...(source.publicUrls || [])].map(value=>new URL(value).hostname)));
  const match=createObservationMatcher(games);
  const linksBySource=new Map<string,Map<string,SourcesSnapshot['sources'][number]['links'][number]>>();
  const linksByGame=new Map<string,SourcesSnapshot['games'][number]['sourceLinks']>();
  const reasonsBySource=new Map<string,Map<SourceMatchReason,number>>();
  for (const observation of input.observations) {
    if (observation.observedAt<windowStartAt || observation.observedAt>at+60_000) continue;
    if (!sourceById.has(observation.sourceId)) continue;
    const url=publicObservationUrl(observation.url,publicHosts);
    if (!url) continue;
    const links=linksBySource.get(observation.sourceId) || new Map();
    if (links.has(url)) continue;
    const result=match(observation,at);
    const gameId=result.kind==='matched' && gameById.has(result.gameId) ? result.gameId : null;
    links.set(url,{title:observation.title,url,gameId});
    linksBySource.set(observation.sourceId,links);
    if (!gameId) {
      const reasons=reasonsBySource.get(observation.sourceId) || new Map<SourceMatchReason,number>();
      const reason=result.kind==='unmatched' ? sourceReason(result.reason) : 'other';
      reasons.set(reason,(reasons.get(reason) || 0)+1);
      reasonsBySource.set(observation.sourceId,reasons);
    }
    if (gameId) {
      const gameLinks=linksByGame.get(gameId) || [];
      gameLinks.push({sourceId:observation.sourceId,title:observation.title,url});
      linksByGame.set(gameId,gameLinks);
    }
  }
  const sourceRows=sources.map(source=>{
    const links=[...(linksBySource.get(source.id)?.values() || [])];
    const matched=new Set(links.flatMap(link=>link.gameId ? [link.gameId] : []));
    return {
      id:source.id,name:source.name || source.id.replace(/-/g,' '),catalogUrl:source.url,
      publicUrls:[...new Set(source.publicUrls || [source.url])],pending:source.kind==='pending',
      lastAttempt:input.attempts[source.id] || null,listingCount:links.length,matchedGameCount:matched.size,
      unmatchedListingCount:links.length-links.filter(link=>link.gameId).length,
      unmatchedReasons:[...(reasonsBySource.get(source.id) || new Map()).entries()].map(([reason,count])=>({reason,count})),links,
    };
  });
  const gameRows=games.flatMap(game=>{
    const sourceLinks=linksByGame.get(game.id) || [];
    if (!sourceLinks.length) return [];
    const sourceCount=new Set(sourceLinks.map(link=>link.sourceId)).size;
    const currentSources=new Set(sourceLinks.map(link=>link.sourceId));
    const uniqueFeedCount=new Set((candidates.get(game.id) || []).filter(candidate=>candidate.observedAt>=windowStartAt &&
      candidate.observedAt<=at+60_000 && candidate.sourceIds.some(sourceId=>currentSources.has(sourceId)))
      .map(candidate=>candidate.id)).size;
    return [{gameId:game.id,name:game.name,sourceCount,uniqueFeedCount,sourceLinks}];
  });
  return {at,revision:input.revision,windowStartAt,lastDiscoveryAt:input.lastDiscoveryAt,sources:sourceRows,games:gameRows};
}
