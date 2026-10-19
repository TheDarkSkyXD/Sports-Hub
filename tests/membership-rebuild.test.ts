import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mock,test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import type {Game} from '../lib/football/shared.ts';

test('each rebuild reads present and absent memberships once per season and publishes later changes',async()=>{
  const at=Date.parse('2026-10-18T18:00:00Z');
  const store=new FootballStore(':memory:');
  const team=(id:string)=>({id:`espn:ncaaf:${id}`,name:`Fixture ${id}`,short:`Fixture ${id}`,abbreviation:`F${id}`,color:'112233',score:'0'});
  const games:Game[]=Array.from({length:4},(_,index)=>({id:`ncaaf-${index}`,league:'ncaaf',season:index<2?2026:2027,
    name:'Fixture 1 at Fixture 0',date:new Date(at).toISOString(),home:team('0'),away:team('1'),
    status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['fbs']}));
  store.savePartition('fbs',{games,at});
  store.saveMembership({season:2026,at,teams:{'0':'fbs','1':'fcs'}});
  const reads=mock.method(store,'membership');
  const coordinator=new FootballCoordinator({store,now:()=>at,id:randomUUID,
    schedules:[{id:'fbs',league:'ncaaf',path:'/fixture',group:null}],sources:[],
    readSchedule:async()=>({games,league:'ncaaf',at}),readSeasonMembership:async()=>{throw new Error('Unexpected membership fetch');},
    readHtml:async()=>'',parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,
    compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
    probeCandidate:async()=>({kind:'unavailable',reason:'playback'})});
  const rebuild=async()=>{
    reads.mock.resetCalls();
    const reply=await coordinator.command({kind:'set-retention',minutes:1440});
    assert.equal(reply.kind,'board');
    if(reply.kind!=='board')throw new Error('Expected board');
    const memberships=reply.board.games.map(game=>{
      assert.ok('home' in game);
      return [game.id,game.home.membership?.subdivision??null,game.away.membership?.subdivision??null];
    });
    return {memberships,reads:reads.mock.callCount()};
  };
  try {
    const before=await rebuild();
    assert.deepEqual(before.memberships,[['ncaaf-0','fbs','fcs'],['ncaaf-1','fbs','fcs'],['ncaaf-2',null,null],['ncaaf-3',null,null]]);
    assert.equal(before.reads,2);
    store.saveMembership({season:2026,at:at+1,teams:{'0':'fcs','1':'d2-d3'}});
    store.saveMembership({season:2027,at:at+1,teams:{'0':'d2-d3','1':'fbs'}});
    const after=await rebuild();
    assert.deepEqual(after.memberships,[['ncaaf-0','fcs','d2-d3'],['ncaaf-1','fcs','d2-d3'],['ncaaf-2','d2-d3','fbs'],['ncaaf-3','d2-d3','fbs']]);
    assert.equal(after.reads,2);
  } finally {reads.mock.restore();await coordinator.stop();}
});
