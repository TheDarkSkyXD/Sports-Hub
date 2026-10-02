import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { availableUpdate, currentUpdate, downloadingUpdate } from '../.storybook/fixtures';
import { MockDesktop } from '../.storybook/story-runtime';
import { UpdatePanel } from './update-panel';

const meta = {
  title: 'Product components/Update panel', component: UpdatePanel,
  parameters: { docs: { story: { inline: false } } },
  decorators: [(Story) => <div style={{ width: 'min(720px, 90vw)' }}><Story /></div>],
} satisfies Meta<typeof UpdatePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = { decorators: [(Story) => <MockDesktop status={availableUpdate}><Story /></MockDesktop>] };
export const Downloading: Story = { decorators: [(Story) => <MockDesktop status={downloadingUpdate}><Story /></MockDesktop>] };
export const Current: Story = { decorators: [(Story) => <MockDesktop status={currentUpdate}><Story /></MockDesktop>] };
