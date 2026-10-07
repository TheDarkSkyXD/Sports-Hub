import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Candidate, Game, Observation } from '../lib/football/shared.ts';
import type { ScheduleResult } from '../lib/football/domain/ports.ts';

const at = Date.parse('2026-10-02T18:00:00Z');
const game: Game = {
  id: '100', league: 'nfl', name: 'Away at Home', date: new Date(at).toISOString(),
  home: { name: 'Home', short: 'Home', abbreviation: 'HOM', color: '112233', score: '0' },
  away: { name: 'Away', short: 'Away', abbreviation: 'AWY', color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
};

test('a ready live league discovers feeds while another schedule partition is pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-orchestration-'));
  let release!: (result: ScheduleResult) => void;
  const delayed = new Promise<ScheduleResult>(resolve => { release = resolve; });
  const source = { id: 'sportsurge', url: 'https://isportsurge.ws/index6', family: 'sportsurge' };
  const detail = 'https://isportsurge.ws/watch/nfl/away-home/100';
  const coordinator = createFootballCoordinator(join(dir, 'state.sqlite'), {
    now: () => at, sources: [source],
    readSchedule: async partition => partition.id === 'fcs' ? delayed : {
      games: partition.id === 'nfl' ? [game] : [], league: partition.league, at,
    },
    readHtml: async url => url === source.url
      ? `<a href="${detail}" datetime="${game.date}">Away vs Home</a>`
      : '<iframe src="https://gooz.aapmains.net/new-stream-embed/101"></iframe>',
    probeCandidate: async () => ({ kind: 'playable', proof: 'media' }),
  });
  const refreshing = coordinator.refresh(true);
  try {
    for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') return;
    assert.deepEqual(reply.snapshot.games.find(row => row.gameId === game.id)?.candidates.map(candidate => candidate.id), ['gooz-101']);
  } finally {
    release({ games: [], league: 'ncaaf', at });
    await refreshing;
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live games receive probe slots until an explicit scheduled check takes priority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-live-probes-'));
  const live = {...game,id:'live'};
  const scheduled = Array.from({length:4},(_,index):Game=>({
    ...game,id:`scheduled-${index}`,name:`Away ${index} at Home ${index}`,
    home:{...game.home,name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`},
    away:{...game.away,name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`},
    status:'pre',lifecycle:'scheduled',detail:'Scheduled',
  }));
  const games=[...scheduled,live];
  const source={id:'fixture',url:'https://fixture.example/list',family:'fixture'};
  const observations=games.map((match,index):Observation=>({
    id:`listing-${index}`,sourceId:source.id,url:`https://fixture.example/detail/${index}`,
    title:match.name,league:'nfl',teams:[match.away.name,match.home.name],
    kickoff:at,rawTime:'',observedAt:at,parserVersion:1,
  }));
  const calls:string[]=[];
  const pending:{id:string;resolve:()=>void}[]=[];
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async partition=>({games:partition.id==='nfl'?games:[],league:partition.league,at}),
    readHtml:async()=>'<div>fixture</div>',
    parseListings:()=>({outcome:'parsed',observations}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId,value)=>Array.from({length:gameId==='live'?6:1},(_,index):Candidate=>({
      id:`${gameId}-${index}`,gameId,label:`Server ${index}`,sourceIds:[value.sourceId],observedAt:at,
      locator:{provider:'gooz',playerId:String(games.findIndex(match=>match.id===gameId)*10+index+1)},
    })),
    probeCandidate:async(locator,signal)=>{
      assert.equal(locator.provider,'gooz');
      const id=locator.provider==='gooz'?locator.playerId:'';
      calls.push(id);
      await new Promise<void>(resolve=>{
        pending.push({id,resolve});
        signal.addEventListener('abort',resolve,{once:true});
      });
      return {kind:'playable',proof:'media'};
    },
  });
  const until=async(count:number)=>{
    for(let attempt=0;calls.length<count&&attempt<100;attempt++)
      await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(calls.length,count,JSON.stringify(calls));
  };
  try {
    await coordinator.refresh(true);
    await until(4);
    assert.deepEqual(calls,['41','42','43','1']);
    for(const job of pending.splice(0,4))job.resolve();
    await until(8);
    assert.deepEqual(calls.slice(4,7),['44','45','46']);
    assert.ok(['11','21'].includes(calls[7]), 'a scheduled game receives the background slot');
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:['scheduled-3'],retry:false}),{kind:'ok'});
    pending.shift()?.resolve();
    await until(9);
    assert.equal(calls[8],'31');
  } finally {
    for(const job of pending)job.resolve();
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
