import {z} from 'zod';
import {CandidateSchema,ObservationSchema,StreameastCatalogSchema,StreameastCatalogViewSchema,type Candidate,type Game,type Observation,type StreameastCatalog,type StreameastCatalogView,type StoredStreameastCatalog} from '../shared.ts';
import type {SourceEventEvidence} from './matching.ts';
import {nativeView} from './native-view.ts';

const EvidenceSchema=z.object({undated:z.enum(['none','published-listing','live-claim','retained-live-detail']),externalGameId:z.string().nullable()});
export function sameStreameastEvent(left:StreameastCatalog['events'][number],right:StreameastCatalog['events'][number]):boolean {
  return nativeView('sameStreameastEvent',[left,right],z.boolean());
}
export function sanitizeStreameastCatalog(input:StreameastCatalog,now=Date.now(),history:readonly StoredStreameastCatalog[]=[],finished?:(event:StreameastCatalog['events'][number])=>boolean):StreameastCatalog|null {
  const finishedIds=[...input.events,...history.flatMap(stored=>stored.catalog.events)].filter(event=>finished?.(event)).map(event=>event.id);
  return nativeView('sanitizeStreameastCatalog',[input,now,history,finishedIds],StreameastCatalogSchema.nullable());
}
export function streameastDecision(previous:StoredStreameastCatalog|null,incoming:StreameastCatalog):'accepted'|'replay'|'rejected' {
  return nativeView('streameastDecision',[previous,incoming],z.enum(['accepted','replay','rejected']));
}
export function streameastObservation(event:StreameastCatalog['events'][number],at:number):Observation {
  return nativeView('streameastObservation',[event,at],ObservationSchema);
}
export function streameastEvidence(event:StreameastCatalog['events'][number]):SourceEventEvidence {
  return nativeView('streameastEvidence',[event],EvidenceSchema);
}
export function streameastCandidates(event:StreameastCatalog['events'][number],gameId:string):Candidate[] {
  return nativeView('streameastCandidates',[event,gameId],z.array(CandidateSchema));
}
export function streameastCatalogView(stored:StoredStreameastCatalog,games:Game[],now:number):StreameastCatalogView {
  return nativeView('streameastCatalogView',[stored,games,now],StreameastCatalogViewSchema);
}
