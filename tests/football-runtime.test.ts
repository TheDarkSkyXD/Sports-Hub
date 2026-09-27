import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { reconcileSession } from '../lib/football/domain/lifecycle.ts';
import { command as workerCommand } from '../lib/football/runtime/client.ts';
import { SOURCES, parseListings, compatiblePlayers } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import type { Game, Session } from '../lib/football/shared.ts';

const kickoff = Date.parse('2026-09-26T16:00:00Z');
const team = (name:string,id:string) => ({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const live:Game = {
  id:'100',league:'nfl',name:'Away at Home',date:new Date(kickoff).toISOString(),
  home:team('Home','espn:nfl:1'),away:team('Away','espn:nfl:2'),status:'in',lifecycle:'live',
  detail:'Q1',redzone:false,partitions:['nfl'],
};
const final:Game = {...live,status:'post',lifecycle:'final',detail:'Final',finalObservedAt:kickoff,graceEndsAt:kickoff+300000};

test('the first fresh final timestamp survives restart and never extends the grace period',() => {
  const dir = mkdtempSync(join(tmpdir(),'football-store-'));
  const path = join(dir,'state.sqlite');
  try {
    const first = new FootballStore(path);
    first.savePartition('nfl',{games:[final],at:kickoff});
    first.close();
    const second = new FootballStore(path);
    second.savePartition('nfl',{games:[{...final,home:{...final.home,score:'7'}}],at:kickoff+120000});
    assert.equal(second.finals()[0].finalObservedAt,kickoff);
    assert.equal(second.finals()[0].graceEndsAt,kickoff+300000);
    assert.equal(second.finals()[0].home.score,'7');
    second.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a delayed schedule response starts final grace when the coordinator accepts it',async () => {
  const dir = mkdtempSync(join(tmpdir(),'football-delayed-final-'));
  let now = kickoff;
  const coordinator = createFootballCoordinator(join(dir,'state.sqlite'),{
    now:() => now,
    sources:[],
    readSchedule:async (partition,at) => {
      if (partition.id==='nfl') now += 90000;
      return {games:partition.id==='nfl' ? [final] : [],at,league:partition.league};
    },
  });
  try {
    await coordinator.refresh(true);
    const board = await coordinator.command({kind:'board'});
    assert.equal(board.kind,'board');
    if (board.kind==='board') {
      assert.equal(board.board.games[0].finalObservedAt,kickoff+90000);
      assert.equal(board.board.games[0].graceEndsAt,kickoff+390000);
    }
  } finally { await coordinator.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('source aliases become unusable when two games claim the same old ID',() => {
  const dir = mkdtempSync(join(tmpdir(),'football-alias-'));
  try {
    const store = new FootballStore(join(dir,'state.sqlite'));
    store.alias('source-123','100');
    assert.equal(store.aliases()['source-123'],'100');
    store.alias('source-123','200');
    assert.equal(store.aliases()['source-123'],undefined);
    store.alias('source-123','100');
    assert.equal(store.aliases()['source-123'],undefined);
    store.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a draining session closes at its own deadline even when the schedule row disappears',() => {
  const session = {id:'1',gameId:'100',candidateId:'gooz-123',generation:2,state:'draining',graceEndsAt:kickoff+300000} satisfies Session;
  assert.equal(reconcileSession(session,undefined,kickoff+299999).state,'draining');
  assert.equal(reconcileSession(session,undefined,kickoff+300000).state,'closed');
});

test('only one SQLite writer can own the pipeline database',() => {
  const dir = mkdtempSync(join(tmpdir(),'football-owner-'));
  const path = join(dir,'state.sqlite');
  try {
    const first = new FootballStore(path);
    assert.throws(() => new FootballStore(path),/football-writer-already-active/);
    const script = "import { FootballStore } from './lib/football/adapters/store.ts'; new FootballStore(process.argv[1]).close();";
    const rival = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,path],{cwd:process.cwd(),encoding:'utf8'});
    assert.notEqual(rival.status,0);
    assert.match(rival.stderr,/football-writer-already-active/);
    first.close();
    const second = new FootballStore(path);
    second.close();
    const released = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,path],{cwd:process.cwd(),encoding:'utf8'});
    assert.equal(released.status,0,released.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('active playback rejects stale failures, drains at final, then closes on the fixed deadline',async () => {
  const dir = mkdtempSync(join(tmpdir(),'football-runtime-'));
  let now = kickoff;
  let status:Game = live;
  let includeGame = true;
  let serial = 0;
  const listUrl = SOURCES[0].url;
  const detailUrl = 'https://isportsurge.ws/watch/nfl/away-home/123';
  const listing = `<a href="${detailUrl}" datetime="${new Date(kickoff).toISOString()}"><span class="team-name-event-row"><img alt="Away"></span><span class="team-name-event-row"><img alt="Home"></span></a>`;
  const observation = parseListings(SOURCES[0],listing,now).observations[0];
  assert.equal(observation.kickoff,kickoff,JSON.stringify(observation));
  assert.deepEqual(matchObservation(observation,[live],now),{kind:'matched',gameId:'100'});
  assert.equal(compatiblePlayers('100',observation,'<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe>',now).length,1);
  const coordinator = createFootballCoordinator(join(dir,'state.sqlite'),{
    now:() => now,
    sources:[SOURCES[0]],
    id:() => `00000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`,
    readSchedule:async (partition,at) => ({games:partition.id==='nfl' && includeGame ? [status] : [],at,league:partition.league}),
    readHtml:async url => url===listUrl
      ? listing
      : '<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe>',
  });
  try {
    await coordinator.refresh(true);
    const requestId = '11111111-1111-4111-8111-111111111111';
    let opened = await coordinator.command({kind:'open',gameId:'100',manual:false,requestId});
    for (let attempt=0;opened.kind==='error' && attempt<30;attempt++) {
      await new Promise(resolve => setTimeout(resolve,10));
      opened = await coordinator.command({kind:'open',gameId:'100',manual:false,requestId});
    }
    assert.equal(opened.kind,'playback',JSON.stringify(opened));
    if (opened.kind !== 'playback') return;
    const session = opened.playback.session;
    const duplicate = await coordinator.command({kind:'open',gameId:'100',manual:false,requestId});
    assert.equal(duplicate.kind,'playback');
    if (duplicate.kind === 'playback') assert.equal(duplicate.playback.session.id,session.id);
    const otherViewer = await coordinator.command({kind:'open',gameId:'100',manual:false,requestId:'22222222-2222-4222-8222-222222222222'});
    assert.equal(otherViewer.kind,'playback');
    if (otherViewer.kind === 'playback') {
      assert.notEqual(otherViewer.playback.session.id,session.id);
      await coordinator.command({kind:'close',sessionId:otherViewer.playback.session.id});
    }
    const first = await coordinator.command({kind:'session',sessionId:session.id,generation:0,failure:true,retry:false});
    assert.equal(first.kind,'session');
    if (first.kind !== 'session') return;
    assert.equal(first.session.generation,1);
    const stale = await coordinator.command({kind:'session',sessionId:session.id,generation:0,failure:true,retry:false});
    assert.equal(stale.kind,'error');
    const exhausted = await coordinator.command({kind:'session',sessionId:session.id,generation:1,failure:true,retry:false});
    assert.equal(exhausted.kind,'error');
    const retried = await coordinator.command({kind:'session',sessionId:session.id,generation:1,failure:false,retry:true});
    assert.equal(retried.kind,'session');
    if (retried.kind !== 'session') return;
    assert.equal(retried.session.generation,2);
    const beforeFinal = await coordinator.command({kind:'session',sessionId:session.id,generation:2,failure:true,retry:false});
    assert.equal(beforeFinal.kind,'session');
    if (beforeFinal.kind === 'session') assert.equal(beforeFinal.session.generation,3);
    for (let heartbeat=0;heartbeat<Math.ceil(25*3600000/70000);heartbeat++) {
      now += 70000;
      const authorized = await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:'gooz-123',generation:3});
      assert.equal(authorized.kind,'authorized');
    }
    const staleBoard = await coordinator.command({kind:'board'});
    assert.equal(staleBoard.kind,'board');
    if (staleBoard.kind === 'board') {
      assert.equal(staleBoard.board.games[0].id,'100');
      assert.equal(staleBoard.board.games[0].sourceUrl,undefined);
    }
    assert.equal((await coordinator.command({kind:'open',gameId:'100',manual:false})).kind,'error');
    now += 60000;
    status = final;
    await coordinator.refresh(true);
    const board = await coordinator.command({kind:'board'});
    assert.equal(board.kind,'board');
    if (board.kind === 'board') {
      assert.equal(board.board.games[0].lifecycle,'final',JSON.stringify(board.board.games[0]));
      assert.equal(board.board.games[0].sourceUrl,undefined);
    }
    assert.equal((await coordinator.command({kind:'open',gameId:'100',manual:false})).kind,'error');
    const drain = await coordinator.command({kind:'session',sessionId:session.id,generation:3,failure:false,retry:false});
    assert.equal(drain.kind,'session');
    if (drain.kind !== 'session') return;
    assert.equal(drain.session.state,'draining');
    assert.equal(drain.session.graceEndsAt,now+300000);
    const refreshed = await coordinator.command({kind:'session',sessionId:session.id,generation:3,failure:true,retry:false});
    assert.equal(refreshed.kind,'session');
    if (refreshed.kind === 'session') assert.equal(refreshed.session.generation,4);
    includeGame=false;
    await coordinator.refresh(true);
    const missing = await coordinator.command({kind:'session',sessionId:session.id,generation:4,failure:false,retry:false});
    assert.equal(missing.kind,'session');
    if (missing.kind === 'session') assert.equal(missing.session.graceEndsAt,drain.session.graceEndsAt);
    now += 300001;
    assert.equal((await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:'gooz-123',generation:4})).kind,'error');
  } finally { await coordinator.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('automatic failover reaches the fourth source after one bounded wait, then stops',async () => {
  const dir = mkdtempSync(join(tmpdir(),'football-failover-'));
  let now = kickoff;
  const coordinator = createFootballCoordinator(join(dir,'state.sqlite'),{
    now:() => now,
    sources:[SOURCES[0]],
    readSchedule:async (partition,at) => ({games:partition.id==='nfl' ? [live] : [],at,league:partition.league}),
    readHtml:async url => url===SOURCES[0].url
      ? `<a href="https://isportsurge.ws/watch/nfl/away-home/123" datetime="${new Date(kickoff).toISOString()}"><span class="team-name-event-row"><img alt="Away"></span><span class="team-name-event-row"><img alt="Home"></span></a>`
      : '<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe><button onclick="changeStream(124)"></button><button onclick="changeStream(125)"></button><button onclick="changeStream(126)"></button>',
  });
  try {
    await coordinator.refresh(true);
    let opened = await coordinator.command({kind:'open',gameId:'100',manual:false});
    for (let attempt=0;opened.kind==='error' && attempt<30;attempt++) {
      await new Promise(resolve => setTimeout(resolve,10));
      opened = await coordinator.command({kind:'open',gameId:'100',manual:false});
    }
    assert.equal(opened.kind,'playback',JSON.stringify(opened));
    if (opened.kind !== 'playback') return;
    assert.equal(opened.playback.candidates.length,4);
    const sessionId = opened.playback.session.id;
    let generation = 0;
    for (let failed=0;failed<3;failed++) {
      const refreshed = await coordinator.command({kind:'session',sessionId,generation,failure:true,retry:false});
      assert.equal(refreshed.kind,'session');
      generation++;
      const next = await coordinator.command({kind:'session',sessionId,generation,failure:true,retry:false});
      if (failed<2) { assert.equal(next.kind,'session'); generation++; }
      else {
        assert.equal(next.kind,'error');
        if (next.kind === 'error') assert.equal(next.retryAfter,now+30000);
      }
    }
    now += 29999;
    const early = await coordinator.command({kind:'session',sessionId,generation,failure:false,retry:false});
    assert.equal(early.kind,'error');
    now += 1;
    const fourth = await coordinator.command({kind:'session',sessionId,generation,failure:false,retry:false});
    assert.equal(fourth.kind,'session');
    if (fourth.kind !== 'session') return;
    assert.equal(fourth.session.candidateId,'gooz-126');
    generation = fourth.session.generation;
    assert.equal((await coordinator.command({kind:'session',sessionId,generation,failure:true,retry:false})).kind,'session');
    generation++;
    const exhausted = await coordinator.command({kind:'session',sessionId,generation,failure:true,retry:false});
    assert.equal(exhausted.kind,'error');
    if (exhausted.kind === 'error') assert.equal(exhausted.retryAfter,undefined);
  } finally { await coordinator.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('a newly discovered candidate accompanies the session reply that selects it',async () => {
  const dir = mkdtempSync(join(tmpdir(),'football-late-candidate-'));
  let now = kickoff;
  const detailUrl = 'https://isportsurge.ws/watch/nfl/away-home/123';
  const listing = `<a href="${detailUrl}" datetime="${new Date(kickoff).toISOString()}"><span class="team-name-event-row"><img alt="Away"></span><span class="team-name-event-row"><img alt="Home"></span></a>`;
  let detail = '<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe>';
  const coordinator = createFootballCoordinator(join(dir,'state.sqlite'),{
    now:() => now,
    sources:[SOURCES[0]],
    readSchedule:async (partition,at) => ({games:partition.id==='nfl' ? [live] : [],at,league:partition.league}),
    readHtml:async url => url===SOURCES[0].url ? listing : detail,
  });
  try {
    await coordinator.refresh(true);
    let opened = await coordinator.command({kind:'open',gameId:'100',manual:false});
    for (let attempt=0;opened.kind==='error' && attempt<30;attempt++) {
      await new Promise(resolve => setTimeout(resolve,10));
      opened = await coordinator.command({kind:'open',gameId:'100',manual:false});
    }
    assert.equal(opened.kind,'playback',JSON.stringify(opened));
    if (opened.kind!=='playback') return;
    assert.equal(opened.playback.session.candidateId,'gooz-123');
    const sessionId = opened.playback.session.id;
    detail += '<button onclick="changeStream(124)"></button>';
    now += 60000;
    assert.equal((await coordinator.command({kind:'session',sessionId,generation:0,failure:false,retry:false})).kind,'session');
    now += 60001;
    await coordinator.refresh(true);
    let discovered = await coordinator.command({kind:'session',sessionId,generation:0,failure:false,retry:false});
    for (let attempt=0;discovered.kind==='session' && !discovered.candidates.some(candidate=>candidate.id==='gooz-124') && attempt<30;attempt++) {
      await new Promise(resolve => setTimeout(resolve,10));
      discovered = await coordinator.command({kind:'session',sessionId,generation:0,failure:false,retry:false});
    }
    assert.equal(discovered.kind,'session');
    if (discovered.kind==='session') assert.ok(discovered.candidates.some(candidate=>candidate.id==='gooz-124'));
    const first = await coordinator.command({kind:'session',sessionId,generation:0,failure:true,retry:false});
    assert.equal(first.kind,'session');
    const switched = await coordinator.command({kind:'session',sessionId,generation:1,failure:true,retry:false});
    assert.equal(switched.kind,'session',JSON.stringify(switched));
    if (switched.kind==='session') {
      assert.equal(switched.session.candidateId,'gooz-124');
      assert.ok(switched.candidates.some(candidate=>candidate.id===switched.session.candidateId));
    }
  } finally { await coordinator.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('the worker bridge validates a command and shuts down its SQLite writer',async () => {
  const dir = mkdtempSync(join(tmpdir(),'football-worker-'));
  process.env.SUNDAY_ROOM_DATA_DIR = dir;
  try {
    const reply = await workerCommand({kind:'stop'});
    assert.deepEqual(reply,{kind:'ok'});
    for (let attempt=0;globalThis.footballWorkerClient && attempt<50;attempt++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(globalThis.footballWorkerClient,undefined);
  } finally {
    delete process.env.SUNDAY_ROOM_DATA_DIR;
    const target=resolve(dir);
    assert.equal(dirname(target),resolve(tmpdir()));
    assert.match(basename(target),/^football-worker-/);
    rmSync(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test('a replacement worker reclaims only the confirmed exited worker token',async () => {
  const dir = mkdtempSync(join(tmpdir(),'football-worker-crash-'));
  process.env.SUNDAY_ROOM_DATA_DIR = dir;
  try {
    const board = workerCommand({kind:'board'});
    const client = globalThis.footballWorkerClient;
    assert.ok(client);
    const worker = Reflect.get(client,'worker');
    let ownerSeen = false;
    for (let attempt=0;attempt<100;attempt++) {
      const path = join(dir,'football.sqlite');
      if (existsSync(path)) {
        try {
          const reader = new DatabaseSync(path,{readOnly:true});
          try { ownerSeen = reader.prepare('SELECT token FROM owner WHERE slot=1').get() !== undefined; }
          finally { reader.close(); }
          if (ownerSeen) break;
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.equal(ownerSeen,true);
    await worker.terminate();
    assert.equal((await board).kind,'error');
    for (let attempt=0;globalThis.footballWorkerClient && attempt<20;attempt++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(globalThis.footballWorkerClient,undefined);
    assert.deepEqual(await workerCommand({kind:'stop'}),{kind:'ok'});
    for (let attempt=0;globalThis.footballWorkerClient && attempt<50;attempt++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(globalThis.footballWorkerClient,undefined);
  } finally {
    delete process.env.SUNDAY_ROOM_DATA_DIR;
    const target=resolve(dir);
    assert.equal(dirname(target),resolve(tmpdir()));
    assert.match(basename(target),/^football-worker-crash-/);
    rmSync(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
