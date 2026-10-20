import { randomUUID } from 'node:crypto';
import { FootballStore } from '../adapters/store.ts';
import { SCHEDULES } from '../adapters/schedule.ts';
import { SOURCES, SourceFetchError, compatiblePlayers, enrichObservation, missingPlayerReason, parseListings, readHtml, resolvePlayers, tvappPlayers } from '../adapters/sources.ts';
import type { FootballDependencies } from '../domain/ports.ts';
import { FootballCoordinator } from './coordinator.ts';
import { NativeScheduleClient } from './native-schedule.ts';
import { PartialListingReadError } from '../domain/ports.ts';
import { configuredProbeCandidate, probeIdentity } from '../../playback/probe.ts';
import { persistableLocator } from '../../playback/persistent-locator.ts';

type Overrides = Partial<Omit<FootballDependencies, 'store'>> & { ownerToken?: string; reclaimToken?: string };

export function createFootballCoordinator(path: string, options: Overrides = {}): FootballCoordinator {
  const store = new FootballStore(path,{ownerToken:options.ownerToken,reclaimToken:options.reclaimToken});
  let scheduleClient:NativeScheduleClient|undefined;
  let scheduleReader=options.readSchedule;
  if(!scheduleReader){scheduleClient=new NativeScheduleClient();scheduleReader=scheduleClient.readSchedule.bind(scheduleClient);}
  try {
    return new FootballCoordinator({
      store,
      browserCollectorsAvailable:options.browserCollectorsAvailable,
      schedules:options.schedules ?? SCHEDULES,
      sources:options.sources ?? SOURCES,
      readSchedule:scheduleReader,
      closeSchedule:options.closeSchedule ?? (async()=>{await scheduleClient?.close();}),
      readSeasonMembership:options.readSeasonMembership ?? ((season,signal)=>(scheduleClient??=new NativeScheduleClient()).readSeasonMembership(season,signal)),
      readHtml:options.readHtml ?? readHtml,
      parseListings:options.parseListings ?? parseListings,
      enrichObservation:options.enrichObservation ?? enrichObservation,
      compatiblePlayers:options.compatiblePlayers ?? compatiblePlayers,
      tvappPlayers:options.tvappPlayers ?? tvappPlayers,
      resolvePlayers:options.resolvePlayers ?? (options.compatiblePlayers||options.tvappPlayers?undefined:resolvePlayers),
      missingPlayerReason:options.missingPlayerReason ?? missingPlayerReason,
      probeCandidate:options.probeCandidate ?? configuredProbeCandidate,
      probeIdentity:options.probeIdentity ?? probeIdentity,
      persistableLocator:options.persistableLocator ?? persistableLocator,
      retryAfterMs:options.retryAfterMs ?? (error => error instanceof SourceFetchError || error instanceof PartialListingReadError ? error.retryAfterMs || 0 : 0),
      now:options.now ?? Date.now,
      id:options.id ?? randomUUID,
    },Object.keys(options));
  } catch(error) { void scheduleClient?.close(); store.close(); throw error; }
}
