/* global console, process */
// providers 模块独立测试运行器
//
// 独立运行 provider 抽象层测试（OpenAI/Anthropic 双协议实现），避免影响 core 顶层测试套件
// 用法：node src/providers/tests/run-tests.mjs
//
// 支持递归发现：会扫描 src/providers/tests/**/*.test.ts
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/core/src/providers/tests -> packages/core
const coreRoot = path.resolve(__dirname, "..", "..", "..");
// 递归发现：覆盖 tests/ 下所有 .test.ts
const testFiles = globSync("src/providers/tests/**/*.test.ts", { cwd: coreRoot });

if (testFiles.length === 0) {
  console.error("No test files found in src/providers/tests/");
  process.exit(1);
}

console.log(`Running ${testFiles.length} test file(s) from ${coreRoot}:`);
for (const f of testFiles) console.log(`  - ${f}`);

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
  cwd: coreRoot,
});
process.exit(result.status ?? 1);
