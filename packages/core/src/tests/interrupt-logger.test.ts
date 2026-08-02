/**
 * 中断事件日志记录器单元测试与集成测试 —— D-4 修复
 *
 * 测试范围：
 * - 单元测试（17 个）：验证 logInterruptEvent 函数的 7 种事件类型、边界条件、容错处理
 * - 集成测试（8 个）：验证真实 InterruptQueue / BackgroundTaskRunner 集成时的事件触发
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接调用 logInterruptEvent / new InterruptQueue() / new BackgroundTaskRunner()
 * - StubSessionHandle 真实实现 SessionHandle 接口（不调用 LLM，但真实实现接口契约）
 * - 中文注释
 *
 * 测试隔离：
 * - 每个测试用例使用 process.env.HOME 临时切换
 * - 使用 fs.mkdtempSync 创建临时目录，finally 块清理
 *
 * 设计依据：
 * - 设计文档 CLI-LOG-FIX-DESIGN.md §3.4 定义 7 种事件类型
 * - D-4 修复：InterruptQueue 和 BackgroundTaskRunner 已接入 interrupt-logger
 *
 * @module tests/interrupt-logger
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// 被测组件：interrupt-logger
import { logInterruptEvent, getInterruptLogPath } from "../common/interrupt-logger";
import type { InterruptEvent } from "../common/interrupt-logger";

// 集成测试依赖：真实 InterruptQueue / BackgroundTaskRunner / TaskRegistry
import { InterruptQueue } from "../interrupts/interrupt-queue";
import { BackgroundTaskRunner } from "../interrupts/background-runner";
import type { SessionHandle } from "../interrupts/background-runner";
import { TaskRegistry } from "../interrupts/task-registry";
import type { InjectedInstruction } from "../interrupts/types";

// ============================================================================
// 测试辅助：StubSessionHandle（真实实现，非 mock）
// ============================================================================

/**
 * 真实 SessionHandle 实现（非 mock）
 *
 * 不调用真实 LLM，但真实实现 SessionHandle 接口契约。
 * 通过 behavior 参数控制行为，覆盖测试场景。
 *
 * 行为模式：
 * - "succeed"：handleUserPrompt 立即 resolve（任务成功）
 * - "fail"：handleUserPrompt 立即 reject（任务失败）
 * - "hang"：handleUserPrompt 返回永不 resolve 的 Promise（用于测试取消场景）
 */
class StubSessionHandle implements SessionHandle {
  /** 行为模式 */
  private readonly behavior: "succeed" | "fail" | "hang";
  /** 可选的 prompt 捕获回调（用于断言传入的 prompt） */
  private readonly onHandle?: (prompt: string) => void;

  /**
   * 构造 StubSessionHandle
   *
   * @param behavior 行为模式
   * @param onHandle 可选的 prompt 捕获回调
   */
  constructor(behavior: "succeed" | "fail" | "hang", onHandle?: (prompt: string) => void) {
    this.behavior = behavior;
    this.onHandle = onHandle;
  }

  /**
   * 启动会话（与 SessionManager.handleUserPrompt 同构）
   *
   * 根据 behavior 返回不同的 Promise：
   * - succeed：立即 resolve（模拟 LLM 成功响应）
   * - fail：立即 reject（模拟 LLM 调用失败）
   * - hang：返回永不 resolve 的 Promise（模拟长时间任务，用于测试取消）
   */
  async handleUserPrompt(prompt: string): Promise<void> {
    if (this.onHandle) {
      this.onHandle(prompt);
    }
    if (this.behavior === "fail") {
      throw new Error("stub failure");
    }
    if (this.behavior === "hang") {
      // 返回永不 resolve 的 Promise，直到外部 cancel 触发
      return new Promise<void>(() => {});
    }
    // succeed：立即 resolve
  }
}

// ============================================================================
// 测试辅助：临时 HOME 隔离
// ============================================================================

/**
 * 在临时 HOME 目录下执行测试
 *
 * 每个测试用例使用独立的临时目录，避免日志文件相互干扰。
 * finally 块确保无论测试成功或失败，HOME 都被恢复，临时目录被清理。
 *
 * @param fn 测试函数，接收临时 HOME 路径
 * @returns 测试函数的返回值
 */
async function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-interrupt-logger-"));
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ============================================================================
// 测试辅助：读取并解析日志文件
// ============================================================================

