import type { Config } from "jest";

const config: Config = {
  rootDir: "..",
  testRegex: "test/.*\\.integration-spec\\.ts$",
  globalSetup: "<rootDir>/test/support/global-setup.ts",
  setupFiles: ["<rootDir>/test/support/env.ts"],
  setupFilesAfterEnv: ["<rootDir>/src/jest-setup.ts"],
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }] },
  moduleNameMapper: { "^src/(.*)$": "<rootDir>/src/$1" },
  testEnvironment: "node",
};

export default config;
