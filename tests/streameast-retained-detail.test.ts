import assert from 'node:assert/strict';
import test from 'node:test';
import type {StreameastCatalogView} from '../lib/football/shared.ts';
import {retainedStreameastDetail} from '../components/source-inventory-view.ts';

type Listing=StreameastCatalogView['games'][number];
type Collected=Extract<Listing['detail'],{kind:'collected'}>;

const server:Collected['servers'][number]={id:'2',label:'Server 2',
  url:'https://v2.streameast.ga/cfb/away-vs-home/2',availability:{kind:'free-page'}};
const collected=(at:number,servers:Collected['servers']=[server]):Listing['detail']=>({kind:'collected',at,servers});
const failed:Listing['detail']={kind:'failed',at:120,reason:'rate-limited'};

function listing(detail:Listing['detail'],changes:Partial<Listing>={}):Listing {
  return {id:'ncaaf:46296',url:'https://v2.streameast.ga/cfb/away-vs-home/',league:'ncaaf',
    title:'Away vs Home',gameId:'ncaaf-123',matchReason:null,detail,...changes};
}

test('a failed current StreamEast detail can show the newest exact-game saved server rows',()=>{
  const current=listing(failed,{title:'Away vs Home Live'});
  const older=listing(collected(90));
  const newer=listing(collected(110,[{...server,id:'3',label:'Server 3',
    url:'https://v2.streameast.ga/cfb/away-vs-home/3'}]));
  assert.deepEqual(retainedStreameastDetail(current,[older,newer]),newer.detail);
});

test('a newer collected empty detail does not revive rows from an older scan',()=>{
  assert.deepEqual(retainedStreameastDetail(listing(failed),[
    listing(collected(90)),listing(collected(110,[])),
  ]),{kind:'collected',at:110,servers:[]});
});

test('a current collected detail is authoritative even when it is empty',()=>{
  assert.equal(retainedStreameastDetail(listing(collected(120,[])),[
    listing(collected(110)),
  ]),null);
});

test('saved rows require the same source event and ESPN game identity',()=>{
  const current=listing(failed);
  const changedListings=[
    {id:'ncaaf:99999'},
    {url:'https://v2.streameast.ga/cfb/other-game/'},
    {league:'nfl'},
    {gameId:'ncaaf-456'},
  ] satisfies Partial<Listing>[];
  for(const changed of changedListings)
    assert.equal(retainedStreameastDetail(current,[listing(collected(110),changed)]),null);
  assert.equal(retainedStreameastDetail(listing(failed,{gameId:null}),[
    listing(collected(110)),
  ]),null);
});

test('a pending current detail can use matching saved rows',()=>{
  assert.deepEqual(retainedStreameastDetail(listing({kind:'pending'}),[
    listing(collected(110)),
  ]),{kind:'collected',at:110,servers:[server]});
});
