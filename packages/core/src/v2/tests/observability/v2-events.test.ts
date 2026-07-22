/**
 * V2EventLogger 单元测试（EV-01 ~ EV-12 + 边界用例）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §12.1 日志事件体系
 *
 * 测试覆盖：
 * - EV-01: logApproval 记录审批决策事件
 * - EV-02: logCompression 记录上下文压缩事件
 * - EV-03: logRetrieval 记录经验检索事件
 * - EV-04: logSnapshot 记录 side-git 快照事件
 * - EV-05: JSON Lines 格式追加（每行一条 JSON）
 * - EV-06: 日志文件名 v2-<YYYY-MM-DD>.log
 * - EV-07: 落盘前经 SensitiveInfoRedactor 脱敏
 * - EV-08: 4 类事件 type 判别字段正确
 * - EV-09: timestamp 与 durationMs 公共字段
 * - EV-10: 多次写入追加（不覆盖已有日志）
 * - EV-11: 日志目录自动创建（recursive mkdir）
 * - EV-12: getTodayLogPath 返回今日日志路径
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 *
 * @module v2/tests/observability/v2-events.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { V2EventLogger } from "../../observability/v2-events";
import { SensitiveInfoRedactor } from "../../memory/redaction";

// ============================================================================
// 测试 fixture：每个用例独立的临时日志目录
// ============================================================================

let tempLogDir: string;
let tempRedactionLog: string;

beforeEach(() => {
  tempLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-v2-events-"));
  tempRedactionLog = path.join(tempLogDir, "redaction.log");
});

afterEach(() => {
  fs.rmSync(tempLogDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建 V2EventLogger 实例（使用临时目录）
 */
function createLogger(): V2EventLogger {
  const redactor = new SensitiveInfoRedactor(undefined, tempRedactionLog);
  return new V2EventLogger(tempLogDir, redactor);
}

/**
 * 读取今日日志文件内容
 */
function readTodayLog(logger: V2EventLogger): string[] {
  const logPath = logger.getTodayLogPath();
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const content = fs.readFileSync(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

// ============================================================================
// EV-01 ~ EV-12 测试用例
// ============================================================================

test("EV-01: logApproval 记录审批决策事件", async () => {
  const logger = createLogger();

  await logger.logApproval({
    timestamp: "2026-07-20T10:30:00.000Z",
    durationMs: 5,
    taskId: "task-001",
    tool: "bash",
    decision: "deny",
    riskLevel: "destructive",
    ruleName: "blacklist-rm-rf-root",
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 1, "应写入一条日志");

  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "approval");
  assert.equal(event.taskId, "task-001");
  assert.equal(event.tool, "bash");
  assert.equal(event.decision, "deny");
  assert.equal(event.riskLevel, "destructive");
  assert.equal(event.ruleName, "blacklist-rm-rf-root");
  assert.equal(event.timestamp, "2026-07-20T10:30:00.000Z");
  assert.equal(event.durationMs, 5);
});

test("EV-02: logCompression 记录上下文压缩事件", async () => {
  const logger = createLogger();

  await logger.logCompression({
    timestamp: "2026-07-20T10:31:00.000Z",
    durationMs: 120,
    sessionId: "session-abc",
    beforeTokens: 100000,
    afterTokens: 50000,
    strategy: "sliding_window",
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 1);

  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "compression");
  assert.equal(event.sessionId, "session-abc");
  assert.equal(event.beforeTokens, 100000);
  assert.equal(event.afterTokens, 50000);
  assert.equal(event.strategy, "sliding_window");
});

test("EV-03: logRetrieval 记录经验检索事件", async () => {
  const logger = createLogger();

  await logger.logRetrieval({
    timestamp: "2026-07-20T10:32:00.000Z",
    durationMs: 80,
    query: "auth token refresh",
    resultCount: 5,
    topScore: 0.92,
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 1);

  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "retrieval");
  assert.equal(event.query, "auth token refresh");
  assert.equal(event.resultCount, 5);
  assert.equal(event.topScore, 0.92);
});

test("EV-04: logSnapshot 记录 side-git 快照事件", async () => {
  const logger = createLogger();

  await logger.logSnapshot({
    timestamp: "2026-07-20T10:33:00.000Z",
    durationMs: 200,
    taskId: "task-002",
    action: "create",
    commitHash: "abc123def456",
    fileCount: 15,
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 1);

  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "snapshot");
  assert.equal(event.taskId, "task-002");
  assert.equal(event.action, "create");
  assert.equal(event.commitHash, "abc123def456");
  assert.equal(event.fileCount, 15);
});

test("EV-05: JSON Lines 格式追加（每行一条 JSON）", async () => {
  const logger = createLogger();

  // 写入 3 条不同类型的事件
  await logger.logApproval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    taskId: "t1",
    tool: "edit",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });
  await logger.logCompression({
    timestamp: "2026-07-20T10:01:00.000Z",
    durationMs: 2,
    sessionId: "s1",
    beforeTokens: 1000,
    afterTokens: 500,
    strategy: "truncation",
  });
  await logger.logRetrieval({
    timestamp: "2026-07-20T10:02:00.000Z",
    durationMs: 3,
    query: "test query",
    resultCount: 0,
    topScore: 0,
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 3, "应写入 3 条日志");

  // 每行应为合法 JSON
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `每行应为合法 JSON: ${line}`);
  }

  // 验证事件类型按写入顺序
  assert.equal(JSON.parse(lines[0]).type, "approval");
  assert.equal(JSON.parse(lines[1]).type, "compression");
  assert.equal(JSON.parse(lines[2]).type, "retrieval");
});

