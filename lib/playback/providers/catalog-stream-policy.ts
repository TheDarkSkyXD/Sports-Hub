export type CatalogSource='streamed'|'livesportpro';

export function streamedEventUrl(source:CatalogSource,id:string):string {
  return source==='streamed'?`https://streamed.st/watch/${id}`:`https://api.kultsport.com/api/matches/all#${id}`;
}

export function validStreamReference(source:string,id:string):boolean {
  return /^[a-z][a-z0-9:-]{0,39}$/.test(source)&&
    /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,159}$/.test(id)&&!id.includes('//')&&!id.includes('..');
}

export function streamApiUrl(catalog:CatalogSource,source:string,id:string):string {
  if(!validStreamReference(source,id))throw new Error('parser-changed');
  return `${catalog==='streamed'?'https://streamed.st':'https://api.kultsport.com'}/api/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
}

export function validStreamTarget(catalog:CatalogSource,source:string,id:string,number:number,value:string):boolean {
  let url:URL;
  try{url=new URL(value);}catch{return false;}
  if(value!==url.href||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return false;
  if(url.hostname==='embed.st')return url.pathname===`/embed/${source.replace(/^sp:/,'')}/${id}/${number}`;
  if(url.hostname==='embedindia.st')return source==='ppv:s'&&url.pathname===`/embed/${id}`;
  return catalog==='livesportpro'&&/^lb\d{1,3}\.strmd\.st$/.test(url.hostname)&&
    /^\/secure\/[A-Za-z0-9_-]{16,160}\/ingest\/stream\/[a-zA-Z0-9_-]{1,100}\/[1-9]\d{0,2}\/playlist\.m3u8$/.test(url.pathname);
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
