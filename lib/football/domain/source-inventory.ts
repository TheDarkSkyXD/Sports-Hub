import { candidateSummary, type Candidate, type CandidateAvailability, type CollectionAttempt, type CollectionHealth, type DetailEvidence, type Game, type LinkEvidence, type Match, type Observation, type SourceAttempt, type SourceEventBinding, type SourceMatchReason, type SourcesSnapshot, type StoredSportsurgeCatalog, type StoredStreameastCatalog, type StreameastCatalog } from '../shared.ts';
import { compareCandidates } from './lifecycle.ts';
import { detailIdentity } from './source-policy.ts';
import { resolvedLiveChannelMatch } from './live-channel.ts';
import { feedDateEligible, feedEligible, feedWindow } from './feed-eligibility.ts';
import { sourceCoverage } from '../source-registry.ts';
import type { ListingSource } from './ports.ts';
import { createFinishedGameMatcher, createObservationMatcher, matchSourceLiveGame, matchUndatedSportsurge, normalizedName } from './matching.ts';
import { sportsurgeCatalogView, sportsurgeObservation } from './sportsurge-catalog.ts';
import { streameastCatalogView, streameastObservation, verifiedStreameastMatch } from './streameast-catalog.ts';

type Input = {
  at:number; revision:number; lastDiscoveryAt:number|null; browserCollectorsAvailable:boolean; sources:readonly ListingSource[];
  observations:Observation[]; games:Game[]; candidates:ReadonlyMap<string,Candidate[]>;
  visibleGameIds?:ReadonlySet<string>;
  freshGameIds?:ReadonlySet<string>;
  details?:DetailEvidence[]; collectionHistory?:CollectionAttempt[];
  sourceEventBindings?:readonly SourceEventBinding[];
  availability?:(candidate:Candidate)=>CandidateAvailability;
  candidateEligible?:(candidate:Candidate)=>boolean;
  compareCandidates?:(left:Candidate,right:Candidate)=>number;
  attempts:Record<string,SourceAttempt>;
  scheduleScopes?:SourcesSnapshot['scheduleScopes'];
  sportsurgeCatalog:{current:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null};
  streameastCatalog:{current:StoredStreameastCatalog|null;lastComplete:StoredStreameastCatalog|null;previous:StoredStreameastCatalog|null};
};

type ReadState=SourcesSnapshot['scheduleScopes'][number]['read'];
type FeedState=SourcesSnapshot['games'][number]['feeds'];
function noPublishedFeed(evidence:LinkEvidence):boolean {
  return evidence.kind==='missing'&&(evidence.reason==='no-published-player'||evidence.reason==='not-yet-published');
}
function feedCounts(rows:readonly Candidate[],availability:(candidate:Candidate)=>CandidateAvailability):FeedState {
  const states=rows.map(availability);
  return {kind:'feeds',discovered:rows.length,
    mediaVerified:states.filter(state=>state.kind==='playable').length,
    decoded:states.filter(state=>state.kind==='playable'&&state.proof==='decoded').length,
    checking:states.filter(state=>state.kind==='unknown'||state.kind==='checking').length};
}

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
    case 'not-a-matchup': case 'unknown-teams': case 'unverified-kickoff': case 'unverified-contextual-kickoff':
    case 'ambiguous-matchup': case 'conflicting-date': case 'finished-game': return reason;
    default: return 'other';
  }
}

function sameMatchup(left:Observation,right:Observation):boolean {
  if (left.sourceId!==right.sourceId || left.url!==right.url || left.league!==right.league || !left.teams || !right.teams) return false;
  const pair=(teams:[string,string])=>teams.map(normalizedName).sort().join('|');
  return pair(left.teams)===pair(right.teams);
}

function detailGeneration(observation:Observation):string {
  return JSON.stringify([observation.sourceId,observation.url,observation.teams,observation.kickoff,
    observation.observedAt,observation.parserVersion]);
}

