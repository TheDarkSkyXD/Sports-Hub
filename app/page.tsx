'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, CircleHelp, Columns2, ExternalLink, Flame, Grid2X2, Headphones, LayoutPanelLeft, Maximize, Minimize, Monitor, Pause, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Star, Tv, Volume2, VolumeX, X, Zap } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { GamePicker } from '@/components/game-picker';
import { TeamBadge as Badge } from '@/components/team-badge';
import { matchesGameSearch } from '@/lib/game-discovery';
import { GamePlayer } from '@/components/game-player';
import { RoomPlaybackBar } from '@/components/room-playback-bar';
import { parseRoomPreferences } from '@/lib/room-preferences';
import { buildGameIdMap, remapRoomIds, remapRoomRecord } from '@/lib/reconcile-room';
import { ProviderPlayer } from '@/components/provider-player';
import { useRoomFullscreen } from '@/hooks/use-room-fullscreen';
import { Board, Feed, Game, Team, priority, SOURCE, validFeedUrl } from '@/lib/sunday';

type Layout = 'quad' | 'focus' | 'duo' | 'single';
const STORAGE = 'sunday-room:v1';
const layouts: { id: Layout; label: string; icon: typeof Grid2X2 }[] = [{ id:'quad', label:'Four games', icon:Grid2X2 }, { id:'focus', label:'Focus view', icon:LayoutPanelLeft }, { id:'duo', label:'Two games', icon:Columns2 }, { id:'single', label:'Single game', icon:Monitor }];
function GameStatus({ game }: { game: Game }) { return <span className={`game-status ${game.status}`}><i/>{game.detail}</span>; }
function score(team: Team, game: Game, hide: boolean) { return hide ? '—' : game.status==='pre' ? '—' : team.score ?? '—'; }

