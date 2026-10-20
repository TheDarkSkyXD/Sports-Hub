import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULES, createFixtureSchedule } from '../lib/football/adapters/schedule.ts';
import {enqueueSchedule} from './schedule-fixture.ts';

test('missing site kickoff uses only the same ESPN event and teams from CDN', async () => {
  const siteEvent = {id:'401858236',status:{type:{state:'pre',name:'STATUS_SCHEDULED',shortDetail:'9/26 - 12:00 PM EDT'}},competitions:[{competitors:[
    {homeAway:'away',team:{id:'2083',displayName:'Bucknell'}},
    {homeAway:'home',team:{id:'221',displayName:'Pittsburgh'}},
  ]}]};
  const cdnEvent = {...siteEvent,date:'2026-09-26T16:00:00Z'};
  let supplement: unknown = {content:{sbData:{events:[cdnEvent]}}};
  let failSupplement = false;
  {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const read = async () => {
      const fixture=createFixtureSchedule();
      enqueueSchedule(fixture,SCHEDULES[1],now,()=>({events:[siteEvent],week:{number:4}}));
      for(let count=0;count<3;count++)fixture.enqueueFixture({url:'https://cdn.espn.com/core/college-football/scoreboard?xhr=1&limit=500&group=80',status:failSupplement?503:200,body:JSON.stringify(supplement)});
      try{return await fixture.readSchedule(SCHEDULES[1],now,new AbortController().signal);}finally{fixture.close();}
    };
    const recovered = await read();
    assert.equal(recovered.games[0].date,'2026-09-26T16:00:00Z');
    assert.equal(recovered.games[0].detail,'Scheduled');
    assert.equal(recovered.games[0].status,'pre');
    assert.equal(recovered.week,4);

    supplement = {content:{sbData:{events:[{...cdnEvent,competitions:[{competitors:[
      {homeAway:'away',team:{id:'2083',displayName:'Bucknell'}},
      {homeAway:'home',team:{id:'999',displayName:'Pittsburgh'}},
    ]}]}]}}};
    assert.equal((await read()).games[0].date,undefined);

    failSupplement = true;
    assert.equal((await read()).games[0].date,undefined);
  }
});
