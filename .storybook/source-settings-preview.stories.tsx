import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SourcesSnapshotSchema, type SourcesSnapshot } from '../lib/football/shared';
import { productBoard, sourcesSnapshot } from './fixtures';
import { MockApi } from './story-runtime';
import { SourceInventory } from '../components/source-inventory';

const at=Date.now();
const sportsurgeComplete:NonNullable<SourcesSnapshot['sportsurgeV2']['current']>={
  runId:'00000000-0000-4000-8000-000000000011',startedAt:at-5_400_000,receivedAt:at-5_100_000,
  interrupted:false,state:{kind:'complete',at:at-5_100_000},categories:{ncaaf:{kind:'collected',at:at-5_200_000},nfl:{kind:'collected',at:at-5_100_000}},
  gameCount:4,collectedDetails:4,pendingDetails:0,failedDetails:0,providerRows:6,rejectedProviders:1,
  rejectedGames:[],catalogIssues:[],games:[],
};
const sportsurgeCurrent:NonNullable<SourcesSnapshot['sportsurgeV2']['current']>={
  ...sportsurgeComplete,runId:'00000000-0000-4000-8000-000000000012',startedAt:at-120_000,receivedAt:at-30_000,
  state:{kind:'partial',at:at-30_000,reason:'timeout'},
  categories:{ncaaf:{kind:'failed',at:at-30_000,reason:'timeout'},nfl:{kind:'collected',at:at-45_000}},
  gameCount:2,collectedDetails:1,pendingDetails:1,providerRows:2,rejectedProviders:0,
};
const streameastComplete:NonNullable<SourcesSnapshot['streameast']['current']>={
  runId:'00000000-0000-4000-8000-000000000021',startedAt:at-90_000,receivedAt:at-20_000,
  interrupted:false,state:{kind:'complete',at:at-20_000},
  categories:{ncaaf:{kind:'collected',at:at-25_000},nfl:{kind:'collected',at:at-20_000}},
  gameCount:2,collectedDetails:2,pendingDetails:0,failedDetails:0,serverRows:3,freeRows:2,premiumRows:1,
  unknownRows:0,unsupportedFreeRows:0,matchedCompatibleChannels:1,rejectedGames:[],games:[],
};

const mixedSnapshot=SourcesSnapshotSchema.parse({
  ...sourcesSnapshot,at,windowStartAt:at-60_000,browserCollectorsAvailable:true,
  sources:[
    {...sourcesSnapshot.sources[0],lastAttempt:{at:at-45_000,outcome:'parsed'},listingCount:2,matchedGameCount:1,compatibleFeedCount:1},
    {id:'sportsurge-v2',name:'Sportsurge V2',catalogUrl:'https://example.invalid/v2',publicUrls:[],pending:false,
      collectionMode:'compatible-feed-discovery',lastAttempt:null,listingCount:2,matchedGameCount:1,staleListingCount:0,
      compatibleFeedCount:0,unmatchedListingCount:0,unmatchedReasons:[],links:[]},
    {id:'streameast',name:'Streameast',catalogUrl:'https://example.invalid/streams',publicUrls:['https://example.invalid/streams'],pending:false,
      collectionMode:'compatible-feed-discovery',lastAttempt:null,listingCount:2,matchedGameCount:1,staleListingCount:0,
      compatibleFeedCount:0,unmatchedListingCount:0,unmatchedReasons:[],links:[]},
    {id:'tvapp',name:'TVApp',catalogUrl:'https://example.invalid/tvapp',publicUrls:['https://example.invalid/tvapp'],pending:false,
      collectionMode:'listings-only',lastAttempt:{at:at-60_000,outcome:'empty'},listingCount:0,matchedGameCount:0,
      staleListingCount:0,compatibleFeedCount:0,unmatchedListingCount:0,unmatchedReasons:[],links:[]},
  ],
  sportsurgeV2:{current:sportsurgeCurrent,lastComplete:sportsurgeComplete,previous:null},
  streameast:{current:streameastComplete,lastComplete:streameastComplete,previous:null},
});
const unavailableSnapshot:SourcesSnapshot={...mixedSnapshot,browserCollectorsAvailable:false};
const rateLimitedSnapshot:SourcesSnapshot={...mixedSnapshot,streameast:{...mixedSnapshot.streameast,
  current:{...streameastComplete,state:{kind:'partial',at,reason:'rate-limited'},
    collectedDetails:1,pendingDetails:1,serverRows:1,freeRows:1}},
};
const fixtureGame=productBoard.games[0];
if(!fixtureGame||!('home' in fixtureGame))throw new Error('Matchup fixture is missing');
const logoGame={id:fixtureGame.id,away:{...fixtureGame.away,logo:'/packers.png'},home:{...fixtureGame.home,logo:'/bears.png'}};
const missingLogoGame={id:fixtureGame.id,away:{...fixtureGame.away,logo:'/missing-team-logo.png'},home:{...fixtureGame.home,logo:undefined}};

