// ============================================================================
// run-all-tests.mjs - @vegamo/deepcode-core 全量测试统一入口
//
// 背景（S1-D2，2026-08-19）：
// - 原 test script 为 POSIX 语法（`;` 分隔、`$?`、`$((A|B|C|D))`），
//   Windows cmd 下必然失败
// - 本脚本以纯 Node 脚本顺序 spawn 4 个既有 runner，跨平台兼容
//
// 执行顺序（4 个 runner，全部串行避免并发资源竞争）：
// 1. src/tests/run-tests.mjs        core 顶层单测（含 EAG 全部模块）
// 2. src/team/tests/run-tests.mjs   team 模块单测
// 3. src/providers/tests/run-tests.mjs providers 模块单测
// 4. src/v2/tests/run-v2-tests.mjs  v2 模块单测
//
// 退出码语义：按位或合并 4 个 runner 的退出码（任一失败则非 0，
// 且不中断后续 runner——保证完整暴露所有失败信息）
//
// 参数透传：本脚本的 argv[2:] 原样透传给每个 runner
// （如 --experimental-test-coverage --test-reporter=lcov 等覆盖率 flags，
//  供 CI Coverage 步骤使用）
// ============================================================================

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 4 个 runner 的相对路径（相对 core 包根目录）
const RUNNERS = [
  "src/tests/run-tests.mjs",
  "src/team/tests/run-tests.mjs",
  "src/providers/tests/run-tests.mjs",
  "src/v2/tests/run-v2-tests.mjs",
];

// 合并退出码（按位或）
let combinedExitCode = 0;

for (const runner of RUNNERS) {
  const runnerPath = path.join(__dirname, runner);
  console.log(`\n========== [run-all-tests] ${runner} ==========\n`);

  // 透传 CLI 参数（如 --test-reporter=lcov），与各 runner 自身的透传逻辑对齐
  const result = spawnSync(process.execPath, [runnerPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    // cwd 与 runner 自身的 glob 语义保持一致（runner 内部以 __dirname 为基准）
    cwd: path.dirname(runnerPath),
  });

  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    combinedExitCode |= exitCode;
    console.error(`\n[run-all-tests] ❌ ${runner} 失败（退出码 ${exitCode}）\n`);
  } else {
    console.log(`\n[run-all-tests] ✅ ${runner} 通过\n`);
  }
}

if (combinedExitCode !== 0) {
  console.error(`[run-all-tests] ❌ 存在失败的 runner（合并退出码 ${combinedExitCode}）`);
} else {
  console.log(`[run-all-tests] 🎉 全部 ${RUNNERS.length} 个 runner 通过`);
}

process.exit(combinedExitCode);
