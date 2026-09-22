/**
 * tsx JSX 转换环境准备（仅测试运行期使用，非用例）。
 *
 * 背景：tsx 从**进程 cwd** 向上发现 tsconfig——测试进程默认 cwd=packages/web
 * 时读不到 tests/tsconfig.json（jsx: react-jsx + jsxImportSource react），
 * 会把 web/src 下 .tsx 模块（如 a2ui/renderer）按经典转换编译成
 * React.createElement，运行时抛 "React is not defined"（react 19 已移除
 * 默认 React 全局命名空间）。
 *
 * 本模块在加载时修正该状态：若 TSX_TSCONFIG_PATH 未设置（run-tests.mjs
 * 统一注入），则重新执行入口并把该变量指向 tests/tsconfig.json 后交给
 * node 再跑一次——保证两种启动方式（统一入口 / 单文件直跑）下 JSX 转换
 * 都与生产构建（esbuild jsx=automatic）一致。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.TSX_TSCONFIG_PATH) {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const tsconfig = path.join(testsDir, "tsconfig.json");
  // 递归守卫：re-exec 时已注入环境变量，不会再次进入本分支
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
  });
  process.exit(result.status ?? 1);
}
