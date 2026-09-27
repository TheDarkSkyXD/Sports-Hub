const { randomUUID } = require('node:crypto');
const { CATEGORY_URLS,parseCategory,parseDetail,freeServerUrls,activeFreeServerUrl,channelId } = require('./streameast-catalog.cjs');

function failure(error) {
  return ['blocked','timeout','parser-changed','unavailable','limit'].includes(error?.message) ? error.message : 'unavailable';
}

async function runStreameastSweep({read,send,signal,now=Date.now,runId=randomUUID()}) {
  const catalog={runId,sequence:0,startedAt:now(),state:{kind:'collecting'},
    categories:{ncaaf:{kind:'pending'},nfl:{kind:'pending'}},events:[],rejectedGames:[]};
  let accepted=structuredClone(catalog);
  const publish=async()=>{
    try {await send(catalog);}
    catch(error) {
      if (failure(error)==='limit' && accepted.sequence<catalog.sequence)
        await send({...accepted,sequence:catalog.sequence,state:{kind:'partial',at:now(),reason:'limit'}});
      throw error;
    }
    accepted=structuredClone(catalog);
    catalog.sequence++;
  };
  await publish();
  let unresolvedRead=false;
  for (const league of ['ncaaf','nfl']) {
    if (signal.aborted) throw new Error('unavailable');
    try {
      const result=parseCategory(await read(CATEGORY_URLS[league],'category',league,signal),league);
      const at=now();
      catalog.categories[league]=result.kind==='collected' ? {kind:'collected',at} : {kind:'failed',at,reason:result.reason};
      catalog.events.push(...result.events);
      catalog.rejectedGames.push(...result.rejectedGames);
    } catch(error) { catalog.categories[league]={kind:'failed',at:now(),reason:failure(error)}; }
    await publish();
  }
  for (const event of catalog.events) {
    if (signal.aborted) throw new Error('unavailable');
    try {
      const html=await read(event.url,'detail',event.league,signal);
      const freePages=new Map();
      const active=activeFreeServerUrl(html,event);
      if (active) {
        const id=channelId(html);
        freePages.set(active,id ? {kind:'channel',id} : {kind:'unsupported'});
      }
      for (const url of freeServerUrls(html,event)) {
        if (signal.aborted) throw new Error('unavailable');
        if (freePages.has(url)) continue;
        try {
          const page=await read(url,'server',event.league,signal);
          const id=channelId(page);
          freePages.set(url,id ? {kind:'channel',id} : {kind:'unsupported'});
        } catch { freePages.set(url,{kind:'unknown'}); unresolvedRead=true; }
      }
      event.detail=parseDetail(html,event,now(),freePages);
    } catch(error) {event.detail={kind:'failed',at:now(),reason:failure(error)};}
    await publish();
  }
  const complete=Object.values(catalog.categories).every(category=>category.kind==='collected') &&
    catalog.events.every(event=>event.detail.kind==='collected') && catalog.rejectedGames.length===0 && !unresolvedRead;
  const firstFailure=Object.values(catalog.categories).find(category=>category.kind==='failed')?.reason ||
    catalog.events.find(event=>event.detail.kind==='failed')?.detail.reason;
  catalog.state=complete ? {kind:'complete',at:now()} : {kind:'partial',at:now(),reason:firstFailure || (unresolvedRead?'unavailable':'parser-changed')};
  await publish();
  return catalog;
}

module.exports={runStreameastSweep};
