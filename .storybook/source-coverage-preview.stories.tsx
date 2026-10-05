import type {Meta,StoryObj} from '@storybook/nextjs-vite';
import {expect,userEvent,within} from 'storybook/test';
import {SourceInventory} from '../components/source-inventory';
import {SourcesSnapshotSchema} from '../lib/football/shared';
import {productBoard,sourcesSnapshot} from './fixtures';
import {MockApi} from './story-runtime';

const at=Date.now();
const live=productBoard.games[2],upcoming=productBoard.games[3];
const waiting={kind:'missing',checkedAt:at-10_000,reason:'not-yet-published',retryAt:at+110_000};
const missing={kind:'missing',checkedAt:at-20_000,reason:'no-compatible-media',retryAt:at+100_000};
const link=(sourceId:string,game:typeof live,evidence:unknown)=>({sourceId,title:game.name,
  url:`https://example.invalid/${sourceId}/${game.id}`,gameId:game.id,observedAt:at-10_000,freshness:'fresh',evidence});
const liveLinks=[link('streameast',live,{kind:'collected',checkedAt:at-15_000,candidateIds:['direct']}),
  link('sportsurge-v2',live,{kind:'collected',checkedAt:at-15_000,candidateIds:['via-directory']}),
  link('vipbox-cfb',live,{kind:'collected',checkedAt:at-20_000,candidateIds:['timeout','pending']})];
const upcomingLinks=[link('tvapp',upcoming,waiting),link('vipbox-cfb',upcoming,missing)];
const source=(id:string,name:string,freeChoiceCount:number,workingChoiceCount:number)=>({
  ...sourcesSnapshot.sources[0],id,name,catalogUrl:`https://example.invalid/${id}`,publicUrls:[],
  freeChoiceCount,workingChoiceCount,compatibleFeedCount:workingChoiceCount,
  links:[...liveLinks,...upcomingLinks].filter(row=>row.sourceId===id),
  listingCount:id==='vipbox-cfb'?2:1,matchedGameCount:id==='vipbox-cfb'?2:1,
});
const snapshot=SourcesSnapshotSchema.parse({
  ...sourcesSnapshot,at,windowStartAt:at-30*60_000,
  sources:[source('streameast','StreamEast',1,1),source('sportsurge-v2','Sportsurge V2',1,1),
    {...source('vipbox-cfb','VIPBox CFB',2,0),collectionHealth:{kind:'attention',reason:'player-drop',
      baselineAt:at-240_000,baselineCount:4,currentAt:at-20_000,currentCount:0}},
    source('tvapp','TVApp',0,0),
    {...source('buffstream-cfb','Buffstream CFB',0,0),listingCount:0,matchedGameCount:0,links:[],
      lastAttempt:{at:at-25_000,outcome:'parser-changed'},collectionHealth:{kind:'attention',reason:'parser-changed',
        baselineAt:at-300_000,baselineCount:12,currentAt:at-25_000,currentCount:0}}],
  games:[{
    gameId:live.id,name:live.name,sourceCount:3,freeChoiceCount:4,workingChoiceCount:2,uniqueFeedCount:2,
    candidates:[
      {id:'direct',gameId:live.id,label:'StreamEast · Server 1',sourceIds:['streameast'],observedAt:at,
        availability:{kind:'playable',proof:'decoded',checkedAt:at-8_000}},
      {id:'via-directory',gameId:live.id,label:'Sportsurge V2 · StreamEast',sourceIds:['sportsurge-v2'],observedAt:at,
        availability:{kind:'playable',proof:'media',checkedAt:at-12_000}},
      {id:'timeout',gameId:live.id,label:'VIPBox · Server 1',sourceIds:['vipbox-cfb'],observedAt:at,
        availability:{kind:'unavailable',reason:'timeout',checkedAt:at-20_000,retryAt:at+100_000}},
      {id:'pending',gameId:live.id,label:'VIPBox · Server 2',sourceIds:['vipbox-cfb'],observedAt:at,
        availability:{kind:'checking',progress:{kind:'active',since:at-8_000}}},
    ],sharedRoutes:[{id:'route-one',candidateIds:['direct','via-directory'],sourceIds:['streameast','sportsurge-v2'],evidence:'same-published-server'}],
    sourceLinks:liveLinks,
  },{
    gameId:upcoming.id,name:upcoming.name,sourceCount:2,freeChoiceCount:0,workingChoiceCount:0,
    uniqueFeedCount:0,candidates:[],sharedRoutes:[],sourceLinks:upcomingLinks,
  }],
});

const meta={title:'Preview/Source coverage',component:SourceInventory,
  parameters:{layout:'fullscreen',docs:{story:{inline:false}}},
  decorators:[(Story)=><div style={{width:'min(960px, 100%)',padding:16,boxSizing:'border-box'}}><MockApi kind="sources" snapshot={snapshot}><Story/></MockApi></div>],
  args:{gameIds:[live.id],branding:{games:productBoard.games}},
} satisfies Meta<typeof SourceInventory>;
export default meta;
type Story=StoryObj<typeof meta>;

export const LiveGameEvidence:Story={play:async({canvasElement})=>{
  const canvas=within(canvasElement);
  await expect(await canvas.findByText('Collected free choices')).toBeVisible();
  await userEvent.click(canvas.getByRole('button',{name:'Games'}));
  await userEvent.click(canvas.getByText(live.name,{selector:'.source-inventory-game-list summary strong'}));
  await expect(canvas.getByText('3 listed sources · 4 free choices · 2 working')).toBeVisible();
  await expect(canvas.getByText(/Media check timed out/)).toBeVisible();
  await expect(canvas.getByText(/reach the same published server route/)).toBeVisible();
  await userEvent.click(canvas.getByText(upcoming.name,{selector:'.source-inventory-game-list summary strong'}));
  await expect(canvas.getByText(/Player not yet published/)).toBeVisible();
  await expect(canvas.getByText(/No supported free player found/)).toBeVisible();
}};

export const CollectionChanges:Story={play:async({canvasElement})=>{
  const canvas=within(canvasElement);
  await userEvent.selectOptions(await canvas.findByLabelText('Show'),'attention');
  await userEvent.click(canvas.getByText('VIPBox CFB'));
  await expect(canvas.getByText('A game page stopped publishing supported free players.')).toBeVisible();
  await userEvent.click(canvas.getByText('Buffstream CFB'));
  await expect(canvas.getByText('The source page format changed.')).toBeVisible();
}};
