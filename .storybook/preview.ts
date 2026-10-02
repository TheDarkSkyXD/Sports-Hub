import type { Preview } from '@storybook/nextjs-vite';
import '../app/globals.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
    nextjs: { appDirectory: true },
    backgrounds: { options: { sundayRoom: { name: 'Sunday Room', value: '#101114' } } },
  },
  initialGlobals: { backgrounds: { value: 'sundayRoom' } },
};

export default preview;
