import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {z} from 'zod';
import {createFixtureCollector,SourceFetchError,SOURCES} from '../lib/football/adapters/sources.ts';
import {PartialListingReadError} from '../lib/football/domain/ports.ts';

const at=Date.parse('2026-10-08T21:10:00Z');
const catalogUrl='https://bestfreestreaming.app/api/xhr';
const categoryNames=['','NFL','NBA','NHL','MLB','F1','motogp','UFC','Boxing'];
const today=readFileSync(new URL('./fixtures/broad-sources/sportsfeed24-today.json',import.meta.url),'utf8');

for(const path of ['/event/f1-singapore-grand-prix-20261011','/f1-singapore-grand-prix-20261011']){
  test(`MLBBite can read its dated catalog event at ${path}`,async()=>{
    const collector=createFixtureCollector();
    const source=SOURCES.find(item=>item.id==='mlbbite-motor-sports');
    assert.ok(source);
    const html=`<section id="s-f1"><a class="gc" data-ts="1791741600" href="${path}" title="F1 Singapore Grand Prix"></a></section>`;
    const listing=collector.parseListings(source,html,at);
    assert.equal(listing.outcome,'parsed');
    assert.equal(listing.observations.length,1);
    const row=listing.observations[0];
    assert.equal(row.url,`https://mlbbite.org${path}`);
    assert.equal(row.league,'f1');
    assert.equal(row.kickoff,1791741600000);
    collector.enqueueFixture({url:row.url,body:html});
    assert.equal(await collector.readHtml(row.url,new AbortController().signal),html);
    assert.deepEqual(collector.fixtureRequests().map(request=>request.url),[row.url]);
  });
}

test('MLBBite rejects addresses outside its canonical event and category paths',async()=>{
  const collector=createFixtureCollector();
  const rejected=[
    'http://mlbbite.org/event/f1-singapore-grand-prix-20261011',
    'https://other.example/event/f1-singapore-grand-prix-20261011',
    'https://user@mlbbite.org/event/f1-singapore-grand-prix-20261011',
    'https://mlbbite.org:8443/event/f1-singapore-grand-prix-20261011',
    'https://mlbbite.org/event/f1-singapore-grand-prix-20261011?stream=1',
    'https://mlbbite.org/event/f1-singapore-grand-prix-20261011#player',
    'https://mlbbite.org/event/',
    'https://mlbbite.org/event/F1-singapore-grand-prix-20261011',
    'https://mlbbite.org/event/f1_singapore_grand_prix',
    'https://mlbbite.org/event/f1-singapore-grand-prix-20261011/',
    'https://mlbbite.org/event/f1-singapore-grand-prix-20261011/extra',
    'https://mlbbite.org/event/f1%2Fsingapore-grand-prix',
    'https://mlbbite.org/f1--singapore-grand-prix',
  ];
  assert.equal(collector.allowedDiscoveryUrl('https://mlbbite.org:443/event/f1-singapore-grand-prix-20261011'),false);
  for(const url of rejected){
    assert.equal(collector.allowedDiscoveryUrl(url),false,url);
    await assert.rejects(collector.readHtml(url,new AbortController().signal),error=>
      error instanceof SourceFetchError&&error.message==='unsupported-discovery-address',url);
  }
  assert.deepEqual(collector.fixtureRequests(),[]);
});

test('SportsFeed24 all-category failure retains a later rate limit and longest retry',async()=>{
  const collector=createFixtureCollector();
  for(const name of categoryNames)collector.enqueueFixture({url:catalogUrl,method:'POST',
    requestBody:name?JSON.stringify({categoryName:name}):'{}',status:name==='F1'?429:503,
    headers:{'retry-after':name==='F1'?'600':'10'}});
  await assert.rejects(collector.readHtml(catalogUrl,new AbortController().signal),(error:unknown)=>{
    assert.ok(error instanceof SourceFetchError);
    assert.deepEqual({message:error.message,retryAfterMs:error.retryAfterMs},
      {message:'http-429',retryAfterMs:600_000});
    return true;
  });
  assert.equal(collector.fixtureRequests().length,9);
});

test('SportsFeed24 partial failure preserves categories and a later rate limit',async()=>{
  const collector=createFixtureCollector();
  for(const name of categoryNames)collector.enqueueFixture({url:catalogUrl,method:'POST',
    requestBody:name?JSON.stringify({categoryName:name}):'{}',
    status:name==='NFL'?503:name==='F1'?429:200,
    headers:{'retry-after':name==='F1'?'600':'10'},
    body:name?JSON.stringify({categoryName:name,subCategories:[]}):today});
  await assert.rejects(collector.readHtml(catalogUrl,new AbortController().signal),(error:unknown)=>{
    assert.ok(error instanceof PartialListingReadError);
    assert.equal(error.message,'http-429');
    assert.equal(error.retryAfterMs,600_000);
    assert.ok(error.cause instanceof SourceFetchError);
    assert.equal(error.cause.message,'http-429');
    assert.equal(error.cause.retryAfterMs,600_000);
    const body=z.object({complete:z.boolean(),categories:z.array(z.object({categoryName:z.string()}))})
      .parse(JSON.parse(error.html));
    assert.deepEqual(body,{
      complete:false,
      categories:['Streams today','NBA','NHL','MLB','motogp','UFC','Boxing'].map(categoryName=>({categoryName})),
    });
    const source=SOURCES.find(item=>item.id==='sportsfeed24');
    assert.ok(source);
    const listing=collector.parseListings(source,error.html,at);
    assert.equal(listing.outcome,'parsed');
    assert.ok(listing.observations.some(row=>row.title==='Dallas Cowboys vs Tampa Bay Buccaneers'));
    return true;
  });
  assert.equal(collector.fixtureRequests().length,9);
});
