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
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/files": [
        { pattern: "app/**/*.tsx", category: "ui" },
        { pattern: "components/**/*.{ts,tsx}", category: "ui" },
        { pattern: "app/**/route.ts", category: "route" },
        { pattern: "lib/football/shared.ts", category: "shared" },
        { pattern: "lib/football/domain/*.ts", category: "domain" },
        { pattern: "lib/football/adapters/*.ts", category: "adapter" },
        { pattern: "lib/football/adapters/store.ts", category: "store" },
        { pattern: "lib/football/runtime/*.ts", category: "runtime" },
        { pattern: "lib/football/runtime/client.ts", category: "client" },
        { pattern: "lib/football/runtime/worker.ts", category: "worker" },
        { pattern: "lib/football/runtime/coordinator.ts", category: "coordinator" },
        { pattern: "lib/{playback,stream}-server.ts", category: "server-facade" },
      ],
    },
    rules: {
      "boundaries/dependencies": ["error", {
        default: "allow",
        policies: [
          {
            from: { file: { categories: "ui" } },
            disallow: { to: { file: { categories: { anyOf: ["runtime", "adapter", "server-facade"] } } } },
          },
          {
            from: { file: { categories: "route" } },
            disallow: { to: { file: { categories: { anyOf: ["worker", "coordinator", "adapter"] } } } },
          },
          {
            from: { file: { categories: "domain" } },
            disallow: { to: { file: { categories: { anyOf: ["runtime", "adapter", "server-facade"] } } } },
          },
          { disallow: { to: { file: { categories: "coordinator" } } } },
          { from: { file: { categories: "worker" } }, allow: { to: { file: { categories: "coordinator" } } } },
          { disallow: { to: { file: { categories: "store" } } } },
          { from: { file: { categories: { anyOf: ["worker", "coordinator"] } } }, allow: { to: { file: { categories: "store" } } } },
        ],
      }],
    },
  },
  {
    files: ["desktop/**/*.cjs"],
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
