const {publicUrl}=require('./source-network.cjs');

function playerDocument(value){
  const ingest=/^https:\/\/embed\.st\/embed\/ingest\/[a-zA-Z0-9_-]{1,120}\/[1-9][0-9]{0,2}\/#player=clappr&autoplay=true$/.test(value);
  const url=ingest?new URL(value):publicUrl(value);
  if(!url||url.port||url.href!==value)return null;
  const {origin,pathname,search}=url;
  const plain=!search;
  const valid=ingest||plain&&(
    origin==='https://embed.st'&&/^\/embed\/[a-z0-9-]{1,32}\/[a-zA-Z0-9_-]{1,120}\/[1-9][0-9]{0,2}$/.test(pathname)||
    origin==='https://gooz.aapmains.net'&&/^\/new-stream-embed\/\d{1,20}$/.test(pathname)||
    origin==='https://streame.center'&&/^\/(?:embed\/ch\d{1,4}|stream-east\/ch\d{1,4})\.php$/.test(pathname)||
    origin==='https://ch.aianimalvibes.com'&&/^\/(?:football|cfb)\/[0-9]{1,10}$/.test(pathname)||
    origin==='https://dembed.top'&&/^\/embed\/channel[1-9]\d{0,3}$/.test(pathname)||
    ['https://fallafar.me','https://posamari.me','https://dervlin.me','https://ninguno.cc','https://lonpapil.eu'].includes(origin)&&/^\/sd0embed\/(?:NFL|NBA)$/.test(pathname)
  )||['https://in-stream.click','https://xstream.st'].includes(origin)&&
    (origin==='https://in-stream.click'?pathname==='/fslive.php':pathname==='/fslivepro.php')&&
    /^\?stream=[A-Za-z0-9_-]{1,40}$/.test(search)||
    origin==='https://embed.sportspatrika.com'&&pathname==='/live/embed.php'&&/^\?ch=es[0-9]+$/.test(search)||
    origin==='https://streame.center'&&/^\/(?:embed\/(?:hls|hls2)|stream-east\/hls)\.php$/.test(pathname)&&/^\?stream=[A-Za-z0-9]{1,40}$/.test(search);
  return valid?url:null;
}

module.exports={playerDocument};
