const { randomUUID } = require('node:crypto');
const { CATEGORY_URLS, parseCategory, parseDetail } = require('./sportsurge-catalog.cjs');

function failure(error) {
  return ['blocked','timeout','parser-changed','unavailable','invalid-detail-url','limit'].includes(error?.message) ? error.message : 'unavailable';
}

async function runSportsurgeSweep({ read, send, signal, now = Date.now, runId = randomUUID() }) {
  const catalog = { runId, sequence: 0, startedAt: now(), state: { kind: 'collecting' },
    categories: { ncaaf: { kind: 'pending' }, nfl: { kind: 'pending' } }, events: [], rejectedGames: [], catalogIssues: [] };
  let accepted = structuredClone(catalog);
  const publish = async () => {
    try { await send(catalog); }
    catch (error) {
      if (failure(error) === 'limit' && accepted.sequence < catalog.sequence) {
        const partial = {...accepted,sequence:catalog.sequence,state:{kind:'partial',at:now(),reason:'limit'}};
        await send(partial);
      }
      throw error;
    }
    accepted = structuredClone(catalog);
    catalog.sequence++;
  };
  await publish();
  for (const league of ['ncaaf','nfl']) {
    if (signal.aborted) throw new Error('unavailable');
    try {
      const html = await read(CATEGORY_URLS[league], 'category', league, signal);
      const at = now();
      const result = parseCategory(html, league);
      catalog.categories[league] = result.kind === 'collected' ? { kind: 'collected', at } : { kind: 'failed', at, reason: result.reason };
      catalog.events.push(...result.events);
      catalog.rejectedGames.push(...result.rejectedGames);
      catalog.catalogIssues.push(...result.catalogIssues);
    } catch (error) { catalog.categories[league] = { kind: 'failed', at: now(), reason: failure(error) }; }
    await publish();
  }
  for (const event of catalog.events) {
    if (signal.aborted) throw new Error('unavailable');
    try { event.detail = parseDetail(await read(event.url, 'detail', event.league, signal), event, now()); }
    catch (error) { event.detail = { kind: 'failed', at: now(), reason: failure(error) }; }
    await publish();
  }
  const complete = Object.values(catalog.categories).every(category => category.kind === 'collected') &&
    catalog.events.every(event => event.detail.kind === 'collected') && catalog.rejectedGames.length === 0;
  const firstFailure = Object.values(catalog.categories).find(category => category.kind === 'failed')?.reason ||
    catalog.events.find(event => event.detail.kind === 'failed')?.detail.reason;
  catalog.state = complete ? { kind: 'complete', at: now() } : { kind: 'partial', at: now(), reason: firstFailure || 'parser-changed' };
  await publish();
  return catalog;
}

module.exports = { runSportsurgeSweep };
