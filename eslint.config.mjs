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
    "dist-electron/**",
    "next-env.d.ts",
    ".agents/**",
    ".scratch/**",
    ".desktop-runtime/**",
    "work/**",
    "storybook-static/**",
  ]),
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", ".storybook/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.ts", "desktop/**/*.cjs", "scripts/**/*.{ts,mjs,cjs}", "tests/**/*.{ts,mjs,cjs}"],
    plugins: { boundaries },
    settings: {
      "boundaries/files": [
        { pattern: "components/**/*.stories.{ts,tsx}", category: "story" },
        { pattern: ".storybook/**/*.{ts,tsx}", category: "story-fixture" },
        { pattern: "app/**/*.tsx", category: "ui" },
        { pattern: "components/**/*.{ts,tsx}", category: "ui" },
        { pattern: "hooks/**/*.{ts,tsx}", category: "ui" },
        { pattern: "app/**/route.ts", category: "route" },
        { pattern: "lib/football/shared.ts", category: "shared" },
        { pattern: "lib/football/source-registry.{ts,json}", category: "source-config" },
        { pattern: "lib/football/domain/college-teams.generated.ts", category: "team-catalog" },
        { pattern: "lib/football/domain/*.ts", category: "domain" },
        { pattern: "lib/football/adapters/{schedule,sources,nflstreams,buffstream,streamed,sportsfeed24,crichd,sportsbite,player-id}.ts", category: "adapter" },
        { pattern: "lib/football/adapters/store.ts", category: "store" },
        { pattern: "lib/football/runtime/*.ts", category: "runtime" },
        { pattern: "lib/football/runtime/schedule-client.ts", category: "schedule-client" },
        { pattern: "lib/football/runtime/schedule-queue.ts", category: "schedule-queue" },
        { pattern: "lib/football/runtime/schedule-worker.ts", category: "schedule-worker" },
        { pattern: "lib/football/runtime/client.ts", category: "client" },
        { pattern: "lib/football/runtime/worker.ts", category: "worker" },
        { pattern: "lib/football/runtime/coordinator.ts", category: "coordinator" },
        { pattern: "lib/football/runtime/composition.ts", category: "composition" },
        { pattern: "lib/playback/provider.ts", category: "provider-contract" },
        { pattern: "lib/playback/probe.ts", category: "provider-probe" },
        { pattern: "lib/playback/providers/streamcenter-player.ts", category: "provider-parser" },
          { pattern: "lib/playback/providers/event-page-policy.ts", category: "provider-parser" },
          { pattern: "lib/playback/providers/catalog-stream-policy.ts", category: "provider-parser" },
          { pattern: "lib/playback/providers/swac-catalog.ts", category: "provider-parser" },
          { pattern: "lib/playback/providers/tvapp-catalog.ts", category: "provider-parser" },
          { pattern: "lib/playback/providers/sportsurge-matchup.ts", category: "provider-parser" },
        { pattern: "lib/playback/providers/edgestream.ts", category: "provider-resource" },
        { pattern: "lib/playback/providers/public-page.ts", category: "provider-resource" },
        { pattern: "lib/playback/providers/streameast-pixel.ts", category: "provider-resource" },
        { pattern: "lib/playback/providers/topstreamer.ts", category: "provider-resource" },
        { pattern: "lib/playback/providers/*.ts", category: "provider-adapter" },
        { pattern: "lib/playback/provider-registry.ts", category: "provider-composition" },
        { pattern: "lib/{playback,stream}-server.ts", category: "server-facade" },
        { pattern: "lib/stream-relay.ts", category: "relay" },
        { pattern: "lib/{sunday,utils,playback-quality,desktop-update,multiview}.ts", category: "pure-lib" },
        { pattern: "desktop/**/*.cjs", category: "desktop" },
        { pattern: "scripts/verify-sportsurge-catalog.cjs", category: "desktop-verifier" },
        { pattern: "scripts/electron-runtime.mjs", category: "desktop-runtime" },
        { pattern: "scripts/**/*.{ts,mjs,cjs}", category: "script" },
        { pattern: "tests/**/*.{ts,mjs,cjs}", category: "test" },
      ],
    },
    rules: {
      "boundaries/dependencies": ["error", {
        default: "disallow",
        policies: [
          { from: { file: { categories: "source-config" } }, allow: { to: { file: { categories: { anyOf: ["source-config", "shared"] } } } } },
          { from: { file: { categories: { anyOf: ["ui", "domain", "adapter", "coordinator", "provider-adapter", "provider-parser", "desktop", "test"] } } }, allow: { to: { file: { categories: "source-config" } } } },
          {
            from: { file: { categories: "story" } },
            allow: { to: { file: { categories: { anyOf: ["ui", "shared", "pure-lib", "story-fixture"] } } } },
          },
          {
            from: { file: { categories: "story-fixture" } },
            allow: { to: { file: { categories: { anyOf: ["ui", "shared", "pure-lib", "story-fixture"] } } } },
          },
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
            allow: { to: { file: { categories: { anyOf: ["domain", "shared", "team-catalog"] } } } },
          },
          { from: { file: { categories: "adapter" } }, allow: { to: { file: { categories: { anyOf: ["adapter", "domain", "shared", "pure-lib", "provider-parser"] } } } } },
          { from: { file: { categories: "store" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared"] } } } } },
          { from: { file: { categories: "client" } }, allow: { to: { file: { categories: "shared" } } } },
          { from: { file: { categories: "worker" } }, allow: { to: { file: { categories: { anyOf: ["composition", "shared"] } } } } },
          { from: { file: { categories: "schedule-client" } }, allow: { to: { file: { categories: "domain" } } } },
          { from: { file: { categories: "schedule-queue" } }, allow: { to: { file: { categories: "adapter" } } } },
          { from: { file: { categories: "schedule-worker" } }, allow: { to: { file: { categories: { anyOf: ["adapter", "schedule-queue"] } } } } },
          { from: { file: { categories: "composition" } }, allow: { to: { file: { categories: { anyOf: ["store", "adapter", "domain", "coordinator", "shared", "provider-probe", "schedule-client"] } } } } },
          { from: { file: { categories: "provider-probe" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared", "provider-contract", "provider-composition"] } } } } },
          { from: { file: { categories: "coordinator" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared"] } } } } },
          { from: { file: { categories: "provider-contract" } }, allow: { to: { file: { categories: "shared" } } } },
          { from: { file: { categories: "provider-parser" } }, allow: { to: { file: { categories: { anyOf: ["provider-parser", "team-catalog"] } } } } },
          { from: { file: { categories: "provider-resource" } }, allow: { to: { file: { categories: { anyOf: ["provider-contract", "provider-resource"] } } } } },
          { from: { file: { categories: "provider-adapter" } }, allow: { to: { file: { categories: { anyOf: ["shared", "provider-contract", "provider-parser", "provider-resource"] } } } } },
          { from: { file: { categories: "provider-composition" } }, allow: { to: { file: { categories: { anyOf: ["shared", "provider-contract", "provider-adapter"] } } } } },
          { from: { file: { categories: "server-facade" } }, allow: { to: { file: { categories: { anyOf: ["client", "shared", "pure-lib", "relay", "provider-contract"] } } } } },
          { from: { file: { categories: "relay" } }, allow: { to: { file: { categories: { anyOf: ["domain", "shared", "provider-contract", "provider-composition"] } } } } },
          { from: { file: { categories: "pure-lib" } }, allow: { to: { file: { categories: { anyOf: ["pure-lib", "shared"] } } } } },
          { from: { file: { categories: "desktop" } }, allow: { to: { file: { categories: "desktop" } } } },
          { from: { file: { categories: "desktop-verifier" } }, allow: { to: { file: { categories: "desktop" } } } },
          { from: { file: { categories: "script" } }, allow: { to: { file: { categories: { anyOf: ["adapter", "domain", "shared", "pure-lib", "desktop-runtime"] } } } } },
          { from: { file: { categories: "test" } }, allow: { to: { file: { categories: { anyOf: ["ui", "route", "shared", "domain", "team-catalog", "adapter", "store", "runtime", "composition", "schedule-client", "schedule-queue", "schedule-worker", "server-facade", "relay", "provider-contract", "provider-parser", "provider-resource", "provider-adapter", "provider-composition", "provider-probe", "pure-lib", "desktop", "desktop-runtime", "script", "test"] } } } } },
        ],
      }],
    },
  },
  {
    files: ["desktop/**/*.cjs", "scripts/verify-sportsurge-catalog.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs"],
    ignores: ["scripts/electron-runtime.mjs"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "electron", message: "Use prepareDevelopmentElectron() so Windows runs the branded executable." }] }],
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.object.name='electron'][callee.property.name='launch'] > ObjectExpression.arguments:not(:has(Property[key.name='executablePath']))",
        message: "Pass an explicit branded executablePath from prepareDevelopmentElectron(), or the packaged executable.",
      }, {
        selector: "CallExpression[callee.name='require'][arguments.0.value='electron']",
        message: "Use prepareDevelopmentElectron() instead of loading the stock executable path.",
      }, {
        selector: "ImportExpression[source.value='electron']",
        message: "Use prepareDevelopmentElectron() instead of loading the stock executable path.",
      }],
    },
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
