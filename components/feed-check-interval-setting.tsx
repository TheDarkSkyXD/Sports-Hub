'use client';

import {useState} from 'react';
import {FeedCheckIntervalMinutesSchema} from '@/lib/football/shared';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';

type Props={minutes:number;disabled:boolean;onChange:(minutes:number)=>Promise<void>};

export function FeedCheckIntervalSetting({minutes,disabled,onChange}:Props) {
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  return <div className="quality-setting">
    <strong id="feed-check-interval-label">Source refresh interval</strong>
    <p>Discover new feeds at this interval. Published media is checked when found and every 5 minutes for today&apos;s, tomorrow&apos;s, and live games, subject to the check queue. Working feeds stay available while rechecks run. Finished games stop automatic checks. Longer provider cooldowns still apply.</p>
    <Select value={String(minutes)} disabled={disabled||saving} onValueChange={value=>{
      const parsed=FeedCheckIntervalMinutesSchema.safeParse(Number(value));
      if(!parsed.success)return;
      setSaving(true);setError('');setMessage('');
      void onChange(parsed.data).then(()=>setMessage(`Saved. Sources will refresh every ${parsed.data} ${parsed.data===1?'minute':'minutes'}. Media rechecks every 5 minutes.`))
        .catch(caught=>setError(caught instanceof Error?caught.message:'Could not save. Try again.'))
        .finally(()=>setSaving(false));
    }}>
      <SelectTrigger aria-labelledby="feed-check-interval-label"><SelectValue/></SelectTrigger>
      <SelectContent>{[1,5,10,15].map(option=><SelectItem key={option} value={String(option)}>{option} {option===1?'minute':'minutes'}</SelectItem>)}</SelectContent>
    </Select>
    {saving&&<p role="status">Saving source refresh interval...</p>}
    {message&&<p role="status">{message}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </div>;
}
