'use client';

import {useState} from 'react';
import {FinishedGameRetentionMinutesSchema} from '@/lib/football/shared';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';

const durations=[
  {minutes:5,label:'5 minutes'},
  {minutes:30,label:'30 minutes'},
  {minutes:60,label:'1 hour'},
  {minutes:360,label:'6 hours'},
  {minutes:720,label:'12 hours'},
  {minutes:1440,label:'24 hours'},
  {minutes:2880,label:'2 days'},
  {minutes:10080,label:'7 days'},
];

type Props={minutes:number;disabled:boolean;onChange:(minutes:number)=>Promise<void>};

export function FinishedGameRetentionSetting({minutes,disabled,onChange}:Props) {
  const [custom,setCustom]=useState(false);
  const [input,setInput]=useState(String(minutes));
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const isCustom=custom||!durations.some(option=>option.minutes===minutes);
  const submit=async(value:number)=>{
    const parsed=FinishedGameRetentionMinutesSchema.safeParse(value);
    if(!parsed.success){setError('Enter a whole number from 5 to 10,080 minutes.');return;}
    setSaving(true);setError('');setMessage('');
    try {
      await onChange(parsed.data);
      setMessage('Saved. Finished games and their feeds use this time.');
    } catch(error) {
      setError(error instanceof Error?error.message:'Could not save. Try again.');
    } finally {setSaving(false);}
  };
  return <div className="quality-setting">
    <strong id="finished-retention-label">Keep finished games and feeds</strong>
    <p>Keep games in Game center and their saved feeds after the final score. The time starts when a game is first reported finished.</p>
    <Select value={isCustom?'custom':String(minutes)} disabled={disabled||saving} onValueChange={value=>{
      setError('');setMessage('');
      if(value==='custom'){setCustom(true);setInput(String(minutes));return;}
      setCustom(false);void submit(Number(value));
    }}>
      <SelectTrigger aria-labelledby="finished-retention-label"><SelectValue/></SelectTrigger>
      <SelectContent>{durations.map(option=><SelectItem key={option.minutes} value={String(option.minutes)}>{option.label}</SelectItem>)}
        <SelectItem value="custom">Custom time</SelectItem>
      </SelectContent>
    </Select>
    {isCustom&&<form className="feed-form" onSubmit={event=>{event.preventDefault();void submit(Number(input));}}>
      <label htmlFor="finished-retention-minutes">Minutes after a game finishes</label>
      <input id="finished-retention-minutes" type="number" min={5} max={10080} step={1} required
        value={custom?input:String(minutes)} disabled={disabled||saving} onChange={event=>{setCustom(true);setInput(event.target.value);setError('');setMessage('');}}/>
      <p>5 minutes to 7 days. 24 hours is 1,440 minutes.</p>
      <button type="submit" className="button subtle" disabled={disabled||saving}>{saving?'Saving…':'Save retention time'}</button>
    </form>}
    {saving&&<p role="status">Saving retention time…</p>}
    {message&&<p role="status">{message}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </div>;
}
