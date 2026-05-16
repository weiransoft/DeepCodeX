// Cross-platform test runner: finds all *.test.ts files and runs them via tsx.
// Needed because glob expansion in npm scripts behaves differently across
// shells and Node versions (particularly Node 20 on Windows).
/* eslint-disable */

import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const testFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(__dirname, f))
  .sort();

// Resolve tsx from the project root
const tsx = new URL("../../node_modules/.bin/tsx", import.meta.url).pathname;

const result = spawnSync(process.execPath, [tsx, "--test", ...testFiles], {
  stdio: "inherit",
  cwd: join(__dirname, "../.."),
});

process.exit(result.status ?? 1);
