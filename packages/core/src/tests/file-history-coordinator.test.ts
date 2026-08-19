/**
 * FileHistoryCoordinator 测试套件（S4 首阶段拆分验收测试）
 *
 * 覆盖域（对齐 docs/optimization-plan-20260819.md §5.2 测试计划）：
 * - FHC-001：ensureFileHistorySession 首次创建仓库与分支（幂等，二次返回同一 head）
 * - FHC-002：git dir 解析（<projectDir>/file-history/.git 落盘位置）
 * - FHC-003：checkpoint 记录/校验/恢复闭环（prepare → 变更 → record → canRestore → restore）
 * - FHC-004：prepareFileMutationCheckpoint → updateLatestUserCheckpointHash 的 hash 回写链路
 *   （经 Context 回调读写消息并验证 checkpointHash 落盘——评审指定必覆盖项）
 * - FHC-005：updateLatestUserCheckpointHash 谓词语义（不一致不覆盖 / 一致替换 /
 *   尾部向前定位 / 非目标消息不写）
 * - FHC-006：hash 不匹配拒绝恢复（canRestore false + restore 抛错）
 * - FHC-007：会话隔离（两 sessionId 分支互不影响）
 * - FHC-008：recordUserPromptCheckpoint 空跟踪文件返回值（changedFilePaths 空列表）
 * - FHC-009：isUndoTargetMessage 纯谓词（无需 git）
 *
 * 测试环境说明：
 * - Context 的消息读写回调由测试内 Map 存储实现（函数注入式真实组件装配，非 mock 框架）
 * - HOME 隔离复用 fixtures/session-test-env（projectDir 按 <home>/.deepcode/projects/<projectCode>
 *   真实路径结构构造，与 SessionManager 生产装配一致）
 * - git 可执行守卫 hasGit() + t.skip（沿用 session-file-history.test.ts 模式）
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { FileHistoryCoordinator } from "../file-history-coordinator";
import { getProjectCode } from "../session";
import type { SessionMessage } from "../session";
import { createSessionTestEnv, createTempDir, hasGit } from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

/**
 * 协调器测试装配：直接构造 FileHistoryCoordinator（无需 SessionManager）
 *
 * 消息存储采用 Map 实现 Context 回调契约（真实读写语义）：
 * - listSessionMessages 返回当前存储副本的引用（与生产读文件语义一致）
 * - saveSessionMessages 全量替换存储（与生产写 jsonl 语义一致）
 */
interface CoordinatorFixture {
  /** 工作区（projectRoot） */
  workspace: string;
  /** 隔离 HOME 目录 */
  home: string;
  /** 会话存储根路径（<home>/.deepcode/projects/<projectCode>） */
  projectDir: string;
  /** 待测协调器实例 */
  coordinator: FileHistoryCoordinator;
  /** 消息存储（Context 回调的数据源） */
  messages: Map<string, SessionMessage[]>;
}

/** 构造测试装配（含 HOME 隔离与真实 projectDir 路径结构） */
function createFixture(prefix: string): CoordinatorFixture {
  const workspace = createTempDir(env, `${prefix}-workspace-`);
  const home = createTempDir(env, `${prefix}-home-`);
  env.setHomeDir(home);

  // 按生产路径结构解析 projectDir（session.ts getProjectStorage 同款规则）
  const projectCode = getProjectCode(workspace);
  const projectDir = path.join(home, ".deepcode", "projects", projectCode);

  const messages = new Map<string, SessionMessage[]>();
  const coordinator = new FileHistoryCoordinator({
    projectRoot: workspace,
    getProjectStorage: () => projectDir,
    listSessionMessages: (sessionId: string): SessionMessage[] => messages.get(sessionId) ?? [],
    saveSessionMessages: (sessionId: string, next: SessionMessage[]): void => {
      messages.set(sessionId, next);
    },
  });

  return { workspace, home, projectDir, coordinator, messages };
}

/** 构造测试用 SessionMessage（默认 user + visible + 未压缩，可按需覆写） */
function buildMessage(
  id: string,
  sessionId: string,
  role: SessionMessage["role"],
  overrides: Partial<Pick<SessionMessage, "visible" | "compacted" | "checkpointHash">> = {}
): SessionMessage {
  const now = new Date().toISOString();
  return {
    id,
    sessionId,
    role,
    content: `content-of-${id}`,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
    ...(overrides.checkpointHash !== undefined ? { checkpointHash: overrides.checkpointHash } : {}),
    ...(overrides.visible !== undefined ? { visible: overrides.visible } : {}),
    ...(overrides.compacted !== undefined ? { compacted: overrides.compacted } : {}),
  };
}

