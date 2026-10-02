import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useArgs } from 'storybook/preview-api';
import { demoFeed } from '../.storybook/fixtures';
import { GamePlayer } from './game-player';

const meta = {
  title: 'Product components/Game player', component: GamePlayer,
  render: function Render(args) {
    const [, updateArgs] = useArgs();
    return <GamePlayer {...args} onPlayingChange={(playing) => updateArgs({ playing })}
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
