import { z } from 'zod';
import { AdvancingVideoSchema, CandidateSchema, LeagueSchema, type Game } from '../shared.ts';
import {nativeDomain} from './native.ts';

const TeamIdentitySchema = z.object({ id: z.string().optional(), name: z.string().min(1) }).strict();
export const FeedOwnerSchema=z.union([
    z.object({ league: LeagueSchema.exclude(['f1','nascar-cup','nascar-truck','motogp','motorsport','ufc','boxing','wwe','tna','aew','wrestling']), home: TeamIdentitySchema, away: TeamIdentitySchema,
      partitionIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
    z.object({league:LeagueSchema.extract(['f1','nascar-cup','nascar-truck','motogp','motorsport']),
      eventId:z.string(),sessionId:z.string(),session:z.string(),round:z.string(),
      partitionIds:z.array(z.string().min(1)).min(1).max(32)}).strict(),
    z.object({league:LeagueSchema.extract(['ufc','boxing','wwe','tna','aew','wrestling']),eventId:z.string().min(1),date:z.string(),
      partitionIds:z.array(z.string().min(1)).min(1).max(32)}).strict(),
  ]);
const WorkingFeedBase = z.object({
  identityHash: z.string().regex(/^[a-f0-9]{64}$/), candidate: CandidateSchema.strict(),
  owner: FeedOwnerSchema,
  checkedAt: z.number().int().nonnegative(),
});
export const WorkingFeedSchema=z.union([
  WorkingFeedBase.extend({version:z.literal(1),proof:z.enum(['media','decoded'])}).strict(),
  WorkingFeedBase.extend({version:z.literal(2),proof:AdvancingVideoSchema}).strict(),
]);
export type WorkingFeed = z.infer<typeof WorkingFeedSchema>;

export function workingFeedOwner(game: Game, partitionIds: readonly string[]): WorkingFeed['owner'] {
  return nativeDomain('workingFeedOwner',[game,partitionIds],FeedOwnerSchema);
}

type FeedIdentity = Pick<WorkingFeed, 'owner'> & { candidate: Pick<WorkingFeed['candidate'], 'gameId'> };

export function workingFeedMatches(feed: FeedIdentity, game: Game): boolean {
  return nativeDomain('workingFeedMatches',[feed,game],z.boolean());
}

export function cachedFeedEligible(feed: FeedIdentity, game: Game, now: number): boolean {
  return nativeDomain('cachedFeedEligible',[feed,game,now],z.boolean());
}
