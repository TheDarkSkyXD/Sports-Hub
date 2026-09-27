const { load } = require('./cheerio.cjs');

const ORIGIN = 'https://v2.streameast.ga';
const CATEGORY_URLS = { ncaaf:`${ORIGIN}/cfb-streams/`, nfl:`${ORIGIN}/nfl-streams/` };
const MAX_PAGE_BYTES = 4_000_000;
const MAX_CHECKPOINT_BYTES = 8_000_000;
const EVENT_PATH = /^\/(cfb|nfl)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/;
const CHANNEL_PATH = /^\/stream-east\/ch(\d{1,4})\.php$/;

function eventUrl(value, league) {
  try {
    const url=new URL(value,ORIGIN);
    const match=EVENT_PATH.exec(url.pathname);
    if (url.origin!==ORIGIN || url.username || url.password || url.search || url.hash || url.href.length>400 ||
      !match || match[1] !== (league==='ncaaf'?'cfb':'nfl')) return null;
    return url.href;
  } catch { return null; }
}

function serverUrl(value, event) {
  try {
    const url=new URL(value,ORIGIN);
    const prefix=new URL(event.url).pathname;
    const match=new RegExp(`^${prefix}(\\d{1,4})$`).exec(url.pathname);
    if (url.origin!==ORIGIN || url.username || url.password || url.search || url.hash || url.href.length>400 || !match) return null;
    return {url:url.href,id:match[1]};
  } catch { return null; }
}

function channelId(html) {
  const $=load(html);
  const matches=$('iframe[src]').toArray().flatMap(node=>{
    try {
      const url=new URL($(node).attr('src'),ORIGIN);
      const match=CHANNEL_PATH.exec(url.pathname);
      return url.origin==='https://streame.center' && !url.username && !url.password && !url.search && !url.hash && match ? [match[1]]:[];
    } catch{return [];}
  });
  return matches.length===1?matches[0]:null;
}

function parseCategory(html,league) {
  const $=load(html);
  const cards=$('.m-card');
  const empty=$('#m-schedule-empty.m-empty');
  if (!cards.length && !(empty.length && /no (?:college football|cfb|nfl) games available/i.test(empty.find('.m-empty__title').text())))
    return {kind:'failed',reason:'parser-changed',events:[],rejectedGames:[]};
  const events=[];
  const rejectedGames=[];
  const seen=new Set();
  const ids=new Set();
  for (const card of cards.toArray()) {
    const node=$(card);
    const link=node.find('a.m-card__link').first();
    const title=(link.attr('aria-label') || '').trim().slice(0,240);
    const url=eventUrl(link.attr('href') || '',league);
    if (!url) { rejectedGames.push({league,title,reason:'invalid-detail-url'}); continue; }
    if (seen.has(url)) { rejectedGames.push({league,title,reason:'duplicate-game-id'}); continue; }
    seen.add(url);
    const sourceId=node.attr('data-match-id') || '';
    if (!/^\d{1,12}$/.test(sourceId)) { rejectedGames.push({league,title,reason:'invalid-detail-url'}); continue; }
    if (ids.has(sourceId)) { rejectedGames.push({league,title,reason:'duplicate-game-id'}); continue; }
    ids.add(sourceId);
    const names=(node.attr('data-team-names') || '').split('|').map(value=>value.trim());
    const time=node.attr('data-time') || '';
    const kickoff=/^\d{10}$/.test(time) ? Number(time)*1000 : null;
    const espnPath=node.attr('data-espn-path');
    const rawEspn=node.attr('data-espn-event-id') || '';
    const espnEventId=espnPath===(league==='ncaaf'?'football/college-football':'football/nfl') && /^\d{5,12}$/.test(rawEspn) ? rawEspn : null;
    events.push({id:`${league}:${sourceId}`,url,league,title:title || names.join(' vs ').slice(0,240) || 'Unknown matchup',
      teams:names.length===2 && names.every(value=>value.length>0 && value.length<=120) ? names : null,
      kickoff,espnEventId,detail:{kind:'pending'}});
  }
  return {kind:'collected',events,rejectedGames};
}

function parseDetail(html,event,at,freePages) {
  const $=load(html);
  const rows=$('.stream-alt-list a.stream-alt-item');
  if (!rows.length) return {kind:'failed',at,reason:'parser-changed'};
  const servers=[];
  for (const row of rows.toArray()) {
    const node=$(row);
    const link=serverUrl(node.attr('href') || '',event);
    if (!link) return {kind:'failed',at,reason:'parser-changed'};
    const label=(node.find('.stream-alt-name').text() || `Server ${link.id}`).trim().slice(0,120);
    const pro=node.hasClass('stream-alt-item-pro') || node.find('.stream-alt-pro-icon').length>0;
    const free=node.find('.stream-alt-free-badge').length>0;
    let availability={kind:'unknown'};
    if (pro) availability={kind:'premium'};
    else if (free) {
      const result=freePages.get(link.url);
      availability=result?.kind==='channel' ? {kind:'free-channel',channelId:result.id} :
        result?.kind==='unsupported' ? {kind:'free-unsupported'} : {kind:'free-unresolved'};
    }
    servers.push({id:link.id,label,url:link.url,availability});
  }
  return {kind:'collected',at,servers};
}

function freeServerUrls(html,event) {
  const $=load(html);
  return $('.stream-alt-list a.stream-alt-item').toArray().flatMap(row=>{
    const node=$(row);
    const link=serverUrl(node.attr('href') || '',event);
    return link && !node.hasClass('stream-alt-item-pro') && !node.find('.stream-alt-pro-icon').length &&
      node.find('.stream-alt-free-badge').length ? [link.url] : [];
  });
}

function activeFreeServerUrl(html,event) {
  const $=load(html);
  const node=$('.stream-alt-list a.stream-alt-item.active').first();
  const link=serverUrl(node.attr('href') || '',event);
  return link && !node.hasClass('stream-alt-item-pro') && !node.find('.stream-alt-pro-icon').length &&
    !!node.find('.stream-alt-free-badge').length ? link.url : null;
}

module.exports={ORIGIN,CATEGORY_URLS,MAX_PAGE_BYTES,MAX_CHECKPOINT_BYTES,eventUrl,serverUrl,channelId,parseCategory,parseDetail,freeServerUrls,activeFreeServerUrl};
