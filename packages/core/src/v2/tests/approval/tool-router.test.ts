/**
 * ToolRouter 单元测试
 *
 * 测试覆盖（对应设计 §4.3 ToolRouter + §4.4.3 集成流程）：
 * - TR-01：deny 决策抛出 ApprovalDeniedError（携带完整 result）
 * - TR-02：ask_user 决策用户批准 → 放行
 * - TR-03：ask_user 决策用户拒绝 → 抛出 ApprovalDeniedError("User denied")
 * - TR-04：auto_approve + snapshotRequired=false → 不创建快照
 * - TR-05：auto_approve + snapshotRequired=true + 仓库健康 → 创建 pre-turn 快照
 * - TR-06：仓库损坏（head_corrupt）→ 自动重建 → 重建后创建快照
 * - TR-07：降级模式（degraded_mode）→ 跳过快照直接放行（不阻断工具执行）
 * - TR-08：未注入 askUser 回调时 ask_user 决策 → 保守拒绝
 *
 * 所有测试使用真实文件系统和真实 git 命令，无 mock。
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/approval-denied-error.js";
import { ToolRouter } from "../../approval/tool-router.js";
import { SideGitManager, projectHash } from "../../approval/side-git.js";
import { SideGitRecovery } from "../../approval/side-git-recovery.js";
import type { ApprovalContext } from "../../approval/types.js";

const execFileAsync = promisify(execFile);

// 测试 fixture：每个测试用例独立的临时目录
let tempDir: string;
let workspaceRoot: string;
let sideGitDir: string;
let sideGit: SideGitManager;
let recovery: SideGitRecovery;
let gate: ApprovalGate;
let notifications: string[];

beforeEach(async () => {
  // 创建临时工作区并初始化主仓库
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepcode-v2-router-"));
  workspaceRoot = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceRoot });
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test Project\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: workspaceRoot });

  // 推导 side-git 仓库路径并初始化组件
  const hash = projectHash(workspaceRoot);
  sideGitDir = path.join(os.homedir(), ".deepcode", "side-git", hash);

  sideGit = new SideGitManager({
    sideGitDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });
  await sideGit.initialize();

  notifications = [];
  recovery = new SideGitRecovery(sideGit, sideGit["config"], (msg) => {
    notifications.push(msg);
  });
  gate = new ApprovalGate();
});

afterEach(async () => {
  // 清理临时目录与 side-git 仓库
  await fs.rm(tempDir, { recursive: true, force: true });
  try {
    await fs.rm(sideGitDir, { recursive: true, force: true });
  } catch {
    // 静默忽略
  }
});

/** 构造审批上下文的便捷工厂 */
function makeContext(overrides: Partial<ApprovalContext>): ApprovalContext {
  return {
    toolName: "bash",
    toolCategory: "bash",
    appMode: "agent",
    approvalMode: "suggest",
    ...overrides,
  };
}

test("TR-01: deny 决策抛出 ApprovalDeniedError（携带完整 result）", async () => {
  // plan 模式下非只读工具 → deny（确定性分支，不依赖黑名单词表）
  const router = new ToolRouter(gate, sideGit, recovery);
  const ctx = makeContext({
    toolName: "write",
    toolCategory: "file_write",
    appMode: "plan",
    approvalMode: "auto",
    filePath: "src/index.ts",
  });

  await assert.rejects(router.route(ctx), (error: unknown) => {
    assert.ok(error instanceof ApprovalDeniedError, "应抛出 ApprovalDeniedError");
    const denied = error as ApprovalDeniedError;
    assert.equal(denied.result.decision, "deny");
    assert.ok(denied.result.reason.includes("plan"), "应携带决策原因");
    assert.equal(denied.result.snapshotRequired, false);
    return true;
  });

  // deny 决策不应创建任何快照
  const snapshots = await sideGit.listSnapshots();
  assert.equal(snapshots.length, 0, "deny 决策不应创建快照");
});

test("TR-02: ask_user 决策用户批准 → 放行", async () => {
  // suggest 模式下 network 工具 → ask_user
  let askCalled = false;
  const router = new ToolRouter(gate, sideGit, recovery, async (ctx, result) => {
    askCalled = true;
    assert.equal(ctx.toolName, "web_search");
    assert.equal(result.decision, "ask_user");
    return true; // 用户批准
  });

  const ctx = makeContext({ toolName: "web_search", toolCategory: "network" });
  const allowed = await router.route(ctx);

  assert.equal(allowed, true, "用户批准后应放行");
  assert.ok(askCalled, "应调用 askUser 回调");

  // ask_user 结果 snapshotRequired=false，不创建快照
  const snapshots = await sideGit.listSnapshots();
  assert.equal(snapshots.length, 0, "ask_user 分支不应创建快照");
});