test("EV-06: 日志文件名 v2-<YYYY-MM-DD>.log", async () => {
  const logger = createLogger();

  const logPath = logger.getTodayLogPath();
  const fileName = path.basename(logPath);

  // 文件名格式：v2-YYYY-MM-DD.log
  assert.match(fileName, /^v2-\d{4}-\d{2}-\d{2}\.log$/);

  // 写入一条事件后，文件应存在
  await logger.logApproval({
    timestamp: new Date().toISOString(),
    durationMs: 1,
    taskId: "t1",
    tool: "edit",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });
  assert.ok(fs.existsSync(logPath), "日志文件应存在");
});

test("EV-07: 落盘前经 SensitiveInfoRedactor 脱敏", async () => {
  const logger = createLogger();

  // 在 retrieval 事件中嵌入敏感信息
  await logger.logRetrieval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 10,
    query: "password=hunter2 api_key=sk-abc123",
    resultCount: 1,
    topScore: 0.5,
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 1);

  // 验证日志中的敏感信息已被脱敏
  const logContent = lines[0];
  assert.ok(!logContent.includes("hunter2"), "日志中不应包含明文密码");
  assert.ok(!logContent.includes("sk-abc123"), "日志中不应包含明文 API Key");
  assert.ok(logContent.includes("[REDACTED]"), "敏感信息应被替换为 [REDACTED]");

  // 验证 JSON 仍可解析（脱敏不破坏 JSON 结构）
  const event = JSON.parse(logContent);
  assert.equal(event.type, "retrieval");
  assert.match(event.query, /\[REDACTED\]/);
});

test("EV-08: 4 类事件 type 判别字段正确", async () => {
  const logger = createLogger();

  await logger.logApproval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    taskId: "t",
    tool: "edit",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });
  await logger.logCompression({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    sessionId: "s",
    beforeTokens: 1,
    afterTokens: 1,
    strategy: "summarization",
  });
  await logger.logRetrieval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    query: "q",
    resultCount: 0,
    topScore: 0,
  });
  await logger.logSnapshot({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    taskId: "t",
    action: "restore",
    commitHash: "abc",
    fileCount: 1,
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 4);

  // 验证 4 类事件 type 字段
  const types = lines.map((line) => JSON.parse(line).type);
  assert.ok(types.includes("approval"));
  assert.ok(types.includes("compression"));
  assert.ok(types.includes("retrieval"));
  assert.ok(types.includes("snapshot"));
});

