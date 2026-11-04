#!/usr/bin/env node
/**
 * CI 冒烟：Super Agent 子命令的真实端到端验证
 *
 * 覆盖 docs/proposals/super-agent/proposal-final.md §9 的 T12：
 * 「CLI 冒烟：真实进程启动 → 事件注入 → 候选/工单可见 → 状态可查」。
 *
 * 设计约束：
 * - **不使用 `deepcode` 二进制**（dist 需要先构建，CI 冒烟不应依赖构建产物），
 *   直接用 tsx 跑 `packages/cli/src/cli.tsx` 源码；
 * - **纯 Node 脚本**（不用 POSIX `&` / `wait`），Windows / macOS / Linux 通用；
 * - 每个断言都基于**真实输出**，不伪造通过。
 *
 * 用法：
 *   node tests/scripts/ci-super-agent-smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境不可用
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_DIR = path.join(REPO_ROOT, "packages/cli");
const CLI_ENTRY = path.join(CLI_DIR, "src/cli.tsx");

// ---------- 用例计数 ----------

let pass = 0;
let fail = 0;

/**
 * 断言一个条件
 *
 * @param {boolean} condition 条件
 * @param {string} message 失败说明
 */
function check(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${message}`);
  } else {
    fail += 1;
    console.error(`  ❌ ${message}`);
  }
}

// ---------- 环境检查 ----------

if (!existsSync(CLI_ENTRY)) {
  console.error(`❌ 找不到 CLI 入口：${CLI_ENTRY}`);
  process.exit(2);
}

const projectRoot = mkdtempSync(path.join(tmpdir(), "super-agent-smoke-"));
console.log(`临时工程目录：${projectRoot}\n`);

/**
 * 运行一次 super 子命令
 *
 * @param {string[]} args 子命令参数
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runSuper(args) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, "super", ...args, "--project-root", projectRoot],
    // cwd 必须是 packages/cli：tsx 依此找到 packages/cli/tsconfig.json 的
    // paths 映射（@vegamo/deepcode-core → ../core/src/index.ts），
    // 从而**不依赖 core 的 dist 构建产物**（与 CLI 自身测试的运行方式一致）。
    { cwd: CLI_DIR, encoding: "utf8", timeout: 120_000 }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------- 用例 1：start --once 就绪契约 ----------

console.log("用例 1：`super start --once` 启动并落库");
{
  const result = runSuper(["start", "--once", "--no-watch"]);
  check(result.status === 0, `退出码为 0（实际 ${result.status}）`);
  check(result.stdout.includes("Super Agent 已启动"), "输出包含就绪契约「Super Agent 已启动」");
  check(result.stdout.includes("单轮执行完成"), "输出包含「单轮执行完成」");
  const dbPath = path.join(projectRoot, ".deepcode", "super-agent", "super-agent.db");
  check(existsSync(dbPath), `SQLite 数据库已创建：${dbPath}`);
}

// ---------- 用例 2：status 可查 ----------

console.log("\n用例 2：`super status` 返回可解析的状态");
{
  const result = runSuper(["status", "--format", "json"]);
  check(result.status === 0, `退出码为 0（实际 ${result.status}）`);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  check(parsed !== null, "输出是合法 JSON");
  if (parsed !== null) {
    check(parsed.acceptMode === "observe", `接单模式为 observe（实际 ${parsed.acceptMode}）`);
    check(typeof parsed.totalTickets === "number", "含工单总数");
    check(Array.isArray(parsed.effectHealth), "含副作用健康数组");
  }
}

// ---------- 用例 3：inject 事件进入候选队列 ----------

console.log("\n用例 3：`super inject` 事件进入候选队列");
{
  const result = runSuper(["inject", "请修复登录崩溃", "--addressed"]);
  check(result.status === 0, `退出码为 0（实际 ${result.status}）`);
  check(result.stdout.includes("事件已接收"), "输出包含「事件已接收」");
}

// ---------- 用例 4：candidates 可见 ----------

console.log("\n用例 4：`super candidates` 能看到候选");
{
  const result = runSuper(["candidates"]);
  check(result.status === 0, `退出码为 0（实际 ${result.status}）`);
  check(result.stdout.includes("待研判候选（1）"), "候选数为 1");
  check(result.stdout.includes("请修复登录崩溃"), "候选内容包含注入的文本");
}

// ---------- 用例 5：policy 可切换 ----------

console.log("\n用例 5：`super policy --mode auto` 切换接单模式");
{
  const result = runSuper(["policy", "--mode", "auto"]);
  check(result.status === 0, `退出码为 0（实际 ${result.status}）`);
  check(result.stdout.includes("接单模式已切换为 auto"), "输出包含模式切换提示");

  const view = runSuper(["policy"]);
  check(view.stdout.includes("接单模式：auto"), "再次查看策略显示 auto");
}

// ---------- 用例 6：tickets 空态友好 ----------

console.log("\n用例 6：`super tickets` 空态");
{
  const result = runSuper(["tickets"]);
  check(result.status === 0, `退出码为 0（实际 ${result.status}）`);
  check(result.stdout.includes("（无工单）"), "无工单时给出明确提示");
}

// ---------- 清理 ----------

rmSync(projectRoot, { recursive: true, force: true });

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
