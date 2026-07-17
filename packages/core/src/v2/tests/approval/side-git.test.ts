/**
 * SideGitManager 单元测试
 *
 * 测试覆盖：
 * - SG-01：创建 pre-turn 快照
 * - SG-02：创建 post-turn 快照
 * - SG-03：/restore <turn_id> 回滚
 * - SG-04：/revert_turn <turn_id> 撤销（软撤销，不写入工作区）
 * - SG-05：主仓库 .git 零污染
 * - SG-06：10 个并发快照创建（串行化队列验证）
 * - SG-07：side-git 仓库损坏检测（head_corrupt）
 * - SG-07b：side-git 仓库损坏检测（refs_corrupt，HEAD 合法但 refs 文件损坏）
 * - SG-07c：side-git 仓库损坏检测（worktree_missing，workspaceRoot 被删除）
 * - SG-07d：side-git 仓库损坏检测（config_corrupt，config 文件损坏）
 * - SG-08：side-git 仓库自动重建
 * - SG-08b：rebuild 失败后进入降级模式（5 分钟退避）
 * - SG-08c：rebuild 步骤 1 备份失败处置
 * - SG-08d：rebuild 步骤 2 重建失败处置（备份自动恢复）
 * - SG-08e：rebuild 步骤 3 基线快照失败处置
 * - SG-08f：rebuild 步骤 4 通知失败处置
 * - SG-09：快照列表查询
 * - SG-10：side-git 仓库位置隔离（project_hash=A vs B）
 * - SG-11：V1 GitFileHistory 与 V2 SideGitManager 路径隔离
 * - SG-12：V1 GitFileHistory 不受 V2 SideGitManager 影响
 * - SG-13：listSnapshots 分页与过滤（P2-04）
 * - SG-14：.gitignore 忽略模式不进入快照（P2-06）
 * - SG-15：getStats 运行统计（P2-07）
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
import { SideGitManager, generateTurnId, projectHash } from "../../approval/side-git.js";

const execFileAsync = promisify(execFile);

// 测试 fixture：每个测试用例独立的临时目录
let tempDir: string;
let workspaceRoot: string;
let sideGitDir: string;
let sideGit: SideGitManager;

beforeEach(async () => {
  // 创建临时工作区
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepcode-v2-sidegit-"));
  workspaceRoot = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  // 初始化 git 仓库（主仓库）
  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceRoot });

  // 创建初始文件并 commit
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test Project\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: workspaceRoot });

  // 推导 side-git 仓库路径
  const hash = projectHash(workspaceRoot);
  sideGitDir = path.join(os.homedir(), ".deepcode", "side-git", hash);

  // 创建 SideGitManager 实例
  sideGit = new SideGitManager({
    sideGitDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });

  await sideGit.initialize();
});

afterEach(async () => {
  // 清理临时目录
  await fs.rm(tempDir, { recursive: true, force: true });

  // 清理 side-git 仓库（如存在）
  try {
    await fs.rm(sideGitDir, { recursive: true, force: true });
  } catch {
    // 静默忽略
  }
});

test("SG-01: 创建 pre-turn 快照", async () => {
  // 修改文件
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "content 1\n", "utf8");

  // 创建 pre-turn 快照
  const turnId = generateTurnId();
  const snapshot = await sideGit.createSnapshot(turnId, "pre_turn", "task-001");

  // 验证快照元数据
  assert.equal(snapshot.turnId, turnId);
  assert.equal(snapshot.type, "pre_turn");
  assert.equal(snapshot.taskId, "task-001");
  assert.ok(snapshot.commitHash, "commitHash 应存在");
  assert.ok(snapshot.timestamp, "timestamp 应存在");
  // side-git 首次快照会跟踪所有未跟踪文件（包括主仓库已跟踪的 README.md）
  assert.deepEqual(snapshot.changedFiles.sort(), ["README.md", "file1.txt"].sort());
  assert.ok(snapshot.additions >= 1, "additions 应 >= 1");

  // 验证 side-git 仓库 commit 成功
  const log = await execFileAsync("git", [`--git-dir=${sideGitDir}`, "log", "--oneline"], {
    cwd: workspaceRoot,
  });
  assert.ok(log.stdout.includes(snapshot.commitHash.slice(0, 7)), "commit 应在 side-git 仓库中");
});

test("SG-02: 创建 post-turn 快照", async () => {
  // 创建 pre-turn 快照
  const turnId = generateTurnId();
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "content 1\n", "utf8");
  await sideGit.createSnapshot(turnId, "pre_turn", "task-001");

  // 修改文件（模拟 turn 执行）
  await fs.writeFile(path.join(workspaceRoot, "file2.txt"), "content 2\n", "utf8");

  // 创建 post-turn 快照
  const postSnapshot = await sideGit.createSnapshot(turnId, "post_turn", "task-001");

  // 验证 post-turn 快照包含 turn 内的修改
  assert.equal(postSnapshot.turnId, turnId);
  assert.equal(postSnapshot.type, "post_turn");
  assert.deepEqual(postSnapshot.changedFiles.sort(), ["file2.txt"].sort());
  assert.equal(postSnapshot.additions, 1);
});

test("SG-03: /restore <turn_id> 回滚", async () => {
  // 创建 pre-turn 快照
  const turnId = generateTurnId();
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "original content\n", "utf8");
  await sideGit.createSnapshot(turnId, "pre_turn", "task-001");

  // 修改文件（模拟 turn 执行）
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "modified content\n", "utf8");

  // 回滚到 pre-turn 快照
  const backupPath = await sideGit.restore(turnId, "pre_turn");

  // 验证工作区文件已恢复
  const content = await fs.readFile(path.join(workspaceRoot, "file1.txt"), "utf8");
  assert.equal(content, "original content\n");

  // 验证备份路径返回（有未提交修改）
  assert.ok(backupPath, "应返回备份路径");
  assert.ok(backupPath.includes("uncommitted-"), "备份路径应包含 uncommitted-");
});

test("SG-04: /revert_turn <turn_id> 撤销（软撤销，不写入工作区）", async () => {
  // 创建 pre-turn 快照
  const turnId = generateTurnId();
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "original\n", "utf8");
  await sideGit.createSnapshot(turnId, "pre_turn", "task-001");

  // 修改文件（模拟 turn 执行）
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "modified\n", "utf8");
  await sideGit.createSnapshot(turnId, "post_turn", "task-001");

  // 记录当前文件内容
  const beforeRevert = await fs.readFile(path.join(workspaceRoot, "file1.txt"), "utf8");

  // 软撤销（不写入工作区）
  const preview = await sideGit.revertTurn(turnId);

  // 验证工作区文件未被修改（软撤销）
  const afterRevert = await fs.readFile(path.join(workspaceRoot, "file1.txt"), "utf8");
  assert.equal(afterRevert, beforeRevert, "软撤销不应修改工作区文件");

  // 验证预览包含反向 diff
  assert.ok(preview.diffPreview, "应包含 diff 预览");
  assert.ok(preview.instructions.includes("审阅"), "应包含用户操作指引");
});

test("SG-05: 主仓库 .git 零污染", async () => {
  // 记录主仓库 git log
  const beforeLog = await execFileAsync("git", ["log", "--oneline"], { cwd: workspaceRoot });
  await execFileAsync("git", ["status", "--porcelain"], {
    cwd: workspaceRoot,
  });

  // 创建快照
  const turnId = generateTurnId();
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "content\n", "utf8");
  await sideGit.createSnapshot(turnId, "pre_turn", "task-001");

  // 验证主仓库 git log 不变
  const afterLog = await execFileAsync("git", ["log", "--oneline"], { cwd: workspaceRoot });
  assert.equal(afterLog.stdout, beforeLog.stdout, "主仓库 git log 不应变化");

  // 验证主仓库 git status 无 staged/modified 变化（side-git add 不影响主仓库 index）
  // 注意：untracked 文件（??）是合理的（file1.txt 未 add 到主仓库），side-git add 只影响 side-git index
  const afterStatus = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: workspaceRoot,
  });
  // 过滤掉 untracked 行（??），只检查 staged/modified/deleted
  const stagedOrModified = afterStatus.stdout.split("\n").filter((line) => line.length > 0 && !line.startsWith("??"));
  assert.equal(stagedOrModified.length, 0, "主仓库不应有 staged/modified/deleted 变化");
});

test("SG-06: 10 个并发快照创建（串行化队列验证）", async () => {
  // 创建 10 个并发快照
  const promises = [];
  for (let i = 0; i < 10; i++) {
    const turnId = generateTurnId();
    promises.push(
      (async () => {
        await fs.writeFile(path.join(workspaceRoot, `file${i}.txt`), `content ${i}\n`, "utf8");
        return sideGit.createSnapshot(turnId, "pre_turn", `task-${i}`);
      })()
    );
  }

  // 等待全部完成
  const snapshots = await Promise.all(promises);

  // 验证全部成功（无 git lock 冲突）
  assert.equal(snapshots.length, 10);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.commitHash, "每个快照应有 commitHash");
  }

  // 验证 manifest.json 包含所有快照
  const allSnapshots = await sideGit.listSnapshots();
  assert.ok(allSnapshots.length >= 10, "manifest.json 应包含至少 10 个快照");
});

test("SG-07: side-git 仓库损坏检测（head_corrupt）", async () => {
  // 破坏 HEAD 文件（sideGitDir 本身就是 git-dir，不是 sideGitDir/.git）
  const headPath = path.join(sideGitDir, "HEAD");
  await fs.writeFile(headPath, "corrupted content\n", "utf8");

  // 导入 SideGitRecovery
  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(sideGit, sideGit["config"], (msg) => console.log(msg));

  // 验证损坏检测
  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, false);
  assert.ok(report.failures.includes("head_corrupt"), "应检测到 head_corrupt");
});

test("SG-08: side-git 仓库自动重建", async () => {
  // 破坏 HEAD 文件（sideGitDir 本身就是 git-dir，不是 sideGitDir/.git）
  const headPath = path.join(sideGitDir, "HEAD");
  await fs.writeFile(headPath, "corrupted content\n", "utf8");

  // 导入 SideGitRecovery
  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  let notified = false;
  const recovery = new SideGitRecovery(sideGit, sideGit["config"], (msg) => {
    if (msg.includes("已重建")) notified = true;
  });

  // 自动重建
  await recovery.rebuild();

  // 验证重建后健康
  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, true, "重建后应健康");

  // 验证通知已发送
  assert.ok(notified, "应发送重建通知");
});

test("SG-09: 快照列表查询", async () => {
  // 创建 5 个快照
  const turnIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const turnId = generateTurnId();
    turnIds.push(turnId);
    await fs.writeFile(path.join(workspaceRoot, `file${i}.txt`), `content ${i}\n`, "utf8");
    await sideGit.createSnapshot(turnId, "pre_turn", `task-${i}`);
  }

  // 列出所有快照
  const snapshots = await sideGit.listSnapshots();

  // 验证返回 5 条，按时间倒序
  assert.ok(snapshots.length >= 5, "应返回至少 5 条快照");
  for (let i = 0; i < snapshots.length - 1; i++) {
    assert.ok(snapshots[i].timestamp >= snapshots[i + 1].timestamp, "快照应按时间倒序排列");
  }
});

test("SG-10: side-git 仓库位置隔离（project_hash=A vs B）", async () => {
  // 创建第二个工作区
  const workspaceRoot2 = path.join(tempDir, "workspace2");
  await fs.mkdir(workspaceRoot2, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspaceRoot2 });

  // 推导第二个 side-git 仓库路径
  const hash2 = projectHash(workspaceRoot2);
  const sideGitDir2 = path.join(os.homedir(), ".deepcode", "side-git", hash2);

  // 验证两个路径不同
  assert.notEqual(sideGitDir, sideGitDir2, "不同项目应有不同的 side-git 仓库路径");

  // 清理
  try {
    await fs.rm(sideGitDir2, { recursive: true, force: true });
  } catch {
    // 静默忽略
  }
});

test("SG-11: V1 GitFileHistory 与 V2 SideGitManager 路径隔离", async () => {
  // V1 GitFileHistory 路径：<project>/.deepcode/file-history/<session>.git
  const v1Path = path.join(workspaceRoot, ".deepcode", "file-history", "session-001.git");

  // V2 SideGitManager 路径：~/.deepcode/side-git/<project_hash>/
  const v2Path = sideGitDir;

  // 验证路径不存在交集
  assert.ok(!v1Path.startsWith(v2Path), "V1 路径不应在 V2 路径内");
  assert.ok(!v2Path.startsWith(v1Path), "V2 路径不应在 V1 路径内");
});

test("SG-12: V1 GitFileHistory 不受 V2 SideGitManager 影响", async () => {
  // V1 GitFileHistory 路径
  const v1Dir = path.join(workspaceRoot, ".deepcode", "file-history");
  await fs.mkdir(v1Dir, { recursive: true });

  // 创建 V1 manifest.json
  const v1ManifestPath = path.join(v1Dir, "manifest.json");
  const v1Manifest = { version: "1.0.0", checkpoints: [] };
  await fs.writeFile(v1ManifestPath, JSON.stringify(v1Manifest, null, 2), "utf8");

  // V2 创建快照
  const turnId = generateTurnId();
  await fs.writeFile(path.join(workspaceRoot, "file1.txt"), "content\n", "utf8");
  await sideGit.createSnapshot(turnId, "pre_turn", "task-001");

  // 验证 V1 manifest.json 不变
  const v1Content = await fs.readFile(v1ManifestPath, "utf8");
  assert.deepEqual(JSON.parse(v1Content), v1Manifest, "V1 manifest.json 不应变化");
});

// ========== SG-07b/07c/07d：P1-06 修复补全的损坏场景检测 ==========

test("SG-07b: side-git 仓库损坏检测（refs_corrupt）", async () => {
  // 读取 HEAD 获取当前分支 ref 路径（兼容 master/main 默认分支差异）
  const headPath = path.join(sideGitDir, "HEAD");
  const headContent = await fs.readFile(headPath, "utf8");
  const refMatch = headContent.trim().match(/^ref: (.+)$/);
  assert.ok(refMatch, "HEAD 应为 ref 形式");
  const refPath = path.join(sideGitDir, refMatch[1]);

  // 破坏 refs 文件（写入非法 hash），HEAD 文件本身保持合法格式
  await fs.writeFile(refPath, "not-a-valid-commit-hash\n", "utf8");

  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(sideGit, sideGit["config"], () => {});

  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, false);
  assert.ok(report.failures.includes("refs_corrupt"), "应检测到 refs_corrupt");
  assert.ok(!report.failures.includes("head_corrupt"), "HEAD 合法，不应报 head_corrupt");
});

test("SG-07c: side-git 仓库损坏检测（worktree_missing）", async () => {
  // 删除工作区目录（模拟用户删除项目目录的场景）
  await fs.rm(workspaceRoot, { recursive: true, force: true });

  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(sideGit, sideGit["config"], () => {});

  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, false);
  // worktree 缺失时 git 子进程检查被跳过（均以 workspaceRoot 为 cwd，必然级联失败），
  // 报告应精确只有 worktree_missing 根因，无 refs/config 级联噪声
  assert.deepEqual(report.failures, ["worktree_missing"]);
});

test("SG-07d: side-git 仓库损坏检测（config_corrupt）", async () => {
  // 破坏 config 文件（sideGitDir 本身就是 git-dir，config 直接在其下）
  const configPath = path.join(sideGitDir, "config");
  await fs.writeFile(configPath, "this is not valid git config [[[\n", "utf8");

  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(sideGit, sideGit["config"], () => {});

  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, false);
  assert.ok(report.failures.includes("config_corrupt"), "应检测到 config_corrupt");
});

// ========== SG-08b~08f：P1-07/P1-08 修复的降级模式与四步失败处置 ==========

test("SG-08b: rebuild 失败后进入降级模式（5 分钟退避）", async () => {
  // 使用不存在的 sideGitDir（从未初始化）→ rebuild 步骤 1 备份必然失败
  const missingDir = path.join(tempDir, "sg08b", "side-git");
  const brokenGit = new SideGitManager({
    sideGitDir: missingDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });

  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(brokenGit, brokenGit["config"], () => {});

  // rebuild 失败（不抛异常，内部进入降级模式）
  await recovery.rebuild();

  // 降级模式下 verifyIntegrityLightweight 直接返回 degraded_mode，跳过实际检查
  // （若执行实际检查，不存在的 sideGitDir 结果应为 git_dir_missing 而非 degraded_mode）
  const report1 = await recovery.verifyIntegrityLightweight();
  assert.deepEqual(report1.failures, ["degraded_mode"], "退避期内应直接返回 degraded_mode");

  // 连续第二次调用仍在退避期内，同样直接返回（证明跳过了实际检查而非重新尝试）
  const report2 = await recovery.verifyIntegrityLightweight();
  assert.deepEqual(report2.failures, ["degraded_mode"], "退避期内重复调用仍返回 degraded_mode");
});

test("SG-08c: rebuild 步骤 1 备份失败处置", async () => {
  // sideGitDir 不存在 → fs.rename 失败（ENOENT），步骤 1 失败
  const missingDir = path.join(tempDir, "sg08c", "side-git");
  const brokenGit = new SideGitManager({
    sideGitDir: missingDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });

  const notifications: string[] = [];
  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(brokenGit, brokenGit["config"], (msg) => {
    notifications.push(msg);
  });

  // rebuild 不抛异常（降级为无快照运行）
  await recovery.rebuild();

  // 验证：通知包含备份失败与重建失败告警
  assert.ok(
    notifications.some((m) => m.includes("备份失败")),
    "应通知备份失败"
  );
  assert.ok(
    notifications.some((m) => m.includes("重建失败")),
    "应通知重建失败并进入降级"
  );

  // 验证：原路径未被创建（无可备份对象时不产生半成品目录，保留现场语义）
  const dirCreated = await fs
    .access(missingDir)
    .then(() => true)
    .catch(() => false);
  assert.equal(dirCreated, false, "备份失败时不应创建新 sideGitDir");

  // 验证：进入降级模式
  const report = await recovery.verifyIntegrityLightweight();
  assert.deepEqual(report.failures, ["degraded_mode"]);
});

test("SG-08d: rebuild 步骤 2 重建失败处置（备份自动恢复）", async () => {
  // 独立 sideGitDir（tempDir 内，避免污染默认 ~/.deepcode 目录）
  const customDir = path.join(tempDir, "sg08d", "side-git");
  const customGit = new SideGitManager({
    sideGitDir: customDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });
  await customGit.initialize();

  // 记录重建前 HEAD 内容（用于验证备份被恢复）
  const headBefore = await fs.readFile(path.join(customDir, "HEAD"), "utf8");

  // 删除 workspaceRoot：步骤 1 备份（rename，不触碰 workspace）成功，
  // 但步骤 2 initialize 内 git init 以 workspaceRoot 为 cwd，spawn ENOENT 失败
  await fs.rm(workspaceRoot, { recursive: true, force: true });

  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(customGit, customGit["config"], () => {});

  await recovery.rebuild();

  // 验证：进入降级模式
  const report = await recovery.verifyIntegrityLightweight();
  assert.deepEqual(report.failures, ["degraded_mode"]);

  // 验证：备份已被恢复到原路径（HEAD 内容一致，可审计现场保留）
  const headAfter = await fs.readFile(path.join(customDir, "HEAD"), "utf8");
  assert.equal(headAfter, headBefore, "重建失败后备份应恢复到原路径");
});

test("SG-08e: rebuild 步骤 3 基线快照失败处置", async () => {
  // 独立 sideGitDir 并破坏 HEAD（使 rebuild 的步骤 1/2 可正常执行）
  const customDir = path.join(tempDir, "sg08e", "side-git");
  const customGit = new SideGitManager({
    sideGitDir: customDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });
  await customGit.initialize();
  await fs.writeFile(path.join(customDir, "HEAD"), "corrupted\n", "utf8");

  // 在工作区放置不可读文件：步骤 3 createSnapshot 的 git add 读取内容时 EACCES 失败
  // （git status 对未跟踪文件不读内容，故步骤 2 的 initialize 不受影响）
  const secretFile = path.join(workspaceRoot, "secret-unreadable.txt");
  await fs.writeFile(secretFile, "secret\n", "utf8");
  await fs.chmod(secretFile, 0o000);

  const notifications: string[] = [];
  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(customGit, customGit["config"], (msg) => {
    notifications.push(msg);
  });

  try {
    await recovery.rebuild();
  } finally {
    // 恢复文件权限以便 afterEach 清理
    await fs.chmod(secretFile, 0o644);
  }

  // 验证：通知包含基线快照失败告警 + 重建成功通知（步骤 3 失败不视为重建失败）
  assert.ok(
    notifications.some((m) => m.includes("基线快照失败")),
    "应通知基线快照失败"
  );
  assert.ok(
    notifications.some((m) => m.includes("已重建")),
    "步骤 3 失败不阻断重建成功通知"
  );

  // 验证：未进入降级模式（sideGitDir 已就绪，下次 createSnapshot 时再建快照）
  const report = await recovery.verifyIntegrityLightweight();
  assert.ok(!report.failures.includes("degraded_mode"), "不应进入降级模式");
});

test("SG-08f: rebuild 步骤 4 通知失败处置", async () => {
  // 独立 sideGitDir 并破坏 HEAD
  const customDir = path.join(tempDir, "sg08f", "side-git");
  const customGit = new SideGitManager({
    sideGitDir: customDir,
    workspaceRoot,
    autoSnapshot: true,
    maxSnapshots: 50,
  });
  await customGit.initialize();
  await fs.writeFile(path.join(customDir, "HEAD"), "corrupted\n", "utf8");

  // notify 回调始终抛错（模拟 UI 通知通道异常场景）
  const { SideGitRecovery } = await import("../../approval/side-git-recovery.js");
  const recovery = new SideGitRecovery(customGit, customGit["config"], () => {
    throw new Error("UI 通知通道异常");
  });

  // rebuild 应正常完成，不因通知失败而抛出或降级（safeNotify 契约保护）
  await recovery.rebuild();

  // 验证：重建成功，仓库健康（fresh repo + 基线快照 + 工作区完好）
  const report = await recovery.verifyIntegrityLightweight();
  assert.equal(report.healthy, true, "通知失败不应影响重建结果");
});

// ========== SG-13~SG-15：P2-04/P2-06/P2-07 修复的分页过滤、忽略排除、运行统计 ==========

test("SG-13: listSnapshots 分页与过滤（P2-04）", async () => {
  // 创建 3 个 pre_turn 快照（不同 taskId）+ 2 个 post_turn 快照
  for (let i = 1; i <= 3; i++) {
    await fs.writeFile(path.join(workspaceRoot, `file${i}.txt`), `content ${i}\n`, "utf8");
    await sideGit.createSnapshot(generateTurnId(), "pre_turn", `task-00${i}`);
  }
  for (let i = 4; i <= 5; i++) {
    await fs.writeFile(path.join(workspaceRoot, `file${i}.txt`), `content ${i}\n`, "utf8");
    await sideGit.createSnapshot(generateTurnId(), "post_turn", `task-00${i}`);
  }

  // 1. 默认 limit=50：返回全部 5 个（含初始 commit 产生的首个快照 0 个，此处 5 个显式创建）
  const all = await sideGit.listSnapshots();
  assert.equal(all.length, 5, "默认 limit=50 应返回全部快照");

  // 2. limit 分页：limit=2 只返回最近 2 个
  const page1 = await sideGit.listSnapshots({ limit: 2 });
  assert.equal(page1.length, 2, "limit=2 应只返回 2 个");
  const page2 = await sideGit.listSnapshots({ limit: 2, offset: 2 });
  assert.equal(page2.length, 2, "offset=2 应返回第 3~4 个");
  // 分页不重叠
  assert.notEqual(page1[0]!.turnId, page2[0]!.turnId, "分页结果不应重叠");

  // 3. type 过滤：只看 pre_turn 应返回 3 个
  const preOnly = await sideGit.listSnapshots({ type: "pre_turn" });
  assert.equal(preOnly.length, 3, "type=pre_turn 应过滤出 3 个");
  assert.ok(
    preOnly.every((s) => s.type === "pre_turn"),
    "过滤结果应全为 pre_turn"
  );

  // 4. taskId 过滤：精确匹配 task-002 应返回 1 个
  const byTask = await sideGit.listSnapshots({ taskId: "task-002" });
  assert.equal(byTask.length, 1, "taskId 过滤应精确匹配");
  assert.equal(byTask[0]!.taskId, "task-002");
});

test("SG-14: .gitignore 忽略模式不进入快照（P2-06）", async () => {
  // 写入项目 .gitignore：排除 logs/ 目录与 *.tmp 文件
  await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "logs/\n*.tmp\n", "utf8");

  // 重新 initialize 以加载 .gitignore（mergedIgnorePatterns 缓存在 initialize 时构建）
  await sideGit.initialize();

  // 创建应被忽略的文件：node_modules 内置排除、logs/ .gitignore 排除、*.tmp 通配符排除
  await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "x", "utf8");
  await fs.mkdir(path.join(workspaceRoot, "logs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "logs", "app.log"), "log\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "debug.tmp"), "tmp\n", "utf8");
  // 创建应被跟踪的正常文件
  await fs.writeFile(path.join(workspaceRoot, "src.txt"), "tracked\n", "utf8");

  const snapshot = await sideGit.createSnapshot(generateTurnId(), "pre_turn", "task-ignore");

  // .gitignore 本身也是变更文件（未忽略），应出现在 changedFiles 中
  assert.ok(snapshot.changedFiles.includes("src.txt"), "正常文件应被跟踪");
  assert.ok(!snapshot.changedFiles.some((f) => f.startsWith("node_modules/")), "node_modules/ 应被内置排除");
  assert.ok(!snapshot.changedFiles.some((f) => f.startsWith("logs/")), "logs/ 应被 .gitignore 排除");
  assert.ok(!snapshot.changedFiles.includes("debug.tmp"), "*.tmp 应被通配符排除");
});

test("SG-15: getStats 运行统计（P2-07）", async () => {
  // 初始状态：无快照
  const stats0 = await sideGit.getStats();
  assert.equal(stats0.totalSnapshots, 0, "初始无快照");
  assert.equal(stats0.lastSnapshotAt, null);
  assert.equal(stats0.failedSnapshots, 0);

  // 创建 2 个快照
  await fs.writeFile(path.join(workspaceRoot, "s1.txt"), "1\n", "utf8");
  await sideGit.createSnapshot(generateTurnId(), "pre_turn", "task-s1");
  await fs.writeFile(path.join(workspaceRoot, "s2.txt"), "2\n", "utf8");
  await sideGit.createSnapshot(generateTurnId(), "post_turn", "task-s2");

  const stats = await sideGit.getStats();
  assert.equal(stats.totalSnapshots, 2, "totalSnapshots 应累计");
  assert.ok(stats.lastSnapshotAt !== null, "lastSnapshotAt 应存在");
  assert.ok(stats.avgSnapshotMs >= 0, "avgSnapshotMs 应为非负数");
  assert.ok(stats.diskUsageBytes > 0, "diskUsageBytes 应统计到非空目录");

  // 触发一次失败快照（sideGitDir 被删除后 createSnapshot 必失败）
  await fs.rm(sideGitDir, { recursive: true, force: true });
  await sideGit.createSnapshot(generateTurnId(), "pre_turn", "task-fail").catch(() => {});
  const statsAfterFail = await sideGit.getStats();
  assert.equal(statsAfterFail.failedSnapshots, 1, "failedSnapshots 应累计失败次数");

  // 恢复 sideGitDir 供 afterEach 清理路径一致（afterEach 会尝试 rm，目录不存在时 force:true 静默通过）
});
