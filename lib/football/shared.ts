import { z } from 'zod';

export const LeagueSchema = z.enum(['nfl', 'ncaaf', 'nba']);
const BrowserCatalogLeagueSchema = z.enum(['nfl','ncaaf']);
export const TeamSchema = z.object({
  id: z.string().optional(), name: z.string(), short: z.string(), abbreviation: z.string(),
  color: z.string(), logo: z.string().optional(), score: z.string().nullable(), record: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  membership: z.object({subdivision:z.enum(['fbs','fcs']),season:z.number().int(),observedAt:z.number(),source:z.literal('espn-core')}).optional(),
});
const GameFields = z.object({
  id: z.string(), league: LeagueSchema, name: z.string(), date: z.string().optional(),
  home: TeamSchema, away: TeamSchema,
  season: z.number().optional(), partitions: z.array(z.string()).optional(),
  detail: z.string(), redzone: z.boolean(), possession: z.string().optional(), down: z.string().optional(),
  lastPlay: z.string().optional(), venue: z.string().optional(), broadcast: z.string().optional(),
  sourceUrl: z.string().optional(), sourceUrls: z.array(z.string()).optional(),
});
const NonfinalFields = { finalObservedAt:z.never().optional(), graceEndsAt:z.never().optional() };
const ScheduledGameSchema = GameFields.extend({...NonfinalFields,status:z.literal('pre'),lifecycle:z.literal('scheduled')}).strict();
const LiveGameSchema = GameFields.extend({...NonfinalFields,status:z.literal('in'),lifecycle:z.literal('live')}).strict();
const UnknownGameSchema = GameFields.extend({...NonfinalFields,status:z.enum(['pre','in','post','unknown']),lifecycle:z.literal('unknown')}).strict();
const RawFinalGameSchema = GameFields.extend({...NonfinalFields,status:z.literal('post'),lifecycle:z.literal('final')}).strict();
const FinalGameSchema = GameFields.extend({status:z.literal('post'),lifecycle:z.literal('final'),sourceUrls:z.tuple([]).optional(),finalObservedAt:z.number(),graceEndsAt:z.number()}).strict();
export const ScheduleGameSchema = z.discriminatedUnion('lifecycle',[ScheduledGameSchema,LiveGameSchema,UnknownGameSchema,RawFinalGameSchema]);
export const GameSchema = z.discriminatedUnion('lifecycle',[ScheduledGameSchema,LiveGameSchema,UnknownGameSchema,FinalGameSchema]);
export const LeagueFeedSchema = z.object({ week: z.number().optional(), scoresAt: z.string().nullable(), sourceAt: z.string().nullable(), errors: z.array(z.string()) });
export const FinishedGameRetentionMinutesSchema = z.number().int().min(5).max(10080);
export const DEFAULT_FINISHED_GAME_RETENTION_MINUTES = 1440;
export const FeedCheckIntervalMinutesSchema = z.number().int().refine(minutes=>[1,5,10,15].includes(minutes));
export const DEFAULT_FEED_CHECK_INTERVAL_MINUTES = 5;
export const BoardSchema = z.object({
  schemaVersion: z.literal(2), revision: z.number().int().nonnegative(), games: z.array(GameSchema), updatedAt: z.string(),
  scheduleState: z.enum(['loading','ready']),
  finishedGameRetentionMinutes: FinishedGameRetentionMinutesSchema.default(DEFAULT_FINISHED_GAME_RETENTION_MINUTES),
  feedCheckIntervalMinutes: FeedCheckIntervalMinutesSchema.default(DEFAULT_FEED_CHECK_INTERVAL_MINUTES),
  leagues: z.object({ nfl: LeagueFeedSchema, ncaaf: LeagueFeedSchema, nba: LeagueFeedSchema.default({scoresAt:null,sourceAt:null,errors:[]}) }), aliases: z.record(z.string()),
});
export type Team = z.infer<typeof TeamSchema>;
export type Game = z.infer<typeof GameSchema>;
export type ScheduleGame = z.infer<typeof ScheduleGameSchema>;
export type FinalGame = z.infer<typeof FinalGameSchema>;
export type RawFinalGame = z.infer<typeof RawFinalGameSchema>;
export type League = z.infer<typeof LeagueSchema>;
export type LeagueFeedStatus = z.infer<typeof LeagueFeedSchema>;
export type Board = z.infer<typeof BoardSchema>;

