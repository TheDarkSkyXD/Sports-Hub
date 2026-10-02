import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { availableUpdate, downloadingUpdate } from '../.storybook/fixtures';
import { MockDesktop } from '../.storybook/story-runtime';
import { UpdatePopup } from './update-popup';

const meta = {
  title: 'Product components/Update popup', component: UpdatePopup,
  parameters: { docs: { story: { inline: false } } },
  decorators: [(Story) => <div style={{ position: 'relative', width: 'min(720px, 90vw)', height: 420 }}><Story /></div>],
} satisfies Meta<typeof UpdatePopup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = { decorators: [(Story) => <MockDesktop status={availableUpdate}><Story /></MockDesktop>] };
export const Downloading: Story = { decorators: [(Story) => <MockDesktop status={downloadingUpdate}><Story /></MockDesktop>] };
