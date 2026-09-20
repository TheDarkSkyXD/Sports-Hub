import type { Game } from './sunday.ts';

const matchupConnectors = new Set(['at', 'vs', 'v', 'versus']);
const canonicalTeams = new Map([
  ['arizona cardinals', 'ari'], ['atlanta falcons', 'atl'], ['baltimore ravens', 'bal'], ['buffalo bills', 'buf'],
  ['carolina panthers', 'car'], ['chicago bears', 'chi'], ['cincinnati bengals', 'cin'], ['cleveland browns', 'cle'],
  ['dallas cowboys', 'dal'], ['denver broncos', 'den'], ['detroit lions', 'det'], ['green bay packers', 'gb'],
  ['houston texans', 'hou'], ['indianapolis colts', 'ind'], ['jacksonville jaguars', 'jax'], ['kansas city chiefs', 'kc'],
  ['los angeles chargers', 'lac'], ['los angeles rams', 'lar'], ['las vegas raiders', 'lv'], ['miami dolphins', 'mia'],
  ['minnesota vikings', 'min'], ['new england patriots', 'ne'], ['new orleans saints', 'no'], ['new york giants', 'nyg'],
  ['new york jets', 'nyj'], ['philadelphia eagles', 'phi'], ['pittsburgh steelers', 'pit'], ['san francisco 49ers', 'sf'],
  ['seattle seahawks', 'sea'], ['tampa bay buccaneers', 'tb'], ['tennessee titans', 'ten'], ['washington commanders', 'wsh'],
]);
const canonicalAbbreviations = new Set([...canonicalTeams.values(), 'was']);
const canonicalCode = (code: string) => code === 'was' ? 'wsh' : code;

function normalizeSearch(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find a matchup from team names, abbreviations, or any order of search terms. */
export function matchesGameSearch(game: Game, query: string): boolean {
  const terms = normalizeSearch(query).split(/\s+/).filter(term => term && !matchupConnectors.has(term));
  if (!terms.length) return true;
  const teams = [game.home, game.away];
  const abbreviations = new Set(teams.map(team => canonicalCode(normalizeSearch(team.abbreviation))));
  for (const team of teams) {
    // Directory fallback abbreviations can be generated initials, such as CB for Chicago.
    const canonical = canonicalTeams.get(normalizeSearch(team.name));
    if (canonical) abbreviations.add(canonical);
  }
  const words = [game.name, ...teams.flatMap(team => [team.name, team.short])]
    .flatMap(field => normalizeSearch(field).split(/\s+/));
  return terms.every(term => {
    const code = canonicalCode(term);
    if (canonicalAbbreviations.has(term) || abbreviations.has(code)) return abbreviations.has(code);
    return words.some(word => word.startsWith(term));
  });
}
