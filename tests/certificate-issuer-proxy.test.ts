import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import { rootCertificates } from 'node:tls';
import { test } from 'node:test';

const require=createRequire(import.meta.url);
const { handleCertificateIssuerRequest }=require('../desktop/certificate-issuer-proxy.cjs');
const certificate=new X509Certificate(rootCertificates[0]).raw;
const authorization='Basic '+Buffer.from('observer:secret').toString('base64');

async function listen(server){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return server.address().port;
}

async function close(server){await new Promise(resolve=>server.close(resolve));}

async function requestProxy(port,path,auth){
  return new Promise((resolve,reject)=>{
    const request=get({host:'127.0.0.1',port,path,headers:auth?{'Proxy-Authorization':auth}:{}},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));
      response.on('error',reject);
      response.on('aborted',()=>reject(new Error('Proxy response aborted')));
    });
    request.on('error',reject);
  });
}

test('proxy forwards only authenticated, bounded issuer certificates',async()=>{
  let issuerStatus=200;
  let issuerBody=certificate;
  let issuerRequests=0;
  const issuer=createServer((request,response)=>{
    issuerRequests++;
    assert.equal(request.headers['proxy-authorization'],undefined);
    response.writeHead(issuerStatus,{'Content-Type':'application/pkix-cert'});
    response.end(issuerBody);
  });
  const issuerPort=await listen(issuer);
  let pinned=0;
  const proxy=createServer((request,response)=>{
    void handleCertificateIssuerRequest(request,response,{
      authorization,
      pinAddress:async host=>{assert.equal(host,'yr1.i.lencr.org');pinned++;return {address:'8.8.8.8',family:4};},
      isActive:()=>true,
      admit:()=>true,
      requestIssuer:(url,options,callback)=>{
        assert.equal(url.href,'http://yr1.i.lencr.org/');
        assert.equal(typeof options.lookup,'function');
        return get({host:'127.0.0.1',port:issuerPort,headers:options.headers,signal:options.signal},callback);
      },
    });
  });
  const proxyPort=await listen(proxy);
  try{
    assert.equal((await requestProxy(proxyPort,'http://yr1.i.lencr.org/')).status,407);
    for(const path of ['http://example.com/','http://yr1.i.lencr.org/other','http://yr1.i.lencr.org/?x=1','http://127.0.0.1/'])
      assert.equal((await requestProxy(proxyPort,path,authorization)).status,405,path);
    assert.equal(issuerRequests,0);
    const allowed=await requestProxy(proxyPort,'http://yr1.i.lencr.org/',authorization);
    assert.equal(allowed.status,200);
    assert.deepEqual(allowed.body,certificate);
    assert.equal(pinned,1);

    issuerStatus=302;
    assert.equal((await requestProxy(proxyPort,'http://yr1.i.lencr.org/',authorization)).status,502);
    issuerStatus=200;
    issuerBody=Buffer.alloc(64*1024+1);
    assert.equal((await requestProxy(proxyPort,'http://yr1.i.lencr.org/',authorization)).status,502);
  }finally{await close(proxy);await close(issuer);}
});

test('issuer proxy closes a response when its observation ends during DNS or download',async()=>{
  let active=true;
  let pinBlocked=true;
  let resolvePin;
  let issuerResponse;
  const issuer=createServer((_request,response)=>{
    issuerResponse=response;
    response.writeHead(200,{'Content-Type':'application/pkix-cert'});
    response.write(certificate.subarray(0,100));
  });
  const issuerPort=await listen(issuer);
  const proxy=createServer((request,response)=>{
    void handleCertificateIssuerRequest(request,response,{
      authorization,
      pinAddress:()=>pinBlocked ? new Promise(resolve=>{resolvePin=resolve;}) : Promise.resolve({address:'8.8.8.8',family:4}),
      isActive:()=>active,
      admit:()=>true,
      requestIssuer:(_url,options,callback)=>get({host:'127.0.0.1',port:issuerPort,signal:options.signal},callback),
    });
  });
  const proxyPort=await listen(proxy);
  const until=async predicate=>{
    for(let tries=0;tries<100&&!predicate();tries++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(predicate(),'expected proxy stage did not begin');
  };
  try{
    const dnsRequest=requestProxy(proxyPort,'http://yr1.i.lencr.org/',authorization);
    await until(()=>!!resolvePin);
    active=false;
    resolvePin({address:'8.8.8.8',family:4});
    await assert.rejects(dnsRequest,/abort|reset|hang up/i);

    active=true;
    pinBlocked=false;
    resolvePin=undefined;
    const bodyRequest=requestProxy(proxyPort,'http://yr1.i.lencr.org/',authorization);
    await until(()=>!!issuerResponse);
    active=false;
    issuerResponse.end(certificate.subarray(100));
    await assert.rejects(bodyRequest,/abort|reset|hang up/i);
  }finally{issuerResponse?.destroy();await close(proxy);await close(issuer);}
});
