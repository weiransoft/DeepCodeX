// Test runner for @deepcodex/quality
//
// S1-D2（2026-08-19）：修复原 test script 的 shell glob 缺陷
// - 原 `src/tests/**/*.test.ts` 在 sh 下 `**` 退化为 `*`，
//   实测只跑到 4 个文件（e2e/ 3 个 + codemap/ 1 个），
//   漏掉顶层 visual-regression.test.ts 与 uiux-analyzer.test.ts
// - 本 runner 用 glob 模块的递归 glob（跨平台、无 shell 依赖）发现全部测试
//
// 用法：
//   node src/tests/run-tests.mjs              全量（含 e2e/）
//   node src/tests/run-tests.mjs --skip-e2e   跳过 e2e/ 子目录
//                                              （过滤 e2e/ 路径段，显式开关非静默；
//                                                供 CI Test 步骤时限治理使用）
//
// 参数透传：除 --skip-e2e 外的 CLI 参数原样透传给 node --test
// （如 --experimental-test-coverage --test-reporter=lcov 等覆盖率 flags）
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --skip-e2e 开关解析（从 argv 中摘除，不透传给 node --test）
const forwardArgs = [];
let skipE2e = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--skip-e2e") {
    skipE2e = true;
  } else {
    forwardArgs.push(arg);
  }
}

// 递归发现全部测试文件（含 e2e/、codemap/ 子目录）
let testFiles = globSync("**/*.test.ts", { cwd: __dirname });

// --skip-e2e：过滤 e2e/ 路径段（显式开关，非静默过滤）
if (skipE2e) {
  const before = testFiles.length;
  testFiles = testFiles.filter((f) => !f.includes("e2e/"));
  console.log(`[quality-runner] --skip-e2e 生效：过滤 ${before - testFiles.length} 个 e2e 测试文件`);
}

if (testFiles.length === 0) {
  console.error("No test files found in src/tests/");
  process.exit(1);
}

console.log(`Running ${testFiles.length} test file(s) from ${__dirname}:`);
for (const f of testFiles) console.log(`  - ${f}`);

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...forwardArgs, ...testFiles], {
  stdio: "inherit",
  cwd: __dirname,
});

process.exit(result.status ?? 1);
