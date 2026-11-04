/**
 * Super Agent 子命令 CLI 测试
 *
 * 覆盖范围：
 * - cli-args：`super` 子命令的识别、help fallback、选项与位置参数提取
 * - super-cmd：help / status / policy / inject / tickets / ticket 的真实行为
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 真实 SQLite（临时目录），不 mock 持久层
 * - 每个用例用独立临时目录作为 projectRoot，避免污染真实工程
 *
 * @module cli/tests/super-cmd
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArguments } from "../cli-args";
import { executeSuperCommand, formatSuperHelp, resolveDatabasePath } from "../super/super-cmd";

// ============================================================================
// 测试辅助
// ============================================================================

/** 创建临时工程目录 */
function makeProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "super-cli-"));
}

// ============================================================================
// cli-args：参数解析
// ============================================================================

test("cli-args：识别 super 子命令", async () => {
  const parsed = await parseArguments(["super", "status"]);
  assert.equal(parsed.super, "status");
  assert.equal(parsed.superPositional, undefined);
});

test("cli-args：`super help` 走 help fallback（yargs 18 会拦截 help 关键字）", async () => {
  const parsed = await parseArguments(["super", "help"]);
  assert.equal(parsed.super, "help");
});

test("cli-args：提取 super 的选项与位置参数", async () => {
  const parsed = await parseArguments([
    "super",
    "ticket",
    "tkt_123",
    "--format",
    "json",
    "--project-root",
    "/tmp/demo",
  ]);
  assert.equal(parsed.super, "ticket");
  assert.equal(parsed.superPositional, "tkt_123");
  assert.equal(parsed.superOptions["format"], "json");
  assert.equal(parsed.superOptions["project-root"], "/tmp/demo");
});

test("cli-args：`super start --once` 与 `--no-watch` 正确落到选项", async () => {
  const once = await parseArguments(["super", "start", "--once"]);
  assert.equal(once.super, "start");
  assert.equal(once.superOptions["once"], true);

  const noWatch = await parseArguments(["super", "start", "--no-watch"]);
  assert.equal(noWatch.superOptions["watch"], false);
});

test("cli-args：`super policy --mode auto` 提取接单模式", async () => {
  const parsed = await parseArguments(["super", "policy", "--mode", "auto"]);
  assert.equal(parsed.super, "policy");
  assert.equal(parsed.superOptions["mode"], "auto");
});

test("cli-args：非法的子命令被 yargs 拒绝（choices 校验，退出码非 0）", () => {
  // 注意：parseArguments 的失败路径会 process.exit(1)，必须在子进程里验证
  const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.tsx", "super", "nonsense"], {
    cwd: cliDir,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Choices/);
});

// ============================================================================
// super-cmd：命令行为
// ============================================================================

