import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingIncludes: {
    '/*': ['./lib/football/**/*.ts', './lib/playback/**/*.ts', './lib/sunday.ts'],
  },
  // The football worker resolves its database from a runtime path, so the tracer
  // follows it into local build and verification scratch. Left in standalone,
  // that scratch is copied into the install and re-traced on the next build,
  // nesting each packaged app inside the next until paths exceed MAX_PATH.
  outputFileTracingExcludes: {
    '/*': ['./dist-electron/**/*', './work/**/*', './.desktop-runtime/**/*'],
  },
};

export default nextConfig;
