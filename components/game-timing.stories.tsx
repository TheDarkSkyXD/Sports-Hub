import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { GameTiming } from './game-timing';

const meta = { title: 'Product components/Game timing', component: GameTiming } satisfies Meta<typeof GameTiming>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeKickoff: Story = {
  args: { game: { date: new Date(Date.now() + 45 * 60_000).toISOString(), status: 'pre' }, relativeDay: true },
};

export const Live: Story = {
  args: { game: { date: new Date(Date.now() - 90 * 60_000).toISOString(), status: 'in' } },
};

export const StartUnavailable: Story = { args: { game: { date: undefined, status: 'pre' } } };
