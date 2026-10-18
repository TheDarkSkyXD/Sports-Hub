export function combatCardTitle(value:string):{title:string;segment:'Early Prelims'|'Prelims'|'Main Card'|null} {
  const title=value.trim().replace(/\s+vs\s+live(?:\s+broadcast)?$/i,'')
    .replace(/\s+(?:watch\s+)?(?:live\s+stream|live)$/i,'');
  const stage=/^ufc\b/i.test(title)?/\s*(?:[:\-–—]\s*|\(\s*|\s+)((?:early\s+)?(?:prelims|preliminary\s+card)|main\s+card)\s*\)?$/i.exec(title):null;
  if(!stage)return {title,segment:null};
  const label=stage[1].toLowerCase();
  return {title:title.slice(0,stage.index).trim(),
    segment:label.startsWith('early')?'Early Prelims':label.startsWith('main')?'Main Card':'Prelims'};
}
