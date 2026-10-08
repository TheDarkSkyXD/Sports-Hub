function exactPage(value: string): URL | null {
  try {
    const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
    const url = new URL(value);
    if (!authority || authority !== url.hostname || value !== url.href || url.protocol !== 'https:' || url.username || url.password ||
      url.port || url.search || url.hash || url.href.length > 2000 || url.pathname.includes('%')) return null;
    return url;
  } catch { return null; }
}

export function validEventPagePair(eventUrl: string, serverUrl: string): boolean {
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
  if(event.hostname==='ms.buffstream.io'&&server.hostname==='embedsports.me'){
    const team=/^\/(nfl|cfb|nba)-streams\/([a-z0-9]+(?:-[a-z0-9]+)*)-live-stream$/.exec(event.pathname);
    const pair=/^\/(american-football|basketball)\/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$/.exec(server.pathname);
    return !!team&&!!pair&&(team[1]==='nba' ? pair[1]==='basketball' : pair[1]==='american-football')&&
      (team[2]===pair[2]||team[2]===pair[3]);
  }
  if (event.hostname === 'tvapp1.pk') return eventUrl===serverUrl && /^\/watch\/\d{1,20}$/.test(event.pathname);
  if ((event.hostname === 'methstreams.st' || event.hostname === 'crackstreams.st') && server.hostname === 'fxtrend.st') {
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
    return /^\/event\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.pathname) &&
      /^\/event\/live_(?:cfb|nfl)_[a-z0-9]+(?:-[a-z0-9]+)*-live-streaming-\d{1,20}\/(?:vector|vertex|foxtrot)\/[1-9]\d{0,2}$/.test(server.pathname);
  }
  if (event.hostname === 'vipbox.fm' && server.hostname === event.hostname) {
    const match = /^\/onair\/(ncaaf|nfl|nba)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname);
    return !!match && new RegExp(`^/live/${match[1]}/${match[2]}-[1-9]\\d{0,3}$`).test(server.pathname);
  }
  if (event.hostname === 'www.vipboxtv.sk' && server.hostname === event.hostname) {
    const match = /^\/cfb\/([a-z0-9]+(?:-[a-z0-9]+)*)-stream-live$/.exec(event.pathname);
    return !!match && new RegExp(`^/cfb/[1-9]\\d{0,3}/stream-${match[1]}-live$`).test(server.pathname);
  }
  if (event.hostname === 'strikeout.im' && server.hostname === event.hostname) {
    const match = /^\/(college-football|nfl|nba)\/stream-([a-z0-9]+(?:-[a-z0-9]+)*)-live$/.exec(event.pathname);
    return !!match && new RegExp(`^/${match[1]}/[1-9]\\d{0,3}/${match[2]}-stream$`).test(server.pathname);
  }
  if (event.hostname === 'ppv.st' && server.hostname === 'embedindia.st') {
    const match = /^\/live\/(cfb|nfl|nba|wnba)\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(event.pathname);
    if (!match) return false;
    const path=`/embed/${match[1]}/${match[2]}/${match[3]}`;
    return server.pathname===path || server.pathname===`${path}/skycast`;
  }
  return false;
}
