const net = require('node:net');

function probe(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function localServerPort(preferred = 51931) {
  try { return await probe(preferred); }
  catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EADDRINUSE') throw error;
    return probe(0);
  }
}

module.exports = { localServerPort };