/**
 * 读取并解析中断事件日志文件
 *
 * 每行一个 JSON 对象，返回解析后的数组。
 * 文件不存在时返回空数组。
 *
 * @param logPath 日志文件路径
 * @returns 解析后的事件数组（每行一个对象）
 */
function readInterruptLog(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const content = fs.readFileSync(logPath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ============================================================================
// 测试辅助：构造真实 InjectedInstruction fixture
// ============================================================================

/**
 * 构造测试用 InjectedInstruction
 *
 * 真实结构（非 mock），使用 crypto.randomUUID() 生成 id。
 *
 * @param text 指令文本
 * @param source 注入来源（默认 user）
 * @returns 真实 InjectedInstruction 对象（冻结）
 */
function createInstruction(text: string, source: "user" | "llm" = "user"): InjectedInstruction {
  return Object.freeze({
    id: crypto.randomUUID(),
    text,
    enqueuedAt: new Date().toISOString(),
    source,
  });
}

// ============================================================================
// 测试辅助：构造真实 BackgroundTaskRunner fixture
// ============================================================================

/**
 * 构造真实 BackgroundTaskRunner fixture
 *
 * 使用真实的 TaskRegistry 和 StubSessionHandle（真实实现 SessionHandle 接口）。
 *
 * @param behavior StubSessionHandle 行为模式（默认 hang，任务不自动完成）
 * @returns 真实 BackgroundTaskRunner 与 TaskRegistry
 */
function createRunner(behavior: "succeed" | "fail" | "hang" = "hang"): {
  runner: BackgroundTaskRunner;
  registry: TaskRegistry;
} {
  const registry = new TaskRegistry();
  const runner = new BackgroundTaskRunner({
    sharedSessionOptions: {
      sessionManagerFactory: () => new StubSessionHandle(behavior),
    },
    registry,
  });
  return { runner, registry };
}

// ============================================================================
// 测试辅助：等待事件循环
// ============================================================================

/**
 * 等待指定的毫秒数（让异步任务完成）
 *
 * @param ms 等待毫秒数（默认 20ms）
 */
function waitMs(ms: number = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 第一部分：单元测试（17 个，验证 logInterruptEvent 函数）
// ============================================================================

// ----------------------------------------------------------------------------
// TC-IL-001: interrupt.enqueued 事件写入正确（事件类型 1/7）
// ----------------------------------------------------------------------------

test("TC-IL-001: interrupt.enqueued 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 interrupt.enqueued 事件（指令入队）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:00:00.000Z",
      eventType: "interrupt.enqueued",
      instructionText: "加上错误处理",
      instructionSource: "user",
      queueSize: 1,
    };
    logInterruptEvent(event);

    // 读取并验证日志
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "interrupt.enqueued");
    assert.equal(entries[0].timestamp, "2026-07-25T10:00:00.000Z");
    assert.equal(entries[0].instructionText, "加上错误处理");
    assert.equal(entries[0].instructionSource, "user");
    assert.equal(entries[0].queueSize, 1);
  });
});

// ----------------------------------------------------------------------------
// TC-IL-002: interrupt.drained 事件写入正确（事件类型 2/7）
// ----------------------------------------------------------------------------

test("TC-IL-002: interrupt.drained 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 interrupt.drained 事件（指令被消费）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:01:00.000Z",
      eventType: "interrupt.drained",
      queueSize: 0,
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "interrupt.drained");
    assert.equal(entries[0].timestamp, "2026-07-25T10:01:00.000Z");
    assert.equal(entries[0].queueSize, 0);
  });
});

// ----------------------------------------------------------------------------
// TC-IL-003: task.started 事件写入正确（事件类型 3/7）
// ----------------------------------------------------------------------------

test("TC-IL-003: task.started 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 task.started 事件（后台任务启动）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:02:00.000Z",
      eventType: "task.started",
      taskId: "t-abc-001",
      taskKind: "chat",
      taskStatus: "running",
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "task.started");
    assert.equal(entries[0].taskId, "t-abc-001");
    assert.equal(entries[0].taskKind, "chat");
    assert.equal(entries[0].taskStatus, "running");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-004: task.succeeded 事件写入正确（事件类型 4/7）
// ----------------------------------------------------------------------------

