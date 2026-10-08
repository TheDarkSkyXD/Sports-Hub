import {createHash} from 'node:crypto';

export function playerId(provider:'event-page'|'catalog-stream',identity:readonly unknown[]):string {
  return `${provider}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24)}`;
}
