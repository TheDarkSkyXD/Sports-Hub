import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingIncludes: {
    '/*': ['./lib/football/**/*.ts', './lib/sunday.ts'],
  },
};

export default nextConfig;