function collectionHealth(sourceId:string,history:readonly CollectionAttempt[],playerDrop:CollectionHealth|null):CollectionHealth {
  const scopes=new Map<string,CollectionAttempt[]>();
  for(const attempt of history.filter(row=>row.sourceId===sourceId)) {
    const key=attempt.league||'all';
    const rows=scopes.get(key)||[];
    rows.push(attempt);
    scopes.set(key,rows);
  }
  const findings:CollectionHealth[]=[];
  for(const rows of scopes.values()) {
    rows.sort((a,b)=>b.at-a.at);
    const current=rows[0];
    const baseline=rows.find(row=>row.at<current.at&&row.outcome==='parsed'&&row.count>0);
    if(!baseline)continue;
    const reason=current.outcome==='parser-changed'?'parser-changed':
      current.outcome==='failed'?'collection-failed':
        current.count===0&&(current.outcome==='empty'||current.outcome==='parsed')?'empty-after-success':null;
    findings.push(reason?{kind:'attention',reason,currentAt:current.at,currentCount:current.count,
      baselineAt:baseline.at,baselineCount:baseline.count}:{kind:'healthy',currentAt:current.at,
      currentCount:current.count,baselineAt:baseline.at,baselineCount:baseline.count});
  }
  const attention=findings.filter(row=>row.kind==='attention').sort((a,b)=>b.currentAt-a.currentAt)[0];
  if(attention)return attention;
  if(playerDrop)return playerDrop;
  return findings.filter(row=>row.kind!=='no-baseline').sort((a,b)=>b.currentAt-a.currentAt)[0]||{kind:'no-baseline'};
}

