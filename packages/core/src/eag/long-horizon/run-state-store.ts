/**
 * RunState 持久化存储（JSONL + SHA256 校验 + 文件锁）—— EAG-P3 批次 10 §4.10
 *
 * 本模块实现 EAG 方案 §5.12.2 + R9 风险缓解所需的 RunState 持久化机制，
 * 是长程自动化"跨 Loop 续跑 + 跨会话续跑"的核心基础设施。
 *
 * 核心职责（对齐设计文档 §4.10.1）：
 * 1. 将 RunState 以 JSONL 格式持久化（每行一个事件，文本可读 + 原子追加）
 * 2. SHA256 累积校验和防腐败（每事件含局部 SHA256 + 全文件累积 SHA256）
 * 3. 文件锁防并发写冲突（自实现 O_EXCL 原子锁，零新增依赖）
 * 4. 加载时校验完整性 + 重放事件重建 RunState 对象
 *
 * 关键技术决策（对齐 §4.10.2）：
 * - 存储格式：JSONL（每行一个事件），与 events.jsonl 一致
 * - 校验和：SHA256 累积校验（局部 + 累积双层）
 * - 文件锁：基于 fs.openSync + O_EXCL 自实现（proper-lockfile 不在依赖中，零新增依赖）
 * - 原子追加：fs.appendFileSync + O_APPEND 标志（操作系统级原子性）
 * - 路径布局：<projectRoot>/.eag/run-state/<run-id>.jsonl
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 并发安全：
 * - 单 run-id 同一时刻只允许一个写入方（文件锁保证）
 * - 多 run-id 之间无锁竞争（不同文件）
 *
 * @module eag/long-horizon/run-state-store
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopType } from "../loop/models";
import type { HumanInterventionRecord, LogCallback, MilestoneRecord, RunState, RunStateStatus } from "./types";
import { DEFAULT_RUN_STATE_DIR } from "./types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 文件锁获取重试间隔（毫秒）
 *
 * 当锁文件已存在时，按此间隔重试，直到达到 LOCK_TIMEOUT_MS 上限。
 */
const LOCK_RETRY_INTERVAL_MS = 50 as const;

/**
 * 文件锁获取总超时（毫秒）
 *
 * 超过此时间仍无法获取锁时抛出 RunStateStoreError。
 * 取值依据：5 秒覆盖正常 git/IO 抖动，避免无限等待。
 */
const LOCK_TIMEOUT_MS = 5000 as const;

/**
 * 文件锁后缀（追加在 .jsonl 文件名后形成 .jsonl.lock）
 */
const LOCK_FILE_SUFFIX = ".lock" as const;

/**
 * JSONL 文件扩展名
 */
const JSONL_EXTENSION = ".jsonl" as const;

/**
 * 默认日志空函数（避免 undefined 判空）
 *
 * 对齐 testing/testing-orchestrator.ts 中的 noopLog 模式。
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 2. 自定义错误类
// ============================================================================

/**
 * RunState 持久化错误类型（字面量联合类型）
 *
 * - corrupted：SHA256 校验失败或文件格式损坏
 * - not-found：run-id 对应的 JSONL 文件不存在
 * - already-exists：初始化时 run-id 已存在
 * - diverged：git HEAD 与 RunState 最后一个 milestone 不一致（/eag-resume 校验）
 * - lock-timeout：文件锁获取超时
 * - io-failed：底层文件系统 I/O 失败
 * - invalid-request：请求字段非法
 */
export type RunStateStoreErrorKind =
  | "corrupted"
  | "not-found"
  | "already-exists"
  | "diverged"
  | "lock-timeout"
  | "io-failed"
  | "invalid-request";

/**
 * RunState 持久化错误基类
 *
 * 所有 RunState 持久化相关错误均继承自此基类，
 * 调用方可以通过 instanceof RunStateStoreError 统一捕获，
 * 也可通过 err.kind 区分具体错误类型分别处理。
 */
export class RunStateStoreError extends Error {
  /**
   * @param kind 错误类型（RunStateStoreErrorKind 之一）
   * @param detail 错误详情（人类可读）
   * @param runId 关联的 run-id（便于日志溯源）
   */
  constructor(
    public readonly kind: RunStateStoreErrorKind,
    public readonly detail: string,
    public readonly runId?: string
  ) {
    super(`RunState 持久化错误 [${kind}]${runId ? ` runId=${runId}` : ""}：${detail}`);
    this.name = "RunStateStoreError";
  }
}

/**
 * RunState 校验失败错误（SHA256 不匹配 / JSON 解析失败 / 文件格式损坏）
 *
 * 调用方应拒绝恢复，引导用户从最近 milestone tag 手动恢复。
 */
export class RunStateCorruptedError extends RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param detail 错误详情（含具体行号与不匹配字段）
   */
  constructor(runId: string, detail: string) {
    super("corrupted", detail, runId);
    this.name = "RunStateCorruptedError";
  }
}

/**
 * RunState 不存在错误（run-id 对应的 JSONL 文件不存在）
 */
export class RunStateNotFoundError extends RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param projectRoot 项目根目录
   */
  constructor(runId: string, projectRoot: string) {
    super(
      "not-found",
      `RunState 文件不存在：${path.join(projectRoot, DEFAULT_RUN_STATE_DIR, runId + JSONL_EXTENSION)}`,
      runId
    );
    this.name = "RunStateNotFoundError";
  }
}

/**
 * RunState 已存在错误（initialize 时 run-id 已存在，避免覆盖既有状态）
 */
export class RunStateAlreadyExistsError extends RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param projectRoot 项目根目录
   */
  constructor(runId: string, projectRoot: string) {
    super(
      "already-exists",
      `RunState 文件已存在：${path.join(projectRoot, DEFAULT_RUN_STATE_DIR, runId + JSONL_EXTENSION)}`,
      runId
    );
    this.name = "RunStateAlreadyExistsError";
  }
}

