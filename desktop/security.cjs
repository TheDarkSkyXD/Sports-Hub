const PLAYER_ORIGIN = 'https://gooz.aapmains.net';
function allowedPlayer(value) {
  try { const u=new URL(value); return u.origin===PLAYER_ORIGIN && /^\/new-stream-embed\/\d+$/.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password; } catch { return false; }
}
function validGameId(value) { return typeof value==='string' && /^(?:\d{1,20}|source-\d{1,20}|redzone)$/.test(value); }
function safeBounds(rect, size) {
  if(!rect || !['x','y','width','height'].every(k=>Number.isFinite(rect[k]))) return null;
  const x=Math.max(0,Math.round(rect.x)), y=Math.max(0,Math.round(rect.y));
  const width=Math.max(0,Math.min(Math.round(rect.width),size[0]-x));
  const height=Math.max(0,Math.min(Math.round(rect.height),size[1]-y));
  if (width<24 || height<24 || rect.x<0 || rect.y<0) return null;
  return {x,y,width,height};
}
module.exports={allowedPlayer,validGameId,safeBounds};
