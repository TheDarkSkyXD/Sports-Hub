import { z } from 'zod';
import { CandidateSchema, LeagueSchema, type Game } from '../shared.ts';
import { normalizedName } from './matching.ts';
import { feedDateEligible } from './feed-eligibility.ts';

const TeamIdentitySchema = z.object({ id: z.string().optional(), name: z.string().min(1) }).strict();
export const WorkingFeedSchema = z.object({
  version: z.literal(1), identityHash: z.string().regex(/^[a-f0-9]{64}$/), candidate: CandidateSchema.strict(),
  owner: z.object({ league: LeagueSchema, home: TeamIdentitySchema, away: TeamIdentitySchema,
    partitionIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  checkedAt: z.number().int().nonnegative(), proof: z.enum(['media', 'decoded']),
}).strict();
export type WorkingFeed = z.infer<typeof WorkingFeedSchema>;

export function workingFeedOwner(game: Game, partitionIds: readonly string[]): WorkingFeed['owner'] {
  const team = (value: Game['home']) => ({ ...(value.id ? { id: value.id } : {}), name: value.name });
  return { league: game.league, home: team(game.home), away: team(game.away), partitionIds: [...new Set(partitionIds)].sort() };
}

type FeedIdentity = Pick<WorkingFeed, 'owner'> & { candidate: Pick<WorkingFeed['candidate'], 'gameId'> };

export function workingFeedMatches(feed: FeedIdentity, game: Game): boolean {
  const same = (saved: WorkingFeed['owner']['home'], current: Game['home']) =>
    saved.id && current.id ? saved.id === current.id : normalizedName(saved.name) === normalizedName(current.name);
  return feed.candidate.gameId === game.id && feed.owner.league === game.league &&
    same(feed.owner.home, game.home) && same(feed.owner.away, game.away);
}

export function cachedFeedEligible(feed: FeedIdentity, game: Game, now: number): boolean {
  if (!workingFeedMatches(feed,game)) return false;
  if (game.lifecycle==='final') return now < game.graceEndsAt;
  return game.finalObservedAt===undefined &&
    (game.lifecycle==='live'||game.lifecycle==='scheduled') &&
    game.date!==undefined && feedDateEligible(Date.parse(game.date),now);
}
