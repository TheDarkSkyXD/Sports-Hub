const {lookup}=require('node:dns/promises');
const {randomUUID,timingSafeEqual}=require('node:crypto');
const http=require('node:http');
const net=require('node:net');
const ipaddr=require('ipaddr.js');
const {blocksSourceRequest}=require('./source-adblock.cjs');
const {handleCertificateIssuerRequest}=require('./certificate-issuer-proxy.cjs');

const globalV6=ipaddr.parseCIDR('2000::/3');
const specialV6=ipaddr.parseCIDR('2001::/23');
function publicAddress(address){
  if(!net.isIP(address))return false;
  const value=ipaddr.parse(address);
  return value.range()==='unicast'&&(value.kind()==='ipv4'||value.match(globalV6)&&!value.match(specialV6));
}
function publicUrl(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='8443')||url.hash||
      url.href.length>2048||net.isIP(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.')||
      /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname))return null;
    return url;
  }catch{return null;}
}
function publicNetworkUrl(value){
  if(typeof value!=='string'||value.length>2048)return null;
  const transport=value.split('#',1)[0];
  return publicUrl(transport.startsWith('wss://')?`https://${transport.slice(6)}`:transport);
}
async function pinnedAddress(host,isActive=()=>true,resolver=lookup){
  if(!isActive())throw new Error('dns-inactive');
  let timer;
  try{
    const addresses=await Promise.race([resolver(host,{all:true}),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('dns-timeout')),3000);
    })]);
    if(!isActive())throw new Error('dns-inactive');
    if(!addresses.length||addresses.some(item=>item.family!==net.isIP(item.address)||!publicAddress(item.address)))
      throw new Error('private-address');
    return addresses.find(item=>item.family===4)||addresses[0];
  }finally{clearTimeout(timer);}
}
function sourceRequestAllowed(details,sourceUrl){
  if(details.resourceType==='object'&&details.url==='data:application/pdf;base64,aG1t')return true;
  return !!publicNetworkUrl(details.url)&&(!details.url.startsWith('wss://')||details.resourceType==='webSocket')&&
    !blocksSourceRequest(details,sourceUrl);
}

function createNetworkBudget({mode='capture',onLimit=()=>{},now=Date.now,
  requests=mode==='capture'?300:1200,connects=mode==='capture'?100:300,
  bytes=mode==='capture'?24*1024*1024:128*1024*1024,frames=32,tunnels=mode==='capture'?64:16}={}){
  const limits={requests,connects,bytes},used={requests:0,connects:0,bytes:0};
  const buckets=Array.from({length:60},()=>({requests:0,connects:0,bytes:0}));
  const sockets=new Set();
  let closed=false,activeTunnels=0,issuers=0,second=Math.floor(now()/1000);
  function close(){if(closed)return;closed=true;for(const socket of sockets)socket.destroy();sockets.clear();}
  function fail(reason){if(!closed){close();onLimit(reason);}return false;}
  function spend(kind,amount=1){
    if(closed)return false;
    const current=Math.floor(now()/1000);
    if(mode==='playback'){
      for(let elapsed=second+1;elapsed<=Math.min(current,second+60);elapsed++){
        const bucket=buckets[elapsed%60];
        for(const key of Object.keys(used)){used[key]-=bucket[key];bucket[key]=0;}
      }
      second=current;
      buckets[current%60][kind]+=amount;
    }
    used[kind]+=amount;
    return used[kind]<=limits[kind]||fail(kind==='bytes'?'byte-budget':kind==='requests'?'request-budget':'connect-budget');
  }
  return {active:()=>!closed,request:()=>spend('requests'),received:amount=>spend('bytes',amount),
    frames:count=>!closed&&(count<=frames||fail('frame-budget')),
    issuer:()=>!closed&&++issuers<=8,
    tunnel(){
      if(closed)return null;
      if(activeTunnels>=tunnels){fail('tunnel-budget');return null;}
      if(!spend('connects'))return null;
      activeTunnels++;
      let released=false;
      return ()=>{if(released)return;released=true;activeTunnels--;};
    },
    track(socket){if(closed)socket.destroy();else{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));}},close};
}

