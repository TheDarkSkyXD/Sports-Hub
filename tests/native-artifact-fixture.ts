import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(checkout, '.desktop-runtime', 'rust-collector-addon');

export function stageNativeArtifact(root: string): void {
  const manifest = JSON.parse(readFileSync(path.join(stage, 'active.json'), 'utf8'));
  const destination = path.join(root, '.desktop-runtime', 'rust-collector-addon');
  mkdirSync(destination, { recursive: true });
  for (const name of ['active.json', 'source-registry.json', manifest.filename])
    copyFileSync(path.join(stage, name), path.join(destination, name));
  const bridge = path.join(root, 'native', 'collector', 'bridge.cjs');
  mkdirSync(path.dirname(bridge), { recursive: true });
  copyFileSync(path.join(checkout, 'native', 'collector', 'bridge.cjs'), bridge);
}
