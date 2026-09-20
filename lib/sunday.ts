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
export function parseDirectory(html: string): Game[] {
  const games: Game[] = [];
  for (const match of html.matchAll(/<a\b[^>]*class="[^"]*MaclariListele[^\"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = match[1], body = match[2];
    if (!url.startsWith('https://isportsurge.ws/watch/nfl/')) continue;
    const names = [...body.matchAll(/class="team-name-event-row"[\s\S]*?<img\b[^>]*alt="([^"]+)"[^>]*src="([^"]+)"/g)];
    if (names.length !== 2) continue;
    const team = (m: RegExpMatchArray): Team => ({ name: clean(m[1]), short: clean(m[1]).split(' ').slice(-1)[0], abbreviation: clean(m[1]).split(' ').map(v => v[0]).join('').slice(0,3), color: '566775', logo: m[2].startsWith('https://') ? m[2] : undefined, score: null });
    const detail = clean(body.match(/class="time-badge[^\"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] || 'Schedule unavailable');
    games.push({ id: `source-${url.split('/').pop()}`, name: `${names[0][1]} vs ${names[1][1]}`, away: team(names[0]), home: team(names[1]), status: 'unknown', detail: detail === 'In Progress' ? 'Listed live · score unavailable' : detail, redzone: false, sourceUrl: url });
  }
  return games;
}
// ESPN's public scoreboard is an external, unversioned feed. Validate the fields we use.
export function parseScoreboard(data: unknown): Game[] {
  const events = (data as { events?: unknown[] })?.events;
  if (!Array.isArray(events)) throw new Error('Scoreboard format changed');
  return events.flatMap((raw) => {
    const e = raw as Record<string, any>;
    const c = e.competitions?.[0];
    if (!c || !Array.isArray(c.competitors)) return [];
    const home = c.competitors.find((t: any) => t.homeAway === 'home');
    const away = c.competitors.find((t: any) => t.homeAway === 'away');
    if (!home?.team?.displayName || !away?.team?.displayName || !e.id) return [];
    const team = (t: any): Team => ({ name: t.team.displayName, short: t.team.shortDisplayName || t.team.name, abbreviation: t.team.abbreviation, color: /^[a-f0-9]{6}$/i.test(t.team.color) ? t.team.color : '566775', logo: typeof t.team.logo === 'string' && t.team.logo.startsWith('https://') ? t.team.logo : undefined, score: t.score == null ? null : String(t.score), record: t.records?.find((r: any) => r.type === 'total')?.summary });
    const status = e.status || c.status;
    return [{ id: String(e.id), name: e.name, date: e.date, home: team(home), away: team(away), status: ['pre','in','post'].includes(status?.type?.state) ? status.type.state : 'unknown', detail: status?.type?.shortDetail || 'Status unavailable', redzone: c.situation?.isRedZone === true && status?.type?.state === 'in', down: c.situation?.downDistanceText, possession: c.situation?.possession === home.id ? home.team.abbreviation : c.situation?.possession === away.id ? away.team.abbreviation : undefined, lastPlay: c.situation?.lastPlay?.text, venue: c.venue?.fullName, broadcast: c.broadcasts?.[0]?.names?.join(' / ') } as Game];
  });
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
export function priority(game: Game): number { return (game.status === 'in' ? 100 : game.status === 'pre' ? 30 : 0) + (game.redzone ? 60 : 0) + (game.status === 'in' && Math.abs(Number(game.home.score) - Number(game.away.score)) <= 8 ? 15 : 0); }