test("FHC-001: ensureFileHistorySession 首次创建仓库与分支，二次调用幂等返回同一 head", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { coordinator } = createFixture("fhc-ensure");
  const sessionId = "session-fhc-001";

  const first = coordinator.ensureFileHistorySession(sessionId);
  assert.ok(first, "首次调用应返回 Initial checkpoint 提交哈希");

  const second = coordinator.ensureFileHistorySession(sessionId);
  assert.equal(second, first, "二次调用应幂等返回同一分支 head");

  const head = coordinator.getCurrentCheckpointHash(sessionId);
  assert.equal(head, first, "getCurrentCheckpointHash 应与 ensure 返回值一致");
});

test("FHC-002: git dir 解析为 <projectDir>/file-history/.git", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { projectDir, coordinator } = createFixture("fhc-gitdir");
  coordinator.ensureFileHistorySession("session-fhc-002");

  const gitDir = path.join(projectDir, "file-history", ".git");
  assert.ok(fs.existsSync(gitDir), `file-history git 目录应存在于 ${gitDir}`);
});

test("FHC-003: checkpoint 记录/校验/恢复闭环（prepare → 变更 → record → canRestore → restore）", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { workspace, coordinator } = createFixture("fhc-loop");
  const sessionId = "session-fhc-003";
  const filePath = path.join(workspace, "demo.txt");

  // 步骤 1：初始化分支（空 manifest）
  coordinator.ensureFileHistorySession(sessionId);
  const initialHash = coordinator.getCurrentCheckpointHash(sessionId);
  assert.ok(initialHash, "初始分支 head 应存在");

  // 步骤 2：写入文件并记录变更前检查点（Pre-mutation checkpoint 快照 v1）
  fs.writeFileSync(filePath, "v1\n", "utf8");
  coordinator.prepareFileMutationCheckpoint(sessionId, filePath);
  const preMutationHash = coordinator.getCurrentCheckpointHash(sessionId);
  assert.ok(preMutationHash, "Pre-mutation checkpoint 后应有新 head");
  assert.notEqual(preMutationHash, initialHash, "内容变更后 head 应前进");

  // 步骤 3：模拟工具改写文件并记录变更后检查点（File mutation checkpoint 快照 v2）
  fs.writeFileSync(filePath, "v2\n", "utf8");
  coordinator.recordFileMutationCheckpoint(sessionId, filePath);
  assert.equal(fs.readFileSync(filePath, "utf8"), "v2\n", "变更后文件应为 v2");

  // 步骤 4：校验 pre-mutation hash 可恢复并执行恢复
  assert.equal(
    coordinator.canRestoreCheckpointHash(sessionId, preMutationHash as string),
    true,
    "pre-mutation checkpoint 应可恢复"
  );
  coordinator.restoreCheckpointHash(sessionId, preMutationHash as string);
  assert.equal(fs.readFileSync(filePath, "utf8"), "v1\n", "恢复后文件内容应回滚为 v1");

  // 步骤 5：恢复后分支 head 应指向恢复的 checkpoint
  assert.equal(
    coordinator.getCurrentCheckpointHash(sessionId),
    preMutationHash,
    "恢复后分支 head 应指向目标 checkpoint"
  );
});

test("FHC-004: prepareFileMutationCheckpoint 经 Context 回调完成 hash 回写并落盘", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { workspace, coordinator, messages } = createFixture("fhc-writeback");
  const sessionId = "session-fhc-004";
  const filePath = path.join(workspace, "tracked.txt");

  // 预置一条无 checkpointHash 的可撤销用户消息（hash 回写目标）
  const originalMessage = buildMessage("msg-1", sessionId, "user");
  messages.set(sessionId, [originalMessage]);

  // 先初始化分支并捕获 Initial head（prepare 之前的基准，用于断言 head 前进）
  const initialHash = coordinator.ensureFileHistorySession(sessionId);
  assert.ok(initialHash, "Initial checkpoint 应存在");

  // 写入工作区文件后执行变更前检查点
  fs.writeFileSync(filePath, "writeback-content\n", "utf8");
  coordinator.prepareFileMutationCheckpoint(sessionId, filePath);

  // 验证 1：hash 已回写到最近一条用户消息（经 saveSessionMessages 落盘）
  const stored = messages.get(sessionId);
  assert.ok(stored, "消息存储应存在");
  const updated = stored?.[0];
  assert.ok(updated?.checkpointHash, "用户消息应被回写 checkpointHash");
  assert.notEqual(updated, originalMessage, "回写应产生新消息对象（不可变替换，非原地修改）");

  // 验证 2：回写的 hash 即当前分支 head（Pre-mutation checkpoint）
  const head = coordinator.getCurrentCheckpointHash(sessionId);
  assert.equal(updated?.checkpointHash, head, "回写 hash 应与当前分支 head 一致");

  // 验证 3：head 相对 Initial checkpoint 已前进（文件内容被真实快照）
  assert.notEqual(head, initialHash, "记录文件后 head 应前进（不再指向 Initial 空快照）");
});

