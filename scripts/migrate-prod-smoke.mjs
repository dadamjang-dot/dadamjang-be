import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.scripts["migrate:prod"], "node dist/scripts/migrate.js");

const repositoryRoot = new URL("..", import.meta.url);
const build = spawnSync("pnpm", ["build"], { cwd: repositoryRoot, encoding: "utf8" });
assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
assert.equal(existsSync(new URL("../dist/scripts/migrate.js", import.meta.url)), true);

const load = spawnSync("pnpm", ["migrate:prod"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: { ...process.env, NODE_ENV: "local", POSTGRES_HOST: "" },
});
const output = `${load.stdout}${load.stderr}`;
assert.equal(load.status, 1, output);
assert.match(output, /POSTGRES_HOST is required/);
assert.doesNotMatch(output, /Cannot find module|ts-node|scripts\/migrate\.ts/);
process.stdout.write("production migration command built and loaded without TypeScript runtime dependencies\n");
