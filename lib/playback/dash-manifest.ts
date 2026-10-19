import {load} from 'cheerio';
import type {Element} from 'domhandler';

const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function dashManifestScope(body:string,base:string){
  if(/<!DOCTYPE|<!ENTITY/i.test(body))throw new Error('Unsupported DASH document');
  const $=load(body,{xml:true});
  const root=$.root().children();
  if(root.length!==1||root[0].name!=='MPD'||$('*').length>10000)throw new Error('Invalid DASH document');
  const references:Array<{kind:'manifest'|'segment';pattern:RegExp}>=[];
  const add=(value:string,bases:readonly string[],kind:'manifest'|'segment',id?:string,bandwidth?:string)=>{
    for(const parent of bases){
      const url=new URL(value,parent).href;
      const address=new URL(url);
      if(address.protocol!=='https:'||address.username||address.password||address.hash)throw new Error('Unsupported DASH reference');
      let offset=0,pattern='';
      const numeric=new Set<string>();
      for(const match of url.matchAll(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0([1-9]\d?)d)?\$/g)){
        pattern+=escape(url.slice(offset,match.index));offset=match.index+match[0].length;
        if(match[0]==='$$'){pattern+='\\$';continue;}
        const literal=match[1]==='RepresentationID'?id:match[1]==='Bandwidth'?bandwidth:undefined;
        if(match[1]==='RepresentationID'||match[1]==='Bandwidth'){
          if(!literal)throw new Error('Unsupported DASH template');
          pattern+=escape(literal);
        }else{
          if(numeric.has(match[1])||numeric.size>=2)throw new Error('Unsupported repeated DASH template');
          numeric.add(match[1]);
          const width=match[2]?Number(match[2]):1;
          if(width>20)throw new Error('Unsupported DASH template width');
          pattern+=`[0-9]{${width},20}`;
        }
      }
      const remainder=url.slice(offset);
      if(remainder.includes('$'))throw new Error('Unsupported DASH template');
      pattern+=escape(remainder);
      if(references.length>=2048)throw new Error('DASH reference limit exceeded');
      references.push({kind,pattern:new RegExp(`^${pattern}$`)});
    }
  };
  type Template={media?:string;initialization?:string;index?:string};
  const visit=(node:Element,parents:readonly string[],inherited:Template)=>{
    const current=$(node),baseNodes=current.children('BaseURL');
    const bases=baseNodes.length?parents.flatMap(parent=>baseNodes.toArray().map(child=>new URL($(child).text().trim(),parent).href)):parents;
    if(bases.length>32)throw new Error('DASH base limit exceeded');
    const declared=current.children('SegmentTemplate').first();
    const template={...inherited,...declared.attr()};
    if(node.name==='Representation'||node.name==='AdaptationSet'&&!current.children('Representation').length){
      for(const name of ['media','initialization','index'] as const)if(template[name])
        add(template[name],bases,'segment',current.attr('id'),current.attr('bandwidth'));
      if(current.children('SegmentBase').length||baseNodes.length&&!Object.keys(template).length&&bases.every(value=>!new URL(value).pathname.endsWith('/')))
        for(const value of bases)add(value,bases,'segment');
    }
    for(const value of current.children('Location').toArray())add($(value).text().trim(),[base],'manifest');
    for(const value of current.children('SegmentList, SegmentBase').find('SegmentURL, Initialization, RepresentationIndex').toArray()){
      for(const name of ['media','index','sourceURL']){const reference=$(value).attr(name);if(reference)add(reference,bases,'segment');}
    }
    for(const child of current.children().toArray())if(!['BaseURL','SegmentTemplate','SegmentList','SegmentBase','Location'].includes(child.name))
      visit(child,bases,template);
  };
  visit(root[0],[base],{});
  return {base,allows(reference:string,kind:'manifest'|'segment'){
    let address:string;
    try{address=new URL(reference,base).href;}catch{return false;}
    return references.some(item=>item.kind===kind&&item.pattern.test(address));
  }};
}
