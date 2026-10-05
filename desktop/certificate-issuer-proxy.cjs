const { X509Certificate, timingSafeEqual } = require('node:crypto');
const http = require('node:http');

const MAX_CERTIFICATE_BYTES = 64 * 1024;
const ISSUER_WAIT_MS = 5000;

function issuerUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && url.pathname === '/' &&
      /^[a-z0-9]+\.i\.lencr\.org$/.test(url.hostname) ? url : null;
  } catch { return null; }
}

function authorized(value, expected) {
  const supplied = Buffer.from(value || '');
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied,wanted);
}

async function handleCertificateIssuerRequest(request, response, { authorization, pinAddress, isActive, admit, requestIssuer = http.get }) {
  const url = request.method === 'GET' && issuerUrl(request.url);
  if (!url || !isActive()) { response.writeHead(405); response.end(); return; }
  if (!authorized(request.headers['proxy-authorization'],authorization)) {
    response.writeHead(407,{ 'Proxy-Authenticate':'Basic realm="certificate-issuer"' });
    response.end();
    return;
  }
  if (!admit()) { response.writeHead(429); response.end(); return; }

  const signal = AbortSignal.timeout(ISSUER_WAIT_MS);
  const canceled = new Promise((_,reject) => signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  try {
    const address = await Promise.race([pinAddress(url.hostname),canceled]);
    if (!isActive()) { response.destroy(); return; }
    if (response.destroyed) return;
    const body = await new Promise((resolve,reject) => {
      const upstream = requestIssuer(url,{
        signal,
        headers:{Accept:'application/pkix-cert'},
        lookup(_hostname,options,callback) {
          if (options.all) callback(null,[address]);
          else callback(null,address.address,address.family);
        },
      },incoming => {
        if (incoming.statusCode !== 200) { incoming.destroy(); reject(new Error('Issuer response failed')); return; }
        const chunks = [];
        let bytes = 0;
        incoming.on('data',chunk => {
          bytes += chunk.length;
          if (bytes > MAX_CERTIFICATE_BYTES) { upstream.destroy(); reject(new Error('Issuer certificate is too large')); }
          else chunks.push(chunk);
        });
        incoming.on('error',reject);
        incoming.on('end',()=>resolve(Buffer.concat(chunks)));
      });
      upstream.on('error',reject);
      response.once('close',()=>upstream.destroy());
    });
    if (!isActive()) { response.destroy(); return; }
    if (response.destroyed) return;
    if (!new X509Certificate(body).ca) throw new Error('Issuer response is not a CA certificate');
    response.writeHead(200,{ 'Content-Type':'application/pkix-cert', 'Content-Length':body.length });
    response.end(body);
  } catch {
    if (!response.destroyed && !response.headersSent) { response.writeHead(502); response.end(); }
  }
}

module.exports = { handleCertificateIssuerRequest, issuerUrl };