/**
 * RunState 分歧错误（git HEAD 与 RunState 最后一个 milestone 的 commitSha 不一致）
 *
 * 触发场景：/eag-resume 时检测到用户手动改了代码，拒绝自动恢复。
 */
export class RunStateDivergedError extends RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param expectedCommitSha RunState 记录的 commitSha
   * @param actualCommitSha git HEAD 实际 commitSha
   */
  constructor(
    runId: string,
    public readonly expectedCommitSha: string,
    public readonly actualCommitSha: string
  ) {
    super("diverged", `git HEAD 与 RunState 分歧：expected=${expectedCommitSha} actual=${actualCommitSha}`, runId);
    this.name = "RunStateDivergedError";
  }
}

// ============================================================================
// 3. 类型定义
// ============================================================================

/**
 * RunState 事件类型（字面量联合类型，11 种）
 *
 * 对应 §4.10 RunStateEvent.type：
 * - run-started：Run 启动（initialize 时写入首行）
 * - loop-started：Loop 启动（currentLoop/currentIteration 更新）
 * - loop-completed：Loop 完成（completedLoops 追加 + milestone 添加）
 * - iteration-completed：迭代完成（currentIteration 递增 + token/llm 累计）
 * - milestone-tagged：里程碑 tag 创建（milestones 追加）
 * - human-intervention：人工介入（humanInterventions 追加 + count 递增）
 * - human-intervention-resolved：人工介入已解决（标记 resolved=true）
 * - run-paused：Run 暂停（status=paused）
 * - run-resumed：Run 恢复（status=running）
 * - run-completed：Run 完成（status=completed）
 * - run-failed：Run 失败（status=failed）
 */
export type RunStateEventType =
  | "run-started"
  | "loop-started"
  | "loop-completed"
  | "iteration-completed"
  | "milestone-tagged"
  | "human-intervention"
  | "human-intervention-resolved"
  | "run-paused"
  | "run-resumed"
  | "run-completed"
  | "run-failed";

/**
 * RUN_STATE_EVENT_TYPES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const RUN_STATE_EVENT_TYPES: ReadonlyArray<RunStateEventType> = Object.freeze([
  "run-started",
  "loop-started",
  "loop-completed",
  "iteration-completed",
  "milestone-tagged",
  "human-intervention",
  "human-intervention-resolved",
  "run-paused",
  "run-resumed",
  "run-completed",
  "run-failed",
]);

/**
 * RunState 事件（JSONL 单行，含 SHA256 校验和）
 *
 * 对应 §4.10 RunStateEvent：
 * 每个 RunState 状态变更都表达为一个事件，持久化为 JSONL 文件的一行。
 *
 * 字段全部 readonly——事件一经写入即不可变，状态变更通过追加新事件表达。
 *
 * 范例：
 *   {
 *     type: "loop-completed",
 *     timestamp: "2026-07-19T11:00:00.000Z",
 *     payload: { loopType: "design", milestone: { index: 1, ... } },
 *     localChecksum: "sha256:abc...",
 *     cumulativeChecksum: "sha256:abcdef..."
 *   }
 */
export interface RunStateEvent {
  /** 事件类型（11 种之一） */
  readonly type: RunStateEventType;
  /** 事件时间戳（ISO 8601 字符串） */
  readonly timestamp: string;
  /**
   * 事件负载（类型相关字段）
   *
   * 不同 type 的 payload 约定：
   * - run-started: { runId, projectRoot, initialLoop }
   * - loop-started: { loopType, iteration }
   * - loop-completed: { loopType, milestone }
   * - iteration-completed: { loopType, iteration, llmCallCount, tokensUsed }
   * - milestone-tagged: { milestone }
   * - human-intervention: { loopType, reason, decision }
   * - human-intervention-resolved: { index }
   * - run-paused: { reason }
   * - run-resumed: {}
   * - run-completed: { finalReport? }
   * - run-failed: { reason }
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** 局部 SHA256（本行 {type, timestamp, payload} 内容的 SHA256，前缀 "sha256:"） */
  readonly localChecksum: string;
  /** 累积 SHA256（前一事件 cumulativeChecksum + 本事件 localChecksum 的 SHA256，前缀 "sha256:"） */
  readonly cumulativeChecksum: string;
}

/**
 * RunState 事件输入（不含校验和，调用方传入）
 *
 * appendEvent 接受此类型作为输入，由 store 内部计算 localChecksum 与 cumulativeChecksum。
 * 设计理由：调用方无法预知前一事件的 cumulativeChecksum，故校验和必须由 store 统一计算。
 *
 * timestamp 可选，未提供时由 store 自动填充当前 ISO 时间。
 */
export interface RunStateEventInput {
  /** 事件类型 */
  readonly type: RunStateEventType;
  /** 事件时间戳（可选，默认 new Date().toISOString()） */
  readonly timestamp?: string;
  /** 事件负载 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * RunState 初始化请求（initialize 方法入参）
 *
 * 对应 §4.10 RunStateInitRequest。
 */
export interface RunStateInitRequest {
  /** run-id（可选，未提供时自动生成 12 位 UUID 前缀） */
  readonly runId?: string;
  /** 项目根目录（绝对路径或相对路径，内部会 path.resolve 处理） */
  readonly projectRoot: string;
  /** 初始 Loop 类型（默认 "design"） */
  readonly initialLoop?: LoopType;
}

/**
 * RunState 摘要（listRuns 返回）
 *
 * 对应 §4.10 RunStateSummary：
 * 用于 /eag-status 无参数时显示最近 run 列表，仅含必要字段。
 */
export interface RunStateSummary {
  /** run-id */
  readonly runId: string;
  /** 启动时间（ISO 8601 字符串） */
  readonly startedAt: string;
  /** 最近更新时间（ISO 8601 字符串） */
  readonly updatedAt: string;
  /** 当前状态 */
  readonly status: RunStateStatus;
  /** 当前 Loop 类型 */
  readonly currentLoop: LoopType;
  /** 完成度（completedLoops.length / 3，0~1） */
  readonly completionRate: number;
}

/**
 * 锁句柄（acquire 成功后返回，release 时传入）
 *
 * 含锁文件路径与获取时间，便于调试与超时检测。
 */
export interface LockHandle {
  /** 锁文件绝对路径 */
  readonly lockPath: string;
  /** 获取时间（Date.now() 毫秒数） */
  readonly acquiredAt: number;
}

/**
 * 锁提供者协议
 *
 * 抽象文件锁实现，便于测试注入内存锁（仍遵循"禁止 mock"规则——内存锁是真实实现）。
 * 生产实现为 FileLockProvider，基于 fs.openSync + O_EXCL 自实现。
 */
export interface LockProvider {
  /**
   * 获取锁（阻塞直到获取成功或超时）
   *
   * @param lockPath 锁文件绝对路径
   * @returns 锁句柄
   * @throws RunStateStoreError 锁获取超时（kind=lock-timeout）
   */
  acquire(lockPath: string): Promise<LockHandle>;

