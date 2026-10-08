import type { CandidateLocator, CollectionAttempt, DetailEvidence, Game, League, Match, MissingPlayerReason, Observation, ResolvedPlayer, SeasonMembership, SourceAttempt, SourceEventBinding, StoredSportsurgeCatalog, StoredStreameastCatalog } from '../shared.ts';
import type { WorkingFeed } from './working-feed.ts';

export type CandidateProbeResult =
  | {kind:'playable';proof:'media'|'decoded'}
  | {kind:'unavailable';reason:'upstream'|'unsupported'|'invalid-media'|'timeout'}
  | {kind:'deferred';retryAfterMs:number};

export type ScheduleSource = { id: string; league: League; sport?: 'football' | 'basketball' | 'hockey'; path: string; group: string | null };
export type ListingSource = { id: string; url: string; family: string; kind?: 'catalog' | 'pending' | 'browser-catalog'; name?: string; publicUrls?: readonly string[]; parserVersion?: number };
export type SchedulePartition = { games: Game[]; at: number; week?: number };
export type ScheduleResult = SchedulePartition & { league: League; horizonErrors?: string[] };
export type ListingResult = { observations: Observation[]; outcome: 'parsed' | 'empty' | 'unsupported' | 'parser-changed' };

export class PartialListingReadError extends Error {
  readonly html:string;
  readonly retryAfterMs:number;
  constructor(html:string,failure:Error,retryAfterMs:number) {
    super(failure.message,{cause:failure});
    this.name='PartialListingReadError';
    this.html=html;
    this.retryAfterMs=retryAfterMs;
  }
}

export interface FootballRepository {
  finishedGameRetentionMinutes(): number;
  setFinishedGameRetentionMinutes(minutes:number):void;
  feedCheckIntervalMinutes():number;
  setFeedCheckIntervalMinutes(minutes:number):void;
  workingFeeds(): WorkingFeed[];
  replaceWorkingIdentity(gameId:string,identityHash:string,feeds:readonly WorkingFeed[]):void;
  removeWorkingGames(gameIds:readonly string[]):void;
  partition(id: string): SchedulePartition | undefined;
  savePartition(id: string, value: SchedulePartition): void;
  finals(): Game[];
  observe(observation: Observation, result: Match): void;
  observations(): Observation[];
  sourceEventBindings():SourceEventBinding[];
  removeFinalEvidence(gameIds:readonly string[],now:number):void;
  sourceAttempts(): Record<string,SourceAttempt>;
  collectionHistory(now:number): CollectionAttempt[];
  saveListingAttempt(id:string, attempt:SourceAttempt, observations:{observation:Observation;result:Match}[],bindings?:SourceEventBinding[]):void;
  detailEvidence(): DetailEvidence[];
  saveDetailEvidence(value:DetailEvidence, observation?:{observation:Observation;result:Match}):void;
  sportsurgeCatalog(): {current:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null};
  saveSportsurgeCatalog(value:StoredSportsurgeCatalog,observations:{observation:Observation;result:Match}[],bindings?:SourceEventBinding[]): void;
  streameastCatalog(): {current:StoredStreameastCatalog|null;lastComplete:StoredStreameastCatalog|null;previous:StoredStreameastCatalog|null};
  saveStreameastCatalog(value:StoredStreameastCatalog,observations:{observation:Observation;result:Match}[]): void;
  membership(season: number): SeasonMembership | undefined;
  saveMembership(value: SeasonMembership): void;
  alias(oldId: string, gameId: string): void;
  aliases(): Record<string, string>;
  sweep(now: number): void;
  close(): void;
}

export type FootballDependencies = {
  browserCollectorsAvailable?:boolean;
  store: FootballRepository;
  schedules: readonly ScheduleSource[];
  sources: readonly ListingSource[];
  readSchedule: (source: ScheduleSource, now: number, signal: AbortSignal, onCurrent?: (result: ScheduleResult) => void) => Promise<ScheduleResult>;
  readSeasonMembership: (season: number, signal: AbortSignal) => Promise<SeasonMembership>;
  readHtml: (url: string, signal: AbortSignal) => Promise<string>;
  parseListings: (source: ListingSource, html: string, now: number) => ListingResult;
  enrichObservation: (observation: Observation, html: string) => Observation;
  compatiblePlayers: (gameId: string, observation: Observation, html: string) => ResolvedPlayer[];
  tvappPlayers?: (gameId:string,observation:Observation,html:string,signal:AbortSignal)=>Promise<ResolvedPlayer[]>;
  missingPlayerReason: (observation: Observation, html: string) => MissingPlayerReason;
  probeCandidate: (locator: CandidateLocator, signal: AbortSignal) => Promise<CandidateProbeResult>;
  probeIdentity?: (locator: CandidateLocator) => string;
  persistableLocator?: (locator: CandidateLocator) => boolean;
  retryAfterMs: (error: unknown) => number;
  now: () => number;
  id: () => string;
};
