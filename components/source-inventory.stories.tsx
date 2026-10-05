import { useLayoutEffect, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SourcesSnapshotSchema, type SourcesSnapshot } from '../lib/football/shared';
import { productBoard, sourcesSnapshot } from '../.storybook/fixtures';
import { MockApi } from '../.storybook/story-runtime';
import { SourceInventory } from './source-inventory';

const at=Date.now();
const link=(sourceId:string,title:string,gameId:string)=>({sourceId,title,gameId,url:`https://example.invalid/${sourceId}/${gameId}`,observedAt:at,freshness:'fresh' as const});
const mixedSnapshot=SourcesSnapshotSchema.parse({
  ...sourcesSnapshot,at,windowStartAt:at-60_000,browserCollectorsAvailable:true,
  sources:[
    {...sourcesSnapshot.sources[0],lastAttempt:{at:at-45_000,outcome:'parsed'},listingCount:2,matchedGameCount:2,compatibleFeedCount:1,freeChoiceCount:3,workingChoiceCount:1,
      links:[{title:'Packers at Bears',url:'https://example.invalid/sportsurge/401',gameId:'401',observedAt:at,freshness:'fresh'},
        {title:'Chiefs at Bills',url:'https://example.invalid/sportsurge/402',gameId:'402',observedAt:at,freshness:'fresh'}]},
    {id:'sportsurge-v2',name:'Sportsurge V2',catalogUrl:'https://example.invalid/v2',publicUrls:[],pending:false,
      collectionMode:'compatible-feed-discovery',lastAttempt:null,listingCount:2,matchedGameCount:1,staleListingCount:0,compatibleFeedCount:0,freeChoiceCount:1,workingChoiceCount:0,
      unmatchedListingCount:1,unmatchedReasons:[{reason:'ambiguous-matchup',count:1}],
      links:[{title:'Packers at Bears',url:'https://example.invalid/v2/401',gameId:'401',observedAt:at,freshness:'fresh'},
        {title:'Unclear matchup',url:'https://example.invalid/v2/unknown',gameId:null,observedAt:at,freshness:'fresh'}]},
    {id:'streameast',name:'Streameast',catalogUrl:'https://example.invalid/streams',publicUrls:['https://example.invalid/streams'],pending:false,
      collectionMode:'compatible-feed-discovery',lastAttempt:null,listingCount:1,matchedGameCount:1,staleListingCount:0,compatibleFeedCount:1,freeChoiceCount:1,workingChoiceCount:1,
      unmatchedListingCount:0,unmatchedReasons:[],links:[{title:'Packers at Bears',url:'https://example.invalid/streameast/401',gameId:'401',observedAt:at,freshness:'fresh'}]},
    {id:'tvapp',name:'TVApp',catalogUrl:'https://example.invalid/tvapp',publicUrls:['https://example.invalid/tvapp'],pending:false,
      collectionMode:'listings-only',lastAttempt:{at:at-60_000,outcome:'empty'},listingCount:0,matchedGameCount:0,staleListingCount:0,
      compatibleFeedCount:0,unmatchedListingCount:0,unmatchedReasons:[],links:[]},
    {...sourcesSnapshot.sources[0],id:'swac',name:'SWAC',catalogUrl:'https://example.invalid/swac',publicUrls:[],
      listingCount:1,matchedGameCount:1,freeChoiceCount:1,workingChoiceCount:0,
      links:[{title:'Georgia at Alabama',url:'https://example.invalid/swac/ncaaf-501',gameId:'ncaaf-501',observedAt:at,freshness:'fresh'}]},
  ],
  sportsurgeV2:{current:{runId:'00000000-0000-4000-8000-000000000001',startedAt:at-120_000,receivedAt:at-30_000,interrupted:false,
    state:{kind:'partial',at:at-30_000,reason:'timeout'},categories:{ncaaf:{kind:'failed',at:at-30_000,reason:'timeout'},nfl:{kind:'collected',at:at-35_000}},
    gameCount:1,collectedDetails:1,pendingDetails:0,failedDetails:0,providerRows:2,rejectedProviders:0,
    rejectedGames:[],catalogIssues:[],
    games:[{id:'nfl:401',title:'Packers at Bears',url:'https://example.invalid/v2/401',league:'nfl',gameId:'401',matchReason:null,sourceStatus:'live',
      detail:{kind:'collected',at:at-35_000,providers:[
        {id:'p1',label:'Custom player',observedAt:at-35_000,destination:{kind:'link'}},
        {id:'p2',label:'Second player',observedAt:at-35_000,destination:{kind:'link'}},
      ]}}]},lastComplete:null,previous:null},
  streameast:{current:{runId:'00000000-0000-4000-8000-000000000002',startedAt:at-90_000,receivedAt:at-20_000,interrupted:false,
    state:{kind:'complete',at:at-20_000},categories:{ncaaf:{kind:'collected',at:at-25_000},nfl:{kind:'collected',at:at-20_000}},
    gameCount:1,collectedDetails:1,pendingDetails:0,failedDetails:0,serverRows:1,freeRows:1,premiumRows:0,unknownRows:0,unsupportedFreeRows:0,
    matchedCompatibleChannels:1,rejectedGames:[],games:[{id:'nfl:401',title:'Packers at Bears',url:'https://example.invalid/streameast/401',league:'nfl',gameId:'401',matchReason:null,
      detail:{kind:'collected',at:at-20_000,servers:[{id:'42',label:'Channel 42',url:'https://example.invalid/streameast/401/42',availability:{kind:'free-channel',channelId:'42'}}]}}]},
    lastComplete:null,previous:null},
  games:[
    {gameId:'401',name:'Green Bay Packers at Chicago Bears',sourceCount:3,uniqueFeedCount:2,freeChoiceCount:3,workingChoiceCount:2,
      candidates:[
        {id:'media',gameId:'401',label:'Media candidate',sourceIds:['sportsurge'],observedAt:at,availability:{kind:'playable',checkedAt:at-15_000,proof:'media'}},
        {id:'decoded',gameId:'401',label:'Decoded candidate',sourceIds:['streameast'],observedAt:at,availability:{kind:'playable',checkedAt:at-12_000,proof:'decoded'}},
        {id:'checking',gameId:'401',label:'Checking candidate',sourceIds:['sportsurge-v2'],observedAt:at,availability:{kind:'checking',progress:{kind:'deferred',since:at-2_000,retryAt:at+28_000}}},
      ],sourceLinks:[link('sportsurge','Packers at Bears','401'),link('sportsurge-v2','Packers at Bears','401'),link('streameast','Packers at Bears','401')]},
    {gameId:'402',name:'Kansas City Chiefs at Buffalo Bills',sourceCount:1,uniqueFeedCount:0,freeChoiceCount:2,workingChoiceCount:0,
      candidates:[{id:'unavailable',gameId:'402',label:'Unavailable candidate',sourceIds:['sportsurge'],observedAt:at,
        availability:{kind:'unavailable',checkedAt:at-20_000,retryAt:at+60_000,reason:'timeout'}},
        {id:'unknown',gameId:'402',label:'Unknown candidate',sourceIds:['sportsurge'],observedAt:at,availability:{kind:'unknown'}}],
      sourceLinks:[link('sportsurge','Chiefs at Bills','402')]},
    {gameId:'ncaaf-501',name:'Georgia Bulldogs at Alabama Crimson Tide',sourceCount:1,uniqueFeedCount:0,freeChoiceCount:1,workingChoiceCount:0,
      candidates:[{id:'college',gameId:'ncaaf-501',label:'College feed',sourceIds:['swac'],observedAt:at,availability:{kind:'unknown'}}],
      sourceLinks:[link('swac','Georgia at Alabama','ncaaf-501')]},
  ],
});
const emptySnapshot:SourcesSnapshot={...sourcesSnapshot,at,sources:[],games:[],sportsurgeV2:{current:null,lastComplete:null,previous:null},
  streameast:{current:null,lastComplete:null,previous:null}};
