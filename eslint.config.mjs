import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".agents/**",
    ".desktop-runtime/**",
    "work/**",
  ]),
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.ts", "desktop/**/*.cjs", "scripts/**/*.{ts,mjs,cjs}", "tests/**/*.{ts,mjs,cjs}"],
    plugins: { boundaries },
    settings: {
      "boundaries/files": [
        { pattern: "app/**/*.tsx", category: "ui" },
        { pattern: "components/**/*.{ts,tsx}", category: "ui" },
        { pattern: "hooks/**/*.{ts,tsx}", category: "ui" },
        { pattern: "app/**/route.ts", category: "route" },
        { pattern: "lib/football/shared.ts", category: "shared" },
        { pattern: "lib/football/domain/*.ts", category: "domain" },
        { pattern: "lib/football/adapters/{schedule,sources}.ts", category: "adapter" },
        { pattern: "lib/football/adapters/store.ts", category: "store" },
        { pattern: "lib/football/runtime/*.ts", category: "runtime" },
        { pattern: "lib/football/runtime/client.ts", category: "client" },
        { pattern: "lib/football/runtime/worker.ts", category: "worker" },
        { pattern: "lib/football/runtime/coordinator.ts", category: "coordinator" },
        { pattern: "lib/football/runtime/composition.ts", category: "composition" },
        { pattern: "lib/playback/provider.ts", category: "provider-contract" },
        { pattern: "lib/playback/providers/streamcenter-player.ts", category: "provider-parser" },
        { pattern: "lib/playback/providers/edgestream.ts", category: "provider-resource" },
        { pattern: "lib/playback/providers/*.ts", category: "provider-adapter" },
        { pattern: "lib/playback/provider-registry.ts", category: "provider-composition" },
        { pattern: "lib/{playback,stream}-server.ts", category: "server-facade" },
        { pattern: "lib/stream-relay.ts", category: "relay" },
        { pattern: "lib/{sunday,utils}.ts", category: "pure-lib" },
        { pattern: "desktop/**/*.cjs", category: "desktop" },
        { pattern: "scripts/verify-sportsurge-catalog.cjs", category: "desktop-verifier" },
        { pattern: "scripts/**/*.{ts,mjs,cjs}", category: "script" },
        { pattern: "tests/**/*.{ts,mjs,cjs}", category: "test" },
      ],
    },
    rules: {
      "boundaries/dependencies": ["error", {
        default: "disallow",
        policies: [
          {
            from: { file: { categories: "ui" } },
            allow: { to: { file: { categories: { anyOf: ["ui", "shared", "pure-lib"] } } } },
          },
          {
            from: { file: { categories: "route" } },
            allow: { to: { file: { categories: { anyOf: ["client", "shared", "server-facade", "pure-lib"] } } } },
          },
          {
            from: { file: { categories: "domain" } },
            allow: { to: { file: { categories: { anyOf: ["domain", "shared"] } } } },
          },
          { from: { file: { categories: "adapter" } }, allow: { to: { file: { categories: { anyOf: ["adapter", "domain", "shared", "pure-lib", "provider-parser"] } } } } },
          { from: { file: { categories: "store" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared"] } } } } },
          { from: { file: { categories: "client" } }, allow: { to: { file: { categories: "shared" } } } },
          { from: { file: { categories: "worker" } }, allow: { to: { file: { categories: { anyOf: ["composition", "shared"] } } } } },
          { from: { file: { categories: "composition" } }, allow: { to: { file: { categories: { anyOf: ["store", "adapter", "domain", "coordinator", "shared"] } } } } },
          { from: { file: { categories: "coordinator" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared"] } } } } },
          { from: { file: { categories: "provider-contract" } }, allow: { to: { file: { categories: "shared" } } } },
          { from: { file: { categories: "provider-parser" } }, allow: { to: { file: { categories: "provider-parser" } } } },
          { from: { file: { categories: "provider-resource" } }, allow: { to: { file: { categories: "provider-contract" } } } },
          { from: { file: { categories: "provider-adapter" } }, allow: { to: { file: { categories: { anyOf: ["shared", "provider-contract", "provider-parser", "provider-resource"] } } } } },
          { from: { file: { categories: "provider-composition" } }, allow: { to: { file: { categories: { anyOf: ["shared", "provider-contract", "provider-adapter"] } } } } },
          { from: { file: { categories: "server-facade" } }, allow: { to: { file: { categories: { anyOf: ["client", "shared", "pure-lib", "relay", "provider-contract"] } } } } },
          { from: { file: { categories: "relay" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared", "provider-contract", "provider-composition"] } } } } },
          { from: { file: { categories: "pure-lib" } }, allow: { to: { file: { categories: { anyOf: ["pure-lib", "shared"] } } } } },
          { from: { file: { categories: "desktop" } }, allow: { to: { file: { categories: "desktop" } } } },
          { from: { file: { categories: "desktop-verifier" } }, allow: { to: { file: { categories: "desktop" } } } },
          { from: { file: { categories: "script" } }, allow: { to: { file: { categories: { anyOf: ["adapter", "domain", "shared", "pure-lib"] } } } } },
          { from: { file: { categories: "test" } }, allow: { to: { file: { categories: { anyOf: ["ui", "route", "shared", "domain", "adapter", "store", "runtime", "composition", "server-facade", "relay", "provider-contract", "provider-parser", "provider-adapter", "provider-composition", "pure-lib", "desktop", "script", "test"] } } } } },
        ],
      }],
    },
  },
  {
    files: ["desktop/**/*.cjs", "scripts/verify-sportsurge-catalog.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
