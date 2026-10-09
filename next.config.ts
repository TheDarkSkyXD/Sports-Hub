import type { NextConfig } from "next";
import { createRequire } from "node:module";

const { sourceIdentity } = createRequire(import.meta.url)("./desktop/source-identity.cjs");
const localDistDir = process.env.SUNDAY_ROOM_NEXT_DIST_DIR;
if (localDistDir && !/^\.desktop-runtime\/local-builds\/[a-f0-9-]+$/.test(localDistDir)) {
  throw new Error("Invalid local Next build directory");
}
const localBuildId = localDistDir?.slice(localDistDir.lastIndexOf("/") + 1);

const nextConfig: NextConfig = {
  ...(localDistDir ? { distDir: localDistDir } : {}),
  ...(localDistDir ? { typescript: { tsconfigPath: `.desktop-runtime/local-build-config/${localBuildId}.json` } } : {}),
  generateBuildId: () => sourceIdentity(process.cwd(), process.env.SUNDAY_ROOM_BUILD_PUBLIC_ENV),
  devIndicators: false,
  output: "standalone",
  outputFileTracingIncludes: {
    '/*': ['./lib/football/**/*.ts', './lib/football/source-registry.json', './lib/playback/**/*.ts', './lib/sunday.ts', './lib/game-timing.ts', './native/collector/bridge.cjs'],
  },
  // Keep local build and verification scratch out of standalone output. Copying
  // prior packaged apps into the next build nests each install until paths
  // exceed MAX_PATH.
  outputFileTracingExcludes: {
    '/*': ['./dist-electron/**/*', './work/**/*', ...(localBuildId ? [
      './.desktop-runtime/!(local-builds)/**/*',
      `./.desktop-runtime/local-builds/!(${localBuildId})/**/*`,
      './.desktop-runtime/local-builds/*.json',
    ] : ['./.desktop-runtime/**/*'])],
  },
};

export default nextConfig;