  /**
   * 释放锁
   *
   * @param handle 锁句柄
   */
  release(handle: LockHandle): Promise<void>;
}

// ============================================================================
// 4. FileLockProvider 文件锁实现（基于 O_EXCL 原子创建）
// ============================================================================

/**
 * 文件锁提供者（生产实现，基于 fs.openSync + O_EXCL 原子创建）
 *
 * 算法：
 * 1. acquire：循环尝试 fs.openSync(lockPath, 'wx')（O_EXCL 标志保证原子性）
 *    - 成功：立即关闭 fd，返回 LockHandle
 *    - 失败（EEXIST）：休眠 LOCK_RETRY_INTERVAL_MS 后重试
 *    - 超时（LOCK_TIMEOUT_MS）：抛 RunStateStoreError(lock-timeout)
 * 2. release：fs.unlinkSync(lockPath) 删除锁文件
 *
 * 设计理由（零新增依赖）：
 * - 设计文档 §4.10.2 提到使用 proper-lockfile 库，但 packages/core/package.json
 *   实际依赖中不包含 proper-lockfile（仅有 @anthropic-ai/sdk / chalk / ejs /
 *   gray-matter / ignore / openai / undici / zod）
 * - 为遵循"零新增依赖"硬约束，使用 fs.openSync + O_EXCL 自实现文件锁
 * - O_EXCL 是 POSIX 标志，保证跨进程原子性（与 proper-lockfile 行为等价）
 *
 * 注意：本实现不支持跨机器锁（NFS 等共享文件系统下 O_EXCL 不可靠），
 * 适用场景为单机多进程（CLI 工具的典型场景）。
 */
export class FileLockProvider implements LockProvider {
  /**
   * 获取文件锁（阻塞直到获取成功或超时）
   *
   * @param lockPath 锁文件绝对路径
   * @returns 锁句柄
   * @throws RunStateStoreError 锁获取超时或 I/O 失败
   */
  async acquire(lockPath: string): Promise<LockHandle> {
    const startTime = Date.now();

    // 循环尝试获取锁，直到成功或超时

    while (true) {
      try {
        // 'wx' 标志 = O_WRONLY | O_CREAT | O_EXCL，原子创建文件
        // 若文件已存在则抛 EEXIST 错误（这是预期行为，表示锁被占用）
        const fd = fs.openSync(lockPath, "wx");
        // 立即关闭 fd（我们只需要文件存在作为锁标志，不需要写入内容）
        fs.closeSync(fd);
        return Object.freeze({
          lockPath,
          acquiredAt: Date.now(),
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          // 锁被占用，检查是否超时
          const elapsed = Date.now() - startTime;
          if (elapsed >= LOCK_TIMEOUT_MS) {
            throw new RunStateStoreError("lock-timeout", `文件锁获取超时（${LOCK_TIMEOUT_MS}ms）：${lockPath}`);
          }
          // 短暂休眠后重试
          await sleep(LOCK_RETRY_INTERVAL_MS);
          continue;
        }
        // 其他 I/O 错误（如目录不存在）直接抛出
        throw new RunStateStoreError("io-failed", `文件锁获取失败：${lockPath} 错误：${e.message}`);
      }
    }
  }

  /**
   * 释放文件锁（删除锁文件）
   *
   * @param handle 锁句柄
   */
  async release(handle: LockHandle): Promise<void> {
    try {
      // 使用 unlinkSync 删除锁文件
      // 若文件不存在（已被其他进程清理）则忽略 ENOENT 错误
      fs.unlinkSync(handle.lockPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // 锁文件已不存在，视为已释放（幂等）
        return;
      }
      // 其他错误抛出
      throw new RunStateStoreError("io-failed", `文件锁释放失败：${handle.lockPath} 错误：${e.message}`);
    }
  }
}

// ============================================================================
// 5. RunStateStore 主类
// ============================================================================

/**
 * RunState 持久化存储（对齐 §4.10 RunStateStore）
 *
 * 算法：
 * 1. initialize：创建 .eag/run-state/ 目录 + 初始化 JSONL 文件（首行写入 run-started 事件）
 * 2. appendEvent：追加事件行（含累积 SHA256），重放事件重建 RunState 返回
 * 3. load：读取全部行 → 校验 SHA256 → 重放事件重建 RunState
 * 4. listRuns：列出 .eag/run-state/ 下所有 .jsonl 文件，提取摘要
 *
 * 并发安全：
 * - 单 run-id 同一时刻只允许一个写入方（文件锁保证）
 * - 多 run-id 之间无锁竞争（不同文件，独立锁）
 *
 * 使用方式：
 * ```typescript
 * const store = new RunStateStore();
 * const state1 = await store.initialize({ projectRoot: "/path/to/project" });
 * const state2 = await store.appendEvent(state1.runId, {
 *   type: "loop-started",
 *   payload: { loopType: "design", iteration: 1 }
 * });
 * const state3 = await store.load(state1.runId, "/path/to/project");
 * const runs = await store.listRuns("/path/to/project");
 * ```
 */
export class RunStateStore {
  /** 锁提供者（默认 FileLockProvider，可注入测试实现） */
  private readonly lockProvider: LockProvider;
  /** 日志回调（默认 noopLog） */
  private readonly log: LogCallback;
  /**
   * runId → projectRoot 内存缓存
   *
   * appendEvent 入参不含 projectRoot，需通过此缓存查找 initialize 时记录的项目根目录。
   * 设计理由：appendEvent 在 initialize 之后频繁调用（每事件一次），
   * 每次扫描文件系统开销大；内存缓存提供 O(1) 查找。
   *
   * 缓存生命周期：initialize / load 成功后写入，进程结束时丢弃（无需持久化）。
   */
  private readonly runIdToProjectRoot: Map<string, string> = new Map();

