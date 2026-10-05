import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {allowedDiscoveryUrl,compatiblePlayers,enrichObservation,parseListings} from '../lib/football/adapters/sources.ts';
import {parseSwacEvent,swacApiUrl,swacProgramUrl} from '../lib/playback/providers/swac-catalog.ts';

const event=JSON.parse(readFileSync(new URL('./fixtures/swac/live-event.json',import.meta.url),'utf8'));
const source={id:'swac',family:'swac',kind:'catalog' as const,url:'https://ott.gideo.video/api/legacy?cmd=getCategoryChildren&AccountID=Southwestern-Athletic-Conference&CategoryID=e1dbe7ec9a7e686b42b53ab33c3e30e4'};
const now=Date.parse('2026-10-04T01:00:00Z');

test('SWAC discovers the exact free football event using kickoff instead of preroll',()=>{
  const result=parseListings(source,JSON.stringify([event]),now);
  assert.equal(result.outcome,'parsed');
  const observation=result.observations[0];
  assert.deepEqual(observation.teams,['Arkansas Pine-Bluff','Southern']);
  assert.equal(observation.kickoff,Date.parse('2026-10-03T23:00:00Z'));
  const players=compatiblePlayers('ncaaf-401868936',observation,JSON.stringify(event));
  assert.equal(players.length,1);
  assert.deepEqual(players[0].locator,{provider:'swac',eventId:event.id});
});

test('SWAC excludes archives, paid content, other sports and inconsistent metadata',()=>{
  for(const invalid of [{...event,live:false},{...event,freeBehavior:'subscribe'},
    {...event,title:event.title.replace('Football','Volleyball')},
    {...event,title:event.title.replace('10/3/26','10/4/26')},
    {...event,description:event.description.replace('6:00 PM','25:00 PM')},
    {...event,goLiveTime:'2026-10-04T00:00:00Z'}]){
    assert.equal(parseListings(source,JSON.stringify([invalid]),now).observations.length,0);
  }
});

test('SWAC uses Central daylight and winter time and rejects conflicting event identities',()=>{
  assert.equal(parseSwacEvent({...event,freeBehavior:'allow_ads'})?.kickoff,Date.parse('2026-10-03T23:00:00Z'));
  const winter={...event,title:'Football (11/21/26) Arkansas Pine-Bluff vs Southern',description:'November 21, 2026 | 6:00 PM CT',goLiveTime:'2026-11-21T23:50:00Z'};
  assert.equal(parseSwacEvent(winter)?.kickoff,Date.parse('2026-11-22T00:00:00Z'));
  assert.equal(parseSwacEvent({...winter,description:'November 31, 2026 | 6:00 PM CT',title:winter.title.replace('11/21','11/31')}),null);
  const result=parseListings(source,JSON.stringify([event,event]),now);
  assert.equal(result.observations.length,1);
  assert.equal(parseListings(source,JSON.stringify([event,{...event,title:event.title.replace('Southern','Grambling')}]),now).outcome,'parser-changed');
  const observation=result.observations[0];
  assert.deepEqual(enrichObservation(observation,JSON.stringify(event)),observation);
  for(const changed of [{...event,id:'f'.repeat(32)},{...event,title:event.title.replace('Southern','Grambling')},
    {...event,description:event.description.replace('6:00 PM','7:00 PM')}])assert.deepEqual(compatiblePlayers('ncaaf-401868936',observation,JSON.stringify(changed)),[]);
});

test('SWAC discovery admits only the fixed public tenant and exact event routes',()=>{
  assert.equal(swacApiUrl('getVideoUrls',event.id),`https://ott.gideo.video/api/legacy?cmd=getVideoUrls&accountId=Southwestern-Athletic-Conference&videoId=${event.id}`);
  assert.equal(allowedDiscoveryUrl(source.url),true);
  assert.equal(allowedDiscoveryUrl(swacApiUrl('getVideo',event.id)),true);
  assert.equal(allowedDiscoveryUrl(swacProgramUrl(event.id)),true);
  for(const url of [source.url.replace('Southwestern-Athletic-Conference','Other'),source.url+'&extra=1',
    source.url.replace('ott.gideo.video','ott.gideo.video.attacker.test'),swacProgramUrl(event.id)+'#play',swacProgramUrl(event.id)+'?id=other',
    swacProgramUrl(event.id).replace('https:','http:'),swacApiUrl('getVideoUrls',event.id)])assert.equal(allowedDiscoveryUrl(url),false,url);
});
