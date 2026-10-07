import {useState} from 'react';
import type {Meta,StoryObj} from '@storybook/nextjs-vite';
import {FeedCheckIntervalSetting} from './feed-check-interval-setting';

const meta={title:'Settings/Feed check interval',component:FeedCheckIntervalSetting} satisfies Meta<typeof FeedCheckIntervalSetting>;
export default meta;
type Story=StoryObj<typeof meta>;

function IntervalStory() {
  const [minutes,setMinutes]=useState(5);
  return <FeedCheckIntervalSetting minutes={minutes} disabled={false} onChange={async value=>setMinutes(value)}/>;
}

export const Default:Story={args:{minutes:5,disabled:false,onChange:async()=>{}},render:()=> <IntervalStory/>};
