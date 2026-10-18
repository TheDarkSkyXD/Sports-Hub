import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {z} from 'zod';
import {parseListings,resolvePlayers,SOURCES} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const detail=z.object({game:z.object({teamA:z.string(),teamB:z.string(),matchDate:z.string(),sourceLink:z.string(),
  trendy:z.string(),player2:z.string(),websiteLink:z.string(),streamerLinks:z.array(z.object({websiteLink:z.string()}))})})
  .parse(JSON.parse(readFileSync(new URL('./fixtures/sportsfeed22-published-routes.json',import.meta.url),'utf8')));
const source=SOURCES.find(source=>source.id==='sportsfeed24');
assert.ok(source);
const observation=parseListings(source,JSON.stringify([{categoryName:'NHL',subCategories:[{subCategoryName:'NHL',games:[detail.game]}]}]),
  Date.parse('2026-10-12T17:30:00Z')).observations[0];
assert.ok(observation);
const rejected=['https://attacker.example/payload','https://attacker.example/sabres-vs-panthers/',
  'https://goomdstea.click/admin?ch=11','https://goomdstea.click/stream.php?ch=11&redirect=1',
  'https://domainx.rest/admin/?7','https://domainx.rest/file/?7&redirect=1',
  'https://embed.st/admin/ppv-florida-panthers-vs-buffalo-sabres/1',
  'https://trend48.st/admin/ppv-florida-panthers-vs-buffalo-sabres',
  'https://alphastreams.mom/2026/10/12/rangers-vs-canucks/'];

test('SportsFeed preserves all22 captured published feeds in native resolution and playback policy',async()=>{
  const expected=[detail.game.trendy,detail.game.player2,detail.game.websiteLink,
    ...detail.game.streamerLinks.map((link:{websiteLink:string})=>link.websiteLink)]
    .filter(url=>!/^https:\/\/sportsfeed24\./.test(url));
  const unique=[...new Set<string>(expected)];
  assert.equal(unique.length,22);
  for(const url of unique)assert.equal(validEventPagePair(observation.url,url),true,url);
  const players=await resolvePlayers('401892486',observation,JSON.stringify(detail),new AbortController().signal);
  assert.deepEqual(players.map(player=>player.locator.provider==='event-page'?player.locator.serverUrl:null),unique);
});

test('SportsFeed playback policy rejects unknown hosts and malformed provider routes and queries',()=>{
  for(const url of rejected)assert.equal(validEventPagePair(observation.url,url),false,url);
});

test('SportsFeed native resolution rejects unknown hosts and malformed provider routes and queries',async()=>{
  for(const websiteLink of rejected) {
    const game={...detail.game,trendy:'',player2:'',websiteLink,streamerLinks:[]};
    assert.deepEqual(await resolvePlayers('401892486',observation,JSON.stringify({game}),new AbortController().signal),[],websiteLink);
  }
});
