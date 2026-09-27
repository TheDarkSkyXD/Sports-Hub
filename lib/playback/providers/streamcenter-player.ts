import { load } from 'cheerio';

const playerUrl=/^(?:https:)?\/\/streame\.center\/embed\/(?:hls|hls2)\.php\?stream=([a-z0-9]{1,40})$/;

export function parseStreamcenterPlayer(html:string): {stream:string;url:string} | null {
  const $=load(html);
  for (const frame of $('iframe[src]').toArray()) {
    const source=$(frame).attr('src') || '';
    const match=playerUrl.exec(source);
    if (match) return {stream:match[1],url:source.startsWith('//') ? `https:${source}` : source};
  }
  return null;
}
