import { z } from 'zod';

export const LeagueSchema = z.enum(['nfl', 'ncaaf']);
export const TeamSchema = z.object({
  id: z.string().optional(), name: z.string(), short: z.string(), abbreviation: z.string(),
  color: z.string(), logo: z.string().optional(), score: z.string().nullable(), record: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  membership: z.object({subdivision:z.enum(['fbs','fcs']),season:z.number().int(),observedAt:z.number(),source:z.literal('espn-core')}).optional(),
});
export const GameSchema = z.object({
  id: z.string(), league: LeagueSchema, name: z.string(), date: z.string().optional(),
  home: TeamSchema, away: TeamSchema, status: z.enum(['pre', 'in', 'post', 'unknown']),
  lifecycle: z.enum(['scheduled', 'live', 'final', 'unknown']).optional(),
  season: z.number().optional(), partitions: z.array(z.string()).optional(),
  detail: z.string(), redzone: z.boolean(), possession: z.string().optional(), down: z.string().optional(),
  lastPlay: z.string().optional(), venue: z.string().optional(), broadcast: z.string().optional(),
  sourceUrl: z.string().optional(), sourceUrls: z.array(z.string()).optional(),
  finalObservedAt: z.number().optional(), graceEndsAt: z.number().optional(),
});
export const LeagueFeedSchema = z.object({ week: z.number().optional(), scoresAt: z.string().nullable(), sourceAt: z.string().nullable(), errors: z.array(z.string()) });
export const BoardSchema = z.object({
  schemaVersion: z.literal(2), revision: z.number().int().nonnegative(), games: z.array(GameSchema), updatedAt: z.string(),
  leagues: z.object({ nfl: LeagueFeedSchema, ncaaf: LeagueFeedSchema }), aliases: z.record(z.string()),
});
export type Team = z.infer<typeof TeamSchema>;
export type Game = z.infer<typeof GameSchema>;
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
  kickoff: z.number().nullable(), rawTime: z.string(), observedAt: z.number(), parserVersion: z.literal(1),
  legacyId: z.string().optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;
export type Match = { kind: 'matched'; gameId: string } | { kind: 'unmatched'; reason: string; possibleGameIds: string[] };
export const CandidateSchema = z.object({
  id: z.string(), gameId: z.string(), playerId: z.string(), url: z.string().url(),
  label: z.string(), sourceIds: z.array(z.string()), observedAt: z.number(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export const SessionSchema = z.object({
  id: z.string(), gameId: z.string(), candidateId: z.string(), generation: z.number(),
  state: z.enum(['active', 'draining', 'closed']), graceEndsAt: z.number().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;
export const PlaybackSchema = z.object({ session: SessionSchema, candidates: z.array(CandidateSchema) });
export type Playback = z.infer<typeof PlaybackSchema>;
export const CommandSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('board')}),
  z.object({kind:z.literal('open'),gameId:z.string().min(1).max(100),manual:z.boolean().default(false),requestId:z.string().uuid().optional()}),
  z.object({kind:z.literal('session'),sessionId:z.string().uuid(),generation:z.number().int().nonnegative(),candidateId:z.string().max(100).optional(),failure:z.boolean().default(false),retry:z.boolean().default(false)}),
  z.object({kind:z.literal('close'),sessionId:z.string().uuid()}),
  z.object({kind:z.literal('authorize'),sessionId:z.string().uuid(),candidateId:z.string().min(1).max(100),generation:z.number().int().nonnegative()}),
  z.object({kind:z.literal('refresh')}),
  z.object({kind:z.literal('stop')}),
]);
export type Command = z.infer<typeof CommandSchema>;
export const ReplySchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('board'),board:BoardSchema}),
  z.object({kind:z.literal('playback'),playback:PlaybackSchema}),
  z.object({kind:z.literal('session'),session:SessionSchema}),
  z.object({kind:z.literal('authorized'),candidate:CandidateSchema,session:SessionSchema}),
  z.object({kind:z.literal('ok')}),
  z.object({kind:z.literal('error'),status:z.number(),message:z.string(),retryAfter:z.number().int().nonnegative().optional()}),
]);
export type Reply = z.infer<typeof ReplySchema>;
