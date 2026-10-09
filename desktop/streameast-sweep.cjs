const { runNativeSweep } = require('./native-sweep.cjs');

module.exports = { runStreameastSweep: options => runNativeSweep('streameast', options) };
