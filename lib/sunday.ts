export type Team = { name: string; short: string; abbreviation: string; color: string; logo?: string; score: string | null; record?: string };
export type Game = { id: string; name: string; date?: string; home: Team; away: Team; status: 'pre' | 'in' | 'post' | 'unknown'; detail: string; redzone: boolean; possession?: string; down?: string; lastPlay?: string; venue?: string; broadcast?: string; sourceUrl?: string };
export type Board = { games: Game[]; updatedAt: string; scoresAt: string | null; sourceAt: string | null; week?: number; errors: string[] };
export type Feed = { url: string; label: string };
export type SourcePlayer = { id: string; label: string; url: string };
export function validSourcePage(value: string): boolean {
  try { const u = new URL(value); return u.origin === 'https://isportsurge.ws' && !u.username && !u.password && !u.search && !u.hash && /^\/(?:watch\/nfl\/[a-z0-9-]+\/\d+|event\/nfl\/nfl-redzone-live-streaming-links)$/.test(u.pathname); } catch { return false; }
}
export function parsePlayers(html: string): SourcePlayer[] {
  const initial = html.match(/<iframe\b[^>]*src="(https:\/\/gooz\.aapmains\.net\/new-stream-embed\/(\d+))"/i);
  if (!initial) return [];
  const ids = [...new Set([initial[2], ...[...html.matchAll(/changeStream\((\d+)\)/g)].map(m => m[1])])].slice(0, 6);
  return ids.map((id, index) => ({ id, label: index ? `Backup ${index}` : 'Primary', url: `https://gooz.aapmains.net/new-stream-embed/${id}` }));
}
export const SOURCE = 'https://isportsurge.ws/nfl/livestreams3';
const clean = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
const attribute = (attributes: string, name: string) => {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? clean(match[1] ?? match[2] ?? match[3]) : '';
};
export function parseDirectory(html: string): Game[] {
  const games: Game[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!attribute(match[1], 'class').split(/\s+/).includes('MaclariListele')) continue;
    const url = attribute(match[1], 'href'), body = match[2];
    if (!validSourcePage(url) || !new URL(url).pathname.startsWith('/watch/nfl/')) continue;
    const id = `source-${url.split('/').pop()}`;
    if (seen.has(id)) continue;
    const names = [...body.matchAll(/<[^>]*\bclass\s*=\s*(?:"[^"]*\bteam-name-event-row\b[^"]*"|'[^']*\bteam-name-event-row\b[^']*')[^>]*>[\s\S]*?<img\b([^>]*)>/gi)]
      .map(row => ({ name: attribute(row[1], 'alt'), logo: attribute(row[1], 'src') }))
      .filter(row => row.name);
    if (names.length !== 2) continue;
    const team = (row: { name: string; logo: string }): Team => ({ name: row.name, short: row.name.split(' ').slice(-1)[0], abbreviation: row.name.split(' ').map(v => v[0]).join('').slice(0,3), color: '566775', logo: row.logo.startsWith('https://') ? row.logo : undefined, score: null });
    const badge = [...body.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)].find(row => attribute(row[1], 'class').split(/\s+/).includes('time-badge'));
    const detail = clean(badge?.[2] || 'Schedule unavailable');
    seen.add(id);
    games.push({ id, name: `${names[0].name} vs ${names[1].name}`, away: team(names[0]), home: team(names[1]), status: 'unknown', detail: detail === 'In Progress' ? 'Listed live · score unavailable' : detail, redzone: false, sourceUrl: url });
  }
  return games;
}
// ESPN's public scoreboard is an external, unversioned feed. Validate the fields we use.
export function parseScoreboard(data: unknown): Game[] {
  const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const identifier = (value: unknown): string | undefined => text(value) || (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);
  const events = record(data)?.events;
  if (!Array.isArray(events)) throw new Error('Scoreboard format changed');
  const seen = new Set<string>();
  const games = events.flatMap((raw): Game[] => {
    const e = record(raw);
    const id = identifier(e?.id);
    if (!e || !id || seen.has(id)) return [];
    const c = record(Array.isArray(e.competitions) ? e.competitions[0] : undefined);
    if (!c || !Array.isArray(c.competitors)) return [];
    const competitors = c.competitors.map(record).filter((entry): entry is Record<string, unknown> => !!entry);
    const home = competitors.find(t => t.homeAway === 'home');
    const away = competitors.find(t => t.homeAway === 'away');
    const team = (competitor: Record<string, unknown> | undefined): Team | null => {
      const source = record(competitor?.team), name = text(source?.displayName);
      if (!competitor || !source || !name) return null;
      const short = text(source.shortDisplayName) || text(source.name) || name;
      const abbreviation = text(source.abbreviation) || name.split(/\s+/).map(word => word[0]).join('').slice(0, 3).toUpperCase();
      const color = text(source.color);
      const logo = text(source.logo);
      const records = Array.isArray(competitor.records) ? competitor.records : [];
      const total = records.map(record).find(entry => entry?.type === 'total');
      const rawScore = typeof competitor.score === 'number' ? String(competitor.score) : text(competitor.score);
      return { name, short, abbreviation, color: color && /^[a-f0-9]{6}$/i.test(color) ? color : '566775', logo: logo?.startsWith('https://') ? logo : undefined, score: rawScore && /^\d+$/.test(rawScore) ? rawScore : null, record: text(total?.summary) };
    };
    const homeTeam = team(home), awayTeam = team(away);
    if (!homeTeam || !awayTeam) return [];
    const status = record(record(e.status)?.type) || record(record(c.status)?.type);
    const state: Game['status'] = status?.state === 'pre' || status?.state === 'in' || status?.state === 'post' ? status.state : 'unknown';
    const situation = record(c.situation), possession = identifier(situation?.possession);
    const broadcasts = Array.isArray(c.broadcasts) ? c.broadcasts : [];
    const names = record(broadcasts[0])?.names;
    const broadcast = Array.isArray(names) ? names.map(text).filter(Boolean).join(' / ') : undefined;
    const date = text(e.date);
    seen.add(id);
    return [{ id, name: text(e.name) || `${awayTeam.name} at ${homeTeam.name}`, date: date && Number.isFinite(Date.parse(date)) ? date : undefined, home: homeTeam, away: awayTeam, status: state, detail: text(status?.shortDetail) || 'Status unavailable', redzone: situation?.isRedZone === true && state === 'in', down: text(situation?.downDistanceText), possession: possession && possession === identifier(home?.id) ? homeTeam.abbreviation : possession && possession === identifier(away?.id) ? awayTeam.abbreviation : undefined, lastPlay: text(record(situation?.lastPlay)?.text), venue: text(record(c.venue)?.fullName), broadcast: broadcast || undefined }];
  });
  if (events.length && !games.length) throw new Error('Scoreboard contained no valid games');
  return games;
}
export function mergeGames(scores: Game[], directory: Game[]): Game[] {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  if (!scores.length) return directory;
  return scores.map(game => {
    const names = [normalize(game.home.name), normalize(game.away.name)].sort().join('|');
    const link = directory.find(d => [normalize(d.home.name), normalize(d.away.name)].sort().join('|') === names);
    return { ...game, sourceUrl: link?.sourceUrl };
  });
}
export function validFeedUrl(input: string): string | null {
  try { const url = new URL(input.trim()); return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function priority(game: Game): number {
  const knownScores = [game.home.score, game.away.score].every(score => typeof score === 'string' && /^\d+$/.test(score));
  return (game.status === 'in' ? 100 : game.status === 'pre' ? 30 : 0) + (game.redzone ? 60 : 0) + (game.status === 'in' && knownScores && Math.abs(Number(game.home.score) - Number(game.away.score)) <= 8 ? 15 : 0);
}
