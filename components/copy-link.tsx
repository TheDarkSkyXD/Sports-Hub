'use client';

import {useState,type ReactNode} from 'react';

export function CopyLink({url,label,children,className}:{
  url:string;
  label:'Copy source link'|'Copy server link'|'Copy RedZone page link';
  children?:ReactNode;
  className?:string;
}) {
  const [state,setState]=useState<'idle'|'copying'|'copied'|'failed'>('idle');
  async function copy() {
    setState('copying');
    try {
      const address=new URL(url);
      if(!['https:','http:'].includes(address.protocol)||address.username||address.password)throw new Error('Unsupported link');
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {setState('failed');}
  }
  return <button type="button" aria-label={typeof children==='string'?`${label}: ${children}`:label} title={label} disabled={state==='copying'} onClick={()=>void copy()}
    className={className??'inline-flex max-w-full flex-wrap items-center gap-x-1.5 text-left text-[11px] text-[#ffac9b] underline underline-offset-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffac9b]'}>
    {children}<span role="status" className="text-[10px]">{state==='copied'?'Link copied':state==='failed'?'Copy failed. Try again.':state==='copying'?'Copying…':label}</span>
  </button>;
}
