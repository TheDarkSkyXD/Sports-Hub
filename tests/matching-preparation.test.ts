import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {createObservationMatcher} from '../lib/football/domain/matching.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');
test('matching preparation computes team ownership independently of alias count',context=>{
 const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:null,
  aliases:Array.from({length:40},(_,index)=>name+' alias '+index)});
 const game:Game={id:'fixture',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),
  home:team('Home Harbor Hawks'),away:team('Away Valley Bears'),status:'in',lifecycle:'live',detail:'Live',redzone:false,partitions:['nfl']};
 const observation:Observation={id:'listing',sourceId:'fixture',url:'https://fixture.example/game',title:game.name,
  league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:at,parserVersion:3};
 let identityReads=0;
 const normalize=String.prototype.normalize;
 const calls=mock.method(String.prototype,'normalize',function(this:string,form?:string){
  if(this===game.home.name||this===game.away.name)identityReads++;
  return normalize.call(this,form);
 });
 try{
  const match=createObservationMatcher([game]);
  const preparationReads=identityReads;
  assert.deepEqual(match(observation,at),{kind:'matched',gameId:'fixture'});
  assert.deepEqual(match({...observation,teams:['Away Valley Bears alias 39','Home Harbor Hawks alias 39']},at),{kind:'matched',gameId:'fixture'});
  assert.deepEqual(match(observation,at+30*60_000+1),{kind:'unmatched',reason:'stale-observation',possibleGameIds:[]});
  context.diagnostic(JSON.stringify({aliasesPerTeam:40,identityReads:preparationReads}));
  assert.ok(preparationReads<=12,'Preparing two teams repeatedly normalized ownership '+preparationReads+' times');
 }finally{calls.mock.restore();}
});