const meta={
  title:'Preview/Source settings',component:SourceInventory,
  parameters:{docs:{story:{inline:false}}},
  decorators:[(Story)=><div style={{width:'min(920px, 92vw)'}}><Story/></div>],
} satisfies Meta<typeof SourceInventory>;
export default meta;
type Story=StoryObj<typeof meta>;

export const RateLimitedCollector:Story={
  args:{gameIds:[]},
  decorators:[(Story)=><MockApi kind="sources" snapshot={rateLimitedSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await userEvent.click(await canvas.findByText('Streameast',{selector:'summary strong'}));
    await expect(canvas.getByText(/Partial \(Rate limited; collection paused\)/)).toBeVisible();
  },
};

export const MixedStatuses:Story={
  args:{gameIds:['401']},
  decorators:[(Story)=><MockApi kind="sources" snapshot={mixedSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await expect(await canvas.findByText('Fetched')).toBeVisible();
    await expect(canvas.getByText('Collection complete')).toBeVisible();
    const sportsurge=canvas.getByText('Sportsurge V2').closest('details');
    if(!sportsurge)throw new Error('Sportsurge V2 card is missing');
    await userEvent.click(within(sportsurge).getByText('Sportsurge V2'));
    await expect(within(sportsurge).getByText('Latest recorded collection')).toBeVisible();
    await expect(within(sportsurge).getByText('Last complete collection')).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText('Show'),'attention');
    await expect(canvas.getByText('Sportsurge V2')).toBeVisible();
    await expect(canvas.queryByText('Streameast')).not.toBeInTheDocument();
  },
};

export const CollectorsUnavailable:Story={
  args:{gameIds:['401']},
  decorators:[(Story)=><MockApi kind="sources" snapshot={unavailableSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await expect(await canvas.findByText('Fetched')).toBeVisible();
    const sportsurge=canvas.getByText('Sportsurge V2').closest('details');
    if(!sportsurge)throw new Error('Sportsurge V2 card is missing');
    await userEvent.click(within(sportsurge).getByText('Sportsurge V2'));
    const unavailable=within(sportsurge).getByRole('note');
    await expect(within(unavailable).getByText('Browser collector unavailable')).toBeVisible();
    await expect(within(unavailable).getByText(/Saved scans below show earlier collection/)).toBeVisible();
    await expect(within(sportsurge).getByText('Latest recorded collection')).toBeVisible();
    await expect(within(sportsurge).getByText('Last complete collection')).toBeVisible();
    await userEvent.click(within(sportsurge).getByText('View saved scan details'));
    await expect(within(sportsurge).getByText(/6 provider rows/)).toBeVisible();
  },
};

export const LogoTitles:Story={
  args:{gameIds:['401'],branding:{games:[logoGame]}},
  decorators:[(Story)=><MockApi kind="sources" snapshot={mixedSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    const sportsurge=await canvas.findByText('Sportsurge');
    const sourceCard=sportsurge.closest('details');
    if(!sourceCard)throw new Error('Sportsurge source card is missing');
    await waitFor(()=>{
      const icon=sourceCard.querySelector('img');
      if(!icon||!icon.complete||icon.naturalWidth===0)throw new Error('Sportsurge site logo did not load');
    },{timeout:5000});
    await expect(canvas.getByText('Streameast')).toBeVisible();
    await userEvent.click(canvas.getByRole('button',{name:'Games'}));
    const gameTitle=await canvas.findByText('Green Bay Packers at Chicago Bears');
    const gameCard=gameTitle.closest('details');
    if(!gameCard)throw new Error('Game card is missing');
    await waitFor(()=>{
      const logos=[...gameCard.querySelectorAll<HTMLImageElement>('summary img')];
      if(logos.length!==2||logos.some(logo=>!logo.complete||logo.naturalWidth===0))
        throw new Error('Both team logos must load beside the game title');
    },{timeout:5000});
    await expect(gameTitle).toBeVisible();
  },
};

export const MissingLogoFallback:Story={
  args:{gameIds:['401'],branding:{games:[missingLogoGame]}},
  decorators:[(Story)=><MockApi kind="sources" snapshot={mixedSnapshot}><Story/></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    const sportsurgeV2=await canvas.findByText('Sportsurge V2');
    const sourceCard=sportsurgeV2.closest('details');
    if(!sourceCard)throw new Error('Sportsurge V2 source card is missing');
    await expect(within(sourceCard).getByText('S')).toBeVisible();
    await userEvent.click(canvas.getByRole('button',{name:'Games'}));
    const gameTitle=await canvas.findByText('Green Bay Packers at Chicago Bears');
    const gameCard=gameTitle.closest('details');
    if(!gameCard)throw new Error('Game card is missing');
    await waitFor(()=>{
      if(gameCard.querySelector('summary img'))throw new Error('Broken team image is still visible');
    });
    await expect(within(gameCard).getByText('GB')).toBeVisible();
    await expect(within(gameCard).getByText('CHI')).toBeVisible();
    await expect(gameTitle).toBeVisible();
  },
};
