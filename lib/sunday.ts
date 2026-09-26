export type Team = { name: string; short: string; abbreviation: string; color: string; logo?: string; score: string | null; record?: string };
export type League = 'nfl' | 'ncaaf';
export type Game = { id: string; league: League; name: string; date?: string; home: Team; away: Team; status: 'pre' | 'in' | 'post' | 'unknown'; detail: string; redzone: boolean; possession?: string; down?: string; lastPlay?: string; venue?: string; broadcast?: string; sourceUrl?: string };
export type LeagueFeedStatus = { week?: number; scoresAt: string | null; sourceAt: string | null; errors: string[] };
export type Board = { games: Game[]; updatedAt: string; leagues: Record<League, LeagueFeedStatus> };
export type Feed = { url: string; label: string };
export type SourcePlayer = { id: string; label: string; url: string };
export const LEAGUES = {
  nfl: { label: 'NFL', scoreboardFeeds: [{ url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', format: 'site', role: 'primary' }], directoryUrl: 'https://isportsurge.ws/nfl/livestreams3', sourcePath: /^\/watch\/nfl\/[a-z0-9-]+\/\d+$/ },
  ncaaf: { label: 'NCAA', scoreboardFeeds: [
    { url: 'https://cdn.espn.com/core/college-football/scoreboard?xhr=1&limit=500&group=80', format: 'cdn', role: 'primary' },
    { url: 'https://cdn.espn.com/core/college-football/scoreboard?xhr=1&limit=500&group=81', format: 'cdn', role: 'supplemental' },
    { url: 'https://cdn.espn.com/core/college-football/scoreboard?xhr=1&limit=500&group=35', format: 'cdn', role: 'supplemental' },
  ], directoryUrl: 'https://isportsurge.ws/cfb/livestreams2', sourcePath: /^\/watch\/cfb\/[a-z0-9-]+\/\d+$/ },
} satisfies Record<League, { label: string; scoreboardFeeds: { url: string; format: 'site' | 'cdn'; role: 'primary' | 'supplemental' }[]; directoryUrl: string; sourcePath: RegExp }>;
export function validGameId(value: unknown): value is string { return typeof value === 'string' && /^(?:\d{1,20}|source-\d{1,20}|redzone|ncaaf-\d{1,20}|ncaaf-source-\d{1,20})$/.test(value); }
export function validSourcePage(value: string): boolean {
  try { const u = new URL(value); return u.origin === 'https://isportsurge.ws' && !u.username && !u.password && !u.search && !u.hash && (LEAGUES.nfl.sourcePath.test(u.pathname) || LEAGUES.ncaaf.sourcePath.test(u.pathname) || u.pathname === '/event/nfl/nfl-redzone-live-streaming-links'); } catch { return false; }
}
export function parsePlayers(html: string): SourcePlayer[] {
  const initial = html.match(/<iframe\b[^>]*src="(https:\/\/gooz\.aapmains\.net\/new-stream-embed\/(\d+))"/i);
  if (!initial) return [];
  const ids = [...new Set([initial[2], ...[...html.matchAll(/changeStream\((\d+)\)/g)].map(m => m[1])])].slice(0, 6);
  return ids.map((id, index) => ({ id, label: index ? `Backup ${index}` : 'Primary', url: `https://gooz.aapmains.net/new-stream-embed/${id}` }));
}
const clean = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
export function parseDirectory(html: string, league: League = 'nfl'): Game[] {
  const games: Game[] = [];
  for (const match of html.matchAll(/<a\b[^>]*class="[^"]*MaclariListele[^\"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = match[1], body = match[2];
    if (!validSourcePage(url) || !LEAGUES[league].sourcePath.test(new URL(url).pathname)) continue;
    const names = [...body.matchAll(/class="team-name-event-row"[\s\S]*?<img\b[^>]*alt="([^"]+)"[^>]*src="([^"]+)"/g)];
    if (names.length !== 2) continue;
    const team = (m: RegExpMatchArray): Team => ({ name: clean(m[1]), short: league === 'ncaaf' ? clean(m[1]) : clean(m[1]).split(' ').slice(-1)[0], abbreviation: clean(m[1]).split(' ').map(v => v[0]).join('').slice(0,3), color: '566775', logo: m[2].startsWith('https://') ? m[2] : undefined, score: null });
    const detail = clean(body.match(/class="time-badge[^\"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] || 'Schedule unavailable');
    games.push({ id: `${league === 'ncaaf' ? 'ncaaf-' : ''}source-${url.split('/').pop()}`, league, name: `${clean(names[0][1])} vs ${clean(names[1][1])}`, away: team(names[0]), home: team(names[1]), status: 'unknown', detail: detail === 'In Progress' ? 'Listed live · score unavailable' : detail, redzone: false, sourceUrl: url });
  }
  return games;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function items(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
export function scoreboardWeek(data: unknown): number | undefined {
  const week = object(object(data)?.week)?.number;
  return typeof week === 'number' && Number.isInteger(week) ? week : undefined;
}
export function scoreboardFeedData(data: unknown, format: 'site' | 'cdn'): unknown {
  if (format === 'site') return data;
  const payload = object(object(data)?.content)?.sbData;
  if (!object(payload)) throw new Error('Scoreboard format changed');
  return payload;
}

const easternTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function parseSourceDate(html: string): string | null {
  const aside = [...html.matchAll(/<aside\b[^>]*class="[^"]*\bmatch-info\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi)];
  const dates = [...new Set(aside.flatMap(match => [...match[1].matchAll(/<dt\b[^>]*>\s*Date:\s*<\/dt>\s*<dd\b[^>]*>\s*([^<]+?)\s*<\/dd>/gi)].map(date => date[1])))];
  if (dates.length !== 1) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})ET$/.exec(dates[0]);
  if (!parts) return null;
  const [, year, month, day, hour, minute] = parts;
  const local = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 16) !== `${year}-${month}-${day}T${hour}:${minute}`) return null;
  const matches = [4, 5].map(offset => local + offset * 3600000).filter(candidate => {
    const fields = Object.fromEntries(easternTime.formatToParts(candidate).map(part => [part.type, part.value]));
    return fields.year === year && fields.month === month && fields.day === day && fields.hour === hour && fields.minute === minute;
  });
  return matches.length === 1 ? new Date(matches[0]).toISOString() : null;
}
export function parseScoreboard(data: unknown, league: League = 'nfl'): Game[] {
  const events = object(data)?.events;
  if (!Array.isArray(events)) throw new Error('Scoreboard format changed');
  return events.flatMap((raw): Game[] => {
    const event = object(raw);
    const competition = object(items(event?.competitions)[0]);
    const competitors = items(competition?.competitors).map(object).filter((item): item is Record<string, unknown> => item !== null);
    const home = competitors.find(item => item.homeAway === 'home');
    const away = competitors.find(item => item.homeAway === 'away');
    const homeTeam = object(home?.team), awayTeam = object(away?.team);
    const id = text(event?.id);
    if (!id || !/^\d{1,20}$/.test(id) || !text(homeTeam?.displayName) || !text(awayTeam?.displayName) || !home || !away || !homeTeam || !awayTeam) return [];
    const team = (item: Record<string, unknown>, info: Record<string, unknown>): Team => {
      const name = text(info.displayName) || '';
      const color = text(info.color), logo = text(info.logo);
      const record = items(item.records).map(object).find(entry => entry?.type === 'total');
      return { name, short: text(info.shortDisplayName) || (league === 'ncaaf' ? name : text(info.name)) || name, abbreviation: text(info.abbreviation) || name.slice(0, 3), color: color && /^[a-f0-9]{6}$/i.test(color) ? color : '566775', logo: logo?.startsWith('https://') ? logo : undefined, score: typeof item.score === 'string' || typeof item.score === 'number' ? String(item.score) : null, record: text(record?.summary) };
    };
    const status = object(event?.status) || object(competition?.status);
    const statusType = object(status?.type);
    const state = statusType?.state;
    const gameStatus: Game['status'] = state === 'pre' || state === 'in' || state === 'post' ? state : 'unknown';
    const shortDetail = text(statusType?.shortDetail) || 'Status unavailable';
    const detail = statusType?.name === 'STATUS_SCHEDULED' && shortDetail !== 'TBD' && shortDetail !== 'TBA' ? 'Scheduled' : shortDetail;
    const situation = object(competition?.situation);
    const names = items(object(items(competition?.broadcasts)[0])?.names).filter((name): name is string => typeof name === 'string');
    return [{ id: league === 'ncaaf' ? `ncaaf-${id}` : id, league, name: text(event?.name) || `${awayTeam.displayName} at ${homeTeam.displayName}`, date: text(event?.date), home: team(home, homeTeam), away: team(away, awayTeam), status: gameStatus, detail, redzone: situation?.isRedZone === true && gameStatus === 'in', down: text(situation?.downDistanceText), possession: situation?.possession === home.id ? text(homeTeam.abbreviation) : situation?.possession === away.id ? text(awayTeam.abbreviation) : undefined, lastPlay: text(object(situation?.lastPlay)?.text), venue: text(object(competition?.venue)?.fullName), broadcast: names.length ? names.join(' / ') : undefined }];
  });
}
export function mergeGames(scores: Game[], directory: Game[]): Game[] {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pair = (game: Game) => `${game.league}:${[normalize(game.home.name), normalize(game.away.name)].sort().join('|')}`;
  const scorePairs = new Map<string, Game[]>(), directoryPairs = new Map<string, Game[]>(), sourceCounts = new Map<string, number>();
  for (const game of scores) scorePairs.set(pair(game), [...(scorePairs.get(pair(game)) || []), game]);
  for (const game of directory) {
    directoryPairs.set(pair(game), [...(directoryPairs.get(pair(game)) || []), game]);
    if (game.sourceUrl) sourceCounts.set(game.sourceUrl, (sourceCounts.get(game.sourceUrl) || 0) + 1);
  }
  const matched = new Set<string>();
  const merged = scores.map(game => {
    const matches = directoryPairs.get(pair(game)) || [];
    if (scorePairs.get(pair(game))?.length !== 1 || matches.length !== 1 || !matches[0].sourceUrl || sourceCounts.get(matches[0].sourceUrl) !== 1) return game;
    matched.add(matches[0].id);
    return { ...game, sourceUrl: matches[0].sourceUrl };
  });
  const seen = new Set(merged.map(game => game.id));
  for (const game of directory) if (!matched.has(game.id) && !seen.has(game.id)) { merged.push(game); seen.add(game.id); }
  return merged;
}
export function validFeedUrl(input: string): string | null {
  try { const url = new URL(input.trim()); return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function priority(game: Game): number { return (game.status === 'in' ? 100 : game.status === 'pre' ? 30 : 0) + (game.redzone ? 60 : 0) + (game.status === 'in' && Math.abs(Number(game.home.score) - Number(game.away.score)) <= 8 ? 15 : 0); }
