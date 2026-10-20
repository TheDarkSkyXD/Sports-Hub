import {z} from 'zod';
import {nativeDomain} from './native.ts';
import {ObservationSchema,ResolvedPlayerSchema,type DetailEvidence,type Game,type Observation,type SportsurgeCatalog,type StreameastCatalog} from '../shared.ts';

export type BrowserCatalog=SportsurgeCatalog|StreameastCatalog;
export type BrowserEvent=BrowserCatalog['events'][number];
const PublicationSchema=z.object({players:z.array(ResolvedPlayerSchema),at:z.number(),until:z.number()}).nullable();

export function browserPublicationIdentity(event:BrowserEvent):string {
  return nativeDomain('browserPublicationIdentity',[event],z.string());
}
export function retainedBrowserPublication(event:BrowserEvent,observedAt:number,detail:DetailEvidence|undefined,game:Game,now:number) {
  return nativeDomain('retainedBrowserPublication',[event,observedAt,detail,game,now],PublicationSchema);
}
export function browserObservation(event:BrowserEvent,at:number):Observation {
  return nativeDomain('browserObservation',[event,at],ObservationSchema);
}
export function browserCategoryDeadline(catalog:BrowserCatalog,league:Game['league'],games:readonly Game[],now:number):number {
  return nativeDomain('browserCategoryDeadline',[catalog,league,games,now],z.number());
}
export function browserEventDeadline(detail:DetailEvidence|undefined,game:Game|undefined,now:number):number {
  return nativeDomain('browserEventDeadline',[detail,game,now],z.number());
}
export function browserPollingSignature(event:BrowserEvent,observation:Observation,game:Game|undefined):string|null {
  return nativeDomain('browserPollingSignature',[event,observation,game],z.string().nullable());
}
export function browserEvidenceFresh(detail:DetailEvidence|undefined,checkedAt:number,now:number):boolean {
  return nativeDomain('browserEvidenceFresh',[detail,checkedAt,now],z.boolean());
}
