import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useArgs } from 'storybook/preview-api';
import { demoFeed } from '../.storybook/fixtures';
import { GamePlayer } from './game-player';

const meta = {
  title: 'Product components/Game player', component: GamePlayer,
  render: function Render(args) {
    const [, updateArgs] = useArgs();
    return <GamePlayer {...args} feed={{...args.feed,url:new URL(args.feed.url,location.href).href}} onPlayingChange={(playing) => updateArgs({ playing })}
      onAudibleChange={(audible) => updateArgs({ audible })}
      onVolumeChange={(volume) => updateArgs({ volume })}/>;
  },
  decorators: [(Story) => <div style={{ position: 'relative', width: 'min(720px, 90vw)', height: 405 }}><Story /></div>],
} satisfies Meta<typeof GamePlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PausedLocalClip: Story = {
  args: { feed: demoFeed, focused: false, audible: false, volume: 65, defaultQuality: 'auto', playing: false,
    onPlayingChange: () => {}, onAudibleChange: () => {}, onVolumeChange: () => {} },
};
export const Focused: Story = {
  args: { ...PausedLocalClip.args, focused: true },
};

export const Dash:Story={args:{...PausedLocalClip.args,format:'dash',feed:{label:'Local DASH video',url:'/media/manifest.mpd'},focused:true,playing:true}};
export const Mp4:Story={args:{...PausedLocalClip.args,format:'progressive',feed:{label:'Local MP4 video',url:'/media/sample.mp4'},playing:true}};
export const WebM:Story={args:{...PausedLocalClip.args,format:'progressive',playing:true}};
export const Flv:Story={args:{...PausedLocalClip.args,format:'flv',feed:{label:'Local FLV video',url:'/media/sample.flv'},playing:true}};
export const MpegTs:Story={args:{...PausedLocalClip.args,format:'mpegts',feed:{label:'Local MPEG-TS video',url:'/media/sample.mpegts'},playing:true}};
