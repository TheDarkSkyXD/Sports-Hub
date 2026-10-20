import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeCollector} from '../native/collector/bridge.cjs';
import {ResolvedPlayerSchema} from '../lib/football/shared.ts';
import {z} from 'zod';

test('native acquisition retains the published combat segment in player labels',()=>{
  const native=createNativeCollector(true);
  const row={id:'fixture',sourceId:'fixture',url:'https://fixture.example/event',title:'UFC 320 Prelims',league:'ufc',teams:null,kickoff:1,rawTime:'',observedAt:1,parserVersion:3};
  const body='<iframe src="https://gooz.aapmains.net/new-stream-embed/1"></iframe>';
  const players=z.array(ResolvedPlayerSchema).parse(JSON.parse(native.compatiblePlayers('ufc-1',JSON.stringify(row),body)));
  assert.equal(players[0]?.label,'Primary · Prelims');
});