export const SeasonMembershipSchema = z.object({
  season:z.number().int(),at:z.number(),teams:z.record(z.enum(['fbs','fcs'])),
});
export type SeasonMembership = z.infer<typeof SeasonMembershipSchema>;

export const ObservationSchema = z.object({
  id: z.string(), sourceId: z.string(), url: z.string(), title: z.string(),
  league: LeagueSchema.nullable(), teams: z.tuple([z.string(), z.string()]).nullable(),
  kickoff: z.number().nullable(), rawTime: z.string(), observedAt: z.number(), parserVersion: z.union([z.literal(1),z.literal(2),z.literal(3)]),
  legacyId: z.string().optional(),
  kickoffLineage:z.object({observedAt:z.number(),rawTime:z.string()}).optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;
export const SourceEventBindingSchema=z.object({
  sourceId:z.string(),eventId:z.string(),url:z.string().url(),league:LeagueSchema,
  teams:z.tuple([z.string(),z.string()]),gameId:z.string(),observedAt:z.number(),
});
export type SourceEventBinding=z.infer<typeof SourceEventBindingSchema>;
export type Match = { kind: 'matched'; gameId: string } | { kind: 'unmatched'; reason: string; possibleGameIds: string[] };
export const CandidateAvailabilitySchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('unknown')}),
  z.object({kind:z.literal('checking'),progress:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('queued'),since:z.number()}),
    z.object({kind:z.literal('active'),since:z.number()}),
    z.object({kind:z.literal('deferred'),since:z.number(),retryAt:z.number()}),
  ])}),
  z.object({kind:z.literal('playable'),checkedAt:z.number(),proof:z.enum(['media','decoded'])}),
  z.object({kind:z.literal('unavailable'),checkedAt:z.number(),retryAt:z.number(),reason:z.enum(['upstream','unsupported','invalid-media','timeout','playback'])}),
]);
export type CandidateAvailability = z.infer<typeof CandidateAvailabilitySchema>;
export const CandidateSummarySchema = z.object({
  id: z.string(), gameId: z.string(), label: z.string(), sourceIds: z.array(z.string()), observedAt: z.number(),availability:CandidateAvailabilitySchema,
});
export type CandidateSummary = z.infer<typeof CandidateSummarySchema>;
export const CandidateLocatorSchema = z.discriminatedUnion('provider',[
  z.object({provider:z.literal('swac'),eventId:z.string().regex(/^[a-f0-9]{32}$/)}),
  z.object({provider:z.literal('gooz'),playerId:z.string().regex(/^\d{1,20}$/)}),
  z.object({provider:z.literal('streamcenter'),eventId:z.string().regex(/^\d{5,12}$/),linkId:z.string().uuid(),league:z.enum(['ncaaf','nba']).optional()}),
  z.object({provider:z.literal('streameast'),channelId:z.string().regex(/^\d{1,4}$/)}),
  z.object({provider:z.literal('streameast-server'),gameId:z.string().regex(/^(?:(?:ncaaf|nba)-)?\d{1,20}$/),
    sourceEventId:z.string().regex(/^(?:ncaaf|nfl|nba):\d{1,12}$/),eventUrl:z.string().url().max(400),
    serverId:z.string().regex(/^[1-9]\d{0,3}$/)}).strict(),
  z.object({provider:z.literal('sportsurge-v2'),eventId:z.string().regex(/^(?:ncaaf|nfl|nba):\d{1,12}$/),providerId:z.string().min(1).max(100),url:z.string().url().max(2000),
    expectedMatchup:z.object({league:LeagueSchema,teams:z.tuple([z.string().min(1).max(120),z.string().min(1).max(120)])}).strict().optional()}),
  z.object({provider:z.literal('wikisport'),section:z.enum(['0nhl','strm']),playerId:z.string().regex(/^\d{1,4}$/)}),
  z.object({provider:z.literal('event-page'),gameId:z.string().regex(/^(?:(?:ncaaf|nba)-)?\d{1,20}$/),
    eventUrl:z.string().url().max(2000),serverUrl:z.string().url().max(2000)}).strict(),
  z.object({provider:z.literal('tvapp'),gameId:z.string().regex(/^(?:(?:ncaaf|nba)-)?\d{1,20}$/),
    eventUrl:z.string().url().max(2000),source:z.string().regex(/^[a-z0-9-]{1,32}$/),
    sourceId:z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),streamNo:z.number().int().min(1).max(100),
    kickoff:z.number().int(),title:z.string().min(1).max(200),teams:z.tuple([z.string().min(1),z.string().min(1)])}).strict(),
]);
export type CandidateLocator = z.infer<typeof CandidateLocatorSchema>;
export const CandidateSchema = CandidateSummarySchema.omit({availability:true}).extend({locator:CandidateLocatorSchema});
export type Candidate = z.infer<typeof CandidateSchema>;
export function candidateSummary(candidate: Candidate, availability:CandidateAvailability={kind:'unknown'}): CandidateSummary {
  const {id,gameId,label,sourceIds,observedAt} = candidate;
  return {id,gameId,label,sourceIds,observedAt,availability};
}
const SessionFields = z.object({
  id: z.string(), gameId: z.string(), candidateId: z.string(), generation: z.number(),
});
export const SessionSchema = z.discriminatedUnion('state',[
  SessionFields.extend({state:z.literal('active'),graceEndsAt:z.null()}).strict(),
  SessionFields.extend({state:z.literal('draining'),graceEndsAt:z.number()}).strict(),
  SessionFields.extend({state:z.literal('closed'),graceEndsAt:z.number()}).strict(),
]);
export type Session = z.infer<typeof SessionSchema>;
export const PlaybackSchema = z.object({ session: SessionSchema, candidates: z.array(CandidateSummarySchema) });
export type Playback = z.infer<typeof PlaybackSchema>;
export const SourceAttemptSchema = z.object({
  at:z.number(),outcome:z.enum(['parsed','empty','unsupported','parser-changed','failed']),
  failure:z.enum(['not-found','blocked','rate-limited','timed-out','network-unavailable','unsupported-address','invalid-response','upstream-error']).optional(),
  count:z.number().int().nonnegative().optional(),failures:z.number().int().nonnegative().optional(),nextEligibleAt:z.number().optional(),
  parserVersion:z.number().int().positive().optional(),
});
export type SourceAttempt = z.infer<typeof SourceAttemptSchema>;
export type CollectionAttempt = {sourceId:string;league:League|null;at:number;outcome:SourceAttempt['outcome'];count:number};
export const ResolvedPlayerSchema = CandidateSchema.pick({id:true,label:true,locator:true});
export type ResolvedPlayer = z.infer<typeof ResolvedPlayerSchema>;
export const MissingPlayerReasonSchema=z.enum(['no-compatible-media','not-yet-published','no-published-player',
  'unsupported-player','paid-only','conflicting-game','parser-changed']);
