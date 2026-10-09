import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { GamePlayer } from '../components/game-player';
import { demoFeed } from './fixtures';

function PlaybackProof(props: ComponentProps<typeof GamePlayer>) {
  const [evidence, setEvidence] = useState<{ count: number; url: string; startupMs: number } | null>(null);
  return <div>
    <div style={{ position: 'relative', width: 'min(720px, 90vw)', height: 405 }}>
      <GamePlayer {...props} onDecoded={(url, proof) => setEvidence(previous => ({
        count: (previous?.count || 0) + 1, url, startupMs:proof.startupMs,
      }))}/>
    </div>
    <output data-testid="decoded-proof" data-count={evidence?.count || 0}>
      {evidence ? `Decoded ${evidence.url} in ${evidence.startupMs} ms` : 'Waiting for a decoded video frame'}
    </output>
  </div>;
}

const meta = {
  title: 'Verification/Playback evidence', component: GamePlayer,
  render: args => <PlaybackProof {...args}/>,
} satisfies Meta<typeof GamePlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DecodedLocalVideo: Story = {
  args: { feed: demoFeed, focused: false, audible: false, volume: 65, defaultQuality: 'auto', playing: true,
    onPlayingChange: () => {}, onAudibleChange: () => {}, onVolumeChange: () => {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId('decoded-proof')).toHaveAttribute('data-count', '1'), { timeout: 10000 });
    await expect(canvas.getByTestId('decoded-proof')).toHaveTextContent('Decoded /sample.webm');
    const video = canvas.getByLabelText('Storybook sample feed');
    if (!(video instanceof HTMLVideoElement)) throw new Error('The player did not render a video.');
    await expect(video.videoWidth).toBeGreaterThan(0);
    await expect(video.videoHeight).toBeGreaterThan(0);
    await expect(video.currentTime).toBeGreaterThan(0);
  },
};

export const DecodedFrameCounterFallback: Story = {
  ...DecodedLocalVideo,
  beforeEach: () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: undefined });
    return () => {
      if (descriptor) Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', descriptor);
      else Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    };
  },
  play: async context => {
    await DecodedLocalVideo.play?.(context);
    const video = within(context.canvasElement).getByLabelText('Storybook sample feed');
    if (!(video instanceof HTMLVideoElement)) throw new Error('The player did not render a video.');
    const quality = video.getVideoPlaybackQuality();
    await expect(quality.totalVideoFrames).toBeGreaterThan(quality.droppedVideoFrames);
  },
};
