import type {DetailEvidence,Game,Observation,SportsurgeCatalog,StreameastCatalog} from '../shared.ts';
import {sportsurgeObservation} from './sportsurge-catalog.ts';
import {streameastObservation} from './streameast-catalog.ts';
import {ACTIVE_DISCOVERY_MS,COLLECTION_SETTLE_MS,SOURCE_REFRESH_MS,detailDeadline,detailIdentity,discoveryDeadline} from './source-policy.ts';

export type BrowserCatalog=SportsurgeCatalog|StreameastCatalog;
export type BrowserEvent=BrowserCatalog['events'][number];
export function browserPublicationIdentity(event:BrowserEvent):string {
  return JSON.stringify(['sourceStatus' in event?'sportsurge-v2':'streameast',event.id,event.url,event.league,event.title,
    event.teams,event.kickoff,'sourceStatus' in event?[event.sourceStatus,event.advertisedLinkCount]:event.espnEventId]);
}
export function retainedBrowserPublication(event:BrowserEvent,observedAt:number,detail:DetailEvidence|undefined,game:Game,now:number) {
  const success=detail?.lastSuccess;
  const publication=success?.publication;
  if(!success||!publication||success.identity!==browserPublicationIdentity(event)||
    publication.event.gameId!==game.id||publication.event.date!==(game.date??null)||
    success.at>now+60_000||observedAt>now+60_000||
    event.detail.kind==='collected'&&event.detail.at>success.at)return null;
  const until=Math.min(success.at+ACTIVE_DISCOVERY_MS+30*60_000,observedAt+ACTIVE_DISCOVERY_MS+COLLECTION_SETTLE_MS);
  return now<=until?{players:publication.players,at:success.at,until}:null;
}
export function browserObservation(event:BrowserEvent,at:number):Observation {
  return 'sourceStatus' in event?sportsurgeObservation(event,at):streameastObservation(event,at);
}
export function browserCategoryDeadline(catalog:BrowserCatalog,league:Game['league'],games:readonly Game[],now:number):number {
  const category=catalog.categories[league];
  if(!category||category.kind==='pending')return now;
  if(category.kind==='failed')return category.at+SOURCE_REFRESH_MS;
  if(catalog.rejectedGames.some(event=>event.league===league)||'catalogIssues' in catalog&&catalog.catalogIssues.some(issue=>issue.league===league))return category.at+SOURCE_REFRESH_MS;
  return discoveryDeadline(category.at,catalog.events.filter(event=>event.league===league).map(event=>browserObservation(event,category.at)),games,[league],now);
}
export function browserEventDeadline(detail:DetailEvidence|undefined,game:Game|undefined,now:number):number {
  if(!detail)return now;
  return detail.polling?detailDeadline({at:detail.at,polling:detail.polling,game,now,
    published:detail.outcome==='resolved'&&!!detail.lastSuccess?.publication?.players.length}):detail.nextEligibleAt;
}
export function browserPollingSignature(event:BrowserEvent,observation:Observation,game:Game|undefined):string|null {
  if(event.detail.kind!=='collected')return null;
  const published='providers' in event.detail?event.detail.providers.map(row=>JSON.stringify([row.id,row.destination.kind==='link'?row.destination.url:row.destination.kind])):
    event.detail.servers.map(row=>JSON.stringify([row.id,row.url,row.availability]));
  return JSON.stringify([detailIdentity(observation),game?.id,game?.date,published.sort()]);
}
export function browserEvidenceFresh(detail:DetailEvidence|undefined,checkedAt:number,now:number):boolean {
  if(detail&&(detail.at>checkedAt||detail.at===checkedAt&&detail.outcome!=='resolved'))return false;
  return checkedAt<=now+60_000&&now<=Math.max(checkedAt+ACTIVE_DISCOVERY_MS,detail?.at===checkedAt?detail.nextEligibleAt:0)+COLLECTION_SETTLE_MS;
}
