// ============================================================================
// run-tests.mjs - @vegamo/deepcode-web 测试统一入口
//
// 职责：
// - 收集 tests 目录下全部 *.test.ts 用例文件
// - 以 node --import tsx --test 方式运行（tsx 实时转译 TS，无需预构建）
// - 透传命令行参数（如 --test-reporter=spec）
//
// 退出码语义：任一用例失败则非 0（node --test 原生语义）
// ============================================================================

import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 收集当前目录全部测试文件（按名称排序保证运行顺序稳定）
// 注意：含 JSX 的用例（如 A2UI 渲染器测试使用 react-dom/server 真实渲染）
// 必须使用 .tsx 后缀——tsx 转译器仅在 .tsx 文件中启用 JSX 转译
const testFiles = readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx"))
  .sort()
  .map((name) => path.join(__dirname, name));

if (testFiles.length === 0) {
  console.error("[run-tests] 未找到任何 *.test.ts / *.test.tsx 测试文件");
  process.exit(1);
}

console.log(`[run-tests] 共 ${testFiles.length} 个测试文件：`);
for (const file of testFiles) {
  console.log(`  - ${path.basename(file)}`);
}

// 运行 node:test（透传额外 CLI 参数）
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...testFiles], {
  stdio: "inherit",
  cwd: __dirname,
});

process.exit(result.status ?? 1);
