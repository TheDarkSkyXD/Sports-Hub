const { browserCategories } = require('./source-registry.cjs');
const { helper } = require('./native-browser-catalog.cjs');

const CATEGORIES = browserCategories('sportsurge-v2');
const CATEGORY_URLS = Object.fromEntries(Object.entries(CATEGORIES).map(([league, category]) => [league, category.url]));
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const native = (name, ...args) => helper('sportsurge-v2', name, args);

module.exports = {
  CATEGORY_URLS, MAX_PAGE_BYTES, MAX_CHECKPOINT_BYTES,
  detailUrl: (value, league) => native('detailUrl', value, league),
  destination: value => native('destination', value),
  parseCategory: (html, league) => native('parseCategory', html, league),
  parseDetail: (html, event, at) => native('parseDetail', html, event, at),
};