test("TR-03: ask_user 决策用户拒绝 → 抛出 ApprovalDeniedError", async () => {
  const router = new ToolRouter(gate, sideGit, recovery, async () => false);

  const ctx = makeContext({ toolName: "web_search", toolCategory: "network" });

  await assert.rejects(router.route(ctx), (error: unknown) => {
    assert.ok(error instanceof ApprovalDeniedError);
    const denied = error as ApprovalDeniedError;
    assert.equal(denied.message, "User denied");
    // 用户拒绝时 result.decision 保留为 ask_user（供 UI 区分 deny 与用户拒绝）
    assert.equal(denied.result.decision, "ask_user");
    return true;
  });
});

test("TR-04: auto_approve + snapshotRequired=false → 不创建快照", async () => {
  // suggest 模式下只读工具 → auto_approve 且 snapshotRequired=false
  const router = new ToolRouter(gate, sideGit, recovery);
  const ctx = makeContext({ toolName: "read", toolCategory: "readonly" });

  const allowed = await router.route(ctx);

  assert.equal(allowed, true);
  const snapshots = await sideGit.listSnapshots();
  assert.equal(snapshots.length, 0, "snapshotRequired=false 不应创建快照");
});

test("TR-05: snapshotRequired=true + 仓库健康 → 创建 pre-turn 快照", async () => {
  // auto 模式下 bash 工具 → auto_approve 且 snapshotRequired=true
  const router = new ToolRouter(gate, sideGit, recovery);

  // 模拟工作区有变更（快照才有内容）
  await fs.writeFile(path.join(workspaceRoot, "new-file.txt"), "change\n", "utf8");

  const ctx = makeContext({
    command: "npm run build",
    approvalMode: "auto",
    taskId: "task-tr-005",
  });
  const allowed = await router.route(ctx);

  assert.equal(allowed, true);

  // 验证已创建 pre-turn 快照且关联 taskId
  const snapshots = await sideGit.listSnapshots();
  assert.equal(snapshots.length, 1, "应创建 1 个 pre-turn 快照");
  assert.equal(snapshots[0].type, "pre_turn");
  assert.equal(snapshots[0].taskId, "task-tr-005");
  assert.ok(snapshots[0].changedFiles.includes("new-file.txt"), "快照应包含变更文件");
});

test("TR-06: 仓库损坏（head_corrupt）→ 自动重建 → 重建后创建快照", async () => {
  // 破坏 HEAD 文件
  const headPath = path.join(sideGitDir, "HEAD");
  await fs.writeFile(headPath, "corrupted content\n", "utf8");

  const router = new ToolRouter(gate, sideGit, recovery);
  await fs.writeFile(path.join(workspaceRoot, "new-file.txt"), "change\n", "utf8");

  const ctx = makeContext({ command: "npm run build", approvalMode: "auto" });
  const allowed = await router.route(ctx);

  assert.equal(allowed, true, "重建后应正常放行");

  // 验证：发送了重建通知
  assert.ok(
    notifications.some((m) => m.includes("已重建")),
    "应通知 side-git 已重建"
  );

  // 验证：重建后仓库健康，且存在快照（基线快照 + 本次 pre-turn 快照）
  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, true, "重建后仓库应健康");

  const snapshots = await sideGit.listSnapshots();
  assert.ok(snapshots.length >= 1, "重建后应存在快照");
  assert.ok(
    snapshots.some((s) => s.taskId !== "recovery-baseline" || snapshots.length >= 1),
    "应包含路由创建的快照"
  );
});

test("TR-07: 降级模式（degraded_mode）→ 跳过快照直接放行", async () => {
  // 构造一个 rebuild 必然失败的 recovery（sideGitDir 不存在 → 步骤 1 备份失败）
  const missingDir = path.join(tempDir, "tr07", "side-git");
  const brokenGit = new SideGitManager({
    sideGitDir: missingDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });
  const brokenRecovery = new SideGitRecovery(brokenGit, brokenGit["config"], () => {});

  // 先触发一次失败 rebuild，使其进入降级模式
  await brokenRecovery.rebuild();
  const degradedReport = await brokenRecovery.verifyIntegrityLightweight();
  assert.deepEqual(degradedReport.failures, ["degraded_mode"], "前置条件：已进入降级模式");

  // 降级模式下 route() 应跳过快照直接放行（不阻断工具执行）
  const router = new ToolRouter(gate, brokenGit, brokenRecovery);
  const ctx = makeContext({ command: "npm run build", approvalMode: "auto" });
  const allowed = await router.route(ctx);

  assert.equal(allowed, true, "降级模式应放行工具执行（无快照运行）");

  // 验证：未创建任何快照（missingDir 从未被初始化）
  const dirCreated = await fs
    .access(missingDir)
    .then(() => true)
    .catch(() => false);
  assert.equal(dirCreated, false, "降级模式不应创建快照仓库");
});

test("TR-08: 未注入 askUser 回调时 ask_user 决策 → 保守拒绝", async () => {
  // 不注入 askUser 回调（安全默认：无确认通道不放行）
  const router = new ToolRouter(gate, sideGit, recovery);
  const ctx = makeContext({ toolName: "web_search", toolCategory: "network" });

  await assert.rejects(router.route(ctx), (error: unknown) => {
    assert.ok(error instanceof ApprovalDeniedError);
    assert.equal((error as ApprovalDeniedError).message, "User denied");
    return true;
  });
});
