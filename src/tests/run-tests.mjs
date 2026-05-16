// Cross-platform test runner: finds all *.test.ts files and runs them via tsx.
// Needed because glob expansion in npm scripts behaves differently across
// shells and Node versions (particularly Node 20 on Windows).
/* eslint-disable */

import { spawnSync } from "child_process";
import { readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");

const testFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(__dirname, f))
  .sort();

// Cross-platform resolution of the local tsx binary
function findTsx() {
  const candidates = [
    join(projectRoot, "node_modules", ".bin", "tsx"),
    join(projectRoot, "node_modules", ".bin", "tsx.cmd"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const tsx = findTsx();

const result = spawnSync(tsx, ["--test", ...testFiles], {
  stdio: "inherit",
  cwd: projectRoot,
});

process.exit(result.status ?? 1);
