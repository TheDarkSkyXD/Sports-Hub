import assert from 'node:assert/strict';
import {test} from 'node:test';
import {missingPlayerReason,parseListings,resolvePlayers,SOURCES} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const source=SOURCES.find(item=>item.id==='sportsfeed24')!;
const at=Date.parse('2026-10-12T14:00:00Z');
const trendy='https://trend48.st/event/ppv-florida-panthers-vs-buffalo-sabres';
const game={teamA:'Sabres',teamB:'Panthers',matchDate:'Mon, 12 Oct 2026 17:02:20 GMT',
  sourceLink:'https://links.totalsportek1.is/sabres-vs-panthers/73180/',trendy,
  player2:'https://goomdstea.click/stream.php?ch=11',websiteLink:'https://domainx.rest/file/?7',
  streamerLinks:[{websiteLink:'https://sportsfeed24.pk/fixture/Sabres-vs-Panthers'},
    {websiteLink:'https://sportsfeed24.cx/fixture/Sabres-vs-Panthers'},
    {websiteLink:trendy,streamer:'Trendy'},
    {websiteLink:'https://alphastreams.mom/2026/10/12/sabres-vs-panthers/',streamer:'NFL PASS'},
    {websiteLink:'https://bizzstreamz.online/2026/10/12/panthers-vs-sabres/',streamer:'NHL Gamecenter'}]};
const listing=JSON.stringify([{categoryName:'NHL',subCategories:[{subCategoryName:'NHL',games:[game]}]}]);
const observation=parseListings(source,listing,at).observations[0];
const resolve=(detail:unknown)=>resolvePlayers('401892486',observation,JSON.stringify({game:detail}),new AbortController().signal);

test('SportsFeed24 collects its primary published page first and every distinct external feed',async()=>{
  assert.ok(observation);
  const players=await resolve(game);
  assert.deepEqual(players.map(player=>player.locator.provider==='event-page'?player.locator.serverUrl:null),[
    trendy,game.player2,game.websiteLink,
    'https://alphastreams.mom/2026/10/12/sabres-vs-panthers/',
    'https://bizzstreamz.online/2026/10/12/panthers-vs-sabres/']);
  assert.ok(players.every(player=>player.locator.provider==='event-page'&&
    validEventPagePair(player.locator.eventUrl,player.locator.serverUrl)));
});

test('SportsFeed24 keeps feeds attached to the exact source event',async()=>{
  for(const detail of [{...game,teamA:'Bruins'},
    {...game,sourceLink:'https://links.totalsportek1.is/sabres-vs-panthers/73181/'},
    {...game,matchDate:'Tue, 13 Oct 2026 17:02:20 GMT'}])assert.deepEqual(await resolve(detail),[]);
  assert.deepEqual(await resolve({...game,trendy:'',player2:'',websiteLink:'',streamerLinks:[]}),[]);
  assert.deepEqual(await resolve({...game,trendy:null,player2:null,websiteLink:null,streamerLinks:null}),[]);
});

test('SportsFeed24 rejects unrelated matchup pages and unsafe published destinations in native and playback policies',async()=>{
  const rejected=['http://trend48.st/event/ppv-florida-panthers-vs-buffalo-sabres',
    'https://user:password@trend48.st/player','https://trend48.st:8443/player','https://trend48.st/player#anchor',
    'https://127.0.0.1/player','https://[::1]/player','https://2130706433/player','https://localhost/player',
    'https://player.local/player','https://player.internal/player','https://player.example./player',
    'https://sportsfeed24.st/fixture/Sabres-vs-Panthers','https://sportsfeed24.pk/fixture/Sabres-vs-Panthers',
    'https://sportsfeed24.cx/fixture/Sabres-vs-Panthers',
    'https://liveonstreamz.xyz/2026/10/08/asu-poli-timisoara-vs-steaua-bucuresti/'];
  for(const websiteLink of rejected){
    assert.equal(validEventPagePair(observation.url,websiteLink),false,websiteLink);
    assert.deepEqual(await resolve({...game,trendy:'',player2:'',websiteLink,streamerLinks:[]}),[],websiteLink);
  }
});

test('SportsFeed24 canonical fixture names accept spaces and Unicode without allowing encoded path escapes',()=>{
  for(const event of ['https://sportsfeed24.st/fixture/Florida%20Panthers-vs-Buffalo%20Sabres',
    'https://sportsfeed24.st/fixture/Montr%C3%A9al%20Canadiens-vs-Buffalo%20Sabres'])
    assert.equal(validEventPagePair(event,trendy),event.includes('Florida'),event);
  assert.equal(validEventPagePair('https://sportsfeed24.st/fixture/Montr%C3%A9al%20Canadiens-vs-Buffalo%20Sabres',
    'https://domainx.rest/file/?7'),true);
  for(const name of ['Florida%2520Panthers','Florida%2FPanthers','Florida%5CPanthers','Florida%00Panthers',
    'Florida%20%2E%2EPanthers','Florida%20%'])
    assert.equal(validEventPagePair(`https://sportsfeed24.st/fixture/${name}-vs-Buffalo%20Sabres`,trendy),false,name);
});

test('SportsFeed24 trendy alone counts as a published feed',()=>{
  assert.equal(missingPlayerReason(observation,JSON.stringify({game:{...game,player2:'',websiteLink:'',streamerLinks:[]}})),
    'unsupported-player');
});

test('SportsFeed24 native and playback policies accept canonical names and preserve query player addresses',async()=>{
  for(const teamA of ['Florida Panthers','Montréal Canadiens']){
    const named={...game,teamA,teamB:'Buffalo Sabres',trendy:'https://domainx.rest/file/?7',
      player2:'',websiteLink:'',streamerLinks:[]};
    const namedListing=JSON.stringify([{categoryName:'NHL',subCategories:[{subCategoryName:'NHL',games:[named]}]}]);
    const row=parseListings(source,namedListing,at).observations[0];
    const players=await resolvePlayers('401892486',row,JSON.stringify({game:named}),new AbortController().signal);
    assert.equal(players.length,1,teamA);
    assert.equal(players[0].locator.provider,'event-page');
    if(players[0].locator.provider==='event-page')
      assert.equal(validEventPagePair(players[0].locator.eventUrl,players[0].locator.serverUrl),true,teamA);
  }
});
