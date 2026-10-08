import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {sportsurgeCandidates} from '../lib/football/domain/sportsurge-catalog.ts';
import {CandidateLocatorSchema} from '../lib/football/shared.ts';
import {sportsurgeV2Provider} from '../lib/playback/providers/sportsurge-v2.ts';
import type {Game,SportsurgeCatalog} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T00:15:00Z');
const expectedMatchup={league:'ncaaf' as const,teams:['Jacksonville State Gamecocks','Kennesaw State Owls'] as [string,string]};
const destination='https://provider.example/watch/current-game';
const page=readFileSync(new URL('./fixtures/sportsurge-topstreams-wrong-match.html',import.meta.url),'utf8');
const media='https://cdn.example/live/index.m3u8';
const makeLocator=(expected=true)=>{
  const parsed=CandidateLocatorSchema.parse({provider:'sportsurge-v2',eventId:'ncaaf:66184',providerId:'stream-1-0',
    url:destination,...(expected?{expectedMatchup}:{})});
  assert.equal(parsed.provider,'sportsurge-v2');
  if(parsed.provider!=='sportsurge-v2')throw new Error('unexpected locator');
  return parsed;
};
const requester=(html:string,status=200)=>async(url:URL):Promise<Response>=>{
  if(url.href!==destination)throw new Error('unexpected media request');
  return new Response(html,{status,headers:{'Content-Type':'text/html'}});
};

test('new Sportsurge candidates carry their verified event matchup without dropping old locator payloads',()=>{
  const team=(id:string,name:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game={id:'ncaaf-401871051',league:'ncaaf',name:'Jacksonville State at Kennesaw State',
    date:'2026-10-07T23:00:00Z',away:team('espn:ncaaf:55','Jacksonville State Gamecocks'),
    home:team('espn:ncaaf:338','Kennesaw State Owls'),status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fbs']};
  const event:SportsurgeCatalog['events'][number]={id:'ncaaf:66184',
    url:'https://v2.sportsurge.net/watch-66184-cfb-jacksonville-state-kennesaw-state/',league:'ncaaf',
    title:'Jacksonville State Gamecocks vs Kennesaw State Owls',teams:expectedMatchup.teams,
    sourceStatus:'live',kickoff:null,advertisedLinkCount:1,
    detail:{kind:'collected',at,providers:[{id:'stream-1-0',label:'Tophdstreams',observedAt:at,
      destination:{kind:'link',url:destination}}]}};
  const catalog:SportsurgeCatalog={runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'complete',at},categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},
    events:[event],rejectedGames:[],catalogIssues:[]};
  const candidates=sportsurgeCandidates({current:{catalog,receivedAt:at},previous:null,lastComplete:null,games:[game],now:at});
  assert.equal(candidates.length,1);
  assert.deepEqual(candidates[0].locator,{...makeLocator(false),expectedMatchup});
  assert.deepEqual(CandidateLocatorSchema.parse(makeLocator(false)),makeLocator(false));
  assert.equal('expectedMatchup' in makeLocator(false),false);
});

test('a concrete wrong-game Sportsurge page cannot supply static media or reach browser fallback',async()=>{
  const locator=makeLocator();
  assert.deepEqual('expectedMatchup' in locator?locator.expectedMatchup:undefined,expectedMatchup);
  await assert.rejects(sportsurgeV2Provider(requester(page)).open(locator,new AbortController().signal),/conflicting.*matchup/i);
  await assert.rejects(sportsurgeV2Provider(requester(page.replace(/<video>[\s\S]*<\/video>/,'')))
    .open(locator,new AbortController().signal,'probe'),/conflicting.*matchup/i);
});

test('correct aliases and generic player titles retain media access, including old locators',async()=>{
  for(const title of ['Jax State vs Kennesaw St','Kennesaw St at Jax State','Live Football Player','Troy vs Kennesaw State']){
    const html=`<title>${title}</title><video><source src="${media}"></video>`;
    const playback=await sportsurgeV2Provider(requester(html)).open(makeLocator(),new AbortController().signal);
    assert.equal(playback.root.identity,media);
    playback.close();
  }
  const legacy=makeLocator(false);
  const playback=await sportsurgeV2Provider(requester(page)).open(legacy,new AbortController().signal);
  assert.equal(playback.root.identity,media);
  playback.close();
});

test('an HTTP 403 challenge cannot publish an HTML media tag through static lookup',async()=>{
  await assert.rejects(sportsurgeV2Provider(requester(page,403)).open(makeLocator(),new AbortController().signal));
});
