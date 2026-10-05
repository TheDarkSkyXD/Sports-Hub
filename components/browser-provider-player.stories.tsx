import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useLayoutEffect, type ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useArgs } from 'storybook/preview-api';
import { candidates, demoFeed, playback } from '../.storybook/fixtures';
import { MockApi } from '../.storybook/story-runtime';
import { BrowserProviderPlayer } from './browser-provider-player';

const meta = {
  title: 'Product components/Browser provider player', component: BrowserProviderPlayer,
  render: function Render(args) {
    const [, updateArgs] = useArgs();
    return <BrowserProviderPlayer {...args} onPlayingChange={(playing) => updateArgs({ playing })}
      onAudibleChange={(audible) => updateArgs({ audible })}
      onVolumeChange={(volume) => updateArgs({ volume })}/>;
  },
  parameters: { docs: { story: { inline: false } } },
  decorators: [(Story) => <div style={{ position: 'relative', width: 'min(720px, 90vw)', height: 425 }}><Story /></div>],
} satisfies Meta<typeof BrowserProviderPlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ManualFeed: Story = {
  args: { gameId: '401', manualFeed: demoFeed, focused: false, audible: false, volume: 65,
    defaultQuality: 'auto', playing: false, onPlayingChange: () => {}, onAudibleChange: () => {}, onVolumeChange: () => {} },
  decorators: [(Story) => <MockApi kind="playback" playback={playback}><Story /></MockApi>],
};

export const FinalGame: Story = {
  args: { ...ManualFeed.args, manualFeed: undefined, availableCandidates: candidates, graceEndsAt: 1 },
};

export const VerifiedServers: Story = {
  args: { ...ManualFeed.args, manualFeed: undefined, initialCandidateId: candidates[0].id, availableCandidates: candidates },
  decorators: [(Story) => <MockApi kind="playback" playback={playback}><Story /></MockApi>],
};

const replacementCandidates = Array.from({length:13},(_,index)=>({
  ...candidates[0],id:`replacement-${index+1}`,label:`Replacement ${index+1}`,
}));
const missingSelectedPlayback = {
  session:{...playback.session,candidateId:'removed-primary'},
  candidates:replacementCandidates,
};
export const MissingSelectedCandidate: Story = {
  args:{...VerifiedServers.args,initialCandidateId:undefined,availableCandidates:replacementCandidates},
  decorators:[(Story)=><MockApi kind="playback" playback={missingSelectedPlayback}><Story /></MockApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await waitFor(()=>expect(canvas.getByText('This server is no longer listed. Choose another verified server or try again.')).toBeInTheDocument());
    await expect(canvas.getByRole('combobox',{name:'Choose listed server'})).toHaveValue('');
  },
};

function RepairingApi({children,secondMissing=false}:{children:ReactNode;secondMissing?:boolean}) {
  useLayoutEffect(()=>{
    const original=window.fetch;
    let current=missingSelectedPlayback;
    let repairs=0;
    window.fetch=(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.startsWith('/api/playback')) {
        if(init?.method==='DELETE')return Promise.resolve(Response.json({}));
        if(init?.method==='PATCH'&&typeof init.body==='string') {
          const command:unknown=JSON.parse(init.body);
          if(command&&typeof command==='object'&&'kind' in command&&command.kind==='session') {
            repairs++;
            current={...current,session:{...current.session,
              candidateId:secondMissing&&repairs===1?'removed-second':replacementCandidates[0].id,
              generation:current.session.generation+1}};
          }
        }
        return Promise.resolve(Response.json(current));
      }
      if(url.startsWith('/api/stream/'))return Promise.resolve(new Response(null,{status:404}));
      return original(input,init);
    };
    return()=>{window.fetch=original;};
  },[secondMissing]);
  return children;
}

export const MissingSelectedCandidateRepaired: Story = {
  args:MissingSelectedCandidate.args,
  decorators:[(Story)=><RepairingApi><Story /></RepairingApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await waitFor(()=>expect(canvas.getByRole('combobox',{name:'Choose listed server'})).toHaveValue('replacement-1'));
    await expect(canvas.queryByText('Player unavailable')).not.toBeInTheDocument();
  },
};

export const ChangedMissingCandidateRepaired: Story = {
  args:MissingSelectedCandidate.args,
  decorators:[(Story)=><RepairingApi secondMissing><Story /></RepairingApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await waitFor(()=>expect(canvas.getByRole('combobox',{name:'Choose listed server'})).toHaveValue('replacement-1'));
    await expect(canvas.queryByText('Player unavailable')).not.toBeInTheDocument();
  },
};

function RefreshDropsSelectedApi({children}:{children:ReactNode}) {
  useLayoutEffect(()=>{
    const original=window.fetch;
    let current={...playback,candidates:[candidates[0],...replacementCandidates]};
    let dropped=false;
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.startsWith('/api/playback')) {
        if(init?.method==='DELETE')return Response.json({});
        if(init?.method==='PATCH'&&typeof init.body==='string') {
          const command:unknown=JSON.parse(init.body);
          if(command&&typeof command==='object'&&'kind' in command&&command.kind==='session') {
            if(!dropped) {
              dropped=true;
              current={...current,candidates:replacementCandidates};
            } else {
              await new Promise(resolve=>setTimeout(resolve,300));
              current={...current,session:{...current.session,candidateId:replacementCandidates[0].id,
                generation:current.session.generation+1}};
            }
          }
        }
        return Response.json(current);
      }
      if(url.startsWith('/api/stream/'))return new Response(null,{status:404});
      return original(input,init);
    };
    return()=>{window.fetch=original;};
  },[]);
  return children;
}

export const SelectedCandidateLostOnRefresh: Story = {
  args:{...VerifiedServers.args,availableCandidates:[candidates[0],...replacementCandidates]},
  decorators:[(Story)=><RefreshDropsSelectedApi><Story /></RefreshDropsSelectedApi>],
  play:async({canvasElement})=>{
    const canvas=within(canvasElement);
    await waitFor(()=>expect(canvas.getByRole('combobox',{name:'Choose listed server'})).toHaveValue(candidates[0].id));
    const video=canvasElement.querySelector('video');
    await userEvent.click(canvas.getByRole('button',{name:'Switch server'}));
    await waitFor(()=>expect(canvas.getByRole('combobox',{name:'Choose listed server'})).toHaveValue(''));
    await expect(canvasElement.querySelector('video')).toBe(video);
    await waitFor(()=>expect(canvas.getByRole('combobox',{name:'Choose listed server'})).toHaveValue('replacement-1'));
  },
};
