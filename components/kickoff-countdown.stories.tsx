import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { KickoffCountdown } from './kickoff-countdown';

const meta = {
  title: 'Product components/Kickoff countdown',
  component: KickoffCountdown,
  decorators: [(Story) => <span className="game-timing"><Story /></span>],
} satisfies Meta<typeof KickoffCountdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeKickoff: Story = {
  args: { game: { date: new Date(Date.now() + 45 * 60_000).toISOString(), status: 'pre' } },
};

export const AwaitingKickoff: Story = {
  args: { game: { date: new Date(Date.now() - 60_000).toISOString(), status: 'pre' } },
};