  /**
   * @param lockProvider 锁提供者（默认 FileLockProvider）
   * @param logger 日志回调（可选）
   */
  constructor(lockProvider: LockProvider = new FileLockProvider(), logger: LogCallback = noopLog) {
    this.lockProvider = lockProvider;
    this.log = logger;
  }

  /**
   * 初始化 RunState（创建新 run）
   *
   * 算法：
   * 1. 生成 runId（如未提供，自动生成 12 位 UUID 前缀）
   * 2. 解析项目根目录（path.resolve 处理相对路径）
   * 3. 计算 JSONL 文件路径：<projectRoot>/.eag/run-state/<runId>.jsonl
   * 4. 计算锁文件路径：<runId>.jsonl.lock
   * 5. 获取文件锁
   * 6. 检查 JSONL 文件是否已存在 → 抛 RunStateAlreadyExistsError
   * 7. 确保 .eag/run-state/ 目录存在（mkdir -p）
   * 8. 构造 run-started 事件（payload 含 runId/projectRoot/initialLoop）
   * 9. 计算 localChecksum + cumulativeChecksum（首事件累积 = 局部）
   * 10. 写入首行到 JSONL 文件（O_APPEND 原子追加）
   * 11. 释放锁
   * 12. 重放首事件构造初始 RunState（status="running"）返回
   *
   * @param request 初始化请求
   * @returns 初始 RunState（status="running"）
   * @throws RunStateAlreadyExistsError 同 run-id 已存在
   * @throws RunStateStoreError 锁超时 / I/O 失败 / 请求非法
   */
  async initialize(request: Readonly<RunStateInitRequest>): Promise<Readonly<RunState>> {
    // 1. 校验请求
    if (!request || typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new RunStateStoreError("invalid-request", "projectRoot 必须为非空字符串");
    }
    // 2. 生成或校验 runId
    const runId = request.runId ?? this.generateRunId();
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new RunStateStoreError("invalid-request", "runId 必须为非空字符串");
    }
    // runId 仅允许字母/数字/连字符（防止路径穿越攻击）
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
      throw new RunStateStoreError("invalid-request", `runId 仅允许字母/数字/连字符，实际值：${runId}`);
    }
    const initialLoop: LoopType = request.initialLoop ?? "design";
    // 3. 解析路径
    const projectRootAbs = path.resolve(request.projectRoot);
    const runStateDir = path.join(projectRootAbs, DEFAULT_RUN_STATE_DIR);
    const jsonlPath = path.join(runStateDir, runId + JSONL_EXTENSION);
    const lockPath = jsonlPath + LOCK_FILE_SUFFIX;

    this.log(`初始化 RunState：runId=${runId} path=${jsonlPath}`, "info");

    // 4. 确保目录存在（mkdir -p）—— 必须在获取文件锁之前完成
    //    原因：FileLockProvider 使用 fs.openSync(lockPath, "wx") 创建锁文件，
    //    若父目录不存在则抛 ENOENT 错误。因此需要先创建目录，再获取锁。
    fs.mkdirSync(runStateDir, { recursive: true });

    // 5. 获取文件锁
    const lockHandle = await this.lockProvider.acquire(lockPath);
    try {
      // 6. 检查文件是否已存在
      if (fs.existsSync(jsonlPath)) {
        throw new RunStateAlreadyExistsError(runId, projectRootAbs);
      }

      // 7. 构造 run-started 事件
      const timestamp = new Date().toISOString();
      const payload: Readonly<Record<string, unknown>> = Object.freeze({
        runId,
        projectRoot: projectRootAbs,
        initialLoop,
      });
      const event = this.buildEventWithChecksum("run-started", timestamp, payload, "");

      // 8. 原子追加写入首行（O_APPEND 保证操作系统级原子性）
      this.appendEventLine(jsonlPath, event);

      // 9. 写入内存缓存（appendEvent 时通过 runId 查找 projectRoot）
      this.runIdToProjectRoot.set(runId, projectRootAbs);

      this.log(`RunState 初始化完成：runId=${runId}`, "info");

      // 10. 重放首事件构造初始 RunState 返回
      return this.rebuildRunStateFromEvents(runId, projectRootAbs, [event]);
    } finally {
      // 释放锁（无论成功或失败）
      await this.lockProvider.release(lockHandle);
    }
  }