const unavailableSnapshot:SourcesSnapshot={...mixedSnapshot,browserCollectorsAvailable:false,sportsurgeV2:{current:null,lastComplete:null,previous:null},
  streameast:{current:null,lastComplete:null,previous:null}};
const sportsurgeRun=mixedSnapshot.sportsurgeV2.current;
if(!sportsurgeRun)throw new Error('Story requires a Sportsurge run');
const partialSnapshot=SourcesSnapshotSchema.parse({...mixedSnapshot,sportsurgeV2:{...mixedSnapshot.sportsurgeV2,current:{...sportsurgeRun,
  gameCount:2,failedDetails:1,games:[...sportsurgeRun.games,{...sportsurgeRun.games[0],id:'nfl:402',url:'https://example.invalid/v2/402',
    detail:{kind:'failed',at:at-10_000,reason:'timeout'}}]}}});
const pendingSnapshot=SourcesSnapshotSchema.parse({...mixedSnapshot,sportsurgeV2:{...mixedSnapshot.sportsurgeV2,current:{...sportsurgeRun,
  state:{kind:'collecting'},categories:{ncaaf:{kind:'collected',at:at-30_000},nfl:{kind:'collected',at:at-35_000}},
  gameCount:2,pendingDetails:1,games:[...sportsurgeRun.games,{...sportsurgeRun.games[0],id:'nfl:402',url:'https://example.invalid/v2/402',
    detail:{kind:'pending'}}]}}});

function MockFailure({children,loading}:{children:ReactNode;loading:boolean}) {
  useLayoutEffect(()=>{
    const original=window.fetch;
    window.fetch=(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url==='/api/sources')return loading?new Promise<Response>(()=>{}):Promise.resolve(new Response(null,{status:503}));
      return original(input,init);
    };
    return()=>{window.fetch=original;};
  },[loading]);
  return children;
}

