import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { load } from 'cheerio';

const require = createRequire(import.meta.url);
const { isOfflinePlayerState, isNetworkErrorPlayerState, offlinePlayerFrame,
  activatePublishedVipboxVideo } = require('../desktop/sportsurge-observer.cjs');

const offlineHtml = `<html><head><title>Stream is Offline</title></head><body>
<div class="banner-container"><span class="status-text">Offline</span>
<h1>We'll Be Right Back</h1><p class="description">The stream is currently offline. Please wait or reload the page to check if the broadcast has started.</p>
<button onclick="window.parent.location.reload();">Reload</button></div></body></html>`;

test('the published offline player banner ends observation only after its document is ready', () => {
  const $ = load(offlineHtml);
  const state = {
    title: $('title').text(), readyState: 'complete', hasVideo: $('video').length > 0,
    status: $('.banner-container .status-text').text().trim(),
    description: $('.banner-container .description').text().trim(),
  };
  assert.equal(isOfflinePlayerState(state), true);
  assert.equal(isOfflinePlayerState({ ...state, readyState: 'interactive' }), true);
  assert.equal(isOfflinePlayerState({ ...state, readyState: 'loading' }), false);
  assert.equal(isOfflinePlayerState({ ...state, hasVideo: true }), false);
  assert.equal(isOfflinePlayerState({ ...state, title: 'Technical Issue' }), false);
  assert.equal(isOfflinePlayerState({ ...state, status: '' }), false);
  assert.equal(isOfflinePlayerState({ ...state, description: 'The player is loading.' }), false);
});

test('offline detection applies only to one named player under its known event-page source', () => {
  const player = { url: 'https://fallafar.me/sd0embed/NFL?pid=5&v=ncaaf59' };
  const ad = { url: 'https://ads.example/advert' };
  assert.equal(offlinePlayerFrame('https://strikeout.im/college-football/2/northern-colorado-vs-montana-stream', [player, ad]), player);
  assert.equal(offlinePlayerFrame('https://tvapp1.pk/watch/2498915', [player]), null);
  assert.equal(offlinePlayerFrame('https://strikeout.im/college-football/2/northern-colorado-vs-montana-stream', [player, { ...player }]), null);
  assert.equal(offlinePlayerFrame('https://strikeout.im/college-football/2/northern-colorado-vs-montana-stream', [ad]), null);
  assert.equal(offlinePlayerFrame('https://strikeout.im/college-football/2/northern-colorado-vs-montana-stream', [{ url: 'http://fallafar.me/sd0embed/NFL' }]), null);
  assert.equal(offlinePlayerFrame('https://strikeout.im/college-football/2/northern-colorado-vs-montana-stream', [{ url: 'https://ads.example/sd0embed/NFL' }]), null);
  assert.equal(offlinePlayerFrame('https://vipbox.fm/ads/other-page', [player]), null);
});

test('one named SD0 player is eligible on published CFB servers', () => {
  const player = { url: 'https://lonpapil.eu/sd0embed/NFL?pid=5&v=ncaaf59' };
  for (const source of [
    'https://vipbox.fm/live/nfl/dallas-cowboys-vs-tampa-bay-buccaneers-1',
    'https://vipbox.fm/live/ncaaf/jacksonville-state-vs-kennesaw-state-1',
    'https://strikeout.im/nfl/1/dallas-cowboys-vs-tampa-bay-buccaneers-stream',
    'https://strikeout.im/college-football/1/jacksonville-state-vs-kennesaw-state-stream',
    'https://www.vipboxtv.sk/cfb/1/stream-jacksonville-state-vs-kennesaw-state-live',
  ]) assert.equal(offlinePlayerFrame(source, [player]), player);
  assert.equal(offlinePlayerFrame('https://www.vipboxtv.sk/ads/other-page', [player]), null);
  assert.equal(offlinePlayerFrame('https://vipbox.fm/live/ncaaf/jacksonville-state-vs-kennesaw-state-1?ad=1', [player]), null);
  assert.equal(offlinePlayerFrame('https://vipbox.fm:8443/live/ncaaf/jacksonville-state-vs-kennesaw-state-1', [player]), null);
  assert.equal(offlinePlayerFrame('https://vipbox.fm/live/ncaaf/jacksonville-state-vs-kennesaw-state', [player]), null);
  assert.equal(offlinePlayerFrame('https://strikeout.im/college-football/1/jacksonville-state-vs-kennesaw-state', [player]), null);
});

