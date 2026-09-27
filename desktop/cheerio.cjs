const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const packagedServer = process.resourcesPath && path.join(process.resourcesPath, 'server', 'package.json');
const { load } = packagedServer && fs.existsSync(packagedServer)
  ? createRequire(packagedServer)('cheerio')
  : require('cheerio');

module.exports = { load };
