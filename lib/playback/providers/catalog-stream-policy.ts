export type CatalogSource='streamed'|'sportsupa'|'livesportpro';
export const CATALOG_API_ORIGINS={streamed:'https://streamed.st',sportsupa:'https://streamed.pk',livesportpro:'https://api.kultsport.com'} satisfies Record<CatalogSource,string>;

export function streamedEventUrl(source:CatalogSource,id:string):string {
  return source==='livesportpro'?`https://api.kultsport.com/api/matches/all#${id}`:`${CATALOG_API_ORIGINS[source]}/watch/${id}`;
}

export function validStreamReference(source:string,id:string):boolean {
  return /^[a-z][a-z0-9:-]{0,39}$/.test(source)&&
    /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,159}$/.test(id)&&!id.includes('//')&&!id.includes('..');
}

export function streamApiUrl(catalog:CatalogSource,source:string,id:string):string {
  if(!validStreamReference(source,id))throw new Error('parser-changed');
  return `${CATALOG_API_ORIGINS[catalog]}/api/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
}

export function validStreamTarget(catalog:CatalogSource,source:string,id:string,number:number,value:string):boolean {
  if(!Number.isInteger(number)||number<1||number>100)return false;
  let url:URL;
  try{url=new URL(value);}catch{return false;}
  if(value!==url.href||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return false;
  if(url.hostname==='embed.st')return url.pathname===`/embed/${source.replace(/^sp:/,'')}/${id}/${number}`;
  if(url.hostname==='embedindia.st')return source==='ppv:s'&&url.pathname===`/embed/${id}`;
  if(url.hostname==='taifood-blog.asia')return catalog==='livesportpro'&&source==='ppv:s'&&
    /^(?:wwe|tna|aew)\/\d{4}-\d{2}-\d{2}$/.test(id)&&url.pathname===`/embed/${id}`;
  const direct = /^\/secure\/[A-Za-z0-9_-]{16,160}\/(ingest|hotel)\/stream\/[a-zA-Z0-9_-]{1,100}\/[1-9]\d{0,2}\/playlist\.m3u8$/.exec(url.pathname);
  return catalog==='livesportpro'&&/^lb\d{1,3}\.strmd\.st$/.test(url.hostname)&&
    direct!==null&&(direct[1]==='ingest'||source==='sp:hotel');
}

export function validLiveRelay(value:string,media:string):boolean {
  let url:URL;
  try{url=new URL(value);}catch{return false;}
  if(value!==url.href||url.origin!=='https://api.kultsport.com'||url.pathname!=='/api/hls/playlist.m3u8'||
    url.username||url.password||url.port||url.hash||url.searchParams.size!==4)return false;
  const keys=[...url.searchParams.keys()];
  return new Set(keys).size===4&&keys.every(key=>['url','exp','sig','referer'].includes(key))&&
    url.searchParams.get('url')===media&&/^\d{13}$/.test(url.searchParams.get('exp')||'')&&
    Number(url.searchParams.get('exp'))>Date.now()&&
    /^[A-Za-z0-9_-]{20,200}$/.test(url.searchParams.get('sig')||'')&&
    url.searchParams.get('referer')==='https://exposestrat.com/';
}
