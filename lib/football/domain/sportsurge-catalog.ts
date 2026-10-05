import { confirmedFinishedBoundEvent, confirmedFinishedGameId, createObservationMatcher, matchSourceLiveGame } from './matching.ts';
import { createHash } from 'node:crypto';
import type { Candidate, Game, Match, Observation, SourceEventBinding, SourceMatchReason, SportsurgeCatalog, SportsurgeCatalogView, SportsurgeProvider, StoredSportsurgeCatalog } from '../shared.ts';

const DETAIL_PATH=/^\/watch-(\d{1,12})-(cfb|nfl)-[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const CREDENTIAL_KEY=/^(?:token|access_token|auth|authorization|key|signature|sig|st|e|x-amz-.+)$/i;

function safeDestination(value:string):SportsurgeProvider['destination'] {
  const url=new URL(value);
  const display=url.hostname.slice(0,240) || null;
  if (url.protocol!=='https:') return {kind:'rejected',reason:'insecure',display};
  if (url.username || url.password || url.port) return {kind:'rejected',reason:'credentials',display};
  if (!url.hostname || url.hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ||
    url.hostname==='localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal'))
    return {kind:'rejected',reason:'private-host',display};
  if ([...url.searchParams.keys()].some(key=>CREDENTIAL_KEY.test(key)) || /(?:^#|[&?])(?:token|access_token|auth|authorization|key|signature|sig|st|e|x-amz-[^=]+)=/i.test(url.hash))
    return {kind:'rejected',reason:'credential-query',display};
  if (url.href.length>2000) return {kind:'rejected',reason:'oversized',display};
  return {kind:'link',url:url.href};
}

export function sameSportsurgeEvent(left:SportsurgeCatalog['events'][number],right:SportsurgeCatalog['events'][number]):boolean {
  return left.id===right.id&&left.url===right.url&&left.league===right.league&&left.title===right.title&&
    left.kickoff===right.kickoff&&JSON.stringify(left.teams)===JSON.stringify(right.teams)&&left.sourceStatus===right.sourceStatus&&left.advertisedLinkCount===right.advertisedLinkCount;
}

export function sanitizeSportsurgeCatalog(catalog:SportsurgeCatalog,history:readonly StoredSportsurgeCatalog[]=[]):SportsurgeCatalog|null {
  const urls=new Set<string>();
  for (const event of catalog.events) {
    let url:URL;
    try { url=new URL(event.url); } catch { return null; }
    const match=DETAIL_PATH.exec(url.pathname);
    if (url.origin!=='https://v2.sportsurge.net' || url.username || url.password || url.search || url.hash || !match ||
      event.id!==`${event.league}:${match[1]}` || match[2] !== (event.league==='ncaaf'?'cfb':'nfl') || urls.has(event.url)) return null;
    urls.add(event.url);
    const detail=event.detail;
    const retained=detail.kind==='collected'&&detail.retainedFromRunId!==undefined;
    if(retained&&!history.some(stored=>stored.catalog.events.some(prior=>sameSportsurgeEvent(event,prior)&&
      prior.detail.kind==='collected'&&detail.retainedFromRunId===(prior.detail.retainedFromRunId||stored.catalog.runId)&&
      JSON.stringify([detail.at,detail.providers])===JSON.stringify([prior.detail.at,prior.detail.providers]))))return null;
    if (event.detail.kind!=='collected') continue;
    const rowIds=new Set<string>();
    for (const provider of event.detail.providers) {
      if (rowIds.has(provider.id)) return null;
      rowIds.add(provider.id);
      if (provider.destination.kind==='link') provider.destination=safeDestination(provider.destination.url);
    }
  }
  if (catalog.state.kind==='complete' && (Object.values(catalog.categories).some(category=>category.kind!=='collected') ||
    catalog.events.some(event=>event.detail.kind!=='collected') || catalog.rejectedGames.length>0)) return null;
  return catalog;
}

export function catalogDecision(previous:StoredSportsurgeCatalog|null,incoming:SportsurgeCatalog):'accepted'|'replay'|'rejected' {
  if (!previous) return incoming.sequence===0 ? 'accepted' : 'rejected';
  const current=previous.catalog;
  if (current.runId!==incoming.runId) return incoming.sequence===0 && incoming.startedAt>current.startedAt ? 'accepted' : 'rejected';
  if (incoming.startedAt!==current.startedAt) return 'rejected';
  if (incoming.sequence===current.sequence) return JSON.stringify(incoming)===JSON.stringify(current) ? 'replay' : 'rejected';
  if (incoming.sequence<current.sequence || current.state.kind!=='collecting') return 'rejected';
  return 'accepted';
}

export function sportsurgeObservation(event:SportsurgeCatalog['events'][number],at:number):Observation {
  return {id:`sportsurge-v2:${event.url}`,sourceId:'sportsurge-v2',url:event.url,title:event.title,league:event.league,
    teams:event.teams,kickoff:event.kickoff,rawTime:event.kickoff===null?'':new Date(event.kickoff).toISOString(),observedAt:at,parserVersion:1};
}

function matchedGame(event:SportsurgeCatalog['events'][number],at:number,games:Game[],now:number,
  match:ReturnType<typeof createObservationMatcher>):Game|undefined {
  const raw:Match=match(sportsurgeObservation(event,at),now);
  const result=event.sourceStatus==='live'&&event.kickoff===null?matchSourceLiveGame(raw,games,now):raw;
  const id=result.kind==='matched'?result.gameId:null;
  const game=games.find(item=>item.id===id);
  if (!game || game.lifecycle!=='live' && game.lifecycle!=='scheduled') return undefined;
  return game;
}

function rowIdentity(eventUrl:string,providerId:string,destinationUrl:string):string {
  return createHash('sha256').update(eventUrl).update('\0').update(providerId).update('\0').update(destinationUrl).digest('hex').slice(0,24);
}

export function sportsurgeCandidates(input:{
  current:StoredSportsurgeCatalog|null;
  previous:StoredSportsurgeCatalog|null;
  lastComplete:StoredSportsurgeCatalog|null;
  games:Game[];
  now:number;
}):Candidate[] {
  const {current,previous,lastComplete,games,now}=input;
  const older=current?.catalog.state.kind==='complete'?[]:[previous,lastComplete];
  const catalogs=[current,...older].filter((stored):stored is StoredSportsurgeCatalog=>stored!==null);
  const match=createObservationMatcher(games,'inventory-live');
  const replaced=new Set<string>();
  const candidates=new Map<string,Candidate>();
  for(const stored of catalogs) for(const event of stored.catalog.events) {
    if(replaced.has(event.url))continue;
    const category=stored.catalog.categories[event.league];
    if(category.kind!=='collected'||event.detail.kind!=='collected')continue;
    const detail=event.detail;
    if(!detail.retainedFromRunId&&detail.at<category.at||detail.at>now+60_000||now-detail.at>=30*60_000)continue;
    replaced.add(event.url);
    const game=matchedGame(event,category.at,games,now,match);
    if(!game)continue;
    for(const provider of detail.providers) {
      if(provider.destination.kind!=='link'||provider.observedAt!==detail.at)continue;
      const id=`sportsurge-v2:${rowIdentity(event.url,provider.id,provider.destination.url)}`;
      candidates.set(id,{id,gameId:game.id,label:`Sportsurge v2 · ${provider.label}`,
        sourceIds:['sportsurge-v2'],observedAt:detail.at,
        locator:{provider:'sportsurge-v2',eventId:event.id,providerId:provider.id,url:provider.destination.url}});
    }
  }
  return [...candidates.values()];
}

function publicReason(value:string):SourceMatchReason {
  switch(value) {
    case 'not-a-matchup': case 'unknown-teams': case 'unverified-kickoff': case 'ambiguous-matchup':
    case 'conflicting-date': case 'finished-game': return value;
    default: return 'other';
  }
}

export function sportsurgeCatalogView(stored:StoredSportsurgeCatalog,games:Game[],now:number,bindings:readonly SourceEventBinding[]=[]):SportsurgeCatalogView {
  const {catalog,receivedAt}=stored;
  const match=createObservationMatcher(games);
  const matchInventory=createObservationMatcher(games,'inventory-live');
  const activeEvents=catalog.events.filter(event=>{
    const category=catalog.categories[event.league];
    const observedAt=category.kind==='pending'?catalog.startedAt:category.at;
    const observation=sportsurgeObservation(event,observedAt);
    return !confirmedFinishedGameId(observation,games,now)&&
      !confirmedFinishedBoundEvent(observation,event.id,bindings,games);
  });
  const views=activeEvents.map(event=>{
    const category=catalog.categories[event.league];
    const observedAt=category.kind==='pending' ? catalog.startedAt : category.at;
    const result=match(sportsurgeObservation(event,observedAt),now);
    const game=matchedGame(event,observedAt,games,now,matchInventory);
    const detail=event.detail.kind==='collected'?{...event.detail,providers:event.detail.providers.map(provider=>({
      ...provider,destination:provider.destination.kind==='link'?{kind:'link' as const}:provider.destination,
    }))}:event.detail;
    return {id:event.id,title:event.title,url:event.url,league:event.league,
      gameId:game?.id || null,
      matchReason:game?null:result.kind==='unmatched' ? publicReason(result.reason) : null,
      sourceStatus:event.sourceStatus,detail};
  });
  const details=activeEvents.map(event=>event.detail);
  return {runId:catalog.runId,startedAt:catalog.startedAt,receivedAt,interrupted:catalog.state.kind==='collecting' && now-receivedAt>180000,
    state:catalog.state,categories:catalog.categories,
    gameCount:activeEvents.length,collectedDetails:details.filter(detail=>detail.kind==='collected').length,
    pendingDetails:details.filter(detail=>detail.kind==='pending').length,
    failedDetails:details.filter(detail=>detail.kind==='failed').length,
    providerRows:details.reduce((count,detail)=>count+(detail.kind==='collected'?detail.providers.length:0),0),
    rejectedProviders:details.reduce((count,detail)=>count+(detail.kind==='collected'?detail.providers.filter(provider=>provider.destination.kind!=='link').length:0),0),
    rejectedGames:catalog.rejectedGames,catalogIssues:catalog.catalogIssues,games:views};
}
