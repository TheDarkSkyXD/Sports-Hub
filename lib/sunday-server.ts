import { LEAGUES, mergeGames, parseDirectory, parseScoreboard, parseSourceDate, scoreboardFeedData, scoreboardWeek, validSourcePage } from './sunday';
import type { Board, Game, League, LeagueFeedStatus } from './sunday';

type Scores = { games: Game[]; week?: number; at: string };
type Directory = { games: Game[]; at: string };
type Snapshot = { scores: Map<string, Scores>; directory?: Directory; errors: string[] };
const snapshots: Record<League, Snapshot> = { nfl: { scores: new Map(), errors: [] }, ncaaf: { scores: new Map(), errors: [] } };
let cache: Board | null = null;
let running: Promise<Board> | null = null;
const sourceDates = new Map<string, { date: string | null; expiresAt: number }>();
let warming: Promise<void> | null = null;

async function read(url: string) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error', headers: { 'User-Agent': 'SundayRoom/1.0', Accept: 'application/json,text/html' } });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response;
}

async function refreshLeague(league: League): Promise<void> {
  const config = LEAGUES[league], snapshot = snapshots[league];
  const [scores, directory] = await Promise.all([
    Promise.allSettled(config.scoreboardFeeds.map(feed => read(feed.url).then(response => response.json() as Promise<unknown>))),
    read(config.directoryUrl).then(response => response.text()).then(value => ({ value }), () => ({ value: null })),
  ]);
  const errors: string[] = [];
  for (const [index, feed] of config.scoreboardFeeds.entries()) {
    try {
      const result = scores[index];
      if (result.status !== 'fulfilled') throw new Error('Score feed failed');
      const data = scoreboardFeedData(result.value, feed.format);
      snapshot.scores.set(feed.url, { games: parseScoreboard(data, league), week: scoreboardWeek(data), at: new Date().toISOString() });
    } catch {
      if (!errors.length) errors.push(`${config.label} scores could not refresh. Previously loaded scores may be out of date.`);
    }
  }
  try {
    if (directory.value === null) throw new Error('Directory failed');
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
    const scores = [...snapshot.scores.values()];
    const primary = LEAGUES[league].scoreboardFeeds.filter(feed => feed.role === 'primary').flatMap(feed => snapshot.scores.get(feed.url)?.games || []);
    const supplemental = LEAGUES[league].scoreboardFeeds.filter(feed => feed.role === 'supplemental').flatMap(feed => snapshot.scores.get(feed.url)?.games || []);
    const primaryIds = new Set(primary.map(game => game.id));
    const unique = new Map(primary.map(game => [game.id, game]));
    for (const game of supplemental) if (!unique.has(game.id)) unique.set(game.id, game);
    const directory = snapshot.directory?.games || [];
    const directoryIds = new Set(directory.map(game => game.id));
    games.push(...mergeGames([...unique.values()], directory).filter(game => primaryIds.has(game.id) || directoryIds.has(game.id) || Boolean(game.sourceUrl)));
    leagues[league] = { week: scores.map(feed => feed.week).find(week => week !== undefined), scoresAt: scores.map(feed => feed.at).sort().at(-1) || null, sourceAt: snapshot.directory?.at || null, errors: snapshot.errors };
  }
  cache = { games, leagues, updatedAt: new Date().toISOString() };
  return cache;
}

export async function getFootballBoard(): Promise<Board> {
  if (!cache || Date.now() - Date.parse(cache.updatedAt) >= 25000) running ??= refresh().finally(() => { running = null; });
  const board = running ? await running : cache;
  if (!board) throw new Error('Football board unavailable');
  const now = Date.now();
  return { ...board, games: board.games.map(game => {
    if (game.date || !game.sourceUrl) return game;
    const entry = sourceDates.get(game.sourceUrl);
    if (!entry?.date || entry.expiresAt <= now) return game;
    if (!/^(?:ncaaf-)?source-/.test(game.id)) return { ...game, date: entry.date };
    const upcoming = Date.parse(entry.date) > now && game.detail !== 'Listed live · score unavailable';
    return { ...game, date: entry.date, status: upcoming ? 'pre' : game.status };
  }) };
}

export function warmSourceDates(board: Board): Promise<void> {
  if (warming) return warming;
  const games = cache?.games ?? board.games;
  const current = new Set(games.map(game => game.sourceUrl).filter((url): url is string => url !== undefined && validSourcePage(url)));
  const now = Date.now();
  for (const [url, entry] of sourceDates) if (!current.has(url) || entry.expiresAt <= now) sourceDates.delete(url);
  const pending = [...new Set(games.filter(game => !game.date).map(game => game.sourceUrl).filter((url): url is string => url !== undefined && current.has(url)))].filter(url => !sourceDates.has(url)).slice(0, 24);
  if (!pending.length) return Promise.resolve();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const url = pending[next++];
      try {
        const html = await read(url).then(response => response.text());
        const date = parseSourceDate(html);
        sourceDates.set(url, { date, expiresAt: Date.now() + (date ? 3600000 : 300000) });
      } catch {
        sourceDates.set(url, { date: null, expiresAt: Date.now() + 300000 });
      }
    }
  };
  warming = Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker)).then(() => { warming = null; }, () => { warming = null; });
  return warming;
}
