import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNativeMatcher} from '../native/collector/bridge.cjs';
import {z} from 'zod';

test('native prepared matcher keeps its accepted schedule and checks each observation time',()=>{
  const corpus=z.object({cases:z.array(z.object({operation:z.string(),input:z.record(z.unknown())}))})
    .parse(JSON.parse(readFileSync(new URL('./fixtures/rust-pipeline-domain.json',import.meta.url),'utf8')));
  const fixture=corpus.cases.find(row=>row.operation==='match');
  assert.ok(fixture);
  const now=z.number().parse(fixture.input.now);
  const observation=z.record(z.unknown()).parse(fixture.input.observation);
  const matcher=createNativeMatcher('observation',JSON.stringify(fixture.input.games));
  assert.deepEqual(JSON.parse(matcher.call(JSON.stringify({observation,now}))),{kind:'matched',gameId:'100'});
  assert.deepEqual(JSON.parse(matcher.call(JSON.stringify({observation,now:now+30*60_000+1}))),
    {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]});
});
