import {z} from 'zod';
import {CandidateSchema,ObservationSchema,SportsurgeCatalogSchema,SportsurgeCatalogViewSchema,type Candidate,type Game,type Observation,type SourceEventBinding,type SportsurgeCatalog,type SportsurgeCatalogView,type StoredSportsurgeCatalog} from '../shared.ts';
import type {SourceEventEvidence} from './matching.ts';
import {nativeView} from './native-view.ts';

const EvidenceSchema=z.object({undated:z.enum(['none','published-listing','live-claim','retained-live-detail']),externalGameId:z.string().nullable()});
export function sameSportsurgeEvent(left:SportsurgeCatalog['events'][number],right:SportsurgeCatalog['events'][number]):boolean {
  return nativeView('sameSportsurgeEvent',[left,right],z.boolean());
}
export function sanitizeSportsurgeCatalog(catalog:SportsurgeCatalog,history:readonly StoredSportsurgeCatalog[]=[]):SportsurgeCatalog|null {
  return nativeView('sanitizeSportsurgeCatalog',[catalog,history],SportsurgeCatalogSchema.nullable());
}
export function catalogDecision(previous:StoredSportsurgeCatalog|null,incoming:SportsurgeCatalog):'accepted'|'replay'|'rejected' {
  return nativeView('catalogDecision',[previous,incoming],z.enum(['accepted','replay','rejected']));
}
export function sportsurgeObservation(event:SportsurgeCatalog['events'][number],at:number):Observation {
  return nativeView('sportsurgeObservation',[event,at],ObservationSchema);
}
export function sportsurgeEvidence(event:SportsurgeCatalog['events'][number],now:number):SourceEventEvidence {
  return nativeView('sportsurgeEvidence',[event,now],EvidenceSchema);
}
export function sportsurgeEventCandidate(candidate:Candidate,event:SportsurgeCatalog['events'][number]):boolean {
  return nativeView('sportsurgeEventCandidate',[candidate,event],z.boolean());
}
export function sportsurgeCandidates(input:{
  current:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;games:Game[];now:number;
  freshness?:(observation:Observation)=>number|undefined;detailFresh?:(id:string,at:number)=>boolean;
}):Candidate[] {
  const observations=[input.current,input.previous,input.lastComplete].flatMap(stored=>stored?stored.catalog.events.map(event=>{
    const category=stored.catalog.categories[event.league];return {event,observation:sportsurgeObservation(event,category.kind==='pending'?stored.catalog.startedAt:category.at)};
  }):[]);
  return nativeView('sportsurgeCandidates',[{...input,
    deadlines:input.freshness?Object.fromEntries(observations.flatMap(({observation})=>{const at=input.freshness?.(observation);return at===undefined?[]:[[observation.id,at]];})):undefined,
    detailFresh:input.detailFresh?Object.fromEntries(observations.filter(({event})=>event.detail.kind==='collected').map(({event,observation})=>[observation.id,event.detail.kind==='collected'&&input.detailFresh?.(observation.id,event.detail.at)])):undefined,
  }],z.array(CandidateSchema));
}
export function sportsurgeEventCandidates(event:SportsurgeCatalog['events'][number],gameId:string):Candidate[] {
  return nativeView('sportsurgeEventCandidates',[event,gameId],z.array(CandidateSchema));
}
export function sportsurgeCatalogView(stored:StoredSportsurgeCatalog,games:Game[],now:number,bindings:readonly SourceEventBinding[]=[],freshness?:(observation:Observation)=>number|undefined):SportsurgeCatalogView {
  const deadlines=Object.fromEntries(stored.catalog.events.flatMap(event=>{
    const category=stored.catalog.categories[event.league],observation=sportsurgeObservation(event,category.kind==='pending'?stored.catalog.startedAt:category.at);
    const at=freshness?.(observation);return at===undefined?[]:[[observation.id,at]];
  }));
  return nativeView('sportsurgeCatalogView',[stored,games,now,bindings,deadlines],SportsurgeCatalogViewSchema);
}
