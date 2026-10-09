const { browserCategories } = require('./source-registry.cjs');
const { helper } = require('./native-browser-catalog.cjs');

const ORIGIN = 'https://v2.streameast.ga';
const CATEGORIES = browserCategories('streameast');
const CATEGORY_URLS = Object.fromEntries(Object.entries(CATEGORIES).map(([league, category]) => [league, category.url]));
const MAX_PAGE_BYTES = 4_000_000;
const MAX_CHECKPOINT_BYTES = 8_000_000;
const native = (name, ...args) => helper('streameast', name, args);
function eventShape(event) {
  return { league: event.id.split(':')[0], title: '', detail: { kind: 'pending' }, ...event };
}

module.exports = {
  ORIGIN, CATEGORIES, CATEGORY_URLS, MAX_PAGE_BYTES, MAX_CHECKPOINT_BYTES,
  eventUrl: (value, league) => native('eventUrl', value, league),
  serverUrl: (value, event) => native('serverUrl', value, eventShape(event)),
  freePlayer: html => native('freePlayer', html),
  publishedFreePlayer: (html, event, selectedUrl) => native('publishedFreePlayer', html, eventShape(event), selectedUrl),
  serverPlayer: (html, event, url) => native('serverPlayer', html, eventShape(event), url),
  parseCategory: (html, league) => native('parseCategory', html, league),
  parseDetail: (html, event, at, freePages) => native('parseDetail', html, event, at, [...freePages]),
  freeServerUrls: (html, event) => native('freeServerUrls', html, eventShape(event)),
  activeFreeServerUrl: (html, event) => native('activeFreeServerUrl', html, eventShape(event)),
};
