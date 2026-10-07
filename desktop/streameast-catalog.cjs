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

function freePlayer(html) {
  const $=load(html);
  const matches=$('iframe[src]').toArray().flatMap(node=>{
    try {
      const url=new URL($(node).attr('src'),ORIGIN);
      if(url.username || url.password || url.port || url.search || url.hash)return [];
      const channel=CHANNEL_PATH.exec(url.pathname);
      if(url.origin==='https://streame.center' && channel)return [{kind:'channel',id:channel[1]}];
      const wikisport=/^\/(0nhl|strm)\/(\d{1,4})\.php$/.exec(url.pathname);
      return url.origin==='https://wikisport.info' && wikisport ? [{kind:'wikisport',section:wikisport[1],id:wikisport[2]}]:[];
    } catch{return [];}
  });
  return matches.length===1?matches[0]:{kind:'unsupported'};
}

function publishedFreePlayer(html,event,selectedUrl) {
  const $=load(html);
  const selected=serverUrl(selectedUrl,event);
  const sourceId=event.id.split(':')[1];
  const board=$('.se-board[data-match-id]');
  const active=$('.stream-alt-list a.stream-alt-item.active');
  const root=$('#se-player-root.se-player');
  const frame=root.children('iframe[src]');
  if(!selected||!$('.streameast-video-page').length||
    board.length!==1||board.attr('data-match-id')!==sourceId||root.length!==1||
    active.length!==1||active.hasClass('stream-alt-item-pro')||active.find('.stream-alt-pro-icon').length||
    active.find('.stream-alt-free-badge').length!==1||
    serverUrl(active.attr('href')||'',event)?.url!==selectedUrl||frame.length!==1)
    return {kind:'unsupported'};
  let url;
  try {url=new URL(frame.attr('src'));}
  catch{return {kind:'unsupported'};}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||
    url.href.length>400)return {kind:'unsupported'};
  if(url.origin==='https://streame.center') {
    const channel=CHANNEL_PATH.exec(url.pathname);
    if(channel)return {kind:'channel',id:channel[1],url:url.href};
  }
  if(url.origin==='https://wikisport.info') {
    const player=/^\/(0nhl|strm)\/(\d{1,4})\.php$/.exec(url.pathname);
    if(player)return {kind:'wikisport',section:player[1],id:player[2],url:url.href};
  }
  const supported=url.origin==='https://dlive.sx'&&/^\/stream\/stream-\d{1,4}\.php$/.test(url.pathname)||
    url.origin==='https://flyembed.click'&&/^\/embed\/\d{1,4}\.php$/.test(url.pathname)||
    url.origin==='https://fsportshdz.xyz'&&/^\/embed\/[a-z0-9]+(?:-[a-z0-9]+)*-live-streams\.php$/.test(url.pathname);
  return supported?{kind:'page',url:url.href}:{kind:'unsupported'};
}

function serverPlayer(html,event,selectedUrl) {
  return load(html)('.streameast-video-page').length ?
    publishedFreePlayer(html,event,selectedUrl) : freePlayer(html);
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

function freeRows($) {
  return $('.stream-alt-list a.stream-alt-item').toArray().filter(row=>{
    const node=$(row);
    return !node.hasClass('stream-alt-item-pro') && !node.find('.stream-alt-pro-icon').length &&
      node.find('.stream-alt-free-badge').length>0;
  });
}

function parseDetail(html,event,at,freePages) {
  const $=load(html);
  const rows=$('.stream-alt-list a.stream-alt-item');
  if (!rows.length) {
    const sourceId=event.id.split(':')[1];
    if ($('.streameast-video-page').length && $('.se-board[data-match-id]').first().attr('data-match-id')===sourceId &&
      $('.se-streams--share-only .se-streams__list').length && !$('.se-streams__list a.se-stream__link').length &&
      $('.se-countdown__title').first().text().trim()==='Stream starting soon')
      return {kind:'collected',at,servers:[]};
    const list=$('#se-streams-list.se-streams__list');
    const published=list.find('.se-stream:not(.se-stream--share)').toArray();
    const heading=$('.se-progate__match').first().text().replace(/\s+/g,' ').trim();
    if ($('.streameast-video-page').length && heading===event.title && published.length &&
      published.every(row=>$(row).hasClass('is-pro') && serverUrl($(row).find('a.se-stream__link').attr('href')||'',event)))
      return {kind:'collected',at,servers:[]};
    return {kind:'failed',at,reason:'parser-changed'};
  }
  const servers=[];
  for (const row of freeRows($)) {
    const node=$(row);
    const link=serverUrl(node.attr('href') || '',event);
    if (!link) return {kind:'failed',at,reason:'parser-changed'};
    const label=(node.find('.stream-alt-name').text() || `Server ${link.id}`).trim().slice(0,120);
    const result=freePages.get(link.url);
    const availability=result?.kind==='channel' ? {kind:'free-channel',channelId:result.id} :
      result?.kind==='wikisport' ? {kind:'free-wikisport',section:result.section,playerId:result.id} :
      result?.kind==='page' ? {kind:'free-page'} :
      result?.kind==='unsupported' ? {kind:'free-unsupported'} : {kind:'free-unresolved'};
    servers.push({id:link.id,label,url:link.url,availability});
  }
  return {kind:'collected',at,servers};
}

function freeServerUrls(html,event) {
  const $=load(html);
  return freeRows($).flatMap(row=>{
    const node=$(row);
    const link=serverUrl(node.attr('href') || '',event);
    return link ? [link.url] : [];
  });
}

function activeFreeServerUrl(html,event) {
  const $=load(html);
  const active=freeRows($).find(row=>$(row).hasClass('active'));
  const link=active && serverUrl($(active).attr('href') || '',event);
  return link ? link.url : null;
}

module.exports={ORIGIN,CATEGORY_URLS,MAX_PAGE_BYTES,MAX_CHECKPOINT_BYTES,eventUrl,serverUrl,freePlayer,publishedFreePlayer,serverPlayer,parseCategory,parseDetail,freeServerUrls,activeFreeServerUrl};
