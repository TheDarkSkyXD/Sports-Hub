const { randomUUID } = require('node:crypto');
const { createNativeCollector } = require('../native/collector/bridge.cjs');

const knownFailures = new Set(['blocked', 'timeout', 'parser-changed', 'unavailable', 'invalid-detail-url', 'limit', 'rate-limited']);
function reason(error) { return knownFailures.has(error?.message) ? error.message : 'unavailable'; }

let collector;
function native() { return collector ||= createNativeCollector(); }

async function runNativeSweep(kind, { read, send, signal, now = Date.now, runId = randomUUID() }) {
  if (signal.aborted) throw new Error('unavailable');
  const owner = native();
  const begin = JSON.parse(owner.beginSweep(kind, runId, now()));
  let action = begin.action;
  let publishError;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('unavailable');
      if (action.kind === 'done') return action.catalog;
      if (action.kind === 'failed') throw publishError || new Error(action.reason);
      let result;
      if (action.kind === 'read') {
        try {
          const body = await read(action.url, action.role, action.league, signal);
          result = { kind: 'read-ok', id: action.id, body };
        } catch (error) {
          if (signal.aborted) throw new Error('unavailable');
          result = { kind: 'read-failed', id: action.id, reason: reason(error) };
        }
      } else if (action.kind === 'publish') {
        try {
          const ack = await send(action.catalog);
          publishError = undefined;
          result = { kind: 'publish-ok', id: action.id, ack: ack ?? null };
        } catch (error) {
          if (signal.aborted) throw new Error('unavailable');
          publishError = error;
          result = { kind: 'publish-failed', id: action.id, reason: reason(error) };
        }
      } else {
        throw new Error('Unknown Rust collector sweep action');
      }
      action = JSON.parse(owner.advanceSweep(begin.id, JSON.stringify(result), now()));
    }
  } finally { owner.closeSweep(begin.id); }
}

module.exports = { runNativeSweep };
