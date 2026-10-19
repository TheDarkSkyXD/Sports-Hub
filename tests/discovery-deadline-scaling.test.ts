import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sourceInventory} from '../lib/football/domain/source-inventory.ts';
import type {Game,SourceAttempt} from '../lib/football/shared.ts';

test('source deadlines evaluate distant schedules once per snapshot and retain live and kickoff wake times',()=>{
  const at=Date.parse('2026-10-18T18:00:00Z');
  const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const fixture=(id:string,date:number):Game=>({id,league:'nfl',name:'Away at Home',date:new Date(date).toISOString(),
    home:team('Home'),away:team('Away'),status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false});
  for(const mode of ['idle','kickoff','live'] as const){
    const readCounts:number[]=[];
    for(const sourceCount of [2,32]){
      let lifecycleReads=0;
      const distant:Game[]=Array.from({length:128},(_,index)=>({...fixture(`future-${index}`,at+7*86400000),
        get lifecycle(){lifecycleReads++;return 'scheduled' as const;}}));
      const current=mode==='live'?{...fixture('current',at),status:'in',lifecycle:'live' as const}:fixture('current',at+4*3600000);
      const games=mode==='idle'?distant:[...distant,current];
      const sources=Array.from({length:sourceCount},(_,index)=>({id:`fixture-${index}`,url:`https://fixture-${index}.example/list`,family:'fixture',leagues:['nfl'] as const}));
      const attempts=Object.fromEntries(sources.map(source=>[source.id,{at,outcome:'empty'} satisfies SourceAttempt]));
      const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:false,
        sources,games,observations:[],candidates:new Map(),attempts,
        sportsurgeCatalog:{current:null,lastComplete:null,previous:null},streameastCatalog:{current:null,lastComplete:null,previous:null}});
      const deadline=at+(mode==='idle'?5*3600000:mode==='kickoff'?2*3600000:30*60000);
      assert.deepEqual(snapshot.sources.map(source=>source.lastAttempt?.nextEligibleAt),Array(sourceCount).fill(deadline));
      readCounts.push(lifecycleReads);
    }
    assert.ok(readCounts[1]<=readCounts[0]+256,
      `${mode} repeated distant-game eligibility for more sources: ${readCounts.join(' -> ')}`);
  }
});
