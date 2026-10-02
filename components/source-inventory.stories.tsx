import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sourcesSnapshot } from '../.storybook/fixtures';
import { MockApi } from '../.storybook/story-runtime';
import { SourceInventory } from './source-inventory';

const meta = {
  title: 'Product components/Source inventory', component: SourceInventory,
  parameters: { docs: { story: { inline: false } } },
  decorators: [(Story) => <MockApi kind="sources" snapshot={sourcesSnapshot}>
    <div style={{ width: 'min(920px, 92vw)' }}><Story /></div>
  </MockApi>],
} satisfies Meta<typeof SourceInventory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithListings: Story = { args: { gameIds: ['401'] } };
export const WithoutSelectedGames: Story = { args: { gameIds: [] } };
