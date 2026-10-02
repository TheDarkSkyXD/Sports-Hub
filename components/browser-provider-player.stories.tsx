import type { Meta, StoryObj } from '@storybook/nextjs-vite';
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