  /**
   * 追加事件（状态变更）
   *
   * 算法：
   * 1. 解析路径 + 获取锁
   * 2. 读取现有全部事件（用于计算累积 SHA256 + 后续重放）
   * 3. 取最后一行的 cumulativeChecksum 作为前置累积值
   * 4. 构造新事件（计算 localChecksum + cumulativeChecksum）
   * 5. 原子追加写入新行
   * 6. 释放锁
   * 7. 重放全部事件重建 RunState 返回
   *
   * @param runId run-id
   * @param input 事件输入（type + payload，timestamp 可选）
   * @returns 更新后的 RunState
   * @throws RunStateNotFoundError run-id 不存在
   * @throws RunStateCorruptedError 现有文件 SHA256 校验失败
   * @throws RunStateStoreError 锁超时 / I/O 失败
   */
  async appendEvent(runId: string, input: Readonly<RunStateEventInput>): Promise<Readonly<RunState>> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new RunStateStoreError("invalid-request", "runId 必须为非空字符串");
    }
    if (!input || typeof input.type !== "string") {
      throw new RunStateStoreError("invalid-request", "input.type 必须为字符串");
    }
    if (!RUN_STATE_EVENT_TYPES.includes(input.type)) {
      throw new RunStateStoreError(
        "invalid-request",
        `input.type 非法：${input.type}（合法值：${RUN_STATE_EVENT_TYPES.join(", ")}）`
      );
    }
    if (input.payload === null || typeof input.payload !== "object") {
      throw new RunStateStoreError("invalid-request", "input.payload 必须为对象");
    }

    // 2. 解析路径（需要 projectRoot，从已存在的文件首行读取）
    //    此处先扫描 .eag/run-state/ 目录找到 runId.jsonl 文件
    const projectRootFromFirstLine = await this.findProjectRootForRun(runId);
    const projectRootAbs = projectRootFromFirstLine;
    const runStateDir = path.join(projectRootAbs, DEFAULT_RUN_STATE_DIR);
    const jsonlPath = path.join(runStateDir, runId + JSONL_EXTENSION);
    const lockPath = jsonlPath + LOCK_FILE_SUFFIX;

    this.log(`追加事件：runId=${runId} type=${input.type}`, "info");

    // 3. 获取锁
    const lockHandle = await this.lockProvider.acquire(lockPath);
    try {
      // 4. 检查文件存在
      if (!fs.existsSync(jsonlPath)) {
        throw new RunStateNotFoundError(runId, projectRootAbs);
      }
      // 5. 读取全部现有事件（含 SHA256 校验）
      const existingEvents = this.readAndVerifyEvents(runId, jsonlPath);
      // 6. 取前置累积 SHA256（首事件的前置为空字符串）
      const prevCumulative =
        existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].cumulativeChecksum : "";

      // 7. 构造新事件
      const timestamp = input.timestamp ?? new Date().toISOString();
      const event = this.buildEventWithChecksum(input.type, timestamp, input.payload, prevCumulative);

      // 8. 原子追加
      this.appendEventLine(jsonlPath, event);

      this.log(`事件追加成功：runId=${runId} type=${input.type}`, "info");

      // 9. 重放全部事件（含新事件）重建 RunState
      const allEvents = [...existingEvents, event];
      return this.rebuildRunStateFromEvents(runId, projectRootAbs, allEvents);
    } finally {
      await this.lockProvider.release(lockHandle);
    }
  }

  /**
   * 加载 RunState（断点续跑入口）
   *
   * 算法：
   * 1. 解析路径 + 检查文件存在
   * 2. 读取全部事件 + SHA256 校验
   * 3. 重放事件重建 RunState
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns RunState
   * @throws RunStateNotFoundError 文件不存在
   * @throws RunStateCorruptedError SHA256 校验失败
   */
  async load(runId: string, projectRoot: string): Promise<Readonly<RunState>> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new RunStateStoreError("invalid-request", "runId 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new RunStateStoreError("invalid-request", "projectRoot 必须为非空字符串");
    }

    const projectRootAbs = path.resolve(projectRoot);
    const runStateDir = path.join(projectRootAbs, DEFAULT_RUN_STATE_DIR);
    const jsonlPath = path.join(runStateDir, runId + JSONL_EXTENSION);

    this.log(`加载 RunState：runId=${runId} path=${jsonlPath}`, "info");

    // 2. 检查文件存在
    if (!fs.existsSync(jsonlPath)) {
      throw new RunStateNotFoundError(runId, projectRootAbs);
    }

    // 3. 读取 + 校验 + 重放（无需获取锁，读操作并发安全）
    const events = this.readAndVerifyEvents(runId, jsonlPath);

    // 4. 写入内存缓存（后续 appendEvent 可通过 runId 查找 projectRoot）
    this.runIdToProjectRoot.set(runId, projectRootAbs);

    return this.rebuildRunStateFromEvents(runId, projectRootAbs, events);
  }

  /**
   * 列出所有 run-id（用于 /eag-status 无参数时显示最近 run）
   *
   * 算法：
   * 1. 列出 .eag/run-state/ 目录下所有 *.jsonl 文件
   * 2. 对每个文件：读取首行（run-started）+ 末行（最新状态）
   * 3. 构造 RunStateSummary（含 runId/startedAt/updatedAt/status/currentLoop/completionRate）
   * 4. 按 updatedAt 降序排序（最近在前）
   *
   * @param projectRoot 项目根目录
   * @returns run-id 列表（按 updatedAt 降序）
   */
  async listRuns(projectRoot: string): Promise<ReadonlyArray<RunStateSummary>> {
    // 1. 校验入参
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new RunStateStoreError("invalid-request", "projectRoot 必须为非空字符串");
    }
    const projectRootAbs = path.resolve(projectRoot);
    const runStateDir = path.join(projectRootAbs, DEFAULT_RUN_STATE_DIR);

    // 2. 目录不存在时返回空数组（首次运行场景）
    if (!fs.existsSync(runStateDir)) {
      return Object.freeze([]);
    }

    // 3. 列出所有 .jsonl 文件
    const files = fs.readdirSync(runStateDir).filter((f) => f.endsWith(JSONL_EXTENSION));

    const summaries: RunStateSummary[] = [];
    for (const file of files) {
      const jsonlPath = path.join(runStateDir, file);
      try {
        const summary = this.buildSummaryFromFile(file, jsonlPath);
        summaries.push(summary);
      } catch (err) {
        // 单个文件损坏不影响整体列表，仅记录日志
        this.log(`跳过损坏的 RunState 文件：${file} 错误：${(err as Error).message}`, "warn");
      }
    }

    // 4. 按 updatedAt 降序排序
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Object.freeze(summaries);
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 生成 12 位 UUID 前缀作为 runId
   *
   * 对齐 LoopKernel.generateRunId 实现，保持 runId 格式一致性。
   *
   * @returns 12 位十六进制字符串
   */
  private generateRunId(): string {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return uuid.substring(0, 12);
  }

  /**
   * 构造带 SHA256 校验和的事件
   *
   * 算法：
   * 1. 序列化事件核心内容（{type, timestamp, payload}）为规范 JSON
   * 2. 计算 localChecksum = "sha256:" + sha256(canonicalJson)
   * 3. 计算 cumulativeChecksum = "sha256:" + sha256(prevCumulative + localChecksum)
   *    - 首事件（prevCumulative=""）的 cumulativeChecksum = sha256("" + localChecksum)
   *
   * @param type 事件类型
   * @param timestamp 时间戳
   * @param payload 事件负载
   * @param prevCumulative 前一事件的 cumulativeChecksum（首事件传空字符串）
   * @returns 完整的 RunStateEvent（含校验和）
   */
  private buildEventWithChecksum(
    type: RunStateEventType,
    timestamp: string,
    payload: Readonly<Record<string, unknown>>,
    prevCumulative: string
  ): Readonly<RunStateEvent> {
    // 序列化核心内容（确保字段顺序：type → timestamp → payload）
    // 使用 JSON.stringify 默认顺序（对象键插入顺序），由于本方法构造时按固定顺序写入，保证确定性
    const coreContent = JSON.stringify({ type, timestamp, payload });
    const localHash = crypto.createHash("sha256").update(coreContent, "utf8").digest("hex");
    const localChecksum = `sha256:${localHash}`;

    // 累积 SHA256 = sha256(prevCumulative + localChecksum)
    const cumulativeInput = prevCumulative + localChecksum;
    const cumulativeHash = crypto.createHash("sha256").update(cumulativeInput, "utf8").digest("hex");
    const cumulativeChecksum = `sha256:${cumulativeHash}`;

    return Object.freeze({
      type,
      timestamp,
      payload,
      localChecksum,
      cumulativeChecksum,
    });
  }

  /**
   * 原子追加事件行到 JSONL 文件
   *
   * 使用 fs.appendFileSync + O_APPEND 标志，操作系统保证追加操作的原子性。
   *
   * @param jsonlPath JSONL 文件绝对路径
   * @param event 待写入的事件
   */
  private appendEventLine(jsonlPath: string, event: Readonly<RunStateEvent>): void {
    const line = JSON.stringify(event) + "\n";
    try {
      fs.appendFileSync(jsonlPath, line, { encoding: "utf8", flag: "a" });
    } catch (err) {
      throw new RunStateStoreError("io-failed", `写入 JSONL 文件失败：${jsonlPath} 错误：${(err as Error).message}`);
    }
  }

  /**
   * 读取并校验 JSONL 文件全部事件
   *
   * 算法：
   * 1. 读取文件全部内容
   * 2. 按行拆分（过滤空行）
   * 3. 逐行 JSON.parse + 校验 localChecksum + 校验 cumulativeChecksum
   * 4. 任一行校验失败 → 抛 RunStateCorruptedError
   *
   * @param runId run-id（用于错误信息）
   * @param jsonlPath JSONL 文件路径
   * @returns 校验通过的事件列表
   * @throws RunStateCorruptedError 任一行校验失败
   */
  private readAndVerifyEvents(runId: string, jsonlPath: string): ReadonlyArray<Readonly<RunStateEvent>> {
    let content: string;
    try {
      content = fs.readFileSync(jsonlPath, "utf8");
    } catch (err) {
      throw new RunStateStoreError(
        "io-failed",
        `读取 JSONL 文件失败：${jsonlPath} 错误：${(err as Error).message}`,
        runId
      );
    }

    // 按行拆分（过滤尾部空行）
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new RunStateCorruptedError(runId, "JSONL 文件为空（无事件）");
    }

    const events: RunStateEvent[] = [];
    let prevCumulative = "";

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // 解析 JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new RunStateCorruptedError(runId, `第 ${lineNum} 行 JSON 解析失败：${(err as Error).message}`);
      }

      // 校验字段完整性
      if (typeof parsed !== "object" || parsed === null) {
        throw new RunStateCorruptedError(runId, `第 ${lineNum} 行非对象`);
      }
      const event = parsed as Record<string, unknown>;
      if (
        typeof event.type !== "string" ||
        typeof event.timestamp !== "string" ||
        typeof event.payload !== "object" ||
        typeof event.localChecksum !== "string" ||
        typeof event.cumulativeChecksum !== "string"
      ) {
        throw new RunStateCorruptedError(runId, `第 ${lineNum} 行字段缺失或类型错误`);
      }

      // 重新计算 localChecksum 并校验
      const coreContent = JSON.stringify({
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
      });
      const expectedLocalHash = crypto.createHash("sha256").update(coreContent, "utf8").digest("hex");
      const expectedLocalChecksum = `sha256:${expectedLocalHash}`;
      if (event.localChecksum !== expectedLocalChecksum) {
        throw new RunStateCorruptedError(
          runId,
          `第 ${lineNum} 行 localChecksum 不匹配：expected=${expectedLocalChecksum} actual=${event.localChecksum}`
        );
      }

      // 重新计算 cumulativeChecksum 并校验
      const cumulativeInput = prevCumulative + event.localChecksum;
      const expectedCumulativeHash = crypto.createHash("sha256").update(cumulativeInput, "utf8").digest("hex");
      const expectedCumulativeChecksum = `sha256:${expectedCumulativeHash}`;
      if (event.cumulativeChecksum !== expectedCumulativeChecksum) {
        throw new RunStateCorruptedError(
          runId,
          `第 ${lineNum} 行 cumulativeChecksum 不匹配：expected=${expectedCumulativeChecksum} actual=${event.cumulativeChecksum}`
        );
      }

      // 校验通过，加入事件列表
      events.push({
        type: event.type as RunStateEventType,
        timestamp: event.timestamp,
        payload: event.payload as Readonly<Record<string, unknown>>,
        localChecksum: event.localChecksum,
        cumulativeChecksum: event.cumulativeChecksum,
      });

      // 更新前置累积值
      prevCumulative = event.cumulativeChecksum;
    }

    return Object.freeze(events);
  }

  /**
   * 重放事件重建 RunState
   *
   * 算法：按事件顺序应用状态变更：
   * 1. run-started：初始化基础字段（runId/projectRoot/startedAt/currentLoop/startedAt）
   * 2. loop-started：更新 currentLoop + currentIteration
   * 3. iteration-completed：累加 llmCallCount/tokensUsed + 更新 currentIteration
   * 4. loop-completed：completedLoops 追加 + currentIteration 重置为 0
   * 5. milestone-tagged：milestones 追加
   * 6. human-intervention：humanInterventions 追加 + count 递增
   * 7. human-intervention-resolved：标记指定索引的 intervention 为 resolved
   * 8. run-paused：status=paused + blockedReason
   * 9. run-resumed：status=running + 清除 blockedReason
   * 10. run-completed：status=completed
   * 11. run-failed：status=failed + blockedReason
   *
   * @param runId run-id（与事件 payload.runId 应一致）
   * @param projectRoot 项目根目录
   * @param events 全部事件列表（已通过 SHA256 校验）
   * @returns 重建后的 RunState
   */
  private rebuildRunStateFromEvents(
    runId: string,
    projectRoot: string,
    events: ReadonlyArray<Readonly<RunStateEvent>>
  ): Readonly<RunState> {
    // 初始状态（首事件必须是 run-started）
    if (events.length === 0 || events[0].type !== "run-started") {
      throw new RunStateCorruptedError(runId, "首事件必须是 run-started");
    }

    const startedEvent = events[0];
    const startedPayload = startedEvent.payload;
    const initialLoop = (startedPayload.initialLoop as LoopType) ?? "design";

    // 初始化可变状态（重放过程中累加）
    let status: RunStateStatus = "running";
    let currentLoop: LoopType = initialLoop;
    let currentIteration = 0;
    const startedAt = startedEvent.timestamp;
    let updatedAt = startedEvent.timestamp;
    let blockedReason: string | undefined = undefined;
    let totalLlmCallCount = 0;
    let totalTokensUsed = 0;
    const completedLoops: LoopType[] = [];
    const completedTaskIds: string[] = [];
    const pendingDeleteFiles: string[] = [];
    const milestones: MilestoneRecord[] = [];
    const humanInterventions: HumanInterventionRecord[] = [];

    // 重放每个事件
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      updatedAt = event.timestamp;

      switch (event.type) {
        case "run-started":
          // 初始化已在上方完成
          break;
        case "loop-started": {
          const p = event.payload;
          currentLoop = (p.loopType as LoopType) ?? currentLoop;
          currentIteration = typeof p.iteration === "number" ? p.iteration : currentIteration;
          break;
        }
        case "iteration-completed": {
          const p = event.payload;
          if (typeof p.iteration === "number") currentIteration = p.iteration;
          if (typeof p.llmCallCount === "number") totalLlmCallCount += p.llmCallCount;
          if (typeof p.tokensUsed === "number") totalTokensUsed += p.tokensUsed;
          if (Array.isArray(p.completedTaskIds)) {
            for (const tid of p.completedTaskIds) {
              if (typeof tid === "string" && !completedTaskIds.includes(tid)) {
                completedTaskIds.push(tid);
              }
            }
          }
          if (Array.isArray(p.pendingDeleteFiles)) {
            for (const f of p.pendingDeleteFiles) {
              if (typeof f === "string" && !pendingDeleteFiles.includes(f)) {
                pendingDeleteFiles.push(f);
              }
            }
          }
          break;
        }
        case "loop-completed": {
          const p = event.payload;
          const loopType = p.loopType as LoopType | undefined;
          if (loopType && !completedLoops.includes(loopType)) {
            completedLoops.push(loopType);
          }
          // 若 payload 含 milestone，也加入 milestones 列表
          if (p.milestone && typeof p.milestone === "object") {
            const milestone = p.milestone as MilestoneRecord;
            if (!milestones.find((m) => m.tagName === milestone.tagName)) {
              milestones.push(milestone);
            }
          }
          currentIteration = 0;
          break;
        }
        case "milestone-tagged": {
          const p = event.payload;
          if (p.milestone && typeof p.milestone === "object") {
            const milestone = p.milestone as MilestoneRecord;
            if (!milestones.find((m) => m.tagName === milestone.tagName)) {
              milestones.push(milestone);
            }
          }
          break;
        }
        case "human-intervention": {
          const p = event.payload;
          const record: HumanInterventionRecord = {
            intervenedAt: event.timestamp,
            loopType: (p.loopType as LoopType) ?? currentLoop,
            reason: typeof p.reason === "string" ? p.reason : "",
            decision: typeof p.decision === "string" ? p.decision : "",
            resolved: false,
          };
          humanInterventions.push(record);
          break;
        }
        case "human-intervention-resolved": {
          const p = event.payload;
          const idx = typeof p.index === "number" ? p.index : humanInterventions.length - 1;
          if (idx >= 0 && idx < humanInterventions.length) {
            // copy-on-write：用新对象替换原对象（不可变优先）
            humanInterventions[idx] = { ...humanInterventions[idx], resolved: true };
          }
          break;
        }
        case "run-paused": {
          const p = event.payload;
          status = "paused";
          blockedReason = typeof p.reason === "string" ? p.reason : undefined;
          break;
        }
        case "run-resumed": {
          status = "running";
          blockedReason = undefined;
          break;
        }
        case "run-completed": {
          status = "completed";
          break;
        }
        case "run-failed": {
          const p = event.payload;
          status = "failed";
          blockedReason = typeof p.reason === "string" ? p.reason : undefined;
          break;
        }
        default: {
          // 未知事件类型：跳过（前向兼容）
          this.log(`未知事件类型，跳过：${event.type}`, "warn");
          break;
        }
      }
    }

    // 最后事件的 cumulativeChecksum 作为 RunState.checksum
    const checksum = events[events.length - 1].cumulativeChecksum;

    return Object.freeze({
      runId,
      projectRoot,
      startedAt,
      updatedAt,
      currentLoop,
      currentIteration,
      completedLoops: Object.freeze([...completedLoops]),
      completedTaskIds: Object.freeze([...completedTaskIds]),
      pendingDeleteFiles: Object.freeze([...pendingDeleteFiles]),
      milestones: Object.freeze([...milestones]),
      humanInterventions: Object.freeze([...humanInterventions]),
      humanInterventionCount: humanInterventions.length,
      totalLlmCallCount,
      totalTokensUsed,
      status,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
      checksum,
    });
  }

  /**
   * 从单个 JSONL 文件构造摘要（listRuns 辅助方法）
   *
   * 读取首行（run-started）+ 末行（最新状态），构造 RunStateSummary。
   * 不进行完整 SHA256 校验（性能考虑），仅做基本字段提取。
   *
   * @param fileName 文件名（含 .jsonl 扩展名）
   * @param jsonlPath 文件绝对路径
   * @returns RunState 摘要
   */
  private buildSummaryFromFile(fileName: string, jsonlPath: string): RunStateSummary {
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new RunStateCorruptedError(fileName, "JSONL 文件为空");
    }

    // 解析首行（run-started）获取 runId / startedAt / initialLoop
    const firstLine = JSON.parse(lines[0]) as RunStateEvent;
    if (firstLine.type !== "run-started") {
      throw new RunStateCorruptedError(fileName, "首事件类型非 run-started");
    }
    const runId = firstLine.payload.runId as string;
    const startedAt = firstLine.timestamp;
    const initialLoop = (firstLine.payload.initialLoop as LoopType) ?? "design";

    // 解析末行获取 updatedAt / status / currentLoop
    const lastLine = JSON.parse(lines[lines.length - 1]) as RunStateEvent;
    const updatedAt = lastLine.timestamp;

    // 通过重放确定 status / currentLoop / completedLoops（轻量重放，不校验 SHA256）
    let status: RunStateStatus = "running";
    let currentLoop: LoopType = initialLoop;
    const completedLoops: LoopType[] = [];
    for (const line of lines) {
      const evt = JSON.parse(line) as RunStateEvent;
      switch (evt.type) {
        case "loop-started":
          currentLoop = (evt.payload.loopType as LoopType) ?? currentLoop;
          break;
        case "loop-completed": {
          const lt = evt.payload.loopType as LoopType | undefined;
          if (lt && !completedLoops.includes(lt)) completedLoops.push(lt);
          break;
        }
        case "run-paused":
          status = "paused";
          break;
        case "run-resumed":
          status = "running";
          break;
        case "run-completed":
          status = "completed";
          break;
        case "run-failed":
          status = "failed";
          break;
        case "human-intervention":
          // 人工介入期间视为 human-checkpoint 状态
          status = "human-checkpoint";
          break;
        case "human-intervention-resolved":
          status = "running";
          break;
      }
    }

    // 完成度 = completedLoops.length / 3（design/coding/testing 三 Loop）
    const completionRate = completedLoops.length / 3;

    return Object.freeze({
      runId,
      startedAt,
      updatedAt,
      status,
      currentLoop,
      completionRate,
    });
  }

  /**
   * 查找 runId 对应的项目根目录（appendEvent 入口辅助方法）
   *
   * appendEvent 入参不含 projectRoot，需通过以下策略查找：
   * 1. 优先查询内存缓存（initialize / load 时写入）
   * 2. 缓存未命中时扫描 process.cwd()/.eag/run-state/<runId>.jsonl
   * 3. 找到文件后读取首行 payload.projectRoot（权威来源）
   *
   * 注意：本方法仅用于 appendEvent 入口，load() 方法直接接收 projectRoot 参数。
   *
   * @param runId run-id
   * @returns 项目根目录绝对路径
   * @throws RunStateNotFoundError 文件不存在
   */
  private async findProjectRootForRun(runId: string): Promise<string> {
    // 1. 优先查询内存缓存（O(1) 查找）
    const cached = this.runIdToProjectRoot.get(runId);
    if (cached) {
      return cached;
    }

    // 2. 缓存未命中时扫描 process.cwd()（CLI 场景：用户从项目根目录运行）
    const candidates = [process.cwd()];
    for (const candidate of candidates) {
      const projectRootAbs = path.resolve(candidate);
      const jsonlPath = path.join(projectRootAbs, DEFAULT_RUN_STATE_DIR, runId + JSONL_EXTENSION);
      if (fs.existsSync(jsonlPath)) {
        // 读取首行获取 projectRoot（首行 payload.projectRoot 是权威来源）
        try {
          const content = fs.readFileSync(jsonlPath, "utf8");
          const firstLine = content.split("\n").filter((l) => l.trim().length > 0)[0];
          if (firstLine) {
            const firstEvent = JSON.parse(firstLine) as RunStateEvent;
            if (firstEvent.type === "run-started" && typeof firstEvent.payload.projectRoot === "string") {
              // 回填缓存（后续 appendEvent 调用可直接命中）
              this.runIdToProjectRoot.set(runId, firstEvent.payload.projectRoot);
              return firstEvent.payload.projectRoot;
            }
          }
        } catch {
          // 读取失败时回退到候选目录
        }
        return projectRootAbs;
      }
    }

    // 3. 未找到文件，抛 RunStateNotFoundError（projectRoot 用 process.cwd() 作为信息）
    throw new RunStateNotFoundError(runId, process.cwd());
  }
}

// ============================================================================
// 6. 工具函数
// ============================================================================

/**
 * Promise 化的 setTimeout（用于文件锁重试休眠）
 *
 * @param ms 休眠毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
