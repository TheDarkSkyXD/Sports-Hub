import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SOURCES,parseListings} from '../lib/football/adapters/sources.ts';

const now=Date.parse('2026-10-11T19:00:00Z');
const games=[
  {day:'20261011',slug:'m-los-angeles-dodgers-vs-milwaukee-brewers-nlcs-game-1-1012',
    title:'Los Angeles Dodgers vs Milwaukee Brewers (NLCS Game 1)',kickoff:'2026-10-12T00:00:00Z'},
  {day:'20261012',slug:'m-los-angeles-dodgers-vs-milwaukee-brewers-nlcs-game-2-1012',
    title:'Los Angeles Dodgers vs Milwaukee Brewers (NLCS Game 2)',kickoff:'2026-10-12T21:00:00Z'},
  {day:'20261012',slug:'m-cleveland-guardians-vs-tampa-bay-rays-alcs-game-1-1013',
    title:'Cleveland Guardians vs Tampa Bay Rays (ALCS Game 1)',kickoff:'2026-10-13T00:00:00Z'},
];

test('Methstreams and Crackstreams retain today and tomorrow MLB league sections',()=>{
  const body=games.map(game=>`<section class="lg" id="g-lg-mlb-${game.day}">
    <a class="ev" href="/event/${game.slug}" data-start="${Date.parse(game.kickoff)/1000}">
      ${game.title}<time datetime="${game.kickoff}"></time></a></section>`).join('');
  for(const id of ['methstreams-mlb','crackstreams-mlb']){
    const source=SOURCES.find(source=>source.id===id);
    assert.ok(source);
    const result=parseListings(source,body,now);
    assert.equal(result.outcome,'parsed');
    assert.deepEqual(result.observations.map(row=>({url:row.url,league:row.league,teams:row.teams,kickoff:row.kickoff})),
      games.map(game=>({url:new URL(`/event/${game.slug}`,source.url).href,league:'mlb',
        teams:game.slug.includes('dodgers')?['Los Angeles Dodgers','Milwaukee Brewers']:['Cleveland Guardians','Tampa Bay Rays'],
        kickoff:Date.parse(game.kickoff)})));
    for(const wrong of ['g-lg-nhl','g-lg-mlb-wrong-date']){
      assert.deepEqual(parseListings(source,body.replaceAll('g-lg-mlb',wrong),now).observations,[]);
    }
  }
});
