import { createObservationMatcher } from './matching.ts';
import type { Candidate,Game,Match,Observation,SourceMatchReason,StreameastCatalog,StreameastCatalogView,StoredStreameastCatalog } from '../shared.ts';

const EVENT_PATH=/^\/(cfb|nfl)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/;

export function sanitizeStreameastCatalog(catalog:StreameastCatalog,now=Date.now()):StreameastCatalog|null {
  if(catalog.startedAt>now+60_000||catalog.startedAt<now-24*3600_000)return null;
  const current=(at:number)=>at>=catalog.startedAt&&at<=now+60_000;
  if(catalog.state.kind!=='collecting'&&!current(catalog.state.at))return null;
  if(Object.values(catalog.categories).some(category=>category.kind!=='pending'&&!current(category.at)))return null;
  let latest=catalog.startedAt;
  for(const category of Object.values(catalog.categories))if(category.kind!=='pending')latest=Math.max(latest,category.at);
  const urls=new Set<string>();
  const ids=new Set<string>();
  for(const event of catalog.events) {
    let url:URL;
    try {url=new URL(event.url);} catch{return null;}
    const match=EVENT_PATH.exec(url.pathname);
    if(url.origin!=='https://v2.streameast.ga'||url.username||url.password||url.search||url.hash||!match||
      match[1] !== (event.league==='ncaaf'?'cfb':'nfl')||urls.has(url.href)||ids.has(event.id))return null;
    urls.add(url.href);ids.add(event.id);
    if(event.detail.kind==='pending')continue;
    const category=catalog.categories[event.league];
    if(category.kind!=='collected'||!current(event.detail.at)||event.detail.at<category.at)return null;
    latest=Math.max(latest,event.detail.at);
    if(event.detail.kind==='failed')continue;
    const serverIds=new Set<string>();
    for(const server of event.detail.servers) {
      let serverUrl:URL;
      try {serverUrl=new URL(server.url);}catch{return null;}
      if(serverUrl.origin!==url.origin||serverUrl.username||serverUrl.password||serverUrl.search||serverUrl.hash||
        serverUrl.pathname!==`${url.pathname}${server.id}`||serverIds.has(server.id))return null;
      serverIds.add(server.id);
    }
  }
  if(catalog.state.kind!=='collecting'&&catalog.state.at<latest)return null;
  if(catalog.state.kind==='complete'&&(Object.values(catalog.categories).some(category=>category.kind!=='collected')||
    catalog.events.some(event=>event.detail.kind!=='collected')||catalog.rejectedGames.length>0))return null;
  return catalog;
}

export function streameastDecision(previous:StoredStreameastCatalog|null,incoming:StreameastCatalog):'accepted'|'replay'|'rejected' {
  if(!previous)return incoming.sequence===0?'accepted':'rejected';
  const current=previous.catalog;
  if(current.runId!==incoming.runId)return incoming.sequence===0&&incoming.startedAt>current.startedAt?'accepted':'rejected';
  if(incoming.startedAt!==current.startedAt)return 'rejected';
  if(incoming.sequence===current.sequence)return JSON.stringify(incoming)===JSON.stringify(current)?'replay':'rejected';
  if(incoming.sequence<current.sequence||current.state.kind!=='collecting')return 'rejected';
  return 'accepted';
}

export function streameastObservation(event:StreameastCatalog['events'][number],at:number):Observation {
  return {id:`streameast:${event.url}`,sourceId:'streameast',url:event.url,title:event.title,league:event.league,
    teams:event.teams,kickoff:event.kickoff,rawTime:event.kickoff===null?'':new Date(event.kickoff).toISOString(),observedAt:at,parserVersion:1};
}

export function verifiedStreameastMatch(event:StreameastCatalog['events'][number],result:Match,game:Game|undefined):Match {
  if(result.kind!=='matched'||!game)return result;
  if(event.espnEventId!==null&&game.id!==(event.league==='ncaaf'?`ncaaf-${event.espnEventId}`:event.espnEventId))
    return {kind:'unmatched',reason:'conflicting-date',possibleGameIds:[game.id]};
  return result;
}

export function streameastCandidates(event:StreameastCatalog['events'][number],gameId:string):Candidate[] {
  const detail=event.detail;
  if(detail.kind!=='collected')return [];
  const seen=new Set<string>();
  return detail.servers.flatMap(server=>{
    if(server.availability.kind!=='free-channel'||seen.has(server.availability.channelId))return [];
    const channelId=server.availability.channelId;
    seen.add(channelId);
    return [{id:`streameast:${channelId}`,gameId,label:`StreamEast · ${server.label}`,sourceIds:['streameast'],
      observedAt:detail.at,locator:{provider:'streameast' as const,channelId}}];
  });
}

function publicReason(value:string):SourceMatchReason {
  switch(value) {
    case 'not-a-matchup':case 'unknown-teams':case 'unverified-kickoff':case 'ambiguous-matchup':
    case 'conflicting-date':case 'finished-game':return value;
    default:return 'other';
  }
}

export function streameastCatalogView(stored:StoredStreameastCatalog,games:Game[],now:number):StreameastCatalogView {
  const {catalog,receivedAt}=stored;
  const match=createObservationMatcher(games);
  const views=catalog.events.map(event=>{
    const category=catalog.categories[event.league];
    const observedAt=category.kind==='pending'?catalog.startedAt:category.at;
    const observation=streameastObservation(event,observedAt);
    const raw=match(observation,now);
    const result=verifiedStreameastMatch(event,raw,games.find(game=>game.id===(raw.kind==='matched'?raw.gameId:'')));
    return {id:event.id,title:event.title,url:event.url,league:event.league,
      gameId:result.kind==='matched'?result.gameId:null,
      matchReason:result.kind==='unmatched'?publicReason(result.reason):null,detail:event.detail};
  });
  const details=catalog.events.map(event=>event.detail);
  const rows=details.flatMap(detail=>detail.kind==='collected'?detail.servers:[]);
  const compatible=new Set(views.flatMap((view,index)=>view.gameId&&catalog.events[index].detail.kind==='collected'?
    streameastCandidates(catalog.events[index],view.gameId).map(candidate=>`${view.gameId}:${candidate.id}`):[]));
  return {runId:catalog.runId,startedAt:catalog.startedAt,receivedAt,interrupted:catalog.state.kind==='collecting'&&now-receivedAt>180000,
    state:catalog.state,categories:catalog.categories,gameCount:catalog.events.length,
    collectedDetails:details.filter(detail=>detail.kind==='collected').length,
    pendingDetails:details.filter(detail=>detail.kind==='pending').length,
    failedDetails:details.filter(detail=>detail.kind==='failed').length,
    serverRows:rows.length,freeRows:rows.filter(row=>row.availability.kind.startsWith('free-')).length,
    premiumRows:rows.filter(row=>row.availability.kind==='premium').length,
    unknownRows:rows.filter(row=>row.availability.kind==='unknown'||row.availability.kind==='free-unresolved').length,
    unsupportedFreeRows:rows.filter(row=>row.availability.kind==='free-unsupported').length,
    matchedCompatibleChannels:compatible.size,rejectedGames:catalog.rejectedGames,games:views};
}
