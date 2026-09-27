import type { Candidate, Game, League, Match, Observation, SeasonMembership } from '../shared.ts';

export type ScheduleSource = { id: string; league: League; path: string; group: string | null };
export type ListingSource = { id: string; url: string; family: string };
export type SchedulePartition = { games: Game[]; at: number; week?: number };
export type ScheduleResult = SchedulePartition & { league: League };
export type ListingResult = { observations: Observation[]; outcome: 'parsed' | 'empty' | 'unsupported' | 'parser-changed' };

export interface FootballRepository {
  partition(id: string): SchedulePartition | undefined;
  savePartition(id: string, value: SchedulePartition): void;
  finals(): Game[];
  observe(observation: Observation, result: Match): void;
  observations(): Observation[];
  source(id: string, value: { at: number; outcome: string; count: number; error?: string }): void;
  membership(season: number): SeasonMembership | undefined;
  saveMembership(value: SeasonMembership): void;
  alias(oldId: string, gameId: string): void;
  aliases(): Record<string, string>;
  sweep(now: number): void;
  close(): void;
}

export type FootballDependencies = {
  store: FootballRepository;
  schedules: readonly ScheduleSource[];
  sources: readonly ListingSource[];
  readSchedule: (source: ScheduleSource, now: number, signal: AbortSignal) => Promise<ScheduleResult>;
  readSeasonMembership: (season: number, signal: AbortSignal) => Promise<SeasonMembership>;
  readHtml: (url: string, signal: AbortSignal) => Promise<string>;
  parseListings: (source: ListingSource, html: string, now: number) => ListingResult;
  enrichObservation: (observation: Observation, html: string) => Observation;
  compatiblePlayers: (gameId: string, observation: Observation, html: string, now: number) => Candidate[];
  retryAfterMs: (error: unknown) => number;
  now: () => number;
  id: () => string;
};
