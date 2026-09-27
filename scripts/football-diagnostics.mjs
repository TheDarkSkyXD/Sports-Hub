import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES } from '../lib/football/adapters/sources.ts';

const path = join(process.env.SUNDAY_ROOM_DATA_DIR || join(process.cwd(),'.desktop-runtime'),'football.sqlite');
if (!existsSync(path)) {
  process.stderr.write('Football pipeline database has not been created.\n');
  process.exitCode = 1;
} else {
  const db = new DatabaseSync(path,{readOnly:true});
  try {
    const rows = db.prepare('SELECT id,payload FROM sources ORDER BY id').all();
    const latest = new Map(rows.flatMap(row => {
      if (typeof row.id !== 'string' || typeof row.payload !== 'string') return [];
      try { return [[row.id,JSON.parse(row.payload)]]; } catch { return []; }
    }));
    const redact = value => typeof value === 'string' ? value.replace(/https?:\/\/\S+/g,'[url]').slice(0,120) : undefined;
    const sources = SOURCES.map(source => {
      const entry = latest.get(source.id);
      return {id:source.id,family:source.family,outcome:entry?.outcome || 'not-polled',at:entry?.at || null,count:entry?.count || 0,error:redact(entry?.error)};
    });
    const results = db.prepare('SELECT result FROM observations ORDER BY at DESC LIMIT 10000').all();
    const reasons = {};
    for (const row of results) {
      if (typeof row.result !== 'string') continue;
      try {
        const result = JSON.parse(row.result);
        if (result?.kind === 'unmatched' && typeof result.reason === 'string') {
          const reason = redact(result.reason);
          if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
        }
      } catch {}
    }
    const history = db.prepare('SELECT source_id,at,outcome,count,error FROM diagnostics ORDER BY at DESC LIMIT 1000').all().map(row => ({
      sourceId:row.source_id,at:row.at,outcome:row.outcome,count:row.count,error:redact(row.error),
    }));
    const listings = [];
    if (process.argv.includes('--listings')) {
      const samples = db.prepare('SELECT payload,result FROM observations ORDER BY at DESC LIMIT 1000').all();
      for (const row of samples) {
        if (listings.length >= 25) break;
        if (typeof row.payload !== 'string' || typeof row.result !== 'string') continue;
        try {
          const observation = JSON.parse(row.payload);
          const match = JSON.parse(row.result);
          if (!Array.isArray(observation.teams) || observation.teams.length !== 2) continue;
          listings.push({sourceId:observation.sourceId,title:redact(observation.title),teams:observation.teams.map(redact),
            rawTime:redact(observation.rawTime),kickoff:observation.kickoff,reason:match.kind === 'unmatched' ? redact(match.reason) : 'matched',
            possibleGameIds:Array.isArray(match.possibleGameIds) ? match.possibleGameIds.slice(0,5) : match.gameId ? [match.gameId] : []});
        } catch {}
      }
    }
    process.stdout.write(`${JSON.stringify({sources,unmatchedReasons:reasons,history,...(process.argv.includes('--listings') ? {listings} : {})},null,2)}\n`);
  } finally { db.close(); }
}
