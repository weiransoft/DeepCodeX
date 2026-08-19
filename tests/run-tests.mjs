// Test runner for root-level tests（仓库根目录 tests/ 下的孤儿测试）
//
// S1-D2（2026-08-19）：根目录 tests/*.test.ts 3 个文件（webview-security /
// build-security / quality-gates-integration）此前无任何 script/CI 引用，
// 属孤儿测试——本 runner 将其纳入统一测试入口
//
// 设计要点：
// - 单层 glob `*.test.ts`（不含 scripts/、fixtures/ 子目录）
// - spawn cwd = tests 目录（与各 workspace runner 的 __dirname 模式一致，
//   避免 runner spawn cwd 陷阱：相对路径 reporter-destination 会写入 cwd）
// - 参数透传：argv[2:] 原样透传给 node --test（供 CI Coverage 步骤使用）
//
// 用法：
//   node tests/run-tests.mjs
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 单层 glob：仅 tests/ 顶层 *.test.ts（scripts/ 为 shell 脚本、fixtures/ 为数据）
const testFiles = globSync("*.test.ts", { cwd: __dirname });

if (testFiles.length === 0) {
  console.error("No test files found in tests/");
  process.exit(1);
}

console.log(`Running ${testFiles.length} test file(s) from ${__dirname}:`);
for (const f of testFiles) console.log(`  - ${f}`);

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...testFiles], {
  stdio: "inherit",
  cwd: __dirname,
});

process.exit(result.status ?? 1);