export function sourceInventory(input:Input):SourcesSnapshot {
  const {at,sources,games,candidates}=input;
  const availability=(candidate:Candidate):CandidateAvailability=>input.availability?.(candidate)||{kind:'unknown'};
  const windowStartAt=at-30*60_000;
  const candidateCurrent=input.candidateEligible??((candidate:Candidate)=>
    candidate.observedAt>=windowStartAt&&candidate.observedAt<=at+60_000);
  const details=new Map((input.details||[]).map(detail=>[detail.observationId,detail]));
  const gameById=new Map(games.map(game=>[game.id,game]));
  const visibleGameIds=input.visibleGameIds??new Set(games.filter(game=>feedEligible(game,at)).map(game=>game.id));
  const candidateEligible=(candidate:Candidate):boolean=>{
    return visibleGameIds.has(candidate.gameId)&&candidateCurrent(candidate);
  };
  const sourceById=new Map(sources.map(source=>[source.id,source]));
  const publicHosts=new Set(sources.flatMap(source=>[source.url,...(source.publicUrls || [])].map(value=>new URL(value).hostname)));
  const match=createObservationMatcher(games,'inventory-live');
  const finished=createFinishedGameMatcher(games);
  const freshGames=games.filter(game=>input.freshGameIds?.has(game.id));
  const visibleObservation=(observation:Observation,result:Match):boolean=>{
    if(result.kind==='matched') {
      return visibleGameIds.has(result.gameId);
    }
    if(result.reason==='finished-game')return false;
    if(result.possibleGameIds.length&&!result.possibleGameIds.some(id=>{
      return visibleGameIds.has(id);
    }))return false;
    return observation.kickoff===null||feedDateEligible(observation.kickoff,at);
  };
  const liveDates=games.filter(game=>visibleGameIds.has(game.id)&&game.lifecycle==='live' && game.date)
    .map(game=>({league:game.league,date:Date.parse(game.date || '')}));
  const linksBySource=new Map<string,Map<string,SourcesSnapshot['sources'][number]['links'][number]>>();
  const linksByGame=new Map<string,SourcesSnapshot['games'][number]['sourceLinks']>();
  const reasonsBySource=new Map<string,Map<SourceMatchReason,number>>();
  const matchedBySource=new Map<string,Set<string>>();
  const playerDropBySource=new Map<string,CollectionHealth>();
  const evidenceFor=(observation:Observation,result:Match):LinkEvidence=>{
    if(result.kind==='unmatched')return {kind:'unmatched',reason:sourceReason(result.reason)};
    const detail=details.get(observation.id);
    if(!detail)return {kind:'pending'};
    const identityMatches=detail.outcome==='resolved'&&detail.identity?
      detail.identity===detailIdentity(observation):detail.generation===detailGeneration(observation);
    const game=gameById.get(result.gameId);
    const retainedPublished=detail.outcome==='resolved'&&
      detail.identity===detailIdentity(observation)&&detail.players.length>0&&game?.lifecycle==='live'&&
      game.finalObservedAt===undefined&&detail.players.every(player=>(candidates.get(result.gameId)||[]).some(candidate=>
        candidate.sourceIds.includes(observation.sourceId)&&candidateEligible(candidate)&&
        availability(candidate).kind==='playable'&&JSON.stringify(candidate.locator)===JSON.stringify(player.locator)));
    if(detail.at>at+60_000||!identityMatches||
      (detail.at<windowStartAt||observation.observedAt<windowStartAt)&&!retainedPublished)return {kind:'pending'};
    if(detail.outcome==='resolved')return {kind:'collected',checkedAt:detail.at,
      candidateIds:(candidates.get(result.gameId)||[]).filter(candidate=>candidate.sourceIds.includes(observation.sourceId)&&
        detail.players.some(player=>JSON.stringify(player.locator)===JSON.stringify(candidate.locator))).map(candidate=>candidate.id)};
    if(detail.outcome==='failed')return {kind:'failed',checkedAt:detail.at,failure:detail.failure,
      retryAt:detail.nextEligibleAt};
    return {kind:'missing',checkedAt:detail.at,reason:detail.reason,retryAt:detail.nextEligibleAt};
  };
  const add=(observation:Observation,fallback=false,event:StreameastCatalog['events'][number]|null=null,
    sourceLive=false,catalogEvidence?:LinkEvidence,eventId?:string):void=>{
    const expectedId=event?.espnEventId===null||!event?.espnEventId?undefined:
      event.league==='nfl'?event.espnEventId:`${event.league}-${event.espnEventId}`;
    if(finished.finishedGameId(observation,at,expectedId)||eventId&&
      finished.finishedBoundEvent(observation,eventId,input.sourceEventBindings||[]))return;
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
    const live=sourceLive&&!stale&&observation.league&&observation.teams&&observation.kickoff===null?
      matchSourceLiveGame(raw,games,at):raw;
    const resolved:Match=event===null?resolvedLiveChannelMatch(observation,live,freshGames,details.get(observation.id),at):
      verifiedStreameastMatch(event,raw,gameById.get(raw.kind==='matched'?raw.gameId:''));
    const result=matchUndatedSportsurge(observation,resolved,games,at);
    if(!visibleObservation(observation,result))return;
    const gameId=result.kind==='matched' && gameById.has(result.gameId) ? result.gameId : null;
    if (stale && (!gameId || gameById.get(gameId)?.lifecycle!=='live')) return;
    if (fallback && gameId && matchedBySource.get(observation.sourceId)?.has(gameId)) return;
    const freshness=stale?'stale-live':'fresh';
    const publishedEvidence=catalogEvidence||evidenceFor(observation,result);
    const evidence=publishedEvidence.kind==='collected'?
      {...publishedEvidence,candidateIds:publishedEvidence.candidateIds.filter(id=>
        !!gameId&&(candidates.get(gameId)||[]).some(candidate=>candidate.id===id&&
          candidateEligible(candidate)))}:publishedEvidence;
    links.set(url,{title:observation.title,url,gameId,league:gameId?gameById.get(gameId)?.league??observation.league:observation.league,
      observedAt:observation.observedAt,freshness,evidence});
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
      gameLinks.push({sourceId:observation.sourceId,title:observation.title,url,observedAt:observation.observedAt,freshness,evidence});
      linksByGame.set(gameId,gameLinks);
      const detail=details.get(observation.id);
      if(detail?.outcome==='unresolved'&&detail.generation===detailGeneration(observation)&&detail.reason!=='not-yet-published'&&
        detail.lastSuccess?.identity===detailIdentity(observation)&&detail.lastSuccess.at<detail.at&&
        detail.lastSuccess.at>=at-24*3600000) {
        const prior=playerDropBySource.get(observation.sourceId);
        if(!prior||prior.kind!=='attention'||prior.currentAt<detail.at)
          playerDropBySource.set(observation.sourceId,{kind:'attention',reason:detail.reason==='parser-changed'?'parser-changed':'player-drop',currentAt:detail.at,
            currentCount:0,baselineAt:detail.lastSuccess.at,baselineCount:detail.lastSuccess.count});
      }
    }
  };
  for (const observation of input.observations) {
    if (observation.sourceId==='sportsurge-v2'||observation.sourceId==='streameast') continue;
    add(observation);
  }
  const datedLive=(observation:Observation,event:StreameastCatalog['events'][number]|null=null):boolean=>{
    const raw=match(observation,at);
    const result=event===null?raw:verifiedStreameastMatch(event,raw,gameById.get(raw.kind==='matched'?raw.gameId:''));
    return result.kind==='matched' && visibleGameIds.has(result.gameId)&&gameById.get(result.gameId)?.lifecycle==='live';
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
      const catalogEvidence:LinkEvidence=event.detail.kind==='pending'?{kind:'pending'}:
        event.detail.kind==='failed'?{kind:'failed',checkedAt:event.detail.at,
          failure:event.detail.reason==='timeout'?'timed-out':event.detail.reason==='blocked'?'blocked':event.detail.reason==='rate-limited'?'rate-limited':'upstream-error',retryAt:null}:
          {kind:'collected',checkedAt:event.detail.at,candidateIds:[...candidates.values()].flat()
            .filter(candidate=>candidate.sourceIds.includes('sportsurge-v2')&&
              candidate.locator.provider==='sportsurge-v2'&&candidate.locator.eventId===event.id)
            .map(candidate=>candidate.id)};
      const publishedEvidence:LinkEvidence=catalogEvidence.kind==='collected'&&!catalogEvidence.candidateIds.length?
        {kind:'missing',checkedAt:catalogEvidence.checkedAt,
          reason:event.detail.kind==='collected'&&event.detail.providers.length?'unsupported-player':'no-published-player',retryAt:null}:
          catalogEvidence;
      if (runIndex===0 && observation.kickoff===null) {
        const historical=sportsurgeHistory.flatMap((events,index)=>{
          const prior=events.get(event.url);
          const run=sportsurgeRuns[index+1];
          if (!prior || !run) return [];
          const priorCategory=run.catalog.categories[prior.league];
          return [sportsurgeObservation(prior,priorCategory.kind==='pending'?run.catalog.startedAt:priorCategory.at)];
        }).find(prior=>prior.kickoff!==null && sameMatchup(observation,prior));
        if (historical && datedLive(historical)) {
          add({...observation,kickoff:historical.kickoff,rawTime:historical.rawTime},false,null,false,publishedEvidence,event.id);
          continue;
        }
      }
      add(observation,false,null,category.kind==='collected' && event.sourceStatus==='live',publishedEvidence,event.id);
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
      const catalogEvidence:LinkEvidence=event.detail.kind==='pending'?{kind:'pending'}:
        event.detail.kind==='failed'?{kind:'failed',checkedAt:event.detail.at,
          failure:event.detail.reason==='timeout'?'timed-out':event.detail.reason==='blocked'?'blocked':event.detail.reason==='rate-limited'?'rate-limited':'upstream-error',retryAt:null}:
          {kind:'collected',checkedAt:event.detail.at,candidateIds:[...candidates.values()].flat()
            .filter(candidate=>candidate.sourceIds.includes('streameast')&&event.detail.kind==='collected'&&
              event.detail.servers.some(server=>server.availability.kind==='free-channel'&&
                candidate.locator.provider==='streameast'&&candidate.locator.channelId===server.availability.channelId||
                server.availability.kind==='free-wikisport'&&candidate.locator.provider==='wikisport'&&
                candidate.locator.section===server.availability.section&&candidate.locator.playerId===server.availability.playerId||
                server.availability.kind==='free-page'&&candidate.locator.provider==='streameast-server'&&
                candidate.locator.sourceEventId===event.id&&candidate.locator.eventUrl===event.url&&
                candidate.locator.serverId===server.id))
            .map(candidate=>candidate.id)};
      const publishedEvidence:LinkEvidence=catalogEvidence.kind==='collected'&&!catalogEvidence.candidateIds.length?
        {kind:'missing',checkedAt:catalogEvidence.checkedAt,
          reason:event.detail.kind==='collected'&&event.detail.servers.length&&event.detail.servers.every(server=>server.availability.kind==='premium')?
            'paid-only':event.detail.kind==='collected'&&event.detail.servers.some(server=>server.availability.kind==='free-unsupported')?
              'unsupported-player':'no-published-player',retryAt:null}:catalogEvidence;
      if (runIndex===0 && observation.kickoff===null) {
        const historical=streameastHistory.flatMap((events,index)=>{
          const prior=events.get(event.id);
          const run=streameastRuns[index+1];
          if (!prior || !run) return [];
          const priorCategory=run.catalog.categories[prior.league];
          return [{event:prior,observation:streameastObservation(prior,priorCategory.kind==='pending'?run.catalog.startedAt:priorCategory.at)}];
        }).find(prior=>prior.observation.kickoff!==null && sameMatchup(observation,prior.observation));
        if (historical && datedLive(historical.observation,historical.event) && datedLive(historical.observation,event)) {
          add(historical.observation,true,event,false,publishedEvidence);
          continue;
        }
      }
      add(observation,runIndex>0,event,false,publishedEvidence);
    }
  }
  const sourceRows=sources.map(source=>{
    const links=[...(linksBySource.get(source.id)?.values() || [])];
    const matched=new Set(links.flatMap(link=>link.gameId ? [link.gameId] : []));
    const freshGames=new Set(links.flatMap(link=>link.gameId && link.freshness==='fresh' ? [link.gameId] : []));
    const compatibleFeedCount=new Set([...freshGames].flatMap(gameId=>(candidates.get(gameId) || [])
      .filter(candidate=>candidateEligible(candidate) && candidate.sourceIds.includes(source.id) && availability(candidate).kind==='playable')
      .map(candidate=>`${gameId}:${candidate.id}`))).size;
    const freeChoiceCount=new Set([...candidates].flatMap(([gameId,rows])=>rows
      .filter(candidate=>candidateEligible(candidate)&&candidate.sourceIds.includes(source.id))
      .map(candidate=>`${gameId}:${candidate.id}`))).size;
    const workingChoiceCount=new Set([...candidates].flatMap(([gameId,rows])=>rows
      .filter(candidate=>candidateEligible(candidate)&&
        candidate.sourceIds.includes(source.id)&&availability(candidate).kind==='playable')
      .map(candidate=>`${gameId}:${candidate.id}`))).size;
    const leagues=[...(source.leagues??sourceCoverage(source.id))];
    const scopes=leagues.map(league=>{
      const scopeLinks=links.filter(link=>link.freshness==='fresh'&&(link.league===league||link.league===null));
      const run=source.id==='sportsurge-v2'?input.sportsurgeCatalog.current:source.id==='streameast'?input.streameastCatalog.current:null;
      let read:ReadState;
      if(source.kind==='pending')read={kind:'incomplete',reason:'unavailable',checkedAt:null};
      else if(source.kind==='browser-catalog') {
        const category=run?Object.entries(run.catalog.categories).find(([key])=>key===league)?.[1]:undefined;
        read=!input.browserCollectorsAvailable?{kind:'incomplete',reason:'unavailable',checkedAt:null}:
          !category||category.kind==='pending'?{kind:'incomplete',reason:'pending',checkedAt:null}:
          category.kind==='failed'?{kind:'incomplete',reason:'failed',checkedAt:category.at}:
          at-category.at>=30*60_000?{kind:'incomplete',reason:'stale',checkedAt:category.at}:
          run?.catalog.rejectedGames.some(event=>event.league===league)?{kind:'incomplete',reason:'partial',checkedAt:category.at}:
          {kind:'complete',checkedAt:category.at};
      } else {
        const attempt=input.attempts[source.id];
        read=!attempt?{kind:'incomplete',reason:'pending',checkedAt:null}:
          at-attempt.at>=30*60_000?{kind:'incomplete',reason:'stale',checkedAt:attempt.at}:
          attempt.outcome==='parsed'||attempt.outcome==='empty'?{kind:'complete',checkedAt:attempt.at}:
          {kind:'incomplete',reason:'failed',checkedAt:attempt.at};
      }
      if(read.kind==='complete'&&scopeLinks.some(link=>link.league===null||link.gameId===null))
        read={kind:'incomplete',reason:scopeLinks.some(link=>link.evidence.kind==='unmatched'&&
          (link.evidence.reason==='unverified-kickoff'||link.evidence.reason==='unverified-contextual-kickoff'))?'unverified-date':'partial',checkedAt:read.checkedAt};
      const rows=[...candidates.values()].flatMap(rows=>rows.filter(candidate=>candidateEligible(candidate)&&
        candidate.sourceIds.includes(source.id)&&gameById.get(candidate.gameId)?.league===league));
      const feeds:FeedState=rows.length?feedCounts(rows,availability):
        read.kind==='complete'&&scopeLinks.length>0&&scopeLinks.every(link=>link.gameId!==null&&noPublishedFeed(link.evidence))?
          {kind:'no-feeds',checkedAt:read.checkedAt}:{kind:'incomplete',reason:scopeLinks.length?'details':'listings'};
      return {league,read,eventCount:scopeLinks.length,feeds};
    });
    return {
      id:source.id,name:source.name || source.id.replace(/-/g,' '),catalogUrl:source.url,
      leagues,scopes,
      publicUrls:[...new Set(source.publicUrls || [source.url])],pending:source.kind==='pending',
      collectionMode:'compatible-feed-discovery' as const,
      lastAttempt:input.attempts[source.id] || null,listingCount:links.length,matchedGameCount:matched.size,
      staleListingCount:links.filter(link=>link.freshness==='stale-live').length,compatibleFeedCount,
      freeChoiceCount,workingChoiceCount,
      collectionHealth:collectionHealth(source.id,input.collectionHistory||[],playerDropBySource.get(source.id)||null),
      unmatchedListingCount:links.length-links.filter(link=>link.gameId).length,
      unmatchedReasons:[...(reasonsBySource.get(source.id) || new Map()).entries()].map(([reason,count])=>({reason,count})),links,
    };
  });
  const gameRows=games.flatMap(game=>{
    if(!visibleGameIds.has(game.id))return [];
    const sourceLinks=linksByGame.get(game.id) || [];
    const selectable=(candidates.get(game.id) || []).filter(candidate=>candidateEligible(candidate))
      .sort(input.compareCandidates??compareCandidates).map(candidate=>candidateSummary(candidate,availability(candidate)));
    const sourceCount=new Set(sourceLinks.map(link=>link.sourceId)).size;
    const currentSources=new Set(sourceLinks.filter(link=>link.freshness==='fresh').map(link=>link.sourceId));
    const uniqueFeedCount=new Set((candidates.get(game.id) || []).filter(candidate=>candidateEligible(candidate) && candidate.sourceIds.some(sourceId=>currentSources.has(sourceId)) && availability(candidate).kind==='playable')
      .map(candidate=>candidate.id)).size;
    const freshCandidates=(candidates.get(game.id)||[]).filter(candidate=>candidateEligible(candidate));
    const direct=input.streameastCatalog.current?.catalog;
    const surge=input.sportsurgeCatalog.current?.catalog;
    const currentSurgeRoute=(candidate:Candidate,url:string):boolean=>{
      const locator=candidate.locator;
      if(!surge||locator.provider!=='sportsurge-v2'||locator.url!==url||
        !candidate.sourceIds.includes('sportsurge-v2'))return false;
      return surge.events.some(event=>{
        const detail=event.detail;
        return event.id===locator.eventId&&surge.categories[event.league].kind==='collected'&&
          detail.kind==='collected'&&at-detail.at<30*60_000&&
          sourceLinks.some(link=>link.sourceId==='sportsurge-v2'&&link.freshness==='fresh'&&link.url===event.url)&&
          detail.providers.some(provider=>provider.id===locator.providerId&&provider.observedAt===detail.at&&
            provider.destination.kind==='link'&&provider.destination.url===url);
      });
    };
    const sharedRoutes:SourcesSnapshot['games'][number]['sharedRoutes']=[];
    if(direct)for(const event of direct.events) {
      if(direct.categories[event.league].kind!=='collected'||event.detail.kind!=='collected'||
        at-event.detail.at>=30*60_000||!sourceLinks.some(link=>link.sourceId==='streameast'&&
          link.freshness==='fresh'&&link.url===event.url))continue;
      for(const server of event.detail.servers) {
        const directChoice=freshCandidates.find(candidate=>candidate.sourceIds.includes('streameast')&&
          (server.availability.kind==='free-channel'&&candidate.locator.provider==='streameast'&&
            candidate.locator.channelId===server.availability.channelId||
            server.availability.kind==='free-wikisport'&&candidate.locator.provider==='wikisport'&&
            candidate.locator.section===server.availability.section&&candidate.locator.playerId===server.availability.playerId||
            server.availability.kind==='free-page'&&candidate.locator.provider==='streameast-server'&&
            candidate.locator.sourceEventId===event.id&&candidate.locator.eventUrl===event.url&&
            candidate.locator.serverId===server.id));
        if(!directChoice)continue;
        for(const route of freshCandidates.filter(candidate=>currentSurgeRoute(candidate,server.url))) {
          sharedRoutes.push({id:`${game.id}:${directChoice.id}:${route.id}`,candidateIds:[directChoice.id,route.id],
            sourceIds:['streameast','sportsurge-v2'],evidence:'same-published-server'});
        }
      }
    }
    const relevant=sourceRows.flatMap(source=>source.scopes.filter(scope=>scope.league===game.league));
    const complete= relevant.length>0&&relevant.every(scope=>scope.read.kind==='complete');
    const feedState:FeedState=freshCandidates.length?feedCounts(freshCandidates,availability):
      input.freshGameIds&&!input.freshGameIds.has(game.id)?{kind:'incomplete',reason:'schedule'}:
      complete&&sourceLinks.every(link=>link.freshness==='fresh'&&noPublishedFeed(link.evidence))?
        {kind:'no-feeds',checkedAt:Math.max(...relevant.map(scope=>scope.read.checkedAt??0))}:
        {kind:'incomplete',reason:sourceLinks.length?'details':'listings'};
    return [{gameId:game.id,name:game.name,league:game.league,date:game.date??null,feeds:feedState,sourceCount,uniqueFeedCount,
      freeChoiceCount:new Set(freshCandidates.map(candidate=>candidate.id)).size,
      workingChoiceCount:new Set(freshCandidates.filter(candidate=>availability(candidate).kind==='playable')
        .map(candidate=>candidate.id)).size,sharedRoutes,candidates:selectable,sourceLinks}];
  });
  const scopedSportsurge=(stored:StoredSportsurgeCatalog|null)=>stored?{...stored,catalog:{...stored.catalog,
    events:stored.catalog.events.filter(event=>{
      const category=stored.catalog.categories[event.league];
      const observation=sportsurgeObservation(event,category.kind==='pending'?stored.catalog.startedAt:category.at);
      return visibleObservation(observation,match(observation,at));
    })}}:null;
  const scopedStreameast=(stored:StoredStreameastCatalog|null)=>stored?{...stored,catalog:{...stored.catalog,
    events:stored.catalog.events.filter(event=>{
      const category=stored.catalog.categories[event.league];
      const observation=streameastObservation(event,category.kind==='pending'?stored.catalog.startedAt:category.at);
      const raw=match(observation,at);
      return visibleObservation(observation,verifiedStreameastMatch(event,raw,gameById.get(raw.kind==='matched'?raw.gameId:'')));
    })}}:null;
  const sportsurgeView=(stored:StoredSportsurgeCatalog|null)=>{
    const scoped=scopedSportsurge(stored);
    return scoped?sportsurgeCatalogView(scoped,games,at,input.sourceEventBindings):null;
  };
  const streameastView=(stored:StoredStreameastCatalog|null)=>{
    const scoped=scopedStreameast(stored);
    return scoped?streameastCatalogView(scoped,games,at):null;
  };
  return {at,revision:input.revision,windowStartAt,window:feedWindow(at),scheduleScopes:input.scheduleScopes??[],lastDiscoveryAt:input.lastDiscoveryAt,browserCollectorsAvailable:input.browserCollectorsAvailable,
    sportsurgeV2:{
      current:sportsurgeView(input.sportsurgeCatalog.current),
      lastComplete:sportsurgeView(input.sportsurgeCatalog.lastComplete),
      previous:sportsurgeView(input.sportsurgeCatalog.previous),
    },
    streameast:{
      current:streameastView(input.streameastCatalog.current),
      lastComplete:streameastView(input.streameastCatalog.lastComplete),
      previous:streameastView(input.streameastCatalog.previous),
    },sources:sourceRows,games:gameRows};
}
