import {z} from 'zod';
import {SourcesSnapshotSchema,RoomSourcesSnapshotSchema,type Candidate,type CandidateAvailability,type CollectionAttempt,type DetailEvidence,type Game,type Observation,type SourceAttempt,type SourceEventBinding,type SourcesSnapshot,type RoomSourcesSnapshot,type StoredSportsurgeCatalog,type StoredStreameastCatalog} from '../shared.ts';
import type {ListingSource} from './ports.ts';
import {nativeView} from './native-view.ts';
import {browserObservation} from './browser-polling.ts';

type Input={
  at:number;revision:number;lastDiscoveryAt:number|null;browserCollectorsAvailable:boolean;sources:readonly ListingSource[];
  observations:Observation[];games:Game[];candidates:ReadonlyMap<string,Candidate[]>;
  visibleGameIds?:ReadonlySet<string>;freshGameIds?:ReadonlySet<string>;details?:DetailEvidence[];collectionHistory?:CollectionAttempt[];
  sourceEventBindings?:readonly SourceEventBinding[];
  availability?:(candidate:Candidate)=>CandidateAvailability;candidateIdentity?:(candidate:Candidate)=>string;
  candidateEligible?:(candidate:Candidate)=>boolean;compareCandidates?:(left:Candidate,right:Candidate)=>number;
  attempts:Record<string,SourceAttempt>;scheduleScopes?:SourcesSnapshot['scheduleScopes'];
  observationDeadline?:(observation:Observation)=>number|undefined;
  sportsurgeCatalog:{current:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null};
  streameastCatalog:{current:StoredStreameastCatalog|null;lastComplete:StoredStreameastCatalog|null;previous:StoredStreameastCatalog|null};
};

function transport(input:Input,view:'full'|'room') {
  const groups=[...input.candidates];
  const sourceConfig=input.sources.map(source=>({
    id:source.id,url:source.url,family:source.family,kind:source.kind,
    publicUrls:source.publicUrls,leagues:source.leagues,
    ...(view==='full'?{name:source.name,publicCategories:source.publicCategories,parserVersion:source.parserVersion}:{}),
  }));
  const base={
    at:input.at,revision:input.revision,lastDiscoveryAt:input.lastDiscoveryAt,
    browserCollectorsAvailable:input.browserCollectorsAvailable??false,
    sources:sourceConfig,observations:input.observations,games:input.games,candidates:groups,
    attempts:input.attempts,details:input.details,sourceEventBindings:input.sourceEventBindings,
    collectionHistory:view==='full'?input.collectionHistory:undefined,
    scheduleScopes:view==='full'?input.scheduleScopes:undefined,
    visibleGameIds:input.visibleGameIds?[...input.visibleGameIds]:undefined,
    freshGameIds:input.freshGameIds?[...input.freshGameIds]:undefined,
    sportsurgeCatalog:input.sportsurgeCatalog,streameastCatalog:input.streameastCatalog,
  };
  const indexesSchema=z.array(z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative()]));
  const requested=(operation:string,value:unknown)=>nativeView(operation,value,indexesSchema).map(([group,index])=>{
    const candidate=groups[group]?.[1][index];
    if(!candidate)throw new Error('Native candidate reference is invalid.');
    return candidate;
  });
  const key=(candidate:Candidate)=>JSON.stringify([candidate.gameId,candidate.id]);
  const candidateEligible=input.candidateEligible;
  const withEligibility={...base,eligibility:candidateEligible?
    Object.fromEntries(requested('inventoryCandidateIndexes',base).map(candidate=>[key(candidate),candidateEligible(candidate)])):undefined};
  const availability=input.availability;
  const identity=view==='full'?input.candidateIdentity:undefined;
  const compare=input.compareCandidates;
  const candidates=availability||identity||compare?requested('inventoryEligibleCandidateIndexes',withEligibility):[];
  const ordered=compare?[...candidates].sort(compare):candidates;
  const catalogObservations=input.observationDeadline?
    [...Object.values(input.sportsurgeCatalog),...Object.values(input.streameastCatalog)].flatMap(stored=>stored?stored.catalog.events.map(event=>{
      const category=stored.catalog.categories[event.league];
      return browserObservation(event,category?.kind==='pending'?stored.catalog.startedAt:category?.at??stored.catalog.startedAt);
    }):[]):[];
  return {...withEligibility,
    availability:availability?Object.fromEntries(ordered.map(candidate=>[key(candidate),availability(candidate)])):undefined,
    identities:identity?Object.fromEntries(candidates.map(candidate=>[key(candidate),identity(candidate)])):undefined,
    rankIds:compare?ordered.map(key):undefined,
    observationDeadlines:input.observationDeadline?Object.fromEntries([...input.observations,...catalogObservations].flatMap(observation=>{
      const deadline=input.observationDeadline?.(observation);return deadline===undefined?[]:[[observation.id,deadline]];
    })):undefined,
  };
}
export function sourceInventory(input:Input):SourcesSnapshot {
  return nativeView('sourceInventory',transport(input,'full'),SourcesSnapshotSchema);
}
export function roomSourceInventory(input:Input):RoomSourcesSnapshot {
  return nativeView('roomSourceInventory',transport(input,'room'),RoomSourcesSnapshotSchema);
}
export function roomSources(snapshot:SourcesSnapshot):RoomSourcesSnapshot {
  return nativeView('roomSources',snapshot,RoomSourcesSnapshotSchema);
}