export type MissingPlayerReason=z.infer<typeof MissingPlayerReasonSchema>;
const LastDetailSuccessSchema=z.object({identity:z.string(),at:z.number(),count:z.number().int().positive()});
export const DetailEvidenceSchema = z.discriminatedUnion('outcome',[
  z.object({outcome:z.literal('resolved'),observationId:z.string(),generation:z.string(),identity:z.string().optional(),at:z.number(),players:z.array(ResolvedPlayerSchema),nextEligibleAt:z.number(),lastSuccess:LastDetailSuccessSchema.optional()}),
  z.object({outcome:z.literal('unresolved'),observationId:z.string(),generation:z.string(),at:z.number(),reason:MissingPlayerReasonSchema,failures:z.number().int().nonnegative(),nextEligibleAt:z.number(),lastSuccess:LastDetailSuccessSchema.optional()}),
  z.object({outcome:z.literal('failed'),observationId:z.string(),generation:z.string(),at:z.number(),failure:SourceAttemptSchema.shape.failure.unwrap(),failures:z.number().int().nonnegative(),nextEligibleAt:z.number(),lastSuccess:LastDetailSuccessSchema.optional()}),
]);
export type DetailEvidence = z.infer<typeof DetailEvidenceSchema>;
export const SourceMatchReasonSchema=z.enum(['not-a-matchup','unknown-teams','unverified-kickoff','unverified-contextual-kickoff',
  'ambiguous-matchup','conflicting-date','finished-game','other']);