test("TC-IL-004: task.succeeded 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 task.succeeded 事件（任务成功完成）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:03:00.000Z",
      eventType: "task.succeeded",
      taskId: "t-abc-002",
      taskKind: "chat",
      taskStatus: "succeeded",
      sessionId: "t-abc-002",
      durationMs: 1500,
      reason: "completed",
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "task.succeeded");
    assert.equal(entries[0].taskId, "t-abc-002");
    assert.equal(entries[0].taskKind, "chat");
    assert.equal(entries[0].taskStatus, "succeeded");
    assert.equal(entries[0].sessionId, "t-abc-002");
    assert.equal(entries[0].durationMs, 1500);
    assert.equal(entries[0].reason, "completed");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-005: task.failed 事件写入正确（事件类型 5/7）
// ----------------------------------------------------------------------------

test("TC-IL-005: task.failed 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 task.failed 事件（任务失败）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:04:00.000Z",
      eventType: "task.failed",
      taskId: "t-abc-003",
      taskKind: "chat",
      taskStatus: "failed",
      sessionId: "t-abc-003",
      durationMs: 800,
      reason: "LLM 调用失败",
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "task.failed");
    assert.equal(entries[0].taskId, "t-abc-003");
    assert.equal(entries[0].taskStatus, "failed");
    assert.equal(entries[0].durationMs, 800);
    assert.equal(entries[0].reason, "LLM 调用失败");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-006: task.cancelled 事件写入正确（事件类型 6/7）
// ----------------------------------------------------------------------------

test("TC-IL-006: task.cancelled 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 task.cancelled 事件（任务被取消）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:05:00.000Z",
      eventType: "task.cancelled",
      taskId: "t-abc-004",
      taskKind: "chat",
      taskStatus: "cancelled",
      sessionId: "t-abc-004",
      durationMs: 300,
      reason: "用户取消",
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "task.cancelled");
    assert.equal(entries[0].taskId, "t-abc-004");
    assert.equal(entries[0].taskStatus, "cancelled");
    assert.equal(entries[0].reason, "用户取消");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-007: task.injected 事件写入正确（事件类型 7/7）
// ----------------------------------------------------------------------------