function createPinnedProxy({session,getBudget,pinAddress=pinnedAddress,connect=net.connect}){
  const username='source',password=randomUUID();
  const authorization=`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  let starting,stopped=false;
  const server=http.createServer((request,response)=>{
    const budget=getBudget();
    void handleCertificateIssuerRequest(request,response,{authorization,pinAddress,
      isActive:()=>!stopped&&getBudget()===budget&&!!budget?.active(),admit:()=>budget.issuer()});
  });
  server.on('connect',async(request,client,head)=>{
    client.on('error',()=>{});
    const supplied=Buffer.from(request.headers['proxy-authorization']||''),wanted=Buffer.from(authorization);
    const budget=getBudget();
    if(stopped||!budget?.active()||supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted)){
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="source"\r\nConnection: close\r\n\r\n');return;
    }
    const target=/^([^:]+):(443|8443)$/.exec(request.url||'');
    const url=target&&publicUrl(`https://${target[1]}:${target[2]}/`);
    if(!url){client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const release=budget.tunnel();
    if(!release){client.destroy();return;}
    budget.track(client);client.once('close',release);
    let address;
    const active=()=>!stopped&&getBudget()===budget&&budget.active();
    try{address=await pinAddress(url.hostname,active);}
    catch{client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    if(!active()||client.destroyed){client.destroy();return;}
    const remote=connect({host:address.address,family:address.family,port:Number(target[2])});
    budget.track(remote);
    let cleaned=false;
    const cleanup=()=>{if(cleaned)return;cleaned=true;release();client.destroy();remote.destroy();};
    client.once('error',cleanup);remote.once('error',cleanup);client.once('close',cleanup);remote.once('close',cleanup);
    remote.once('connect',()=>{
      if(!active()){cleanup();return;}
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)remote.write(head);
      client.pipe(remote);remote.pipe(client);
    });
    remote.on('data',chunk=>{if(!active()||!budget.received(chunk.length))cleanup();});
  });
  return {credentials:{username,password},
    start(){
      starting??=(async()=>{
        if(stopped)throw new Error('Source proxy is closed');
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        if(stopped){server.close();throw new Error('Source proxy is closed');}
        await session.setProxy({mode:'fixed_servers',proxyRules:`http://127.0.0.1:${server.address().port}`,proxyBypassRules:'<-loopback>'});
      })();
      return starting;
    },
    stop(){if(stopped)return;stopped=true;if(server.listening)server.close();server.closeAllConnections();},
  };
}

function createPageNetwork({session,pinAddress=pinnedAddress,createProxy=createPinnedProxy}){
  let budget,url;
  const proxy=createProxy({session,pinAddress,getBudget:()=>budget});
  session.webRequest.onBeforeRequest((details,callback)=>{
    callback({cancel:!budget?.active()||!sourceRequestAllowed(details,url)||
      ['media','image','font','ping','cspReport'].includes(details.resourceType)||!budget.request()});
  });
  function end(){budget?.close();budget=undefined;}
  return {begin(value,onLimit){end();url=value;budget=createNetworkBudget({onLimit});},ready:()=>proxy.start(),end,
    frames:count=>budget?.frames(count),
    login(event,_details,authInfo,callback){
      if(!authInfo.isProxy||authInfo.host!=='127.0.0.1')return;
      event.preventDefault();callback(proxy.credentials.username,proxy.credentials.password);
    },
    stop(){end();proxy.stop();session.webRequest.onBeforeRequest(null);},
  };
}

module.exports={publicAddress,publicUrl,publicNetworkUrl,pinnedAddress,sourceRequestAllowed,createNetworkBudget,createPinnedProxy,createPageNetwork};
