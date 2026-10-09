const { createNativeCollector } = require('../native/collector/bridge.cjs');

let collector;
function helper(kind, name, args) {
  collector ||= createNativeCollector();
  return JSON.parse(collector.browserHelper(kind, name, JSON.stringify(args)));
}

module.exports = { helper };
