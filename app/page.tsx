'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, Check, ChevronRight, Columns2, Flame, GripVertical, Grid2X2, Headphones, LayoutPanelLeft, Maximize, Minimize, Monitor, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Star, Tv, Volume2, X, Zap } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BrowserProviderPlayer } from '@/components/browser-provider-player';
import { GameTiming } from '@/components/game-timing';
import { SourceInventory } from '@/components/source-inventory';
import { FinishedGameRetentionSetting } from '@/components/finished-game-retention-setting';
import { FeedCheckIntervalSetting } from '@/components/feed-check-interval-setting';
import { UpdatePanel } from '@/components/update-panel';
import { UpdatePopup } from '@/components/update-popup';
import { ServerControls } from '@/components/server-controls';
import { BoardSchema, DEFAULT_FEED_CHECK_INTERVAL_MINUTES, DEFAULT_FINISHED_GAME_RETENTION_MINUTES, SourcesSnapshotSchema, type SourcesSnapshot } from '@/lib/football/shared';
import { parseQualityPreference, qualityPreferences, type QualityPreference } from '@/lib/playback-quality';
import { addToSlots, emptySlots, placeInSlot, reconcileSlots, removeFromSlots, restoreSlots, selectedGames, slotsFromIds, type RoomSlots } from '@/lib/multiview';
import { Board, Feed, Game, LEAGUES, Team, isBasketballLeague, priority, sortGamesForDisplay, validFeedUrl, validGameId } from '@/lib/sunday';

type Layout = 'quad' | 'focus' | 'duo' | 'single';
type RoomPlayback = { defaultPlaying: boolean; overrides: Record<string, boolean> };
const effectivePlaying = (state: RoomPlayback, id: string) => state.overrides[id] ?? state.defaultPlaying;
const STORAGE = 'sunday-room:v1';
const EMPTY_GAMES: Game[] = [];
const layouts: { id: Layout; label: string; icon: typeof Grid2X2 }[] = [{ id:'quad', label:'Four games', icon:Grid2X2 }, { id:'focus', label:'Focus view', icon:LayoutPanelLeft }, { id:'duo', label:'Two games', icon:Columns2 }, { id:'single', label:'Single game', icon:Monitor }];
function Badge({ team, large = false }: { team: Team; large?: boolean }) { const [failed,setFailed]=useState(false); return <span className={`team-badge ${large?'large':''}`} style={{'--team':`#${team.color}`} as React.CSSProperties}>{team.logo&&!failed ? <Image src={team.logo} alt="" width={large?56:32} height={large?56:32} unoptimized onError={()=>setFailed(true)}/> : team.abbreviation}</span>; }
function GameStatus({ game }: { game: Game }) { return game.detail==='Scheduled' ? null : <span className={`game-status ${game.status}`}><i/>{game.detail}</span>; }
function score(team: Team, game: Game, hide: boolean) { return hide ? '—' : game.status==='pre' ? '—' : team.score ?? '—'; }