test("super help：输出用法说明", async () => {
  const result = await executeSuperCommand({
    subcommand: "help",
    projectRoot: process.cwd(),
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /deepcode super/);
  assert.match(result.stdout, /observe/);
});

test("formatSuperHelp：包含全部子命令", () => {
  const help = formatSuperHelp();
  for (const sub of ["start", "status", "candidates", "tickets", "ticket", "inject", "policy", "memory"]) {
    assert.match(help, new RegExp(sub));
  }
});

test("super status：真实打开 SQLite 并返回状态", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({ subcommand: "status", projectRoot });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /司南（Sinan）· 常驻主理智能体/);
    assert.match(result.stdout, /接单模式：observe/);
    // 数据库文件确实被创建
    assert.ok(fs.existsSync(resolveDatabasePath(projectRoot)));
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super status --format json：输出可解析的 JSON", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({
      subcommand: "status",
      projectRoot,
      format: "json",
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed["acceptMode"], "observe");
    assert.equal(typeof parsed["totalTickets"], "number");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super policy：查看策略并切换接单模式", async () => {
  const projectRoot = makeProjectDir();
  try {
    const view = await executeSuperCommand({ subcommand: "policy", projectRoot });
    assert.equal(view.exitCode, 0);
    assert.match(view.stdout, /接单模式：observe/);

    const switched = await executeSuperCommand({
      subcommand: "policy",
      projectRoot,
      mode: "auto",
    });
    assert.equal(switched.exitCode, 0);
    assert.match(switched.stdout, /接单模式已切换为 auto/);

    const after = await executeSuperCommand({ subcommand: "policy", projectRoot });
    assert.match(after.stdout, /接单模式：auto/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super inject：事件被接收并进入候选队列", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({
      subcommand: "inject",
      projectRoot,
      text: "请修复登录崩溃",
      addressed: true,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /事件已接收/);

    const candidates = await executeSuperCommand({ subcommand: "candidates", projectRoot });
    assert.equal(candidates.exitCode, 0);
    assert.match(candidates.stdout, /待研判候选（1）/);
    assert.match(candidates.stdout, /请修复登录崩溃/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super inject：缺少正文时报参数错误（退出码 2）", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({ subcommand: "inject", projectRoot });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /需要事件正文/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super ticket：缺少工单 ID 时报参数错误", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({ subcommand: "ticket", projectRoot });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /需要工单 ID/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super ticket：工单不存在时报错而不是崩溃", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({
      subcommand: "ticket",
      projectRoot,
      ticketId: "tkt_not_exist",
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Super Agent 命令失败/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("super tickets：无工单时给出明确提示", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({ subcommand: "tickets", projectRoot });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /（无工单）/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// T22：用户可见交付物
// ============================================================================

/**
 * 造一条历史研判经验（直接写库——CLI 层不提供写入历史的入口）
 *
 * @param projectRoot 工程目录
 */
async function seedHistory(projectRoot: string): Promise<void> {
  const { openStore, SuperAgentRepositories } = await import("@vegamo/deepcode-core");
  const databasePath = resolveDatabasePath(projectRoot);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const store = await openStore({ databasePath });
  const repos = new SuperAgentRepositories(store);
  store.write((tx) => {
    repos.insertTrigger(tx, {
      id: "trg_seed",
      sourceId: "src-seed",
      idempotencyKey: "k1",
      actor: "alice",
      actorKind: "human",
      addressed: true,
      text: "请修复登录页的样式错乱问题",
      createdAt: "2026-11-01T00:00:00.000Z",
      meta: {},
    });
    repos.upsertThread(tx, { id: "th_seed", sourceId: "src-seed", active: true, meta: {} });
    repos.linkTriggerThread(tx, "trg_seed", "th_seed", "2026-11-01T00:00:01.000Z");
    repos.insertDecision(tx, {
      id: "dec_seed",
      threadId: "th_seed",
      kind: "accept",
      strength: "explicit",
      reason: "明确要求修复登录页，属于可执行请求",
      wouldAccept: false,
      at: "2026-11-01T00:00:05.000Z",
    });
  });
  store.close();
}

test("T22 `super memory`：列出真实历史研判经验", async () => {
  const projectRoot = makeProjectDir();
  try {
    await seedHistory(projectRoot);
    const result = await executeSuperCommand({ subcommand: "memory", projectRoot });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /历史研判经验（1）/);
    assert.match(result.stdout, /明确要求修复登录页/);
    assert.match(result.stdout, /请修复登录页的样式错乱问题/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T22 `super memory --format json`：输出可解析的 JSON", async () => {
  const projectRoot = makeProjectDir();
  try {
    await seedHistory(projectRoot);
    const result = await executeSuperCommand({
      subcommand: "memory",
      projectRoot,
      format: "json",
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as { count: number; entries: Array<{ id: string }> };
    assert.equal(parsed.count, 1);
    assert.equal(parsed.entries[0]?.id, "dec_seed");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T22 `super memory`：无历史时如实说明（不编造）", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({ subcommand: "memory", projectRoot });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /系统还没有做出过任何研判决策/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T22 `super status`：补上 4 个新计数（候选 / 待办 / token / 直通）", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({ subcommand: "status", projectRoot });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /候选：待研判 \d+，今日新增 \d+，累计 \d+/);
    assert.match(result.stdout, /待办（未决 Attention）：\d+/);
    assert.match(result.stdout, /累计 token（估算）：\d+/);
    assert.match(result.stdout, /订阅直通：\d+ 次/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T22 `super status --format json`：新计数可被程序读取", async () => {
  const projectRoot = makeProjectDir();
  try {
    const result = await executeSuperCommand({
      subcommand: "status",
      projectRoot,
      format: "json",
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const candidates = parsed["candidates"] as Record<string, unknown>;
    assert.equal(typeof candidates["pending"], "number");
    assert.equal(typeof candidates["today"], "number");
    assert.equal(typeof candidates["total"], "number");
    assert.equal(typeof parsed["openAttention"], "number");
    assert.equal(typeof parsed["routedViaSubscription"], "number");
    const tokens = parsed["workerTokens"] as Record<string, unknown>;
    assert.equal(typeof tokens["total"], "number");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cli-args：`super memory --source --limit` 提取选项", async () => {
  const parsed = await parseArguments(["super", "memory", "--source", "src-a", "--limit", "5"]);
  assert.equal(parsed.super, "memory");
  assert.equal(parsed.superOptions["source"], "src-a");
  assert.equal(parsed.superOptions["limit"], 5);
});
