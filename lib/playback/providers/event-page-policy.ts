function exactPage(value: string): URL | null {
  try {
    const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
    const url = new URL(value);
    if (!authority || authority !== url.hostname || value !== url.href || url.protocol !== 'https:' || url.username || url.password ||
      url.port || url.search || url.hash || url.href.length > 2000 || url.pathname.includes('%')) return null;
    return url;
  } catch { return null; }
}

function sportsfeedPair(eventUrl:string,serverUrl:string):boolean {
  try {
    const event=new URL(eventUrl),server=new URL(serverUrl);
    const names=event.pathname.slice('/fixture/'.length).split('-vs-');
    if(eventUrl!==event.href||event.hostname!=='sportsfeed24.st'||event.username||event.password||event.port||
      event.search||event.hash||event.href.length>2000||names.length!==2)return false;
    const teams=names.map(name=>{
      const decoded=decodeURIComponent(name);
      return encodeURIComponent(decoded)===name&&/^[\p{L}\p{N} _.'!~()&-]+$/u.test(decoded)?
        decoded.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join('-'):'';
    });
    if(teams.some(team=>!team)||serverUrl!==server.href||server.protocol!=='https:'||server.username||server.password||
      server.port||server.hash||server.href.length>2048)return false;
    if(server.hostname==='domainx.rest')return server.pathname==='/file/'&&/^\?[1-9]\d{0,12}$/.test(server.search);
    if(['trend48.st','embed.st'].includes(server.hostname)) {
      if(server.search)return false;
      const slug=(server.hostname==='trend48.st'?/^\/event\/ppv-([a-z0-9-]+-vs-[a-z0-9-]+)$/:
        /^\/embed\/admin\/ppv-([a-z0-9-]+-vs-[a-z0-9-]+)\/[1-9]\d{0,2}$/).exec(server.pathname)?.[1];
      return !!slug&&publishedMatchup(teams,slug);
    }
    return publishedProviderPair(teams,server);
  } catch { return false; }
}

export function validEventPagePair(eventUrl: string, serverUrl: string): boolean {
  const published=publishedPair(eventUrl,serverUrl);
  if(published!==null)return published;
  if(eventUrl.startsWith('https://sportsfeed24.st/fixture/'))return sportsfeedPair(eventUrl,serverUrl);
  if(eventUrl.startsWith('https://streamed.st/watch/')||eventUrl.startsWith('https://api.kultsport.com/api/matches/all#')){
    let event:URL,server:URL;
    try{event=new URL(eventUrl);server=new URL(serverUrl);}catch{return false;}
    const streamed=event.hostname==='streamed.st'&&event.hash===''&&
      /^\/watch\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(event.pathname);
    const live=event.hostname==='api.kultsport.com'&&event.pathname==='/api/matches/all'&&
      /^#[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(event.hash);
    return eventUrl===event.href&&serverUrl===server.href&&event.protocol==='https:'&&server.protocol==='https:'&&
      !event.username&&!event.password&&!event.port&&!event.search&&
      !server.username&&!server.password&&!server.port&&!server.search&&!server.hash&&
      (streamed||live)&&
      (server.hostname==='embed.st'&&/^\/embed\/[a-z][a-z0-9-]{0,39}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\/[1-9]\d{0,2}$/.test(server.pathname)||
        live&&server.hostname==='embedindia.st'&&/^\/embed\/(?:nfl|cfb|nba|wnba|nhl|mlb|f1)\/[a-zA-Z0-9/-]{1,150}$/.test(server.pathname));
  }
  if(eventUrl.startsWith('https://crichd.pk/event/')||eventUrl.startsWith('https://m.crichd.pk/event/')){
    const event=exactPage(eventUrl),server=exactPage(serverUrl);
    const slug=event&&/^\/event\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname)?.[1];
    return !!event&&!!server&&!!slug&&['crichd.pk','m.crichd.pk'].includes(event.hostname)&&
      server.hostname==='playerbee.top'&&
      new RegExp(`^/charlie/${slug}/[1-9]\\d{0,9}$`).test(server.pathname);
  }
  if(eventUrl.startsWith('https://sportsbite.org/event/')){
    const event=exactPage(eventUrl);
    let server:URL;
    try{server=new URL(serverUrl);}catch{return false;}
    const eventSlug=event&&/^\/event\/fg-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname)?.[1];
    const sides=eventSlug?.split('-vs-');
    const serverSlug=/^\/(?:lol-embed|rs-embed)\/embed\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(server.pathname)?.[1];
    const matchup=!!sides&&sides.length===2&&!!serverSlug&&[eventSlug,`${sides[1]}-vs-${sides[0]}`].some(pair=>
      serverSlug===pair||server.pathname.startsWith('/rs-embed/')&&
      new RegExp(`^(?:nfl|nba|nhl|mlb|cfb)-streams-[1-9]\\d{0,2}-${pair}-(?:nfl|nba|nhl[1-9]?|mlb|espn[1-9]?)-(?:admin|temp|tedesco)$`).test(serverSlug));
    return !!event&&!!eventSlug&&!!serverSlug&&(!eventSlug.includes('-vs-')||matchup)&&
      serverUrl===server.href&&server.protocol==='https:'&&server.hostname==='sportsbite.org'&&
      !server.username&&!server.password&&!server.port&&!server.hash&&
      /^\?v=high&emb=[1-9]\d{0,5}$/.test(server.search);
  }
  if(eventUrl.startsWith('https://nflstreams.org/')||serverUrl.startsWith('https://piratecat.store/')){
    const event=exactPage(eventUrl);
    let server:URL;
    try{server=new URL(serverUrl);}catch{return false;}
    if(!event||event.hostname!=='nflstreams.org'||
      !/^\/teams\/[a-z0-9]+(?:-[a-z0-9]+)*-live\/$/.test(event.pathname)||
      serverUrl!==server.href||server.protocol!=='https:'||server.hostname!=='piratecat.store'||
      server.username||server.password||server.port||server.hash||server.pathname!=='/sports/player.php'||
      server.href.length>2000||server.searchParams.size!==1)return false;
    const value=server.searchParams.get('hd')||'';
    return server.search===`?hd=${value}`&&/^[A-Za-z0-9-]{1,20}=[A-Za-z0-9-]{1,20}$/.test(value)&&value.includes('-');
  }
  if(eventUrl.startsWith('https://livetv.sx/')||serverUrl.startsWith('https://livetv.sx/')){
    const event=exactPage(eventUrl);
    let server:URL;
    try {server=new URL(serverUrl);}catch{return false;}
    const match=event&&/^\/enx\/eventinfo\/([1-9]\d{0,19})_[a-z0-9_]*\/$/.exec(event.pathname);
    if(!event||!match||event.hostname!=='livetv.sx'||serverUrl!==server.href||server.protocol!=='https:'||server.hostname!=='livetv.sx'||
      server.username||server.password||server.port||server.hash||server.pathname!=='/webplayer.php'||
      server.href.length>2000||server.searchParams.size!==7)return false;
    const keys=[...server.searchParams.keys()];
    if(keys.length!==7||new Set(keys).size!==7||keys.some(key=>!['t','c','lang','eid','lid','ci','si'].includes(key)))return false;
    const query=server.searchParams;
    return query.get('t')==='ifr'&&query.get('lang')==='en'&&query.get('si')==='27'&&
      query.get('eid')===match[1]&&/^[1-9]\d{0,19}$/.test(query.get('c')||'')&&
      query.get('c')===query.get('lid')&&/^[1-9]\d{0,5}$/.test(query.get('ci')||'');
  }
  const event = exactPage(eventUrl), server = exactPage(serverUrl);
  if (!event || !server) return false;
  if(['ms.buffstream.io','streameasthd.app'].includes(event.hostname)&&server.hostname==='embedsports.me'){
    const broadcast=/^\/(mma|boxing|wwe|f1|motor)-streams\/([a-z0-9]+(?:-[a-z0-9]+)*)-live-stream$/.exec(event.pathname);
    if(broadcast) {
      const player=/^\/(boxing|motorsports)\/([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$/.exec(server.pathname);
      if(!player)return false;
      const eventSlug=broadcast[2].replaceAll('-',''),playerSlug=player[2].replaceAll('-','');
      switch(broadcast[1]) {
        case 'mma':case 'wwe':return player[1]==='boxing'&&eventSlug===playerSlug;
        case 'boxing': {
          const sides=player[2].split('-vs-');
          return player[1]==='boxing'&&sides.length===2&&sides.every(side=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(side))&&
            sides.some(side=>side.replaceAll('-','')===eventSlug);
        }
        case 'f1':case 'motor':return player[1]==='motorsports'&&(eventSlug===playerSlug||
          /^(?:f1|formula-1)-/.test(broadcast[2])&&player[2]==='sky-sports-f1-sky-f1'||
          broadcast[2].startsWith('motogp-')&&player[2]==='motogp-qualifying-motogp-main-race');
        default:return false;
      }
    }
    const team=/^\/(nfl|cfb|nba|nhl|mlb)-streams\/([a-z0-9]+(?:-[a-z0-9]+)*)-live-stream$/.exec(event.pathname);
    const pair=/^\/(american-football|basketball|ice-hockey|baseball)\/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$/.exec(server.pathname);
    return !!team&&!!pair&&(team[1]==='nba' ? pair[1]==='basketball' : team[1]==='nhl'?pair[1]==='ice-hockey':team[1]==='mlb'?pair[1]==='baseball':pair[1]==='american-football')&&
      (team[2]===pair[2]||team[2]===pair[3]);
  }
  if(event.hostname==='mlbbox.me'&&server.hostname==='embedsports.me'){
    const matchup=/^\/mlb\/([a-z0-9-]+)-vs-([a-z0-9-]+)-stream$/.exec(event.pathname);
    const player=/^\/baseball\/([a-z0-9-]+)-vs-([a-z0-9-]+)-stream-[12]$/.exec(server.pathname);
    return !!matchup&&!!player&&
      (matchup[1]===player[1]&&matchup[2]===player[2]||matchup[1]===player[2]&&matchup[2]===player[1]);
  }
  if (event.hostname === 'tvapp1.pk') return eventUrl===serverUrl && /^\/watch\/[a-zA-Z0-9-]{1,120}$/.test(event.pathname);
  if (event.hostname === 'buffstreams.ch' || event.hostname === 'methstreams.vg') {
    return server.hostname === 'foxiy.st' && /^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname) &&
      new RegExp(`^${event.pathname}-nascar-cup-series-[0-9]{10}/hotel/[1-9][0-9]{0,2}$`).test(server.pathname);
  }
  if ((event.hostname === 'methstreams.st' || event.hostname === 'crackstreams.st') && ['fxtrend.st','foxiy.st'].includes(server.hostname)) {
    if(server.hostname==='foxiy.st'&&/^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname)&&
      new RegExp(`^${event.pathname}-nascar-cup-series-[0-9]{10}/hotel/[1-9][0-9]{0,2}$`).test(server.pathname))return true;
    if(/^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname)&&server.pathname===event.pathname)return true;
    if (/^\/event\/ppv-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname))
      return new RegExp(`^${event.pathname}/(?:core|vector|vertex|hotel)/[1-9]\\d{0,2}$`).test(server.pathname);
    const publishedPpv=/^\/event\/ppv-([a-z0-9-]+)\/(?:core|vector|vertex|hotel)\/[1-9]\d{0,2}$/.exec(server.pathname);
    if(publishedPpv){
      const pair=(slug:string)=>{
        const teams=slug.split('-vs-');
        return teams.length===2&&teams.every(team=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team))?teams.sort():null;
      };
      const eventTeams=event.pathname.startsWith('/event/')?pair(event.pathname.slice('/event/'.length)):null;
      const serverTeams=pair(publishedPpv[1]);
      return !!eventTeams&&!!serverTeams&&eventTeams[0]===serverTeams[0]&&eventTeams[1]===serverTeams[1];
    }
    if (/^\/event\/m-[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}$/.test(event.pathname)) {
      return server.pathname===event.pathname ||
        new RegExp(`^${event.pathname}/(?:core|vector|vertex|foxtrot|main|hotel)/[1-9]\\d{0,2}$`).test(server.pathname);
    }
    return server.hostname==='fxtrend.st' && /^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname) &&
      /^\/event\/live_(?:cfb|nfl)_[a-z0-9]+(?:-[a-z0-9]+)*-live-streaming-\d{1,20}\/(?:vector|vertex|foxtrot)\/[1-9]\d{0,2}$/.test(server.pathname);
  }
  if (event.hostname === 'vipbox.fm' && server.hostname === event.hostname) {
    const match = /^\/onair\/(ncaaf|nfl|nba|nhl)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname);
    return !!match && new RegExp(`^/live/${match[1]}/${match[2]}-[1-9]\\d{0,3}$`).test(server.pathname);
  }
  if (event.hostname === 'www.vipboxtv.sk' && server.hostname === event.hostname) {
    const match = /^\/cfb\/([a-z0-9]+(?:-[a-z0-9]+)*)-stream-live$/.exec(event.pathname);
    return !!match && new RegExp(`^/cfb/[1-9]\\d{0,3}/stream-${match[1]}-live$`).test(server.pathname);
  }
  if (event.hostname === 'strikeout.im' && server.hostname === event.hostname) {
    const match = /^\/(college-football|nfl|nba|nhl|mlb)\/stream-([a-z0-9]+(?:-[a-z0-9]+)*)-live$/.exec(event.pathname);
    return !!match && new RegExp(`^/${match[1]}/[1-9]\\d{0,3}/${match[2]}-stream$`).test(server.pathname);
  }
  if (event.hostname === 'ppv.st' && ['embedindia.st', 'taifood-blog.asia'].includes(server.hostname)) {
    const wrestling=/^\/live\/((?:wwe|tna|aew)\/\d{4}-\d{2}-\d{2}|[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]{0,18})$/.exec(event.pathname);
    if(wrestling)return server.hostname==='taifood-blog.asia'&&server.pathname===`/embed/${wrestling[1]}`;
    const race=/^\/live\/f1\/(\d{4})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(fp[123]|sprint-q|sprint|qualifying|race)$/.exec(event.pathname);
    if(race){
      const path=`/embed/f1/${race[1]}/${race[2]}/${race[3]}`;
      if(server.pathname===path)return true;
      const session=race[3].startsWith('fp')?`practice-${race[3][2]}`:race[3]==='sprint-q'?'sprint-qualifying':race[3];
      return new RegExp(`^/embed/${race[2]}-grand-prix---${session}-[1-9]\\d{0,9}$`).test(server.pathname);
    }
    const match = /^\/live\/(cfb|nfl|nba|wnba|nhl|mlb)\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname);
    if (!match) return false;
    const path=`/embed/${match[1]}/${match[2]}/${match[3]}`;
    return server.pathname===path || server.pathname===`${path}/skycast`;
  }
  return false;
}