export type SourceMatchReason=z.infer<typeof SourceMatchReasonSchema>;
export const SportsurgeFailureSchema=z.enum(['blocked','rate-limited','timeout','parser-changed','unavailable','invalid-detail-url','limit']);
export const SportsurgeProviderSchema=z.object({
  id:z.string().min(1).max(100),label:z.string().min(1).max(160),observedAt:z.number().int().nonnegative(),
  destination:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('link'),url:z.string().url().max(2000)}).strict(),
    z.object({kind:z.literal('rejected'),reason:z.enum(['insecure','credentials','private-host','credential-query','oversized']),display:z.string().max(240).nullable()}).strict(),
    z.object({kind:z.literal('malformed'),reason:z.enum(['missing','invalid-url'])}).strict(),
  ]),
}).strict();
export type SportsurgeProvider=z.infer<typeof SportsurgeProviderSchema>;
export const SportsurgeDetailSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pending')}).strict(),
  z.object({kind:z.literal('collected'),at:z.number().int().nonnegative(),retainedFromRunId:z.string().uuid().optional(),providers:z.array(SportsurgeProviderSchema)}).strict(),
  z.object({kind:z.literal('failed'),at:z.number().int().nonnegative(),reason:SportsurgeFailureSchema}).strict(),
]);
export const SportsurgeEventSchema=z.object({
  id:z.string().regex(/^(?:ncaaf|nfl):\d{1,12}$/),url:z.string().url().max(400),league:BrowserCatalogLeagueSchema,
  title:z.string().min(1).max(240),teams:z.tuple([z.string().min(1).max(120),z.string().min(1).max(120)]).nullable(),
  sourceStatus:z.enum(['live','upcoming','unknown']),kickoff:z.number().int().nonnegative().nullable(),
  advertisedLinkCount:z.number().int().nonnegative().nullable(),detail:SportsurgeDetailSchema,
}).strict();
export const SportsurgeCategorySchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pending')}).strict(),
  z.object({kind:z.literal('collected'),at:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('failed'),at:z.number().int().nonnegative(),reason:SportsurgeFailureSchema}).strict(),
]);
export const SportsurgeCatalogSchema=z.object({
  runId:z.string().uuid(),sequence:z.number().int().nonnegative(),startedAt:z.number().int().nonnegative(),
  state:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('collecting')}).strict(),
    z.object({kind:z.literal('complete'),at:z.number().int().nonnegative()}).strict(),
    z.object({kind:z.literal('partial'),at:z.number().int().nonnegative(),reason:SportsurgeFailureSchema}).strict(),
  ]),
  categories:z.object({ncaaf:SportsurgeCategorySchema,nfl:SportsurgeCategorySchema}).strict(),
  events:z.array(SportsurgeEventSchema),
  rejectedGames:z.array(z.object({league:BrowserCatalogLeagueSchema,title:z.string().max(240),reason:z.enum(['invalid-detail-url','duplicate-game-id'])}).strict()),
  catalogIssues:z.array(z.object({league:BrowserCatalogLeagueSchema,title:z.string().max(240),reason:z.literal('duplicate-game-id')}).strict()),
}).strict();
export type SportsurgeCatalog=z.infer<typeof SportsurgeCatalogSchema>;
export const StoredSportsurgeCatalogSchema=z.object({catalog:SportsurgeCatalogSchema,receivedAt:z.number().int().nonnegative()}).strict();
export type StoredSportsurgeCatalog=z.infer<typeof StoredSportsurgeCatalogSchema>;
export const StreameastFailureSchema=z.enum(['blocked','rate-limited','timeout','parser-changed','unavailable','limit']);
export const StreameastCategorySchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pending')}).strict(),
  z.object({kind:z.literal('collected'),at:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('failed'),at:z.number().int().nonnegative(),reason:StreameastFailureSchema}).strict(),
]);
export const StreameastAvailabilitySchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('free-channel'),channelId:z.string().regex(/^\d{1,4}$/)}).strict(),
  z.object({kind:z.literal('free-wikisport'),section:z.enum(['0nhl','strm']),playerId:z.string().regex(/^\d{1,4}$/)}).strict(),
  z.object({kind:z.literal('free-page')}).strict(),
  z.object({kind:z.literal('free-unsupported')}).strict(),
  z.object({kind:z.literal('free-unresolved')}).strict(),
  z.object({kind:z.literal('premium')}).strict(),
  z.object({kind:z.literal('unknown')}).strict(),
]);
export const StreameastServerSchema=z.object({
  id:z.string().regex(/^\d{1,4}$/),label:z.string().min(1).max(120),url:z.string().url().max(400),
  availability:StreameastAvailabilitySchema,
}).strict();
export const StreameastDetailSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pending')}).strict(),
  z.object({kind:z.literal('collected'),at:z.number().int().nonnegative(),retainedFromRunId:z.string().uuid().optional(),servers:z.array(StreameastServerSchema)}).strict(),
  z.object({kind:z.literal('failed'),at:z.number().int().nonnegative(),reason:StreameastFailureSchema}).strict(),
]);
export const StreameastEventSchema=z.object({
  id:z.string().regex(/^(?:ncaaf|nfl):\d{1,12}$/),league:BrowserCatalogLeagueSchema,url:z.string().url().max(400),
  title:z.string().min(1).max(240),teams:z.tuple([z.string().min(1).max(120),z.string().min(1).max(120)]).nullable(),
  kickoff:z.number().int().nonnegative().nullable(),espnEventId:z.string().regex(/^\d{5,12}$/).nullable(),
  detail:StreameastDetailSchema,
}).strict();
export const StreameastCatalogSchema=z.object({
  runId:z.string().uuid(),sequence:z.number().int().nonnegative(),startedAt:z.number().int().nonnegative(),
  state:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('collecting')}).strict(),
    z.object({kind:z.literal('complete'),at:z.number().int().nonnegative()}).strict(),
    z.object({kind:z.literal('partial'),at:z.number().int().nonnegative(),reason:StreameastFailureSchema}).strict(),
  ]),
  categories:z.object({ncaaf:StreameastCategorySchema,nfl:StreameastCategorySchema}).strict(),
  events:z.array(StreameastEventSchema),
  rejectedGames:z.array(z.object({league:BrowserCatalogLeagueSchema,title:z.string().max(240),reason:z.enum(['invalid-detail-url','duplicate-game-id'])}).strict()),
}).strict();
export type StreameastCatalog=z.infer<typeof StreameastCatalogSchema>;
export const StoredStreameastCatalogSchema=z.object({catalog:StreameastCatalogSchema,receivedAt:z.number().int().nonnegative()}).strict();
export type StoredStreameastCatalog=z.infer<typeof StoredStreameastCatalogSchema>;
export const StreameastCatalogViewSchema=z.object({
  runId:z.string().uuid(),startedAt:z.number(),receivedAt:z.number(),interrupted:z.boolean(),state:StreameastCatalogSchema.shape.state,
  categories:StreameastCatalogSchema.shape.categories,gameCount:z.number().int().nonnegative(),
  collectedDetails:z.number().int().nonnegative(),pendingDetails:z.number().int().nonnegative(),failedDetails:z.number().int().nonnegative(),
  serverRows:z.number().int().nonnegative(),freeRows:z.number().int().nonnegative(),premiumRows:z.number().int().nonnegative(),
  unknownRows:z.number().int().nonnegative(),unsupportedFreeRows:z.number().int().nonnegative(),matchedCompatibleChannels:z.number().int().nonnegative(),
  rejectedGames:StreameastCatalogSchema.shape.rejectedGames,
  games:z.array(z.object({id:z.string(),title:z.string(),url:z.string().url(),league:LeagueSchema,gameId:z.string().nullable(),
    matchReason:SourceMatchReasonSchema.nullable(),detail:StreameastDetailSchema})),
}).strict();
export type StreameastCatalogView=z.infer<typeof StreameastCatalogViewSchema>;
const SportsurgePublicProviderSchema=SportsurgeProviderSchema.extend({destination:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('link')}).strict(),
  SportsurgeProviderSchema.shape.destination.options[1],
  SportsurgeProviderSchema.shape.destination.options[2],
])});
const SportsurgePublicDetailSchema=z.discriminatedUnion('kind',[
  SportsurgeDetailSchema.options[0],
  SportsurgeDetailSchema.options[1].extend({providers:z.array(SportsurgePublicProviderSchema)}),
  SportsurgeDetailSchema.options[2],
]);
export const SportsurgeCatalogViewSchema=z.object({
  runId:z.string().uuid(),startedAt:z.number(),receivedAt:z.number(),interrupted:z.boolean(),state:SportsurgeCatalogSchema.shape.state,
  categories:SportsurgeCatalogSchema.shape.categories,
  gameCount:z.number().int().nonnegative(),collectedDetails:z.number().int().nonnegative(),
  pendingDetails:z.number().int().nonnegative(),failedDetails:z.number().int().nonnegative(),
  providerRows:z.number().int().nonnegative(),rejectedProviders:z.number().int().nonnegative(),
  rejectedGames:SportsurgeCatalogSchema.shape.rejectedGames,
  catalogIssues:SportsurgeCatalogSchema.shape.catalogIssues,
  games:z.array(z.object({
    id:z.string(),title:z.string(),url:z.string().url(),league:LeagueSchema,gameId:z.string().nullable(),
    matchReason:SourceMatchReasonSchema.nullable(),sourceStatus:z.enum(['live','upcoming','unknown']),
    detail:SportsurgePublicDetailSchema,
  })),
});
export type SportsurgeCatalogView=z.infer<typeof SportsurgeCatalogViewSchema>;
export const LinkEvidenceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pending')}),
  z.object({kind:z.literal('unmatched'),reason:SourceMatchReasonSchema}),
  z.object({kind:z.literal('collected'),checkedAt:z.number(),candidateIds:z.array(z.string())}),
  z.object({kind:z.literal('missing'),checkedAt:z.number(),reason:MissingPlayerReasonSchema,retryAt:z.number().nullable()}),
  z.object({kind:z.literal('failed'),checkedAt:z.number(),failure:SourceAttemptSchema.shape.failure.unwrap(),retryAt:z.number().nullable()}),
]);
export type LinkEvidence=z.infer<typeof LinkEvidenceSchema>;
export const CollectionHealthSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('no-baseline')}),
  z.object({kind:z.literal('healthy'),currentAt:z.number(),currentCount:z.number().int().nonnegative(),baselineAt:z.number(),baselineCount:z.number().int().positive()}),
  z.object({kind:z.literal('attention'),reason:z.enum(['parser-changed','empty-after-success','player-drop','collection-failed']),
    currentAt:z.number(),currentCount:z.number().int().nonnegative(),baselineAt:z.number(),baselineCount:z.number().int().positive()}),
]);
export type CollectionHealth=z.infer<typeof CollectionHealthSchema>;
export const SharedRouteSchema=z.object({id:z.string(),candidateIds:z.array(z.string()),sourceIds:z.array(z.string()),
  evidence:z.literal('same-published-server')});