test("TC-IL-007: task.injected 事件写入正确", async () => {
  await withTempHome(async () => {
    // 构造 task.injected 事件（指令注入到任务）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T10:06:00.000Z",
      eventType: "task.injected",
      taskId: "t-abc-005",
      taskKind: "chat",
      taskStatus: "running",
      instructionText: "改用 TypeScript 实现",
      instructionSource: "user",
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "task.injected");
    assert.equal(entries[0].taskId, "t-abc-005");
    assert.equal(entries[0].taskKind, "chat");
    assert.equal(entries[0].taskStatus, "running");
    assert.equal(entries[0].instructionText, "改用 TypeScript 实现");
    assert.equal(entries[0].instructionSource, "user");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-008: 指令文本超过 200 字符时截断（边界-截断）
// ----------------------------------------------------------------------------

test("TC-IL-008: 指令文本超过 200 字符时截断", async () => {
  await withTempHome(async () => {
    // 构造 201 字符的指令文本
    const longText = "x".repeat(201);
    const event: InterruptEvent = {
      timestamp: new Date().toISOString(),
      eventType: "interrupt.enqueued",
      instructionText: longText,
      instructionSource: "user",
      queueSize: 1,
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    // 验证指令文本被截断（前 200 字符 + ...(total 201 chars)）
    const expected = `${"x".repeat(200)}...(total 201 chars)`;
    assert.equal(
      entries[0].instructionText,
      expected,
      "超过 200 字符的指令文本应被截断为前 200 字符 + ...(total N chars)"
    );
  });
});

// ----------------------------------------------------------------------------
// TC-IL-009: 指令文本等于 200 字符时不截断（边界-截断）
// ----------------------------------------------------------------------------

test("TC-IL-009: 指令文本等于 200 字符时不截断", async () => {
  await withTempHome(async () => {
    // 构造刚好 200 字符的指令文本（边界值，不应截断）
    const exactText = "y".repeat(200);
    const event: InterruptEvent = {
      timestamp: new Date().toISOString(),
      eventType: "interrupt.enqueued",
      instructionText: exactText,
      instructionSource: "user",
      queueSize: 1,
    };
    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    // 验证指令文本原样保留（未截断）
    assert.equal(entries[0].instructionText, exactText, "等于 200 字符的指令文本不应被截断");
    assert.equal((entries[0].instructionText as string).length, 200, "指令文本长度应为 200");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-010: 日志文件不存在时自动创建目录（边界-目录创建）
// ----------------------------------------------------------------------------

test("TC-IL-010: 日志文件不存在时自动创建目录", async () => {
  await withTempHome(async () => {
    // 验证初始状态：~/.deepcodex/logs/ 目录不存在
    const logPath = getInterruptLogPath();
    const logDir = path.dirname(logPath);
    assert.ok(!fs.existsSync(logDir), "测试开始前日志目录应不存在");

    // 调用 logInterruptEvent（应自动创建目录）
    const event: InterruptEvent = {
      timestamp: new Date().toISOString(),
      eventType: "task.started",
      taskId: "t-dir-test",
      taskKind: "chat",
      taskStatus: "running",
    };
    logInterruptEvent(event);

    // 验证目录已创建
    assert.ok(fs.existsSync(logDir), "日志目录应被自动创建");
    // 验证日志文件已创建
    assert.ok(fs.existsSync(logPath), "日志文件应被自动创建");

    // 验证日志内容正确
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    assert.equal(entries[0].eventType, "task.started");
    assert.equal(entries[0].taskId, "t-dir-test");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-011: 多条事件追加写入（不覆盖）（边界-追加模式）
// ----------------------------------------------------------------------------

test("TC-IL-011: 多条事件追加写入（不覆盖）", async () => {
  await withTempHome(async () => {
    // 连续写入 3 条不同类型的事件
    const events: InterruptEvent[] = [
      {
        timestamp: "2026-07-25T11:00:00.000Z",
        eventType: "interrupt.enqueued",
        instructionText: "指令 1",
        instructionSource: "user",
        queueSize: 1,
      },
      {
        timestamp: "2026-07-25T11:01:00.000Z",
        eventType: "task.started",
        taskId: "t-001",
        taskKind: "chat",
        taskStatus: "running",
      },
      {
        timestamp: "2026-07-25T11:02:00.000Z",
        eventType: "task.succeeded",
        taskId: "t-001",
        taskKind: "chat",
        taskStatus: "succeeded",
        durationMs: 1000,
      },
    ];

    for (const event of events) {
      logInterruptEvent(event);
    }

    // 验证 3 条日志都被追加（不覆盖）
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 3, "应有 3 条日志（追加模式）");

    // 验证顺序与写入一致
    assert.equal(entries[0].eventType, "interrupt.enqueued");
    assert.equal(entries[0].timestamp, "2026-07-25T11:00:00.000Z");
    assert.equal(entries[1].eventType, "task.started");
    assert.equal(entries[1].taskId, "t-001");
    assert.equal(entries[2].eventType, "task.succeeded");
    assert.equal(entries[2].taskStatus, "succeeded");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-012: 日志文件超过 10MB 时触发轮转（集成轮转）
// ----------------------------------------------------------------------------

test("TC-IL-012: 日志文件超过 10MB 时触发轮转", async () => {
  await withTempHome(async () => {
    const logPath = getInterruptLogPath();
    // 确保日志目录存在
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // 预先写入超过 10MB 的内容（10MB + 100 字节）
    // 10MB = 10 * 1024 * 1024 = 10485760 字节
    const maxSize = 10 * 1024 * 1024;
    const largeContent = "x".repeat(maxSize + 100);
    fs.writeFileSync(logPath, largeContent, "utf8");
    assert.ok(fs.existsSync(logPath), "预写入大文件应存在");

    // 调用 logInterruptEvent（应触发轮转）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T12:00:00.000Z",
      eventType: "task.started",
      taskId: "t-rotate-test",
      taskKind: "chat",
      taskStatus: "running",
    };
    logInterruptEvent(event);

    // 验证原文件被重命名为 .1（轮转备份）
    assert.ok(fs.existsSync(`${logPath}.1`), "轮转后应生成 .1 备份文件");
    // 验证 .1 备份文件大小为原大文件大小
    const backupStats = fs.statSync(`${logPath}.1`);
    assert.equal(backupStats.size, largeContent.length, ".1 备份应包含原大文件内容");

    // 验证新日志文件存在，且仅包含新写入的事件（不含旧内容）
    assert.ok(fs.existsSync(logPath), "轮转后应创建新的日志文件");
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "新日志文件应仅包含 1 条新事件");
    assert.equal(entries[0].eventType, "task.started");
    assert.equal(entries[0].taskId, "t-rotate-test");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-013: rotateLogIfNeeded 失败时仍写入日志（容错-降级）
// ----------------------------------------------------------------------------

test("TC-IL-013: rotateLogIfNeeded 失败时仍写入日志", async () => {
  await withTempHome(async () => {
    const logPath = getInterruptLogPath();
    // 确保日志目录存在
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // 预先写入超过 10MB 的内容（触发轮转条件）
    const maxSize = 10 * 1024 * 1024;
    const largeContent = "y".repeat(maxSize + 1);
    fs.writeFileSync(logPath, largeContent, "utf8");

    // 创建 logPath.1 目录，使 rename logPath → logPath.1 失败
    // （在 Unix 上，rename 文件到目录会失败，rotateLogIfNeeded 会抛错）
    fs.mkdirSync(`${logPath}.1`, { recursive: true });

    // 调用 logInterruptEvent（rotateLogIfNeeded 抛错，但应降级为直接 append）
    const event: InterruptEvent = {
      timestamp: "2026-07-25T13:00:00.000Z",
      eventType: "task.failed",
      taskId: "t-rotate-fail",
      taskKind: "chat",
      taskStatus: "failed",
      reason: "测试轮转失败降级",
    };
    logInterruptEvent(event);

    // 验证 logPath 仍存在（轮转失败后原文件保留）
    assert.ok(fs.existsSync(logPath), "轮转失败后 logPath 应仍存在");

    // 验证 logPath 包含新写入的事件（降级为直接 append）
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length >= 1, "应至少有 1 行日志");

    // 解析最后一行，验证为新写入的事件
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    assert.equal(parsed.eventType, "task.failed");
    assert.equal(parsed.taskId, "t-rotate-fail");
    assert.equal(parsed.reason, "测试轮转失败降级");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-014: logInterruptEvent 抛错时不影响主流程（容错-静默）
// ----------------------------------------------------------------------------

test("TC-IL-014: logInterruptEvent 抛错时不影响主流程", async () => {
  await withTempHome(async (home) => {
    // 构造一个让 logInterruptEvent 内部失败的环境：
    // 在 HOME 路径下创建一个文件（而非目录），导致 mkdirSync 失败
    const blockerFile = path.join(home, "blocker-file");
    fs.writeFileSync(blockerFile, "blocker", "utf8");
    // 将 HOME 指向这个文件，使得 getInterruptLogPath() 返回的路径父目录无法创建
    process.env.HOME = blockerFile;

    // 调用 logInterruptEvent（内部 mkdirSync 会失败，但应被 try/catch 吞掉）
    const event: InterruptEvent = {
      timestamp: new Date().toISOString(),
      eventType: "task.started",
      taskId: "t-fail-test",
      taskKind: "chat",
      taskStatus: "running",
    };

    // 验证 logInterruptEvent 不抛错（整体被 try/catch 包裹）
    assert.doesNotThrow(() => logInterruptEvent(event), "logInterruptEvent 应吞掉所有错误，不影响主流程");

    // 验证主流程可以继续执行（模拟主流程后续操作）
    const followUpValue = 42;
    assert.equal(followUpValue, 42, "主流程应继续执行");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-015: bigint 字段正确序列化为字符串（边界-序列化）
// ----------------------------------------------------------------------------

test("TC-IL-015: bigint 字段正确序列化为字符串", async () => {
  await withTempHome(async () => {
    // InterruptEvent 接口本身没有 bigint 字段，但 toSerializable 会递归处理任意层级
    // 通过 cast 传入含 bigint 的扩展对象，验证序列化逻辑
    const event = {
      timestamp: "2026-07-25T14:00:00.000Z",
      eventType: "task.started",
      taskId: "t-bigint-test",
      taskKind: "chat",
      taskStatus: "running",
      // 附加 bigint 字段（不在接口中，但 toSerializable 会处理）
      customBigint: BigInt(123456789),
      nestedBigint: {
        value: BigInt(0),
      },
    } as unknown as InterruptEvent;

    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");
    // 验证 bigint 被序列化为字符串
    assert.equal(entries[0].customBigint, "123456789", "bigint 应被序列化为字符串");
    assert.equal((entries[0].nestedBigint as Record<string, unknown>).value, "0", "嵌套 bigint 应被序列化为字符串");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-016: Error 对象正确序列化为 {name, message, stack}（边界-序列化）
// ----------------------------------------------------------------------------

test("TC-IL-016: Error 对象正确序列化为 {name, message, stack}", async () => {
  await withTempHome(async () => {
    // 构造一个 Error 对象
    const testError = new Error("测试错误消息");
    testError.name = "CustomError";

    // 通过 cast 传入含 Error 的扩展对象，验证序列化逻辑
    const event = {
      timestamp: "2026-07-25T15:00:00.000Z",
      eventType: "task.failed",
      taskId: "t-error-test",
      taskKind: "chat",
      taskStatus: "failed",
      // 附加 Error 字段（不在接口中，但 toSerializable 会处理）
      customError: testError,
    } as unknown as InterruptEvent;

    logInterruptEvent(event);

    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 1, "应有 1 条日志");

    // 验证 Error 被序列化为 {name, message, stack}
    const serializedError = entries[0].customError as Record<string, unknown>;
    assert.equal(serializedError.name, "CustomError", "Error.name 应被正确序列化");
    assert.equal(serializedError.message, "测试错误消息", "Error.message 应被正确序列化");
    assert.ok(
      typeof serializedError.stack === "string" && serializedError.stack.length > 0,
      "Error.stack 应被序列化为非空字符串"
    );
  });
});

// ----------------------------------------------------------------------------
// TC-IL-017: getInterruptLogPath 返回正确路径（辅助函数）
// ----------------------------------------------------------------------------

test("TC-IL-017: getInterruptLogPath 返回正确路径", async () => {
  await withTempHome(async (home) => {
    const logPath = getInterruptLogPath();
    const expectedPath = path.join(home, ".deepcodex", "logs", "interrupts.log");
    assert.equal(logPath, expectedPath, "日志路径应为 $HOME/.deepcodex/logs/interrupts.log");
    // 验证路径是绝对路径
    assert.ok(path.isAbsolute(logPath), "日志路径应为绝对路径");
    // 验证文件名正确
    assert.equal(path.basename(logPath), "interrupts.log", "文件名应为 interrupts.log");
  });
});

// ============================================================================
// 第二部分：集成测试（8 个，验证真实 InterruptQueue/BackgroundTaskRunner 集成）
// ============================================================================

// ----------------------------------------------------------------------------
// TC-IL-018: InterruptQueue.enqueue 触发 interrupt.enqueued 事件（集成-enqueue）
// ----------------------------------------------------------------------------

test("TC-IL-018: InterruptQueue.enqueue 触发 interrupt.enqueued 事件", async () => {
  await withTempHome(async () => {
    // 创建真实 InterruptQueue
    const queue = new InterruptQueue();
    const instruction = createInstruction("集成测试指令-enqueue");
    queue.enqueue(instruction);

    // 读取日志，验证 interrupt.enqueued 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.ok(entries.length >= 1, "应至少有 1 条日志");

    // 查找 interrupt.enqueued 事件
    const enqueuedEvents = entries.filter((e) => e.eventType === "interrupt.enqueued");
    assert.equal(enqueuedEvents.length, 1, "应有 1 条 interrupt.enqueued 事件");

    // 验证事件内容
    const event = enqueuedEvents[0];
    assert.equal(event.instructionText, "集成测试指令-enqueue", "instructionText 应为入队的指令文本");
    assert.equal(event.instructionSource, "user", "instructionSource 应为 user");
    assert.equal(event.queueSize, 1, "queueSize 应为 1（入队后队列长度）");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-019: InterruptQueue.drain 触发 interrupt.drained 事件（集成-drain）
// ----------------------------------------------------------------------------

test("TC-IL-019: InterruptQueue.drain 触发 interrupt.drained 事件", async () => {
  await withTempHome(async () => {
    // 创建真实 InterruptQueue，先入队 2 条指令
    const queue = new InterruptQueue();
    queue.enqueue(createInstruction("指令 A"));
    queue.enqueue(createInstruction("指令 B"));
    assert.equal(queue.size, 2, "入队后队列长度应为 2");

    // drain 取出全部指令
    const drained = queue.drain();
    assert.equal(drained.length, 2, "drain 应返回 2 条指令");
    assert.equal(queue.size, 0, "drain 后队列长度应为 0");

    // 读取日志，验证 interrupt.drained 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);

    // 应有 2 条 interrupt.enqueued + 1 条 interrupt.drained
    const enqueuedEvents = entries.filter((e) => e.eventType === "interrupt.enqueued");
    const drainedEvents = entries.filter((e) => e.eventType === "interrupt.drained");
    assert.equal(enqueuedEvents.length, 2, "应有 2 条 interrupt.enqueued 事件");
    assert.equal(drainedEvents.length, 1, "应有 1 条 interrupt.drained 事件");

    // 验证 drained 事件的 queueSize 为 0（drain 后队列已清空）
    assert.equal(drainedEvents[0].queueSize, 0, "drained 事件的 queueSize 应为 0");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-020: InterruptQueue.drain 空队列时不触发事件（集成-边界）
// ----------------------------------------------------------------------------

test("TC-IL-020: InterruptQueue.drain 空队列时不触发事件", async () => {
  await withTempHome(async () => {
    // 创建真实空 InterruptQueue
    const queue = new InterruptQueue();
    assert.equal(queue.size, 0, "初始队列应为空");

    // drain 空队列
    const drained = queue.drain();
    assert.equal(drained.length, 0, "drain 空队列应返回空数组");

    // 读取日志，验证没有 interrupt.drained 事件（空队列不触发）
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);
    assert.equal(entries.length, 0, "空队列 drain 不应产生任何日志事件");

    // 验证日志文件甚至可能不存在（因为没有写入）
    assert.ok(!fs.existsSync(logPath), "空队列 drain 后日志文件不应被创建");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-021: BackgroundTaskRunner.start 触发 task.started 事件（集成-start）
// ----------------------------------------------------------------------------

test("TC-IL-021: BackgroundTaskRunner.start 触发 task.started 事件", async () => {
  await withTempHome(async () => {
    // 使用 hang 模式，任务不会自动完成，便于隔离测试 task.started 事件
    const { runner } = createRunner("hang");

    const { taskId } = await runner.start("集成测试任务-start", "chat");
    assert.ok(taskId.startsWith("t-"), "taskId 应以 t- 前缀开头");

    // 读取日志，验证 task.started 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);

    const startedEvents = entries.filter((e) => e.eventType === "task.started");
    assert.equal(startedEvents.length, 1, "应有 1 条 task.started 事件");

    // 验证事件内容
    const event = startedEvents[0];
    assert.equal(event.taskId, taskId, "taskId 应与 start 返回的 taskId 一致");
    assert.equal(event.taskKind, "chat", "taskKind 应为 chat");
    assert.equal(event.taskStatus, "running", "taskStatus 应为 running");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-022: BackgroundTaskRunner.inject 触发 task.injected 事件（集成-inject）
// ----------------------------------------------------------------------------

test("TC-IL-022: BackgroundTaskRunner.inject 触发 task.injected 事件", async () => {
  await withTempHome(async () => {
    // 使用 hang 模式，任务保持 running 状态，便于测试 inject
    const { runner, registry } = createRunner("hang");
    const { taskId } = await runner.start("集成测试任务-inject", "chat");

    // 验证任务已注册
    const task = registry.get(taskId);
    assert.ok(task, "任务应已注册");
    assert.equal(task!.state, "running", "任务应为 running 状态");

    // 调用 inject 注入指令
    const instruction = createInstruction("集成测试注入指令");
    runner.inject(taskId, instruction);

    // 读取日志，验证 task.injected 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);

    const injectedEvents = entries.filter((e) => e.eventType === "task.injected");
    assert.equal(injectedEvents.length, 1, "应有 1 条 task.injected 事件");

    // 验证事件内容
    const event = injectedEvents[0];
    assert.equal(event.taskId, taskId, "taskId 应与 inject 的目标任务一致");
    assert.equal(event.taskKind, "chat", "taskKind 应为 chat");
    assert.equal(event.taskStatus, "running", "taskStatus 应为 running");
    assert.equal(event.instructionText, "集成测试注入指令", "instructionText 应为注入的指令文本");
    assert.equal(event.instructionSource, "user", "instructionSource 应为 user");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-023: BackgroundTask markSucceeded 触发 task.succeeded 事件（集成-终态）
// ----------------------------------------------------------------------------

test("TC-IL-023: BackgroundTask markSucceeded 触发 task.succeeded 事件", async () => {
  await withTempHome(async () => {
    // 使用 succeed 模式，handleUserPrompt 立即 resolve，触发 markSucceeded
    const { runner } = createRunner("succeed");
    const { taskId } = await runner.start("集成测试任务-succeed", "chat");

    // 等待异步任务完成：handleUserPrompt.resolve → markSucceeded → onStateChange → 日志写入
    await waitMs(30);

    // 读取日志，验证 task.succeeded 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);

    const succeededEvents = entries.filter((e) => e.eventType === "task.succeeded");
    assert.equal(succeededEvents.length, 1, "应有 1 条 task.succeeded 事件");

    // 验证事件内容
    const event = succeededEvents[0];
    assert.equal(event.taskId, taskId, "taskId 应与 start 返回的 taskId 一致");
    assert.equal(event.taskKind, "chat", "taskKind 应为 chat");
    assert.equal(event.taskStatus, "succeeded", "taskStatus 应为 succeeded");
    assert.equal(event.sessionId, taskId, "sessionId 应等于 taskId");
    assert.ok(typeof event.durationMs === "number" && event.durationMs >= 0, "durationMs 应为非负数");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-024: BackgroundTask markFailed 触发 task.failed 事件（集成-终态）
// ----------------------------------------------------------------------------

test("TC-IL-024: BackgroundTask markFailed 触发 task.failed 事件", async () => {
  await withTempHome(async () => {
    // 使用 fail 模式，handleUserPrompt 立即 reject，触发 markFailed
    const { runner } = createRunner("fail");
    const { taskId } = await runner.start("集成测试任务-fail", "chat");

    // 等待异步任务失败：handleUserPrompt.reject → markFailed → onStateChange → 日志写入
    await waitMs(30);

    // 读取日志，验证 task.failed 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);

    const failedEvents = entries.filter((e) => e.eventType === "task.failed");
    assert.equal(failedEvents.length, 1, "应有 1 条 task.failed 事件");

    // 验证事件内容
    const event = failedEvents[0];
    assert.equal(event.taskId, taskId, "taskId 应与 start 返回的 taskId 一致");
    assert.equal(event.taskKind, "chat", "taskKind 应为 chat");
    assert.equal(event.taskStatus, "failed", "taskStatus 应为 failed");
    assert.equal(event.sessionId, taskId, "sessionId 应等于 taskId");
    assert.equal(event.reason, "stub failure", "reason 应为 stub failure（StubSessionHandle 抛错）");
    assert.ok(typeof event.durationMs === "number" && event.durationMs >= 0, "durationMs 应为非负数");
  });
});

// ----------------------------------------------------------------------------
// TC-IL-025: BackgroundTask cancel 触发 task.cancelled 事件（集成-终态）
// ----------------------------------------------------------------------------

test("TC-IL-025: BackgroundTask cancel 触发 task.cancelled 事件", async () => {
  await withTempHome(async () => {
    // 使用 hang 模式，任务永不自动完成，便于测试手动 cancel
    const { runner } = createRunner("hang");
    const { taskId } = await runner.start("集成测试任务-cancel", "chat");

    // 调用 stop 取消任务（内部调用 task.cancel）
    await runner.stop(taskId, "用户手动取消");

    // 等待异步日志写入完成（onStateChange 同步触发，但保险起见等待）
    await waitMs(10);

    // 读取日志，验证 task.cancelled 事件被触发
    const logPath = getInterruptLogPath();
    const entries = readInterruptLog(logPath);

    const cancelledEvents = entries.filter((e) => e.eventType === "task.cancelled");
    assert.equal(cancelledEvents.length, 1, "应有 1 条 task.cancelled 事件");

    // 验证事件内容
    const event = cancelledEvents[0];
    assert.equal(event.taskId, taskId, "taskId 应与 start 返回的 taskId 一致");
    assert.equal(event.taskKind, "chat", "taskKind 应为 chat");
    assert.equal(event.taskStatus, "cancelled", "taskStatus 应为 cancelled");
    assert.equal(event.sessionId, taskId, "sessionId 应等于 taskId");
    assert.equal(event.reason, "用户手动取消", "reason 应为 stop 传入的取消原因");
    assert.ok(typeof event.durationMs === "number" && event.durationMs >= 0, "durationMs 应为非负数");
  });
});
