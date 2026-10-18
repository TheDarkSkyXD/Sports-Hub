import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {candidateEvidence} from '../components/source-inventory-view.ts';
import {CandidateSummarySchema} from '../lib/football/shared.ts';
import {configuredProbeCandidate} from '../lib/playback/probe.ts';

test('decoded-video failures keep their reported cause through the checker and source inventory',async()=>{
  let report:unknown={kind:'unavailable'};
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify(request.url==='/verify'?report:{ok:true}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const previous=Object.fromEntries(['SUNDAY_ROOM_APP_ORIGIN','SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN','SUNDAY_ROOM_CONTROL_TOKEN']
    .map(key=>[key,process.env[key]]));
  process.env.SUNDAY_ROOM_APP_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=process.env.SUNDAY_ROOM_APP_ORIGIN;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='public-test-fixture';
  const target={sessionId:'00000000-0000-4000-8000-000000000001',gameId:'1',candidateId:'one',generation:0} satisfies Parameters<typeof configuredProbeCandidate>[3];
  try{
    for(const value of [
      {kind:'unavailable',reason:'no-feed',phase:'activation'},
      {kind:'unavailable',reason:'invalid-media',phase:'decode'},
      {kind:'deferred',reason:'upstream',phase:'ownership',retryAfterMs:45000},
      {kind:'deferred',reason:'capacity',phase:'capture',retryAfterMs:2000},
    ]){
      report=value;
      assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target),value);
    }
    const waiting=CandidateSummarySchema.parse({id:'one',gameId:'1',label:'One',sourceIds:['fixture'],observedAt:0,
      availability:{kind:'checking',progress:{kind:'deferred',since:1000,retryAt:3000,reason:'capacity',phase:'capture',retryAfterMs:2000}}});
    assert.equal(candidateEvidence(waiting,1000),'Waiting for a playback check · Retrying in 2s');
    for(const [reason,label] of [['blocked','Source denied media access'],['not-found','Source media not found'],
      ['invalid-media','No valid video returned'],['timeout','Media check timed out']]){
      report={kind:'unavailable',reason};
      const result=await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target);
      assert.deepEqual(result,{kind:'unavailable',reason,phase:'replay'});
      const candidate=CandidateSummarySchema.parse({id:'one',gameId:'1',label:'One',sourceIds:['fixture'],observedAt:0,
        availability:{...result,checkedAt:1000,retryAt:301000}});
      assert.equal(candidateEvidence(candidate,1000),`${label} · Waiting 5m 0s for next check`);
    }
    report={kind:'unavailable'};
    assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target),
      {kind:'unavailable',reason:'playback',phase:'replay'});
    for(const invalid of [{kind:'playable',proof:{kind:'advancing-video'}},{kind:'unavailable',reason:'invented'}]){
      report=invalid;
      assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},target),
        {kind:'deferred',retryAfterMs:30000});
    }
  }finally{
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('a verifier service error cannot establish that the upstream video is broken',async()=>{
  const server=createServer((_request,response)=>{response.writeHead(500);response.end('Verifier unavailable');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const previous=Object.fromEntries(['SUNDAY_ROOM_APP_ORIGIN','SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN','SUNDAY_ROOM_CONTROL_TOKEN']
    .map(key=>[key,process.env[key]]));
  process.env.SUNDAY_ROOM_APP_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=process.env.SUNDAY_ROOM_APP_ORIGIN;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='public-test-fixture';
  try{
    assert.deepEqual(await configuredProbeCandidate({provider:'gooz',playerId:'1'},new AbortController().signal,()=>{},
      {sessionId:'00000000-0000-4000-8000-000000000001',gameId:'1',candidateId:'one',generation:0}),
    {kind:'deferred',retryAfterMs:30000});
  }finally{
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
