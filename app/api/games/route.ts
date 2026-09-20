import { Board, Game, mergeGames, parseDirectory, parseScoreboard, SOURCE } from '@/lib/sunday';
export const dynamic = 'force-dynamic';
let cache: Board | null = null;
let running: Promise<Board> | null = null;
async function read(url: string) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error', headers: { 'User-Agent': 'SundayRoom/1.0', Accept: 'application/json,text/html' } });
  if (!r.ok) throw new Error(`Upstream returned ${r.status}`);
  return r;
}
async function refresh(): Promise<Board> {
  const results = await Promise.allSettled([
    read('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard').then(r => r.json()),
    read(SOURCE).then(r => r.text()),
  ]);
  const errors: string[] = [];
  let scores: Game[] = [], directory: Game[] = [], week = cache?.week;
  let scoresAt = cache?.scoresAt || null, sourceAt = cache?.sourceAt || null;
  try {
    if (results[0].status !== 'fulfilled') throw new Error();
    scores = parseScoreboard(results[0].value); week = results[0].value.week?.number;
    scoresAt = new Date().toISOString();
  } catch { errors.push('Scores could not refresh. Previously loaded scores may be out of date.'); scores = cache?.games.filter(g => !g.id.startsWith('source-')) || []; }
  try {
    if (results[1].status !== 'fulfilled') throw new Error();
    directory = parseDirectory(results[1].value);
    if (!directory.length) throw new Error();
    sourceAt = new Date().toISOString();
  } catch { errors.push('The stream directory is unavailable. Saved game links may be out of date.'); directory = cache?.games.filter(g => g.sourceUrl) || []; }
  const board = { games: mergeGames(scores, directory), week, scoresAt, sourceAt, updatedAt: new Date().toISOString(), errors };
  cache = board; return board;
}
export async function GET() {
  if (cache && Date.now() - Date.parse(cache.updatedAt) < 25000) return Response.json(cache);
  running ??= refresh().finally(() => { running = null; });
  return Response.json(await running, { headers: { 'Cache-Control': 'no-store' } });
}