function publishedPair(eventUrl:string,serverUrl:string):boolean|null {
  let event:URL,server:URL;
  try {event=new URL(eventUrl);server=new URL(serverUrl);}catch{return null;}
  const hosts=['iohit.st','trend48.st','foxiy.st','buffstreams.ch','sportsurgei.is','nbabitez.com','dudestream1.com','mlbbite.org','ihdstreams.top'];
  if(!hosts.includes(event.hostname))return null;
  if(eventUrl!==event.href||serverUrl!==server.href||event.protocol!=='https:'||server.protocol!=='https:'||
    event.username||event.password||event.port||event.search||event.hash||server.username||server.password||server.port||
    server.hash&&!['#player=clappr','#player=clappr&autoplay=true'].includes(server.hash))return false;
  if(event.hostname==='sportsurgei.is'&&server.hostname==='live3.totalsportek.vg')
    return !server.search&&!server.hash&&event.pathname===server.pathname&&/^\/[A-Za-z0-9-]+\/[1-9][0-9]{0,11}$/.test(event.pathname);
  if(event.hostname==='sportsurgei.is'&&!['live.totalsportek.vg','live4.totalsportek.vg'].includes(server.hostname))
    return sportsurgePublishedPair(event,server);
  if(server.search)return false;
  if(event.hostname==='ihdstreams.top')return /^\/watch\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname)&&
    server.hostname===event.hostname&&/^\/embed\/(?:nba|nfl|nhl|mlb|cfb|wnba|ufc|boxing|wwe|f1)\/ch[1-9]\d{0,2}\.php$/.test(server.pathname);
  if(event.hostname==='trend48.st'&&server.hostname==='trendy48.site')return /^\/event\/m-[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}$/.test(event.pathname)&&
    /^\/embed\/[a-z0-9]{1,64}-[1-9]\d{0,11}$/.test(server.pathname);
  if(event.hostname==='trend48.st'&&server.hostname==='embed.st') {
    const eventSlug=/^\/event\/(ppv-[a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname)?.[1];
    return !!eventSlug&&new RegExp(`^/embed-noads/admin/${eventSlug}/[1-9][0-9]{0,2}$`).test(server.pathname);
  }
  if(['sportsurgei.is','nbabitez.com'].includes(event.hostname)&&['live.totalsportek.vg','live4.totalsportek.vg'].includes(server.hostname))
    return event.pathname===server.pathname&&/^\/[A-Za-z0-9-]+\/[1-9][0-9]{0,11}$/.test(event.pathname);
  if(['foxiy.st','fxtrend.st'].includes(server.hostname)&&['foxiy.st','trend48.st','buffstreams.ch','mlbbite.org'].includes(event.hostname)) {
    const path=event.hostname==='mlbbite.org'?`/event${event.pathname}`:event.pathname;
    if(/^\/event\/(?:m-|ppv-)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path))
      return server.pathname===path||new RegExp(`^${path}/(?:hotel|core|vector|vertex|foxtrot)/[1-9][0-9]{0,2}$`).test(server.pathname);
  }
  if(event.hostname==='dudestream1.com'&&server.hostname==='embedsports.me')
    return /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(event.pathname)&&/^\/(?:basketball|american-football|ice-hockey|baseball)\/[a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*-stream-[12]$/.test(server.pathname);
  if(event.hostname==='iohit.st'&&server.hostname==='embed.st') {
    const eventSlug=event.pathname.startsWith('/event/')?event.pathname.slice(7).replace(/-[0-9]+$/,''):'';
    if(eventSlug.split('-vs-').length!==2)return false;
    if(/^\/embed-noads\/golf\/[1-9]\d{0,11}\/[1-9]\d{0,2}$/.test(server.pathname))return true;
    const serverSlug=/^\/embed-noads\/hotel\/([a-z0-9]+(?:-[a-z0-9]+)*)-(?:nba|wnba|nfl|cfb|nhl|mlb)-[0-9]{10}\/[1-9][0-9]{0,2}$/.exec(server.pathname)?.[1]
      ??/^\/embed-noads\/admin\/ppv-([a-z0-9]+(?:-[a-z0-9]+)*)\/[1-9]\d{0,2}$/.exec(server.pathname)?.[1];
    const pair=(slug:string)=>slug.split('-vs-').sort().join('|');
    return eventSlug.split('-vs-').length===2&&!!serverSlug&&pair(eventSlug)===pair(serverSlug);
  }
  return ['buffstreams.ch','foxiy.st'].includes(event.hostname)?null:false;
}

