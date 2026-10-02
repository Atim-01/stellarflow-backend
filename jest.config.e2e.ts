import type { Config } from "jest";

/**
 * Jest configuration for the TypeScript end-to-end integration suite.
 *
 * Mirrors the repo's default `jest.config.ts` (ESM + ts-jest) but scopes the
 * run to the `.e2e.test.ts` files under `tests/e2e` and uses transpile-only
 * (`isolatedModules`) so importing production source modules never fails the
 * suite on ambient type errors. Run with: `npm run test:e2e`.
 */
const config: Config = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        isolatedModules: true,
        tsconfig: "tsconfig.json",
      },
    ],
  },
  testMatch: ["<rootDir>/tests/e2e/**/*.e2e.test.ts"],
  testTimeout: 60000,
  collectCoverageFrom: ["src/state/keeper.ts"],
};

export default config;