export default function Home() {
 const [board,setBoard]=useState<Board|null>(null),[fetchError,setFetchError]=useState(''),[loading,setLoading]=useState(true);
 const [displayNow,setDisplayNow]=useState(0);
 const [sources,setSources]=useState<SourcesSnapshot|null>(null);
 const [slots,setSlots]=useState<RoomSlots>(emptySlots),[favorites,setFavorites]=useState<string[]>([]),[feeds,setFeeds]=useState<Record<string,Feed>>({});
 const [desktop,setDesktop]=useState(false),[providerChoices,setProviderChoices]=useState<Partial<Record<string,true>>>({});
 const [initialCandidateIds,setInitialCandidateIds]=useState<Record<string,string>>({});
 const [layout,setLayout]=useState<Layout>('quad'),[focus,setFocus]=useState(''),[audio,setAudio]=useState(''),[muted,setMuted]=useState(false),[volume,setVolume]=useState(70),[defaultQuality,setDefaultQuality]=useState<QualityPreference>('auto'),[playback,setPlayback]=useState<RoomPlayback>({defaultPlaying:true,overrides:{}});
 const [filter,setFilter]=useState('all'),[leagueFilter,setLeagueFilter]=useState<'all'|'nfl'|'ncaaf'|'basketball'>('all'),[search,setSearch]=useState(''),[view,setView]=useState('room'),[theater,setTheater]=useState(false),[fullscreen,setFullscreen]=useState(false),[auto,setAuto]=useState(false),[spoilers,setSpoilers]=useState(false),[showGameDayHeader,setShowGameDayHeader]=useState(false);
 const [modal,setModal]=useState<'feed'|'help'|'settings'|null>(null),[feedGame,setFeedGame]=useState(''),[feedUrl,setFeedUrl]=useState(''),[feedLabel,setFeedLabel]=useState(''),[formError,setFormError]=useState(''),[notice,setNotice]=useState(''),[ready,setReady]=useState(false);
 const [dragOverSlot,setDragOverSlot]=useState<number|null>(null),[dragOverCenter,setDragOverCenter]=useState(false);
 const dragging=useRef<{kind:'center'|'tile';id:string}|null>(null);
 const initialized=useRef(false),refreshing=useRef(false),room=useRef<HTMLDivElement>(null),lastAuto=useRef(0),lastSourceRefresh=useRef(-1);
 const retentionGeneration=useRef(0);
 const games=board?.games??EMPTY_GAMES;
 const scheduleLoading=board?.scheduleState!=='ready';
 const selected=useMemo(()=>selectedGames(slots),[slots]);
 const chosen=selected.map(id=>games.find(g=>g.id===id)).filter(Boolean) as Game[];
 const candidatesByGame=useMemo(()=>new Map(sources?.games.map(game=>[game.gameId,game.candidates])||[]),[sources]);
 const sourcesCollecting=sources?.sportsurgeV2.current?.state.kind==='collecting'||sources?.streameast.current?.state.kind==='collecting';
 const checkingServers=(gameId:string)=>candidatesByGame.get(gameId)?.some(candidate=>candidate.availability.kind==='unknown'||candidate.availability.kind==='checking');
 const canPlay=useCallback((game:Game)=>(game.lifecycle==='final'?
  game.graceEndsAt!==undefined&&displayNow<game.graceEndsAt:game.status!=='post')&&
  (!!game.sourceUrl||!!candidatesByGame.get(game.id)?.some(candidate=>candidate.availability.kind==='playable')),[candidatesByGame,displayNow]);
 const providerGames=chosen.filter(g=>!feeds[g.id]&&(providerChoices[g.id]??canPlay(g))).map(g=>g.id);
 const discovery=games.filter(g=>leagueFilter==='all'||(leagueFilter==='basketball'?isBasketballLeague(g.league):g.league===leagueFilter));
 const headerGames=sortGamesForDisplay(discovery,displayNow);
 const centerGames=discovery.filter(g=>g.lifecycle==='final'||g.status==='post'?
  g.graceEndsAt!==undefined&&displayNow<g.graceEndsAt:true);
 const leagueLabel=leagueFilter==='all'?'GAMES':leagueFilter==='basketball'?'BASKETBALL':LEAGUES[leagueFilter].label;
 const week=leagueFilter==='all'||leagueFilter==='basketball'?undefined:board?.leagues[leagueFilter].week;
 const errors=board ? Object.values(board.leagues).flatMap(status=>status.errors) : [];
 const ordered=[...chosen].sort((a,b)=>a.id===focus?-1:b.id===focus?1:0);
 const visible=layout==='single'?ordered.slice(0,1):layout==='duo'?ordered.slice(0,2):layout==='focus'?ordered:chosen;
 const capacity=layout==='single'?1:layout==='duo'?2:4;
 const gridCells=layout==='quad'?slots.map((id,index)=>({g:games.find(game=>game.id===id),index,slotIndex:index})):[...visible.map((g,index)=>({g,index,slotIndex:slots.indexOf(g.id)})),...slots.flatMap((id,slotIndex)=>id===null?[{g:undefined,index:0,slotIndex}]:[])].slice(0,capacity).map((cell,index)=>({...cell,index}));
 const live=discovery.filter(g=>g.status==='in'),hot=live.filter(g=>g.redzone);
 const filteredGames=centerGames.filter(g=>(filter==='all'||filter==='live'&&g.status==='in'||filter==='redzone'&&g.redzone||filter==='favorites'&&favorites.includes(g.id))&&`${g.name} ${g.home.abbreviation} ${g.away.abbreviation}`.toLowerCase().includes(search.toLowerCase()));
 const filtered=filter==='live'||filter==='redzone'?filteredGames.sort((a,b)=>priority(b)-priority(a)):sortGamesForDisplay(filteredGames,displayNow);
 const stale=!!fetchError||!scheduleLoading&&!!errors.length;
 useEffect(()=>{
  const controller=new AbortController();
  const startupAt=Date.now();
  let timer:ReturnType<typeof setTimeout>;
  const refreshSources=async()=>{
   let nextDelay=30000;
   try{
    const response=await fetch('/api/sources',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw new Error('Source inventory unavailable');
    const snapshot=SourcesSnapshotSchema.parse(await response.json());
    if(!controller.signal.aborted)setSources(snapshot);
    if(Date.now()-startupAt<90_000||snapshot.sources.some(source=>source.links.some(link=>link.evidence.kind==='pending'))||
      snapshot.sportsurgeV2.current?.state.kind==='collecting'||snapshot.streameast.current?.state.kind==='collecting'||
      snapshot.games.some(row=>row.candidates.some(candidate=>candidate.availability.kind==='unknown'||candidate.availability.kind==='checking')))nextDelay=3000;
   }catch{nextDelay=5000;}
   finally{if(!controller.signal.aborted)timer=setTimeout(()=>void refreshSources(),nextDelay);}
  };
  void refreshSources();
  return()=>{controller.abort();clearTimeout(timer);};
 },[]);
 useEffect(()=>{const timer=window.setTimeout(()=>setDesktop(!!window.sundayDesktop),0);return()=>window.clearTimeout(timer);},[]);
 useEffect(()=>{
  if(!ready||!selected.length)return;
  const controller=new AbortController();
  const prioritize=async()=>{
   try{
    const response=await fetch('/api/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'check-sources',gameIds:selected,retry:false}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    await response.body?.cancel();
   }catch{}
  };
  void prioritize();
  const timer=setInterval(()=>void prioritize(),30000);
  return()=>{controller.abort();clearInterval(timer);};
 },[ready,selected]);
 const toast=useCallback((message:string)=>setNotice(message),[]);
 useEffect(()=>{ if(notice){const timer=setTimeout(()=>setNotice(''),4500);return ()=>clearTimeout(timer);} },[notice]);
 useEffect(()=>{const timer=window.setTimeout(()=>{
  try { const p:unknown=JSON.parse(localStorage.getItem(STORAGE)||'null'); if(p&&typeof p==='object'){
    if('slots' in p||'selected' in p){setSlots(restoreSlots('slots' in p?p.slots:undefined,'selected' in p?p.selected:undefined,validGameId));initialized.current=true;}
   if('favorites' in p&&Array.isArray(p.favorites))setFavorites(p.favorites.filter(validGameId));
   const savedLayout='layout' in p?layouts.find(l=>l.id===p.layout):undefined;
   if(savedLayout)setLayout(savedLayout.id);
   if('volume' in p&&typeof p.volume==='number')setVolume(Math.min(100,Math.max(0,p.volume)));
   setSpoilers('spoilers' in p&&p.spoilers===true);
   setShowGameDayHeader('showGameDayHeader' in p&&typeof p.showGameDayHeader==='boolean'?p.showGameDayHeader:false);
   setDefaultQuality(parseQualityPreference('defaultQuality' in p?p.defaultQuality:undefined));
   if('feeds' in p&&p.feeds&&typeof p.feeds==='object'){
    const savedFeeds:[string,Feed][]=[];
    for(const [id,value] of Object.entries(p.feeds)){
     if(!value||typeof value!=='object'||!('url' in value)||typeof value.url!=='string'||!validFeedUrl(value.url))continue;
     savedFeeds.push([id,{url:value.url,label:'label' in value&&typeof value.label==='string'?value.label:'My feed'}]);
    }
    setFeeds(Object.fromEntries(savedFeeds));
   }
  } }catch{} setReady(true);
 },0);return()=>window.clearTimeout(timer);},[]);
  useEffect(()=>{ if(!ready)return;try{localStorage.setItem(STORAGE,JSON.stringify({slots,selected,favorites,feeds,layout,volume,spoilers,showGameDayHeader,defaultQuality}));}catch{queueMicrotask(()=>toast('Device storage is unavailable. Your room will last for this session.'));} },[ready,slots,selected,favorites,feeds,layout,volume,spoilers,showGameDayHeader,defaultQuality,toast]);
 const refresh=useCallback(async()=>{ if(refreshing.current)return;const generation=retentionGeneration.current;refreshing.current=true;setLoading(true);try{const r=await fetch('/api/games',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error();const b:Board=await r.json();if(!Array.isArray(b.games))throw new Error();if(generation===retentionGeneration.current){setBoard(b);setFetchError('');}}catch{setFetchError('Could not refresh game data. Retrying automatically.');}finally{setDisplayNow(Date.now());refreshing.current=false;setLoading(false);}},[]);
 const saveFinishedRetention=async(minutes:number)=>{
  retentionGeneration.current++;
  const response=await fetch('/api/games',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({kind:'set-retention',minutes}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not save the retention time. Try again.');
  const parsed=BoardSchema.safeParse(await response.json());
  if(!parsed.success)throw new Error('Could not confirm the saved retention time. Try again.');
  retentionGeneration.current++;
  setBoard(parsed.data);setDisplayNow(Date.now());
 };
 const saveFeedCheckInterval=async(minutes:number)=>{
  retentionGeneration.current++;
  const response=await fetch('/api/games',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({kind:'set-feed-check-interval',minutes}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not save the feed check interval. Try again.');
  const parsed=BoardSchema.safeParse(await response.json());
  if(!parsed.success)throw new Error('Could not confirm the saved feed check interval. Try again.');
  retentionGeneration.current++;
  setBoard(parsed.data);setDisplayNow(Date.now());
 };
 useEffect(()=>{
  if(!sources||lastSourceRefresh.current===sources.revision||refreshing.current)return;
  if(!sources.games.some(row=>selected.includes(row.gameId)&&row.candidates.some(candidate=>candidate.availability.kind==='playable')&&!board?.games.find(game=>game.id===row.gameId)?.sourceUrl))return;
  lastSourceRefresh.current=sources.revision;
  const timer=window.setTimeout(()=>void refresh(),0);
  return()=>window.clearTimeout(timer);
 },[sources,board,selected,refresh]);
 useEffect(()=>{const first=window.setTimeout(()=>void refresh(),0);const timer=setInterval(()=>{if(!document.hidden)void refresh();},scheduleLoading?3000:30000);return()=>{window.clearTimeout(first);clearInterval(timer);};},[refresh,scheduleLoading]);
  useEffect(()=>{ if(!ready||scheduleLoading||!games.length||initialized.current)return;initialized.current=true;const timer=window.setTimeout(()=>setSlots(prev=>selectedGames(prev).length?prev:slotsFromIds([...games].sort((a,b)=>priority(b)-priority(a)).slice(0,4).map(g=>g.id))),0);return()=>window.clearTimeout(timer); },[games,ready,scheduleLoading]);
 useEffect(()=>{
  if(!board||!ready)return;
  const timer=window.setTimeout(()=>{
  const url=new URL(window.location.href),requested=url.searchParams.get('game');
  if(!requested)return;
   const id=board.aliases[requested]||requested;
   if(board.games.some(game=>game.id===id)){
    const displaced=selected.length===4&&!slots.includes(id)?slots[0]:null;
    if(displaced){setPlayback(state=>{const overrides={...state.overrides};delete overrides[displaced];return {...state,overrides};});setProviderChoices(state=>{const next={...state};delete next[displaced];return next;});setInitialCandidateIds(state=>{const next={...state};delete next[displaced];return next;});if(audio===displaced)setAudio(id);}
    setSlots(current=>{const added=addToSlots(current,id);return added===current?placeInSlot(current,id,0):added;});
   setFocus(id);setView('room');
   url.searchParams.delete('game');window.history.replaceState(null,'',url);
  }
  },0);
  return()=>window.clearTimeout(timer);
  },[board,ready,selected,slots,audio]);
 useEffect(()=>{
  if(!board||!ready||scheduleLoading)return;
  const timer=window.setTimeout(()=>{
  const canonical=(id:string)=>board.aliases[id]||id;
  const remap=(ids:string[])=>[...new Set(ids.map(canonical))];
   setSlots(current=>reconcileSlots({slots:current,board}));
  setFavorites(current=>{const next=remap(current);return next.length===current.length&&next.every((id,index)=>id===current[index])?current:next;});
  setFeeds(current=>{const next={...current};for(const [id,feed] of Object.entries(current)){const resolved=canonical(id);if(resolved!==id){if(!next[resolved])next[resolved]=feed;delete next[id];}}return Object.keys(next).length===Object.keys(current).length&&Object.keys(next).every(id=>next[id]===current[id])?current:next;});
  setProviderChoices(current=>{const next={...current};for(const id of Object.keys(current)){const resolved=canonical(id);if(resolved!==id){if(!next[resolved])next[resolved]=true;delete next[id];}}return Object.keys(next).length===Object.keys(current).length&&Object.keys(next).every(id=>next[id]===current[id])?current:next;});
  },0);
  return()=>window.clearTimeout(timer);
 },[board,ready,scheduleLoading]);
 useEffect(()=>{if(!board)return;const eligible=board.games.filter(g=>selected.includes(g.id)&&!feeds[g.id]&&canPlay(g)).map(g=>g.id);if(!eligible.length)return;const timer=window.setTimeout(()=>setProviderChoices(current=>{const next={...current};let changed=false;for(const id of eligible){if(next[id]===undefined){next[id]=true;changed=true;}}return changed?next:current;}),0);return()=>window.clearTimeout(timer);},[board,selected,feeds,canPlay]);
 useEffect(()=>{if(chosen.some(g=>g.id===focus))return;const timer=window.setTimeout(()=>setFocus(chosen[0]?.id||''),0);return()=>window.clearTimeout(timer);},[chosen,focus]);
 useEffect(()=>{if(!auto||stale||spoilers)return;const target=[...chosen].sort((a,b)=>priority(b)-priority(a))[0];if(target&&target.redzone&&target.id!==focus&&Date.now()-lastAuto.current>20000){const timer=window.setTimeout(()=>{lastAuto.current=Date.now();setFocus(target.id);setAudio(target.id);toast(`${target.away.abbreviation} at ${target.home.abbreviation} is in the red zone`);},0);return()=>window.clearTimeout(timer);}},[auto,board,chosen,focus,stale,spoilers,toast]);
 useEffect(()=>{const fn=()=>setFullscreen(document.fullscreenElement===room.current);document.addEventListener('fullscreenchange',fn);return()=>document.removeEventListener('fullscreenchange',fn);},[]);
 const full=useCallback(async()=>{try{if(document.fullscreenElement===room.current)await document.exitFullscreen();else await room.current?.requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser. Try theater mode.');}},[toast]);
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){dragging.current=null;setDragOverSlot(null);setDragOverCenter(false);}if(modal||e.ctrlKey||e.metaKey||e.altKey||(e.target as HTMLElement)?.closest('input,textarea,select,button,[role="slider"],[contenteditable]'))return;if(e.key==='m'){setMuted(v=>!v);e.preventDefault();}if(e.key==='f'){void full();e.preventDefault();}if(e.key==='t')setTheater(v=>!v);if(e.key==='?')setModal('help');if(e.key===' '&&focus&&(feeds[focus]||providerGames.includes(focus))){setPlayback(state=>({...state,overrides:{...state.overrides,[focus]:!effectivePlaying(state,focus)}}));e.preventDefault();}const n=Number(e.key);const target=layout==='quad'?slots[n-1]:chosen[n-1]?.id;if(n>=1&&n<=4&&target){setFocus(target);setAudio(target);setMuted(false);setAuto(false);}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[chosen,slots,layout,modal,full,focus,feeds,providerGames]);
 const playGame=(id:string,initialCandidateId?:string)=>{if(initialCandidateId)setInitialCandidateIds(s=>({...s,[id]:initialCandidateId}));setProviderChoices(s=>({...s,[id]:true}));setAudio(id);setFocus(id);setMuted(false);setPlayback(state=>({...state,overrides:{...state.overrides,[id]:true}}));};
  const clearGameState=(id:string)=>{setPlayback(state=>{const overrides={...state.overrides};delete overrides[id];return {...state,overrides};});setProviderChoices(s=>{const next={...s};delete next[id];return next;});setInitialCandidateIds(s=>{const next={...s};delete next[id];return next;});if(audio===id)setAudio('');};
  const addGame=(id:string)=>{if(selected.includes(id)){setFocus(id);setAudio(id);setMuted(false);setAuto(false);return;}if(selected.length>=4){toast('Your room has four games. Remove one to add another.');return;}const game=games.find(g=>g.id===id);const playable=!!feeds[id]||!!game&&canPlay(game);setSlots(current=>addToSlots(current,id));if(layout==='single')setLayout('duo');else if(layout==='duo'&&selected.length>=2)setLayout('quad');if(playable){setFocus(id);setAudio(id);setMuted(false);}toast(playable?'Game added to your room':'Game added. No compatible stream is available yet.');};
  const removeGame=(id:string)=>{clearGameState(id);setSlots(current=>removeFromSlots(current,id));};
  const endDrag=()=>{dragging.current=null;setDragOverSlot(null);setDragOverCenter(false);};
  const startDrag=(event:React.DragEvent,id:string,kind:'center'|'tile')=>{if(view!=='room'||!games.some(game=>game.id===id)){event.preventDefault();return;}dragging.current={kind,id};event.dataTransfer.setData('application/x-sunday-room-game',id);event.dataTransfer.effectAllowed=kind==='tile'?'move':'copy';};
  const draggedGame=(event:React.DragEvent)=>{const item=dragging.current;return item&&event.dataTransfer.types.includes('application/x-sunday-room-game')&&games.some(game=>game.id===item.id)?item:null;};
  const dropOnSlot=(event:React.DragEvent,index:number)=>{const item=draggedGame(event);if(!item||event.dataTransfer.getData('application/x-sunday-room-game')!==item.id)return;event.preventDefault();endDrag();const displaced=slots[index];const alreadySelected=slots.includes(item.id);const incoming=games.find(game=>game.id===item.id);if(displaced&&displaced!==item.id){if(!alreadySelected){clearGameState(displaced);if(audio===displaced)setAudio(item.id);}else if(audio===displaced&&!visible.some(game=>game.id===item.id))setAudio(item.id);if(layout!=='quad'&&alreadySelected&&focus===item.id)setFocus(displaced);else if(focus===displaced&&(layout!=='quad'||!alreadySelected))setFocus(item.id);}else if(!displaced&&!alreadySelected&&(feeds[item.id]||incoming&&canPlay(incoming))){setFocus(item.id);setAudio(item.id);setMuted(false);}setSlots(current=>placeInSlot(current,item.id,index));};
 const star=(id:string)=>setFavorites(f=>f.includes(id)?f.filter(x=>x!==id):[...f,id]);
 const openFeed=(id:string)=>{setFeedGame(id);setFeedUrl(feeds[id]?.url||'');setFeedLabel(feeds[id]?.label||'My game feed');setFormError('');setModal('feed');};
  const saveFeed=(e:React.FormEvent)=>{e.preventDefault();const url=validFeedUrl(feedUrl);if(!url){setFormError('Enter a valid HTTPS video URL (or HTTP localhost).');return;}if(!feedGame){setFormError('Choose a game first.');return;}if(!selected.includes(feedGame)&&selected.length>=4){setFormError('Your room has four games. Remove one before connecting this feed.');return;}setFeeds(f=>({...f,[feedGame]:{url,label:feedLabel.trim()||'My game feed'}}));setProviderChoices(s=>{const next={...s};delete next[feedGame];return next;});setInitialCandidateIds(s=>{const next={...s};delete next[feedGame];return next;});if(!selected.includes(feedGame))setSlots(s=>addToSlots(s,feedGame));setAudio(feedGame);setMuted(false);setPlayback(state=>({...state,overrides:{...state.overrides,[feedGame]:true}}));setModal(null);toast('Feed connected. Press play if your browser asks.');};
 const setGamePlaying=(id:string,value:boolean)=>setPlayback(state=>({...state,overrides:{...state.overrides,[id]:value}}));
 const setGameAudible=(id:string,value:boolean)=>{if(value){setAudio(id);setMuted(false);if(volume===0)setVolume(70);}else if(audio===id)setMuted(true);};
 const setGameVolume=(id:string,value:number)=>{setVolume(value);setAudio(id);setMuted(value===0);};
 const pick=(id:string)=>{setFocus(id);setAudio(id);setMuted(false);setAuto(false);};
 const leagueSelector = <div className="league-selector" role="group" aria-label="Choose league">{(['all','nfl','ncaaf','basketball'] as const).map(league=><button key={league} type="button" className={leagueFilter===league?'active':''} aria-pressed={leagueFilter===league} onClick={()=>{setLeagueFilter(league);if(league==='basketball'){if(filter==='redzone')setFilter('all');setAuto(false);}}}>{league==='all'?'All':league==='basketball'?'Basketball':LEAGUES[league].label}</button>)}</div>;
 const scoresAt=leagueFilter==='all' ? Object.values(board?.leagues||{}).map(status=>status.scoresAt).filter((at):at is string=>!!at).sort().at(-1) : leagueFilter==='basketball' ? [board?.leagues.nba.scoresAt,board?.leagues.wnba.scoresAt,board?.leagues.ncaab.scoresAt].filter((at):at is string=>!!at).sort().at(-1) : board?.leagues[leagueFilter].scoresAt;
 const time=scoresAt?new Date(scoresAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):null;
 return <div className={`app ${theater?'theater':''} ${desktop?'desktop':''}`}>
  <header className="topbar"><Link className="brand" href="/" aria-label="Sunday Room home"><span className="brand-mark"><i/><i/><i/><i/></span><span>SUNDAY<span className="brand-light">ROOM</span></span></Link><nav className="main-nav" aria-label="Main navigation"><button className={view==='room'?'active':''} onClick={()=>setView('room')}><Tv size={16}/>Watch room</button><button className={view==='schedule'?'active':''} onClick={()=>setView('schedule')}>Game schedule</button></nav><div className="top-right"><span className="private-room"><ShieldCheck size={14}/>{desktop?"Desktop viewer":"Personal room"}</span><button className="icon-button" title="Room settings" aria-label="Room settings" onClick={()=>setModal('settings')}><Settings2 size={19}/></button></div></header>
  {showGameDayHeader&&<section className="score-strip" aria-label="Game scoreboard"><div className="score-label"><span className="eyebrow">{leagueLabel}</span><strong>{week?`WEEK ${week}`:'GAME DAY'}</strong><span>{live.length} live games</span></div><div className="score-scroll">{headerGames.length?headerGames.map(g=><button key={g.id} className={`mini-game ${selected.includes(g.id)?'selected':''}`} onClick={()=>{addGame(g.id);setView('room');}} title={`Add ${g.name}`}><div className="mini-game-top"><span className="league-tag">{LEAGUES[g.league].label}</span><GameTiming game={g} relativeDay/><GameStatus game={g}/></div><div><Badge team={g.away}/><span>{g.away.abbreviation}</span><b>{score(g.away,g,spoilers)}</b></div><div><Badge team={g.home}/><span>{g.home.abbreviation}</span><b>{score(g.home,g,spoilers)}</b></div></button>):<div className="strip-empty">{scheduleLoading||loading?'Finding this week’s games…':'Game scores are currently unavailable.'}</div>}</div><button className="score-refresh icon-button" aria-label="Refresh game data" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={17} className={loading?'spin':''}/></button></section>}
  <main>
   {stale?<div role="status" className="data-alert"><Radio size={16}/><span>{fetchError||errors.join(' ')}</span><button onClick={()=>void refresh()}>Retry</button></div>:null}
   {view==='room'?<div className="workspace"><div className="viewing-column"><div className="viewing-room" ref={room}>
    <div className="room-toolbar"><div className="room-label"><span className="small-square"/><strong>Multiview</strong><span className="count-badge">{visible.length} / 4</span></div>{leagueSelector}<div className="toolbar-end"><div className="layout-switch" role="group" aria-label="Viewing layout">{layouts.map(l=><button key={l.id} className={layout===l.id?'active':''} aria-label={l.label} title={l.label} aria-pressed={layout===l.id} onClick={()=>setLayout(l.id)}><l.icon size={17}/></button>)}</div>{leagueFilter!=='basketball'&&<div className="smart-focus"><Zap size={14} className={auto?'coral':''}/><label htmlFor="smart-focus">Smart focus</label><Switch id="smart-focus" checked={auto} disabled={spoilers} onCheckedChange={v=>{setAuto(v);if(v)setLayout('focus');}}/></div>}<span className="toolbar-divider"/><button className={`icon-button ${theater?'on':''}`} aria-label={theater?'Exit theater mode':'Theater mode'} title="Theater mode (T)" onClick={()=>setTheater(t=>!t)}><Monitor size={17}/></button><button className="icon-button" aria-label={fullscreen?'Exit fullscreen':'Fullscreen'} title="Fullscreen (F)" onClick={()=>void full()}>{fullscreen?<Minimize size={17}/>:<Maximize size={17}/>}</button></div></div>
    <div className={`game-grid ${layout}`}>
     {gridCells.map(({g,index,slotIndex})=>g?<article key={g.id} data-game-id={g.id} data-slot-index={slotIndex} className={`game-tile ${focus===g.id?'focused':''} ${dragOverSlot===slotIndex?'drop-hover':''}`} onDragOver={event=>{if(!draggedGame(event))return;event.preventDefault();event.dataTransfer.dropEffect=dragging.current?.kind==='tile'?'move':'copy';setDragOverSlot(slotIndex);}} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDragOverSlot(null);}} onDrop={event=>dropOnSlot(event,slotIndex)} style={{'--away':`#${g.away.color}`,'--home':`#${g.home.color}`} as React.CSSProperties}>
      <div className="tile-top"><div className="tile-meta"><button type="button" className="tile-drag-grip" draggable aria-label={`Drag ${g.name} to move or remove it`} title="Drag to another square or Game center" onDragStart={event=>startDrag(event,g.id,'tile')} onDragEnd={endDrag}><GripVertical size={14}/></button><span className="tile-number">0{index+1}</span><span className="league-tag">{LEAGUES[g.league].label}</span><GameTiming game={g}/>{g.redzone&&!spoilers?<span className="redzone-pill"><Flame size={12}/>RED ZONE</span>:<GameStatus game={g}/>}</div><div className="tile-actions"><button className={`icon-button ${favorites.includes(g.id)?'starred':''}`} aria-label={`${favorites.includes(g.id)?'Unfavorite':'Favorite'} ${g.name}`} onClick={()=>star(g.id)}><Star size={14} fill={favorites.includes(g.id)?'currentColor':'none'}/></button><button className="icon-button" aria-label={`Remove ${g.name}`} onClick={()=>removeGame(g.id)}><X size={15}/></button></div></div>
      <div className="tile-screen">{providerGames.includes(g.id)||feeds[g.id]?<BrowserProviderPlayer gameId={g.id} initialCandidateId={initialCandidateIds[g.id]} availableCandidates={candidatesByGame.get(g.id)||[]} manualFeed={feeds[g.id]} graceEndsAt={g.graceEndsAt} focused={focus===g.id} audible={audio===g.id&&!muted} volume={volume} defaultQuality={defaultQuality} playing={effectivePlaying(playback,g.id)} onPlayingChange={value=>setGamePlaying(g.id,value)} onAudibleChange={value=>setGameAudible(g.id,value)} onVolumeChange={value=>setGameVolume(g.id,value)}/>:<div className="matchup-screen"><div className="team-watermark left">{g.away.abbreviation}</div><div className="team-watermark right">{g.home.abbreviation}</div><div className="matchup"><div><Badge team={g.away} large/><span>{g.away.short}</span></div><span className="versus">VS</span><div><Badge team={g.home} large/><span>{g.home.short}</span></div></div><span className="screen-caption" role="status">{g.lifecycle==='final'?'Game finished':(checkingServers(g.id)||sourcesCollecting&&!candidatesByGame.get(g.id)?.length)?'Checking listed servers…':'No verified stream yet'}</span><span className="screen-caption">{g.lifecycle==='final'?'Source collection has ended.':<>{g.broadcast?`${g.broadcast} · `:''}Source checks continue automatically</>}</span></div>}</div>
      {!providerGames.includes(g.id)&&!feeds[g.id]&&g.lifecycle!=='final'&&<ServerControls candidates={candidatesByGame.get(g.id)||[]} selectedCandidateId="" onSelect={candidateId=>playGame(g.id,candidateId)}/>}
      <div className="tile-score"><div className="tile-teams"><span>{g.away.abbreviation}<b>{score(g.away,g,spoilers)}</b></span><i/><span>{g.home.abbreviation}<b>{score(g.home,g,spoilers)}</b></span></div><button className={`audio-focus ${focus===g.id?'active':''}`} onClick={()=>pick(g.id)} title={feeds[g.id]||providerGames.includes(g.id)?'Focus this game and its audio':'Focus this game'}>{(feeds[g.id]||providerGames.includes(g.id))&&audio===g.id&&!muted?<Volume2 size={14}/>:<Headphones size={14}/>}<span>{focus===g.id?'IN FOCUS':'FOCUS'}</span></button></div>
      <div className="tile-bottom"><span>{spoilers?'Scores hidden':g.down||g.venue||`${LEAGUES[g.league].label} game day`}</span><div><button aria-label={`Feed settings for ${g.name}`} title="Feed settings" onClick={()=>openFeed(g.id)}><SlidersHorizontal size={13}/></button></div></div>
      </article>:<button key={`empty-${slotIndex}`} type="button" data-slot-index={slotIndex} className={`add-tile ${layout==='quad'?'quad-empty':''} ${dragOverSlot===slotIndex?'drop-hover':''}`} onClick={()=>{if(!selected.length&&index===0){if(games.length)setSlots(slotsFromIds([...games].sort((a,b)=>priority(b)-priority(a)).slice(0,4).map(game=>game.id)));else void refresh();return;}setTheater(false);document.getElementById('game-search')?.focus();}} onDragOver={event=>{if(!draggedGame(event))return;event.preventDefault();event.dataTransfer.dropEffect=dragging.current?.kind==='tile'?'move':'copy';setDragOverSlot(slotIndex);}} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDragOverSlot(null);}} onDrop={event=>dropOnSlot(event,slotIndex)}><span><Plus size={24}/></span><strong>{!selected.length&&index===0?(games.length?'Add top games':scheduleLoading?'Finding games…':'Try again'):layout==='quad'?`Square ${index+1}`:'More games, same screen.'}</strong><small>Drag a game here or choose one from Game center</small></button>)}
    </div>
   </div>
   <section className="around-league"><div className="section-heading"><h2><Radio size={17}/>Around {leagueFilter==='basketball'?'basketball':leagueFilter==='all'?'the games':'football'}</h2><span>{spoilers?'Scores hidden':hot.length?`${hot.length} in the red zone`:'Live game pulse'}</span></div><div className="pulse-list">{!spoilers&&live.some(g=>g.lastPlay)?live.filter(g=>g.lastPlay).slice(0,3).map(g=><button key={g.id} onClick={()=>addGame(g.id)}><span className={`pulse-icon ${g.redzone?'hot':''}`}>{g.redzone?<Flame size={17}/>:<Radio size={17}/>}</span><div><strong>{g.away.abbreviation} <span>at</span> {g.home.abbreviation}</strong><p>{g.lastPlay}</p></div><ChevronRight size={15}/></button>):<div className="pulse-empty"><span className="pulse-icon"><Radio size={20}/></span><div><strong>{spoilers?'Enjoy the games at your own pace.':'Stay close to the next big play.'}</strong><p>{spoilers?'Play updates are hidden while spoiler-free mode is on.':'Latest plays appear here when the live score feed reports them.'}</p></div></div>}</div></section>
   </div><aside className={`game-center ${dragOverCenter?'remove-hover':''}`} onDragOver={event=>{if(draggedGame(event)?.kind!=='tile')return;event.preventDefault();event.dataTransfer.dropEffect='move';setDragOverCenter(true);}} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDragOverCenter(false);}} onDrop={event=>{const item=draggedGame(event);if(item?.kind==='tile'&&event.dataTransfer.getData('application/x-sunday-room-game')===item.id){event.preventDefault();removeGame(item.id);}endDrag();}}><div className="center-heading"><div><h2>Game center</h2><span>{discovery.length} matchups this week</span></div><span className="live-counter">{live.length} LIVE</span></div><Tabs value={filter} onValueChange={setFilter}><TabsList className="game-tabs"><TabsTrigger value="all">All games</TabsTrigger><TabsTrigger value="live">Live</TabsTrigger>{leagueFilter!=='basketball'&&<TabsTrigger value="redzone" aria-label="Red zone games"><Flame size={15}/></TabsTrigger>}<TabsTrigger value="favorites" aria-label="Favorite games"><Star size={15}/></TabsTrigger></TabsList></Tabs><label className="search-box"><Search size={15}/><input id="game-search" placeholder="Find a team or game" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="Clear search" onClick={()=>setSearch('')}><X size={14}/></button>}</label>{dragOverCenter&&<div className="center-remove-cue">Drop here to remove game</div>}<div className="center-games">{filtered.map(g=><div className={`center-game ${selected.includes(g.id)?'in-room':''}`} key={g.id} data-game-id={g.id} draggable onDragStart={event=>startDrag(event,g.id,'center')} onDragEnd={endDrag} style={{background:`linear-gradient(110deg,color-mix(in srgb,#${g.away.color} 15%,#111419) 0%,#111419 53%,color-mix(in srgb,#${g.home.color} 14%,#111419) 100%)`}}><div className="center-game-watermarks" aria-hidden="true"><span>{g.away.abbreviation}</span><span>{g.home.abbreviation}</span></div><div className="center-game-top"><div className="center-game-meta"><span className="league-tag">{LEAGUES[g.league].label}</span><GameTiming game={g} relativeDay/><GameStatus game={g}/></div><button className={`icon-button ${favorites.includes(g.id)?'starred':''}`} aria-label={`${favorites.includes(g.id)?'Unfavorite':'Favorite'} ${g.name}`} onClick={()=>star(g.id)}><Star size={14} fill={favorites.includes(g.id)?'currentColor':'none'}/></button></div>{[g.away,g.home].map(t=><div className="center-team" key={t.name}><Badge team={t}/><strong>{t.short}</strong><span>{t.record}</span><b>{score(t,g,spoilers)}</b></div>)}<div className="center-game-bottom"><span>{g.redzone&&!spoilers?<><Flame size={12}/>Red zone</>:g.broadcast||LEAGUES[g.league].label}</span><button onClick={()=>selected.includes(g.id)?pick(g.id):addGame(g.id)} className={selected.includes(g.id)?'added':''}>{selected.includes(g.id)?<><Check size={13}/>In your room</>:<><Plus size={13}/>Add game</>}</button></div></div>)}{!filtered.length&&<div className="filter-empty"><Search size={25}/><strong>{scheduleLoading||loading?'Loading games…':'No games here yet'}</strong><p>{search?'Try another team name.':filter==='redzone'?'Games appear here when a team enters the red zone.':filter==='favorites'?'Star a game to keep it here.':filter==='live'?'Live games appear when play begins.':'Refresh to check for games.'}</p></div>}</div>{(leagueFilter==='all'||leagueFilter==='nfl')&&<a className="redzone-link" href="https://isportsurge.ws/event/nfl/nfl-redzone-live-streaming-links" target="_blank" rel="noopener noreferrer"><span className="redzone-logo">RZ</span><div><strong>NFL RedZone</strong><span>Open the dedicated channel</span></div><ArrowUpRight size={17}/></a>}</aside></div>:<div className="schedule-view"><div className="schedule-toolbar">{leagueSelector}<span>{discovery.length} matchups{week?` · Week ${week}`:''}</span><button className="button subtle" onClick={()=>void refresh()}><RefreshCw size={15}/>Refresh</button></div><div className="schedule-grid">{discovery.map(g=><article className="schedule-card" key={g.id}><div className="schedule-card-top"><span className="league-tag">{LEAGUES[g.league].label}</span><GameTiming game={g}/><GameStatus game={g}/></div><div className="schedule-matchup"><div><Badge team={g.away} large/><strong>{g.away.short}</strong><b>{score(g.away,g,spoilers)}</b></div><span>AT</span><div><Badge team={g.home} large/><strong>{g.home.short}</strong><b>{score(g.home,g,spoilers)}</b></div></div><p>{g.venue||LEAGUES[g.league].label}{g.broadcast?` · ${g.broadcast}`:''}</p><button className="button" onClick={()=>{addGame(g.id);setView('room');}}>{selected.includes(g.id)?'View in your room':'Add to your room'}<ArrowUpRight size={15}/></button></article>)}</div>{!discovery.length&&<div className="room-empty"><h2>{scheduleLoading?'Loading game schedule…':'No schedule available'}</h2><button className="button" onClick={()=>void refresh()}>Try again</button></div>}</div>}
   <footer className="footer"><span className={stale?'stale':''}><i/>{stale?'Feed update delayed':time?`Scores updated ${time}`:'Waiting for score feed'}<span className="footer-separator">/</span>Refreshes every 30 seconds</span><span>Made for game days.<span className="footer-ball">↗</span></span></footer>
  </main>
  <Dialog open={modal!==null} onOpenChange={open=>{if(!open)setModal(null);}}><DialogContent className={modal==='settings'?'room-dialog settings-dialog':'room-dialog'}><DialogHeader><DialogTitle>{modal==='feed'?'Connect your game feed':modal==='settings'?'Make it your room':'Welcome to Sunday Room'}</DialogTitle><DialogDescription>{modal==='feed'?'Add a direct HLS (.m3u8) or video URL you have access to.':modal==='settings'?'Your preferences are saved on this device.':'Four games. One screen. You call the shots.'}</DialogDescription></DialogHeader>
   {modal==='feed'&&<form onSubmit={saveFeed} className="feed-form"><label>Game<Select value={feedGame} onValueChange={id=>{setFeedGame(id);setFeedUrl(feeds[id]?.url||'');setFeedLabel(feeds[id]?.label||'My game feed');}}><SelectTrigger><SelectValue placeholder="Choose a matchup"/></SelectTrigger><SelectContent>{games.map(g=><SelectItem key={g.id} value={g.id}>{g.away.short} at {g.home.short}</SelectItem>)}</SelectContent></Select></label><label>Feed name<input value={feedLabel} onChange={e=>setFeedLabel(e.target.value)} maxLength={60} placeholder="My game feed"/></label><label>Video URL<input type="url" value={feedUrl} onChange={e=>setFeedUrl(e.target.value)} placeholder="https://your-provider.com/live.m3u8" required autoComplete="off"/></label><div className="feed-note"><Radio size={17}/><p>Listed live games play inside the room when added. Connect your own direct video feed here only if you want to use another source. A regular webpage link won’t play.</p></div>{formError&&<p className="form-error" role="alert">{formError}</p>}<div className="form-actions">{feeds[feedGame]&&<button type="button" className="button subtle" onClick={()=>{setFeeds(f=>{const next={...f};delete next[feedGame];return next;});setModal(null);toast('Feed disconnected');}}>Disconnect</button>}<button type="submit" className="button primary"><Play size={15}/>Connect feed</button></div></form>}
   {modal==='help'&&<div className="help-content"><div><span>01</span><p><strong>Build your game day.</strong>Add up to four games. Choose a grid, two-up, single game, or a larger focus view.</p></div><div><span>02</span><p><strong>Add a game. Watch in your room.</strong>Adding a listed live game starts its provider inside the tile. If a server fails, try another listed server. No feed URL is needed.</p></div><div><span>03</span><p><strong>Follow the action.</strong>Focus a game for its audio and video controls. Smart focus follows red-zone activity among your selected games, with at least 20 seconds between switches.</p></div><div className="shortcuts"><span><kbd>1–4</kbd>Focus game</span><span><kbd>M</kbd>Mute audio</span><span><kbd>F</kbd>Room fullscreen</span><span><kbd>T</kbd>Theater mode</span><span><kbd>Space</kbd>Play / pause focused game</span></div><p className="help-fine">Scores can lead or lag your video. Stream availability and playback permissions are controlled by each provider. Sunday Room is an independent personal viewer.</p><button className="button primary" onClick={()=>setModal(null)}>Make yourself at home<ChevronRight size={16}/></button></div>}
   {modal==='settings'&&<Tabs orientation="vertical" defaultValue="general" className="settings-tabs">
    <TabsList aria-label="Settings sections" className="settings-sidebar">
     <TabsTrigger value="general"><Settings2 size={17}/>General</TabsTrigger>
     <TabsTrigger value="playback"><Volume2 size={17}/>Playback</TabsTrigger>
     <TabsTrigger value="sources"><Radio size={17}/>Sources</TabsTrigger>
     <TabsTrigger value="updates"><RefreshCw size={17}/>Updates</TabsTrigger>
     <TabsTrigger value="privacy"><ShieldCheck size={17}/>Privacy</TabsTrigger>
    </TabsList>
    <TabsContent forceMount value="general" className="settings-panel"><div className="settings-panel-heading"><h3>General</h3><p>Choose how game day appears in your room.</p></div><div className="setting-row"><div><strong>Spoiler-free mode</strong><p>Hide scores and latest play updates.</p></div><Switch aria-label="Spoiler-free mode" checked={spoilers} onCheckedChange={v=>{setSpoilers(v);if(v){setAuto(false);setFilter('all');}}}/></div><div className="setting-row"><div><strong>Show Game Day header</strong><p>Show the scoreboard above your room.</p></div><Switch aria-label="Show Game Day header" checked={showGameDayHeader} onCheckedChange={setShowGameDayHeader}/></div><FinishedGameRetentionSetting minutes={board?.finishedGameRetentionMinutes??DEFAULT_FINISHED_GAME_RETENTION_MINUTES} disabled={!board} onChange={saveFinishedRetention}/></TabsContent>
    <TabsContent forceMount value="playback" className="settings-panel"><div className="settings-panel-heading"><h3>Playback</h3><p>Set your room&apos;s sound and preferred video quality.</p></div><div className="setting-row"><div><strong>Room volume</strong><p>Only your selected feed plays audio.</p></div><span>{volume}%</span></div><Slider aria-label="Default room volume" value={[volume]} onValueChange={v=>setVolume(v[0])} max={100}/><div className="quality-setting"><strong>Default video quality</strong><p>Uses the closest available quality at or below your choice, or the lowest available if none are lower.</p><Select value={defaultQuality} onValueChange={value=>setDefaultQuality(parseQualityPreference(value))}><SelectTrigger aria-label="Default video quality"><SelectValue/></SelectTrigger><SelectContent>{qualityPreferences.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div></TabsContent>
    <TabsContent forceMount value="sources" className="settings-panel"><div className="settings-panel-heading"><h3>Sources</h3><p>Review the game listings and available streams.</p></div><FeedCheckIntervalSetting minutes={board?.feedCheckIntervalMinutes??DEFAULT_FEED_CHECK_INTERVAL_MINUTES} disabled={!board} onChange={saveFeedCheckInterval}/><SourceInventory gameIds={selected} branding={{games}}/></TabsContent>
    <TabsContent forceMount value="updates" className="settings-panel"><div className="settings-panel-heading"><h3>Updates</h3><p>Manage updates to the Sunday Room desktop viewer.</p></div>{desktop?<UpdatePanel/>:<div className="feed-note"><Monitor size={18}/><p>App updates are available in the desktop viewer. This browser version updates when you reload the page.</p></div>}</TabsContent>
    <TabsContent forceMount value="privacy" className="settings-panel"><div className="settings-panel-heading"><h3>Privacy</h3><p>Manage the room data saved on this device.</p></div><div className="feed-note"><ShieldCheck size={18}/><p>Layouts, favorites, and feed URLs are stored only in this browser. Avoid saving links on a shared device.</p></div><button className="button subtle" onClick={()=>{setFeeds({});setProviderChoices({});setInitialCandidateIds({});setFavorites([]);setSlots(slotsFromIds([...games].sort((a,b)=>priority(b)-priority(a)).slice(0,4).map(g=>g.id)));setLayout('quad');setAudio('');setAuto(false);setSpoilers(false);setShowGameDayHeader(false);setVolume(70);setDefaultQuality('auto');setPlayback({defaultPlaying:true,overrides:{}});toast('Room reset. Saved feeds removed.');setModal(null);}}>Reset room and remove saved feeds</button></TabsContent>
   </Tabs>}
  </DialogContent></Dialog>
   {notice&&<div className="toast" role="status"><Check size={16}/>{notice}</div>}
   <UpdatePopup/>
  </div>;
}