export type SharedRoute=z.infer<typeof SharedRouteSchema>;
export const SourcesSnapshotSchema = z.object({
  at:z.number(),revision:z.number(),windowStartAt:z.number(),lastDiscoveryAt:z.number().nullable(),browserCollectorsAvailable:z.boolean(),
  sportsurgeV2:z.object({current:SportsurgeCatalogViewSchema.nullable(),lastComplete:SportsurgeCatalogViewSchema.nullable(),previous:SportsurgeCatalogViewSchema.nullable()}),
  streameast:z.object({current:StreameastCatalogViewSchema.nullable(),lastComplete:StreameastCatalogViewSchema.nullable(),previous:StreameastCatalogViewSchema.nullable()}),
  sources:z.array(z.object({
    id:z.string(),name:z.string(),catalogUrl:z.string().url(),publicUrls:z.array(z.string().url()),pending:z.boolean(),
    collectionMode:z.enum(['listings-only','compatible-feed-discovery']),
    lastAttempt:SourceAttemptSchema.nullable(),listingCount:z.number().int().nonnegative(),
    matchedGameCount:z.number().int().nonnegative(),staleListingCount:z.number().int().nonnegative(),
    freeChoiceCount:z.number().int().nonnegative().default(0),workingChoiceCount:z.number().int().nonnegative().default(0),
    collectionHealth:CollectionHealthSchema.default({kind:'no-baseline'}),
    compatibleFeedCount:z.number().int().nonnegative(),
    unmatchedListingCount:z.number().int().nonnegative(),
    unmatchedReasons:z.array(z.object({reason:SourceMatchReasonSchema,count:z.number().int().positive()})),
    links:z.array(z.object({title:z.string(),url:z.string().url(),gameId:z.string().nullable(),
      observedAt:z.number(),freshness:z.enum(['fresh','stale-live']),evidence:LinkEvidenceSchema.default({kind:'pending'})})),
  })),
  games:z.array(z.object({
    gameId:z.string(),name:z.string(),sourceCount:z.number().int().nonnegative(),
    uniqueFeedCount:z.number().int().nonnegative(),freeChoiceCount:z.number().int().nonnegative().default(0),
    workingChoiceCount:z.number().int().nonnegative().default(0),sharedRoutes:z.array(SharedRouteSchema).default([]),
    candidates:z.array(CandidateSummarySchema),sourceLinks:z.array(z.object({sourceId:z.string(),title:z.string(),url:z.string().url(),
      observedAt:z.number(),freshness:z.enum(['fresh','stale-live']),evidence:LinkEvidenceSchema.default({kind:'pending'})})),
  })),
});
export type SourcesSnapshot = z.infer<typeof SourcesSnapshotSchema>;
export const CommandSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('board')}),
  z.object({kind:z.literal('set-retention'),minutes:FinishedGameRetentionMinutesSchema}),
  z.object({kind:z.literal('set-feed-check-interval'),minutes:FeedCheckIntervalMinutesSchema}),
  z.object({kind:z.literal('sources')}),
  z.object({kind:z.literal('check-sources'),gameIds:z.array(z.string().min(1).max(100)).min(1).max(4),retry:z.boolean().default(false)}),
  z.object({kind:z.literal('open'),gameId:z.string().min(1).max(100),manual:z.boolean().default(false),requestId:z.string().uuid().optional(),initialCandidateId:z.string().min(1).max(100).optional()}),
  z.object({kind:z.literal('session'),sessionId:z.string().uuid(),generation:z.number().int().nonnegative(),candidateId:z.string().max(100).optional(),failure:z.boolean().default(false),retry:z.boolean().default(false)}),
  z.object({kind:z.literal('close'),sessionId:z.string().uuid()}),
  z.object({kind:z.literal('authorize'),sessionId:z.string().uuid(),candidateId:z.string().min(1).max(100),generation:z.number().int().nonnegative()}),
  z.object({kind:z.literal('playback-evidence'),sessionId:z.string().uuid(),candidateId:z.string().min(1).max(100),generation:z.number().int().nonnegative(),evidence:z.object({kind:z.literal('decoded'),startupMs:z.number().int().nonnegative().max(300000)})}),
  z.object({kind:z.literal('refresh')}),
  z.object({kind:z.literal('sportsurge-catalog'),catalog:SportsurgeCatalogSchema}),
  z.object({kind:z.literal('streameast-catalog'),catalog:StreameastCatalogSchema}),
  z.object({kind:z.literal('stop')}),
]);
export type Command = z.infer<typeof CommandSchema>;
export const ReplySchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('board'),board:BoardSchema}),
  z.object({kind:z.literal('sources'),snapshot:SourcesSnapshotSchema}),
  z.object({kind:z.literal('playback'),playback:PlaybackSchema}),
  z.object({kind:z.literal('session'),session:SessionSchema,candidates:z.array(CandidateSummarySchema)}),
  z.object({kind:z.literal('authorized'),candidate:CandidateSchema,session:SessionSchema}),
  z.object({kind:z.literal('ok')}),
  z.object({kind:z.literal('catalog-ack'),skipDetailEventIds:z.array(z.string()),sourceRefreshMs:z.number().int().refine(milliseconds=>[60_000,300_000,600_000,900_000].includes(milliseconds)).optional(),skipDetailEventUrls:z.array(z.string().url()).optional(),reuseDetails:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('sportsurge-v2'),events:z.array(SportsurgeEventSchema)}),
    z.object({kind:z.literal('streameast'),events:z.array(StreameastEventSchema)}),
  ]).optional()}),
  z.object({kind:z.literal('error'),status:z.number(),message:z.string(),retryAfter:z.number().int().nonnegative().optional(),code:z.enum(['drain-exhausted']).optional()}),
]);
export type Reply = z.infer<typeof ReplySchema>;
