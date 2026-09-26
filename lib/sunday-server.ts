import { Board, Game, LEAGUES, League, LeagueFeedStatus, mergeGames, parseDirectory, parseScoreboard, scoreboardWeek } from './sunday';

type Scores = { games: Game[]; week?: number; at: string };
type Directory = { games: Game[]; at: string };
type Snapshot = { scores?: Scores; directory?: Directory; errors: string[] };
const snapshots: Record<League, Snapshot> = { nfl: { errors: [] }, ncaaf: { errors: [] } };
let cache: Board | null = null;
let running: Promise<Board> | null = null;

async function read(url: string) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error', headers: { 'User-Agent': 'SundayRoom/1.0', Accept: 'application/json,text/html' } });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response;
}

async function refreshLeague(league: League): Promise<void> {
  const config = LEAGUES[league], snapshot = snapshots[league];
  const [scores, directory] = await Promise.allSettled([
    read(config.scoreboardUrl).then(response => response.json() as Promise<unknown>),
    read(config.directoryUrl).then(response => response.text()),
  ]);
  const errors: string[] = [];
  try {
    if (scores.status !== 'fulfilled') throw new Error('Score feed failed');
    const games = parseScoreboard(scores.value, league);
    snapshot.scores = { games, week: scoreboardWeek(scores.value), at: new Date().toISOString() };
  } catch { errors.push(`${config.label} scores could not refresh. Previously loaded scores may be out of date.`); }
  try {
    if (directory.status !== 'fulfilled') throw new Error('Directory failed');
    const games = parseDirectory(directory.value, league);
    if (!games.length && !/id="Arama"|placeholder="Search Games/i.test(directory.value)) throw new Error('Directory format changed');
    snapshot.directory = { games, at: new Date().toISOString() };
  } catch { errors.push(`${config.label} stream directory is unavailable. Saved game links may be out of date.`); }
  snapshot.errors = errors;
}

async function refresh(): Promise<Board> {
  await Promise.all([refreshLeague('nfl'), refreshLeague('ncaaf')]);
  const leagues = {} as Record<League, LeagueFeedStatus>;
  const games: Game[] = [];
  for (const league of ['nfl', 'ncaaf'] as const) {
    const snapshot = snapshots[league];
    games.push(...mergeGames(snapshot.scores?.games || [], snapshot.directory?.games || []));
    leagues[league] = { week: snapshot.scores?.week, scoresAt: snapshot.scores?.at || null, sourceAt: snapshot.directory?.at || null, errors: snapshot.errors };
  }
  cache = { games, leagues, updatedAt: new Date().toISOString() };
  return cache;
}

export async function getFootballBoard(): Promise<Board> {
  if (cache && Date.now() - Date.parse(cache.updatedAt) < 25000) return cache;
  running ??= refresh().finally(() => { running = null; });
  return running;
}
