import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createFinishedGameMatcher, createSourceEventMatcher, detailCandidateGameIds, mergeSchedulePartitions, normalizedName, type SourceEventEvidence } from '../domain/matching.ts';
import { listingEventEvidence,sourceCoverage } from '../source-registry.ts';
import { SESSION_LEASE_MS, compareCandidates, failedCandidate, nextCandidate, reconcileSession } from '../domain/lifecycle.ts';
import { roomSources, roomSourceInventory, sourceInventory } from '../domain/source-inventory.ts';
import { combatListingFeedEligible, feedCalendarDay, feedEligible, feedInventoryEligible, feedWindow } from '../domain/feed-eligibility.ts';
import { cachedFeedEligible, workingFeedMatches, workingFeedOwner, type WorkingFeed } from '../domain/working-feed.ts';
import {FEED_CHECK_RETENTION_MS,INCOMPLETE_RETRY_DELAYS,type FeedCheck} from '../domain/feed-check.ts';
import { persistableLocator } from '../../playback/persistent-locator.ts';
import verificationPolicy from '../../playback/verification-policy.json' with {type:'json'};
import { SOURCE_REFRESH_MS, ACTIVE_DISCOVERY_MS, COLLECTION_SETTLE_MS, discoveryDeadline, detailPolling, detailDeadline, detailIdentity, detailIdentityMatches, retryDeadline, sourceFailure } from '../domain/source-policy.ts';
import { playbackResolution } from '../domain/playback-resolution.ts';
import {browserCategoryDeadline,browserEventDeadline,browserObservation,browserPollingSignature,browserPublicationIdentity,retainedBrowserPublication,browserEvidenceFresh,type BrowserCatalog} from '../domain/browser-polling.ts';
import { provisionalLiveChannel, resolvedLiveChannelMatch } from '../domain/live-channel.ts';
import { catalogDecision, sameSportsurgeEvent, sanitizeSportsurgeCatalog, sportsurgeCandidates, sportsurgeEventCandidates, sportsurgeCatalogView, sportsurgeEventCandidate, sportsurgeEvidence, sportsurgeObservation } from '../domain/sportsurge-catalog.ts';
import { sameStreameastEvent, sanitizeStreameastCatalog, streameastDecision, streameastObservation, streameastCandidates, streameastCatalogView, streameastEvidence } from '../domain/streameast-catalog.ts';
import type { Recovery } from '../domain/lifecycle.ts';
import { PartialListingReadError, type CandidateProbeResult, type FootballDependencies, type FootballRepository, type ScheduleProgress } from '../domain/ports.ts';
import { candidateSummary, isRaceGame, isWrestlingLeague, isMotorsportsLeague, type Board, type Candidate, type CandidateAvailability, type Command, type DetailEvidence, type Game, type MatchupGame, type LeagueFeedStatus, type Observation, type Reply, type Session, type SourceEventBinding, type RoomSourcesSnapshot, type SourcesSnapshot, type StreameastCatalog, type SportsurgeCatalog, type VerificationTarget } from '../shared.ts';

type RecoveryPhase = {kind:'cycling'} | {kind:'exhausted';until:number;knownIds:string[]};
type FeedOwner = WorkingFeed['owner'];
type SelectionOwner = {key:string;owner:FeedOwner};
type OwnedSession = {value:Session;lastSeen:number;recovery:Recovery;refreshes:number;drainRefreshes:number;phase:RecoveryPhase;requestId?:string;lastEvidence?:{generation:number;at:number};selection?:SelectionOwner};
type ProbePhase = {kind:'queued';since:number}|{kind:'active';since:number};
type ProbeWork = {priority:'forced'|'unknown'|'retry'}|{priority:'recheck';expectedCheckedAt:number};
type ProbeJob = ProbeWork & {key:string;candidate:Candidate;owner:FeedOwner;controller:AbortController;revision:number;phase:ProbePhase;queuedAt:number;startedAt?:number;admittedDemand:boolean;admittedNear:boolean;incompleteAttempts:number;promise?:Promise<void>};
type TerminalRecord = (Extract<CandidateAvailability,{kind:'playable'}> & {owner:FeedOwner}) | Extract<CandidateAvailability,{kind:'unavailable'}>;
type TerminalHealth = TerminalRecord & {owner:FeedOwner};
type DeferredProbe={since:number;until:number;timer:ReturnType<typeof setTimeout>;candidate:Candidate;owner:FeedOwner;incompleteAttempts:number;phase:Extract<CandidateProbeResult,{kind:'deferred'}>['phase'];
  reason?:Extract<CandidateProbeResult,{kind:'deferred'}>['reason'];retryAfterMs?:number;timings?:Extract<CandidateProbeResult,{kind:'deferred'}>['timings']} &
  ({kind:'capacity'}|{kind:'incomplete'});