const meta={
  title:'Product components/Source inventory',component:SourceInventory,
  parameters:{docs:{story:{inline:false}}},
  decorators:[(Story)=><div style={{width:'min(920px, 92vw)'}}><Story/></div>],
} satisfies Meta<typeof SourceInventory>;
export default meta;
type Story=StoryObj<typeof meta>;

export const MixedSources:Story={args:{gameIds:['401','ncaaf-501'],branding:{games:productBoard.games}},decorators:[(Story)=><MockApi kind="sources" snapshot={mixedSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await expect(await canvas.findByRole('tab',{name:'NFL'})).toHaveAttribute('aria-selected','true');
    await expect(canvas.queryByText('SWAC')).not.toBeInTheDocument();
    await expect(canvas.getByText('2 matched games \u00b7 1 available feeds')).toBeVisible();
    await userEvent.selectOptions(await canvas.findByLabelText('Show'),'attention');
    await expect(canvas.queryByText('Sportsurge V2')).not.toBeInTheDocument();
    await expect(canvas.queryByText('Streameast')).not.toBeInTheDocument();
    canvas.getByRole('tab',{name:'NFL'}).focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('tab',{name:'NCAA CFB'})).toHaveAttribute('aria-selected','true');
    await expect(canvas.getByText('Sportsurge V2')).toBeVisible();
    await expect(canvas.getByText('0 matched games \u00b7 0 available feeds \u00b7 1 unclassified links')).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText('Show'),'all');
    await expect(canvas.getByText('SWAC')).toBeVisible();
    await userEvent.click(canvas.getByRole('button',{name:'Games'}));
    await expect(canvas.getByText('Georgia Bulldogs at Alabama Crimson Tide')).toBeVisible();
    await userEvent.type(canvas.getByRole('searchbox',{name:'Find a listed game'}),'Georgia');
    await userEvent.click(canvas.getByRole('tab',{name:'NFL'}));
    await expect(canvas.getByRole('searchbox',{name:'Find a listed game'})).toHaveValue('');
    await userEvent.click(canvas.getByText('Green Bay Packers at Chicago Bears'));
    await expect(canvas.getByText(/Media checked/)).toBeVisible();
    await expect(canvas.getByText(/Playback decoded/)).toBeVisible();
    await userEvent.click(canvas.getByRole('tab',{name:'NCAA CFB'}));
    await expect(canvas.getByRole('searchbox',{name:'Find a listed game'})).toHaveValue('Georgia');
  }};
export const WithListings:Story={args:{gameIds:['401'],branding:{games:productBoard.games}},decorators:[(Story)=><MockApi kind="sources" snapshot={sourcesSnapshot}><Story/></MockApi>]};
export const SameLeaguePartial:Story={args:{gameIds:['401'],branding:{games:productBoard.games}},
  decorators:[(Story)=><MockApi kind="sources" snapshot={partialSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await userEvent.selectOptions(await canvas.findByLabelText('Show'),'attention');
    await expect(canvas.getByText('Sportsurge V2')).toBeVisible();
    await expect(canvas.getByText('Partial collection')).toBeVisible();
  }};
export const SameLeaguePending:Story={args:{gameIds:['401'],branding:{games:productBoard.games}},
  decorators:[(Story)=><MockApi kind="sources" snapshot={pendingSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await expect(await canvas.findByText('Collecting')).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText('Show'),'attention');
    await expect(canvas.queryByText('Sportsurge V2')).not.toBeInTheDocument();
  }};
export const WithoutSelectedGames:Story={args:{gameIds:[],branding:{games:productBoard.games}},decorators:[(Story)=><MockApi kind="sources" snapshot={sourcesSnapshot}><Story/></MockApi>]};
export const UnclassifiedGames:Story={args:{gameIds:[],branding:{games:productBoard.games.map(game=>({...game,
  league:game.id==='401'?undefined:game.league}))}},decorators:[(Story)=><MockApi kind="sources" snapshot={sourcesSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await expect(await canvas.findByText(/1 game could not be assigned to a league/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button',{name:'Games'}));
    await userEvent.click(canvas.getByText(/Games awaiting league classification/));
    await expect(canvas.getByText('Green Bay Packers at Chicago Bears')).toBeVisible();
  }};
export const Empty:Story={args:{gameIds:[]},decorators:[(Story)=><MockApi kind="sources" snapshot={emptySnapshot}><Story/></MockApi>]};
export const CollectorsUnavailable:Story={args:{gameIds:['401'],branding:{games:productBoard.games}},decorators:[(Story)=><MockApi kind="sources" snapshot={unavailableSnapshot}><Story/></MockApi>]};
export const Loading:Story={args:{gameIds:[]},decorators:[(Story)=><MockFailure loading><Story/></MockFailure>]};
export const ErrorState:Story={args:{gameIds:[]},decorators:[(Story)=><MockFailure loading={false}><Story/></MockFailure>]};