test("FHC-005: updateLatestUserCheckpointHash 语义（不一致不覆盖 / 一致替换 / 尾部向前定位 / 非目标不写）", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { coordinator, messages } = createFixture("fhc-update-hash");
  const sessionId = "session-fhc-005";

  // 场景 A：消息已有 checkpointHash 且与 previousHash 不一致 → 保持不变（更新的 checkpoint 占位）
  messages.set(sessionId, [buildMessage("msg-a", sessionId, "user", { checkpointHash: "hash-newer" })]);
  coordinator.updateLatestUserCheckpointHash(sessionId, "hash-older", "hash-target");
  assert.equal(
    messages.get(sessionId)?.[0]?.checkpointHash,
    "hash-newer",
    "previousHash 不匹配时不应覆盖（保持更新值）"
  );

  // 场景 B：消息 checkpointHash 与 previousHash 一致 → 替换为 nextHash
  messages.set(sessionId, [buildMessage("msg-b", sessionId, "user", { checkpointHash: "hash-older" })]);
  coordinator.updateLatestUserCheckpointHash(sessionId, "hash-older", "hash-target");
  assert.equal(messages.get(sessionId)?.[0]?.checkpointHash, "hash-target", "previousHash 匹配时应替换为 nextHash");

  // 场景 C：无 checkpointHash（undefined）→ 无条件写入 nextHash
  messages.set(sessionId, [buildMessage("msg-c", sessionId, "user")]);
  coordinator.updateLatestUserCheckpointHash(sessionId, "hash-any", "hash-filled");
  assert.equal(messages.get(sessionId)?.[0]?.checkpointHash, "hash-filled", "消息无 checkpointHash 时应无条件写入");

  // 场景 D：尾部向前定位第一条可撤销用户消息（跳过其后的 assistant/tool 消息）
  const first = buildMessage("msg-d1", sessionId, "user");
  const assistant = buildMessage("msg-d2", sessionId, "assistant");
  const tool = buildMessage("msg-d3", sessionId, "tool");
  messages.set(sessionId, [first, assistant, tool]);
  coordinator.updateLatestUserCheckpointHash(sessionId, undefined, "hash-tail");
  const stored = messages.get(sessionId);
  assert.equal(stored?.[0]?.checkpointHash, "hash-tail", "应定位到第一条（尾部向前）用户消息");
  assert.equal(stored?.[1]?.checkpointHash, undefined, "assistant 消息不应被写入");
  assert.equal(stored?.[2]?.checkpointHash, undefined, "tool 消息不应被写入");

  // 场景 E：无可撤销目标消息（仅 assistant + compacted user + invisible user）→ 不写入
  messages.set(sessionId, [
    buildMessage("msg-e1", sessionId, "assistant"),
    buildMessage("msg-e2", sessionId, "user", { compacted: true }),
    buildMessage("msg-e3", sessionId, "user", { visible: false }),
  ]);
  coordinator.updateLatestUserCheckpointHash(sessionId, undefined, "hash-none");
  const untouched = messages.get(sessionId);
  assert.equal(
    untouched?.every((message) => message.checkpointHash === undefined),
    true,
    "无目标消息时全部保持原状"
  );
});

test("FHC-006: hash 不匹配拒绝恢复（canRestore false + restore 抛错）", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { coordinator } = createFixture("fhc-reject");
  const sessionId = "session-fhc-006";
  coordinator.ensureFileHistorySession(sessionId);

  // 格式非法的 hash：canRestore false
  assert.equal(coordinator.canRestoreCheckpointHash(sessionId, "not-a-hash"), false, "非法格式 hash 应拒绝");

  // 格式合法但不存在的 hash：canRestore false
  const missingHash = "e".repeat(40);
  assert.equal(coordinator.canRestoreCheckpointHash(sessionId, missingHash), false, "不存在的 hash 应拒绝");

  // 格式非法的 hash：restore 抛错（Invalid checkpoint hash）
  assert.throws(
    () => coordinator.restoreCheckpointHash(sessionId, "not-a-hash"),
    /Invalid checkpoint hash/,
    "非法格式 hash restore 应抛错"
  );

  // 格式合法但不存在的 hash：restore 抛错（git cat-file 失败）
  assert.throws(() => coordinator.restoreCheckpointHash(sessionId, missingHash), "不存在的 hash restore 应抛错");
});

