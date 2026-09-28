import { candidateSummary, type Candidate, type CandidateAvailability, type Game, type Match, type Observation, type SourceAttempt, type SourceMatchReason, type SourcesSnapshot, type StoredSportsurgeCatalog, type StoredStreameastCatalog, type StreameastCatalog } from '../shared.ts';
import { compareCandidates } from './lifecycle.ts';
import type { ListingSource } from './ports.ts';
import { createObservationMatcher, normalizedName } from './matching.ts';
import { sportsurgeCatalogView, sportsurgeObservation } from './sportsurge-catalog.ts';
import { streameastCatalogView, streameastObservation, verifiedStreameastMatch } from './streameast-catalog.ts';

type Input = {
  at:number; revision:number; lastDiscoveryAt:number|null; browserCollectorsAvailable:boolean; sources:readonly ListingSource[];
  observations:Observation[]; games:Game[]; candidates:ReadonlyMap<string,Candidate[]>;
  availability?:(candidate:Candidate)=>CandidateAvailability;
  attempts:Record<string,SourceAttempt>;
  sportsurgeCatalog:{current:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null};
  streameastCatalog:{current:StoredStreameastCatalog|null;lastComplete:StoredStreameastCatalog|null;previous:StoredStreameastCatalog|null};
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

function sameMatchup(left:Observation,right:Observation):boolean {
  if (left.sourceId!==right.sourceId || left.url!==right.url || left.league!==right.league || !left.teams || !right.teams) return false;
  const pair=(teams:[string,string])=>teams.map(normalizedName).sort().join('|');
  return pair(left.teams)===pair(right.teams);
}

export function sourceInventory(input:Input):SourcesSnapshot {
  const {at,sources,games,candidates}=input;
  const availability=input.availability||(()=>({kind:'unknown' as const}));
  const windowStartAt=at-30*60_000;
  const gameById=new Map(games.map(game=>[game.id,game]));
  const sourceById=new Map(sources.map(source=>[source.id,source]));
  const publicHosts=new Set(sources.flatMap(source=>[source.url,...(source.publicUrls || [])].map(value=>new URL(value).hostname)));
  const match=createObservationMatcher(games,'inventory-live');
  const liveDates=games.filter(game=>game.lifecycle==='live' && game.date).map(game=>({league:game.league,date:Date.parse(game.date || '')}));
  const linksBySource=new Map<string,Map<string,SourcesSnapshot['sources'][number]['links'][number]>>();
  const linksByGame=new Map<string,SourcesSnapshot['games'][number]['sourceLinks']>();
  const reasonsBySource=new Map<string,Map<SourceMatchReason,number>>();
  const matchedBySource=new Map<string,Set<string>>();
  const add=(observation:Observation,fallback=false,event:StreameastCatalog['events'][number]|null=null,sourceLive=false):void=>{
    if (!sourceById.has(observation.sourceId)) return;
    const url=publicObservationUrl(observation.url,publicHosts);
    if (!url || observation.observedAt>at+60_000) return;
    const stale=fallback || observation.observedAt<windowStartAt;
    const kickoff=observation.kickoff;
    if (stale && (!observation.teams || kickoff===null || !liveDates.some(game=>
      (!observation.league || game.league===observation.league) && Math.abs(game.date-kickoff)<=3*60*60_000))) return;
    const links=linksBySource.get(observation.sourceId) || new Map();
    if (links.has(url)) return;
    const raw=match(observation,at);
    const liveIds=sourceLive && !stale && observation.league && observation.teams && observation.kickoff===null &&
      raw.kind==='unmatched' && raw.reason==='unverified-kickoff' && raw.possibleGameIds.length===1 &&
      gameById.get(raw.possibleGameIds[0])?.lifecycle==='live' ? raw.possibleGameIds : [];
    const result:Match=liveIds.length===1 ? {kind:'matched',gameId:liveIds[0]}:
      event===null?raw:verifiedStreameastMatch(event,raw,gameById.get(raw.kind==='matched'?raw.gameId:''));
    const gameId=result.kind==='matched' && gameById.has(result.gameId) ? result.gameId : null;
    if (stale && (!gameId || gameById.get(gameId)?.lifecycle!=='live')) return;
    if (fallback && gameId && matchedBySource.get(observation.sourceId)?.has(gameId)) return;
    const freshness=stale?'stale-live':'fresh';
    links.set(url,{title:observation.title,url,gameId,observedAt:observation.observedAt,freshness});
    linksBySource.set(observation.sourceId,links);
    if (!gameId) {
      const reasons=reasonsBySource.get(observation.sourceId) || new Map<SourceMatchReason,number>();
      const reason=result.kind==='unmatched' ? sourceReason(result.reason) : 'other';
      reasons.set(reason,(reasons.get(reason) || 0)+1);
      reasonsBySource.set(observation.sourceId,reasons);
    }
    if (gameId) {
      const matched=matchedBySource.get(observation.sourceId) || new Set<string>();
      matched.add(gameId);
      matchedBySource.set(observation.sourceId,matched);
      const gameLinks=linksByGame.get(gameId) || [];
      gameLinks.push({sourceId:observation.sourceId,title:observation.title,url,observedAt:observation.observedAt,freshness});
      linksByGame.set(gameId,gameLinks);
    }
  };
  for (const observation of input.observations) {
    if (observation.sourceId==='sportsurge-v2'||observation.sourceId==='streameast') continue;
    add(observation);
  }
  const datedLive=(observation:Observation,event:StreameastCatalog['events'][number]|null=null):boolean=>{
    const raw=match(observation,at);
    const result=event===null?raw:verifiedStreameastMatch(event,raw,gameById.get(raw.kind==='matched'?raw.gameId:''));
    return result.kind==='matched' && gameById.get(result.gameId)?.lifecycle==='live';
  };
  const sportsurgeRuns=input.sportsurgeCatalog.current?.catalog.state.kind==='complete'?
    [input.sportsurgeCatalog.current]:
    [input.sportsurgeCatalog.current,input.sportsurgeCatalog.previous,input.sportsurgeCatalog.lastComplete];
  const sportsurgeHistory=sportsurgeRuns.slice(1).map(stored=>new Map(stored?.catalog.events.map(event=>[event.url,event]) || []));
  const sportsurgeSeen=new Set<string>();
  for (const [runIndex,stored] of sportsurgeRuns.entries()) {
    if (!stored) continue;
    for (const event of stored.catalog.events) {
      const category=stored.catalog.categories[event.league];
      if(category.kind!=='collected')continue;
      if (sportsurgeSeen.has(event.url)) continue;
      sportsurgeSeen.add(event.url);
      const observation=sportsurgeObservation(event,category.at);
      if (runIndex===0 && observation.kickoff===null) {
        const historical=sportsurgeHistory.flatMap((events,index)=>{
          const prior=events.get(event.url);
          const run=sportsurgeRuns[index+1];
          if (!prior || !run) return [];
          const priorCategory=run.catalog.categories[prior.league];
          return [sportsurgeObservation(prior,priorCategory.kind==='pending'?run.catalog.startedAt:priorCategory.at)];
        }).find(prior=>prior.kickoff!==null && sameMatchup(observation,prior));
        if (historical && datedLive(historical)) {
          add({...observation,kickoff:historical.kickoff,rawTime:historical.rawTime});
          continue;
        }
      }
      add(observation,false,null,category.kind==='collected' && event.sourceStatus==='live');
    }
  }
  const streameastRuns=[input.streameastCatalog.current,input.streameastCatalog.previous,input.streameastCatalog.lastComplete];
  const streameastHistory=streameastRuns.slice(1).map(stored=>new Map(stored?.catalog.events.map(event=>[event.id,event]) || []));
  const streameastSeen=new Set<string>();
  for (const [runIndex,stored] of streameastRuns.entries()) {
    if (!stored) continue;
    for (const event of stored.catalog.events) {
      if (streameastSeen.has(event.id)) continue;
      streameastSeen.add(event.id);
      const category=stored.catalog.categories[event.league];
      const observation=streameastObservation(event,category.kind==='pending'?stored.catalog.startedAt:category.at);
      if (runIndex===0 && observation.kickoff===null) {
        const historical=streameastHistory.flatMap((events,index)=>{
          const prior=events.get(event.id);
          const run=streameastRuns[index+1];
          if (!prior || !run) return [];
          const priorCategory=run.catalog.categories[prior.league];
          return [{event:prior,observation:streameastObservation(prior,priorCategory.kind==='pending'?run.catalog.startedAt:priorCategory.at)}];
        }).find(prior=>prior.observation.kickoff!==null && sameMatchup(observation,prior.observation));
        if (historical && datedLive(historical.observation,historical.event) && datedLive(historical.observation,event)) {
          add(historical.observation,true,event);
          continue;
        }
      }
      add(observation,runIndex>0,event);
    }
  }
  const sourceRows=sources.map(source=>{
    const links=[...(linksBySource.get(source.id)?.values() || [])];
    const matched=new Set(links.flatMap(link=>link.gameId ? [link.gameId] : []));
    const freshGames=new Set(links.flatMap(link=>link.gameId && link.freshness==='fresh' ? [link.gameId] : []));
    const compatibleFeedCount=new Set([...freshGames].flatMap(gameId=>(candidates.get(gameId) || [])
      .filter(candidate=>candidate.observedAt>=windowStartAt && candidate.observedAt<=at+60_000 && candidate.sourceIds.includes(source.id) && availability(candidate).kind==='playable')
      .map(candidate=>`${gameId}:${candidate.id}`))).size;
    return {
      id:source.id,name:source.name || source.id.replace(/-/g,' '),catalogUrl:source.url,
      publicUrls:[...new Set(source.publicUrls || [source.url])],pending:source.kind==='pending',
      collectionMode:source.kind==='catalog'
        ? 'listings-only' as const : 'compatible-feed-discovery' as const,
      lastAttempt:input.attempts[source.id] || null,listingCount:links.length,matchedGameCount:matched.size,
      staleListingCount:links.filter(link=>link.freshness==='stale-live').length,compatibleFeedCount,
      unmatchedListingCount:links.length-links.filter(link=>link.gameId).length,
      unmatchedReasons:[...(reasonsBySource.get(source.id) || new Map()).entries()].map(([reason,count])=>({reason,count})),links,
    };
  });
  const gameRows=games.flatMap(game=>{
    if(game.lifecycle!=='scheduled'&&game.lifecycle!=='live')return [];
    const sourceLinks=linksByGame.get(game.id) || [];
    const selectable=(candidates.get(game.id) || []).filter(candidate=>at-candidate.observedAt<30*60_000)
      .sort(compareCandidates).map(candidate=>candidateSummary(candidate,availability(candidate)));
    if (!sourceLinks.length && !selectable.length) return [];
    const sourceCount=new Set(sourceLinks.map(link=>link.sourceId)).size;
    const currentSources=new Set(sourceLinks.filter(link=>link.freshness==='fresh').map(link=>link.sourceId));
    const uniqueFeedCount=new Set((candidates.get(game.id) || []).filter(candidate=>candidate.observedAt>=windowStartAt &&
      candidate.observedAt<=at+60_000 && candidate.sourceIds.some(sourceId=>currentSources.has(sourceId)) && availability(candidate).kind==='playable')
      .map(candidate=>candidate.id)).size;
    return [{gameId:game.id,name:game.name,sourceCount,uniqueFeedCount,candidates:selectable,sourceLinks}];
  });
  return {at,revision:input.revision,windowStartAt,lastDiscoveryAt:input.lastDiscoveryAt,browserCollectorsAvailable:input.browserCollectorsAvailable,
    sportsurgeV2:{
      current:input.sportsurgeCatalog.current ? sportsurgeCatalogView(input.sportsurgeCatalog.current,games,at) : null,
      lastComplete:input.sportsurgeCatalog.lastComplete ? sportsurgeCatalogView(input.sportsurgeCatalog.lastComplete,games,at) : null,
      previous:input.sportsurgeCatalog.previous ? sportsurgeCatalogView(input.sportsurgeCatalog.previous,games,at) : null,
    },
    streameast:{
      current:input.streameastCatalog.current ? streameastCatalogView(input.streameastCatalog.current,games,at) : null,
      lastComplete:input.streameastCatalog.lastComplete ? streameastCatalogView(input.streameastCatalog.lastComplete,games,at) : null,
      previous:input.streameastCatalog.previous ? streameastCatalogView(input.streameastCatalog.previous,games,at) : null,
    },sources:sourceRows,games:gameRows};
}
