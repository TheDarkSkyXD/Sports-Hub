import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url);
const {createNavigationPolicy}=require('../desktop/sportsurge-observer.cjs');
const path='/cfb/montana-state-bobcats-vs-idaho-vandals-1790994600/';
const original=`https://streameast.ga${path}`;
const canonical=`https://v2.streameast.ga${path}`;
const handoff=`https://auth.streamea.st/SsoHandoff.php?${new URLSearchParams({h:'v2.streameast.ga',p:path})}`;
const connect=`https://v2.streameast.ga/connect.php?${new URLSearchParams({redirect:path})}`;
test('the same StreamEast game can complete one public site handoff',()=>{
  const allow=createNavigationPolicy(original);
  for(const url of [original,canonical,handoff,handoff,connect,canonical,canonical])assert.equal(allow(url),true,url);
  assert.equal(allow(handoff),false,'the handoff cannot cycle');
  assert.equal(allow(original),false,'the old origin cannot cycle');
});
test('StreamEast handoff rejects another game, origin, private address, or extra parameter',()=>{
  for(const target of [
    'https://v2.streameast.ga/cfb/other-game/',
    'https://127.0.0.1/',
    'https://example.com/',
    handoff.replace('v2.streameast.ga','example.com'),
    `${handoff}&extra=1`,
    `${canonical}?premium=1`,
    connect,
    canonical.replace('https:','http:'),
  ])assert.equal(createNavigationPolicy(original)(target),false,target);
  const allow=createNavigationPolicy('https://example.com/game');
  assert.equal(allow('https://example.com/game'),true);
  assert.equal(allow(canonical),false);
});

test('published Sportsurge redirects allow one canonical hop and repeated hooks',()=>{
  const pairs=[
    ['https://dudestream1.com/mawhgte57fdt5rnb67','https://dudestream1.com/nfl2/'],
    ['https://mygoodstream.pw/short/Zg8aR0CjNe','https://v2.mygoodstream.pw/watch/1457eddfd3e21817893326ba'],
    ['https://shd247.world/live-go-streaming-27.html','https://streamhd247.click/live-go-streaming-27.html'],
  ];
  for(const [source,target] of pairs){
    const allow=createNavigationPolicy(source);
    assert.equal(allow(source),true,source);
    assert.equal(allow(target),true,target);
    assert.equal(allow(target),true,`repeated hook ${target}`);
    assert.equal(allow(source),false,`cannot return to ${source}`);
    assert.equal(allow(`${target}?other=1`),false,`query ${target}`);
    assert.equal(allow('https://127.0.0.1/'),false,'private target');
    assert.equal(allow('https://example.com/'),false,'ad navigation');
  }
});

test('published Sportsurge redirects reject changed routes and unsafe targets',()=>{
  const cases=[
    ['https://dudestream1.com/mawhgte57fdt5rnb67','https://dudestream1.com/nfl3/'],
    ['https://mygoodstream.pw/short/Zg8aR0CjNe','https://v2.mygoodstream.pw/watch/not-a-24-hex-id'],
    ['https://shd247.world/live-go-streaming-27.html','https://streamhd247.click/live-go-streaming-28.html'],
    ['https://shd247.world/live-go-streaming-27.html','http://streamhd247.click/live-go-streaming-27.html'],
    ['https://shd247.world/live-go-streaming-27.html','https://user@streamhd247.click/live-go-streaming-27.html'],
  ];
  for(const [source,target] of cases)assert.equal(createNavigationPolicy(source)(target),false,target);
});

test('Mygoodstream watch redirect may drop watch only for the same id',()=>{
  const source='https://mygoodstream.pw/short/Zg8aR0CjNe';
  const watch='https://v2.mygoodstream.pw/watch/1457eddfd3e21817893326ba';
  const final='https://v2.mygoodstream.pw/1457eddfd3e21817893326ba';
  const allow=createNavigationPolicy(source);
  assert.equal(allow(watch),true);
  assert.equal(allow(final),true);
  assert.equal(allow(final),true,'second Electron hook is idempotent');
  assert.equal(allow(watch),false,'cannot return to watch route');
  assert.equal(allow('https://v2.mygoodstream.pw/1457eddfd3e21817893326bb'),false,'different stream id');
  assert.equal(allow(`${final}?ad=1`),false,'query after terminal redirect');
});
