import type { Config } from "jest";

const config: Config = {
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  setupFilesAfterEnv: ["<rootDir>/jest-setup.ts"],
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/../tsconfig.json" }] },
  moduleNameMapper: { "^src/(.*)$": "<rootDir>/$1" },
  collectCoverageFrom: ["**/*.ts", "!main.ts", "!instrument.ts"],
  coverageDirectory: "../coverage",
  testEnvironment: "node",
};

export default config;
