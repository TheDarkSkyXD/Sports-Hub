import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { userEvent, within } from 'storybook/test';
import Home from '../app/page';
import { currentUpdate, playback, productBoard, sourcesSnapshot } from './fixtures';
import { MockDesktop, MockProduct } from './story-runtime';

const meta = {
  title: 'Product/Sunday Room', component: Home,
  parameters: { layout: 'fullscreen', docs: { story: { inline: false, iframeHeight: 800 } } },
  decorators: [(Story) => <MockProduct board={productBoard} snapshot={sourcesSnapshot} playback={playback}>
    <MockDesktop status={currentUpdate}><Story /></MockDesktop>
  </MockProduct>],
} satisfies Meta<typeof Home>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ViewingRoom: Story = {};

export const Settings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Room settings' }));
    await within(canvasElement.ownerDocument.body).findByRole('dialog');
  },
};

export const Schedule: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Game schedule' }));
    await canvas.findByText('Ohio State');
  },
};
