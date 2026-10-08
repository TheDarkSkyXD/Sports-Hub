import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingIncludes: {
    '/*': ['./lib/football/**/*.ts', './lib/football/source-registry.json', './lib/playback/**/*.ts', './lib/sunday.ts', './lib/game-timing.ts'],
  },
  // Keep local build and verification scratch out of standalone output. Copying
  // prior packaged apps into the next build nests each install until paths
  // exceed MAX_PATH.
  outputFileTracingExcludes: {
    '/*': ['./dist-electron/**/*', './work/**/*', './.desktop-runtime/**/*'],
  },
};

export default nextConfig;
