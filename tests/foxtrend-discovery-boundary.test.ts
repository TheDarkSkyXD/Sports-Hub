import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allowedDiscoveryUrl} from '../lib/football/adapters/sources.ts';

const race='https://foxiy.st/event/charlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200';
test('Foxtrend discovery admits its published NASCAR page without admitting unrelated Foxiy pages',()=>{
  assert.equal(allowedDiscoveryUrl('https://foxtrend.app/Motor-Sports'),true);
  assert.equal(allowedDiscoveryUrl(race),true);
  for(const url of [race.replace('nascar-cup-series','formula-1'),race.replace('1791745200','1791745200000'),
    race.replace('foxiy.st','foxiy.st.evil.test'),race.replace('https:','http:'),`${race}/hotel/1`,
    `${race}?next=1`,`${race}#player`,'https://foxiy.st/','https://foxtrend.app/login']) {
    assert.equal(allowedDiscoveryUrl(url),false,url);
  }
});
