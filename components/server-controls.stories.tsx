import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useArgs } from 'storybook/preview-api';
import { candidates } from '../.storybook/fixtures';
import { ServerControls } from './server-controls';

const meta = {
  title: 'Product components/Server controls', component: ServerControls,
  render: function Render(args) {
    const [, updateArgs] = useArgs();
    const playable = args.candidates.filter(candidate => candidate.availability.kind === 'playable');
    return <ServerControls {...args} onSelect={(selectedCandidateId) => updateArgs({ selectedCandidateId })}
      onSwitch={() => {
        const index = playable.findIndex(candidate => candidate.id === args.selectedCandidateId);
        const next = playable[(index + 1) % playable.length];
        if (next) updateArgs({ selectedCandidateId: next.id });
      }}/>
  },
  decorators: [(Story) => <div style={{ position: 'relative', width: 520 }}><Story /></div>],
} satisfies Meta<typeof ServerControls>;
export default meta;
type Story = StoryObj<typeof meta>;

export const VerifiedServers: Story = {
  args: { candidates, selectedCandidateId: candidates[0].id, onSelect: () => {}, onSwitch: () => {} },
};
export const NoVerifiedServer: Story = { args: { candidates: [candidates[2]] } };
export const Disabled: Story = { args: { candidates, selectedCandidateId: candidates[0].id, disabled: true } };
