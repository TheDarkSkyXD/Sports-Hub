const { runNativeSweep } = require('./native-sweep.cjs');

module.exports = { runSportsurgeSweep: options => runNativeSweep('sportsurge-v2', options) };
