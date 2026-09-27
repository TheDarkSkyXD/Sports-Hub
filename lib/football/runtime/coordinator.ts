import { createObservationMatcher, matchObservation, mergeSchedulePartitions } from '../domain/matching.ts';
import { SESSION_LEASE_MS, compareCandidates, failedCandidate, nextCandidate, reconcileSession } from '../domain/lifecycle.ts';
import { sourceInventory } from '../domain/source-inventory.ts';
import { catalogDecision, sanitizeSportsurgeCatalog, sportsurgeObservation } from '../domain/sportsurge-catalog.ts';
import { sanitizeStreameastCatalog, streameastDecision, streameastObservation, streameastCandidates, verifiedStreameastMatch } from '../domain/streameast-catalog.ts';
import type { Recovery } from '../domain/lifecycle.ts';
import type { FootballDependencies, FootballRepository } from '../domain/ports.ts';
import { candidateSummary, type Board, type Candidate, type Command, type Game, type LeagueFeedStatus, type Observation, type Reply, type Session, type SourcesSnapshot } from '../shared.ts';

type RecoveryPhase = {kind:'cycling'} | {kind:'exhausted';until:number;knownIds:string[]};
type OwnedSession = {value:Session;lastSeen:number;recovery:Recovery;refreshes:number;drainRefreshes:number;phase:RecoveryPhase;requestId?:string};
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
  private finalDeadlines = new Map<string,number>();
  private candidates = new Map<string,Candidate[]>();
  private sessions = new Map<string,OwnedSession>();
  private errors = new Map<string,string>();
  private revision = 0;
  private refreshing: Promise<void> | undefined;
  private queuedRefresh: Promise<void> | undefined;
  private discovering: Promise<void> | undefined;
  private lastDiscovery = 0;
  private lastSchedule = 0;
  private stopped = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private sourceTimes = new Map<string,number>();
  private sourceFailures = new Map<string,number>();
  private sourceRetry = new Map<string,number>();
  private lastStoreSweep = 0;
  private detailCursor = 0;
  private inventoryCache: {at:number;revision:number;snapshot:SourcesSnapshot} | undefined;
  private readonly now: () => number;
  private readonly desktopCollectorsAvailable:boolean;
  private readonly schedules: FootballDependencies['schedules'];
  private readonly sources: FootballDependencies['sources'];
  private readonly fetchSchedule: FootballDependencies['readSchedule'];
  private readonly fetchMembership: FootballDependencies['readSeasonMembership'];
  private readonly fetchHtml: FootballDependencies['readHtml'];
  private readonly parseListings: FootballDependencies['parseListings'];
  private readonly enrichObservation: FootballDependencies['enrichObservation'];
  private readonly compatiblePlayers: FootballDependencies['compatiblePlayers'];
  private readonly retryAfterMs: FootballDependencies['retryAfterMs'];
  private readonly id: () => string;
  constructor(dependencies: FootballDependencies) {
    this.now = dependencies.now;
    this.desktopCollectorsAvailable=dependencies.desktop===true;
    this.schedules = dependencies.schedules;
    this.sources = dependencies.sources;
    this.fetchSchedule = dependencies.readSchedule;
    this.fetchMembership = dependencies.readSeasonMembership;
    this.fetchHtml = dependencies.readHtml;
    this.parseListings = dependencies.parseListings;
    this.enrichObservation = dependencies.enrichObservation;
    this.compatiblePlayers = dependencies.compatiblePlayers;
    this.retryAfterMs = dependencies.retryAfterMs;
    this.id = dependencies.id;
    this.store = dependencies.store;
    this.rebuild();
  }
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => { this.sweep(); void this.refresh(); },15000);
    void this.refresh();
  }
  private rebuild(): void {
    const finals = this.store.finals();
    const previous = new Map(finals.map(game => [game.id,game]));
    this.finalDeadlines = new Map(finals.flatMap(game => game.graceEndsAt === undefined ? [] : [[game.id,game.graceEndsAt]]));
    const partitions = this.schedules.map(source => this.store.partition(source.id)?.games || []);
    const before = this.games.map(game => game.id).join('|');
    this.games = mergeSchedulePartitions(partitions).map(game => {
      const final = previous.get(game.id);
      const current = final ? {...final,partitions:game.partitions} : game;
      if (current.league !== 'ncaaf' || !current.season) return current;
      const membership = this.store.membership(current.season);
      if (!membership) return current;
      const team = (value:Game['home']):Game['home'] => {
        const id = value.id?.replace(/^espn:ncaaf:/,'');
        const subdivision = id ? membership.teams[id] : undefined;
        return subdivision ? {...value,membership:{subdivision,season:membership.season,observedAt:membership.at,source:'espn-core'}} : value;
      };
      return {...current,home:team(current.home),away:team(current.away)};
    });
    if (before !== this.games.map(game => game.id).join('|')) {
      for (const observation of this.store.observations()) {
        if (this.now()-observation.observedAt > 30*60000) continue;
        this.store.observe(observation,matchObservation(observation,this.games,this.now()));
      }
      this.lastDiscovery = 0;
    }
    this.reconcileStreameastCandidates();
    this.revision++;
  }
  async refresh(force = false): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      if (!force) return this.refreshing;
      this.queuedRefresh ??= this.refreshing.then(() => this.refresh(true)).finally(() => { this.queuedRefresh=undefined; });
      return this.queuedRefresh;
    }
    const now = this.now();
    if (!force && now - this.lastSchedule < 30000) return;
    this.lastSchedule = now;
    this.refreshing = (async () => {
      await Promise.all(this.schedules.map(async source => {
        try {
          const result = await this.fetchSchedule(source,now,this.controller.signal);
          if (this.stopped) return;
          this.store.savePartition(source.id,{...result,at:this.now()});
          this.errors.delete(source.id);
        } catch(error) { if (!this.stopped) this.errors.set(source.id,errorCode(error)); }
      }));
      if (this.stopped) return;
      const seasons = [...new Set(this.schedules.filter(source => source.league==='ncaaf').flatMap(source => this.store.partition(source.id)?.games.map(game => game.season).filter((year):year is number => year !== undefined) || []))];
      await Promise.all(seasons.map(async season => {
        const cached = this.store.membership(season);
        if (cached && this.now()-cached.at<24*3600000) return;
        try {
          const membership = await this.fetchMembership(season,this.controller.signal);
          if (!this.stopped) { this.store.saveMembership(membership); this.errors.delete(`membership-${season}`); }
        } catch(error) { if (!this.stopped) this.errors.set(`membership-${season}`,errorCode(error)); }
      }));
      if (this.stopped) return;
      this.rebuild();
      this.sweep();
      if (now - this.lastDiscovery >= 120000 && !this.discovering) {
        this.lastDiscovery = now;
        this.discovering = this.discover().catch(error => { if (!this.stopped) this.errors.set('discovery',errorCode(error)); }).finally(() => { this.discovering=undefined; });
      }
    })().finally(() => { this.refreshing=undefined; });
    return this.refreshing;
  }
  private scheduleFresh(game: Game): boolean {
    const keys = game.partitions?.length ? game.partitions : game.league === 'nfl' ? ['nfl'] : [];
    return keys.length > 0 && keys.every(key => !this.errors.has(key) && this.now()-(this.store.partition(key)?.at || 0) <= 90000);
  }
  private async discover(): Promise<void> {
    const observations: Observation[] = [];
    await runBounded(this.sources.filter(source => source.kind !== 'pending' && source.kind !== 'browser-catalog'), source => source.family === 'unknown' ? new URL(source.url).hostname : source.family,4,1,async source => {
      if (this.stopped || (this.sourceRetry.get(source.id) || 0) > this.now()) return;
      try {
        const html = await this.fetchHtml(source.url,this.controller.signal);
        const at = this.now();
        const result = this.parseListings(source,html,at);
        if (this.stopped) return;
        this.store.source(source.id,{at,outcome:result.outcome,count:result.observations.length});
        observations.push(...result.observations.slice(0,1000));
        this.sourceTimes.set(source.id,at);
        this.sourceFailures.delete(source.id);
        this.sourceRetry.delete(source.id);
      } catch(error) {
        if (this.stopped) return;
        const count = (this.sourceFailures.get(source.id) || 0) + 1;
        this.sourceFailures.set(source.id,count);
        const backoff = Math.min(600000,60000*2**(count-1));
        this.sourceRetry.set(source.id,this.now()+Math.max(backoff,this.retryAfterMs(error)));
        this.store.source(source.id,{at:this.now(),outcome:'failed',count:0,error:errorCode(error)});
      }
    });
    if (this.stopped) return;
    for (const observation of observations) this.store.observe(observation,matchObservation(observation,this.games,this.now()));
    const catalogIds = new Set(this.sources.filter(source => source.kind === 'catalog').map(source => source.id));
    const eligible = observations.filter(observation => {
      if (catalogIds.has(observation.sourceId)) return false;
      if (!observation.teams) return false;
      const match = matchObservation(observation,this.games,this.now());
      return match.kind === 'matched' || match.reason === 'unverified-kickoff' && match.possibleGameIds.length > 0;
    });
    const viewed = new Set([...this.sessions.values()].map(session => session.value.gameId));
    const ranked = eligible.sort((a,b) => {
      const score = (observation:Observation) => {
        const match = matchObservation(observation,this.games,this.now());
        const game = this.games.find(game => game.id === (match.kind === 'matched' ? match.gameId : match.possibleGameIds[0]));
        return Number(viewed.has(game?.id || ''))*100 + Number(game?.lifecycle === 'live')*10 + Number(observation.sourceId === 'sportsurge');
      };
      return score(b)-score(a);
    });
    const first = ranked.slice(0,20);
    const rest = ranked.slice(20);
    const offset = rest.length ? this.detailCursor % rest.length : 0;
    const selected = [...first,...rest.slice(offset),...rest.slice(0,offset)].slice(0,80);
    this.detailCursor += Math.max(0,80-first.length);
    await runBounded(selected, observation => new URL(observation.url).hostname,8,2,async original => {
      if (this.stopped) return;
      let observation = original;
      try {
        const html = await this.fetchHtml(original.url,this.controller.signal);
        if (this.stopped) return;
        observation = this.enrichObservation(original,html);
        const match = matchObservation(observation,this.games,this.now());
        this.store.observe(observation,match);
        if (match.kind !== 'matched') return;
        const game = this.games.find(game => game.id === match.gameId);
        if (!game || !this.scheduleFresh(game) || game.finalObservedAt !== undefined) return;
        const players = this.compatiblePlayers(game.id,observation,html,this.now());
        if (!players.length) {
          this.store.observe(observation,{kind:'unmatched',reason:'compatible-media-not-resolved',possibleGameIds:[game.id]});
          return;
        }
        const byId = new Map((this.candidates.get(game.id) || []).map(candidate => [candidate.id,candidate]));
        for (const candidate of players) {
          const previous = byId.get(candidate.id);
          if (previous && JSON.stringify(previous.locator) !== JSON.stringify(candidate.locator)) continue;
          byId.set(candidate.id,{...candidate,sourceIds:[...new Set([...(previous?.sourceIds || []),...candidate.sourceIds])]});
        }
        this.candidates.set(game.id,[...byId.values()]);
        if (observation.legacyId) this.store.alias(observation.legacyId,game.id);
      } catch(error) {
        if (!this.stopped) this.store.observe(observation,{kind:'unmatched',reason:errorCode(error),possibleGameIds:[]});
      }
    });
    this.revision++;
  }
  private board(): Board {
    const feed = (keys: string[]): LeagueFeedStatus => {
      const partitions = keys.map(key => this.store.partition(key));
      const times = partitions.map(partition => partition?.at || 0);
      const oldest = Math.min(...times);
      return {week:partitions[0]?.week,scoresAt:oldest ? new Date(oldest).toISOString() : null,sourceAt:this.sourceTimes.size ? new Date(Math.max(...this.sourceTimes.values())).toISOString() : null,errors:keys.flatMap(key => this.errors.has(key) || !oldest || this.now()-oldest>90000 ? [`${key.toUpperCase()} schedule is unavailable or stale.`] : [])};
    };
    const now = this.now();
    return {schemaVersion:2,revision:this.revision,updatedAt:new Date(now).toISOString(),aliases:this.store.aliases(),leagues:{nfl:feed(['nfl']),ncaaf:feed(['fbs','fcs'])},games:this.games.filter(game => {
      return (game.partitions || []).some(key => now-(this.store.partition(key)?.at || 0)<24*3600000) || game.finalObservedAt !== undefined || [...this.sessions.values()].some(owned => owned.value.gameId===game.id);
    }).map(game => {
      if (game.lifecycle === 'final') return {...game,sourceUrl:undefined,sourceUrls:undefined};
      const candidates = (this.candidates.get(game.id) || []).filter(candidate => now-candidate.observedAt<30*60000);
      return {...game,sourceUrl:this.scheduleFresh(game) && candidates.length ? `/play/${encodeURIComponent(game.id)}` : undefined,sourceUrls:undefined};
    })};
  }
  private sweep(): void {
    const now = this.now();
    const completedGames = new Set<string>();
    for (const [id,owned] of this.sessions) {
      owned.value=reconcileSession(owned.value,this.games.find(game => game.id===owned.value.gameId),now);
      if (owned.value.state==='closed' && owned.value.graceEndsAt !== null) completedGames.add(owned.value.gameId);
      if (now-owned.lastSeen>SESSION_LEASE_MS || owned.value.state==='closed') this.sessions.delete(id);
    }
    for (const [id,candidates] of this.candidates) {
      const game = this.games.find(game => game.id===id);
      if (completedGames.has(id) || (this.finalDeadlines.get(id) || game?.graceEndsAt || Infinity)<=now) this.candidates.delete(id);
      else this.candidates.set(id,candidates.filter(candidate => now-candidate.observedAt<30*60000 || [...this.sessions.values()].some(owned => owned.value.gameId===id && owned.value.candidateId===candidate.id)));
    }
    if (now-this.lastStoreSweep >= 3600000) { this.store.sweep(now); this.lastStoreSweep=now; }
  }
  private sessionReply(session: Session): Reply {
    const now=this.now();
    return {kind:'session',session,candidates:(this.candidates.get(session.gameId) || []).filter(candidate => candidate.id===session.candidateId || now-candidate.observedAt<30*60000).map(candidateSummary)};
  }
  private reconcileStreameastCandidates(): void {
    const stored=this.store.streameastCatalog();
    const current=stored.current?.catalog;
    const catalogs=[...(current?.state.kind==='complete'?[]:stored.lastComplete?[stored.lastComplete.catalog]:[]),...(current?[current]:[])];
    if(!catalogs.length)return;
    const now=this.now();
    const match=createObservationMatcher(this.games);
    const currentListed=new Set<string>();
    for(const catalog of catalogs)for(const event of catalog.events) {
      const category=catalog.categories[event.league];
      if(category.kind!=='collected')continue;
      const raw=match(streameastObservation(event,category.at),now);
      const game=this.games.find(item=>item.id===(raw.kind==='matched'?raw.gameId:''));
      const result=verifiedStreameastMatch(event,raw,game);
      if(result.kind!=='matched'||!game||!this.scheduleFresh(game)||game.finalObservedAt!==undefined)continue;
      if(catalog===current)currentListed.add(game.id);
      if(event.detail.kind!=='collected'||now-event.detail.at>=30*60000)continue;
      const previous=this.candidates.get(game.id)||[];
      const selected=new Set([...this.sessions.values()].filter(owned=>owned.value.gameId===game.id).map(owned=>owned.value.candidateId));
      const retained=previous.filter(candidate=>candidate.locator.provider!=='streameast'||selected.has(candidate.id));
      this.candidates.set(game.id,[...new Map([...retained,...streameastCandidates(event,game.id)]
        .map(candidate=>[candidate.id,candidate] as const)).values()]);
    }
    if(current?.state.kind==='complete')for(const [gameId,prior] of this.candidates)if(!currentListed.has(gameId)) {
      const selected=new Set([...this.sessions.values()].filter(owned=>owned.value.gameId===gameId).map(owned=>owned.value.candidateId));
      this.candidates.set(gameId,prior.filter(candidate=>candidate.locator.provider!=='streameast'||selected.has(candidate.id)));
    }
  }
  private sourcesSnapshot(): SourcesSnapshot {
    const at=this.now();
    if (this.inventoryCache?.revision===this.revision && at-this.inventoryCache.at<15_000) return this.inventoryCache.snapshot;
    const attempts=this.store.sourceAttempts();
    const lastDiscoveryAt=Object.values(attempts).length ? Math.max(...Object.values(attempts).map(item=>item.at)) : null;
    const snapshot=sourceInventory({at,revision:this.revision,lastDiscoveryAt,sources:this.sources,desktopCollectorsAvailable:this.desktopCollectorsAvailable,
      observations:this.store.observations(),games:this.games,candidates:this.candidates,attempts,
      sportsurgeCatalog:this.store.sportsurgeCatalog(),streameastCatalog:this.store.streameastCatalog()});
    this.inventoryCache={at,revision:this.revision,snapshot};
    return snapshot;
  }
  async command(command: Command): Promise<Reply> {
    if (this.stopped && command.kind!=='stop') return {kind:'error',status:503,message:'Pipeline is stopped.'};
    this.sweep();
    if (command.kind==='stop') { await this.stop(); return {kind:'ok'}; }
    if (command.kind==='sportsurge-catalog') {
      const catalog=sanitizeSportsurgeCatalog(command.catalog);
      if (!catalog) return {kind:'error',status:400,message:'Invalid Sportsurge catalog checkpoint.'};
      const decision=catalogDecision(this.store.sportsurgeCatalog().current,catalog);
      if (decision==='replay') return {kind:'ok'};
      if (decision==='rejected') return {kind:'error',status:409,message:'Sportsurge catalog checkpoint is obsolete.'};
      const receivedAt=this.now();
      const match=createObservationMatcher(this.games);
      const observations=catalog.events.map(event=>{
        const category=catalog.categories[event.league];
        const observation=sportsurgeObservation(event,category.kind==='pending' ? catalog.startedAt : category.at);
        return {observation,result:match(observation,receivedAt)};
      });
      this.store.saveSportsurgeCatalog({catalog,receivedAt},observations);
      this.revision++;
      return {kind:'ok'};
    }
    if (command.kind==='streameast-catalog') {
      const catalog=sanitizeStreameastCatalog(command.catalog);
      if(!catalog)return {kind:'error',status:400,message:'Invalid StreamEast catalog checkpoint.'};
      const decision=streameastDecision(this.store.streameastCatalog().current,catalog);
      if(decision==='replay'){this.reconcileStreameastCandidates();return {kind:'ok'};}
      if(decision==='rejected')return {kind:'error',status:409,message:'StreamEast catalog checkpoint is obsolete.'};
      const receivedAt=this.now();
      const match=createObservationMatcher(this.games);
      const observations=catalog.events.map(event=>{
        const category=catalog.categories[event.league];
        const observation=streameastObservation(event,category.kind==='pending'?catalog.startedAt:category.at);
        const raw=match(observation,receivedAt);
        const game=this.games.find(item=>item.id===(raw.kind==='matched'?raw.gameId:''));
        return {observation,result:verifiedStreameastMatch(event,raw,game)};
      });
      const visible=observations.filter(({observation,result})=>{
        const event=catalog.events.find(item=>`streameast:${item.url}`===observation.id);
        return !event?.espnEventId||result.kind==='matched'||result.reason!=='conflicting-date';
      });
      this.store.saveStreameastCatalog({catalog,receivedAt},visible);
      this.reconcileStreameastCandidates();
      this.revision++;
      return {kind:'ok'};
    }
    if (command.kind==='refresh') { await this.refresh(true); return {kind:'ok'}; }
    if (command.kind==='board') { if (!this.games.length) await this.refresh(); else void this.refresh(); return {kind:'board',board:this.board()}; }
    if (command.kind==='sources') return {kind:'sources',snapshot:this.sourcesSnapshot()};
    if (command.kind==='close') { this.sessions.delete(command.sessionId); return {kind:'ok'}; }
    if (command.kind==='open') {
      const gameId = this.store.aliases()[command.gameId] || command.gameId;
      const game = this.games.find(game=>game.id===gameId);
      const prior = command.requestId ? [...this.sessions.values()].find(owned => owned.requestId===command.requestId && owned.value.gameId===gameId && (owned.value.candidateId==='manual')===command.manual) : undefined;
      if (prior) {
        prior.value=reconcileSession(prior.value,game,this.now());
        if (prior.value.state!=='closed') {
          prior.lastSeen=this.now();
          const candidates=(this.candidates.get(gameId)||[]).filter(candidate=>candidate.id===prior.value.candidateId||this.now()-candidate.observedAt<30*60000).sort(compareCandidates);
          return {kind:'playback',playback:{session:prior.value,candidates:candidates.map(candidateSummary)}};
        }
      }
      if (!game || !this.scheduleFresh(game) || game.finalObservedAt!==undefined) return {kind:'error',status:409,message:'This game is finished or its schedule needs a refresh.'};
      const candidates = (this.candidates.get(gameId) || []).filter(candidate => this.now()-candidate.observedAt<30*60000).sort(compareCandidates);
      if (!command.manual && !candidates.length) return {kind:'error',status:404,message:'No compatible stream is available yet.'};
      if (this.sessions.size>=32) return {kind:'error',status:429,message:'Too many playback sessions.'};
      const session: Session = {id:this.id(),gameId,candidateId:command.manual ? 'manual' : candidates[0].id,generation:0,state:'active',graceEndsAt:null};
      this.sessions.set(session.id,{value:session,lastSeen:this.now(),refreshes:0,drainRefreshes:0,phase:{kind:'cycling'},requestId:command.requestId,recovery:{attempted:[],cooled:{},failures:{},cycleStartedAt:this.now()}});
      return {kind:'playback',playback:{session,candidates:candidates.map(candidateSummary)}};
    }
    const owned = this.sessions.get(command.sessionId);
    if (!owned) return {kind:'error',status:410,message:'Playback session ended.'};
    const session = owned.value;
    const candidates = this.candidates.get(session.gameId) || [];
    if (command.kind==='authorize') {
      const candidate = candidates.find(candidate=>candidate.id===command.candidateId);
      if (!candidate || session.candidateId!==candidate.id || session.generation!==command.generation) return {kind:'error',status:410,message:'Stream generation expired.'};
      owned.lastSeen=this.now();
      return {kind:'authorized',candidate,session};
    }
    if (command.generation!==session.generation) return {kind:'error',status:409,message:'Playback state changed. Refresh this stream.'};
    owned.lastSeen=this.now();
    if (session.state==='draining') {
      owned.phase={kind:'cycling'};
      if (command.failure || command.retry) {
        if (owned.drainRefreshes>=1) return {kind:'error',status:503,message:'This game has ended. The current stream cannot refresh again.'};
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
      if (!candidates.some(candidate=>candidate.id===command.candidateId && this.now()-candidate.observedAt<30*60000)) return {kind:'error',status:404,message:'Stream is no longer listed.'};
      session.candidateId=command.candidateId;
      session.generation++;
      owned.refreshes=0;
      owned.recovery={...owned.recovery,attempted:[],cycleStartedAt:this.now()};
      owned.phase={kind:'cycling'};
      return this.sessionReply(session);
    }
    if (owned.phase.kind==='exhausted') {
      const phase=owned.phase;
      const fresh=candidates.filter(candidate=>this.now()-candidate.observedAt<30*60000);
      const cycle={...owned.recovery,attempted:[]};
      const added=fresh.filter(candidate=>!phase.knownIds.includes(candidate.id));
      const eligible=this.now()<phase.until?added:fresh;
      const next=nextCandidate(eligible,cycle,this.now(),session.candidateId)||(this.now()>=phase.until?nextCandidate(eligible,cycle,this.now()):undefined);
      if (next) {
        owned.recovery={...owned.recovery,attempted:[],cycleStartedAt:this.now()};
        owned.refreshes=0;
        owned.phase={kind:'cycling'};
        session.candidateId=next.id;
        session.generation++;
        return this.sessionReply(session);
      }
      owned.phase={kind:'exhausted',until:Math.max(phase.until,Math.min(...fresh.map(candidate=>Math.max(this.now()+1000,owned.recovery.cooled[candidate.id]||this.now()+30000)),this.now()+30000)),knownIds:fresh.map(candidate=>candidate.id)};
      return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:owned.phase.until};
    }
    if (command.failure) {
      if (owned.refreshes<1) { owned.refreshes++; session.generation++; return this.sessionReply(session); }
      owned.recovery=failedCandidate(owned.recovery,session.candidateId,this.now());
      owned.refreshes=0;
      const next=nextCandidate(candidates.filter(candidate => this.now()-candidate.observedAt<30*60000),owned.recovery,this.now(),session.candidateId);
      if (!next) {
        const fresh=candidates.filter(candidate=>this.now()-candidate.observedAt<30*60000);
        owned.phase={kind:'exhausted',until:Math.min(...fresh.map(candidate=>Math.max(this.now()+1000,owned.recovery.cooled[candidate.id]||this.now()+30000)),this.now()+30000),knownIds:fresh.map(candidate=>candidate.id)};
        return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:owned.phase.until};
      }
      session.candidateId=next.id; session.generation++;
    }
    return this.sessionReply(session);
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped=true;
    clearInterval(this.tickTimer);
    this.controller.abort();
    await Promise.allSettled([this.refreshing,this.discovering]);
    this.sessions.clear(); this.candidates.clear(); this.store.close();
  }
}
