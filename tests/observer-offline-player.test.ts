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
