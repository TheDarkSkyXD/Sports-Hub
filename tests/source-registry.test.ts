import assert from 'node:assert/strict';
import test from 'node:test';
import { SOURCE_REGISTRY, browserCategory, sourceCoverage } from '../lib/football/source-registry.ts';
import { SOURCES } from '../lib/football/adapters/sources.ts';
import { LeagueSchema } from '../lib/football/shared.ts';

test('the source registry preserves all configured sources and declares all supported leagues',()=>{
  assert.equal(SOURCES,SOURCE_REGISTRY);
  assert.equal(SOURCES.length,46);
  assert.equal(new Set(SOURCES.map(source=>source.id)).size,46);
  assert.deepEqual([...new Set(SOURCES.flatMap(source=>source.leagues))].sort(),[...LeagueSchema.options].sort());
  assert.deepEqual(sourceCoverage('tvapp-nhl'),['nhl']);
  assert.deepEqual(sourceCoverage('methstreams-f1'),['f1','nascar-cup','nascar-truck','motogp','motorsport']);
  assert.deepEqual(sourceCoverage('made-up-nfl'),[]);
  assert.deepEqual(sourceCoverage('vipbox-nba'),['nba']);
});

test('browser categories use observed provider URLs and preserve unknown detail routes',()=>{
  assert.equal(browserCategory('sportsurge-v2','nba')?.url,'https://v2.sportsurge.net/watch-basketball-streams/');
  assert.equal(browserCategory('sportsurge-v2','nba')?.pathCode,'basketball');
  assert.equal(browserCategory('streameast','nba')?.url,'https://v2.streameast.ga/nba-streams/');
  assert.equal(browserCategory('streameast','nba')?.espnPath,'basketball/nba');
  assert.equal(browserCategory('streameast','f1')?.pathCode,null);
  assert.equal(browserCategory('sportsurge-v2','unlisted'),undefined);
});
