import type { StorybookConfig } from '@storybook/nextjs-vite';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  stories: ['../components/**/*.stories.@(ts|tsx)', './*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: '@storybook/nextjs-vite',
  staticDirs: ['../public', './public'],
  async viteFinal(config) {
    return mergeConfig(config, {
      server: { watch: { ignored: ['**/.next/**', '**/.scratch/**', '**/work/**', '**/.desktop-runtime/**', '**/storybook-static/**'] } },
      resolve: { alias: { 'hls.js': fileURLToPath(new URL('./hls-mock.ts', import.meta.url)) } },
    });
  },
};

export default config;