test("EV-09: timestamp 与 durationMs 公共字段", async () => {
  const logger = createLogger();

  const expectedTimestamp = "2026-07-20T10:30:45.123Z";
  const expectedDuration = 42;

  await logger.logApproval({
    timestamp: expectedTimestamp,
    durationMs: expectedDuration,
    taskId: "t",
    tool: "edit",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });

  const lines = readTodayLog(logger);
  const event = JSON.parse(lines[0]);

  // 验证 V2LogEventBase 公共字段
  assert.equal(event.timestamp, expectedTimestamp, "应保留 timestamp 字段");
  assert.equal(event.durationMs, expectedDuration, "应保留 durationMs 字段");
});

test("EV-10: 多次写入追加（不覆盖已有日志）", async () => {
  const logger = createLogger();

  // 第一次写入
  await logger.logApproval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    taskId: "t1",
    tool: "edit",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });

  // 第二次写入
  await logger.logApproval({
    timestamp: "2026-07-20T11:00:00.000Z",
    durationMs: 2,
    taskId: "t2",
    tool: "edit",
    decision: "deny",
    riskLevel: "caution",
    ruleName: "some-rule",
  });

  const lines = readTodayLog(logger);
  assert.equal(lines.length, 2, "应追加而非覆盖");

  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.taskId, "t1");
  assert.equal(second.taskId, "t2");
});

test("EV-11: 日志目录自动创建（recursive mkdir）", async () => {
  // 使用一个不存在的嵌套目录
  const nestedLogDir = path.join(tempLogDir, "nested", "deep", "logs");
  const redactor = new SensitiveInfoRedactor(undefined, tempRedactionLog);
  const logger = new V2EventLogger(nestedLogDir, redactor);

  // 写入前目录不应存在
  assert.ok(!fs.existsSync(nestedLogDir), "目录初始不应存在");

  await logger.logApproval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    taskId: "t",
    tool: "edit",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });

  // 写入后目录应自动创建
  assert.ok(fs.existsSync(nestedLogDir), "目录应自动创建");
  const logPath = logger.getTodayLogPath();
  assert.ok(fs.existsSync(logPath), "日志文件应存在");
});

test("EV-12: getTodayLogPath 返回今日日志路径", () => {
  const logger = createLogger();
  const logPath = logger.getTodayLogPath();

  // 验证路径在 logDir 下
  assert.ok(logPath.startsWith(tempLogDir), "路径应在 logDir 下");

  // 验证文件名格式
  const fileName = path.basename(logPath);
  assert.match(fileName, /^v2-\d{4}-\d{2}-\d{2}\.log$/);

  // 验证日期为今天
  const now = new Date();
  const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.ok(fileName.includes(expectedDate), `文件名应包含今日日期 ${expectedDate}`);
});

test("EV-13: SnapshotEvent prune 动作 commitHash 为 null", async () => {
  const logger = createLogger();

  await logger.logSnapshot({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 50,
    taskId: "t",
    action: "prune",
    commitHash: null,
    fileCount: 0,
  });

  const lines = readTodayLog(logger);
  const event = JSON.parse(lines[0]);
  assert.equal(event.action, "prune");
  assert.equal(event.commitHash, null);
  assert.equal(event.fileCount, 0);
});

test("EV-14: ApprovalEvent ruleName 为 null（未命中规则）", async () => {
  const logger = createLogger();

  await logger.logApproval({
    timestamp: "2026-07-20T10:00:00.000Z",
    durationMs: 1,
    taskId: "t",
    tool: "read",
    decision: "allow",
    riskLevel: "benign",
    ruleName: null,
  });

  const lines = readTodayLog(logger);
  const event = JSON.parse(lines[0]);
  assert.equal(event.ruleName, null, "未命中规则时 ruleName 应为 null");
});