const sportsurgePlayerPaths=new Map<string,RegExp>([
  ['alphastreams.mom',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['goalstream.cfd',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['apexztreams.xyz',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['smlbn.cyou',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['bizzstreamz.online',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['sportsworld.best',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['sportzworld.ru',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['ripplestream.cyou',/^\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['footyicon.online',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)-live-stream-\d{4}-\d{2}-\d{2}\/$/],
  ['opturspapa.xyz',/^\/([a-z0-9-]+-vs-[a-z0-9-]+)$/],
  ['hadcrak.cyou',/^\/([a-z0-9-]+-vs-[a-z0-9-]+)-live-stream-\d{4}-\d{2}-\d{2}\/$/],
  ['wildgames.bz',/^\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-v-[a-z0-9-]+)\/$/],
  ['techydeals.store',/^\/totalsportek[1-9]\d{0,11}\/(?:nhl|nba|nfl|mlb|cfb)\/[1-9]\d{0,2}\.php$/],
  ['techydeals.best',/^\/totalsportek[1-9]\d{0,11}\/extraplayer\/[1-9]\d{0,2}\.php$/],
  ['sports247.ru',/^\/watch\/([a-z0-9-]+-vs-[a-z0-9-]+)-\d{4}-\d{2}-\d{2}$/],
  ['mjumbo.icu',/^\/\d{6}-[1-9]\d{0,2}\/ch-[1-9]\d{0,2}\.html$/],
  ['topstreams.click',/^\/index\.php\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['playnex.online',/^\/index\.php\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['liveverse.online',/^\/index\.php\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['sportsstreams.online',/^\/index\.php\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-vs-[a-z0-9-]+)\/$/],
  ['iohit.st',/^\/watch\/([a-z0-9-]+-vs-[a-z0-9-]+)-[1-9]\d{0,11}$/],
]);
const sportsurgePlayerQueries=new Map([['goomdstea.click','ch'],['poscihub.ru','post'],['topstream.help','p'],['1ststreams.xyz','p']]);

function sportsurgePublishedPair(event:URL,server:URL):boolean {
  const slug=/^\/([A-Za-z0-9-]+)\/[1-9][0-9]{0,11}$/.exec(event.pathname)?.[1];
  const eventTeams=slug?.toLowerCase().split('-vs-');
  if(!eventTeams||eventTeams.length!==2||eventTeams.some(team=>!team))return false;
  return publishedProviderPair(eventTeams,server);
}

function publishedProviderPair(eventTeams:string[],server:URL):boolean {
  const query=sportsurgePlayerQueries.get(server.hostname);
  if(query)return server.pathname===(query==='ch'?'/stream.php':'/')&&new RegExp(`^\\?${query}=[1-9][0-9]{0,12}$`).test(server.search);
  if(server.search)return false;
  const match=sportsurgePlayerPaths.get(server.hostname)?.exec(server.pathname);
  if(!match)return false;
  const matchup=match[1];
  if(!matchup)return true;
  return publishedMatchup(eventTeams,matchup);
}

function publishedMatchup(eventTeams:string[],matchup:string):boolean {
  const teams=matchup.replace('-v-','-vs-').split('-vs-');
  if(teams.length!==2)return false;
  const contains=(side:string,team:string)=>`-${side}-`.includes(`-${team}-`);
  return contains(teams[0],eventTeams[0])&&contains(teams[1],eventTeams[1])||
    contains(teams[0],eventTeams[1])&&contains(teams[1],eventTeams[0]);
}
