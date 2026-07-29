/* global console, process */
// Team 模块独立测试运行器
//
// 独立运行团队模块测试，避免影响 core 顶层测试套件
// 用法：node src/team/tests/run-tests.mjs
//
// 支持递归发现：会扫描 src/team/tests/**/*.test.ts（覆盖 cybernetics/、principles/ 等子目录）
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/core/src/team/tests -> packages/core
const teamRoot = path.resolve(__dirname, "..", "..", "..");
// 递归发现：覆盖 tests/ 下所有 .test.ts（cybernetics、principles 等子目录都包含）
const testFiles = globSync("src/team/tests/**/*.test.ts", { cwd: teamRoot });

if (testFiles.length === 0) {
  console.error("No test files found in src/team/tests/");
  process.exit(1);
}

console.log(`Running ${testFiles.length} test file(s) from ${teamRoot}:`);
for (const f of testFiles) console.log(`  - ${f}`);

const result = spawnSync(
  process.execPath,
  // 透传 CLI 参数（如 --test-reporter=tap），修复 FIX-03：之前 npm test -- <args> 被静默忽略
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...testFiles],
  {
    stdio: "inherit",
    cwd: teamRoot,
  }
);
process.exit(result.status ?? 1);
