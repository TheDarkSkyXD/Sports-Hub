import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {connect,createServer} from 'node:net';
import test from 'node:test';

const require=createRequire(import.meta.url);
const {publicAddress,pinnedAddress,sourceRequestAllowed,createNetworkBudget,createPinnedProxy}=require('../desktop/source-network.cjs');

test('source DNS admits global addresses and rejects every special or mixed answer',async()=>{
  for(const value of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.1.1','198.18.0.1','224.0.0.1',
    '::1','::ffff:8.8.8.8','::ffff:127.0.0.1','fc00::1','fe80::1','ff02::1','2001:2::1','2001:20::1',
    '2001:db8::1','2002:808:808::1','3fff::1'])assert.equal(publicAddress(value),false,value);
  for(const value of ['8.8.8.8','93.184.216.34','2606:4700:4700::1111'])assert.equal(publicAddress(value),true,value);
  const publicResult={address:'8.8.8.8',family:4};
  assert.deepEqual(await pinnedAddress('media.example',()=>true,async()=>[publicResult]),publicResult);
  await assert.rejects(pinnedAddress('media.example',()=>true,async()=>[publicResult,{address:'127.0.0.1',family:4}]),/private-address/);
  await assert.rejects(pinnedAddress('media.example',()=>true,async()=>[{address:'8.8.8.8',family:6}]),/private-address/);
  await assert.rejects(pinnedAddress('media.example',()=>false,async()=>[publicResult]),/dns-inactive/);
});

test('the shared filter policy rejects ads, unsafe redirects, and private targets without blocking HLS',()=>{
  assert.equal(sourceRequestAllowed({url:'https://googleads.g.doubleclick.net/pagead/ads',resourceType:'script'},'https://player.example/watch'),false);
  for(const url of ['https://127.0.0.1/admin','https://169.254.169.254/latest/meta-data/','https://player.local/','http://player.example/index.m3u8'])
    assert.equal(sourceRequestAllowed({url,resourceType:'media'}),false,url);
  assert.equal(sourceRequestAllowed({url:'https://media.example/index.m3u8',resourceType:'media'}),true);
  assert.equal(sourceRequestAllowed({url:'wss://media.example/socket',resourceType:'webSocket'}),true);
  assert.equal(sourceRequestAllowed({url:'wss://media.example/socket',resourceType:'script'}),false);
});

test('source players can load only the inert PDF sandbox probe as an object',()=>{
  const probe='data:application/pdf;base64,aG1t';
  assert.equal(sourceRequestAllowed({url:probe,resourceType:'object'},'https://embed.st/embed/golf/2260/2'),true);
  for(const resourceType of ['mainFrame','subFrame','script','xhr','stylesheet','image','media'])
    assert.equal(sourceRequestAllowed({url:probe,resourceType}),false,resourceType);
  for(const url of ['data:application/pdf;base64,aG1tCg==','data:application/pdf;base64,aG1t#player',
    'data:application/pdf;base64,JVBERi0xLjQ=','data:text/html;base64,aG1t','blob:https://embed.st/probe',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'])
    assert.equal(sourceRequestAllowed({url,resourceType:'object'}),false,url);
});

test('finite capture budgets close once and release their tracked resources',()=>{
  const failures:string[]=[],closed:string[]=[];
  const budget=createNetworkBudget({bytes:10,onLimit:(reason:string)=>failures.push(reason)});
  budget.track({destroy(){closed.push('socket');},once(){}});
  assert.equal(budget.received(6),true);assert.equal(budget.received(5),false);
  budget.close();assert.equal(budget.request(),false);
  assert.deepEqual(failures,['byte-budget']);assert.deepEqual(closed,['socket']);
  const frames=createNetworkBudget({frames:2,onLimit:(reason:string)=>failures.push(reason)});
  assert.equal(frames.frames(2),true);assert.equal(frames.frames(3),false);
  const requests=createNetworkBudget({requests:2,onLimit:(reason:string)=>failures.push(reason)});
  assert.equal(requests.request(),true);assert.equal(requests.request(),true);assert.equal(requests.request(),false);
  assert.deepEqual(failures,['byte-budget','frame-budget','request-budget']);
});

test('continuous playback uses a rolling traffic budget and a separate concurrent tunnel limit',()=>{
  let now=0;
  const failures:string[]=[],budget=createNetworkBudget({mode:'playback',now:()=>now,bytes:10,tunnels:1,onLimit:(reason:string)=>failures.push(reason)});
  assert.equal(budget.received(6),true);now=60_000;assert.equal(budget.received(6),true);
  const release=budget.tunnel();assert.equal(typeof release,'function');release();release();
  assert.equal(typeof budget.tunnel(),'function');assert.equal(budget.tunnel(),null);
  assert.deepEqual(failures,['tunnel-budget']);
  const rolling=createNetworkBudget({mode:'playback',now:()=>now,bytes:10,onLimit:(reason:string)=>failures.push(reason)});
  assert.equal(rolling.received(6),true);now+=59_000;assert.equal(rolling.received(5),false);
  assert.deepEqual(failures,['tunnel-budget','byte-budget']);
});

test('the authenticated proxy connects only to the address that passed DNS admission',async()=>{
  let rules='',privateAnswer=true,connections=0;
  const destination=createServer(socket=>socket.end());
  await new Promise<void>(resolve=>destination.listen(0,'127.0.0.1',resolve));
  const address=destination.address();assert.ok(address&&typeof address!=='string');
  const budget=createNetworkBudget(),proxy=createPinnedProxy({session:{async setProxy(options:{proxyRules:string}){rules=options.proxyRules;}},getBudget:()=>budget,
    pinAddress:(host:string,active:()=>boolean)=>pinnedAddress(host,active,async()=>[{address:privateAnswer?'127.0.0.1':'8.8.8.8',family:4}]),
    connect(options:{host:string;port:number;family:number}){
      connections++;assert.deepEqual(options,{host:'8.8.8.8',port:443,family:4});
      return connect({host:'127.0.0.1',port:address.port});
    }});
  const attempt=(authorized:boolean)=>new Promise<number>((resolve,reject)=>{
    const url=new URL(rules),auth=proxy.credentials;
    const current=request({host:url.hostname,port:url.port,method:'CONNECT',path:'media.example:443',headers:authorized?
      {'Proxy-Authorization':'Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64')}:{} });
    current.on('connect',(response,socket)=>{socket.destroy();resolve(response.statusCode??0);});current.on('error',reject);current.end();
  });
  try{
    await proxy.start();assert.equal(await attempt(false),407);assert.equal(await attempt(true),403);assert.equal(connections,0);
    privateAnswer=false;assert.equal(await attempt(true),200);assert.equal(connections,1);
    privateAnswer=true;assert.equal(await attempt(true),403);assert.equal(connections,1);
  }finally{budget.close();proxy.stop();await new Promise<void>(resolve=>destination.close(()=>resolve()));}
});