test("FHC-007: 会话隔离（两 sessionId 分支独立演进互不影响）", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { workspace, coordinator } = createFixture("fhc-isolation");
  const sessionA = "session-fhc-007a";
  const sessionB = "session-fhc-007b";

  // 会话 A：记录文件 v1
  const fileA = path.join(workspace, "a.txt");
  fs.writeFileSync(fileA, "content-a\n", "utf8");
  coordinator.ensureFileHistorySession(sessionA);
  coordinator.prepareFileMutationCheckpoint(sessionA, fileA);
  const hashA = coordinator.getCurrentCheckpointHash(sessionA);

  // 会话 B：独立初始化（分支级隔离——每会话独立分支 refs/heads/<sessionId>）
  const headB = coordinator.ensureFileHistorySession(sessionB);
  assert.ok(headB, "会话 B 分支应可独立初始化");
  assert.notEqual(hashA, headB, "两会话分支 head 应不同（A 已前进，B 为 Initial）");

  // 会话 A 继续前进（记录第二份文件），B 的 head 不受影响
  const fileA2 = path.join(workspace, "a2.txt");
  fs.writeFileSync(fileA2, "content-a2\n", "utf8");
  coordinator.recordFileMutationCheckpoint(sessionA, fileA2);
  assert.equal(
    coordinator.getCurrentCheckpointHash(sessionB),
    headB,
    "会话 B 的分支 head 不应随会话 A 的 checkpoint 前进而变化"
  );

  // 各自恢复自身 checkpoint 均可行（hash 对两会话均为自身分支可达目标）
  assert.equal(
    coordinator.canRestoreCheckpointHash(sessionA, hashA as string),
    true,
    "会话 A 应能恢复自己的历史 checkpoint"
  );
  assert.equal(
    coordinator.canRestoreCheckpointHash(sessionB, headB as string),
    true,
    "会话 B 应能恢复自己的 Initial checkpoint"
  );

  // 恢复 A 到首个 checkpoint：仅移动 A 分支，B 分支保持不变
  coordinator.restoreCheckpointHash(sessionA, hashA as string);
  assert.equal(coordinator.getCurrentCheckpointHash(sessionB), headB, "会话 A 的恢复操作不应影响会话 B 的分支 head");
});

test("FHC-008: recordUserPromptCheckpoint 空跟踪文件时返回空变更列表与当前 head", (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const { coordinator } = createFixture("fhc-prompt");
  const sessionId = "session-fhc-008";
  coordinator.ensureFileHistorySession(sessionId);

  // manifest 无跟踪文件 → 不产生新提交，changedFilePaths 为空
  const result = coordinator.recordUserPromptCheckpoint(sessionId);
  assert.deepEqual(result.changedFilePaths, [], "空 manifest 时 changedFilePaths 应为空");
  assert.equal(
    result.checkpointHash,
    coordinator.getCurrentCheckpointHash(sessionId),
    "checkpointHash 应为当前分支 head"
  );
});

test("FHC-009: isUndoTargetMessage 谓词（user + visible + 未压缩）", () => {
  const { coordinator } = createFixture("fhc-predicate");
  const sessionId = "session-fhc-009";

  // 命中：user + visible + 未压缩
  assert.equal(
    coordinator.isUndoTargetMessage(buildMessage("m1", sessionId, "user")),
    true,
    "user + visible + 未压缩应为 undo 目标"
  );

  // 排除：assistant / tool / system 角色
  assert.equal(coordinator.isUndoTargetMessage(buildMessage("m2", sessionId, "assistant")), false, "assistant 应排除");
  assert.equal(coordinator.isUndoTargetMessage(buildMessage("m3", sessionId, "tool")), false, "tool 应排除");
  assert.equal(coordinator.isUndoTargetMessage(buildMessage("m4", sessionId, "system")), false, "system 应排除");

  // 排除：不可见 / 已压缩的 user 消息
  assert.equal(
    coordinator.isUndoTargetMessage(buildMessage("m5", sessionId, "user", { visible: false })),
    false,
    "不可见 user 消息应排除"
  );
  assert.equal(
    coordinator.isUndoTargetMessage(buildMessage("m6", sessionId, "user", { compacted: true })),
    false,
    "已压缩 user 消息应排除"
  );
});
