import { z } from 'zod';
import { AdvancingVideoSchema, CandidateSchema, LeagueSchema, isRaceGame, isWrestlingGame, type Game, type MatchupGame } from '../shared.ts';
import { normalizedName } from './matching.ts';
import { feedDateEligible } from './feed-eligibility.ts';

const TeamIdentitySchema = z.object({ id: z.string().optional(), name: z.string().min(1) }).strict();
const WorkingFeedBase = z.object({
  identityHash: z.string().regex(/^[a-f0-9]{64}$/), candidate: CandidateSchema.strict(),
  owner: z.union([
    z.object({ league: LeagueSchema.exclude(['f1','nascar-cup','nascar-truck','motogp','motorsport','wwe','tna']), home: TeamIdentitySchema, away: TeamIdentitySchema,
      partitionIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
    z.object({league:LeagueSchema.extract(['f1','nascar-cup','nascar-truck','motogp','motorsport']),
      eventId:z.string(),sessionId:z.string(),session:z.string(),round:z.string(),
      partitionIds:z.array(z.string().min(1)).min(1).max(32)}).strict(),
    z.object({league:LeagueSchema.extract(['wwe','tna']),eventId:z.string(),date:z.string(),
      partitionIds:z.array(z.string().min(1)).min(1).max(32)}).strict(),
  ]),
  checkedAt: z.number().int().nonnegative(),
});
export const WorkingFeedSchema=z.union([
  WorkingFeedBase.extend({version:z.literal(1),proof:z.enum(['media','decoded'])}).strict(),
  WorkingFeedBase.extend({version:z.literal(2),proof:AdvancingVideoSchema}).strict(),
]);
export type WorkingFeed = z.infer<typeof WorkingFeedSchema>;

export function workingFeedOwner(game: Game, partitionIds: readonly string[]): WorkingFeed['owner'] {
  const ids=[...new Set(partitionIds)].sort();
  if(isRaceGame(game))return {league:game.league,eventId:game.race.eventId,sessionId:game.race.sessionId,
    session:game.race.session,round:game.race.round,partitionIds:ids};
  if(isWrestlingGame(game))return {league:game.league,eventId:game.wrestling.eventId,date:game.date,partitionIds:ids};
  const team = (value: MatchupGame['home']) => ({ ...(value.id ? { id: value.id } : {}), name: value.name });
  return { league: game.league, home: team(game.home), away: team(game.away), partitionIds:ids };
}

type FeedIdentity = Pick<WorkingFeed, 'owner'> & { candidate: Pick<WorkingFeed['candidate'], 'gameId'> };

export function workingFeedMatches(feed: FeedIdentity, game: Game): boolean {
  if(isRaceGame(game))return 'sessionId' in feed.owner&&feed.candidate.gameId===game.id&&
    feed.owner.league===game.league&&feed.owner.eventId===game.race.eventId&&
    feed.owner.sessionId===game.race.sessionId&&feed.owner.session===game.race.session&&feed.owner.round===game.race.round;
  if(isWrestlingGame(game))return 'date' in feed.owner&&feed.candidate.gameId===game.id&&
    feed.owner.league===game.league&&feed.owner.eventId===game.wrestling.eventId&&feed.owner.date===game.date;
  if(!('home' in feed.owner))return false;
  const same = (saved: typeof feed.owner.home, current: MatchupGame['home']) =>
    saved.id && current.id ? saved.id === current.id : normalizedName(saved.name) === normalizedName(current.name);
  return feed.candidate.gameId === game.id && feed.owner.league === game.league &&
    same(feed.owner.home, game.home) && same(feed.owner.away, game.away);
}

export function cachedFeedEligible(feed: FeedIdentity, game: Game, now: number): boolean {
  if (!workingFeedMatches(feed,game)) return false;
  if (game.lifecycle==='final') return now < game.graceEndsAt;
  return game.finalObservedAt===undefined &&
    (game.lifecycle==='live'||game.lifecycle==='scheduled'||isWrestlingGame(game)&&game.lifecycle==='unknown') &&
    game.date!==undefined && (isWrestlingGame(game)&&game.lifecycle==='unknown'
      ?now>=Date.parse(game.date)&&now-Date.parse(game.date)<=6*60*60_000
      :feedDateEligible(Date.parse(game.date),now));
}
