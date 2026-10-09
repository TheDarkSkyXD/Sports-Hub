const { randomUUID } = require('node:crypto');
const { CATEGORY_URLS, parseCategory, parseDetail } = require('./sportsurge-catalog.cjs');

function failure(error) {
  return ['blocked','timeout','parser-changed','unavailable','invalid-detail-url','limit','rate-limited'].includes(error?.message) ? error.message : 'unavailable';
}

async function runSportsurgeSweep({ read, send, signal, now = Date.now, runId = randomUUID() }) {
  const catalog = { runId, sequence: 0, startedAt: now(), state: { kind: 'collecting' },
    categories: Object.fromEntries(Object.keys(CATEGORY_URLS).map(league=>[league,{kind:'pending'}])), events: [], rejectedGames: [], catalogIssues: [] };
  let accepted = structuredClone(catalog);
  let pending = [];
  const publish = async () => {
    let ack;
    try { ack = await send(catalog); }
    catch (error) {
      if (failure(error) === 'limit' && accepted.sequence < catalog.sequence) {
        const partial = {...accepted,sequence:catalog.sequence,state:{kind:'partial',at:now(),reason:'limit'}};
        await send(partial);
      }
      throw error;
    }
    accepted = structuredClone(catalog);
    if (catalog.state.kind === 'collecting' && ack?.kind === 'catalog-ack' && Array.isArray(ack.skipDetailEventIds)) {
      const skippedIds = new Set(ack.skipDetailEventIds);
      const skippedUrls = new Set(ack.skipDetailEventUrls || []);
      const retained = event => !skippedIds.has(event.id) && !skippedUrls.has(event.url);
      catalog.events = catalog.events.filter(retained);
      pending = pending.filter(retained);
    }
    if(catalog.state.kind==='collecting'&&ack?.reuseDetails?.kind==='sportsurge-v2') {
      for(const event of catalog.events) {
        if(event.detail.kind!=='pending')continue;
        const retained=ack.reuseDetails.events.find(row=>Object.keys(event).every(key=>
          key==='detail'||JSON.stringify(event[key])===JSON.stringify(row[key])));
        if(retained?.detail.kind==='collected'&&retained.detail.retainedFromRunId)
          event.detail=structuredClone(retained.detail);
      }
      pending=pending.filter(event=>event.detail.kind==='pending');
    }
    catalog.sequence++;
  };
  const rateLimited=async()=>{
    catalog.state={kind:'partial',at:now(),reason:'rate-limited'};
    await publish();
    return catalog;
  };
  await publish();
  const categoryPages=new Map();
  for (const league of Object.keys(CATEGORY_URLS)) {
    if (signal.aborted) throw new Error('unavailable');
    try {
      const url=CATEGORY_URLS[league];
      if(!categoryPages.has(url))categoryPages.set(url,read(url,'category',league,signal));
      const html = await categoryPages.get(url);
      const at = now();
      const result = parseCategory(html, league);
      catalog.categories[league] = result.kind === 'collected' ? { kind: 'collected', at } : { kind: 'failed', at, reason: result.reason };
      catalog.events.push(...result.events);
      catalog.rejectedGames.push(...result.rejectedGames);
      catalog.catalogIssues.push(...result.catalogIssues);
    } catch (error) {
      catalog.categories[league] = { kind: 'failed', at: now(), reason: failure(error) };
      if(failure(error)==='rate-limited')return rateLimited();
    }
    await publish();
  }
  const urgency=event=>event.sourceStatus==='live'?0:
    event.kickoff!==null&&event.kickoff>=now()&&event.kickoff<=now()+60*60_000?1:2;
  pending=catalog.events.filter(event=>event.detail.kind==='pending').sort((left,right)=>urgency(left)-urgency(right)||
    (left.kickoff??Infinity)-(right.kickoff??Infinity));
  const stillPending=event=>catalog.events.includes(event)&&event.detail.kind==='pending';
  let admitted=0;
  while(pending.length) {
    const background=admitted%4===3?pending.findIndex(event=>urgency(event)===2):-1;
    const [event]=pending.splice(background<0?0:background,1);
    admitted++;
    if (signal.aborted) throw new Error('unavailable');
    if(!stillPending(event))continue;
    const result=await read(event.url,'detail',event.league,signal).then(html=>({html}),error=>({error}));
    await publish();
    if(!stillPending(event))continue;
    if('error' in result) {
      event.detail={kind:'failed',at:now(),reason:failure(result.error)};
      if(failure(result.error)==='rate-limited')return rateLimited();
    } else {
      try {event.detail=parseDetail(result.html,event,now());}
      catch(error){event.detail={kind:'failed',at:now(),reason:failure(error)};}
    }
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