const PROBE_QUEUE_LIMIT=256;
const WORKING_FRESH_MS=30*60_000;
const WORKING_RECHECK_MS=25*60_000;
const FAILED_RETRY_MS=5*60_000;
const DETAIL_PUBLICATION_MAX_AGE_MS=ACTIVE_DISCOVERY_MS+30*60_000;
const PROBE_PRIORITY={forced:0,recheck:1,unknown:2,retry:3};
const DECODED_STARTUP_WINDOW_MS=10*60_000;
const LISTING_PARSER_VERSION=3;
function detailGeneration(observation:Observation):string {
  return JSON.stringify([observation.sourceId,observation.url,...(observation.teams&&observation.league!=='ufc'&&observation.league!=='boxing'&&!(observation.league!==null&&isWrestlingLeague(observation.league))?[]:[observation.title,observation.league]),observation.teams,observation.kickoff,observation.observedAt,observation.parserVersion]);
}
function matchesDetail(detail:DetailEvidence,observation:Observation):boolean {
  return 'identity' in detail&&detail.identity!==undefined?
    detailIdentityMatches(detail.identity,observation):detail.generation===detailGeneration(observation);
}
function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : 'request-failed').replace(/https?:\/\/\S+/g,'[url]').slice(0,120);
}
async function runBounded<T>(items: T[], group: (item:T) => string, globalLimit: number, perGroup: number, visit: (item:T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  const assigned = new Set<number>();
  const activeByGroup = new Map<string,number>();
  const errors: unknown[] = [];
  let active = 0;
  let finished = 0;
  await new Promise<void>(resolve => {
    const pump = () => {
      while (active < globalLimit) {
        const index = items.findIndex((item,i) => !assigned.has(i) && (activeByGroup.get(group(item)) || 0) < perGroup);
        if (index < 0) break;
        const item = items[index];
        const key = group(item);
        assigned.add(index);
        active++;
        activeByGroup.set(key,(activeByGroup.get(key) || 0) + 1);
        void Promise.resolve().then(() => visit(item)).catch(error => errors.push(error)).finally(() => {
          active--;
          finished++;
          activeByGroup.set(key,(activeByGroup.get(key) || 1) - 1);
          pump();
        });
      }
      if (finished === items.length) resolve();
    };
    pump();
  });
  if (errors.length) throw errors[0];
}
export class FootballCoordinator {
  private store: FootballRepository;
  private controller = new AbortController();
  private games: Game[] = [];
  private finished=createFinishedGameMatcher(this.games);
  private inventoryMatch=createSourceEventMatcher(this.games,'inventory-live');
  private finalDeadlines = new Map<string,number>();
  private cleanedFinals = new Set<string>();
  private candidates = new Map<string,Candidate[]>();
  private sessions = new Map<string,OwnedSession>();
  private verificationSessions=new Map<string,{target:VerificationTarget;job:ProbeJob;deadline:number}>();
  private errors = new Map<string,string>();
  private revision = 0;
  private refreshing: Promise<void> | undefined;
  private queuedRefresh: Promise<void> | undefined;
  private schedulePublication: ReturnType<typeof setImmediate> | undefined;
  private scheduleDiscoveryForce = false;
  private schedulePublicationSources = new Set<string>();
  private discoveryLaunch: ReturnType<typeof setImmediate> | undefined;
  private discovering: Promise<void> | undefined;
  private lastDiscovery = 0;
  private hostCooldowns = new Map<string,number>();
  private pendingListings = new Map<string,string>();
  private lastSchedule = 0;
  private scheduleState: Board['scheduleState'] = 'loading';
  private stopped = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private sourceTimes = new Map<string,number>();
  private lastStoreSweep = 0;
  private detailCursor = 0;
  private detailWork:Promise<void>|undefined;
  private detailControllers=new Map<Observation,AbortController>();
  private wakeDetails:(()=>void)|undefined;
  private detailRevision=0;
  private candidatePublication:{kind:'details'|'all';timer:ReturnType<typeof setImmediate>}|undefined;
  private resolutionPending=false;
  private detailCandidateIds=new Set<string>();
  private inventoryCache: {at:number;day:number|null;revision:number;probeLimit:number;gameIds:Set<string>;freshGameIds:Set<string>;proofExpiresAt:number;snapshot:SourcesSnapshot|RoomSourcesSnapshot} | undefined;
  private terminalByGame = new Map<string,Map<string,TerminalHealth>>();
  private workingFeeds=new Map<string,WorkingFeed>();
  private restoredChecks=new Map<string,FeedCheck>();
  private refreshedSchedules=new Set<string>();
  private healthRevision=new Map<string,number>();
  private decoded=new Map<string,{at:number;startupMs:number}>();
  private probeQueue:ProbeJob[]=[];
  private activeProbes=new Map<string,ProbeJob>();
  private deferredProbes=new Map<string,DeferredProbe>();
  private completedChecks=0;
  private recentChecks:NonNullable<SourcesSnapshot['checks']>['recent']=[];
  private forcedRetries=new Set<string>();
  private promotedProbes=new Map<string,number>();
  private forcedDetailDiscovery=new Set<string>();
  private publicationDeadlines=new Map<string,number>();
  private discoveryDeadlines:{revision:number;games:readonly Game[];at:number;values:Map<string,{at:number;until:number;exact:boolean}>}|undefined;
  private checkTargets=new Map<string,number>();
  private probeAdmissions=0;
  private urgentAdmissions=0;
  private unknownAdmissions=0;
  private protectedBackgroundKey:string|undefined;
  private probePump:ReturnType<typeof setImmediate>|undefined;
  private probeReplan:ReturnType<typeof setImmediate>|undefined;
  private readonly probeKeys=new WeakMap<Candidate,string>();
  private backgroundCursor=0;
  private readonly now: () => number;
  private readonly browserCollectorsAvailable:boolean;
  private readonly schedules: FootballDependencies['schedules'];
  private readonly sources: FootballDependencies['sources'];
  private readonly fetchSchedule: FootballDependencies['readSchedule'];
  private readonly closeSchedule: FootballDependencies['closeSchedule'];
  private readonly fetchMembership: FootballDependencies['readSeasonMembership'];
  private readonly fetchHtml: FootballDependencies['readHtml'];
  private readonly parseListings: FootballDependencies['parseListings'];
  private readonly enrichObservation: FootballDependencies['enrichObservation'];
  private readonly resolvePlayers: NonNullable<FootballDependencies['resolvePlayers']>;
  private readonly missingPlayerReason: FootballDependencies['missingPlayerReason'];
  private readonly probeCandidate: FootballDependencies['probeCandidate'];
  private readonly probeConcurrency:number;
  private readonly probeIdentity: NonNullable<FootballDependencies['probeIdentity']>;
  private readonly persistableLocator: NonNullable<FootballDependencies['persistableLocator']>;
  private readonly retryAfterMs: FootballDependencies['retryAfterMs'];
  private readonly id: () => string;
  constructor(dependencies: FootballDependencies) {
    this.now = dependencies.now;
    this.browserCollectorsAvailable=dependencies.browserCollectorsAvailable===true;
    this.schedules = dependencies.schedules;
    this.sources = dependencies.sources;
    this.fetchSchedule = dependencies.readSchedule;
    this.closeSchedule = dependencies.closeSchedule;
    this.fetchMembership = dependencies.readSeasonMembership;
    this.fetchHtml = dependencies.readHtml;
    this.parseListings = dependencies.parseListings;
    this.enrichObservation = dependencies.enrichObservation;
    this.resolvePlayers=dependencies.resolvePlayers??((gameId,observation,html,signal)=>
      ['tvapp','tvapp-nba','tvapp-nhl','tvapp-mlb'].includes(observation.sourceId)&&dependencies.tvappPlayers?
        dependencies.tvappPlayers(gameId,observation,html,signal):
        Promise.resolve(dependencies.compatiblePlayers?.(gameId,observation,html)??[]));
    this.missingPlayerReason = dependencies.missingPlayerReason;
    this.probeCandidate = dependencies.probeCandidate;
    this.probeConcurrency=dependencies.probeCandidate.concurrency??2;
    if(!Number.isSafeInteger(this.probeConcurrency)||this.probeConcurrency<1)
      throw new Error('Invalid playback verification concurrency');
    this.probeIdentity = dependencies.probeIdentity ?? (locator => JSON.stringify(locator));
    this.persistableLocator = dependencies.persistableLocator ?? persistableLocator;
    this.retryAfterMs = dependencies.retryAfterMs;
    this.id = dependencies.id;
    this.store = dependencies.store;
    for(const check of this.store.feedChecks(this.now()))this.restoredChecks.set(check.identityHash,check);
    for(const feed of this.store.workingFeeds())this.workingFeeds.set(this.workingKey(feed.candidate),feed);
    this.rebuild();
  }
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => { this.sweep(); this.checkSources([],false); void this.refresh(); },15000);
    void this.refresh();
  }
  private observationDeadline(observation:Observation):number|undefined {
    return this.deadlineFor(observation,this.collectionDeadlines());
  }
  private deadlineFor(observation:Observation,deadlines:Map<string,{at:number;until:number;exact:boolean}>):number|undefined {
    const row=deadlines.get(`${observation.sourceId}:${observation.league}`)??deadlines.get(observation.sourceId);
    return row&&(row.exact?row.at===observation.observedAt:observation.observedAt>=row.at)?row.until:undefined;
  }
  private collectionDeadlines(input?:Pick<Parameters<typeof sourceInventory>[0],'at'|'attempts'|'observations'|'sportsurgeCatalog'|'streameastCatalog'>):Map<string,{at:number;until:number;exact:boolean}> {
    const now=input?.at??this.now(),cache=this.discoveryDeadlines;
    if(!input&&cache&&cache.revision===this.revision&&cache.games===this.games&&now-cache.at<1000&&now>=cache.at)return cache.values;
    const values=new Map<string,{at:number;until:number;exact:boolean}>();
    const attempts=input?.attempts??this.store.sourceAttempts(),observations=new Map<string,Observation[]>();
    for(const observation of input?.observations??this.store.observations()) {
      const rows=observations.get(observation.sourceId)??[];rows.push(observation);observations.set(observation.sourceId,rows);
    }
    const fallback=[...new Set(this.games.map(game=>game.league))];
    const discoveryGames=this.games.filter(game=>feedEligible(game,now));
    for(const source of this.sources) {
      if(source.kind==='browser-catalog')continue;
      const attempt=attempts[source.id];
      if(!attempt||(attempt.outcome!=='parsed'&&attempt.outcome!=='empty'))continue;
      const until=discoveryDeadline(attempt.at,(observations.get(source.id)??[]).filter(row=>row.observedAt>=attempt.at),discoveryGames,source.leagues??fallback,now);
      values.set(source.id,{at:attempt.at,until:until+COLLECTION_SETTLE_MS,exact:false});
    }
    for(const [sourceId,history] of [['sportsurge-v2',input?.sportsurgeCatalog??this.store.sportsurgeCatalog()],['streameast',input?.streameastCatalog??this.store.streameastCatalog()]] as const) {
      for(const league of sourceCoverage(sourceId))for(const stored of [history.current,history.previous,history.lastComplete]) {
        const category=stored?.catalog.categories[league];
        if(!category||category.kind==='pending')continue;
        if(category.kind==='collected'&&stored)values.set(`${sourceId}:${league}`,{at:category.at,until:browserCategoryDeadline(stored.catalog,league,this.games,now)+COLLECTION_SETTLE_MS,exact:true});
        break;
      }
    }
    this.discoveryDeadlines={revision:this.revision,games:this.games,at:now,values};
    return values;
  }
  private eventMatcher(games:readonly Game[],mode:'current'|'inventory-live'='current') {
    const deadlines=this.collectionDeadlines();
    return createSourceEventMatcher(games,mode,observation=>this.deadlineFor(observation,deadlines));
  }
  private rebuild(): void {
    this.publicationDeadlines.clear();
    const finals = this.store.finals();
    const previous = new Map(finals.map(game => [game.id,game]));
    this.finalDeadlines = new Map(finals.flatMap(game => game.graceEndsAt === undefined ? [] : [[game.id,game.graceEndsAt]]));
    const now = this.now();
    const partitions = this.schedules.map(source => {
      const partition = this.store.partition(source.id);
      return { partition, current: !!partition && !this.errors.has(source.id) && now-partition.at<=90_000 };
    }).sort((left,right) => Number(right.current)-Number(left.current) || (right.partition?.at ?? 0)-(left.partition?.at ?? 0))
      .map(({partition}) => partition?.games || []);
    const scheduled=mergeSchedulePartitions(partitions);
    const present=new Set(scheduled.map(game=>game.id));
    const memberships=new Map<number,ReturnType<typeof this.store.membership>>();
    this.games = [...scheduled,...finals.filter(game=>!present.has(game.id)&&game.graceEndsAt!==undefined&&this.now()<game.graceEndsAt)].map(game => {
      const final = previous.get(game.id);
      const current = final ? {...final,partitions:game.partitions} : game;
      if (isRaceGame(current) || current.league !== 'ncaaf' || !current.season) return current;
      if(!memberships.has(current.season))memberships.set(current.season,this.store.membership(current.season));
      const membership = memberships.get(current.season);
      if (!membership) return current;
      const team = (value:MatchupGame['home']):MatchupGame['home'] => {
        const id = value.id?.replace(/^espn:ncaaf:/,'');
        const subdivision = id ? membership.teams[id] : undefined;
        return subdivision ? {...value,membership:{subdivision,season:membership.season,observedAt:membership.at,source:'espn-core'}} : value;
      };
      return {...current,home:team(current.home),away:team(current.away)};
    });
    this.finished=createFinishedGameMatcher(this.games);
    this.inventoryMatch=createSourceEventMatcher(this.games,'inventory-live');
    for(const [gameId,health] of this.terminalByGame) {
      const game=this.games.find(row=>row.id===gameId);
      if(!this.feedGame(game))continue;
      for(const [key,value] of health)if(!workingFeedMatches({candidate:{gameId},owner:value.owner},game)) {
        health.delete(key);
        const identityHash=createHash('sha256').update(key).digest('hex');
        this.store.removeFeedCheck(gameId,identityHash);
        this.restoredChecks.delete(identityHash);
        this.healthRevision.set(key,(this.healthRevision.get(key)||0)+1);
        this.decoded.delete(key);
      }
    }
    this.restoreWorkingFeeds();
    const match=this.eventMatcher(this.games);
    const catalogEvidence=new Map<string,SourceEventEvidence>();
    const surge=this.store.sportsurgeCatalog();
    for(const stored of [surge.current,surge.previous,surge.lastComplete])for(const event of stored?.catalog.events||[]) {
      const id=`sportsurge-v2:${event.url}`;
      if(!catalogEvidence.has(id))catalogEvidence.set(id,sportsurgeEvidence(event,this.now()));
    }
    const east=this.store.streameastCatalog();
    for(const stored of [east.current,east.previous,east.lastComplete])for(const event of stored?.catalog.events||[]) {
      const id=`streameast:${event.url}`;
      if(!catalogEvidence.has(id))catalogEvidence.set(id,streameastEvidence(event));
    }
    for (const observation of this.store.observations())
      this.store.observe(observation,match(observation,
        catalogEvidence.get(observation.id)||listingEventEvidence(observation.sourceId),this.now()).match);
    this.projectCandidates();
    this.reconcileProbeJobs();
    this.checkSources([],false);
    this.revision++;
  }
  private publishSchedule(sourceId: string, force: boolean): void {
    this.schedulePublicationSources.add(sourceId);
    this.scheduleDiscoveryForce ||= force;
    this.schedulePublication ??= setImmediate(() => {
      try { this.flushSchedulePublication(); }
      catch { this.revision++; }
    });
  }
  private flushSchedulePublication(): void {
    if (!this.schedulePublication) return;
    clearImmediate(this.schedulePublication);
    this.schedulePublication=undefined;
    const force=this.scheduleDiscoveryForce;
    this.scheduleDiscoveryForce=false;
    const sources=this.schedulePublicationSources;
    this.schedulePublicationSources=new Set<string>();
    if (this.stopped) return;
    try {
      this.rebuild();
      this.requestDiscovery(this.now(),force);
      this.requestResolution();
    } catch(error) {
      for(const sourceId of sources)this.errors.set(sourceId,errorCode(error));
      throw error;
    }
  }
  private requestDiscovery(now: number, explicit=false): void {
    clearImmediate(this.discoveryLaunch);
    this.discoveryLaunch=undefined;
    if (this.stopped || this.discovering || !explicit&&now - this.lastDiscovery < 30_000) return;
    this.lastDiscovery = now;
    this.discovering = this.discover(explicit).catch(error => {
      if (!this.stopped) this.errors.set('discovery',errorCode(error));
    }).finally(() => { this.discovering=undefined; this.requestResolution(); });
  }
  private deferDiscovery(now: number, force: boolean): void {
    if (this.discoveryLaunch) return;
    this.discoveryLaunch=setImmediate(() => {
      this.discoveryLaunch=setImmediate(() => {
        this.discoveryLaunch=undefined;
        this.requestDiscovery(now,force);
      });
    });
  }
  async refresh(force = false): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      if (!force) return this.refreshing;
      this.queuedRefresh ??= this.refreshing.then(() => this.refresh(true)).finally(() => { this.queuedRefresh=undefined; });
      return this.queuedRefresh;
    }
    const now = this.now();
    if (!force && now - this.lastSchedule < 30000) {
      this.sweep();
      this.checkSources([],false);
      this.requestResolution();
      return;
    }
    this.lastSchedule = now;
    this.deferDiscovery(now,force);
    this.refreshing = (async () => {
      await Promise.all(this.schedules.map(async source => {
        try {
          let projectedCoverage = this.refreshedSchedules.has(source.id);
          this.refreshedSchedules.delete(source.id);
          const accept = (result: ScheduleProgress, settled = false) => {
            if (this.stopped) return;
            const previous = this.store.partition(source.id);
            const acceptedAt = this.now();
            const wasFresh = previous && !this.errors.has(source.id) && acceptedAt-previous.at<=90000;
            const historyDay=new Date(now-24*3600_000).toISOString().slice(0,10);
            const games=result.history&&previous?
              [...new Map([...previous.games.filter(game=>game.date?.slice(0,10)===historyDay||
                game.lifecycle==='live'&&feedEligible(game,acceptedAt)),...result.games]
                .map(game=>[game.id,game] as const)).values()]:result.games;
            this.store.savePartition(source.id,{...result,games,at:acceptedAt});
            const accepted = this.store.partition(source.id);
            this.errors.delete(source.id);
            if(result.history) {
              this.refreshedSchedules.delete(source.id);
              if(result.history.kind==='failed')this.errors.set(`${source.id}-history`,`${result.history.day}:${result.history.reason}`.slice(0,120));
            } else this.errors.delete(`${source.id}-history`);
            if(result.games.length || previous?.games.length || this.workingFeeds.size) {
              let published = false;
              if(!wasFresh || feedCalendarDay(previous.at)!==feedCalendarDay(acceptedAt) ||
                (settled||result.history?.kind==='failed')&&projectedCoverage!==this.refreshedSchedules.has(source.id) ||
                !isDeepStrictEqual(previous.games,accepted?.games)) {
                this.publishSchedule(source.id,force);
                published = true;
              }
              else {
                if (!this.schedulePublication) {
                  this.reconcileProbeJobs();
                  this.checkSources([],false);
                  this.revision++;
                }
              }
              if (!this.schedulePublication) {
                this.requestDiscovery(now,force);
                this.requestResolution();
              }
              if(published||settled||result.history)projectedCoverage=this.refreshedSchedules.has(source.id);
            } else this.revision++;
          };
          const result = await this.fetchSchedule(source,now,this.controller.signal,accept);
          if(this.stopped)return;
          if(result.horizonErrors?.length||result.history)this.refreshedSchedules.delete(source.id);
          else this.refreshedSchedules.add(source.id);
          accept(result,true);
          if(result.horizonErrors?.length)this.errors.set(`${source.id}-horizon`,result.horizonErrors.join('; ').slice(0,240));
          else this.errors.delete(`${source.id}-horizon`);
        } catch(error) {
          if (!this.stopped) {
            const alreadyFailed=this.errors.has(source.id);
            this.refreshedSchedules.delete(source.id);
            this.errors.set(source.id,errorCode(error));
            if(!alreadyFailed&&this.store.partition(source.id)?.games.length)this.publishSchedule(source.id,force);
          }
        }
      }));
      if (this.stopped) return;
      this.flushSchedulePublication();
      this.scheduleState='ready';
      this.checkSources([],false);
      this.requestResolution();
      const seasons = [...new Set(this.schedules.filter(source => source.league==='ncaaf').flatMap(source => this.store.partition(source.id)?.games.flatMap(game => 'season' in game&&typeof game.season==='number'?[game.season]:[]) || []))];
      let membershipChanged=false;
      await Promise.all(seasons.map(async season => {
        const cached = this.store.membership(season);
        if (cached && this.now()-cached.at<24*3600000 &&
          (!this.schedules.some(source=>source.id==='d2-d3') || Object.values(cached.teams).includes('d2-d3'))) return;
        try {
          const membership = await this.fetchMembership(season,this.controller.signal);
          if (!this.stopped) { this.store.saveMembership(membership); this.errors.delete(`membership-${season}`); membershipChanged=true; }
        } catch(error) { if (!this.stopped) this.errors.set(`membership-${season}`,errorCode(error)); }
      }));
      if (this.stopped) return;
      if(membershipChanged)this.rebuild();
      this.sweep();
      this.requestDiscovery(now,force);
    })().finally(() => { this.refreshing=undefined;this.revision++; });
    return this.refreshing;
  }
  private scheduleFresh(game: Game, freshness?:Map<string,boolean>): boolean {
    const keys = game.partitions?.length ? game.partitions : game.league === 'nfl' ? ['nfl'] : game.league === 'nba' || game.league === 'wnba' || game.league === 'nhl' || game.league === 'mlb' ? [game.league] : [];
    return keys.some(key => {
      const cached=freshness?.get(key);
      if(cached!==undefined)return cached;
      const fresh=!this.errors.has(key)&&this.now()-(this.store.partition(key)?.at||0)<=90000;
      freshness?.set(key,fresh);
      return fresh;
    });
  }
  private probeKey(candidate:Candidate):string {
    const existing=this.probeKeys.get(candidate);
    if(existing!==undefined)return existing;
    const key=JSON.stringify([candidate.gameId,this.probeIdentity(candidate.locator)]);
    this.probeKeys.set(candidate,key);
    return key;
  }
  private feedGame(game:Game|undefined,freshness?:Map<string,boolean>):game is Game {
    return !!game&&this.scheduleFresh(game,freshness)&&(feedEligible(game,this.now())||combatListingFeedEligible(game,this.now()));
  }
  private observationFeedEligible(observation:Observation):boolean {
    const result=this.inventoryMatch(observation,listingEventEvidence(observation.sourceId),this.now()).match;
    const ids=detailCandidateGameIds(result);
    return ids.some(id=>this.feedGame(this.games.find(game=>game.id===id)));
  }
  private observationCollectionEligible(observation:Observation):boolean {
    const result=this.inventoryMatch(observation,listingEventEvidence(observation.sourceId),this.now()).match;
    return detailCandidateGameIds(result).some(id=>{
      const game=this.games.find(game=>game.id===id);
      return !!game&&(feedEligible(game,this.now())||combatListingFeedEligible(game,this.now()));
    });
  }
  private terminal(candidate:Candidate):TerminalHealth|undefined {
    return this.terminalByGame.get(candidate.gameId)?.get(this.probeKey(candidate));
  }
  private gameOwner(game:Game):FeedOwner {
    return workingFeedOwner(game,game.partitions?.length?game.partitions:
      this.schedules.filter(source=>source.league===game.league).map(source=>source.id));
  }
  private ownedCandidate(candidate:Candidate,owner:FeedOwner):boolean {
    const game=this.games.find(row=>row.id===candidate.gameId);
    return !!game&&workingFeedMatches({candidate,owner},game)&&
      candidate.sourceIds.some(id=>this.sources.some(source=>source.id===id))&&
      (candidate.locator.provider!=='event-page'&&candidate.locator.provider!=='tvapp'&&candidate.locator.provider!=='catalog-stream'&&
        candidate.locator.provider!=='streameast-server'||candidate.locator.gameId===game.id);
  }
  private selectionOwner(candidate:Candidate):SelectionOwner|undefined {
    const health=this.terminal(candidate);
    return health?.kind==='playable'?{key:this.probeKey(candidate),owner:health.owner}:undefined;
  }
  private currentSelection(candidate:Candidate,selection:SelectionOwner|undefined):boolean {
    return !!selection&&selection.key===this.probeKey(candidate)&&this.ownedCandidate(candidate,selection.owner);
  }
  private workingKey(candidate:Candidate):string {
    return JSON.stringify([candidate.gameId,candidate.id]);
  }
  private identityHash(candidate:Candidate):string {
    return createHash('sha256').update(this.probeKey(candidate)).digest('hex');
  }
  private replaceWorkingIdentity(gameId:string,identityHash:string,feeds:WorkingFeed[]):void {
    this.store.replaceWorkingIdentity(gameId,identityHash,feeds);
    for(const [key,feed] of this.workingFeeds)
      if(feed.candidate.gameId===gameId&&feed.identityHash===identityHash)this.workingFeeds.delete(key);
    for(const feed of feeds)this.workingFeeds.set(this.workingKey(feed.candidate),feed);
  }
  private persistWorkingIdentity(candidate:Candidate):void {
    try {
      const health=this.terminal(candidate),game=this.games.find(game=>game.id===candidate.gameId);
      if(health?.kind!=='playable'||!this.feedGame(game))return;
      const identityHash=this.identityHash(candidate);
      const saved=[...this.workingFeeds.values()].filter(feed=>feed.candidate.gameId===game.id&&feed.identityHash===identityHash);
      const owner=health.owner;
      const aliases=new Map([...saved.map(feed=>feed.candidate),...(this.candidates.get(game.id)||[])
        .filter(row=>this.probeKey(row)===this.probeKey(candidate))].map(row=>[row.id,row]));
      const feeds=[...aliases.values()].flatMap(row=>{
        const sourceIds=row.sourceIds.filter(id=>this.sources.some(source=>source.id===id));
        if(!sourceIds.length||!this.persistableLocator(row.locator)||
          (row.locator.provider==='event-page'||row.locator.provider==='tvapp'||row.locator.provider==='catalog-stream'||
            row.locator.provider==='streameast-server')&&row.locator.gameId!==game.id)return [];
        const feed:WorkingFeed={version:2,identityHash,candidate:{...row,sourceIds},owner,checkedAt:health.checkedAt,proof:health.proof};
        return workingFeedMatches(feed,game)?[feed]:[];
      });
      if(feeds.length||saved.length)this.replaceWorkingIdentity(game.id,identityHash,feeds);
      this.errors.delete('working-feed-cache');
    } catch(error) {this.errors.set('working-feed-cache',errorCode(error));}
  }
  private restoreWorkingFeeds():void {
    if(!this.workingFeeds.size)return;
    const surge=this.store.sportsurgeCatalog().current;
    const surgeAssignments=surge?sportsurgeCatalogView(surge,this.games,this.now()).games:[];
    const east=this.store.streameastCatalog();
    const eastAssignments=east.current?streameastCatalogView(east.current,this.games,this.now()).games:[];
    const eastEvents=[east.current,east.previous,east.lastComplete].flatMap(value=>value?.catalog.events||[]);
    const reassigned=(candidate:Candidate):boolean=>{
      if(surge&&candidate.locator.provider==='sportsurge-v2')return surge.catalog.events.some(event=>
        surge.catalog.categories[event.league].kind==='collected'&&sportsurgeEventCandidate(candidate,event)&&
        surgeAssignments.some(row=>row.id===event.id&&row.url===event.url&&row.gameId!==null&&row.gameId!==candidate.gameId));
      if(!east.current||!candidate.sourceIds.includes('streameast'))return false;
      return east.current.catalog.events.some(event=>{
        if(east.current?.catalog.categories[event.league].kind!=='collected')return false;
        const gameId=eastAssignments.find(row=>row.id===event.id&&row.url===event.url)?.gameId;
        return !!gameId&&gameId!==candidate.gameId&&eastEvents.some(prior=>
          prior.id===event.id&&prior.url===event.url&&streameastCandidates(prior,candidate.gameId).some(row=>
            row.id===candidate.id&&JSON.stringify(row.locator)===JSON.stringify(candidate.locator)));
      });
    };
    const groups=new Map<string,WorkingFeed[]>();
    for(const feed of this.workingFeeds.values()) {
      const key=JSON.stringify([feed.candidate.gameId,feed.identityHash]);
      groups.set(key,[...(groups.get(key)||[]),feed]);
    }
    for(const rows of groups.values()) {
      const first=rows[0],game=this.games.find(game=>game.id===first.candidate.gameId);
      const leagueSources=this.schedules.filter(source=>source.league===first.owner.league);
      const absent=!game&&leagueSources.every(source=>this.refreshedSchedules.has(source.id)&&!this.errors.has(source.id)&&
        this.now()-(this.store.partition(source.id)?.at||0)<=90_000);
      const finished=(this.finalDeadlines.get(first.candidate.gameId)??game?.graceEndsAt??Infinity)<=this.now();
      const feeds=absent||finished?[]:rows.flatMap(feed=>{
        const sourceIds=feed.candidate.sourceIds.filter(id=>this.sources.some(source=>source.id===id));
        return (!game||game.lifecycle!=='final'&&!this.scheduleFresh(game)||workingFeedMatches(feed,game))&&
          !reassigned(feed.candidate)&&sourceIds.length&&this.persistableLocator(feed.candidate.locator)&&this.identityHash(feed.candidate)===feed.identityHash&&
          feed.checkedAt<=this.now()+60_000&&feed.candidate.observedAt<=this.now()+60_000&&
          (feed.candidate.locator.provider!=='event-page'&&feed.candidate.locator.provider!=='tvapp'&&feed.candidate.locator.provider!=='catalog-stream'&&
            feed.candidate.locator.provider!=='streameast-server'||
            feed.candidate.locator.gameId===feed.candidate.gameId)?
          [{...feed,candidate:{...feed.candidate,sourceIds}}]:[];
      });
      if(JSON.stringify(feeds)!==JSON.stringify(rows))this.replaceWorkingIdentity(first.candidate.gameId,first.identityHash,feeds);
      if(!feeds.length) {
        const key=this.probeKey(first.candidate);
        const terminal=this.terminal(first.candidate);
        if(terminal?.kind==='playable'&&terminal.checkedAt<=first.checkedAt&&
          JSON.stringify(terminal.owner)===JSON.stringify(first.owner))this.terminalByGame.get(first.candidate.gameId)?.delete(key);
        const candidates=this.candidates.get(first.candidate.gameId)||[];
        if(this.terminal(first.candidate)?.kind!=='playable')
          this.candidates.set(first.candidate.gameId,candidates.filter(candidate=>this.identityHash(candidate)!==first.identityHash));
        continue;
      }
      if(!game)continue;
      for(const feed of feeds) {
        if(!this.feedGame(game)&&!cachedFeedEligible(feed,game,this.now()))continue;
        const terminal=this.terminal(feed.candidate);
        if(terminal?.kind==='unavailable')continue;
        const health=this.terminalByGame.get(game.id)||new Map<string,TerminalHealth>();
        if(feed.version===2&&this.now()-feed.checkedAt<WORKING_FRESH_MS&&(!terminal||terminal.checkedAt<feed.checkedAt))
          health.set(this.probeKey(feed.candidate),{kind:'playable',checkedAt:feed.checkedAt,proof:feed.proof,owner:feed.owner});
        this.terminalByGame.set(game.id,health);
        const candidates=this.candidates.get(game.id)||[];
        const current=candidates.find(candidate=>candidate.id===feed.candidate.id);
        if(!current)candidates.push(feed.candidate);
        else if(JSON.stringify(current.locator)!==JSON.stringify(feed.candidate.locator)) {
          const id=feed.candidate.id+':'+createHash('sha256').update(JSON.stringify(feed.candidate.locator)).digest('hex').slice(0,12);
          feed.candidate={...feed.candidate,id};
          if(!candidates.some(candidate=>candidate.id===id))candidates.push(feed.candidate);
        }
        this.candidates.set(game.id,candidates);
      }
      if(JSON.stringify(feeds)!==JSON.stringify(rows))this.replaceWorkingIdentity(first.candidate.gameId,first.identityHash,feeds);
    }
  }
  private retainedPlayable(candidate:Candidate):boolean {
    const health=this.terminal(candidate);
    const game=this.games.find(game=>game.id===candidate.gameId);
    return health?.kind==='playable'&&!!game&&this.ownedCandidate(candidate,health.owner)&&
      (this.feedGame(game)||cachedFeedEligible({candidate,owner:health.owner},game,this.now()))&&
      candidate.observedAt<=this.now()+60_000&&health.checkedAt<=this.now()+60_000;
  }
  private freshPlayable(candidate:Candidate):boolean {
    const health=this.terminal(candidate);
    return this.retainedPlayable(candidate)&&health?.kind==='playable'&&
      this.now()-health.checkedAt<WORKING_FRESH_MS;
  }
  private retainedWorkingCandidate(candidate:Candidate):boolean {
    const feed=this.workingFeeds.get(this.workingKey(candidate));
    const game=this.games.find(game=>game.id===candidate.gameId);
    return !!feed&&!!game&&this.identityHash(candidate)===feed.identityHash&&
      this.ownedCandidate(candidate,feed.owner)&&workingFeedMatches(feed,game)&&
      (this.feedGame(game)||cachedFeedEligible(feed,game,this.now()));
  }
  private persistFeedCheck(candidate:Candidate,outcome:FeedCheck['outcome'],owner:FeedOwner):void {
    const game=this.games.find(game=>game.id===candidate.gameId);
    if(!game||!this.ownedCandidate(candidate,owner))return;
    const identityHash=this.identityHash(candidate);
    try{
      this.store.saveFeedCheck({version:1,gameId:game.id,gameDate:game.date??null,identityHash,owner,outcome});
      this.restoredChecks.delete(identityHash);
      if(outcome.kind==='unavailable')for(const [key,feed] of this.workingFeeds)
        if(feed.candidate.gameId===game.id&&feed.identityHash===identityHash)this.workingFeeds.delete(key);
      this.errors.delete('feed-check-cache');
    }catch(error){this.errors.set('feed-check-cache',errorCode(error));}
  }
  private restoreFeedChecks():void {
    if(!this.restoredChecks.size)return;
    for(const game of this.games){
      if(!this.feedGame(game))continue;
      for(const candidate of this.candidates.get(game.id)||[]){
        const identityHash=this.identityHash(candidate),saved=this.restoredChecks.get(identityHash);
        if(!saved||!this.currentCandidate(candidate))continue;
        const key=this.probeKey(candidate),outcome=saved.outcome;
        if(this.activeProbes.has(key)||this.probeQueue.some(job=>job.key===key))continue;
        this.restoredChecks.delete(identityHash);
        const health=this.terminal(candidate);
        if(this.now()-outcome.checkedAt>=FEED_CHECK_RETENTION_MS||saved.gameDate!==(game.date??null)||
          !this.ownedCandidate(candidate,saved.owner)||health&&health.checkedAt>outcome.checkedAt){
          this.store.removeFeedCheck(saved.gameId,identityHash);continue;
        }
        if(outcome.kind==='unavailable'&&health?.kind==='playable'){
          this.terminalByGame.get(game.id)?.delete(key);
          this.replaceWorkingIdentity(game.id,identityHash,[]);
        }
        if(outcome.kind==='unavailable'){
          const rows=this.terminalByGame.get(game.id)??new Map<string,TerminalHealth>();
          rows.set(key,{...outcome,owner:saved.owner});this.terminalByGame.set(game.id,rows);
        }else{
          const timer=setTimeout(()=>{if(!this.stopped)this.scheduleProbeReplan();},Math.max(0,outcome.retryAt-this.now()));
          this.deferredProbes.set(key,{kind:'incomplete',candidate,owner:saved.owner,timer,
            since:outcome.checkedAt,until:outcome.retryAt,incompleteAttempts:outcome.incompleteAttempts,
            phase:outcome.phase,reason:outcome.reason,retryAfterMs:outcome.retryAt-outcome.checkedAt,
            ...(outcome.timings?{timings:outcome.timings}:{})});
        }
      }
    }
  }
  private recordTerminal(candidate:Candidate,value:TerminalRecord,owner?:FeedOwner):void {
    const game=this.games.find(game=>game.id===candidate.gameId);
    if(!game)return;
    const rows=this.terminalByGame.get(candidate.gameId)||new Map<string,TerminalHealth>();
    if(value.kind==='unavailable'&&(value.reason==='playback'||rows.get(this.probeKey(candidate))?.kind==='playable'))
      this.rediscoverGame(candidate.gameId,candidate.sourceIds);
    rows.set(this.probeKey(candidate),{...value,owner:owner??(value.kind==='playable'?value.owner:this.gameOwner(game))});
    this.terminalByGame.set(candidate.gameId,rows);
    if(value.kind==='playable'){
      this.restoredChecks.delete(this.identityHash(candidate));
      this.persistWorkingIdentity(candidate);
      try{
        this.store.removeFeedCheck(candidate.gameId,this.identityHash(candidate));
        this.errors.delete('feed-check-cache');
      }catch(error){this.errors.set('feed-check-cache',errorCode(error));}
    }
    else try {
      this.persistFeedCheck(candidate,value,owner??this.gameOwner(game));
      this.replaceWorkingIdentity(candidate.gameId,this.identityHash(candidate),[]);
      this.errors.delete('working-feed-cache');
    } catch(error) {this.errors.set('working-feed-cache',errorCode(error));}
  }
  private rediscoverGame(gameId:string,sourceIds?:readonly string[]):void {
    const match=this.eventMatcher(this.games);
    for(const observation of this.store.observations()) {
      if(sourceIds&&!sourceIds.includes(observation.sourceId))continue;
      const result=match(observation,listingEventEvidence(observation.sourceId),this.now()).match;
      if(detailCandidateGameIds(result).includes(gameId))this.forcedDetailDiscovery.add(observation.id);
    }
    this.requestResolution();
  }
  private retireReassignedCandidates(candidates:Candidate[]):void {
    const identities=new Map(candidates.map(candidate=>[this.probeKey(candidate),candidate]));
    if(!identities.size)return;
    for(const [gameId,rows] of this.candidates)
      this.candidates.set(gameId,rows.filter(candidate=>!identities.has(this.probeKey(candidate))));
    for(const [key,candidate] of identities) {
      this.store.removeFeedCheck(candidate.gameId,this.identityHash(candidate));
      this.restoredChecks.delete(this.identityHash(candidate));
      this.terminalByGame.get(candidate.gameId)?.delete(key);
      this.healthRevision.set(key,(this.healthRevision.get(key)||0)+1);
      this.decoded.delete(key);
      this.probeQueue=this.probeQueue.filter(job=>job.key!==key);
      this.activeProbes.get(key)?.controller.abort();
      const deferred=this.deferredProbes.get(key);
      if(deferred){clearTimeout(deferred.timer);this.deferredProbes.delete(key);}
      for(const owned of this.sessions.values())if(owned.value.gameId===candidate.gameId&&owned.selection?.key===key)
        owned.selection=undefined;
      const identityHash=this.identityHash(candidate);
      if([...this.workingFeeds.values()].some(feed=>feed.candidate.gameId===candidate.gameId&&
        feed.identityHash===identityHash))try {
        this.replaceWorkingIdentity(candidate.gameId,identityHash,[]);
      } catch(error) {this.errors.set('working-feed-cache',errorCode(error));}
    }
    this.revision++;
  }
  private forgetGameProof(gameId:string):void {
    if((this.finalDeadlines.get(gameId)??Infinity)<=this.now()) {
      this.store.removeWorkingGames([gameId]);
      for(const [key,feed] of this.workingFeeds)if(feed.candidate.gameId===gameId)this.workingFeeds.delete(key);
    }
    this.terminalByGame.delete(gameId);
    const prefix=`[${JSON.stringify(gameId)},`;
    for(const key of this.healthRevision.keys())if(key.startsWith(prefix))this.healthRevision.delete(key);
    for(const key of this.decoded.keys())if(key.startsWith(prefix))this.decoded.delete(key);
  }
  private currentCandidate(candidate:Candidate):boolean {
    const key=this.probeKey(candidate);
    return candidate.observedAt<=this.now()+60_000&&
      (this.now()-candidate.observedAt<=30*60_000||candidate.sourceIds.some(sourceId=>(this.publicationDeadlines.get(`${sourceId}:${key}`)??0)>=this.now())||this.retainedPlayable(candidate)||
        this.retainedWorkingCandidate(candidate));
  }
  private listingPending(url:string):boolean {
    return [...this.pendingListings.values()].includes(new URL(url).hostname);
  }
  private hostRetryAt(url:string):number {
    return this.hostCooldowns.get(new URL(url).hostname)||0;
  }
  private readHtml(url:string,signal=this.controller.signal):Promise<string>|undefined {
    if(this.hostRetryAt(url)>this.now())return;
    return this.fetchHtml(url,signal).catch(error=>{
      if(sourceFailure(error)==='rate-limited') {
        const delay=this.retryAfterMs(error);
        this.hostCooldowns.set(new URL(url).hostname,Math.max(this.hostRetryAt(url),
          retryDeadline(this.now(),Math.max(SOURCE_REFRESH_MS,delay),SOURCE_REFRESH_MS)));
      }
      throw error;
    });
  }
  private projectCandidates():void {
    const evidence=new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    this.projectDetails(evidence);
    this.reconcileStreameastCandidates(evidence);
    this.reconcileSportsurgeCandidates(evidence);
  }
  private currentProbeCandidate(job:Pick<ProbeJob,'key'|'candidate'>):boolean {
    const game=this.games.find(game=>game.id===job.candidate.gameId);
    return this.feedGame(game) &&
      (this.candidates.get(game.id)||[]).some(candidate=>candidate.id===job.candidate.id&&
        this.probeKey(candidate)===job.key &&
        this.currentCandidate(candidate));
  }
  private workingRecheckDue(candidate:Candidate,checkedAt:number,now:number):boolean {
    const health=this.terminal(candidate);
    return this.currentProbeCandidate({key:this.probeKey(candidate),candidate})&&
      health?.kind==='playable'&&health.checkedAt===checkedAt&&now>=checkedAt+WORKING_RECHECK_MS;
  }
  private currentProbeJob(job:ProbeJob,queued:boolean):boolean {
    if(!this.currentProbeCandidate(job)||!this.ownedCandidate(job.candidate,job.owner))return false;
    if(job.priority!=='recheck')return true;
    const health=this.terminal(job.candidate);
    return health?.kind==='playable'&&health.checkedAt===job.expectedCheckedAt&&
      (!queued||this.now()>=job.expectedCheckedAt+WORKING_RECHECK_MS);
  }
  private maintenanceDue(job:ProbeWork & {candidate:Candidate}):number {
    if(job.priority==='recheck')return job.expectedCheckedAt+WORKING_RECHECK_MS;
    const health=this.terminal(job.candidate);
    return health?.kind==='unavailable'?health.retryAt:this.deferredProbes.get(this.probeKey(job.candidate))?.until??Infinity;
  }
  private availability(candidate:Candidate):CandidateAvailability {
    const key=this.probeKey(candidate);
    const health=this.terminal(candidate);
    if(health?.kind==='playable'&&this.freshPlayable(candidate))
      return {kind:'playable',proof:health.proof,checkedAt:health.checkedAt,...(health.timings?{timings:health.timings}:{})};
    const active=this.activeProbes.get(key);
    if(active)return {kind:'checking',progress:{kind:active.phase.kind,since:active.phase.since}};
    const queued=this.probeQueue.find(job=>job.key===key);
    if(queued)return {kind:'checking',progress:{kind:'queued',since:queued.phase.since}};
    const deferred=this.deferredProbes.get(key);
    if(deferred&&(deferred.kind==='incomplete'||deferred.until>this.now()))return {kind:'checking',progress:{kind:'deferred',since:deferred.since,retryAt:deferred.until,
      ...(deferred.phase?{phase:deferred.phase}:{}),...(deferred.reason?{reason:deferred.reason}:{}),
      ...(deferred.retryAfterMs!==undefined?{retryAfterMs:deferred.retryAfterMs}:{}),...(deferred.timings?{timings:deferred.timings}:{})}};
    if(health?.kind==='unavailable'){
      const {owner,...availability}=health;
      void owner;
      return availability;
    }
    if(health?.kind==='playable'&&this.retainedPlayable(candidate)&&this.feedGame(this.games.find(game=>game.id===candidate.gameId)))
      return {kind:'checking',progress:{kind:'queued',since:health.checkedAt+WORKING_FRESH_MS}};
    return {kind:'unknown'};
  }
  private selectable(candidate:Candidate):boolean {
    return this.currentCandidate(candidate)&&this.freshPlayable(candidate);
  }
  private visibleListedCandidate(candidate:Candidate):boolean {
    return this.feedGame(this.games.find(game=>game.id===candidate.gameId))||
      this.retainedPlayable(candidate)||this.retainedWorkingCandidate(candidate);
  }
  private candidateSummary(candidate:Candidate) {return candidateSummary(candidate,this.availability(candidate));}
  private candidateRanking() {
    const now=this.now();
    const ranks=new Map<Candidate,{proof:number;startupMs:number|null}>();
    const rank=(candidate:Candidate)=>{
      const existing=ranks.get(candidate);
      if(existing)return existing;
      const health=this.terminal(candidate),decoded=this.decoded.get(this.probeKey(candidate));
      const value={proof:health?.kind==='playable'&&this.freshPlayable(candidate)?2:0,
        startupMs:decoded&&now-decoded.at<DECODED_STARTUP_WINDOW_MS?decoded.startupMs:null};
      ranks.set(candidate,value);
      return value;
    };
    return (left:Candidate,right:Candidate):number=>{
      const a=rank(left),b=rank(right);
      if(a.proof!==b.proof)return b.proof-a.proof;
      if(a.startupMs!==null&&b.startupMs!==null&&a.startupMs!==b.startupMs)return a.startupMs-b.startupMs;
      return compareCandidates(left,right);
    };
  }
  private reconcileProbeJobs(persistWorkingFeeds=true):void {
    this.restoreFeedChecks();
    if(persistWorkingFeeds){
      const persisted=new Set<string>();
      for(const candidate of [...this.candidates.values()].flat()) {
        const key=this.probeKey(candidate);
        if(persisted.has(key)||this.terminal(candidate)?.kind!=='playable')continue;
        persisted.add(key);
        this.persistWorkingIdentity(candidate);
      }
    }
    for(const [observation,controller] of this.detailControllers)
      if(!this.observationFeedEligible(observation))controller.abort();
    this.probeQueue=this.probeQueue.filter(job=>this.currentProbeJob(job,true));
    const currentKeys=new Set([...this.candidates.values()].flat().filter(candidate=>this.currentCandidate(candidate)).map(candidate=>this.probeKey(candidate)));
    if(this.protectedBackgroundKey&&!currentKeys.has(this.protectedBackgroundKey))this.protectedBackgroundKey=undefined;
    for(const key of this.forcedRetries)if(!currentKeys.has(key))this.forcedRetries.delete(key);
    for(const key of this.promotedProbes.keys())if(!currentKeys.has(key))this.promotedProbes.delete(key);
    for(const job of this.activeProbes.values())if(!this.currentProbeJob(job,false))job.controller.abort();
    for(const gameId of this.terminalByGame.keys()) {
      const game=this.games.find(row=>row.id===gameId);
      const owned=[...this.sessions.values()].some(session=>session.value.gameId===gameId&&
        session.value.state!=='closed'&&this.now()-session.lastSeen<=SESSION_LEASE_MS);
      if((this.finalDeadlines.get(gameId)??game?.graceEndsAt??Infinity)<=this.now()||!game&&!owned)
        this.forgetGameProof(gameId);
    }
    for(const [key,deferred] of this.deferredProbes) {
      if(this.currentProbeCandidate({key,candidate:deferred.candidate})&&this.ownedCandidate(deferred.candidate,deferred.owner))continue;
      clearTimeout(deferred.timer);
      this.deferredProbes.delete(key);
    }
  }
  private gamesNeedingWorkingFeeds():Set<string> {
    const games=new Set<string>();
    for(const game of this.games) {
      if(!this.feedGame(game))continue;
      const verified=new Set<string>();
      for(const candidate of this.candidates.get(game.id)||[]) {
        if(this.terminal(candidate)?.kind!=='playable'||!this.selectable(candidate))continue;
        verified.add(this.probeKey(candidate));
        if(verified.size>=verificationPolicy.workingFeedsPerGame)break;
      }
      if(verified.size<verificationPolicy.workingFeedsPerGame)games.add(game.id);
    }
    return games;
  }
  private probeAdmissionLimit(at=this.now()):number {
    const viewing=[...this.sessions.values()].some(owned=>owned.value.state!=='closed'&&at-owned.lastSeen<=SESSION_LEASE_MS);
    return viewing?Math.min(this.probeConcurrency,verificationPolicy.viewingConcurrency):this.probeConcurrency;
  }
  private probeDemand():Set<string> {
    const now=this.now();
    const demand=new Set([...this.checkTargets].filter(([,requestedAt])=>now-requestedAt<=90_000).map(([gameId])=>gameId));
    for(const owned of this.sessions.values())if(owned.value.state!=='closed')demand.add(owned.value.gameId);
    for(const game of this.games)if(game.lifecycle==='live'&&game.finalObservedAt===undefined&&this.scheduleFresh(game)&&
      !(this.candidates.get(game.id)||[]).some(candidate=>this.selectable(candidate)))demand.add(game.id);
    if(demand.size)return demand;
    return new Set(this.games.filter(game=>game.lifecycle==='live'&&game.finalObservedAt===undefined&&this.scheduleFresh(game)).map(game=>game.id));
  }
  private gameUrgency(game:Game|undefined):number {
    if(game?.lifecycle==='live')return 0;
    const kickoff=game?.date?Date.parse(game.date):Infinity;
    return game?.lifecycle==='scheduled'&&kickoff>=this.now()&&kickoff<=this.now()+60*60_000?1:2;
  }
  private probeFrontier():{keys:Set<string>;day:number}|undefined {
    const today=feedCalendarDay(this.now());
    if(today===null)return;
    const queued=new Map(this.probeQueue.map(job=>[job.key,job]));
    const keys=new Set<string>();
    let day=Infinity;
    for(const game of this.games){
      if(!this.feedGame(game))continue;
      const gameDay=game.lifecycle==='live'?today:Math.max(today,game.date?feedCalendarDay(Date.parse(game.date))??today:today);
      for(const candidate of this.candidates.get(game.id)||[]){
        const key=this.probeKey(candidate);
        if(!this.currentCandidate(candidate)||this.terminal(candidate)||this.deferredProbes.get(key)?.kind==='incomplete')continue;
        const job=this.activeProbes.get(key)??queued.get(key);
        if(job&&job.priority!=='unknown')continue;
        if(gameDay<day){day=gameDay;keys.clear();}
        if(gameDay===day)keys.add(key);
      }
    }
    if(keys.size)return {keys,day};
  }
  private currentDayMaintenance(candidate:Candidate):boolean {
    const game=this.games.find(row=>row.id===candidate.gameId);
    const today=feedCalendarDay(this.now());
    return today!==null&&!!game&&(game.lifecycle==='live'||
      !!game.date&&(feedCalendarDay(Date.parse(game.date))??Infinity)<=today);
  }
  private probeAllowed(work:{candidate:Candidate;priority:ProbeWork['priority']},
    frontier:{keys:ReadonlySet<string>;day:number}|undefined):boolean {
    if(!frontier||work.priority==='forced')return true;
    if(work.priority==='unknown')return frontier.keys.has(this.probeKey(work.candidate));
    if(!this.currentDayMaintenance(work.candidate))return false;
    return work.priority==='retry'||frontier.day>(feedCalendarDay(this.now())??Infinity);
  }
  private checkSources(gameIds:string[],retry:boolean):void {
    if(retry)for(const gameId of gameIds)this.rediscoverGame(gameId);
    if(retry)for(const job of [...this.activeProbes.values(),...this.probeQueue])
      if(gameIds.includes(job.candidate.gameId))job.incompleteAttempts=0;
    if(this.probeReplan){clearImmediate(this.probeReplan);this.probeReplan=undefined;}
    const now=this.now();
    for(const [key,deferred] of this.deferredProbes)if(deferred.kind==='capacity'&&deferred.until<=now){
      clearTimeout(deferred.timer);
      this.deferredProbes.delete(key);
    }
    for(const gameId of gameIds) {
      this.checkTargets.delete(gameId);
      this.checkTargets.set(gameId,now);
    }
    for(const [gameId,requestedAt] of this.checkTargets)if(now-requestedAt>90_000)this.checkTargets.delete(gameId);
    while(this.checkTargets.size>16)this.checkTargets.delete(this.checkTargets.keys().next().value!);
    if(retry)for(const gameId of gameIds)for(const candidate of this.candidates.get(gameId)||[])
      if(this.currentCandidate(candidate)&&this.terminal(candidate)?.kind==='unavailable')
        this.forcedRetries.add(this.probeKey(candidate));
    if(retry)for(const job of this.activeProbes.values())if(gameIds.includes(job.candidate.gameId)&&
      job.priority==='retry'&&job.phase.kind==='queued'&&!job.controller.signal.aborted){
      this.forcedRetries.add(job.key);
      this.promotedProbes.set(job.key,0);
      job.controller.abort();
    }
    if(retry)for(const job of this.probeQueue)if(job.priority==='retry'&&gameIds.includes(job.candidate.gameId)) {
      job.priority='forced';
      this.forcedRetries.delete(job.key);
      this.terminalByGame.get(job.candidate.gameId)?.delete(job.key);
      this.revision++;
    }
    if(retry)for(const [key,deferred] of this.deferredProbes)if(gameIds.includes(deferred.candidate.gameId)){
      if(deferred.kind==='incomplete'&&this.terminal(deferred.candidate)?.kind!=='playable')this.forcedRetries.add(key);
      clearTimeout(deferred.timer);
      this.deferredProbes.delete(key);
    }
    const frontier=this.probeFrontier();
    this.probeQueue=this.probeQueue.filter(job=>this.probeAllowed(job,frontier));
    if(frontier){
      if(this.protectedBackgroundKey&&!frontier.keys.has(this.protectedBackgroundKey))this.protectedBackgroundKey=undefined;
      for(const key of this.promotedProbes.keys())if(!frontier.keys.has(key)&&!this.forcedRetries.has(key))this.promotedProbes.delete(key);
    }
    const queued=new Set(this.probeQueue.map(job=>job.key));
    const hasPlayable=(candidate:Candidate):boolean=>this.terminal(candidate)?.kind==='playable';
    const demand=this.probeDemand();
    const firstFeedDemand=new Set([...demand].filter(gameId=>this.checkTargets.has(gameId)||
      !(this.candidates.get(gameId)||[]).some(candidate=>this.selectable(candidate))));
    const admittedByGame=new Map<string,number>();
    for(const job of [...this.activeProbes.values(),...this.probeQueue])
      admittedByGame.set(job.candidate.gameId,(admittedByGame.get(job.candidate.gameId)||0)+1);
    const eligible=this.games.filter(game=>this.feedGame(game)).map(game=>{
      const candidates=(this.candidates.get(game.id)||[]).filter(candidate=>this.currentCandidate(candidate)).sort(this.candidateRanking());
      const sourcesByKey=new Map<string,Set<string>>();
      for(const candidate of candidates){
        const key=this.probeKey(candidate),sources=sourcesByKey.get(key)||new Set<string>();
        for(const sourceId of candidate.sourceIds)sources.add(sourceId);
        sourcesByKey.set(key,sources);
      }
      const seenSources=new Set<string>();
      const seenKeys=new Set<string>();
      for(const candidate of candidates){
        const key=this.probeKey(candidate);
        if(this.terminal(candidate)||this.activeProbes.has(key)||this.deferredProbes.has(key)){
          seenKeys.add(key);
          for(const sourceId of sourcesByKey.get(key)||[])seenSources.add(sourceId);
        }
      }
      const firstChecks:Candidate[]=[],siblings:Candidate[]=[];
      for(const candidate of candidates){
        const key=this.probeKey(candidate),sources=sourcesByKey.get(key)||new Set<string>();
        if(!seenKeys.has(key)&&[...sources].some(sourceId=>!seenSources.has(sourceId))){
          firstChecks.push(candidate);
          seenKeys.add(key);
          for(const sourceId of sources)seenSources.add(sourceId);
        }else siblings.push(candidate);
      }
      return {gameId:game.id,urgency:this.gameUrgency(game),kickoff:game.date?Date.parse(game.date):Infinity,
        candidates:[...firstChecks,...siblings]};
    }).filter(game=>game.candidates.length);
    eligible.sort((left,right)=>left.urgency-right.urgency||
      Number(left.candidates.some(hasPlayable))-Number(right.candidates.some(hasPlayable))||
      Number(left.candidates.every(candidate=>playbackResolution(candidate.locator)==='browser'))-
      Number(right.candidates.every(candidate=>playbackResolution(candidate.locator)==='browser'))||left.kickoff-right.kickoff);
    const nearKickoff=new Set(eligible.filter(game=>game.urgency===1).map(game=>game.gameId));
    const urgencyByGame=new Map(eligible.map(game=>[game.gameId,game.urgency]));
    const roundRobin=(games:typeof eligible):Candidate[]=>{
      const rows:Candidate[]=[];
      for(let index=0;games.some(game=>index<game.candidates.length);index++)
        for(const game of games)if(game.candidates[index])rows.push(game.candidates[index]);
      return rows;
    };
    const selected=roundRobin(eligible.filter(game=>demand.has(game.gameId)));
    const backgroundGames=eligible.filter(game=>!demand.has(game.gameId));
    const offset=selected.length&&backgroundGames.length?this.backgroundCursor%backgroundGames.length:0;
    const background=roundRobin([...backgroundGames.slice(offset),...backgroundGames.slice(0,offset)]);
    const ordered:Candidate[]=[];
    if(!selected.length)ordered.push(...background);
    else {
      let selectedIndex=0,backgroundIndex=0;
      while(selectedIndex<selected.length||backgroundIndex<background.length){
        for(let slot=0;slot<3&&selectedIndex<selected.length;slot++)ordered.push(selected[selectedIndex++]);
        if(backgroundIndex<background.length)ordered.push(background[backgroundIndex++]);
        if(selectedIndex>=selected.length)while(backgroundIndex<background.length)ordered.push(background[backgroundIndex++]);
      }
    }
    const unknown:Candidate[]=[];
    const forced:Candidate[]=[];
    const retries:Candidate[]=[];
    const rechecks:Array<{candidate:Candidate;priority:'recheck';expectedCheckedAt:number}>=[];
    const seen=new Set<string>();
    for(const candidate of ordered) {
      const key=this.probeKey(candidate);
      const deferred=this.deferredProbes.get(key);
      if(seen.has(key)||this.activeProbes.has(key)||queued.has(key)||deferred&&deferred.until>now)continue;
      seen.add(key);
      const force=this.forcedRetries.has(key);
      const prior=this.terminal(candidate);
      if(force&&prior?.kind!=='playable')forced.push(candidate);
      else if(deferred?.kind==='incomplete'&&prior?.kind!=='playable') {
        if(this.probeAllowed({candidate,priority:'retry'},frontier))retries.push(candidate);
      } else if(prior?.kind==='unavailable') {
        if(now>=prior.retryAt&&this.probeAllowed({candidate,priority:'retry'},frontier))retries.push(candidate);
      } else if(prior?.kind==='playable') {
        this.forcedRetries.delete(key);
        if(this.workingRecheckDue(candidate,prior.checkedAt,now)&&this.probeAllowed({candidate,priority:'recheck'},frontier))
          rechecks.push({candidate,priority:'recheck',expectedCheckedAt:prior.checkedAt});
      } else {
        this.forcedRetries.delete(key);
        if(!frontier||frontier.keys.has(key))unknown.push(candidate);
      }
    }
    const maintenance:Array<ProbeWork & {candidate:Candidate}>=[...rechecks,...retries.map(candidate=>({candidate,priority:'retry' as const}))];
    maintenance.sort((left,right)=>this.maintenanceDue(left)-this.maintenanceDue(right));
    const pendingGames=new Set([...admittedByGame.keys(),...unknown.map(candidate=>candidate.gameId),
      ...forced.map(candidate=>candidate.gameId),...maintenance.map(work=>work.candidate.gameId)]);
    const sharedGames=[...pendingGames];
    const demandedGames=sharedGames.filter(gameId=>demand.has(gameId)).length;
    const demandedLimit=Math.max(2,Math.ceil(this.probeConcurrency/Math.max(1,demandedGames)));
    const backgroundLimit=Math.max(1,Math.ceil(this.probeConcurrency/Math.max(1,sharedGames.length)));
    const admissionLimit=(gameId:string)=>{
      return demand.has(gameId)?demandedLimit:backgroundLimit;
    };
    for(const job of this.activeProbes.values())if(job.priority==='unknown'&&job.phase.kind==='queued'&&
      !job.controller.signal.aborted&&this.probeAllowed(job,frontier)){
      const promoted=firstFeedDemand.has(job.candidate.gameId)&&!job.admittedDemand?2:
        nearKickoff.has(job.candidate.gameId)&&!job.admittedNear?3:Infinity;
      if(promoted<Infinity){this.promotedProbes.set(job.key,promoted);job.controller.abort();}
    }
    const recheckGames=new Set(rechecks.map(work=>work.candidate.gameId));
    const forcedGames=new Set(forced.map(candidate=>candidate.gameId));
    const sameGamePriority=new Set([...forcedGames,...recheckGames]);
    const fairCheck=this.urgentAdmissions>=3&&!this.protectedBackgroundKey?ordered.find(candidate=>{
      const key=this.probeKey(candidate);
      return this.probeAllowed({candidate,priority:'unknown'},frontier)&&!this.activeProbes.has(key)&&!this.deferredProbes.has(key)&&
        !this.terminal(candidate)&&((admittedByGame.get(candidate.gameId)||0)<admissionLimit(candidate.gameId)||
          this.probeQueue.some(job=>job.candidate.gameId===candidate.gameId&&job.priority==='recheck'));
    }):undefined;
    const fairKey=fairCheck?this.probeKey(fairCheck):undefined;
    const priorityUnknown=unknown.filter(candidate=>
      (admittedByGame.get(candidate.gameId)||0)<admissionLimit(candidate.gameId));
    const queuedPriority=this.probeQueue.map(job=>job.priority==='forced'?0:job.priority==='recheck'?1:
      firstFeedDemand.has(job.candidate.gameId)?2:nearKickoff.has(job.candidate.gameId)?3:Infinity);
    const priorityLevel=Math.min(...this.promotedProbes.values(),...queuedPriority,
      forced.length?0:Infinity,rechecks.length?1:Infinity,
      priorityUnknown.some(candidate=>firstFeedDemand.has(candidate.gameId))?2:
        priorityUnknown.some(candidate=>nearKickoff.has(candidate.gameId))?3:Infinity);
    if(priorityLevel<Infinity)for(const job of this.activeProbes.values()){
      if(job.phase.kind!=='queued'||job.controller.signal.aborted||!this.probeAllowed(job,frontier))continue;
      const level=job.priority==='forced'?0:job.priority==='recheck'?1:
        firstFeedDemand.has(job.candidate.gameId)?2:nearKickoff.has(job.candidate.gameId)?3:
          job.priority==='retry'?5:4;
      if(job.key===this.protectedBackgroundKey&&!forcedGames.has(job.candidate.gameId))continue;
      if(sameGamePriority.has(job.candidate.gameId)&&job.priority==='unknown'||
        level>priorityLevel){
        if(job.key===this.protectedBackgroundKey)this.protectedBackgroundKey=undefined;
        else if(!this.protectedBackgroundKey&&level>=2&&priorityLevel<level)this.protectedBackgroundKey=job.key;
        job.controller.abort();
      }
    }
    for(let index=this.probeQueue.length-1;index>=0;index--){
      const job=this.probeQueue[index];
      if(job.priority!=='unknown'||job.key===fairKey||!recheckGames.has(job.candidate.gameId))continue;
      this.probeQueue.splice(index,1);
      admittedByGame.set(job.candidate.gameId,(admittedByGame.get(job.candidate.gameId)||1)-1);
      this.revision++;
    }
    if(fairCheck&&fairKey&&!queued.has(fairKey)){
      const admitted=admittedByGame.get(fairCheck.gameId)||0;
      const replacement=this.probeQueue.findLastIndex(job=>job.candidate.gameId===fairCheck.gameId&&job.priority==='recheck');
      if(admitted>=admissionLimit(fairCheck.gameId)&&replacement>=0){
        this.probeQueue.splice(replacement,1);
        admittedByGame.set(fairCheck.gameId,admitted-1);
        this.revision++;
      }
    }
    const queuedRetry=this.unknownAdmissions>=3?this.probeQueue.find(job=>job.priority==='retry'):undefined;
    const fairRetry=this.unknownAdmissions>=3&&!this.protectedBackgroundKey&&!queuedRetry?maintenance.find(work=>
      work.priority==='retry'&&((admittedByGame.get(work.candidate.gameId)||0)<admissionLimit(work.candidate.gameId)||
        this.probeQueue.some(job=>job.candidate.gameId===work.candidate.gameId&&job.priority==='unknown'))):undefined;
    const fairRetryKey=queuedRetry?.key??(fairRetry?this.probeKey(fairRetry.candidate):undefined);
    if(fairRetry){
      const gameId=fairRetry.candidate.gameId,admitted=admittedByGame.get(gameId)||0;
      const replacement=this.probeQueue.findLastIndex(job=>job.candidate.gameId===gameId&&job.priority==='unknown');
      if(admitted>=admissionLimit(gameId)&&replacement>=0){
        this.probeQueue.splice(replacement,1);
        admittedByGame.set(gameId,admitted-1);
        this.revision++;
      }
    }
    const additions:Array<ProbeWork & {candidate:Candidate}>=[...forced.map(candidate=>({candidate,priority:'forced'} as const)),
      ...unknown.filter(candidate=>this.probeKey(candidate)===fairKey).map(candidate=>({candidate,priority:'unknown'} as const)),
      ...maintenance.filter(work=>work.priority==='recheck'),
      ...(fairRetry?[fairRetry]:[]),
      ...unknown.filter(candidate=>this.probeKey(candidate)!==fairKey).map(candidate=>({candidate,priority:'unknown'} as const)),
      ...maintenance.filter(work=>work.priority==='retry'&&work!==fairRetry)];
    for(const work of additions) {
      const {candidate,priority}=work;
      if(this.promotedProbes.size&&!this.promotedProbes.has(this.probeKey(candidate))&&
        (priority==='unknown'||priority==='retry'))continue;
      const admitted=admittedByGame.get(candidate.gameId)||0;
      if(admitted>=admissionLimit(candidate.gameId))continue;
      if(this.probeQueue.length>=PROBE_QUEUE_LIMIT) {
        const maintenanceReplacement=this.probeQueue.reduce((latest,job,index)=>
          job.key!==fairRetryKey&&(job.priority==='retry'||job.priority==='recheck')&&
          (latest<0||this.maintenanceDue(job)>=this.maintenanceDue(this.probeQueue[latest]))?index:latest,-1);
        if(priority==='retry'||priority==='recheck') {
          const replacement=work===fairRetry?this.probeQueue.findLastIndex(job=>job.priority==='unknown'&&job.key!==fairKey):maintenanceReplacement;
          if(replacement<0||work!==fairRetry&&this.maintenanceDue(work)>=this.maintenanceDue(this.probeQueue[replacement]))continue;
          const [removed]=this.probeQueue.splice(replacement,1);
          admittedByGame.set(removed.candidate.gameId,(admittedByGame.get(removed.candidate.gameId)||1)-1);
        } else {
          const demanded=priority!=='forced'&&demand.has(candidate.gameId);
          const approaching=priority!=='forced'&&!demanded&&nearKickoff.has(candidate.gameId);
          if(maintenanceReplacement<0&&priority!=='forced'&&!demanded&&!approaching)continue;
          const displaced=maintenanceReplacement>=0?maintenanceReplacement:demanded||approaching?this.probeQueue.findLastIndex(job=>job.key!==fairRetryKey&&job.priority!=='forced'&&
            !demand.has(job.candidate.gameId)&&(!approaching||!nearKickoff.has(job.candidate.gameId))):
            this.probeQueue.findLastIndex(job=>job.priority!=='forced');
          if(displaced<0)continue;
          if(maintenanceReplacement<0&&demanded&&!demand.has(this.probeQueue[displaced].candidate.gameId)&&
            this.probeQueue.filter(job=>!demand.has(job.candidate.gameId)).length<=1)continue;
          const [removed]=this.probeQueue.splice(displaced,1);
          admittedByGame.set(removed.candidate.gameId,(admittedByGame.get(removed.candidate.gameId)||1)-1);
        }
      }
      const key=this.probeKey(candidate);
      if(priority==='forced')this.terminalByGame.get(candidate.gameId)?.delete(key);
      const game=this.games.find(row=>row.id===candidate.gameId);
      if(!game)continue;
      const prior=this.terminal(candidate);
      const owner=prior?.kind==='playable'?prior.owner:this.gameOwner(game);
      this.probeQueue.push({...work,key,owner,controller:new AbortController(),revision:this.healthRevision.get(key)||0,
        phase:{kind:'queued',since:now},queuedAt:now,admittedDemand:firstFeedDemand.has(candidate.gameId),admittedNear:nearKickoff.has(candidate.gameId),
        incompleteAttempts:this.deferredProbes.get(key)?.incompleteAttempts??0});
      if(priority==='forced')this.forcedRetries.delete(key);
      this.promotedProbes.delete(key);
      admittedByGame.set(candidate.gameId,(admittedByGame.get(candidate.gameId)||0)+1);
      this.revision++;
    }
    const rank=new Map(ordered.map((candidate,index)=>[this.probeKey(candidate),index]));
    this.probeQueue.sort((left,right)=>PROBE_PRIORITY[left.priority]-PROBE_PRIORITY[right.priority]||
      (left.priority===right.priority&&(left.priority==='recheck'||left.priority==='retry')?
        this.maintenanceDue(left)-this.maintenanceDue(right):0)||
      (urgencyByGame.get(left.candidate.gameId)??2)-(urgencyByGame.get(right.candidate.gameId)??2)||
      Number(playbackResolution(left.candidate.locator)==='browser')-Number(playbackResolution(right.candidate.locator)==='browser')||
      (rank.get(left.key)??Infinity)-(rank.get(right.key)??Infinity));
    if(priorityLevel<Infinity)this.pumpProbes();
    else this.probePump??=setImmediate(()=>{this.probePump=undefined;this.pumpProbes();});
  }
  private scheduleProbeReplan():void {
    if(this.stopped||this.probeReplan)return;
    this.probeReplan=setImmediate(()=>{
      this.probeReplan=undefined;
      if(!this.stopped)this.checkSources([],false);
    });
  }
  private runProbe(job:ProbeJob):Promise<CandidateProbeResult> {
    const canceled:CandidateProbeResult={kind:'deferred',reason:'cancelled',retryAfterMs:2000};
    if(job.controller.signal.aborted)return Promise.resolve(canceled);
    const game=this.games.find(row=>row.id===job.candidate.gameId);
    const gameDay=game?.date?feedCalendarDay(Date.parse(game.date)):null;
    const target:VerificationTarget={sessionId:this.id(),gameId:job.candidate.gameId,
      candidateId:job.candidate.id,generation:0,...(gameDay===null?{}:{gameDay})};
    this.verificationSessions.set(target.sessionId,{target,job,deadline:this.now()+60_000});
    return new Promise<CandidateProbeResult>(resolve=>{
      let settled=false;
      const finish=(result:CandidateProbeResult)=>{
        if(settled)return;
        settled=true;
        job.controller.signal.removeEventListener('abort',onAbort);
        resolve(result);
      };
      const onAbort=()=>finish(canceled);
      job.controller.signal.addEventListener('abort',onAbort,{once:true});
      void Promise.resolve().then(()=>job.controller.signal.aborted ? canceled :
        this.probeCandidate(job.candidate.locator,job.controller.signal,progress=>{
          if(this.stopped||job.controller.signal.aborted||this.activeProbes.get(job.key)!==job||
            !this.currentProbeJob(job,false)||job.revision!==(this.healthRevision.get(job.key)||0))return;
          const kind=progress.kind==='active'?'active':'queued';
          if(kind==='active'&&this.protectedBackgroundKey===job.key)this.protectedBackgroundKey=undefined;
          if(job.phase.kind!==kind){
            job.phase={kind,since:this.now()};
            this.revision++;
          }
        },target))
        .then(finish,()=>finish({kind:'deferred',retryAfterMs:FAILED_RETRY_MS}));
    }).finally(()=>{this.verificationSessions.delete(target.sessionId);});
  }
  private pumpProbes():void {
    const admissionsBefore=this.probeAdmissions;
    const gamesNeedingFeeds=this.gamesNeedingWorkingFeeds();
    const frontier=this.probeFrontier();
    const limit=this.probeAdmissionLimit();
    while(!this.stopped&&this.probeQueue.length&&this.activeProbes.size<limit) {
      const ready=this.probeQueue.filter(job=>this.probeAllowed(job,frontier));
      const demand=this.probeDemand();
      const backgroundTurn=this.probeAdmissions%4===3;
      const firstReady=ready[0];
      if(!firstReady)break;
      const urgent=firstReady.priority==='forced'||firstReady.priority==='recheck';
      const lower=ready.find(job=>job.priority==='unknown'||job.priority==='retry');
      const lowerTurn=urgent&&!!lower&&this.urgentAdmissions>=3&&!this.protectedBackgroundKey;
      const selectedPriority=lowerTurn||!urgent?
        this.unknownAdmissions>=3&&ready.some(job=>job.priority==='retry')?'retry':
          ready.some(job=>job.priority==='unknown')?'unknown':'retry':firstReady.priority;
      const eligible=(job:ProbeJob)=>job.priority===selectedPriority&&this.probeAllowed(job,frontier);
      const preferred=this.probeQueue.findIndex(job=>eligible(job)&&(backgroundTurn?!demand.has(job.candidate.gameId):demand.has(job.candidate.gameId)));
      let belowTarget=!backgroundTurn?this.probeQueue.findIndex(job=>eligible(job)&&demand.has(job.candidate.gameId)&&gamesNeedingFeeds.has(job.candidate.gameId)):-1;
      if(!backgroundTurn&&belowTarget<0)belowTarget=this.probeQueue.findIndex(job=>eligible(job)&&gamesNeedingFeeds.has(job.candidate.gameId));
      const next=belowTarget>=0?belowTarget:preferred<0?this.probeQueue.findIndex(eligible):preferred;
      if(next<0)break;
      const [job]=this.probeQueue.splice(next,1);
      const terminal=this.terminal(job.candidate);
      if(job.revision!==(this.healthRevision.get(job.key)||0)||!this.currentProbeJob(job,true))continue;
      if(job.priority!=='recheck') {
        if(terminal?.kind==='playable'||terminal&&job.priority!=='retry')continue;
        if(terminal)this.terminalByGame.get(job.candidate.gameId)?.delete(job.key);
      }
      this.activeProbes.set(job.key,job);
      const deferred=this.deferredProbes.get(job.key);
      if(deferred){clearTimeout(deferred.timer);job.incompleteAttempts=deferred.incompleteAttempts;}
      if(!this.protectedBackgroundKey&&((job.priority==='unknown'||job.priority==='retry')&&this.urgentAdmissions>=3||
        job.priority==='retry'&&this.unknownAdmissions>=3))
        this.protectedBackgroundKey=job.key;
      if(job.priority==='forced'||job.priority==='recheck')this.urgentAdmissions++;
      else {
        this.urgentAdmissions=0;
        this.unknownAdmissions=job.priority==='unknown'?this.unknownAdmissions+1:0;
      }
      job.phase={kind:'active',since:this.now()};
      job.startedAt=this.now();
      this.revision++;
      this.probeAdmissions++;
      if(demand.size&&!demand.has(job.candidate.gameId))this.backgroundCursor++;
      job.promise=this.runProbe(job).then(result=>{
        const checkedAt=this.now();
        this.completedChecks++;
        this.recentChecks.unshift({candidateId:job.candidate.id,gameId:job.candidate.gameId,checkedAt,outcome:result.kind,
          queueMs:Math.max(0,(job.startedAt??checkedAt)-job.queuedAt),activeMs:Math.max(0,checkedAt-(job.startedAt??checkedAt)),
          ...(result.kind!=='playable'&&result.reason?{reason:result.reason}:{}),
          ...(result.kind!=='playable'&&result.phase?{phase:result.phase}:{}),
          ...(result.kind==='deferred'?{retryAfterMs:result.retryAfterMs}:{}),...(result.timings?{timings:result.timings}:{})});
        if(this.recentChecks.length>32)this.recentChecks.length=32;
        this.flushSchedulePublication();
        if(this.stopped||job.controller.signal.aborted||this.activeProbes.get(job.key)!==job||!this.currentProbeJob(job,false)||
          job.revision!==(this.healthRevision.get(job.key)||0))return;
        if(result.kind!=='deferred')this.deferredProbes.delete(job.key);
        if(result.kind==='playable')this.recordTerminal(job.candidate,{kind:'playable',proof:result.proof,checkedAt,owner:job.owner,...(result.timings?{timings:result.timings}:{})});
        else if(result.kind==='unavailable') {
          this.recordTerminal(job.candidate,{kind:'unavailable',reason:result.reason,...(result.phase?{phase:result.phase}:{}),checkedAt,retryAt:checkedAt+FAILED_RETRY_MS,...(result.timings?{timings:result.timings}:{})},job.owner);
          this.publishCandidates('all');
        }
        else {
          const resourceOnly=result.reason==='capacity'||result.reason==='cancelled';
          const incompleteAttempts=resourceOnly?job.incompleteAttempts:Math.min(INCOMPLETE_RETRY_DELAYS.length,job.incompleteAttempts+1);
          const providerDelay=Number.isFinite(result.retryAfterMs)?Math.min(300000,Math.max(2000,result.retryAfterMs)):30000;
          const delay=resourceOnly?providerDelay:Math.max(providerDelay,INCOMPLETE_RETRY_DELAYS[incompleteAttempts-1]);
          const timer=setTimeout(()=>{
            if(!this.stopped)this.scheduleProbeReplan();
          },delay);
          this.deferredProbes.set(job.key,{kind:incompleteAttempts||job.priority!=='unknown'?'incomplete':'capacity',incompleteAttempts,since:checkedAt,until:checkedAt+delay,timer,candidate:job.candidate,owner:job.owner,phase:result.phase,
            ...(result.reason?{reason:result.reason}:{}),retryAfterMs:delay,...(result.timings?{timings:result.timings}:{})});
          if(!resourceOnly)this.persistFeedCheck(job.candidate,{kind:'incomplete',checkedAt,retryAt:checkedAt+delay,incompleteAttempts,
            ...(result.phase?{phase:result.phase}:{}),
            ...(result.reason&&result.reason!=='capacity'&&result.reason!=='cancelled'?{reason:result.reason}:{}),
            ...(result.timings?{timings:result.timings}:{})},job.owner);
        }
        this.revision++;
      }).catch(()=>{
        this.flushSchedulePublication();
        if(this.stopped||job.controller.signal.aborted||this.activeProbes.get(job.key)!==job||!this.currentProbeJob(job,false)||
          job.revision!==(this.healthRevision.get(job.key)||0))return;
        const checkedAt=this.now();
        const incompleteAttempts=Math.min(INCOMPLETE_RETRY_DELAYS.length,job.incompleteAttempts+1);
        const delay=Math.max(FAILED_RETRY_MS,INCOMPLETE_RETRY_DELAYS[incompleteAttempts-1]);
        const timer=setTimeout(()=>{
          if(!this.stopped)this.scheduleProbeReplan();
        },delay);
        this.deferredProbes.set(job.key,{kind:'incomplete',incompleteAttempts,since:checkedAt,until:checkedAt+delay,timer,candidate:job.candidate,owner:job.owner,phase:undefined,retryAfterMs:delay});
        this.persistFeedCheck(job.candidate,{kind:'incomplete',checkedAt,retryAt:checkedAt+delay,incompleteAttempts},job.owner);
        this.revision++;
      }).finally(()=>{
        if(this.protectedBackgroundKey===job.key&&!job.controller.signal.aborted)this.protectedBackgroundKey=undefined;
        if(this.activeProbes.get(job.key)===job){this.activeProbes.delete(job.key);this.revision++;}
        this.pumpProbes();
        this.scheduleProbeReplan();
      });
    }
    if(this.probeAdmissions!==admissionsBefore)this.scheduleProbeReplan();
  }
  private async discover(explicit=false): Promise<void> {
    const attempts=this.store.sourceAttempts();
    const observations=this.store.observations();
    const previousObservations = new Map(observations.map(observation => [observation.id,observation]));
    const sameListing=(observation:Observation,previous:Observation|undefined):previous is Observation=>
      !!previous&&previous.sourceId===observation.sourceId&&previous.url===observation.url&&
      previous.league===observation.league&&!!previous.teams&&!!observation.teams&&
      previous.teams.map(normalizedName).sort().join('|')===observation.teams.map(normalizedName).sort().join('|');
    const verifiedListing=(observation:Observation):Observation=>{
      const previous=previousObservations.get(observation.id);
      if(!(observation.kickoff===null&&sameListing(observation,previous)&&previous.kickoff!==null&&
        this.inventoryMatch(previous,listingEventEvidence(previous.sourceId),this.now()).kind==='matched'))return observation;
      const decision=this.inventoryMatch(previous,listingEventEvidence(previous.sourceId),this.now());
      const game=decision.kind==='matched'?this.games.find(game=>game.id===decision.gameId):undefined;
      if(game?.lifecycle!=='live'||game.finalObservedAt!==undefined||!this.scheduleFresh(game))return observation;
      return {...observation,kickoff:previous.kickoff,rawTime:previous.rawTime,
        kickoffLineage:previous.kickoffLineage||{observedAt:previous.observedAt,rawTime:previous.rawTime}};
    };
    const finishedListingBinding=(observation:Observation,at:number):SourceEventBinding|null=>{
      const previous=previousObservations.get(observation.id);
      if(observation.kickoff!==null||!sameListing(observation,previous)||previous.kickoff===null||
        at-observation.observedAt>30*60_000||observation.observedAt>at+60_000||
        observation.league===null||observation.teams===null)return null;
      const gameId=this.finished.finishedGameId(previous,at);
      if(!gameId)return null;
      const binding:SourceEventBinding={sourceId:observation.sourceId,eventId:observation.id,url:observation.url,
        league:observation.league,teams:observation.teams,gameId,observedAt:at};
      return this.finished.finishedBoundEvent(observation,observation.id,[binding])?binding:null;
    };
    const due=this.sources.filter(source=>{
      const previous=attempts[source.id];
      return source.kind!=='pending'&&source.kind!=='browser-catalog'&&
        ((previous&&(previous.outcome==='parsed'||previous.outcome==='empty')?discoveryDeadline(previous.at,observations.filter(row=>row.sourceId===source.id&&row.observedAt>=previous.at),this.games,source.leagues??[...new Set(this.games.map(game=>game.league))],this.now()):previous?.nextEligibleAt||0)<=this.now()||previous?.outcome==='unsupported'&&explicit||
          previous&&previous.outcome!=='failed'&&
            previous.parserVersion!==(source.parserVersion??LISTING_PARSER_VERSION));
    });
    for(const source of due)this.pendingListings.set(source.id,new URL(source.url).hostname);
    await runBounded(due,source=>source.family==='unknown'?new URL(source.url).hostname:source.family,4,1,async source=>{
      const previous=attempts[source.id];
      try {
        if(this.stopped)return;
        const request=this.readHtml(source.url);
        if(!request)return;
        let partial:PartialListingReadError|null=null;
        let html:string;
        try {html=await request;}
        catch(error) {
          if(!(error instanceof PartialListingReadError))throw error;
          partial=error;
          html=error.html;
        }
        this.flushSchedulePublication();
        const at = this.now();
        const result = this.parseListings(source,html,at);
        if (this.stopped) return;
        const knownBindings=this.store.sourceEventBindings();
        const newBindings:SourceEventBinding[]=[];
        const accepted=result.observations.map(verifiedListing).filter(observation=>{
          if(this.finished.finishedGameId(observation,at)||
            this.finished.finishedBoundEvent(observation,observation.id,knownBindings))return false;
          const binding=finishedListingBinding(observation,at);
          if(!binding)return true;
          newBindings.push(binding);
          return false;
        });
        const failures=partial?(previous?.failures||0)+1:result.outcome==='parser-changed'?(previous?.failures||0)+1:
          result.outcome==='unsupported'?(previous?.failures||0):0;
        const nextEligibleAt=partial?Math.max(this.hostRetryAt(source.url),retryDeadline(at,this.retryAfterMs(partial),SOURCE_REFRESH_MS)):
          result.outcome==='unsupported'?Number.MAX_SAFE_INTEGER:result.outcome==='parser-changed'?retryDeadline(at):discoveryDeadline(at,accepted,this.games,source.leagues??[...new Set(this.games.map(game=>game.league))]);
        const match=this.eventMatcher(this.games);
        const admitted=accepted.map(observation=>{
          const result=match(observation,listingEventEvidence(observation.sourceId),at).match;
          if(observation.league!==null&&observation.teams!==null&&result.kind==='matched'){
            const game=this.games.find(game=>game.id===result.gameId);
            if(game&&this.scheduleFresh(game)&&(observation.kickoff!==null&&game.lifecycle==='live'||
              observation.sourceId==='sportsurge'&&observation.kickoff===null))newBindings.push({sourceId:observation.sourceId,
              eventId:observation.id,url:observation.url,league:observation.league,
              teams:observation.teams,gameId:game.id,observedAt:at});
          }
          return {observation,result};
        });
        this.store.saveListingAttempt(source.id,{at,outcome:partial?'failed':result.outcome,
          ...(partial?{failure:sourceFailure(partial)}:{}),count:result.observations.length,
          failures,nextEligibleAt,parserVersion:source.parserVersion??LISTING_PARSER_VERSION},
          admitted,newBindings);
        this.discoveryDeadlines=undefined;
        if(!partial)this.sourceTimes.set(source.id,at);
        if(accepted.length)this.publishCandidates('details');
      } catch(error) {
        if (this.stopped) return;
        const at=this.now();
        const failures=(previous?.failures||0)+1;
        this.store.saveListingAttempt(source.id,{at,outcome:'failed',failure:sourceFailure(error),count:0,failures,parserVersion:source.parserVersion??LISTING_PARSER_VERSION,
          nextEligibleAt:Math.max(this.hostRetryAt(source.url),retryDeadline(at,this.retryAfterMs(error),SOURCE_REFRESH_MS))},[]);
      } finally {
        this.pendingListings.delete(source.id);
        this.revision++;
        this.publishCandidates('details');
        this.requestResolution();
      }
    });
    if (this.stopped) return;
    this.requestResolution();
  }
  private projectDetails(snapshot?:ReadonlyMap<string,DetailEvidence>):void {
    const priorDetailIds=new Set(this.detailCandidateIds);
    for(const rows of this.candidates.values())for(const candidate of rows)
      if(priorDetailIds.has(candidate.id))for(const sourceId of candidate.sourceIds)this.publicationDeadlines.delete(`${sourceId}:${this.probeKey(candidate)}`);
    const storedEvidence=snapshot??new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    const evidence=new Map(storedEvidence);
    const attempts=this.store.sourceAttempts();
    const observations=this.store.observations();
    const now=this.now(),freshGames=this.games.filter(game=>this.feedGame(game));
    for(const observation of observations){
      const detail=storedEvidence.get(observation.id),success=detail?.lastSuccess;
      if(detail?.outcome!=='failed'||!['blocked','rate-limited','timed-out','network-unavailable','collector-busy','upstream-error'].includes(detail.failure)||
        !success?.publication||!detailIdentityMatches(success.identity,observation)||success.at>now+60_000||now>success.at+DETAIL_PUBLICATION_MAX_AGE_MS)continue;
      evidence.set(observation.id,{outcome:'resolved',observationId:observation.id,generation:detail.generation,identity:success.identity,
        at:success.at,players:success.publication.players,event:success.publication.event,nextEligibleAt:detail.nextEligibleAt});
    }
    const deadlines=this.collectionDeadlines({at:now,attempts,observations,
      sportsurgeCatalog:this.store.sportsurgeCatalog(),streameastCatalog:this.store.streameastCatalog()});
    const match=createSourceEventMatcher(this.games,'current',observation=>this.deadlineFor(observation,deadlines));
    const publication=new Map<string,{conflicting:boolean;matchedGames:Set<string>}>();
    for(const observation of observations){
      const detail=evidence.get(observation.id);
      if(detail?.outcome!=='resolved'||!matchesDetail(detail,observation))continue;
      const result=match(observation,listingEventEvidence(observation.sourceId),now).match;
      if(result.kind!=='matched'&&!(result.kind==='unmatched'&&result.reason==='conflicting-date'))continue;
      for(const player of detail.players){
        const key=JSON.stringify([observation.sourceId,player.locator]);
        const state=publication.get(key)||{conflicting:false,matchedGames:new Set<string>()};
        if(result.kind==='matched')state.matchedGames.add(result.gameId);
        else state.conflicting=true;
        publication.set(key,state);
      }
    }
    const invalidated=[...this.candidates.values()].flat().filter(candidate=>priorDetailIds.has(candidate.id)&&
      candidate.locator.provider!=='event-page'&&candidate.locator.provider!=='tvapp'&&
      candidate.locator.provider!=='catalog-stream'&&candidate.locator.provider!=='streameast-server'&&
      candidate.sourceIds.some(id=>publication.get(JSON.stringify([id,candidate.locator]))?.conflicting)&&
      !candidate.sourceIds.some(id=>publication.get(JSON.stringify([id,candidate.locator]))?.matchedGames.has(candidate.gameId)));
    this.retireReassignedCandidates(invalidated);
    const changedLocators=new Set(observations.flatMap(observation=>{
      const detail=evidence.get(observation.id);
      return detail?.outcome==='resolved'&&!matchesDetail(detail,observation)?
        detail.players.map(player=>JSON.stringify(player.locator)):[];
    }));
    const changedIdentityIds=new Set<string>();
    if(changedLocators.size)for(const rows of this.candidates.values())for(const candidate of rows)
      if(changedLocators.has(JSON.stringify(candidate.locator)))changedIdentityIds.add(candidate.id);
    const selectedActive=new Set([...this.sessions.values()].flatMap(owned=>
      this.pinnedCandidateIds(owned.value.gameId,now).has(owned.value.candidateId)?
        [`${owned.value.gameId}:${owned.value.candidateId}`]:[]));
    const selectedDuringGrace=new Set([...this.sessions.values()].flatMap(owned=>{
      const game=this.games.find(item=>item.id===owned.value.gameId);
      return game?.finalObservedAt!==undefined&&game.graceEndsAt!==undefined&&now<game.graceEndsAt?
        [`${game.id}:${owned.value.candidateId}`]:[];
    }));
    for(const [gameId,rows] of this.candidates)
      this.candidates.set(gameId,rows.filter(candidate=>!priorDetailIds.has(candidate.id)||
        selectedActive.has(`${gameId}:${candidate.id}`)||selectedDuringGrace.has(`${gameId}:${candidate.id}`)||
        !changedIdentityIds.has(candidate.id)&&
          (this.retainedPlayable(candidate)||this.retainedWorkingCandidate(candidate))));
    this.detailCandidateIds.clear();
    for(const rows of this.candidates.values())
      for(const candidate of rows)if(priorDetailIds.has(candidate.id))this.detailCandidateIds.add(candidate.id);
    for(const observation of observations) {
      if(!this.sources.some(source=>source.id===observation.sourceId))continue;
      const attempt=attempts[observation.sourceId];
      if(attempt&&(attempt.outcome==='parsed'||attempt.outcome==='empty')&&observation.observedAt<attempt.at)continue;
      const detail=evidence.get(observation.id);
      if(detail?.outcome!=='resolved'||!matchesDetail(detail,observation)||
        detail.at>now+60_000||now>Math.max(observation.observedAt+ACTIVE_DISCOVERY_MS,this.deadlineFor(observation,deadlines)??0))continue;
      const retainedPublication=storedEvidence.get(observation.id)?.outcome==='failed'||
        now-detail.at>=ACTIVE_DISCOVERY_MS;
      if(retainedPublication&&(!detail.event||now>detail.at+DETAIL_PUBLICATION_MAX_AGE_MS))continue;
      const decision=match(observation,listingEventEvidence(observation.sourceId),now);
      const result=resolvedLiveChannelMatch(observation,decision.match,freshGames,detail,now,{retainedPublication});
      if(result.kind!=='matched')continue;
      const game=this.games.find(item=>item.id===result.gameId);
      if(!this.feedGame(game)||detail.event&&(detail.event.gameId!==game.id||detail.event.date!==(game.date??null)))continue;
      const byId=new Map((this.candidates.get(game.id)||[]).map(candidate=>[candidate.id,candidate]));
      for(const published of detail.players) {
        let player=published;
        if((player.locator.provider==='event-page'||player.locator.provider==='tvapp'||player.locator.provider==='catalog-stream'||
          player.locator.provider==='streameast-server') &&
          (player.locator.gameId!==game.id || player.locator.eventUrl!==observation.url))continue;
        const versionId=player.id+':'+createHash('sha256').update(JSON.stringify(player.locator)).digest('hex').slice(0,12);
        if(byId.has(versionId))player={...player,id:versionId};
        let previous=byId.get(player.id);
        if(previous&&JSON.stringify(previous.locator)!==JSON.stringify(player.locator)) {
          if(detail.at<=previous.observedAt)continue;
          if(byId.has(versionId)||this.retainedPlayable(previous)||this.retainedWorkingCandidate(previous)||
            selectedActive.has(`${game.id}:${previous.id}`))
            player={...player,id:versionId};
          previous=byId.get(player.id);
          if(previous&&JSON.stringify(previous.locator)!==JSON.stringify(player.locator))previous=undefined;
        }
        const candidate={...player,gameId:game.id,sourceIds:[...new Set([...(previous?.sourceIds||[]),observation.sourceId])],
          observedAt:Math.min(observation.observedAt,detail.at)};
        byId.set(player.id,candidate);
        this.publicationDeadlines.set(`${observation.sourceId}:${this.probeKey(candidate)}`,Math.min(detail.at+DETAIL_PUBLICATION_MAX_AGE_MS,
          Math.max(observation.observedAt+ACTIVE_DISCOVERY_MS,this.deadlineFor(observation,deadlines)??0)));
        this.detailCandidateIds.add(player.id);
      }
      this.candidates.set(game.id,[...byId.values()]);
      if(observation.legacyId)this.store.alias(observation.legacyId,game.id);
    }
  }
  private requestResolution():void {
    if(this.stopped)return;
    this.detailRevision++;
    if(this.detailWork){this.resolutionPending=true;this.wakeDetails?.();return;}
    this.detailWork=this.resolveObservations().catch(error=>{
      if(!this.stopped)this.errors.set('details',errorCode(error));
    }).finally(()=>{
      this.detailWork=undefined;
      if(this.resolutionPending){this.resolutionPending=false;this.requestResolution();}
    });
  }
  private publishCandidates(kind:'details'|'all'):void {
    if(this.stopped)return;
    if(this.candidatePublication){
      if(kind==='all')this.candidatePublication.kind='all';
      return;
    }
    const publication={kind,timer:setImmediate(()=>{
      this.candidatePublication=undefined;
      if(this.stopped)return;
      if(publication.kind==='all')this.projectCandidates();
      else this.projectDetails();
      this.reconcileProbeJobs();
      this.checkSources([],false);
      this.revision++;
    })};
    this.candidatePublication=publication;
  }
  private async resolveObservations():Promise<void> {
    const catalogIds = new Set(this.sources.filter(source => source.kind === 'browser-catalog').map(source => source.id));
    const eventPageIds = new Set(this.sources.filter(source => source.family === 'vipbox').map(source => source.id));
    const publishedPlayerCatalogIds = new Set(this.sources.filter(source => source.family === 'ppv' && source.kind === 'catalog').map(source => source.id));
    const evidence=new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    let matchingGames=this.games;
    let match=this.eventMatcher(matchingGames);
    const currentMatch=()=>{
      if(this.games!==matchingGames){matchingGames=this.games;match=this.eventMatcher(matchingGames);}
      return match;
    };
    const liveRolloverGame=(observation:Observation):Game|undefined=>{
      if(!eventPageIds.has(observation.sourceId)||this.now()-observation.observedAt<=30*60_000||observation.kickoff===null)return;
      const result=this.inventoryMatch(observation,listingEventEvidence(observation.sourceId),this.now()).match;
      if(result.kind!=='matched')return;
      const game=this.games.find(value=>value.id===result.gameId);
      return game?.lifecycle==='live'&&game.finalObservedAt===undefined&&this.scheduleFresh(game)&&
        game.date&&observation.kickoff===Date.parse(game.date)?game:undefined;
    };
    const visited=new Set<string>();
    const ranked=():Observation[]=>{
      const viewed=new Set([...this.sessions.values()].map(session=>session.value.gameId));
      const gamesNeedingFeeds=this.gamesNeedingWorkingFeeds();
      for(const [gameId,requestedAt] of this.checkTargets)if(this.now()-requestedAt<=90_000)viewed.add(gameId);
      const match=currentMatch();
      return this.store.observations().flatMap(observation=>{
        if(visited.has(observation.id)||catalogIds.has(observation.sourceId)||!observation.teams&&!(observation.league!==null&&isMotorsportsLeague(observation.league))&&observation.league!=='ufc'&&observation.league!=='boxing'&&!(observation.league!==null&&isWrestlingLeague(observation.league))||
          this.hostRetryAt(observation.url)>this.now()||this.listingPending(observation.url))return [];
        const result=match(observation,listingEventEvidence(observation.sourceId),this.now()).match;
        const rolloverGame=result.kind==='unmatched'&&result.reason==='stale-observation'?liveRolloverGame(observation):undefined;
        const detailIds=detailCandidateGameIds(result);
        if(!detailIds.length&&!rolloverGame)return [];
        const prior=evidence.get(observation.id);
        const scheduledGame=this.games.find(game=>detailIds.includes(game.id));
        const deadline=prior?.polling?detailDeadline({at:prior.at,polling:prior.polling,game:scheduledGame,now:this.now(),
          published:prior.outcome==='resolved'&&prior.players.length>0}):prior?.nextEligibleAt;
        if(prior&&matchesDetail(prior,observation)&&(!prior.event||prior.event.gameId===scheduledGame?.id&&prior.event.date===(scheduledGame?.date??null))&&!this.forcedDetailDiscovery.has(observation.id)&&(deadline??0)>this.now())return [];
        const game=rolloverGame||this.games.find(game=>detailIds.some(id=>id===game.id)&&this.feedGame(game));
        if(!game||!this.observationFeedEligible(observation))return [];
        return [{observation,needsFeeds:gamesNeedingFeeds.has(game.id),viewed:Number(viewed.has(game.id)),urgency:this.gameUrgency(game),
          kickoff:game?.date?Date.parse(game.date):Infinity,
          sourceRank:publishedPlayerCatalogIds.has(observation.sourceId)?0:observation.sourceId==='sportsurge'?1:2}];
      }).sort((left,right)=>Number(right.needsFeeds)-Number(left.needsFeeds)||right.viewed-left.viewed||left.urgency-right.urgency||
        left.kickoff-right.kickoff||left.sourceRank-right.sourceRank).map(row=>row.observation);
    };
    const visit=async(original:Observation):Promise<void>=>{
      if (this.stopped||!this.observationFeedEligible(original)) return;
      const controller=new AbortController();
      this.detailControllers.set(original,controller);
      const signal=AbortSignal.any([this.controller.signal,controller.signal]);
      let observation = original;
      let changed=false;
      try {
        const request=this.readHtml(original.url,signal);
        if(!request)return;
        this.forcedDetailDiscovery.delete(original.id);
        const html = await request;
        this.flushSchedulePublication();
        if (this.stopped||signal.aborted||!this.observationFeedEligible(original)) return;
        observation = this.enrichObservation(original,html);
        if(!this.observationFeedEligible(observation))return;
        const at=this.now();
        const rolloverGame=liveRolloverGame(original);
        const playersFor=(id:string)=>this.resolvePlayers(id,observation,html,signal);
        const rolloverPlayers=rolloverGame&&observation.kickoff===original.kickoff?
          await playersFor(rolloverGame.id):[];
        const publishedEventPage=rolloverPlayers.some(player=>
          (player.locator.provider==='event-page'||player.locator.provider==='tvapp'||player.locator.provider==='catalog-stream')&&
          player.locator.gameId===rolloverGame?.id&&player.locator.eventUrl===original.url);
        if(publishedEventPage)observation={...observation,observedAt:at};
        const rawResult=currentMatch()(observation,listingEventEvidence(observation.sourceId),at).match;
        const freshGames=this.games.filter(game=>this.feedGame(game));
        const game=rawResult.kind==='matched'?this.games.find(value=>value.id===rawResult.gameId):
          provisionalLiveChannel(observation,rawResult,freshGames,at)??undefined;
        const resolutionGames=this.games;
        const players=(this.feedGame(game)?
          publishedEventPage?rolloverPlayers:await playersFor(game.id):[])
          .filter(player=>(player.locator.provider!=='event-page'&&player.locator.provider!=='tvapp'&&player.locator.provider!=='catalog-stream'&&
            player.locator.provider!=='streameast-server')||
            player.locator.gameId===game?.id&&player.locator.eventUrl===observation.url)
          .map(({id,label,locator})=>({id,label,locator}));
        this.flushSchedulePublication();
        if(this.games!==resolutionGames)return;
        if(this.stopped||signal.aborted||!this.observationFeedEligible(original))return;
        const identity=detailIdentity(observation);
        const priorSuccess=evidence.get(original.id)?.lastSuccess;
        const event=game?{gameId:game.id,date:game.date??null}:undefined;
        const lastSuccess=players.length?{identity,at,count:players.length,...(event?{publication:{players,event}}:{})}:
          priorSuccess&&detailIdentityMatches(priorSuccess.identity,observation)?{identity:priorSuccess.identity,at:priorSuccess.at,count:priorSuccess.count}:undefined;
        const polling=detailPolling(evidence.get(original.id),observation,players,game);
        const reason=players.length?'no-compatible-media':rawResult.kind==='unmatched'&&rawResult.reason==='conflicting-date'?'conflicting-game':this.missingPlayerReason(observation,html);
        const knownPublication=players.length>0||reason==='no-published-player'||reason==='not-yet-published';
        const nextEligibleAt=reason==='parser-changed'||reason==='conflicting-game'?retryDeadline(at):
          knownPublication?detailDeadline({at,polling,game,published:players.length>0}):at+ACTIVE_DISCOVERY_MS;
        const detail:DetailEvidence=players.length?
          {outcome:'resolved',observationId:observation.id,generation:detailGeneration(observation),identity,at,
            players,nextEligibleAt,lastSuccess,polling,event}:
          {outcome:'unresolved',observationId:observation.id,generation:detailGeneration(observation),identity,at,
            reason,failures:0,nextEligibleAt,lastSuccess,event,...(knownPublication?{polling}:{})};
        const current=this.store.observation(original.id);
        if(!current||detailGeneration(current)!==detailGeneration(original)||
          this.finished.finishedGameId(original,at)||this.finished.finishedGameId(observation,at))return;
        const result=resolvedLiveChannelMatch(observation,rawResult,freshGames,detail,at);
        this.store.saveDetailEvidence(detail,{observation,result});
        this.forcedDetailDiscovery.delete(original.id);
        evidence.set(detail.observationId,detail);
        changed=true;
      } catch(error) {
        this.flushSchedulePublication();
        if(this.stopped||signal.aborted||!this.observationFeedEligible(original))return;
        const current=this.store.observation(original.id);
        if(!current||detailGeneration(current)!==detailGeneration(original)||this.finished.finishedGameId(original,this.now()))return;
        const prior=evidence.get(original.id);
        const failures=(prior&&prior.outcome!=='resolved'&&prior.generation===detailGeneration(original)?prior.failures:0)+1;
        const at=this.now();
        const lastSuccess=prior?.outcome==='resolved'&&matchesDetail(prior,original)&&prior.players.length&&prior.event?
          {identity:detailIdentity(original),at:prior.at,count:prior.players.length,publication:{players:prior.players,event:prior.event}}:
          prior?.lastSuccess&&detailIdentityMatches(prior.lastSuccess.identity,original)?prior.lastSuccess:undefined;
        const common={observationId:original.id,generation:detailGeneration(original),at,failures,
          nextEligibleAt:Math.max(this.hostRetryAt(original.url),retryDeadline(at,this.retryAfterMs(error),SOURCE_REFRESH_MS)),lastSuccess};
        const detail:DetailEvidence=error instanceof Error&&error.message==='parser-changed'?
          {...common,outcome:'unresolved',reason:'parser-changed'}:
          {...common,outcome:'failed',failure:sourceFailure(error)};
        this.store.saveDetailEvidence(detail);
        evidence.set(detail.observationId,detail);
        changed=true;
      } finally {
        this.detailControllers.delete(original);
        if(changed&&!this.stopped) {
          this.revision++;
          this.publishCandidates('details');
        }
      }
    };
    const active=new Map<string,{host:string;work:Promise<void>}>();
    const errors:unknown[]=[];
    let admitted=0;
    let rankedRevision=-1;
    let waiting:Observation[]=[];
    while(!this.stopped) {
      if(active.size<8&&admitted<80&&rankedRevision!==this.detailRevision) {
        waiting=ranked();
        rankedRevision=this.detailRevision;
      }
      while(active.size<8&&admitted<80&&waiting.length) {
        const first=waiting.slice(0,20),rest=waiting.slice(20);
        const offset=rest.length?this.detailCursor%rest.length:0;
        const background=[...rest.slice(offset),...rest.slice(0,offset)];
        const ordered=admitted%4===3?[...background,...first]:[...first,...background];
        const next=ordered.find(observation=>{
          const host=new URL(observation.url).hostname;
          return !this.listingPending(observation.url)&&this.hostRetryAt(observation.url)<=this.now()&&[...active.values()].filter(job=>job.host===host).length<2;
        });
        if(!next)break;
        if(background.includes(next))this.detailCursor++;
        waiting.splice(waiting.indexOf(next),1);
        visited.add(next.id);
        admitted++;
        const host=new URL(next.url).hostname;
        const work=Promise.resolve().then(()=>visit(next)).catch(error=>{errors.push(error);})
          .finally(()=>{active.delete(next.id);});
        active.set(next.id,{host,work});
      }
      if(!active.size)break;
      const wake=new Promise<void>(resolve=>{this.wakeDetails=resolve;});
      await Promise.race([wake,...[...active.values()].map(job=>job.work)]);
      this.wakeDetails=undefined;
    }
    await Promise.all([...active.values()].map(job=>job.work));
    if(!this.stopped)this.revision++;
    if(errors.length)throw errors[0];
  }
  private board(): Board {
    const feed = (keys: string[]): LeagueFeedStatus => {
      const partitions = keys.map(key => this.store.partition(key));
      const times = partitions.map(partition => partition?.at || 0);
      const oldest = Math.min(...times);
      return {week:partitions[0]?.week,scoresAt:oldest ? new Date(oldest).toISOString() : null,sourceAt:this.sourceTimes.size ? new Date(Math.max(...this.sourceTimes.values())).toISOString() : null,errors:keys.flatMap((key,index) => [
        ...(!times[index] || this.now()-times[index]>90000 ? [`${key.toUpperCase()} schedule is unavailable or stale.`] :
          this.errors.has(key) ? [`${key.toUpperCase()} schedule refresh failed; showing saved scores.`] : []),
        ...(this.errors.has(`${key}-horizon`) ? [`${key.toUpperCase()} future schedule is incomplete: ${this.errors.get(`${key}-horizon`)}`] : []),
        ...(this.errors.has(`${key}-history`) ? [`${key.toUpperCase()} recent schedule history is incomplete: ${this.errors.get(`${key}-history`)}`] : []),
      ]).concat(this.errors.has('working-feed-cache')?['Working feeds could not be saved for the next restart.']:[])};
    };
    const now = this.now();
    return {schemaVersion:2,revision:this.revision,scheduleState:this.scheduleState,finishedGameRetentionMinutes:this.store.finishedGameRetentionMinutes(),updatedAt:new Date(now).toISOString(),aliases:this.store.aliases(),leagues:{nfl:feed(['nfl']),ncaaf:feed(this.schedules.some(source=>source.id==='d2-d3')?['fbs','fcs','d2-d3']:['fbs','fcs']),nba:feed(['nba']),wnba:feed(['wnba']),nhl:feed(['nhl']),mlb:feed(['mlb']),f1:feed(['f1']),'nascar-cup':feed(['nascar-cup']),'nascar-truck':feed(['nascar-truck']),motogp:feed(['motogp']),motorsport:feed(['motorsport']),ufc:feed(['ufc']),boxing:feed(['boxing']),wwe:feed(['wwe']),tna:feed(['tna']),aew:feed(['aew']),wrestling:feed(['wrestling'])},games:this.games.filter(game => {
      if(game.lifecycle==='final')return now<game.graceEndsAt;
      return (game.partitions || []).some(key => now-(this.store.partition(key)?.at || 0)<24*3600000) ||
        game.finalObservedAt !== undefined || (this.candidates.get(game.id)||[]).some(candidate=>this.selectable(candidate)) ||
        [...this.sessions.values()].some(owned => owned.value.gameId===game.id);
    }).map(game => {
      const candidates = (this.candidates.get(game.id) || []).filter(candidate => this.selectable(candidate));
      return {...game,sourceUrl:candidates.length ? `/play/${encodeURIComponent(game.id)}` : undefined,sourceUrls:undefined};
    })};
  }
  private sweep(): void {
    const now = this.now();
    const due=[...this.finalDeadlines].filter(([id,deadline])=>deadline<=now&&!this.cleanedFinals.has(id)).map(([id])=>id);
    if(due.length){this.store.removeFinalEvidence(due,now);for(const id of due)this.cleanedFinals.add(id);this.revision++;}
    this.reconcileProbeJobs(false);
    const completedGames = new Set<string>();
    let removedSession=false;
    for (const [id,owned] of this.sessions) {
      owned.value=reconcileSession(owned.value,this.games.find(game => game.id===owned.value.gameId),now);
      if (owned.value.state==='closed' && owned.value.graceEndsAt !== null) completedGames.add(owned.value.gameId);
      if (now-owned.lastSeen>SESSION_LEASE_MS || owned.value.state==='closed') {this.sessions.delete(id);removedSession=true;}
    }
    for (const [id,candidates] of this.candidates) {
      const game = this.games.find(game => game.id===id);
      if (completedGames.has(id) || (this.finalDeadlines.get(id) || game?.graceEndsAt || Infinity)<=now) this.candidates.delete(id);
      else this.candidates.set(id,candidates.filter(candidate => this.currentCandidate(candidate) || [...this.sessions.values()].some(owned => owned.value.gameId===id && owned.value.candidateId===candidate.id)));
    }
    this.reconcileProbeJobs(false);
    if(removedSession){this.pumpProbes();this.scheduleProbeReplan();}
    if (now-this.lastStoreSweep >= 3600000) { this.store.sweep(now); this.lastStoreSweep=now; }
  }
  private sessionReply(session: Session): Reply {
    const game=this.games.find(game=>game.id===session.gameId);
    return {kind:'session',session,candidates:(this.candidates.get(session.gameId) || [])
      .filter(candidate => candidate.id===session.candidateId ||
        (this.currentCandidate(candidate)&&(this.feedGame(game)||this.retainedPlayable(candidate)||
          this.retainedWorkingCandidate(candidate))))
      .sort(this.candidateRanking()).map(candidate=>this.candidateSummary(candidate))};
  }
  private reconcileStreameastCandidates(snapshot?:ReadonlyMap<string,DetailEvidence>): void {
    for(const rows of this.candidates.values())for(const candidate of rows)
      this.publicationDeadlines.delete(`streameast:${this.probeKey(candidate)}`);
    if(!this.sources.some(source=>source.id==='streameast'))return;
    const stored=this.store.streameastCatalog();
    const detailEvidence=snapshot??new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    const current=stored.current?.catalog;
    const catalogs=[...(current?.state.kind==='complete'?[]:stored.lastComplete?[stored.lastComplete.catalog]:[]),...(current?[current]:[])];
    if(!catalogs.length)return;
    const currentUrls=new Set(current?.events.map(event=>event.url)||[]);
    const now=this.now();
    const match=this.eventMatcher(this.games);
    const currentListed=new Set<string>();
    for(const catalog of catalogs)for(const event of catalog.events) {
      if(catalog!==current&&currentUrls.has(event.url))continue;
      const category=catalog.categories[event.league];
      if(category.kind!=='collected')continue;
      const result=match(streameastObservation(event,category.at),streameastEvidence(event),now).match;
      const game=this.games.find(item=>item.id===(result.kind==='matched'?result.gameId:''));
      if(result.kind!=='matched'||!this.feedGame(game))continue;
      if(catalog===current)currentListed.add(game.id);
      const handoff=catalog===current||current?.categories[event.league]?.kind==='pending';
      const freshlyCollected=event.detail.kind==='collected'&&
        (handoff?browserEvidenceFresh(detailEvidence.get(`streameast:${event.url}`),event.detail.at,now):now-event.detail.at<ACTIVE_DISCOVERY_MS);
      let candidates=freshlyCollected?streameastCandidates(event,game.id):[];
      if(freshlyCollected) {
        const deadline=detailEvidence.get(`streameast:${event.url}`)?.nextEligibleAt??(event.detail.kind==='collected'?event.detail.at+ACTIVE_DISCOVERY_MS:0);
        for(const candidate of candidates)this.publicationDeadlines.set(`streameast:${this.probeKey(candidate)}`,deadline+(handoff?COLLECTION_SETTLE_MS:0));
      }
      if(catalog===current&&!freshlyCollected) {
        const publication=retainedBrowserPublication(event,category.at,detailEvidence.get(`streameast:${event.url}`),game,now);
        if(publication) {
          candidates=publication.players.map(player=>({...player,gameId:game.id,sourceIds:['streameast'],observedAt:publication.at}));
          for(const candidate of candidates)this.publicationDeadlines.set(`streameast:${this.probeKey(candidate)}`,publication.until);
        }
      }
      if(!freshlyCollected&&!candidates.length)continue;
      const previous=this.candidates.get(game.id)||[];
      const selected=this.pinnedCandidateIds(game.id,now);
      const retained=previous.filter(candidate=>!candidate.sourceIds.includes('streameast')||selected.has(candidate.id)||
        this.retainedPlayable(candidate)||this.retainedWorkingCandidate(candidate));
      this.candidates.set(game.id,[...new Map([...retained,...candidates]
        .map(candidate=>[candidate.id,candidate] as const)).values()]);
    }
    if(current?.state.kind==='complete')for(const [gameId,prior] of this.candidates)if(!currentListed.has(gameId)) {
      const selected=this.pinnedCandidateIds(gameId,now);
      this.candidates.set(gameId,prior.filter(candidate=>!candidate.sourceIds.includes('streameast')||selected.has(candidate.id)||
        this.retainedPlayable(candidate)||this.retainedWorkingCandidate(candidate)));
    }
  }
  private pinnedCandidateIds(gameId:string,now=this.now()):Set<string> {
    const game=this.games.find(row=>row.id===gameId);
    if(!game||game.finalObservedAt!==undefined&&(!game.graceEndsAt||now>=game.graceEndsAt))return new Set();
    return new Set([...this.sessions.values()].filter(owned=>owned.value.gameId===gameId&&
      owned.value.state!=='closed'&&now-owned.lastSeen<=SESSION_LEASE_MS).map(owned=>owned.value.candidateId));
  }
  private confirmedSportsurgeFinal(event:SportsurgeCatalog['events'][number],at:number,bindings:readonly SourceEventBinding[]):string|null {
    const observation=sportsurgeObservation(event,at);
    return this.finished.finishedGameId(observation,this.now())||
      this.finished.finishedBoundEvent(observation,event.id,bindings);
  }
  private reconcileSportsurgeCandidates(snapshot?:ReadonlyMap<string,DetailEvidence>):void {
    for(const rows of this.candidates.values())for(const candidate of rows)
      this.publicationDeadlines.delete(`sportsurge-v2:${this.probeKey(candidate)}`);
    if(!this.sources.some(source=>source.id==='sportsurge-v2'))return;
    const stored=this.store.sportsurgeCatalog();
    const detailEvidence=snapshot??new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    const current=stored.current;
    const assignments=current?sportsurgeCatalogView(current,this.games,this.now(),undefined,row=>this.observationDeadline(row)).games.flatMap(row=>{
      const event=current.catalog.events.find(event=>event.id===row.id&&event.url===row.url);
      return row.gameId!==null&&event&&current.catalog.categories[event.league].kind==='collected'?
        [{event,gameId:row.gameId}]:[];
    }):[];
    const retained=current?.catalog.events.flatMap(event=>{
      const category=current.catalog.categories[event.league];
      const detail=detailEvidence.get(`sportsurge-v2:${event.url}`);
      if(category.kind!=='collected'||event.detail.kind==='collected'&&browserEvidenceFresh(detail,event.detail.at,this.now()))return [];
      const assignment=assignments.find(row=>row.event.id===event.id&&row.event.url===event.url);
      const ownerId=detail?.lastSuccess?.publication?.event.gameId;
      const game=this.games.find(row=>row.id===(assignment?.gameId??ownerId));
      if(!this.feedGame(game))return [];
      const publication=retainedBrowserPublication(event,category.at,detail,game,this.now());
      if(!publication)return [];
      if(!assignment) {
        const result=this.inventoryMatch(sportsurgeObservation(event,category.at),{undated:'retained-live-detail',externalGameId:null},this.now()).match;
        if(result.kind!=='matched'||result.gameId!==game.id)return [];
        assignments.push({event,gameId:game.id});
      }
      return [{gameId:game.id,publication}];
    })??[];
    const reassigned=(candidate:Candidate)=>assignments.some(({event,gameId})=>
      gameId!==candidate.gameId&&sportsurgeEventCandidate(candidate,event));
    const next=sportsurgeCandidates({...stored,games:this.games,now:this.now(),freshness:row=>this.observationDeadline(row),detailFresh:(id,at)=>browserEvidenceFresh(detailEvidence.get(id),at,this.now())}).filter(candidate=>!reassigned(candidate));
    const byGame=new Map<string,Candidate[]>();
    for(const candidate of next) {
      const game=this.games.find(item=>item.id===candidate.gameId);
      if(!this.feedGame(game))continue;
      const locator=candidate.locator;
      const event=locator.provider==='sportsurge-v2'?current?.catalog.events.find(event=>event.id===locator.eventId&&sportsurgeEventCandidate(candidate,event)):undefined;
      const detail=event?detailEvidence.get(`sportsurge-v2:${event.url}`):undefined;
      if(detail)this.publicationDeadlines.set(`sportsurge-v2:${this.probeKey(candidate)}`,detail.nextEligibleAt+COLLECTION_SETTLE_MS);
      const rows=byGame.get(game.id)||[];
      rows.push(candidate);
      byGame.set(game.id,rows);
    }
    for(const {gameId,publication} of retained) {
      const candidates=publication.players.map(player=>({...player,gameId,sourceIds:['sportsurge-v2'],observedAt:publication.at}));
      for(const candidate of candidates)this.publicationDeadlines.set(`sportsurge-v2:${this.probeKey(candidate)}`,publication.until);
      byGame.set(gameId,[...new Map([...(byGame.get(gameId)||[]),...candidates].map(candidate=>[candidate.id,candidate])).values()]);
    }
    const superseded=[...this.candidates.values()].flat().filter(candidate=>{
      const locator=candidate.locator;
      if(locator.provider!=='sportsurge-v2')return false;
      return (byGame.get(candidate.gameId)||[]).some(current=>{
        const replacement=current.locator;
        return replacement.provider==='sportsurge-v2'&&replacement.expectedMatchup&&
          (candidate.id===current.id||candidate.id.startsWith(`${current.id}:`))&&
          locator.eventId===replacement.eventId&&locator.providerId===replacement.providerId&&locator.url===replacement.url&&
          JSON.stringify(locator)!==JSON.stringify(replacement);
      });
    });
    this.retireReassignedCandidates(superseded);
    for(const [gameId,prior] of this.candidates) {
      const retained=prior.filter(candidate=>!candidate.sourceIds.includes('sportsurge-v2') ||
        this.pinnedCandidateIds(gameId).has(candidate.id)||this.retainedPlayable(candidate)||
        this.retainedWorkingCandidate(candidate));
      const replacement=byGame.get(gameId)||[];
      this.candidates.set(gameId,[...new Map([...retained,...replacement].map(candidate=>[candidate.id,candidate])).values()]);
      byGame.delete(gameId);
    }
    for(const [gameId,rows] of byGame)this.candidates.set(gameId,rows);
    this.retireReassignedCandidates([...this.candidates.values()].flatMap(rows=>rows.filter(reassigned)));
  }
  private sourcesSnapshot():SourcesSnapshot;
  private sourcesSnapshot(view:'room'):RoomSourcesSnapshot;
  private sourcesSnapshot(view?:'room'):SourcesSnapshot|RoomSourcesSnapshot {
    const at=this.now();
    const day=feedCalendarDay(at);
    const probeLimit=this.probeAdmissionLimit(at);
    const freshness=new Map<string,boolean>();
    const freshGameIds=new Set(this.games.filter(game=>this.feedGame(game,freshness)).map(game=>game.id));
    const eligibleGameIds=new Set(this.games.filter(game=>{
      const candidates=this.candidates.get(game.id)||[];
      return feedInventoryEligible(game,at)||
        candidates.some(candidate=>this.retainedPlayable(candidate)||this.retainedWorkingCandidate(candidate));
    }).map(game=>game.id));
    const cache=this.inventoryCache;
    if (cache?.revision===this.revision && cache.probeLimit===probeLimit&&at>=cache.at && at-cache.at<15_000 && at<cache.proofExpiresAt&&day===cache.day&&
      eligibleGameIds.size===cache.gameIds.size&&
      [...eligibleGameIds].every(id=>cache.gameIds.has(id))&&
      freshGameIds.size===cache.freshGameIds.size&&
      [...freshGameIds].every(id=>cache.freshGameIds.has(id))) {
      if('sources' in cache.snapshot)return view==='room'?roomSources(cache.snapshot):cache.snapshot;
      if(view==='room')return cache.snapshot;
    }
    const attempts=this.store.sourceAttempts(),observations=this.store.observations();
    const sportsurgeCatalog=this.store.sportsurgeCatalog(),streameastCatalog=this.store.streameastCatalog();
    const deadlines=this.collectionDeadlines({at,attempts,observations,sportsurgeCatalog,streameastCatalog});
    const dates=feedWindow(at).days.map(day=>day.replaceAll('-',''));
    const scheduleScopes:SourcesSnapshot['scheduleScopes']=view==='room'?[]:[...new Set(this.schedules.map(source=>source.league))].map(league=>{
      const partitions=this.schedules.filter(source=>source.league===league);
      const checkedAt=Math.min(...partitions.map(source=>this.store.partition(source.id)?.at??0));
      const failed=partitions.some(source=>this.errors.has(source.id)||
        dates.some(date=>this.errors.get(`${source.id}-horizon`)?.includes(date)));
      const read:SourcesSnapshot['scheduleScopes'][number]['read']=failed?
        {kind:'incomplete',reason:'failed',checkedAt:checkedAt||null}:
        !checkedAt?{kind:'incomplete',reason:'pending',checkedAt:null}:
        at-checkedAt>90_000?{kind:'incomplete',reason:'stale',checkedAt}:
        this.refreshing?{kind:'incomplete',reason:'pending',checkedAt}:
        {kind:'complete',checkedAt};
      return {league,read};
    });
    const lastDiscoveryAt=Object.values(attempts).length ? Math.max(...Object.values(attempts).map(item=>item.at)) : null;
    const availableCandidates=new Map([...this.candidates].filter(([gameId])=>eligibleGameIds.has(gameId))
      .map(([gameId,rows])=>[gameId,rows.filter(candidate=>
        freshGameIds.has(gameId)||this.retainedPlayable(candidate)||this.retainedWorkingCandidate(candidate))]));
    let proofExpiresAt=Infinity;
    for(const candidates of availableCandidates.values())for(const candidate of candidates){
      const publicationUntil=Math.max(candidate.observedAt+ACTIVE_DISCOVERY_MS,
        ...candidate.sourceIds.map(sourceId=>this.publicationDeadlines.get(`${sourceId}:${this.probeKey(candidate)}`)??0));
      if(publicationUntil>=at)proofExpiresAt=Math.min(proofExpiresAt,publicationUntil+1);
      const health=this.terminal(candidate);
      if(health?.kind==='playable'&&this.freshPlayable(candidate))
        proofExpiresAt=Math.min(proofExpiresAt,health.checkedAt+WORKING_FRESH_MS);
    }
    const input:Parameters<typeof sourceInventory>[0]={at,revision:this.revision,lastDiscoveryAt,sources:this.sources,scheduleScopes,browserCollectorsAvailable:this.browserCollectorsAvailable,observationDeadline:row=>this.deadlineFor(row,deadlines),
      observations,games:this.games,visibleGameIds:eligibleGameIds,freshGameIds,candidates:availableCandidates,attempts,
      sourceEventBindings:this.store.sourceEventBindings(),
      details:this.store.detailEvidence(),collectionHistory:view==='room'?undefined:this.store.collectionHistory(at),
      availability:candidate=>this.availability(candidate),
      candidateIdentity:candidate=>this.probeKey(candidate),
      candidateEligible:candidate=>this.currentCandidate(candidate),
      compareCandidates:this.candidateRanking(),
      sportsurgeCatalog,streameastCatalog};
    const snapshot=view==='room'?roomSourceInventory(input):sourceInventory(input);
    if('sources' in snapshot)snapshot.checks={limit:Math.max(this.activeProbes.size,probeLimit),active:this.activeProbes.size,queued:this.probeQueue.length,completed:this.completedChecks,recent:[...this.recentChecks]};
    this.inventoryCache={at,day,revision:this.revision,probeLimit,gameIds:eligibleGameIds,freshGameIds,proofExpiresAt,snapshot};
    return snapshot;
  }
  private sportsurgeReuse(catalog:SportsurgeCatalog):Extract<Reply,{kind:'catalog-ack'}>['reuseDetails'] {
    if(!catalog.events.some(event=>event.detail.kind==='pending'&&catalog.categories[event.league].kind==='collected'))return;
    const history=Object.values(this.store.sportsurgeCatalog()).flatMap(stored=>stored?[stored]:[]);
    const detailEvidence=new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    const events:SportsurgeCatalog['events']=[];
    const match=this.eventMatcher(this.games,'inventory-live');
    let bytes=2;
    for(const event of catalog.events) {
      const category=catalog.categories[event.league];
      if(event.detail.kind!=='pending'||category.kind!=='collected')continue;
      const observation=sportsurgeObservation(event,category.at);
      const result=match(observation,sportsurgeEvidence(event,this.now()),this.now()).match;
      const gameId=result.kind==='matched'?result.gameId:event.sourceStatus==='live'&&event.kickoff===null&&
        result.kind==='unmatched'&&result.reason==='unverified-kickoff'&&result.possibleGameIds.length===1?result.possibleGameIds[0]:undefined;
      if(!gameId)continue;
      for(const stored of history) {
        const prior=stored.catalog.events.find(prior=>sameSportsurgeEvent(event,prior)&&prior.detail.kind==='collected');
        if(prior?.detail.kind!=='collected')continue;
        const detail=prior.detail;
        const polling=detailEvidence.get(observation.id);
        const game=this.games.find(game=>game.id===gameId);
        if(this.forcedDetailDiscovery.has(observation.id)||this.now()>=browserEventDeadline(polling,game,this.now()))continue;
        const reused={...event,detail:{...detail,retainedFromRunId:detail.retainedFromRunId||stored.catalog.runId}};
        const size=Buffer.byteLength(JSON.stringify(reused),'utf8')+1;
        if(bytes+size<=512*1024){events.push(reused);bytes+=size;}
        break;
      }
    }
    return events.length?{kind:'sportsurge-v2',events}:undefined;
  }
  private browserPollingPlan(kind:'sportsurge-v2'|'streameast',catalog:BrowserCatalog):Pick<Extract<Reply,{kind:'catalog-ack'}>,'nextSweepAt'|'reuseCategories'> {
    const history=kind==='sportsurge-v2'?this.store.sportsurgeCatalog():this.store.streameastCatalog();
    const current=Object.values<typeof history.current>(history).filter(stored=>stored!==null&&stored.catalog.runId!==catalog.runId)
      .sort((left,right)=>(right?.receivedAt??0)-(left?.receivedAt??0))[0]?.catalog;
    const starting=catalog.sequence===0&&Object.values(catalog.categories).every(category=>category.kind==='pending');
    const snapshot=starting&&current?current:catalog;
    let nextSweepAt=Math.min(...Object.keys(snapshot.categories).map(league=>{
      const category=snapshot.categories[league];
      const source=this.sources.find(source=>source.id===kind);
      const known=(source?.leagues??sourceCoverage(kind)).find(row=>row===league);
      return known?browserCategoryDeadline(snapshot,known,this.games,this.now()):category.kind==='pending'?this.now():category.at+SOURCE_REFRESH_MS;
    }));
    if(snapshot.events.some((event:BrowserCatalog['events'][number])=>snapshot.categories[event.league].kind==='collected')) {
      const evidence=new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
      const match=this.eventMatcher(this.games);
      for(const event of snapshot.events) {
        const category=snapshot.categories[event.league];
        if(category.kind!=='collected')continue;
        const observation=browserObservation(event,category.at);
        const result=match(observation,'sourceStatus' in event?sportsurgeEvidence(event,this.now()):streameastEvidence(event),this.now()).match;
        const game=result.kind==='matched'?this.games.find(game=>game.id===result.gameId):undefined;
        if(!this.feedGame(game))continue;
        nextSweepAt=Math.min(nextSweepAt,this.forcedDetailDiscovery.has(observation.id)?this.now():browserEventDeadline(evidence.get(observation.id),game,this.now()));
      }
    }
    if(!Number.isFinite(nextSweepAt))nextSweepAt=this.now()+SOURCE_REFRESH_MS;
    const plan={nextSweepAt:Math.max(this.now()+1000,nextSweepAt)};
    if(!starting)return plan;
    const prior=current;
    if(!prior)return plan;
    const sleeping=(prior:BrowserCatalog,league:Game['league'])=>prior.categories[league]?.kind==='collected'&&
      browserCategoryDeadline(prior,league,this.games,this.now())>this.now()&&!prior.rejectedGames.some(event=>event.league===league);
    if('catalogIssues' in prior) {
      const categories=(this.sources.find(source=>source.id===kind)?.leagues??sourceCoverage(kind)).flatMap(league=>{
        const category=prior.categories[league];
        return sleeping(prior,league)&&!prior.catalogIssues.some(issue=>issue.league===league)&&category?.kind==='collected'?[{league,at:category.at}]:[];
      })??[];
      const events=prior.events.filter(event=>categories.some(category=>category.league===event.league)).map(event=>({...event,detail:{kind:'pending' as const}}));
      return categories.length?{...plan,reuseCategories:{kind:'sportsurge-v2',categories,events}}:plan;
    }
    const categories=(this.sources.find(source=>source.id===kind)?.leagues??sourceCoverage(kind)).flatMap(league=>{
      const category=prior.categories[league];
      return sleeping(prior,league)&&category?.kind==='collected'?[{league,at:category.at}]:[];
    })??[];
    const events=prior.events.filter(event=>categories.some(category=>category.league===event.league)).map(event=>({...event,detail:{kind:'pending' as const}}));
    return categories.length?{...plan,reuseCategories:{kind:'streameast',categories,events}}:plan;
  }
  private persistBrowserPolling(catalog:BrowserCatalog):void {
    if(!catalog.events.some(event=>catalog.categories[event.league].kind==='collected'&&event.detail.kind!=='pending'))return;
    const evidence=new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    const match=this.eventMatcher(this.games);
    for(const event of catalog.events) {
      const category=catalog.categories[event.league];
      if(category.kind!=='collected'||event.detail.kind==='pending')continue;
      const observation=browserObservation(event,category.at);
      const prior=evidence.get(observation.id);
      if(prior&&prior.at>=event.detail.at)continue;
      this.forcedDetailDiscovery.delete(observation.id);
      const result=match(observation,'sourceStatus' in event?sportsurgeEvidence(event,this.now()):streameastEvidence(event),this.now()).match;
      const game=result.kind==='matched'?this.games.find(game=>game.id===result.gameId):undefined;
      const at=event.detail.at;
      const signature=browserPollingSignature(event,observation,game);
      const common={observationId:observation.id,generation:detailGeneration(observation),identity:detailIdentity(observation),at};
      const publicationIdentity=browserPublicationIdentity(event);
      const priorSuccess=prior?.lastSuccess?.identity===publicationIdentity?prior.lastSuccess:undefined;
      if(signature===null) {
        this.store.saveDetailEvidence({...common,outcome:'failed',failure:event.detail.kind==='failed'&&event.detail.reason==='rate-limited'?'rate-limited':event.detail.kind==='failed'&&event.detail.reason==='timeout'?'timed-out':'upstream-error',failures:(prior?.outcome==='failed'?prior.failures:0)+1,nextEligibleAt:retryDeadline(at),lastSuccess:priorSuccess});
        continue;
      }
      const polling={signature,unchangedChecks:prior?.polling?.signature===signature?Math.min(3,prior.polling.unchangedChecks+1):0};
      const owner=game?{gameId:game.id,date:game.date??null}:undefined;
      const players=game&&this.feedGame(game)?'sourceStatus' in event?sportsurgeEventCandidates(event,game.id):streameastCandidates(event,game.id):[];
      const lastSuccess=players.length&&owner?{identity:publicationIdentity,at,count:players.length,publication:{players,event:owner}}:undefined;
      this.store.saveDetailEvidence({...common,outcome:'resolved',players:[],polling,nextEligibleAt:detailDeadline({at,polling,game,published:players.length>0}),lastSuccess});
    }
  }
  private streameastReuse(catalog:StreameastCatalog):Extract<Reply,{kind:'catalog-ack'}>['reuseDetails'] {
    if(!catalog.events.some(event=>event.detail.kind==='pending'&&catalog.categories[event.league].kind==='collected'))return;
    const history=Object.values(this.store.streameastCatalog()).flatMap(stored=>stored?[stored]:[]);
    const detailEvidence=new Map(this.store.detailEvidence().map(row=>[row.observationId,row]));
    const events:StreameastCatalog['events']=[];
    const match=this.eventMatcher(this.games);
    let bytes=2;
    for(const event of catalog.events) {
      const category=catalog.categories[event.league];
      if(event.detail.kind!=='pending'||category.kind!=='collected')continue;
      const decision=match(streameastObservation(event,category.at),streameastEvidence(event),this.now());
      const game=this.games.find(game=>game.id===(decision.kind==='matched'?decision.gameId:''));
      if(!game)continue;
      for(const stored of history) {
        const prior=stored.catalog.events.find(prior=>sameStreameastEvent(event,prior)&&prior.detail.kind==='collected');
        if(prior?.detail.kind!=='collected')continue;
        const observation=streameastObservation(event,category.at);
        const polling=detailEvidence.get(observation.id);
        if(this.forcedDetailDiscovery.has(observation.id)||this.now()>=browserEventDeadline(polling,game,this.now()))continue;
        const detail=prior.detail;
        const reused={...event,detail:{...detail,retainedFromRunId:detail.retainedFromRunId||stored.catalog.runId}};
        const size=Buffer.byteLength(JSON.stringify(reused),'utf8')+1;
        if(bytes+size<=512*1024){events.push(reused);bytes+=size;}
        break;
      }
    }
    return events.length?{kind:'streameast',events}:undefined;
  }
  async command(command: Command): Promise<Reply> {
    if (this.stopped && command.kind!=='stop') return {kind:'error',status:503,message:'Pipeline is stopped.'};
    if (command.kind!=='stop') this.flushSchedulePublication();
    this.sweep();
    if (command.kind==='stop') { await this.stop(); return {kind:'ok'}; }
    if(command.kind==='collector-polling') {
      const catalog=command.source==='sportsurge-v2'?this.store.sportsurgeCatalog().current?.catalog:this.store.streameastCatalog().current?.catalog;
      return {kind:'collector-polling',nextSweepAt:catalog?this.browserPollingPlan(command.source,catalog).nextSweepAt??this.now():this.now()};
    }
    if (command.kind==='sportsurge-catalog') {
      const catalog=sanitizeSportsurgeCatalog(command.catalog,Object.values(this.store.sportsurgeCatalog()).flatMap(stored=>stored?[stored]:[]));
      if (!catalog) return {kind:'error',status:400,message:'Invalid Sportsurge catalog checkpoint.'};
      const pollingPlan=this.browserPollingPlan('sportsurge-v2',catalog);
      const reused=pollingPlan.reuseCategories;
      const planningCatalog:SportsurgeCatalog=reused?.kind==='sportsurge-v2'?{...catalog,
        categories:{...catalog.categories,...Object.fromEntries(reused.categories.map(category=>[category.league,{kind:'collected',at:category.at} satisfies SportsurgeCatalog['categories'][string]]))},
        events:reused.events}:catalog;
      const bindings=this.store.sourceEventBindings();
      const excluded=planningCatalog.events.filter(event=>{
        const category=planningCatalog.categories[event.league];
        const observedAt=category.kind==='pending'?catalog.startedAt:category.at;
        return !!this.confirmedSportsurgeFinal(event,observedAt,bindings)||
          !this.observationCollectionEligible(sportsurgeObservation(event,observedAt));
      });
      const skipDetailEventIds=[...new Set(excluded.map(event=>event.id))].filter(id=>
        planningCatalog.events.filter(event=>event.id===id).every(event=>excluded.includes(event)));
      const skipDetailEventUrls=excluded.filter(event=>!skipDetailEventIds.includes(event.id)).map(event=>event.url);
      const reuseDetails=this.sportsurgeReuse(planningCatalog);
      const decision=catalogDecision(this.store.sportsurgeCatalog().current,catalog);
      if (decision==='replay') {this.reconcileSportsurgeCandidates();this.reconcileProbeJobs();this.checkSources([],false);return {kind:'catalog-ack',...this.browserPollingPlan('sportsurge-v2',catalog),...(catalog.sequence===0?pollingPlan:{}),skipDetailEventIds,...(skipDetailEventUrls.length?{skipDetailEventUrls}:{}),...(reuseDetails?{reuseDetails}:{})};}
      if (decision==='rejected') return {kind:'error',status:409,message:'Sportsurge catalog checkpoint is obsolete.'};
      const receivedAt=this.now();
      const match=this.eventMatcher(this.games);
      const newBindings:SourceEventBinding[]=[];
      const observations=catalog.events.filter(event=>!skipDetailEventIds.includes(event.id)&&!skipDetailEventUrls.includes(event.url)).map(event=>{
        const category=catalog.categories[event.league];
        const observation=sportsurgeObservation(event,category.kind==='pending' ? catalog.startedAt : category.at);
        const result=match(observation,sportsurgeEvidence(event,receivedAt),receivedAt).match;
        if(category.kind==='collected'&&event.kickoff===null&&event.teams&&
          result.kind==='matched'){
          const game=this.games.find(game=>game.id===result.gameId);
          if(game&&this.scheduleFresh(game))newBindings.push({sourceId:'sportsurge-v2',eventId:event.id,
            url:event.url,league:event.league,teams:event.teams,gameId:game.id,observedAt:receivedAt});
        }
        return {observation,result};
      });
      this.store.saveSportsurgeCatalog({catalog,receivedAt},observations,newBindings);
      this.discoveryDeadlines=undefined;
      this.persistBrowserPolling(catalog);
      this.reconcileSportsurgeCandidates();
      this.reconcileProbeJobs();
      this.checkSources([],false);
      this.revision++;
      return {kind:'catalog-ack',...this.browserPollingPlan('sportsurge-v2',catalog),...(catalog.sequence===0?pollingPlan:{}),skipDetailEventIds,...(skipDetailEventUrls.length?{skipDetailEventUrls}:{}),...(reuseDetails?{reuseDetails}:{})};
    }
    if (command.kind==='streameast-catalog') {
      const catalog=sanitizeStreameastCatalog(command.catalog,this.now(),Object.values(this.store.streameastCatalog()).flatMap(stored=>stored?[stored]:[]),
        event=>!!this.finished.finishedGameId(streameastObservation(event,this.now()),this.now(),streameastEvidence(event).externalGameId??undefined));
      if(!catalog)return {kind:'error',status:400,message:'Invalid StreamEast catalog checkpoint.'};
      const pollingPlan=this.browserPollingPlan('streameast',catalog);
      const reused=pollingPlan.reuseCategories;
      const planningCatalog:StreameastCatalog=reused?.kind==='streameast'?{...catalog,
        categories:{...catalog.categories,...Object.fromEntries(reused.categories.map(category=>[category.league,{kind:'collected',at:category.at} satisfies StreameastCatalog['categories'][string]]))},
        events:reused.events}:catalog;
      const matchCheckpoint=this.eventMatcher(this.games);
      const skipDetailEventIds=planningCatalog.events.filter(event=>{
        const category=planningCatalog.categories[event.league];
        const expected=streameastEvidence(event).externalGameId??undefined;
        const observation=streameastObservation(event,category.kind==='pending'?catalog.startedAt:category.at);
        const result=matchCheckpoint(observation,streameastEvidence(event),this.now()).match;
        return !!this.finished.finishedGameId(observation,this.now(),expected)||
          !detailCandidateGameIds(result).length||!this.observationCollectionEligible(observation);
      }).map(event=>event.id);
      const reuseDetails=this.streameastReuse(planningCatalog);
      const decision=streameastDecision(this.store.streameastCatalog().current,catalog);
      if(decision==='replay'){this.reconcileStreameastCandidates();this.reconcileProbeJobs();this.checkSources([],false);return {kind:'catalog-ack',...pollingPlan,skipDetailEventIds,...(reuseDetails?{reuseDetails}:{})};}
      if(decision==='rejected')return {kind:'error',status:409,message:'StreamEast catalog checkpoint is obsolete.'};
      const receivedAt=this.now();
      const oldEvents=Object.values(this.store.streameastCatalog()).flatMap(stored=>stored?.catalog.events||[]);
      const match=this.eventMatcher(this.games);
      const observations=catalog.events.filter(event=>!skipDetailEventIds.includes(event.id)).map(event=>{
        const category=catalog.categories[event.league];
        const observation=streameastObservation(event,category.kind==='pending'?catalog.startedAt:category.at);
        return {observation,result:match(observation,streameastEvidence(event),receivedAt).match};
      });
      const visible=observations.filter(({observation,result})=>{
        const event=catalog.events.find(item=>`streameast:${item.url}`===observation.id);
        return !event?.espnEventId||result.kind==='matched'||result.reason!=='conflicting-game-id';
      });
      this.store.saveStreameastCatalog({catalog,receivedAt},visible);
      this.discoveryDeadlines=undefined;
      this.persistBrowserPolling(catalog);
      this.reconcileStreameastCandidates();
      this.retireReassignedCandidates(visible.flatMap(({observation,result})=>{
        if(result.kind!=='matched')return [];
        const event=catalog.events.find(row=>row.url===observation.url);
        if(!event||catalog.categories[event.league].kind!=='collected')return [];
        return oldEvents.filter(row=>row.id===event.id&&row.url===event.url).flatMap(row=>{
          const prior=match(streameastObservation(row,receivedAt),streameastEvidence(row),receivedAt).match;
          if(prior.kind!=='matched'||prior.gameId===result.gameId)return [];
          return (this.candidates.get(prior.gameId)||[]).filter(candidate=>candidate.sourceIds.includes('streameast')&&
            streameastCandidates(row,prior.gameId).some(previous=>previous.id===candidate.id&&
              JSON.stringify(previous.locator)===JSON.stringify(candidate.locator)));
        });
      }));
      this.reconcileProbeJobs();
      this.checkSources([],false);
      this.revision++;
      return {kind:'catalog-ack',...this.browserPollingPlan('streameast',catalog),...(catalog.sequence===0?pollingPlan:{}),skipDetailEventIds,...(reuseDetails?{reuseDetails}:{})};
    }
    if (command.kind==='refresh') { await this.refresh(true); return {kind:'ok'}; }
    if (command.kind==='set-retention') {
      this.store.setFinishedGameRetentionMinutes(command.minutes);
      this.cleanedFinals.clear();
      this.rebuild();
      this.sweep();
      return {kind:'board',board:this.board()};
    }
    if (command.kind==='board') { void this.refresh(); this.flushSchedulePublication(); return {kind:'board',board:this.board()}; }
    if (command.kind==='sources') return {kind:'sources',snapshot:this.sourcesSnapshot()};
    if (command.kind==='room-sources') return {kind:'room-sources',snapshot:this.sourcesSnapshot('room')};
    if (command.kind==='check-sources') {
      const listed=new Set(this.games.map(game=>game.id));
      const requested=command.gameIds.filter(gameId=>listed.has(gameId));
      if(!requested.length)return {kind:'error',status:404,message:'Game is no longer listed.'};
      const gameIds=requested.filter(id=>this.feedGame(this.games.find(game=>game.id===id)));
      if(!gameIds.length)return {kind:'error',status:409,message:'Feed checks are available for live games and games scheduled today or tomorrow in America/Chicago.'};
      this.checkSources(gameIds,command.retry);
      return {kind:'ok'};
    }
    if (command.kind==='close') {
      if(this.sessions.delete(command.sessionId)){this.pumpProbes();this.scheduleProbeReplan();}
      return {kind:'ok'};
    }
    if (command.kind==='open') {
      const gameId = this.store.aliases()[command.gameId] || command.gameId;
      const game = this.games.find(game=>game.id===gameId);
      const retainedFinal=game?.lifecycle==='final'&&this.now()<game.graceEndsAt&&
        (this.candidates.get(gameId)||[]).some(candidate=>this.selectable(candidate));
      if(!command.manual&&game&&!feedEligible(game,this.now())&&!combatListingFeedEligible(game,this.now())&&!retainedFinal)return {kind:'error',status:409,
        message:'Listed feeds are available for live games and games scheduled today or tomorrow in America/Chicago.'};
      const prior = command.requestId ? [...this.sessions.values()].find(owned => owned.requestId===command.requestId && owned.value.gameId===gameId && (owned.value.candidateId==='manual')===command.manual) : undefined;
      if (prior) {
        prior.value=reconcileSession(prior.value,game,this.now());
        if (prior.value.state!=='closed') {
          prior.lastSeen=this.now();
          const candidates=(this.candidates.get(gameId)||[]).filter(candidate=>candidate.id===prior.value.candidateId||
            (this.currentCandidate(candidate)&&(command.manual||this.visibleListedCandidate(candidate))))
            .sort(this.candidateRanking());
          return {kind:'playback',playback:{session:prior.value,candidates:candidates.map(candidate=>this.candidateSummary(candidate))}};
        }
      }
      if (!game || game.finalObservedAt!==undefined&&(!retainedFinal||command.manual) || (command.manual ? !this.scheduleFresh(game) :
        !this.feedGame(game) && !(this.candidates.get(gameId)||[]).some(candidate=>this.selectable(candidate))))
        return {kind:'error',status:409,message:'This game is finished or its schedule needs a refresh.'};
      const candidates = (this.candidates.get(gameId) || []).filter(candidate => this.currentCandidate(candidate)&&
        (command.manual||this.visibleListedCandidate(candidate))).sort(this.candidateRanking());
      if (command.manual && command.initialCandidateId) return {kind:'error',status:400,message:'A manual feed cannot select a listed server.'};
      const playable=candidates.filter(candidate=>this.selectable(candidate));
      if(!command.manual&&!playable.length){
        if(game.lifecycle!=='final')this.checkSources([gameId],false);
        return {kind:'error',status:404,message:'No playable server has been verified yet.'};
      }
      const initialCandidate=command.initialCandidateId ? playable.find(candidate=>candidate.id===command.initialCandidateId) : playable[0];
      const candidateId=command.manual ? 'manual' : initialCandidate?.id;
      if (!candidateId) return {kind:'error',status:404,message:'This server is no longer verified playable.'};
      if (this.sessions.size>=32) return {kind:'error',status:429,message:'Too many playback sessions.'};
      const session: Session = game.lifecycle==='final' ?
        {id:this.id(),gameId,candidateId,generation:0,state:'draining',graceEndsAt:game.graceEndsAt} :
        {id:this.id(),gameId,candidateId,generation:0,state:'active',graceEndsAt:null};
      this.sessions.set(session.id,{value:session,lastSeen:this.now(),refreshes:0,drainRefreshes:0,phase:{kind:'cycling'},requestId:command.requestId,
        selection:initialCandidate?this.selectionOwner(initialCandidate):undefined,
        recovery:{attempted:[],cooled:{},failures:{},cycleStartedAt:this.now()}});
      if(game.lifecycle!=='final')this.checkSources([gameId],false);
      return {kind:'playback',playback:{session,candidates:candidates.map(candidate=>this.candidateSummary(candidate))}};
    }
    if(command.kind==='authorize'){
      const trial=this.verificationSessions.get(command.sessionId);
      if(trial){
        const {job,target}=trial;
        const candidate=(this.candidates.get(target.gameId)||[]).find(row=>row.id===target.candidateId);
        if(command.candidateId!==target.candidateId||command.generation!==target.generation||
          this.now()>=trial.deadline||job.controller.signal.aborted||this.activeProbes.get(job.key)!==job||
          job.revision!==(this.healthRevision.get(job.key)||0)||!this.currentProbeJob(job,false)||
          !candidate||this.probeKey(candidate)!==job.key||!this.ownedCandidate(candidate,job.owner))
          return {kind:'error',status:410,message:'Verification grant expired.'};
        return {kind:'verification-authorized',candidate,target,deadline:trial.deadline};
      }
    }
    const owned = this.sessions.get(command.sessionId);
    if (!owned) return {kind:'error',status:410,message:'Playback session ended.'};
    const session = owned.value;
    const candidates = this.candidates.get(session.gameId) || [];
    if (command.kind==='authorize') {
      const candidate = candidates.find(candidate=>candidate.id===command.candidateId);
      if (!candidate || session.candidateId!==candidate.id || session.generation!==command.generation||
        !this.currentSelection(candidate,owned.selection)) return {kind:'error',status:410,message:'Stream generation expired.'};
      owned.lastSeen=this.now();
      return {kind:'authorized',candidate,session};
    }
    if(command.kind==='playback-evidence') {
      if(session.candidateId==='manual'||session.candidateId!==command.candidateId||session.generation!==command.generation||session.state==='closed')
        return {kind:'error',status:410,message:'Stream generation expired.'};
      const candidate=candidates.find(row=>row.id===command.candidateId);
      if(!candidate)return {kind:'error',status:410,message:'Stream generation expired.'};
      const selection=owned.selection;
      if(!selection||!this.currentSelection(candidate,selection))return {kind:'error',status:410,message:'Stream generation expired.'};
      const at=this.now();
      if(owned.lastEvidence?.generation===command.generation&&at-owned.lastEvidence.at<60_000)return {kind:'ok'};
      owned.lastEvidence={generation:command.generation,at};
      const key=this.probeKey(candidate);
      this.healthRevision.set(key,(this.healthRevision.get(key)||0)+1);
      this.recordTerminal(candidate,{kind:'playable',proof:command.evidence,checkedAt:at,owner:selection.owner});
      this.probeQueue=this.probeQueue.filter(job=>job.key!==key);
      const deferred=this.deferredProbes.get(key);
      if(deferred){clearTimeout(deferred.timer);this.deferredProbes.delete(key);}
      this.activeProbes.get(key)?.controller.abort();
      this.probePump??=setImmediate(()=>{this.probePump=undefined;this.pumpProbes();});
      this.decoded.set(key,{at,startupMs:command.evidence.startupMs});
      this.revision++;
      return {kind:'ok'};
    }
    if (command.generation!==session.generation) return {kind:'error',status:409,message:'Playback state changed. Refresh this stream.'};
    owned.lastSeen=this.now();
    if(session.state==='active'&&session.candidateId!=='manual'&&!candidates.some(candidate=>candidate.id===session.candidateId)) {
      const alternative=candidates.filter(candidate=>this.selectable(candidate)).sort(this.candidateRanking())[0];
      if(!alternative)return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:this.now()+1000};
      session.candidateId=alternative.id;
      session.generation++;
      owned.selection=this.selectionOwner(alternative);
      owned.refreshes=0;
      owned.recovery={attempted:[],cooled:{},failures:{},cycleStartedAt:this.now()};
      owned.phase={kind:'cycling'};
      return this.sessionReply(session);
    }
    if (session.state==='draining') {
      owned.phase={kind:'cycling'};
      if(command.candidateId&&command.candidateId!==session.candidateId) {
        const selected=candidates.find(candidate=>candidate.id===command.candidateId&&this.selectable(candidate));
        if(!selected)
          return {kind:'error',status:404,message:'This server is no longer verified playable.'};
        session.candidateId=command.candidateId;
        session.generation++;
        owned.selection=this.selectionOwner(selected);
        owned.drainRefreshes=0;
        return this.sessionReply(session);
      }
      if(command.failure&&session.candidateId!=='manual') {
        const failed=candidates.find(candidate=>candidate.id===session.candidateId);
        if(failed&&this.currentSelection(failed,owned.selection)) {
          const key=this.probeKey(failed),at=this.now();
          this.healthRevision.set(key,(this.healthRevision.get(key)||0)+1);
          this.recordTerminal(failed,{kind:'unavailable',reason:'playback',checkedAt:at,retryAt:at+FAILED_RETRY_MS});
          this.decoded.delete(key);
        }
        const next=candidates.filter(candidate=>this.selectable(candidate)).sort(this.candidateRanking())[0];
        if(next) {
          session.candidateId=next.id;
          session.generation++;
          owned.selection=this.selectionOwner(next);
          owned.drainRefreshes=0;
          return this.sessionReply(session);
        }
      }
      if (command.failure || command.retry) {
        if (owned.drainRefreshes>=1) return {kind:'error',status:503,code:'drain-exhausted',message:'This game has ended. The current stream cannot refresh again.'};
        owned.drainRefreshes++;
        session.generation++;
      }
      return this.sessionReply(session);
    }
    if (command.retry) {
      owned.recovery={...owned.recovery,attempted:[],cycleStartedAt:this.now()};
      owned.refreshes=0;
      owned.phase={kind:'cycling'};
      if (session.candidateId!=='manual') session.generation++;
      return this.sessionReply(session);
    }
    if (session.candidateId==='manual') return this.sessionReply(session);
    if (command.candidateId && command.candidateId!==session.candidateId) {
      const selected=candidates.find(candidate=>candidate.id===command.candidateId&&this.selectable(candidate));
      if (!selected) return {kind:'error',status:404,message:'This server is no longer verified playable.'};
      session.candidateId=command.candidateId;
      session.generation++;
      owned.selection=this.selectionOwner(selected);
      owned.refreshes=0;
      owned.recovery={...owned.recovery,attempted:[],cycleStartedAt:this.now()};
      owned.phase={kind:'cycling'};
      return this.sessionReply(session);
    }
    if (owned.phase.kind==='exhausted') {
      const phase=owned.phase;
      const fresh=candidates.filter(candidate=>{
        if(this.selectable(candidate))return true;
        const health=this.terminal(candidate);
        return this.currentCandidate(candidate)&&health?.kind==='unavailable'&&
          health.reason==='playback'&&health.retryAt<=this.now();
      });
      const cycle={...owned.recovery,attempted:[]};
      const added=fresh.filter(candidate=>!phase.knownIds.includes(candidate.id));
      const eligible=this.now()<phase.until?added:fresh;
      const next=nextCandidate(eligible,cycle,this.now(),session.candidateId,this.candidateRanking())||
        (this.now()>=phase.until?nextCandidate(eligible,cycle,this.now(),undefined,this.candidateRanking()):undefined);
      if (next) {
        owned.recovery={...owned.recovery,attempted:[],cycleStartedAt:this.now()};
        owned.refreshes=0;
        owned.phase={kind:'cycling'};
        session.candidateId=next.id;
        session.generation++;
        owned.selection=this.selectionOwner(next);
        return this.sessionReply(session);
      }
      if (this.now()>=phase.until) owned.phase={kind:'exhausted',until:Math.min(...fresh.map(candidate=>Math.max(this.now()+1000,owned.recovery.cooled[candidate.id]||this.now()+30000)),this.now()+30000),knownIds:fresh.map(candidate=>candidate.id)};
      return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:owned.phase.until};
    }
    if (command.failure) {
      const failed=candidates.find(candidate=>candidate.id===session.candidateId);
      if(failed&&this.currentSelection(failed,owned.selection)){
        const key=this.probeKey(failed),at=this.now();
        this.healthRevision.set(key,(this.healthRevision.get(key)||0)+1);
        this.recordTerminal(failed,{kind:'unavailable',reason:'playback',checkedAt:at,retryAt:at+FAILED_RETRY_MS});
        this.decoded.delete(key);
        this.projectCandidates();
        this.revision++;
      }
      if (owned.refreshes<1) { owned.refreshes++; session.generation++; return this.sessionReply(session); }
      owned.recovery=failedCandidate(owned.recovery,session.candidateId,this.now());
      owned.refreshes=0;
      const next=nextCandidate(candidates.filter(candidate => this.selectable(candidate)),owned.recovery,this.now(),session.candidateId,this.candidateRanking());
      if (!next) {
        const fresh=candidates.filter(candidate=>this.selectable(candidate));
        owned.phase={kind:'exhausted',until:Math.min(...fresh.map(candidate=>Math.max(this.now()+1000,owned.recovery.cooled[candidate.id]||this.now()+30000)),this.now()+30000),knownIds:fresh.map(candidate=>candidate.id)};
        return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:owned.phase.until};
      }
      session.candidateId=next.id; session.generation++;
      owned.selection=this.selectionOwner(next);
    }
    return this.sessionReply(session);
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped=true;
    clearInterval(this.tickTimer);
    clearImmediate(this.probePump);
    clearImmediate(this.probeReplan);
    clearImmediate(this.candidatePublication?.timer);
    clearImmediate(this.schedulePublication);
    this.schedulePublication=undefined;
    this.schedulePublicationSources.clear();
    clearImmediate(this.discoveryLaunch);
    this.discoveryLaunch=undefined;
    this.controller.abort();
    for(const job of this.activeProbes.values())job.controller.abort();
    this.probeQueue=[];
    for(const deferred of this.deferredProbes.values())clearTimeout(deferred.timer);
    this.deferredProbes.clear();
    await Promise.allSettled([this.refreshing,this.discovering,this.detailWork,...[...this.activeProbes.values()].map(job=>job.promise)]);
    await this.closeSchedule?.();
    this.sessions.clear(); this.candidates.clear(); this.store.close();
  }
}
