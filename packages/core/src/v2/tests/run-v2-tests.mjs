/* global console, process */
// V2 测试运行器 — 运行所有 V2 模块测试
// 用法: node --import tsx packages/core/src/v2/tests/run-v2-tests.mjs
import { globSync } from "glob";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 递归查找所有 V2 测试文件
// 注意：globSync 在 cwd 选项下已返回相对于 __dirname 的路径，
// 此处只需转为绝对路径供 node --test 使用；
// 不能再经 path.relative(__dirname, f) 二次解析（f 为相对路径时会被
// 误解析为相对 process.cwd()，导致 "../../../xxx" 错误路径）。
const testFiles = globSync("**/*.test.ts", { cwd: __dirname }).map((f) => path.resolve(__dirname, f));

if (testFiles.length === 0) {
  console.error("未找到 V2 测试文件");
  process.exit(1);
}

console.log(`发现 ${testFiles.length} 个 V2 测试文件:`);
testFiles.forEach((f) => console.log(`  - ${f}`));
console.log("");

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
