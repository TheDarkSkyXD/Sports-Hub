const { randomUUID } = require('node:crypto');
const { CATEGORY_URLS,parseCategory,parseDetail,freeServerUrls,activeFreeServerUrl,serverPlayer } = require('./streameast-catalog.cjs');

function failure(error) {
  return ['blocked','timeout','parser-changed','unavailable','limit','rate-limited'].includes(error?.message) ? error.message : 'unavailable';
}

async function runStreameastSweep({read,send,signal,now=Date.now,runId=randomUUID()}) {
  const catalog={runId,sequence:0,startedAt:now(),state:{kind:'collecting'},
    categories:{ncaaf:{kind:'pending'},nfl:{kind:'pending'}},events:[],rejectedGames:[]};
  let accepted=structuredClone(catalog);
  let pending=[];
  const publish=async()=>{
    let ack;
    try {ack=await send(catalog);}
    catch(error) {
      if (failure(error)==='limit' && accepted.sequence<catalog.sequence)
        await send({...accepted,sequence:catalog.sequence,state:{kind:'partial',at:now(),reason:'limit'}});
      throw error;
    }
    accepted=structuredClone(catalog);
    if(catalog.state.kind==='collecting'&&ack?.kind==='catalog-ack'&&Array.isArray(ack.skipDetailEventIds)) {
      const skippedIds=new Set(ack.skipDetailEventIds);
      const skippedUrls=new Set(ack.skipDetailEventUrls||[]);
      const retained=event=>!skippedIds.has(event.id)&&!skippedUrls.has(event.url);
      catalog.events=catalog.events.filter(retained);
      pending=pending.filter(retained);
    }
    if(catalog.state.kind==='collecting'&&ack?.reuseDetails?.kind==='streameast') {
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
  let unresolvedRead=false;
  for (const league of ['ncaaf','nfl']) {
    if (signal.aborted) throw new Error('unavailable');
    try {
      const result=parseCategory(await read(CATEGORY_URLS[league],'category',league,signal),league);
      const at=now();
      catalog.categories[league]=result.kind==='collected' ? {kind:'collected',at} : {kind:'failed',at,reason:result.reason};
      catalog.events.push(...result.events);
      catalog.rejectedGames.push(...result.rejectedGames);
    } catch(error) {
      catalog.categories[league]={kind:'failed',at:now(),reason:failure(error)};
      if(failure(error)==='rate-limited')return rateLimited();
    }
    await publish();
  }
  const urgency=event=>event.kickoff!==null&&event.kickoff>=now()-6*3600_000&&event.kickoff<=now()?0:
    event.kickoff!==null&&event.kickoff>now()&&event.kickoff<=now()+60*60_000?1:2;
  pending=catalog.events.filter(event=>event.detail.kind==='pending').sort((left,right)=>urgency(left)-urgency(right)||
    (left.kickoff??Infinity)-(right.kickoff??Infinity));
  const stillPending=event=>catalog.events.includes(event)&&event.detail.kind==='pending';
  let admitted=0;
  eventLoop: while(pending.length) {
    const background=admitted%4===3?pending.findIndex(event=>urgency(event)===2):-1;
    const [event]=pending.splice(background<0?0:background,1);
    admitted++;
    if (signal.aborted) throw new Error('unavailable');
    if(!stillPending(event))continue;
    const detailRead=await read(event.url,'detail',event.league,signal).then(html=>({html}),error=>({error}));
    await publish();
    if(!stillPending(event))continue;
    if('error' in detailRead) {
      event.detail={kind:'failed',at:now(),reason:failure(detailRead.error)};
      if(failure(detailRead.error)==='rate-limited')return rateLimited();
      await publish();
      continue;
    }
    const html=detailRead.html;
    const freePages=new Map();
    let eventUnresolvedRead=false;
    let serverUrls;
    try {
      const active=activeFreeServerUrl(html,event);
      if(active)freePages.set(active,serverPlayer(html,event,active));
      serverUrls=freeServerUrls(html,event);
    } catch(error) {
      event.detail={kind:'failed',at:now(),reason:failure(error)};
      await publish();
      continue;
    }
    for(const url of serverUrls) {
      if(signal.aborted)throw new Error('unavailable');
      if(freePages.has(url))continue;
      if(!stillPending(event))continue eventLoop;
      const serverRead=await read(url,'server',event.league,signal).then(page=>({page}),error=>({error}));
      await publish();
      if(!stillPending(event))continue eventLoop;
      if('error' in serverRead) {
        if(failure(serverRead.error)==='rate-limited') {
          event.detail={kind:'failed',at:now(),reason:'rate-limited'};
          return rateLimited();
        }
        freePages.set(url,{kind:'unknown'});eventUnresolvedRead=true;
      } else freePages.set(url,serverPlayer(serverRead.page,event,url));
    }
    try {event.detail=parseDetail(html,event,now(),freePages);}
    catch(error){event.detail={kind:'failed',at:now(),reason:failure(error)};}
    unresolvedRead ||= eventUnresolvedRead;
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
