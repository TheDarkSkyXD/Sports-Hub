import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LeagueSchema, DEFAULT_FEED_CHECK_INTERVAL_MINUTES, DEFAULT_FINISHED_GAME_RETENTION_MINUTES, FeedCheckIntervalMinutesSchema, FinishedGameRetentionMinutesSchema, DetailEvidenceSchema, GameSchema, ObservationSchema, SeasonMembershipSchema, SourceAttemptSchema, SourceEventBindingSchema, StoredSportsurgeCatalogSchema, StoredStreameastCatalogSchema } from '../shared.ts';
import type { CollectionAttempt, DetailEvidence, Game, Match, Observation, SeasonMembership, SourceAttempt, SourceEventBinding, StoredSportsurgeCatalog, StoredStreameastCatalog } from '../shared.ts';
import { recordFinal } from '../domain/lifecycle.ts';
import { createFinishedGameMatcher } from '../domain/matching.ts';
import { SOURCE_REFRESH_MS, rebaseRetryDeadline, retryDeadline } from '../domain/source-policy.ts';
import { WorkingFeedSchema, type WorkingFeed } from '../domain/working-feed.ts';

const PartitionSchema = z.object({games:z.array(GameSchema),at:z.number(),week:z.number().optional()});
export type Partition = z.infer<typeof PartitionSchema>;
function freezePartition(value:unknown):void {
  if(!value||typeof value!=='object'||Object.isFrozen(value))return;
  for(const child of Object.values(value))freezePartition(child);
  Object.freeze(value);
}
export class FootballStore {
  private db: DatabaseSync;
  private ownerToken: string;
  private partitionCache = new Map<string, Partition | undefined>();
  constructor(path: string, options: {ownerToken?:string;reclaimToken?:string} = {}) {
    this.ownerToken = options.ownerToken || randomUUID();
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK(slot=1), token TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;
        BEGIN IMMEDIATE;`);
      const owner = this.db.prepare('SELECT pid,token FROM owner WHERE slot=1').get();
      let alive = false;
      if (typeof owner?.pid === 'number') {
        try { process.kill(owner.pid,0); alive=true; }
        catch(error) { alive = error instanceof Error && 'code' in error && error.code === 'EPERM'; }
      }
      if (alive && owner?.token !== options.reclaimToken) throw new Error('football-writer-already-active');
      this.db.prepare('INSERT INTO owner VALUES (1,?,?) ON CONFLICT(slot) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(this.ownerToken,process.pid);
      this.db.exec('COMMIT');
    } catch(error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw error;
    }
    try { this.db.exec(`CREATE TABLE IF NOT EXISTS partitions (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS finals (id TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS source_event_bindings (source_id TEXT NOT NULL, event_id TEXT NOT NULL, url TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(source_id,event_id,url)) STRICT;
      CREATE TABLE IF NOT EXISTS details (observation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS working_feeds (game_id TEXT NOT NULL, candidate_id TEXT NOT NULL, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(game_id,candidate_id)) STRICT;
      CREATE INDEX IF NOT EXISTS working_identity ON working_feeds(game_id,identity_hash);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS source_catalogs (id TEXT PRIMARY KEY, current_payload TEXT NOT NULL, complete_payload TEXT, previous_payload TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS catalog_attempts (source_id TEXT NOT NULL, league TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_id,league,at,outcome)) STRICT;
      CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS alias_conflicts (id TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, count INTEGER NOT NULL, error TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS memberships (season INTEGER PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      PRAGMA user_version=1;`); }
    catch(error) { this.close(); throw error; }
    if (!this.db.prepare('PRAGMA table_info(source_catalogs)').all().some(row=>row.name==='previous_payload'))
      this.db.exec('ALTER TABLE source_catalogs ADD COLUMN previous_payload TEXT');
    if (!this.db.prepare("SELECT id FROM settings WHERE id='finishedGameRetentionMinutes'").get())
      this.setFinishedGameRetentionMinutes(DEFAULT_FINISHED_GAME_RETENTION_MINUTES);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('feedCheckIntervalMinutes',?)")
      .run(JSON.stringify(DEFAULT_FEED_CHECK_INTERVAL_MINUTES));
  }
  feedCheckIntervalMinutes():number {
    const row=this.db.prepare("SELECT payload FROM settings WHERE id='feedCheckIntervalMinutes'").get();
    return FeedCheckIntervalMinutesSchema.parse(typeof row?.payload==='string'?JSON.parse(row.payload):DEFAULT_FEED_CHECK_INTERVAL_MINUTES);
  }
  setFeedCheckIntervalMinutes(value:number):void {
    const minutes=FeedCheckIntervalMinutesSchema.parse(value);
    const previous=this.feedCheckIntervalMinutes();
    if(previous===minutes)return;
    const previousMs=previous*60_000;
    const nextMs=minutes*60_000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rebaseAttempt=(table:'sources'|'catalog_attempts',key:'id'|'rowid')=>{
        const update=this.db.prepare(`UPDATE ${table} SET payload=? WHERE ${key}=?`);
        for(const row of this.db.prepare(`SELECT ${key},payload FROM ${table}`).all()) {
          if(typeof row.payload!=='string'||(typeof row[key]!=='string'&&typeof row[key]!=='number'))continue;
          const payload=JSON.parse(row.payload);
          const parsed=SourceAttemptSchema.safeParse(payload);
          if(!parsed.success||parsed.data.nextEligibleAt===undefined||parsed.data.outcome==='unsupported')continue;
          const attempt=parsed.data;
          const currentDeadline=attempt.nextEligibleAt;
          if(currentDeadline===undefined)continue;
          const nextEligibleAt=rebaseRetryDeadline(attempt.at,currentDeadline,previousMs,nextMs,attempt.failure==='rate-limited');
          update.run(JSON.stringify({...payload,nextEligibleAt}),row[key]);
        }
      };
      rebaseAttempt('sources','id');
      rebaseAttempt('catalog_attempts','rowid');
      const updateDetail=this.db.prepare('UPDATE details SET payload=? WHERE observation_id=?');
      for(const row of this.db.prepare('SELECT observation_id,payload FROM details').all()) {
        if(typeof row.observation_id!=='string'||typeof row.payload!=='string')continue;
        const parsed=DetailEvidenceSchema.safeParse(JSON.parse(row.payload));
        if(!parsed.success)continue;
        const detail=parsed.data;
        const nextEligibleAt=rebaseRetryDeadline(detail.at,detail.nextEligibleAt,previousMs,nextMs,
          detail.outcome==='failed'&&detail.failure==='rate-limited');
        updateDetail.run(JSON.stringify({...detail,nextEligibleAt}),row.observation_id);
      }
      this.db.prepare("INSERT INTO settings VALUES ('feedCheckIntervalMinutes',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
        .run(JSON.stringify(minutes));
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  finishedGameRetentionMinutes():number {
    const row=this.db.prepare("SELECT payload FROM settings WHERE id='finishedGameRetentionMinutes'").get();
    return FinishedGameRetentionMinutesSchema.parse(typeof row?.payload==='string'?JSON.parse(row.payload):DEFAULT_FINISHED_GAME_RETENTION_MINUTES);
  }
  setFinishedGameRetentionMinutes(value:number):void {
    const minutes=FinishedGameRetentionMinutesSchema.parse(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO settings VALUES ('finishedGameRetentionMinutes',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
        .run(JSON.stringify(minutes));
      this.db.prepare("UPDATE finals SET payload=json_set(payload,'$.graceEndsAt',at+?,'$.finalObservedAt',at)").run(minutes*60_000);
      const finals=new Map(this.finals().map(game=>[game.id,game]));
      const update=this.db.prepare('UPDATE partitions SET payload=? WHERE id=?');
      for(const row of this.db.prepare('SELECT id,payload FROM partitions').all()) {
        if(typeof row.id!=='string'||typeof row.payload!=='string')continue;
        const partition=PartitionSchema.parse(JSON.parse(row.payload));
        const games=partition.games.map(game=>finals.get(game.id)??game);
        update.run(JSON.stringify({...partition,games}),row.id);
      }
      this.db.exec('COMMIT');
      this.partitionCache.clear();
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  partition(id: string): Partition | undefined {
    if (this.partitionCache.has(id)) return this.partitionCache.get(id);
    const row = this.db.prepare('SELECT payload FROM partitions WHERE id=?').get(id);
    const parsed = typeof row?.payload === 'string' ? PartitionSchema.safeParse(JSON.parse(row.payload)) : undefined;
    const partition = parsed?.success ? parsed.data : undefined;
    freezePartition(partition);
    this.partitionCache.set(id,partition);
    return partition;
  }
  savePartition(id: string, value: Partition): void {
    const partition = PartitionSchema.parse(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const acceptedGames: Game[] = [];
      for (const game of partition.games) {
        if (game.lifecycle !== 'final') { acceptedGames.push(game); continue; }
        const previous = this.db.prepare('SELECT at FROM finals WHERE id=?').get(game.id);
        const firstObserved = typeof previous?.at === 'number' ? previous.at : partition.at;
        const final = recordFinal(game,firstObserved,this.finishedGameRetentionMinutes());
        this.db.prepare('INSERT INTO finals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(game.id,JSON.stringify(final),firstObserved);
        acceptedGames.push(final);
      }
      this.db.prepare('INSERT INTO partitions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify({...partition,games:acceptedGames}));
      this.db.exec('COMMIT');
      this.partitionCache.delete(id);
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finals(): Game[] {
    return this.db.prepare('SELECT payload FROM finals').all().flatMap(row => {
      if (typeof row.payload !== 'string') return [];
      const result = GameSchema.safeParse(JSON.parse(row.payload));
      return result.success ? [result.data] : [];
    });
  }
  observe(observation: Observation, result: Match): void {
    this.db.prepare('INSERT INTO observations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,result=excluded.result,at=excluded.at')
      .run(observation.id,JSON.stringify(observation),JSON.stringify(result),observation.observedAt);
  }
  observations(): Observation[] {
    return this.db.prepare('SELECT payload FROM observations ORDER BY at DESC LIMIT 10000').all().flatMap(row => {
      if (typeof row.payload !== 'string') return [];
      const result = ObservationSchema.safeParse(JSON.parse(row.payload));
      return result.success ? [result.data] : [];
    });
  }
  sourceAttempts(): Record<string,SourceAttempt> {
    const attempts=Object.fromEntries(this.db.prepare('SELECT id,payload FROM sources').all().flatMap<[string,SourceAttempt]>(row => {
      if (typeof row.id !== 'string' || typeof row.payload !== 'string') return [];
      try {
        const payload:unknown=JSON.parse(row.payload);
        const result=SourceAttemptSchema.safeParse(payload);
        if (!result.success) return [];
        if (result.data.nextEligibleAt !== undefined) return [[row.id,result.data]];
        if (result.data.outcome!=='failed') return [[row.id,{at:result.data.at,outcome:result.data.outcome,failures:0,nextEligibleAt:0}]];
        const raw=payload && typeof payload==='object' && 'error' in payload ? payload.error : null;
        const error=typeof raw==='string' ? raw : '';
        const failure:NonNullable<SourceAttempt['failure']>=error==='http-404'?'not-found':error==='http-429'?'rate-limited':
          /timeout|timed out/i.test(error)?'timed-out':error==='fetch failed'?'network-unavailable':
          error==='unsupported-discovery-address'?'unsupported-address':
          /^(?:empty-response|response-too-large|redirect-without-location|redirect-limit)$/.test(error)?'invalid-response':'upstream-error';
        return [[row.id,{at:result.data.at,outcome:'failed',failure,failures:0,nextEligibleAt:0}]];
      } catch {return [];}
    }));
    for(const row of this.db.prepare('SELECT source_id,payload FROM catalog_attempts ORDER BY at DESC').all()) {
      if(typeof row.source_id!=='string'||typeof row.payload!=='string')continue;
      try {
        const parsed=SourceAttemptSchema.safeParse(JSON.parse(row.payload));
        if(parsed.success&&(!attempts[row.source_id]||parsed.data.at>attempts[row.source_id].at))attempts[row.source_id]=parsed.data;
      } catch {}
    }
    return attempts;
  }
  workingFeeds(): WorkingFeed[] {
    const feeds:WorkingFeed[]=[];
    const remove=this.db.prepare('DELETE FROM working_feeds WHERE game_id=? AND candidate_id=?');
    for(const row of this.db.prepare('SELECT game_id,candidate_id,identity_hash,payload FROM working_feeds').all()) {
      try {
        const parsed=WorkingFeedSchema.safeParse(typeof row.payload==='string'?JSON.parse(row.payload):null);
        if(parsed.success&&parsed.data.candidate.gameId===row.game_id&&parsed.data.candidate.id===row.candidate_id&&parsed.data.identityHash===row.identity_hash) {
          feeds.push(parsed.data);
          continue;
        }
      } catch {}
      remove.run(row.game_id,row.candidate_id);
    }
    return feeds;
  }
  replaceWorkingIdentity(gameId:string,identityHash:string,feeds:readonly WorkingFeed[]):void {
    const parsed=feeds.map(feed=>WorkingFeedSchema.parse(feed));
    if(parsed.some(feed=>feed.candidate.gameId!==gameId||feed.identityHash!==identityHash))throw new Error('working-feed-identity-mismatch');
    const payloads=parsed.sort((a,b)=>a.candidate.id<b.candidate.id?-1:a.candidate.id>b.candidate.id?1:0).map(feed=>JSON.stringify(feed));
    const previous=this.db.prepare('SELECT payload FROM working_feeds WHERE game_id=? AND identity_hash=? ORDER BY candidate_id').all(gameId,identityHash);
    if(previous.length===payloads.length&&previous.every((row,index)=>row.payload===payloads[index]))return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM working_feeds WHERE game_id=? AND identity_hash=?').run(gameId,identityHash);
      const save=this.db.prepare('INSERT INTO working_feeds VALUES (?,?,?,?) ON CONFLICT(game_id,candidate_id) DO UPDATE SET identity_hash=excluded.identity_hash,payload=excluded.payload');
      for(const [index,feed] of parsed.entries())save.run(gameId,feed.candidate.id,identityHash,payloads[index]);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  removeWorkingGames(gameIds:readonly string[]):void {
    const remove=this.db.prepare('DELETE FROM working_feeds WHERE game_id=?');
    for(const id of gameIds)remove.run(id);
  }
  sourceEventBindings():SourceEventBinding[] {
    return this.db.prepare('SELECT payload FROM source_event_bindings ORDER BY at DESC LIMIT 10000').all().flatMap(row=>{
      if(typeof row.payload!=='string')return [];
      const parsed=SourceEventBindingSchema.safeParse(JSON.parse(row.payload));
      return parsed.success?[parsed.data]:[];
    });
  }
  removeFinalEvidence(gameIds:readonly string[],now:number):void {
    if(!gameIds.length)return;
    const selected=new Set(gameIds);
    const finals=this.finals().filter(game=>selected.has(game.id)&&game.graceEndsAt!==undefined&&game.graceEndsAt<=now);
    if(!finals.length)return;
    const bindings=this.sourceEventBindings();
    const current=new Map(this.finals().map(game=>[game.id,game]));
    for(const row of this.db.prepare('SELECT payload FROM partitions').all()){
      if(typeof row.payload!=='string')continue;
      const parsed=PartitionSchema.safeParse(JSON.parse(row.payload));
      if(parsed.success)for(const game of parsed.data.games)if(!current.has(game.id))current.set(game.id,game);
    }
    const canonicalGames=[...current.values()];
    const selectedFinals=createFinishedGameMatcher(finals);
    const canonical=createFinishedGameMatcher(canonicalGames);
    const ids=this.db.prepare('SELECT id,payload,result FROM observations').all().flatMap(row=>{
      if(typeof row.id!=='string'||typeof row.payload!=='string'||typeof row.result!=='string')return [];
      const parsed=ObservationSchema.safeParse(JSON.parse(row.payload));
      if(!parsed.success)return [];
      const result=JSON.parse(row.result) as Match;
      const sportsurgeId=/^https:\/\/v2\.sportsurge\.net\/watch-(\d{1,12})-[a-z0-9]+-/.exec(parsed.data.url);
      const eventId=sportsurgeId&&parsed.data.league?`${parsed.data.league}:${sportsurgeId[1]}`:null;
      const boundGameId=canonical.finishedBoundEvent(parsed.data,eventId||parsed.data.id,bindings);
      const bound=result.kind==='matched'&&finals.some(game=>game.id===result.gameId)||
        selectedFinals.finishedGameId(parsed.data,now)!==null||
        boundGameId!==null&&finals.some(game=>game.id===boundGameId);
      return bound?[row.id]:[];
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.removeWorkingGames(finals.map(game=>game.id));
      const removeDetail=this.db.prepare('DELETE FROM details WHERE observation_id=?');
      const removeObservation=this.db.prepare('DELETE FROM observations WHERE id=?');
      for(const id of ids){removeDetail.run(id);removeObservation.run(id);}
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  collectionHistory(now:number):CollectionAttempt[] {
    const rows=this.db.prepare(`SELECT source_id,at,outcome,count FROM (
      SELECT source_id,at,outcome,count,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY at DESC,id DESC) AS rank
      FROM diagnostics WHERE at>=?
    ) WHERE rank<=16 ORDER BY at DESC`).all(now-24*3600000);
    return rows.flatMap(row=>{
      if(typeof row.source_id!=='string'||typeof row.at!=='number'||typeof row.count!=='number'||
        typeof row.outcome!=='string')return [];
      const outcome=SourceAttemptSchema.shape.outcome.safeParse(row.outcome);
      if(!outcome.success)return [];
      const category=/^(.*):([a-z0-9-]+)$/.exec(row.source_id);
      const parsedLeague=LeagueSchema.safeParse(category?.[2]);
      const league=parsedLeague.success?parsedLeague.data:null;
      return [{sourceId:category&&league?category[1]:row.source_id,league,
        at:row.at,outcome:outcome.data,count:row.count}];
    });
  }
  private recordCatalogAttempts(sourceId:string, catalog:{categories:Record<string,
    {kind:'pending'}|{kind:'collected';at:number}|{kind:'failed';at:number;reason:string}>;
    events:{league:string}[]}):void {
    const insert=this.db.prepare('INSERT OR IGNORE INTO catalog_attempts VALUES (?,?,?,?,?)');
    const diagnostic=this.db.prepare('INSERT INTO diagnostics (source_id,at,outcome,count,error) VALUES (?,?,?,?,?)');
    for(const league of Object.keys(catalog.categories)) {
      const category=catalog.categories[league];
      if(category.kind==='pending')continue;
      const count=category.kind==='collected'?catalog.events.filter(event=>event.league===league).length:0;
      const outcome=category.kind==='collected'?'parsed':category.reason==='parser-changed'?'parser-changed':'failed';
      const failure=category.kind==='failed'&&outcome==='failed'?(category.reason==='timeout'?'timed-out':category.reason==='blocked'?'blocked':category.reason==='rate-limited'?'rate-limited':'upstream-error'):undefined;
      const prior=this.db.prepare('SELECT payload FROM catalog_attempts WHERE source_id=? AND league=? ORDER BY at DESC LIMIT 1').get(sourceId,league);
      let failures=0;
      if(typeof prior?.payload==='string') {
        try {const parsed=SourceAttemptSchema.safeParse(JSON.parse(prior.payload));if(parsed.success)failures=parsed.data.failures||0;}
        catch {}
      }
      failures=outcome==='parsed'?0:failures+1;
      const attempt=SourceAttemptSchema.parse({at:category.at,outcome,count,failure,failures,
        nextEligibleAt:retryDeadline(category.at,failure==='rate-limited'?SOURCE_REFRESH_MS:0,this.feedCheckIntervalMinutes()*60_000)});
      const payload=JSON.stringify({...attempt,catalogReason:category.kind==='failed'?category.reason:undefined});
      if(insert.run(sourceId,league,category.at,outcome,payload).changes)
        diagnostic.run(`${sourceId}:${league}`,category.at,outcome,count,category.kind==='failed'?category.reason:null);
    }
  }
  saveListingAttempt(id:string, value:SourceAttempt, observations:{observation:Observation;result:Match}[],bindings:SourceEventBinding[]=[]):void {
    const attempt=SourceAttemptSchema.parse(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(attempt));
      const insert=this.db.prepare('INSERT INTO observations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,result=excluded.result,at=excluded.at');
      for(const {observation,result} of observations) {
        const parsed=ObservationSchema.parse(observation);
        insert.run(parsed.id,JSON.stringify(parsed),JSON.stringify(result),parsed.observedAt);
      }
      const bind=this.db.prepare('INSERT INTO source_event_bindings VALUES (?,?,?,?,?) ON CONFLICT(source_id,event_id,url) DO UPDATE SET payload=excluded.payload,at=excluded.at');
      for(const binding of bindings){const parsed=SourceEventBindingSchema.parse(binding);
        bind.run(parsed.sourceId,parsed.eventId,parsed.url,JSON.stringify(parsed),parsed.observedAt);}
      this.db.prepare('INSERT INTO diagnostics (source_id,at,outcome,count,error) VALUES (?,?,?,?,?)').run(id,attempt.at,attempt.outcome,attempt.count||0,attempt.failure||null);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  detailEvidence():DetailEvidence[] {
    return this.db.prepare('SELECT payload FROM details ORDER BY at DESC LIMIT 10000').all().flatMap(row=>{
      if(typeof row.payload!=='string')return [];
      try {const parsed=DetailEvidenceSchema.safeParse(JSON.parse(row.payload));return parsed.success?[parsed.data]:[];}
      catch{return [];}
    });
  }
  saveDetailEvidence(value:DetailEvidence, observation?:{observation:Observation;result:Match}):void {
    const evidence=DetailEvidenceSchema.parse(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(observation) {
        const parsed=ObservationSchema.parse(observation.observation);
        this.db.prepare('INSERT INTO observations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,result=excluded.result,at=excluded.at')
          .run(parsed.id,JSON.stringify(parsed),JSON.stringify(observation.result),parsed.observedAt);
      }
      this.db.prepare('INSERT INTO details VALUES (?,?,?) ON CONFLICT(observation_id) DO UPDATE SET payload=excluded.payload,at=excluded.at')
        .run(evidence.observationId,JSON.stringify(evidence),evidence.at);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  sportsurgeCatalog(): {current:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null} {
    const row=this.db.prepare("SELECT current_payload,complete_payload,previous_payload FROM source_catalogs WHERE id='sportsurge-v2'").get();
    const parse=(value:unknown):StoredSportsurgeCatalog|null=>{
      if (typeof value!=='string') return null;
      try { const result=StoredSportsurgeCatalogSchema.safeParse(JSON.parse(value)); return result.success ? result.data : null; }
      catch { return null; }
    };
    return {current:parse(row?.current_payload),lastComplete:parse(row?.complete_payload),previous:parse(row?.previous_payload)};
  }
  saveSportsurgeCatalog(value:StoredSportsurgeCatalog,observations:{observation:Observation;result:Match}[],bindings:SourceEventBinding[]=[]): void {
    const parsed=StoredSportsurgeCatalogSchema.parse(value);
    const payload=JSON.stringify(parsed);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare("SELECT current_payload,complete_payload,previous_payload FROM source_catalogs WHERE id='sportsurge-v2'").get();
      const oldCurrent=typeof old?.current_payload==='string' ? StoredSportsurgeCatalogSchema.safeParse(JSON.parse(old.current_payload)) : null;
      const prior=oldCurrent?.success && oldCurrent.data.catalog.runId!==parsed.catalog.runId && oldCurrent.data.catalog.state.kind!=='complete'
        ? old?.current_payload || null : old?.previous_payload || null;
      this.db.prepare(`INSERT INTO source_catalogs (id,current_payload,complete_payload,previous_payload) VALUES ('sportsurge-v2',?,?,?)
        ON CONFLICT(id) DO UPDATE SET current_payload=excluded.current_payload,complete_payload=excluded.complete_payload,previous_payload=excluded.previous_payload`)
        .run(payload,parsed.catalog.state.kind==='complete' ? payload : old?.complete_payload || null,prior);
      this.db.exec("DELETE FROM observations WHERE json_extract(payload,'$.sourceId')='sportsurge-v2'");
      const insert=this.db.prepare('INSERT INTO observations VALUES (?,?,?,?)');
      for (const {observation,result} of observations) insert.run(observation.id,JSON.stringify(observation),JSON.stringify(result),observation.observedAt);
      const bind=this.db.prepare('INSERT INTO source_event_bindings VALUES (?,?,?,?,?) ON CONFLICT(source_id,event_id,url) DO UPDATE SET payload=excluded.payload,at=excluded.at');
      for(const binding of bindings){const parsedBinding=SourceEventBindingSchema.parse(binding);
        bind.run(parsedBinding.sourceId,parsedBinding.eventId,parsedBinding.url,JSON.stringify(parsedBinding),parsedBinding.observedAt);}
      this.recordCatalogAttempts('sportsurge-v2',parsed.catalog);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  streameastCatalog(): {current:StoredStreameastCatalog|null;lastComplete:StoredStreameastCatalog|null;previous:StoredStreameastCatalog|null} {
    const row=this.db.prepare("SELECT current_payload,complete_payload,previous_payload FROM source_catalogs WHERE id='streameast'").get();
    const parse=(value:unknown):StoredStreameastCatalog|null=>{
      if(typeof value!=='string')return null;
      try {const result=StoredStreameastCatalogSchema.safeParse(JSON.parse(value));return result.success?result.data:null;}
      catch{return null;}
    };
    return {current:parse(row?.current_payload),lastComplete:parse(row?.complete_payload),previous:parse(row?.previous_payload)};
  }
  saveStreameastCatalog(value:StoredStreameastCatalog,observations:{observation:Observation;result:Match}[]): void {
    const parsed=StoredStreameastCatalogSchema.parse(value);
    const payload=JSON.stringify(parsed);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare("SELECT current_payload,complete_payload,previous_payload FROM source_catalogs WHERE id='streameast'").get();
      const oldCurrent=typeof old?.current_payload==='string'?StoredStreameastCatalogSchema.safeParse(JSON.parse(old.current_payload)):null;
      const prior=oldCurrent?.success&&oldCurrent.data.catalog.runId!==parsed.catalog.runId&&oldCurrent.data.catalog.state.kind!=='complete'
        ? old?.current_payload||null:old?.previous_payload||null;
      this.db.prepare(`INSERT INTO source_catalogs (id,current_payload,complete_payload,previous_payload) VALUES ('streameast',?,?,?)
        ON CONFLICT(id) DO UPDATE SET current_payload=excluded.current_payload,complete_payload=excluded.complete_payload,previous_payload=excluded.previous_payload`)
        .run(payload,parsed.catalog.state.kind==='complete'?payload:old?.complete_payload||null,prior);
      if(observations.length || Object.values(parsed.catalog.categories).some(category=>category.kind!=='pending')) {
        this.db.exec("DELETE FROM observations WHERE json_extract(payload,'$.sourceId')='streameast'");
        const insert=this.db.prepare('INSERT INTO observations VALUES (?,?,?,?)');
        for(const {observation,result} of observations)insert.run(observation.id,JSON.stringify(observation),JSON.stringify(result),observation.observedAt);
      }
      this.recordCatalogAttempts('streameast',parsed.catalog);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  membership(season: number): SeasonMembership | undefined {
    const row = this.db.prepare('SELECT payload FROM memberships WHERE season=?').get(season);
    if (typeof row?.payload !== 'string') return;
    const parsed = SeasonMembershipSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : undefined;
  }
  saveMembership(value: SeasonMembership): void {
    const parsed = SeasonMembershipSchema.parse(value);
    this.db.prepare('INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(season) DO UPDATE SET payload=excluded.payload,at=excluded.at').run(parsed.season,JSON.stringify(parsed),parsed.at);
  }
  alias(oldId: string, gameId: string): void {
    if (this.db.prepare('SELECT id FROM alias_conflicts WHERE id=?').get(oldId)) return;
    const prior = this.db.prepare('SELECT game_id FROM aliases WHERE id=?').get(oldId);
    if (typeof prior?.game_id === 'string' && prior.game_id !== gameId) {
      this.db.prepare('DELETE FROM aliases WHERE id=?').run(oldId);
      this.db.prepare('INSERT OR IGNORE INTO alias_conflicts VALUES (?,?)').run(oldId,Date.now());
      return;
    }
    this.db.prepare('INSERT INTO aliases VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(oldId,gameId,Date.now());
  }
  aliases(): Record<string,string> {
    return Object.fromEntries(this.db.prepare('SELECT id,game_id FROM aliases').all().flatMap(row => typeof row.id === 'string' && typeof row.game_id === 'string' ? [[row.id,row.game_id]] : []));
  }
  sweep(now: number): void {
    this.removeFinalEvidence(this.finals().filter(game=>game.graceEndsAt!==undefined&&game.graceEndsAt<=now).map(game=>game.id),now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM observations WHERE at < ?').run(now-7*24*3600000);
      this.db.prepare('DELETE FROM source_event_bindings WHERE at < ?').run(now-7*24*3600000);
      this.db.exec('DELETE FROM source_event_bindings WHERE rowid IN (SELECT rowid FROM source_event_bindings ORDER BY at DESC LIMIT -1 OFFSET 10000)');
      this.db.prepare('DELETE FROM details WHERE at < ? OR observation_id NOT IN (SELECT id FROM observations)').run(now-7*24*3600000);
      this.db.prepare("DELETE FROM observations WHERE json_extract(result, '$.gameId') IN (SELECT id FROM finals WHERE json_extract(payload, '$.graceEndsAt') <= ?)").run(now);
      this.db.exec('DELETE FROM observations WHERE id IN (SELECT id FROM observations ORDER BY at DESC LIMIT -1 OFFSET 10000)');
      this.db.prepare('DELETE FROM finals WHERE at < ?').run(now-2*366*24*3600000);
      this.db.prepare('DELETE FROM aliases WHERE at < ?').run(now-2*366*24*3600000);
      this.db.prepare('DELETE FROM alias_conflicts WHERE at < ?').run(now-2*366*24*3600000);
      this.db.prepare('DELETE FROM diagnostics WHERE at < ?').run(now-30*24*3600000);
      this.db.prepare('DELETE FROM catalog_attempts WHERE at < ?').run(now-30*24*3600000);
      this.db.prepare('DELETE FROM memberships WHERE season < ?').run(new Date(now).getUTCFullYear()-2);
      this.db.exec('DELETE FROM diagnostics WHERE id IN (SELECT id FROM diagnostics ORDER BY at DESC LIMIT -1 OFFSET 10000)');
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void {
    this.db.prepare('DELETE FROM owner WHERE slot=1 AND token=?').run(this.ownerToken);
    this.db.close();
    this.partitionCache.clear();
  }
}
