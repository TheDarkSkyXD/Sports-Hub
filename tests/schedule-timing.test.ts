import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULES, readSchedule } from '../lib/football/adapters/schedule.ts';

test('missing site kickoff uses only the same ESPN event and teams from CDN', async () => {
  const siteEvent = {id:'401858236',status:{type:{state:'pre',name:'STATUS_SCHEDULED',shortDetail:'9/26 - 12:00 PM EDT'}},competitions:[{competitors:[
    {homeAway:'away',team:{id:'2083',displayName:'Bucknell'}},
    {homeAway:'home',team:{id:'221',displayName:'Pittsburgh'}},
  ]}]};
  const cdnEvent = {...siteEvent,date:'2026-09-26T16:00:00Z'};
  let supplement: unknown = {content:{sbData:{events:[cdnEvent]}}};
  let failSupplement = false;
  const fetchMock = mock.method(globalThis,'fetch', async (input: RequestInfo | URL) => {
    if (String(input).startsWith('https://cdn.espn.com/')) return failSupplement ? new Response(null,{status:503}) : Response.json(supplement);
    return Response.json({events:[siteEvent],week:{number:4}});
  });
  try {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const read = () => readSchedule(SCHEDULES[1],now,new AbortController().signal);
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
  } finally {
    fetchMock.mock.restore();
  }
});