test('Buffstream SD0 player belongs to the selected embedded server subtree', () => {
  const event = 'https://ms.buffstream.io/cfb-streams/jacksonville-state-live-stream';
  const server = 'https://embedsports.me/american-football/jacksonville-state-vs-kennesaw-state-stream-1';
  const root = { url: event, parent: null, isDestroyed: () => false };
  const selected = { url: server, parent: root, isDestroyed: () => false };
  const player = { url: 'https://lonpapil.eu/sd0embed/NFL?pid=5&v=ncaaf59', parent: selected, isDestroyed: () => false };
  const unrelated = { ...player, parent: { url: 'https://embedsports.me/american-football/other-stream-1', parent: root, isDestroyed: () => false } };
  assert.equal(offlinePlayerFrame(server, [player], event), player);
  assert.equal(offlinePlayerFrame(server, [unrelated], event), null);
  assert.equal(offlinePlayerFrame(server, [player, { ...player }], event), null);
  assert.equal(offlinePlayerFrame(server, [player], 'https://other.example/cfb-streams/jacksonville-state-live-stream'), null);
  assert.equal(offlinePlayerFrame('https://embedsports.me/ads/other-page', [player], event), null);
  assert.equal(offlinePlayerFrame(server, [player]), null);
});

test('Dudestream CFB SD0 player belongs only to its selected embedded server subtree', () => {
  const event='https://dudestream1.com/cfb96/';
  const server='https://embedsports.me/american-football/jacksonville-state-vs-kennesaw-state-stream-1';
  const root={url:event,parent:null,isDestroyed:()=>false};
  const selected={url:server,parent:root,isDestroyed:()=>false};
  const player={url:'https://posamari.me/sd0embed/NFL?pid=5',parent:selected,isDestroyed:()=>false};
  assert.equal(offlinePlayerFrame(server,[player],event),player);
  assert.equal(offlinePlayerFrame(server,[player,{...player}],event),null);
  assert.equal(offlinePlayerFrame(server,[{...player,parent:{...selected,url:'https://embedsports.me/american-football/other-vs-team-stream-1'}}],event),null);
  assert.equal(offlinePlayerFrame(server,[player],'https://dudestream1.com/cfb97/'),null);
  assert.equal(offlinePlayerFrame(server,[player],'https://dudestream1.com/nfl2/'),null);
  assert.equal(offlinePlayerFrame(server,[player]),null);
});

test('the published SD0 Play control starts one visible paused video without clicking other controls', () => {
  let clicks=0,plays=0;
  const video={paused:true,muted:false,getBoundingClientRect:()=>({width:913,height:514}),play(){plays++;return Promise.resolve();}};
  const button={click(){clicks++;}};
  const page={querySelectorAll(selector:string){
    if(selector==='video')return [video];
    if(selector.includes('jw-icon-playback'))return [button];
    return [];
  }};
  const style=()=>({display:'block',visibility:'visible'});
  assert.equal(activatePublishedVipboxVideo(page,style),true);
  assert.equal(video.muted,true);
  assert.equal(clicks,1);
  assert.equal(plays,1);
  assert.equal(activatePublishedVipboxVideo({...page,querySelectorAll(selector:string){
    if(selector==='video')return [video];
    if(selector.includes('jw-icon-playback'))return [button,button];
    return [];
  }},style),false);
  assert.equal(activatePublishedVipboxVideo(page,()=>({display:'none',visibility:'visible'})),false);
  assert.equal(clicks,1);
  assert.equal(plays,1);
});

test('the named SD0 network-error page ends observation only for its visible completed error state', () => {
  const html=`<html><head><title>Technical Issue</title></head><body>
    <div class="error-state"><h2>Network Error</h2>
    <p>We are having trouble connecting to the server. Please reload the page. Try switching your DNS.</p></div>
  </body></html>`;
  const $=load(html);
  const state={title:$('title').text(),readyState:'complete',hasVideo:$('video').length>0,
    errorVisible:$('.error-state').length===1,errorHeading:$('.error-state > h2').text().trim(),
    errorDescription:$('.error-state > p').text().trim()};
  assert.equal(isNetworkErrorPlayerState(state),true);
  for(const changed of [
    {readyState:'loading'},{readyState:'interactive'},{hasVideo:true},{errorVisible:false},
    {title:'Watch Live'},{errorHeading:'Stream starting soon'},{errorDescription:'The player is loading.'},
  ])assert.equal(isNetworkErrorPlayerState({...state,...changed}),false);
});
