import assert from 'node:assert/strict';
import test from 'node:test';
import {compatiblePlayers,enrichObservation,parseListings,SOURCES} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const source=SOURCES.find(item=>item.id==='livetv');
assert.ok(source);
const alias='https://livetv.sx/enx/eventinfo/478510070__/';
const canonical='https://livetv.sx/enx/eventinfo/478510070_baffalo_bills_ny_inglend_petriots/';
const kickoff='2026-10-04T20:00:00+03:00';
const wrapper=(channel:string)=>`https://livetv.sx/webplayer.php?t=ifr&c=${channel}&lang=en&eid=478510070&lid=${channel}&ci=142&si=27`;
const listing=`<table><tr><td><img alt="USA. NFL"><a href="/enx/eventinfo/478510070__/"><span>Buffalo Bills &ndash; New England Patriots</span></a>
  <a href="/enx/eventinfo/478510070__/"><img alt="live"></a><span class="evdesc">4 October at 18:00 (USA. NFL)</span></td></tr>
  <tr><td><img alt="Canada. CFL"><a href="/enx/eventinfo/478510999__usk/"><span>Montreal &ndash; Winnipeg</span></a></td></tr></table>`;
const metadata={'@type':'BroadcastEvent',name:'Buffalo Bills -New England Patriots',url:canonical,startDate:kickoff,
  broadcastOfEvent:{'@type':'SportsEvent',name:'Buffalo Bills -New England Patriots',competitor:[
    {'@type':'SportsTeam',name:'Buffalo Bills'},{'@type':'SportsTeam',name:'New England Patriots'}]}};
function detail(event=metadata,links=[wrapper('3081333'),wrapper('3082009')]){
  return `<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}">
    <script type="application/ld+json">${JSON.stringify(event)}</script>
    ${links.map(url=>`<a href="${url.replaceAll('&','&amp;')}"><img alt="free stream"></a>`).join('')}`;
}

test('LiveTV admits only published NFL event rows and enriches from exact dated detail',()=>{
  const result=parseListings(source,listing,Date.parse('2026-10-04T16:00:00Z'));
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  const observation=result.observations[0];
  assert.equal(observation.url,alias);
  assert.equal(observation.league,'nfl');
  assert.deepEqual(observation.teams,['Buffalo Bills','New England Patriots']);
  assert.equal(observation.kickoff,null);
  const enriched=enrichObservation(observation,detail());
  assert.equal(enriched.kickoff,Date.parse(kickoff));
  assert.deepEqual(compatiblePlayers('401872974',enriched,detail()).map(player=>player.locator),[
    {provider:'event-page',gameId:'401872974',eventUrl:alias,serverUrl:wrapper('3081333')},
    {provider:'event-page',gameId:'401872974',eventUrl:alias,serverUrl:wrapper('3082009')},
  ]);
});

test('LiveTV rejects wrong detail identity, date, and altered wrapper contexts',()=>{
  const observation=parseListings(source,listing,Date.parse('2026-10-04T16:00:00Z')).observations[0];
  for(const changed of [
    {...metadata,url:canonical.replace('478510070','478510071')},
    {...metadata,broadcastOfEvent:{...metadata.broadcastOfEvent,competitor:[
      {'@type':'SportsTeam',name:'Other Team'},{'@type':'SportsTeam',name:'New England Patriots'}]}},
  ]){
    assert.equal(enrichObservation(observation,detail(changed)).kickoff,null);
    assert.deepEqual(compatiblePlayers('401872974',{...observation,kickoff:Date.parse(kickoff)},detail(changed)),[]);
  }
  const changedDate={...metadata,startDate:'2026-10-05T20:00:00+03:00'};
  assert.equal(enrichObservation(observation,detail(changedDate)).kickoff,Date.parse(changedDate.startDate));
  assert.deepEqual(compatiblePlayers('401872974',{...observation,kickoff:Date.parse(kickoff)},detail(changedDate)),[]);
  for(const changed of [wrapper('3081333').replace('eid=478510070','eid=478510071'),
    wrapper('3081333').replace('lid=3081333','lid=3082009'),wrapper('3081333')+'&token=secret',
    wrapper('3081333')+'&c=3081333',wrapper('3081333').replace('livetv.sx','livetv.sx.evil.test'),
    wrapper('3081333').replace('https:','http:'),wrapper('3081333').replace('livetv.sx','user@livetv.sx')])
    assert.equal(validEventPagePair(alias,changed),false);
  assert.equal(validEventPagePair(alias.replace('livetv.sx','attacker.test'),wrapper('3081333')),false);
  assert.equal(validEventPagePair(alias.replace('livetv.sx','live%74v.sx'),wrapper('3081333')),false);
});

test('LiveTV empty or malformed football rows do not invent feeds',()=>{
  assert.equal(parseListings(source,'<table><tr><td><img alt="Canada. CFL"><a href="/enx/eventinfo/478510999__usk/">Montreal – Winnipeg</a></td></tr></table>',0).observations.length,0);
  const malformed=listing.replace('/enx/eventinfo/478510070__/','/enx/eventinfo/478510070__/?key=1');
  assert.equal(parseListings(source,malformed,0).observations.length,0);
});

test('LiveTV NCAA competition marker retains college events when published',()=>{
  const collegeAlias='https://livetv.sx/enx/eventinfo/298555243_/';
  const collegeCanonical='https://livetv.sx/enx/eventinfo/298555243_yta_yts_tehas_teh_red_reyders/';
  const html='<table><tr><td><img alt="NCAA"><a href="/enx/eventinfo/298555243_/">Utah Utes &ndash; Texas Tech Red Raiders</a><span class="evdesc">NCAA</span></td></tr></table>';
  const parsed=parseListings(source,html,Date.parse('2025-09-20T12:00:00Z'));
  assert.equal(parsed.outcome,'parsed');
  assert.equal(parsed.observations.length,1);
  const observation=parsed.observations[0];
  assert.equal(observation.url,collegeAlias);
  assert.equal(observation.league,'ncaaf');
  assert.deepEqual(observation.teams,['Utah Utes','Texas Tech Red Raiders']);
  const detail=`<link rel="canonical" href="${collegeCanonical}"><meta property="og:url" content="${collegeCanonical}">
    <script type="application/ld+json">${JSON.stringify({'@type':'BroadcastEvent',url:'/enx/eventinfo/298555243_yta_yts_tehas_teh_red_reyders/',
      name:'Utah Utes -Texas Tech Red Raiders',startDate:'2025-09-20T19:00:00+03:00',
      broadcastOfEvent:{'@type':'SportsEvent',name:'Utah Utes -Texas Tech Red Raiders',
        competitor:[{name:'Utah Utes'},{name:'Texas Tech Red Raiders'}]}})}</script>`;
  assert.equal(enrichObservation(observation,detail).kickoff,Date.parse('2025-09-20T19:00:00+03:00'));
});
