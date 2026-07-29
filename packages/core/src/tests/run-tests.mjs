// Test runner for @vegamo/deepcode-core
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFiles = globSync("*.test.ts", { cwd: __dirname });

const result = spawnSync(
  process.execPath,
  // 透传 CLI 参数（如 --test-reporter=tap），修复 FIX-03：之前 npm test -- <args> 被静默忽略
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...testFiles],
  {
    stdio: "inherit",
    cwd: __dirname,
  }
);

process.exit(result.status ?? 1);
