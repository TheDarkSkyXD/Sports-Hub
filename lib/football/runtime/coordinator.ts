import { matchObservation, mergeSchedulePartitions } from '../domain/matching.ts';
import { SESSION_LEASE_MS, failedCandidate, nextCandidate, reconcileSession } from '../domain/lifecycle.ts';
import type { Recovery } from '../domain/lifecycle.ts';
import type { FootballDependencies, FootballRepository } from '../domain/ports.ts';
import type { Board, Candidate, Command, Game, LeagueFeedStatus, Observation, Reply, Session } from '../shared.ts';

type OwnedSession = {value:Session;lastSeen:number;recovery:Recovery;refreshes:number;drainRefreshes:number;waitingUntil:number|null;requestId?:string};
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
  private readonly now: () => number;
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
    await runBounded([...this.sources], source => source.family === 'unknown' ? new URL(source.url).hostname : source.family,4,1,async source => {
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
    const eligible = observations.filter(observation => {
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
        const byUrl = new Map((this.candidates.get(game.id) || []).map(candidate => [candidate.url,candidate]));
        for (const candidate of players) {
          const previous = byUrl.get(candidate.url);
          byUrl.set(candidate.url,{...candidate,sourceIds:[...new Set([...(previous?.sourceIds || []),...candidate.sourceIds])]});
        }
        this.candidates.set(game.id,[...byUrl.values()]);
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
    return {kind:'session',session,candidates:(this.candidates.get(session.gameId) || []).filter(candidate => candidate.id===session.candidateId || now-candidate.observedAt<30*60000)};
  }
  async command(command: Command): Promise<Reply> {
    if (this.stopped && command.kind!=='stop') return {kind:'error',status:503,message:'Pipeline is stopped.'};
    this.sweep();
    if (command.kind==='stop') { await this.stop(); return {kind:'ok'}; }
    if (command.kind==='refresh') { await this.refresh(true); return {kind:'ok'}; }
    if (command.kind==='board') { if (!this.games.length) await this.refresh(); else void this.refresh(); return {kind:'board',board:this.board()}; }
    if (command.kind==='close') { this.sessions.delete(command.sessionId); return {kind:'ok'}; }
    if (command.kind==='open') {
      const gameId = this.store.aliases()[command.gameId] || command.gameId;
      const game = this.games.find(game=>game.id===gameId);
      if (!game || !this.scheduleFresh(game) || game.finalObservedAt!==undefined) return {kind:'error',status:409,message:'This game is finished or its schedule needs a refresh.'};
      const candidates = (this.candidates.get(gameId) || []).filter(candidate => this.now()-candidate.observedAt<30*60000);
      if (!command.manual && !candidates.length) return {kind:'error',status:404,message:'No compatible stream is available yet.'};
      const prior = command.requestId ? [...this.sessions.values()].find(owned => owned.requestId===command.requestId && owned.value.gameId===gameId && owned.value.state==='active' && (owned.value.candidateId==='manual')===command.manual) : undefined;
      if (prior) { prior.lastSeen=this.now(); return {kind:'playback',playback:{session:prior.value,candidates}}; }
      if (this.sessions.size>=32) return {kind:'error',status:429,message:'Too many playback sessions.'};
      const session: Session = {id:this.id(),gameId,candidateId:command.manual ? 'manual' : candidates[0].id,generation:0,state:'active',graceEndsAt:null};
      this.sessions.set(session.id,{value:session,lastSeen:this.now(),refreshes:0,drainRefreshes:0,waitingUntil:null,requestId:command.requestId,recovery:{attempted:[],cooled:{},failures:{},cycleStartedAt:this.now()}});
      return {kind:'playback',playback:{session,candidates}};
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
      owned.waitingUntil=null;
      if (command.failure || command.retry) {
        if (owned.drainRefreshes>=1) return {kind:'error',status:503,message:'This game has ended. The current stream cannot refresh again.'};
        owned.drainRefreshes++;
        session.generation++;
      }
      return this.sessionReply(session);
    }
    if (command.retry) {
      owned.recovery={attempted:[],cooled:{},failures:{},cycleStartedAt:this.now()};
      owned.refreshes=0;
      owned.waitingUntil=null;
      if (session.candidateId!=='manual') session.generation++;
      return this.sessionReply(session);
    }
    if (session.candidateId==='manual') return this.sessionReply(session);
    if (owned.waitingUntil !== null) {
      if (this.now()<owned.waitingUntil) return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:owned.waitingUntil};
      owned.waitingUntil=null;
      const fresh = candidates.filter(candidate => this.now()-candidate.observedAt<30*60000);
      const next = nextCandidate(fresh,{...owned.recovery,attempted:[]},this.now(),session.candidateId);
      if (!next) return {kind:'error',status:503,message:'Available streams failed. Choose Try again when ready.'};
      owned.recovery={...owned.recovery,attempted:[],cycleStartedAt:this.now()};
      owned.refreshes=0;
      session.candidateId=next.id;
      session.generation++;
      return this.sessionReply(session);
    }
    if (command.failure) {
      if (owned.refreshes<1) { owned.refreshes++; session.generation++; return this.sessionReply(session); }
      owned.recovery=failedCandidate(owned.recovery,session.candidateId,this.now());
      owned.refreshes=0;
      const next=nextCandidate(candidates.filter(candidate => this.now()-candidate.observedAt<30*60000),owned.recovery,this.now(),session.candidateId);
      if (!next) {
        const remaining = candidates.some(candidate => this.now()-candidate.observedAt<30*60000 && !owned.recovery.failures[candidate.id] && candidate.id!==session.candidateId);
        if (remaining) {
          owned.waitingUntil=this.now()+30000;
          return {kind:'error',status:503,message:'Checking the next available stream.',retryAfter:owned.waitingUntil};
        }
        return {kind:'error',status:503,message:'Available streams failed. Choose Try again when ready.'};
      }
      session.candidateId=next.id; session.generation++;
    } else if (command.candidateId && command.candidateId!==session.candidateId) {
      if (!candidates.some(candidate=>candidate.id===command.candidateId && this.now()-candidate.observedAt<30*60000)) return {kind:'error',status:404,message:'Stream is no longer listed.'};
      session.candidateId=command.candidateId; session.generation++; owned.refreshes=0;
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
