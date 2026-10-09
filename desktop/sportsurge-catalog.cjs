const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const { load } = require('./cheerio.cjs');

const ORIGIN = 'https://v2.sportsurge.net';
const CATEGORIES = require('./source-registry.cjs').browserCategories('sportsurge-v2');
const CATEGORY_URLS = Object.fromEntries(Object.entries(CATEGORIES).map(([league,category])=>[league,category.url]));
const DETAIL_PATH = /^\/watch-(\d{1,12})-([a-z0-9]+)-[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const CREDENTIAL_KEY = /^(?:token|access_token|auth|authorization|key|signature|sig|st|e|x-amz-.+)$/i;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

function digest(value) { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
function reasonForPage(html) {
  return /<title>\s*Just a moment|verify you are human|checking your browser/i.test(html) ? 'blocked' : 'parser-changed';
}
function detailUrl(value, league) {
  try {
    const url = new URL(value, `${ORIGIN}/`);
    const match = DETAIL_PATH.exec(url.pathname);
    if (url.href.length > 400 || url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !match || match[2] !== CATEGORIES[league]?.pathCode) return null;
    return { id: `${league}:${match[1]}`, url: url.href };
  } catch { return null; }
}
function destination(value) {
  if (!value || !value.trim()) return { kind: 'malformed', reason: 'missing' };
  let url;
  try { url = new URL(value); } catch { return { kind: 'malformed', reason: 'invalid-url' }; }
  const display = url.hostname.slice(0, 240) || null;
  if (url.protocol !== 'https:') return { kind: 'rejected', reason: 'insecure', display };
  if (url.username || url.password || url.port) return { kind: 'rejected', reason: 'credentials', display };
  if (!url.hostname || isIP(url.hostname.replace(/^\[|\]$/g,'')) || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal'))
    return { kind: 'rejected', reason: 'private-host', display };
  if ([...url.searchParams.keys()].some(key => CREDENTIAL_KEY.test(key)) || /(?:^#|[&?])(?:token|access_token|auth|authorization|key|signature|sig|st|e|x-amz-[^=]+)=/i.test(url.hash))
    return { kind: 'rejected', reason: 'credential-query', display };
  if (url.href.length > 2000) return { kind: 'rejected', reason: 'oversized', display };
  return { kind: 'link', url: url.href };
}
function parseCategory(html, league) {
  if (!CATEGORIES[league]) return {kind:'failed',reason:'parser-changed',events:[],rejectedGames:[],catalogIssues:[]};
  const $ = load(html);
  const container = $('#match-list-container');
  if (!container.length) return { kind: 'failed', reason: reasonForPage(html), events: [], rejectedGames: [], catalogIssues: [] };
  const rows = container.find('a.match-row').toArray();
  if (!rows.length) {
    const empty = container.children('.watch-empty-state').filter((_, element) => {
      const node = $(element);
      return !node.hasClass('match-filter-empty') && !/display\s*:\s*none/i.test(node.attr('style') || '') && /no live or upcoming games/i.test(node.text());
    });
    return empty.length ? { kind: 'collected', events: [], rejectedGames: [], catalogIssues: [] } : { kind: 'failed', reason: reasonForPage(html), events: [], rejectedGames: [], catalogIssues: [] };
  }
  const events = [];
  const rejectedGames = [];
  const catalogIssues = [];
  const ids = new Set();
  const urls = new Set();
  let malformed = false;
  for (const row of rows) {
    const element = $(row);
    const path = detailUrl(element.attr('href') || '', league);
    if (!path) {
      malformed = true;
      rejectedGames.push({league,title:element.text().replace(/\s+/g,' ').trim().slice(0,240),
        reason:'invalid-detail-url'});
      continue;
    }
    if (urls.has(path.url)) continue;
    urls.add(path.url);
    if (ids.has(path.id)) catalogIssues.push({league,title:element.text().replace(/\s+/g,' ').trim().slice(0,240),reason:'duplicate-game-id'});
    ids.add(path.id);
    const names = element.find('.match-row-team-name').map((_, item) => $(item).text().replace(/\s+/g, ' ').trim()).get();
    const teams = names.length === 2 && names.every(name => name.length > 0 && name.length <= 120) ? names : null;
    const rawTime = element.find('.match-time[data-timestamp]').first().attr('data-timestamp') || '';
    const epoch = /^\d{10}$/.test(rawTime) ? Number(rawTime)*1000 : /^\d{13}$/.test(rawTime) ? Number(rawTime) : NaN;
    const kickoff = Number.isSafeInteger(epoch) && epoch >= 946684800000 && epoch < 4102444800000 ? epoch : null;
    const rawCount = /\b(\d{1,5})\s+Streams?\b/i.exec(element.text());
    events.push({
      id: path.id, url: path.url, league,
      title: teams ? `${teams[0]} vs ${teams[1]}`.slice(0,240) :
        (element.attr('title') || names.join(' ') || `Sportsurge ${league.toUpperCase()} ${path.id.split(':')[1]}`).trim().slice(0,240),
      teams, sourceStatus: element.find('.live-badge').length ? 'live' : kickoff !== null ? 'upcoming' : 'unknown',
      kickoff, advertisedLinkCount: rawCount ? Number(rawCount[1]) : null,
      detail: { kind: 'pending' },
    });
  }
  return malformed ? { kind: 'failed', reason: 'parser-changed', events, rejectedGames, catalogIssues } : { kind: 'collected', events, rejectedGames, catalogIssues };
}
function parseDetail(html, event, at) {
  const $ = load(html);
  const list = $('.stream-list');
  if (!list.length) return { kind: 'failed', at, reason: reasonForPage(html) };
  const rows = list.find('.stream-item').toArray();
  if (!rows.length && !/no streams available|no streams found/i.test(list.text())) return { kind: 'failed', at, reason: 'parser-changed' };
  const ids = new Map();
  const providers = rows.map(row => {
    const element = $(row);
    const label = element.find('.stream-row-site-name').first().text().replace(/\s+/g, ' ').trim().slice(0, 160) || 'Unnamed provider';
    const raw = element.attr('data-href') || '';
    const vote = element.find('.stream-vote[id]').first().attr('id') || '';
    const base = /^stream-\d{1,20}$/.test(vote) ? vote : `row-${digest(`${event.id}|${label}|${raw}`)}`;
    const occurrence = ids.get(base) || 0;
    ids.set(base, occurrence + 1);
    return { id: `${base}-${occurrence}`, label, observedAt: at, destination: destination(raw) };
  });
  return { kind: 'collected', at, providers };
}

module.exports = { CATEGORY_URLS, MAX_PAGE_BYTES, MAX_CHECKPOINT_BYTES, detailUrl, destination, parseCategory, parseDetail };
