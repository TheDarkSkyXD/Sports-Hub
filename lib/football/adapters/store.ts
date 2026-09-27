import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GameSchema, ObservationSchema, SeasonMembershipSchema, SourceAttemptSchema } from '../shared.ts';
import type { Game, Match, Observation, SeasonMembership, SourceAttempt } from '../shared.ts';
import { recordFinal } from '../domain/lifecycle.ts';

const PartitionSchema = z.object({games:z.array(GameSchema),at:z.number(),week:z.number().optional()});
export type Partition = z.infer<typeof PartitionSchema>;
export class FootballStore {
  private db: DatabaseSync;
  private ownerToken: string;
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
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS alias_conflicts (id TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, count INTEGER NOT NULL, error TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS memberships (season INTEGER PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
      PRAGMA user_version=1;`); }
    catch(error) { this.close(); throw error; }
  }
  partition(id: string): Partition | undefined {
    const row = this.db.prepare('SELECT payload FROM partitions WHERE id=?').get(id);
    if (typeof row?.payload !== 'string') return;
    const parsed = PartitionSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : undefined;
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
        const final = recordFinal(game,firstObserved);
        this.db.prepare('INSERT INTO finals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(game.id,JSON.stringify(final),firstObserved);
        acceptedGames.push(final);
      }
      this.db.prepare('INSERT INTO partitions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify({...partition,games:acceptedGames}));
      this.db.exec('COMMIT');
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
    return Object.fromEntries(this.db.prepare('SELECT id,payload FROM sources').all().flatMap(row => {
      if (typeof row.id !== 'string' || typeof row.payload !== 'string') return [];
      try {
        const result=SourceAttemptSchema.safeParse(JSON.parse(row.payload));
        return result.success ? [[row.id,result.data]] : [];
      } catch {return [];}
    }));
  }
  source(id: string, value: {at:number;outcome:string;count:number;error?:string}): void {
    this.db.prepare('INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(value));
    this.db.prepare('INSERT INTO diagnostics (source_id,at,outcome,count,error) VALUES (?,?,?,?,?)').run(id,value.at,value.outcome,value.count,value.error?.slice(0,120) || null);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM observations WHERE at < ?').run(now-7*24*3600000);
      this.db.prepare("DELETE FROM observations WHERE json_extract(result, '$.gameId') IN (SELECT id FROM finals WHERE at < ?)").run(now-24*3600000-5*60000);
      this.db.exec('DELETE FROM observations WHERE id IN (SELECT id FROM observations ORDER BY at DESC LIMIT -1 OFFSET 10000)');
      this.db.prepare('DELETE FROM finals WHERE at < ?').run(now-2*366*24*3600000);
      this.db.prepare('DELETE FROM aliases WHERE at < ?').run(now-2*366*24*3600000);
      this.db.prepare('DELETE FROM alias_conflicts WHERE at < ?').run(now-2*366*24*3600000);
      this.db.prepare('DELETE FROM diagnostics WHERE at < ?').run(now-30*24*3600000);
      this.db.prepare('DELETE FROM memberships WHERE season < ?').run(new Date(now).getUTCFullYear()-2);
      this.db.exec('DELETE FROM diagnostics WHERE id IN (SELECT id FROM diagnostics ORDER BY at DESC LIMIT -1 OFFSET 10000)');
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void {
    this.db.prepare('DELETE FROM owner WHERE slot=1 AND token=?').run(this.ownerToken);
    this.db.close();
  }
}