export default function Home() {
 const [board,setBoard]=useState<Board|null>(null),[fetchError,setFetchError]=useState(''),[loading,setLoading]=useState(true);
 const [selected,setSelected]=useState<string[]>([]),[favorites,setFavorites]=useState<string[]>([]),[feeds,setFeeds]=useState<Record<string,Feed>>({});
 const [directReady,setDirectReady]=useState<string[]>([]);
 const directAvailability=useCallback((id:string,available:boolean)=>setDirectReady(ids=>available?(ids.includes(id)?ids:[...ids,id]):ids.includes(id)?ids.filter(v=>v!==id):ids),[]);
 const [audioMenuOpen,setAudioMenuOpen]=useState(false);
 const [placement,setPlacement]=useState<{id:string;feed?:Feed}|null>(null);
 const [providerReady,setProviderReady]=useState<string[]>([]);
 const providerAvailability=useCallback((id:string,ready:boolean)=>setProviderReady(ids=>ready?(ids.includes(id)?ids:[...ids,id]):ids.includes(id)?ids.filter(v=>v!==id):ids),[]);
 const [desktop,setDesktop]=useState(false),[providerGames,setProviderGames]=useState<string[]>([]);
 const [layout,setLayout]=useState<Layout>('quad'),[focus,setFocus]=useState(''),[audio,setAudio]=useState(''),[muted,setMuted]=useState(false),[volume,setVolume]=useState(70),[playing,setPlaying]=useState(true);
 const room=useRef<HTMLDivElement>(null);
 const {fullscreen,toggle:full}=useRoomFullscreen(room);
 const [filter,setFilter]=useState('all'),[search,setSearch]=useState(''),[view,setView]=useState('room'),[theater,setTheater]=useState(false),[auto,setAuto]=useState(false),[spoilers,setSpoilers]=useState(false);
 const [modal,setModal]=useState<'feed'|'help'|'settings'|'replace'|'games'|null>(null),[feedGame,setFeedGame]=useState(''),[feedUrl,setFeedUrl]=useState(''),[feedLabel,setFeedLabel]=useState(''),[formError,setFormError]=useState(''),[notice,setNotice]=useState(''),[ready,setReady]=useState(false),[delays,setDelays]=useState<Record<string,number>>({});
 const initialized=useRef(false),restoredEmpty=useRef(false),refreshing=useRef(false),lastAuto=useRef(0);
 const previousBoard=useRef<Board|null>(null);
 const dialogReturnFocus=useRef<HTMLElement|null>(null);
 const games=board?.games||[];
 const chosen=selected.map(id=>games.find(g=>g.id===id)).filter(Boolean) as Game[];
 const ordered=[...chosen].sort((a,b)=>a.id===focus?-1:b.id===focus?1:0);
 const visible=layout==='single'?ordered.slice(0,1):layout==='duo'?ordered.slice(0,2):layout==='focus'?ordered:chosen;
 const tuckedAway=chosen.filter(game=>!visible.some(item=>item.id===game.id));
 const live=games.filter(g=>g.status==='in'),hot=live.filter(g=>g.redzone);
 const compareGames=useCallback((a:Game,b:Game)=>spoilers?((a.date||'').localeCompare(b.date||'')||a.id.localeCompare(b.id)):priority(b)-priority(a),[spoilers]);
 const filtered=games.filter(g=>(filter==='all'||filter==='live'&&g.status==='in'||filter==='redzone'&&g.redzone||filter==='favorites'&&favorites.includes(g.id))&&matchesGameSearch(g,search)).sort(compareGames);
 const stale=!!fetchError||!!board?.errors.length;
 const scoreTime=Date.parse(board?.scoresAt||'');
 const scoresStale=!!fetchError||!Number.isFinite(scoreTime)||Date.now()-scoreTime>90000;
 const connected=useCallback((g:Game)=>providerGames.includes(g.id)?providerReady.includes(g.id):!!feeds[g.id]&&directReady.includes(g.id),[providerGames,providerReady,feeds,directReady]);
 const audioCandidates=view==='room'?visible.filter(connected):[];
 const activeAudio=audioCandidates.find(g=>g.id===audio&&connected(g))||audioCandidates.find(g=>g.id===focus)||audioCandidates[0];
 const rendered=[...visible,...chosen.filter(g=>!visible.some(v=>v.id===g.id))];
 useEffect(()=>{setDesktop(!!window.sundayDesktop);},[]);
 useEffect(()=>{window.sundayDesktop?.controls({audio:activeAudio?.id||'',muted,volume,playing,overlayOpen:modal!==null||audioMenuOpen});},[activeAudio?.id,muted,volume,playing,providerGames,modal,audioMenuOpen]);
 useEffect(()=>window.sundayDesktop?.onOverlayEscape?.(()=>{
  const target=document.activeElement||document;
  target.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
 }),[]);
 const reconcileRoom=useCallback((mapping:ReadonlyMap<string,string>)=>{
  setSelected(ids=>remapRoomIds(ids,mapping));
  setFavorites(ids=>remapRoomIds(ids,mapping));
  setProviderGames(ids=>remapRoomIds(ids,mapping));
  setFeeds(current=>remapRoomRecord(current,mapping));
  setDelays(current=>remapRoomRecord(current,mapping));
  setFocus(id=>mapping.get(id)||'');setAudio(id=>mapping.get(id)||'');
  setDirectReady(ids=>ids.filter(id=>mapping.get(id)===id));
  setProviderReady(ids=>ids.filter(id=>mapping.get(id)===id));
  setFeedGame(id=>mapping.get(id)||'');
  setPlacement(current=>current&&mapping.has(current.id)?{...current,id:mapping.get(current.id)!}:null);
 },[]);
 const toggleMute=useCallback(()=>{if(volume===0){setVolume(70);setMuted(false);}else setMuted(value=>!value);},[volume]);
 const toast=useCallback((message:string)=>setNotice(message),[]);
 useEffect(()=>{ if(notice){const timer=setTimeout(()=>setNotice(''),4500);return ()=>clearTimeout(timer);} },[notice]);
 useEffect(()=>{
  try {const p=parseRoomPreferences(localStorage.getItem(STORAGE));
  if(p){setSelected(p.selected);setFavorites(p.favorites);setFeeds(p.feeds);setLayout(p.layout);setVolume(p.volume);setSpoilers(p.spoilers);restoredEmpty.current=p.selected.length===0;}}catch{}
  setReady(true);
 },[]);
 useEffect(()=>{ if(!ready)return;try{localStorage.setItem(STORAGE,JSON.stringify({selected,favorites,feeds,layout,volume,spoilers}));}catch{toast('Device storage is unavailable. Your room will last for this session.');} },[ready,selected,favorites,feeds,layout,volume,spoilers,toast]);
 const refresh=useCallback(async()=>{ if(refreshing.current)return;refreshing.current=true;setLoading(true);try{const r=await fetch('/api/games',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error();const b:Board=await r.json();if(!Array.isArray(b.games)||!Array.isArray(b.errors))throw new Error();if(!b.games.length&&b.errors.length&&previousBoard.current?.games.length){setFetchError(b.errors.join(' '));return;}if(previousBoard.current&&b.games.length)reconcileRoom(buildGameIdMap(previousBoard.current.games,b.games));if(b.games.length)previousBoard.current=b;setBoard(b);setFetchError('');}catch{setFetchError('Couldn’t refresh the game center. Check your connection and try again.');}finally{refreshing.current=false;setLoading(false);}},[reconcileRoom]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},30000);return()=>clearInterval(timer);},[refresh]);
 useEffect(()=>{ if(!ready||!games.length||initialized.current)return;initialized.current=true;const mapping=buildGameIdMap([],games);reconcileRoom(mapping);setSelected(prev=>{const valid=remapRoomIds(prev,mapping);return valid.length||restoredEmpty.current?valid:[...games].sort(compareGames).slice(0,4).map(g=>g.id);}); },[games,ready,reconcileRoom,compareGames]);
 useEffect(()=>{if(modal==='replace'&&(!placement||!games.some(game=>game.id===placement.id))){setPlacement(null);setModal(null);}},[modal,placement,games]);
 useEffect(()=>{if(modal==='replace'){const frame=requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.replacement-list button')?.focus());return()=>cancelAnimationFrame(frame);}},[modal]);
 useEffect(()=>{if(!chosen.some(g=>g.id===focus))setFocus(chosen[0]?.id||'');},[chosen,focus]);
 useEffect(()=>{if(!auto||scoresStale||spoilers)return;const target=chosen.filter(connected).sort(compareGames)[0];if(target&&target.redzone&&target.id!==focus&&Date.now()-lastAuto.current>20000){lastAuto.current=Date.now();setFocus(target.id);setAudio(target.id);toast(`${target.away.abbreviation} at ${target.home.abbreviation} is in the red zone`);}},[auto,board,chosen,focus,scoresStale,spoilers,toast,compareGames,connected]);
 useEffect(()=>{
  const onKey=(event:KeyboardEvent)=>{
   const target=event.target instanceof HTMLElement?event.target:null;
   if(event.defaultPrevented||modal||audioMenuOpen||event.repeat||event.ctrlKey||event.metaKey||event.altKey||target?.closest('input,textarea,select,[role="slider"],[role="switch"],[role="combobox"],[role="listbox"],[contenteditable]'))return;
   if(event.key==='/'){setModal('games');event.preventDefault();return;}
   if(event.key==='?'){setModal('help');return;}
   if(view!=='room')return;
   const key=event.key.toLowerCase();
   if(key==='m'){toggleMute();event.preventDefault();}
   if(key==='f'){void full();event.preventDefault();}
   if(key==='t')setTheater(value=>!value);
   if(key===' '&&!target?.closest('button')){setPlaying(value=>!value);event.preventDefault();}
   const index=Number(key)-1;
   if(index>=0&&index<4&&chosen[index]){setFocus(chosen[index].id);setAudio(chosen[index].id);setMuted(false);setAuto(false);}
  };
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[chosen,modal,audioMenuOpen,full,view,toggleMute]);
 const placeGame=(id:string,replaced?:string,feed?:Feed)=>{
  if(replaced){setSelected(ids=>ids.map(value=>value===replaced?id:value));setProviderGames(ids=>ids.filter(value=>value!==replaced));}
  else setSelected(ids=>ids.includes(id)?ids:[...ids,id].slice(0,4));
  if(feed){setFeeds(current=>({...current,[id]:feed}));setProviderGames(ids=>ids.filter(value=>value!==id));setPlaying(true);setMuted(false);}
  if(layout==='single'&&!selected.includes(id)&&!replaced)setLayout('duo');
  else if(layout==='duo'&&selected.length>=2&&!selected.includes(id)&&!replaced)setLayout('quad');
  setFocus(id);setAudio(id);setAuto(false);setView('room');setPlacement(null);setModal(null);
  toast(feed?'Feed connected':replaced?'Lineup updated':'Game added to your room');
 };
 const addGame=(id:string)=>{
  if(selected.includes(id)){setFocus(id);setAudio(id);setMuted(false);setAuto(false);setView('room');return;}
  if(selected.length>=4){setPlacement({id});setModal('replace');return;}
  placeGame(id);
 };
 const playRoom=()=>{
  const startable=chosen.filter(game=>game.sourceUrl&&!feeds[game.id]).map(game=>game.id);
  setProviderGames(ids=>[...new Set([...ids,...startable])]);setPlaying(true);setMuted(false);
  if(!audio)setAudio(startable[0]||chosen[0]?.id||'');
 };
 const removeGame=(id:string)=>{setSelected(s=>s.filter(x=>x!==id));setProviderGames(s=>s.filter(x=>x!==id));if(audio===id)setAudio('');};
 const playGame=(id:string)=>{if(desktop){setProviderGames(s=>s.includes(id)?s:[...s,id]);setAudio(id);setFocus(id);setAuto(false);setMuted(false);setPlaying(true);}else{window.open(`/play/${encodeURIComponent(id)}`,'_blank','noopener,noreferrer');}};
 const star=(id:string)=>setFavorites(f=>f.includes(id)?f.filter(x=>x!==id):[...f,id]);
 const openFeed=(id:string)=>{setFeedGame(id);setFeedUrl(feeds[id]?.url||'');setFeedLabel(feeds[id]?.label||'My game feed');setFormError('');setModal('feed');};
 const saveFeed=(e:React.FormEvent)=>{
  e.preventDefault();const url=validFeedUrl(feedUrl);
  if(!url){setFormError('Enter a valid HTTPS video URL (or HTTP localhost).');return;}
  if(!feedGame){setFormError('Choose a game first.');return;}
  const feed={url,label:feedLabel.trim()||'My game feed'};
  if(!selected.includes(feedGame)&&selected.length>=4){setPlacement({id:feedGame,feed});setModal('replace');return;}
  placeGame(feedGame,undefined,feed);
 };
 const pick=(id:string)=>{setFocus(id);setAudio(id);setMuted(false);setAuto(false);};
 const time=board?.scoresAt?new Date(board.scoresAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):null;
 return <div className={`app ${theater?'theater':''} ${desktop?'desktop':''}`}>
  <header className="topbar"><a className="brand" href="/" aria-label="Sunday Room home" onClick={event=>{event.preventDefault();setView('room');}}><span className="brand-mark"><i/><i/><i/><i/></span><span>SUNDAY<span className="brand-light">ROOM</span></span></a><nav className="main-nav" aria-label="Main navigation"><button aria-current={view==='room'?'page':undefined} className={view==='room'?'active':''} onClick={()=>setView('room')}><Tv size={16}/>Watch room</button><button aria-current={view==='schedule'?'page':undefined} className={view==='schedule'?'active':''} onClick={()=>setView('schedule')}>Game schedule</button></nav><div className="top-right"><span className="private-room"><ShieldCheck size={14}/>{desktop?"Desktop viewer":"Personal room"}</span><button className="icon-button" title="Room settings" aria-label="Room settings" onClick={()=>setModal('settings')}><Settings2 size={19}/></button><span className="avatar">S<span/></span></div></header>
  <section className="score-strip" aria-label="NFL scoreboard"><div className="score-label"><span className="eyebrow">NFL</span><strong>{board?.week?`WEEK ${board.week}`:'GAME DAY'}</strong><span>{live.length} live games</span></div><div className="score-scroll">{games.length?games.map(g=><button key={g.id} className={`mini-game ${selected.includes(g.id)?'selected':''}`} onClick={()=>{addGame(g.id);setView('room');}} title={`Add ${g.name}`}><GameStatus game={g}/><div><Badge team={g.away}/><span>{g.away.abbreviation}</span><b>{score(g.away,g,spoilers)}</b></div><div><Badge team={g.home}/><span>{g.home.abbreviation}</span><b>{score(g.home,g,spoilers)}</b></div></button>):<div className="strip-empty">{loading?'Finding this week’s games…':'Game scores are currently unavailable.'}</div>}</div><button className="score-refresh icon-button" aria-label="Refresh game data" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={17} className={loading?'spin':''}/></button></section>
  <main>
   <div className="page-heading"><div><div className="eyebrow"><span className="coral">THE BEST SEAT IS YOURS</span><span className="eyebrow-divider"/>NFL GAME DAY</div><h1>{view==='room'?'Your viewing room.':'The whole game day.'}</h1><p>{view==='room'?'Pick your games. Make yourself at home.':'Every matchup, all in one place.'}</p></div><div className="heading-actions">{view==='room'&&desktop&&chosen.some(game=>game.sourceUrl&&!feeds[game.id]&&!providerGames.includes(game.id))&&<button className="button primary" onClick={playRoom}><Play size={15} fill="currentColor"/>Play room</button>}<button className="button subtle" onClick={()=>setModal('help')}><CircleHelp size={16}/>How it works</button><a className="button" href={SOURCE} target="_blank" rel="noopener noreferrer">Stream directory<ArrowUpRight size={16}/></a></div></div>
   {(fetchError||board?.errors.length)?<div role="status" className="data-alert"><Radio size={16}/><span>{fetchError||board?.errors.join(' ')}</span><button onClick={()=>void refresh()}>Retry</button></div>:null}
   <div className="workspace" hidden={view!=='room'}><div className="viewing-column"><div className={`viewing-room ${fullscreen?'is-fullscreen':''}`} ref={room}>
    <div className="room-toolbar"><div className="room-label"><span className="small-square"/><strong>Multiview</strong><span className="count-badge" title={`${visible.length} games visible, ${chosen.length} in your lineup`}>{visible.length} viewing{tuckedAway.length>0?` · ${chosen.length} selected`:""}</span></div><div className="toolbar-end"><div className="layout-switch" role="group" aria-label="Viewing layout">{layouts.map(l=><button key={l.id} className={layout===l.id?'active':''} aria-label={l.label} title={l.label} aria-pressed={layout===l.id} onClick={()=>setLayout(l.id)}><l.icon size={17}/></button>)}</div><span className="toolbar-divider"/><button id="room-game-picker" className="icon-button" aria-label="Find a game" title="Find a game (/)" onClick={()=>setModal('games')}><Plus size={18}/></button><button className={`icon-button ${theater?'on':''}`} aria-label={theater?'Exit theater mode':'Theater mode'} title="Theater mode (T)" onClick={()=>setTheater(t=>!t)}><Monitor size={17}/></button><button className="icon-button" aria-label={fullscreen?'Exit fullscreen':'Fullscreen'} title="Fullscreen (F)" onClick={()=>void full()}>{fullscreen?<Minimize size={17}/>:<Maximize size={17}/>}</button></div></div>
    <div className={`game-grid ${layout}`} data-count={visible.length}>
     {rendered.map(g=><article key={g.id} hidden={!visible.some(v=>v.id===g.id)} className={`game-tile ${focus===g.id?'focused':''}`} style={{'--away':`#${g.away.color}`,'--home':`#${g.home.color}`} as React.CSSProperties}>
      <div className="tile-top"><div><span className="tile-number">0{selected.indexOf(g.id)+1}</span>{g.redzone&&!spoilers?<span className="redzone-pill"><Flame size={12}/>RED ZONE</span>:<GameStatus game={g}/>}</div><div className="tile-actions"><button className={`icon-button ${favorites.includes(g.id)?'starred':''}`} aria-label={`${favorites.includes(g.id)?'Unfavorite':'Favorite'} ${g.name}`} onClick={()=>star(g.id)}><Star size={14} fill={favorites.includes(g.id)?'currentColor':'none'}/></button><button className="icon-button" aria-label={`Remove ${g.name}`} onClick={()=>removeGame(g.id)}><X size={15}/></button></div></div>
      <div className="tile-screen">{providerGames.includes(g.id)?<ProviderPlayer gameId={g.id} obscured={view!=='room'||modal!==null||audioMenuOpen||!visible.some(v=>v.id===g.id)} playing={playing} onAvailability={providerAvailability} layoutKey={`${view}:${layout}:${fullscreen}:${theater}:${visible.map(v=>v.id).join(',')}`} onClose={()=>setProviderGames(s=>s.filter(id=>id!==g.id))}/>:feeds[g.id]?<GamePlayer gameId={g.id} onAvailability={directAvailability} onPlayingChange={setPlaying} feed={feeds[g.id]} audible={activeAudio?.id===g.id&&!muted} volume={volume} playing={playing} delay={delays[g.id]||0}/>:<div className="matchup-screen"><div className="team-watermark left">{g.away.abbreviation}</div><div className="team-watermark right">{g.home.abbreviation}</div><div className="matchup"><div><Badge team={g.away} large/><span>{g.away.short}</span></div><span className="versus">VS</span><div><Badge team={g.home} large/><span>{g.home.short}</span></div></div><button className="connect-button" onClick={()=>g.sourceUrl?playGame(g.id):openFeed(g.id)}><Play size={14} fill="currentColor"/>{g.sourceUrl?(desktop?'Play game':'Open player'):'Connect a feed'}</button><span className="screen-caption">{g.broadcast?`${g.broadcast} · `:''}{desktop?'Ready when you are':g.sourceUrl?'Opens the provider’s player':'Your stream goes here'}</span></div>}</div>
      <div className="tile-score"><div className="tile-teams"><span>{g.away.abbreviation}<b>{score(g.away,g,spoilers)}</b></span><i/><span>{g.home.abbreviation}<b>{score(g.home,g,spoilers)}</b></span></div><button aria-label={`Focus ${g.name} and listen`} className={`audio-focus ${focus===g.id?'active':''}`} onClick={()=>pick(g.id)} title={feeds[g.id]||providerGames.includes(g.id)?'Focus this game and its audio':'Focus this game'}>{(feeds[g.id]||providerGames.includes(g.id))&&activeAudio?.id===g.id&&!muted?<Volume2 size={14}/>:<Headphones size={14}/>}<span>{focus===g.id?'IN FOCUS':'FOCUS'}</span></button></div>
      <div className="tile-bottom"><span>{spoilers?'Scores hidden':g.down||g.venue||'NFL game day'}</span><div>{g.sourceUrl&&<a href={g.sourceUrl} target="_blank" rel="noopener noreferrer" title="Open game on Sportsurge">Watch at source<ArrowUpRight size={12}/></a>}<button aria-label={`Feed settings for ${g.name}`} title="Feed settings" onClick={()=>openFeed(g.id)}><SlidersHorizontal size={13}/></button></div></div>
     </article>)}
     {!visible.length&&<div className="room-empty"><Grid2X2 size={40}/><h2>{loading?'Setting up game day…':'Your room starts here'}</h2><p>{games.length?'Add a matchup from the game center to start your multiview.':'We’ll show the NFL schedule as soon as the feeds are available.'}</p><button className="button" onClick={()=>games.length?setSelected([...games].sort(compareGames).slice(0,4).map(g=>g.id)):void refresh()}>{games.length?'Add top games':'Try again'}</button></div>}
     {visible.length>0&&visible.length<(layout==='single'?1:layout==='duo'?2:4)&&<button className="add-tile" onClick={()=>setModal('games')}><span><Plus size={24}/></span><strong>More football, same screen.</strong><small>Find a matchup for your room</small></button>}
    </div>
    {tuckedAway.length>0&&<div className="lineup-shelf" aria-label="Games outside the current layout"><span>IN YOUR LINEUP</span><div>{tuckedAway.map(game=><button key={game.id} onClick={()=>pick(game.id)} aria-label={`Show ${game.name}`} title={`Bring ${game.away.short} at ${game.home.short} into view`}><span className="lineup-slot">0{selected.indexOf(game.id)+1}</span><Badge team={game.away}/><strong>{game.away.abbreviation} / {game.home.abbreviation}</strong><ChevronRight size={13}/></button>)}</div></div>}
    <RoomPlaybackBar onMenuOpen={setAudioMenuOpen} games={audioCandidates} audioId={activeAudio?.id} playing={playing} muted={muted} volume={volume} hasFeeds={chosen.some(game=>!!feeds[game.id]||providerGames.includes(game.id))} smart={auto} spoilers={spoilers} onPlay={()=>setPlaying(value=>!value)} onMute={toggleMute} onVolume={value=>{setVolume(value);setMuted(false);}} onAudio={pick} onSmart={value=>{setAuto(value);if(value)setLayout('focus');}}/>

   </div>
   <div className="room-footnote"><span><ShieldCheck size={13}/>Your layout and feeds stay on this device</span><button onClick={()=>setModal('help')}>Keyboard shortcuts<kbd>?</kbd></button></div>
   <section className="around-league"><div className="section-heading"><h2><Radio size={17}/>Around the league</h2><span>{spoilers?'Scores hidden':hot.length?`${hot.length} in the red zone`:'Live game pulse'}</span></div><div className="pulse-list">{!spoilers&&live.some(g=>g.lastPlay)?live.filter(g=>g.lastPlay).slice(0,3).map(g=><button key={g.id} onClick={()=>addGame(g.id)}><span className={`pulse-icon ${g.redzone?'hot':''}`}>{g.redzone?<Flame size={17}/>:<Radio size={17}/>}</span><div><strong>{g.away.abbreviation} <span>at</span> {g.home.abbreviation}</strong><p>{g.lastPlay}</p></div><ChevronRight size={15}/></button>):<div className="pulse-empty"><span className="pulse-icon"><Radio size={20}/></span><div><strong>{spoilers?'Enjoy the games at your own pace.':'Stay close to the next big play.'}</strong><p>{spoilers?'Play updates are hidden while spoiler-free mode is on.':'Latest plays appear here when the live score feed reports them.'}</p></div></div>}</div></section>
   </div><aside className="game-center"><div className="center-heading"><div><h2>Game center</h2><span>{games.length} matchups this week</span></div><span className="live-counter">{live.length} LIVE</span></div><Tabs value={filter} onValueChange={setFilter}><TabsList className="game-tabs"><TabsTrigger value="all">All games</TabsTrigger><TabsTrigger value="live">Live</TabsTrigger><TabsTrigger value="redzone" aria-label="Red zone games" disabled={spoilers} title={spoilers?"Turn off spoiler-free mode to see red-zone activity":"Red zone games"}><Flame size={15}/></TabsTrigger><TabsTrigger value="favorites" aria-label="Favorite games"><Star size={15}/></TabsTrigger></TabsList></Tabs><label className="search-box"><Search size={15}/><input id="game-search" aria-label="Find a team or game" placeholder="Find a team or game" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="Clear search" onClick={()=>setSearch('')}><X size={14}/></button>}</label><div className="center-games">{filtered.map(g=><div className={`center-game ${selected.includes(g.id)?'in-room':''}`} key={g.id}><div className="center-game-top"><GameStatus game={g}/><button className={`icon-button ${favorites.includes(g.id)?'starred':''}`} aria-label={`${favorites.includes(g.id)?'Unfavorite':'Favorite'} ${g.name}`} onClick={()=>star(g.id)}><Star size={14} fill={favorites.includes(g.id)?'currentColor':'none'}/></button></div>{[g.away,g.home].map(t=><div className="center-team" key={t.name}><Badge team={t}/><strong>{t.short}</strong><span>{spoilers?"":t.record}</span><b>{score(t,g,spoilers)}</b></div>)}<div className="center-game-bottom"><span>{g.redzone&&!spoilers?<><Flame size={12}/>Red zone</>:g.broadcast||'NFL'}</span><button onClick={()=>selected.includes(g.id)?pick(g.id):addGame(g.id)} className={selected.includes(g.id)?'added':''}>{selected.includes(g.id)?<><Check size={13}/>In your room</>:<><Plus size={13}/>{selected.length>=4?'Replace a game':'Add game'}</>}</button></div></div>)}{!filtered.length&&<div className="filter-empty"><Search size={25}/><strong>{loading?'Loading games…':'No games here yet'}</strong><p>{search?'Try another team name.':filter==='redzone'?'Games appear here when a team enters the red zone.':filter==='favorites'?'Star a game to keep it here.':filter==='live'?'Live games appear at kickoff.':'Refresh to check for games.'}</p></div>}</div><a className="redzone-link" href="https://isportsurge.ws/event/nfl/nfl-redzone-live-streaming-links" target="_blank" rel="noopener noreferrer"><span className="redzone-logo">RZ</span><div><strong>NFL RedZone</strong><span>Open the dedicated channel</span></div><ArrowUpRight size={17}/></a></aside></div>{view==='schedule'&&<div className="schedule-view"><div className="schedule-toolbar"><button className="button return-room" onClick={()=>setView('room')}><Tv size={16}/>Return to room<span>{chosen.length} games selected</span></button><span>{games.length} matchups · Week {board?.week||'—'}</span><button className="button subtle" onClick={()=>void refresh()}><RefreshCw size={15}/>Refresh</button></div><div className="schedule-grid">{games.map(g=><article className="schedule-card" key={g.id}><GameStatus game={g}/><div className="schedule-matchup"><div><Badge team={g.away} large/><strong>{g.away.short}</strong><b>{score(g.away,g,spoilers)}</b></div><span>AT</span><div><Badge team={g.home} large/><strong>{g.home.short}</strong><b>{score(g.home,g,spoilers)}</b></div></div><p>{g.venue||'NFL'}{g.broadcast?` · ${g.broadcast}`:''}</p><button className="button" onClick={()=>{addGame(g.id);setView('room');}}>{selected.includes(g.id)?'View in your room':selected.length>=4?'Replace a game':'Add to your room'}<ArrowUpRight size={15}/></button></article>)}</div>{!games.length&&<div className="room-empty"><h2>No schedule available</h2><button className="button" onClick={()=>void refresh()}>Try again</button></div>}</div>}
   <footer className="footer"><span className={stale?'stale':''}><i/>{stale?'Feed update delayed':time?`Scores updated ${time}`:'Waiting for score feed'}<span className="footer-separator">/</span>Refreshes every 30 seconds</span><span>Made for your Sundays.<span className="footer-ball">↗</span></span></footer>
  </main>
  <Dialog open={modal!==null} onOpenChange={open=>{if(!open)setModal(null);}}><DialogContent className={`room-dialog ${modal==='games'?'game-picker-dialog':''}`} onOpenAutoFocus={()=>{dialogReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}} onCloseAutoFocus={event=>{event.preventDefault();const previous=dialogReturnFocus.current;requestAnimationFrame(()=>{const target=previous?.isConnected&&previous.getClientRects().length?previous:document.getElementById('room-game-picker');target?.focus({preventScroll:true});});}}><DialogHeader><DialogTitle>{modal==='games'?'Find your next game':modal==='replace'?'Make room for your next game':modal==='feed'?'Connect your game feed':modal==='settings'?'Make it your room':'Welcome to Sunday Room'}</DialogTitle><DialogDescription>{modal==='games'?'Search the week’s matchups. Your room stays right where you left it.':modal==='replace'?'Choose a game to replace. Your other streams will stay connected.':modal==='feed'?'Add a direct HLS (.m3u8) or video URL you have access to.':modal==='settings'?'Your preferences are saved on this device.':'Four games. One screen. You call the shots.'}</DialogDescription></DialogHeader>
   {modal==='games'&&<GamePicker games={[...games].sort(compareGames)} selected={selected} favorites={favorites} loading={loading} onRefresh={()=>void refresh()} onSelect={id=>{if(selected.includes(id)){pick(id);setView('room');setModal(null);}else addGame(id);}}/>}
   {modal==='replace'&&placement&&<div className="replacement-content">
    <div className="incoming-game"><span>ADDING TO YOUR ROOM</span><strong>{games.find(game=>game.id===placement.id)?.name}</strong></div>
    <div className="replacement-list">{chosen.map((game,index)=><button key={game.id} onClick={()=>placeGame(placement.id,game.id,placement.feed)} aria-label={`Replace ${game.name}`}><span className="replacement-number">0{index+1}</span><Badge team={game.away}/><Badge team={game.home}/><span><strong>{game.away.short} at {game.home.short}</strong><small>{connected(game)?'Stream connected':game.detail}</small></span><span className="replace-action">Replace<ChevronRight size={14}/></span></button>)}</div>
    <button className="button subtle" onClick={()=>{setPlacement(null);setModal(null);}}>Keep my lineup</button>
   </div>}
   {modal==='feed'&&<form onSubmit={saveFeed} className="feed-form"><label>Game<Select value={feedGame} onValueChange={id=>{setFeedGame(id);setFeedUrl(feeds[id]?.url||'');setFeedLabel(feeds[id]?.label||'My game feed');}}><SelectTrigger><SelectValue placeholder="Choose a matchup"/></SelectTrigger><SelectContent>{games.map(g=><SelectItem key={g.id} value={g.id}>{g.away.short} at {g.home.short}</SelectItem>)}</SelectContent></Select></label><label>Feed name<input value={feedLabel} onChange={e=>setFeedLabel(e.target.value)} maxLength={60} placeholder="My game feed"/></label><label>Video URL<input type="url" value={feedUrl} onChange={e=>setFeedUrl(e.target.value)} placeholder="https://your-provider.com/live.m3u8" required autoComplete="off"/></label><div className="feed-note"><ExternalLink size={17}/><p>Sportsurge’s players restrict embedding. Use <a href={games.find(g=>g.id===feedGame)?.sourceUrl||SOURCE} target="_blank" rel="noopener noreferrer">the game’s source page</a> to watch there, or connect a compatible direct feed here. A regular webpage link won’t play.</p></div>{formError&&<p className="form-error" role="alert">{formError}</p>}<div className="form-actions">{feeds[feedGame]&&<button type="button" className="button subtle" onClick={()=>{setFeeds(f=>{const next={...f};delete next[feedGame];return next;});setModal(null);toast('Feed disconnected');}}>Disconnect</button>}<button type="submit" className="button primary"><Play size={15}/>Connect feed</button></div>{feeds[feedGame]&&<label className="delay-setting">Playback delay <span>{delays[feedGame]||0}s behind live edge</span><Slider aria-label="Playback delay" value={[delays[feedGame]||0]} onValueChange={v=>setDelays(d=>({...d,[feedGame]:v[0]}))} min={0} max={45} step={5}/><small>Adjust feeds to match. Timing depends on the available video buffer.</small></label>}</form>}
   {modal==='help'&&<div className="help-content"><div><span>01</span><p><strong>Build your game day.</strong>Add up to four games. Choose a grid, two-up, single game, or a larger focus view.</p></div><div><span>02</span><p><strong>{desktop?"Press play. Watch the game.":"Open the game’s player."}</strong>{desktop?"Play game opens the provider directly in your tile. If a server fails, we try a backup automatically. No feed URLs needed.":"Open player takes you straight to the broadcast player. For in-room multiview without pasting feeds, launch Sunday Room Desktop from the project folder."}</p></div><div><span>03</span><p><strong>Follow the action.</strong>Focus a game for its audio. Smart focus follows red-zone activity among connected games in your lineup, with at least 20 seconds between switches.</p></div><div className="shortcuts"><span><kbd>/</kbd>Find a game</span><span><kbd>1–4</kbd>Focus game</span><span><kbd>M</kbd>Mute audio</span><span><kbd>F</kbd>Fullscreen</span><span><kbd>T</kbd>Theater mode</span><span><kbd>Space</kbd>Play / pause</span></div><p className="help-fine">Scores can lead or lag your video. Stream availability and playback permissions are controlled by each provider. Sunday Room is an independent personal viewer.</p><button className="button primary" onClick={()=>setModal(null)}>Make yourself at home<ChevronRight size={16}/></button></div>}
   {modal==='settings'&&<div className="settings-content"><div className="setting-row"><div><strong>Spoiler-free mode</strong><p>Hide scores, team records, and play updates.</p></div><Switch aria-label="Spoiler-free mode" checked={spoilers} onCheckedChange={v=>{setSpoilers(v);if(v){setAuto(false);setFilter('all');}}}/></div><div className="setting-row"><div><strong>Room volume</strong><p>Only your selected feed plays audio.</p></div><span>{volume}%</span></div><Slider aria-label="Default room volume" value={[volume]} onValueChange={v=>{setVolume(v[0]);setMuted(false);}} max={100}/><div className="feed-note"><ShieldCheck size={18}/><p>Layouts, favorites, and feed URLs are stored only in this browser. Avoid saving links on a shared device.</p></div><button className="button subtle" onClick={()=>{setFeeds({});setProviderGames([]);setFavorites([]);setSelected([...games].sort(compareGames).slice(0,4).map(g=>g.id));setLayout('quad');setAudio('');setAuto(false);setSpoilers(false);setVolume(70);setMuted(false);setPlaying(true);setTheater(false);setFilter('all');setSearch('');setDelays({});toast('Room reset. Saved feeds removed.');setModal(null);}}>Reset room and remove saved feeds</button></div>}
  </DialogContent></Dialog>
  {notice&&<div className="toast" role="status"><Check size={16}/>{notice}</div>}
 </div>;
}
