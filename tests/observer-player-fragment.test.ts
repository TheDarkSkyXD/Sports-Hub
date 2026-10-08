import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { publicNetworkUrl, createNavigationPolicy, aianimalvibesPlayer } = require('../desktop/sportsurge-observer.cjs');

test('only the published Aianimalvibes football player can trigger observation playback', () => {
  assert.equal(aianimalvibesPlayer('https://ch.aianimalvibes.com/football/728'), true);
  assert.equal(aianimalvibesPlayer('https://ch.aianimalvibes.com/cfb/66184'), true);
  for (const url of [
    'https://ch.aianimalvibes.com/cfb/66184?ad=1',
    'https://ch.aianimalvibes.com/cfb/66184/other',
    'https://ch.aianimalvibes.com.evil.example/cfb/66184',
    'https://ch.aianimalvibes.com/football/728?ad=1',
    'https://ch.aianimalvibes.com/football/728#player',
    'https://ch.aianimalvibes.com:8443/football/728',
    'https://ch.aianimalvibes.com/football/728/other',
    'https://ch.aianimalvibes.com.evil.example/football/728',
    'https://user@ch.aianimalvibes.com/football/728',
    'http://ch.aianimalvibes.com/football/728',
  ]) assert.equal(aianimalvibesPlayer(url), false, url);
});

test('a player frame fragment does not change its public network destination', () => {
  assert.equal(publicNetworkUrl('https://embed.st/embed-noads/delta/live_cfb_ball-state-toledo-live-streaming-663656976/1#player=clappr')?.href,
    'https://embed.st/embed-noads/delta/live_cfb_ball-state-toledo-live-streaming-663656976/1');
  assert.equal(publicNetworkUrl('wss://media.example/socket')?.href, 'https://media.example/socket');
  assert.equal(publicNetworkUrl('https://media.example/player%23one?channel=%23two#play')?.href,
    'https://media.example/player%23one?channel=%23two');
  for (const target of ['https://127.0.0.1/player#play', 'https://media.local/player#play',
    'https://[::1]/player#play', 'https://media.example:3000/player#play',
    'https://user@media.example/player#play', 'http://media.example/player#play', 'javascript:alert(1)#play',
    `https://media.example/player#${'a'.repeat(2048)}`]) {
    assert.equal(publicNetworkUrl(target), null, target);
  }
  const allow = createNavigationPolicy('https://fxtrend.st/event/example/vector/1');
  assert.equal(allow('https://fxtrend.st/event/example/vector/1'), true);
  assert.equal(allow('https://fxtrend.st/event/example/vector/1#player=clappr'), false);
});
