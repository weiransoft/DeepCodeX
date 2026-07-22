/**
 * EAG-P5 Phase 5.2 RunState 持久化存储（P5 版）（TASK-P5-1.2-001）
 *
 * 本模块实现 `RunStateStore` 类，提供 AutonomousOrchestrator 4 阶段循环的
 * 状态持久化能力，是 EAG-P5 无人值守模式跨会话续跑（FR-3.1）与上限不可自改
 * 校验（G-A6d）的核心基础设施。
 *
 * 核心职责（对齐架构师审查文档 §4.1 + §4.2 + §11 兼容性矩阵）：
 * 1. 将 AutonomousRunState 以 JSONL 格式持久化（每行一个状态快照，追加写入）
 * 2. SHA256 累积校验和防腐败（每行含局部 SHA256 + 全文件累积 SHA256）
 * 3. 文件锁防并发写冲突（自实现 O_EXCL 原子锁，零新增依赖）
 * 4. load(runId) 加载最新状态，verify(state) 校验完整性，resume(runId) 断点续跑
 *
 * 与 P3 版 RunStateStore（eag/long-horizon/run-state-store.ts）的差异：
 * - P3 版：面向 Loop 调度器，appendEvent 模式（每次追加一个事件）
 * - P5 版：面向 AutonomousOrchestrator，save(state) 模式（每轮迭代后保存完整状态快照）
 * - P5 版接口更简洁：load / save / verify / resume（4 个方法）
 * - P5 版状态字段聚焦 4 阶段循环（plan/dev/verify/fix + iterIndex + completedStages）
 *
 * 关键技术决策（对齐架构师审查 §4.1）：
 * - 存储格式：JSONL（每行一个状态快照），与 long-horizon 一致
 * - 校验和：SHA256 累积校验（局部 + 累积双层），防止文件腐败
 * - 文件锁：基于 fs.openSync + O_EXCL 自实现（零新增依赖）
 * - 原子追加：fs.appendFileSync + O_APPEND 标志（操作系统级原子性）
 * - 路径布局：<projectRoot>/.eag/p5/run-state/<run-id>.jsonl
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 并发安全：
 * - 单 run-id 同一时刻只允许一个写入方（文件锁保证）
 * - 多 run-id 之间无锁竞争（不同文件）
 *
 * @module eag/p5/run-state-store
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * 文件锁获取重试间隔（毫秒）
 *
 * 当锁文件已存在时，按此间隔重试，直到达到 P5_LOCK_TIMEOUT_MS 上限。
 * 取值 50ms：平衡响应速度与 CPU 占用。
 */
const P5_LOCK_RETRY_INTERVAL_MS = 50 as const;

/**
 * 文件锁获取总超时（毫秒）
 *
 * 超过此时间仍无法获取锁时抛出 P5RunStateStoreError。
 * 取值 5000ms：覆盖正常 git/IO 抖动，避免无限等待。
 */
const P5_LOCK_TIMEOUT_MS = 5000 as const;

/**
 * 文件锁后缀（追加在 .jsonl 文件名后形成 .jsonl.lock）
 */
const P5_LOCK_FILE_SUFFIX = ".lock" as const;

/**
 * JSONL 文件扩展名
 */
const P5_JSONL_EXTENSION = ".jsonl" as const;

/**
 * P5 RunState 默认存储目录（相对 projectRoot）
 *
 * 与 P3 版 .eag/run-state/ 区分，避免与 long-horizon 模块的状态文件冲突。
 */
const P5_DEFAULT_RUN_STATE_DIR = ".eag/p5/run-state" as const;

/**
 * SHA256 校验和前缀
 */
const P5_CHECKSUM_PREFIX = "sha256:" as const;

/**
 * 4 阶段循环的阶段顺序（plan → dev → verify → fix）
 *
 * 对齐架构师审查文档 §5 时序图。
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（G-A6d）。
 */
export const P5_STAGE_ORDER: ReadonlyArray<"plan" | "dev" | "verify" | "fix"> = Object.freeze([
  "plan",
  "dev",
  "verify",
  "fix",
]);

/**
 * Loop 类型字面量联合（对齐 GuardContext.loopType）
 *
 * - design：设计 Loop
 * - coding：编码 Loop
 * - testing：测试 Loop
 * - deploy：部署 Loop
 */
export type P5LoopType = "design" | "coding" | "testing" | "deploy";

/**
 * RunState 状态枚举（字面量联合类型）
 *
 * 对应 AutonomousOrchestrator 4 阶段循环的运行状态：
 * - running：运行中（4 阶段循环正常执行）
 * - paused：已暂停（用户手动暂停或人工介入等待）
 * - completed：已完成（命中 stop_when 或全部任务完成）
 * - failed：已失败（连续失败 abort 或不可恢复错误）
 * - aborted：已熔断（用户手动 /eag-autonomous-stop 触发熔断）
 */
export type P5RunStateStatus = "running" | "paused" | "completed" | "failed" | "aborted";

/**
 * P5_RUN_STATE_STATUSES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const P5_RUN_STATE_STATUSES: ReadonlyArray<P5RunStateStatus> = Object.freeze([
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
]);

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * AutonomousOrchestrator 运行状态（P5 版）
 *
 * 每 4 阶段循环迭代结束保存一次完整快照，持久化为 JSONL 文件的一行。
 *
 * 字段全部 readonly——状态一经快照即不可变，状态变更通过追加新快照表达。
 *
 * 范例：
 *   {
 *     runId: "a1b2c3d4e5f6",
 *     projectRoot: "/path/to/project",
 *     objective: "为订单服务加退款功能",
 *     startedAt: "2026-07-21T10:00:00.000Z",
 *     updatedAt: "2026-07-21T11:30:00.000Z",
 *     currentLoop: "coding",
 *     iterIndex: 3,
 *     currentStage: "verify",
 *     completedStages: ["plan", "dev"],
 *     completedLoops: ["design"],
 *     totalLlmCallCount: 28,
 *     totalTokensUsed: 64200,
 *     consecutiveFailures: 0,
 *     maxIterations: 50,
 *     maxTokens: 200000,
 *     stopWhen: "all tests pass",
 *     status: "running",
 *     lastGuardTriggered: null,
 *     localChecksum: "sha256:abc...",
 *     cumulativeChecksum: "sha256:def..."
 *   }
 */
export interface P5RunState {
  /** run-id（12 位 UUID 前缀，与 RunStateStore 文件名对应） */
  readonly runId: string;
  /** 项目根目录（绝对路径，用于解析 .eag/p5/run-state/ 目录） */
  readonly projectRoot: string;
  /** 用户目标文本（如"为订单服务加退款功能并准备上线"） */
  readonly objective: string;
  /** 启动时间（ISO 8601 字符串） */
  readonly startedAt: string;
  /** 最近更新时间（ISO 8601 字符串，每次 save 时更新） */
  readonly updatedAt: string;
  /** 当前 Loop 类型（design/coding/testing/deploy） */
  readonly currentLoop: P5LoopType;
  /** 当前迭代号（0-based，每完成一次 4 阶段循环递增 1） */
  readonly iterIndex: number;
  /** 当前阶段（plan/dev/verify/fix，4 阶段循环中的当前阶段） */
  readonly currentStage: "plan" | "dev" | "verify" | "fix";
  /** 当前迭代已完成的阶段列表（按顺序，如 ["plan", "dev"] 表示已通过 plan + dev） */
  readonly completedStages: ReadonlyArray<"plan" | "dev" | "verify" | "fix">;
  /** 已完成的 Loop 列表（按完成顺序，如 ["design"] 表示 design Loop 已完成） */
  readonly completedLoops: ReadonlyArray<P5LoopType>;
  /** 累计 LLM 调用次数（4 阶段循环全流程汇总） */
  readonly totalLlmCallCount: number;
  /** 累计 token 消耗（input + output，用于成本核算与 SLA 评估） */
  readonly totalTokensUsed: number;
  /** 连续失败次数（连续 N 次失败触发 abort，对齐 LoopGuard.maxConsecutiveFailures） */
  readonly consecutiveFailures: number;
  /** 最大迭代次数上限（G-A6d 不可自改，初始化后冻结） */
  readonly maxIterations: number;
  /** 最大 Token 预算上限（G-A6d 不可自改，初始化后冻结） */
  readonly maxTokens: number;
  /** stop_when 确定性停止条件（如"all tests pass"） */
  readonly stopWhen: string;
  /** 当前状态（running/paused/completed/failed/aborted） */
  readonly status: P5RunStateStatus;
  /** 最近触发的护栏规则 ID（null=未触发，"G-A3a"=范围锁拦截等） */
  readonly lastGuardTriggered: string | null;
  /** 本行内容的局部 SHA256（前缀 "sha256:"，用于校验本行完整性） */
  readonly localChecksum: string;
  /** 累积 SHA256（前一行 cumulativeChecksum + 本行 localChecksum 的 SHA256，前缀 "sha256:"） */
  readonly cumulativeChecksum: string;
}

/**
 * RunState 持久化错误类型（字面量联合类型）
 *
 * - corrupted：SHA256 校验失败或文件格式损坏
 * - not-found：run-id 对应的 JSONL 文件不存在
 * - already-exists：初始化时 run-id 已存在
 * - lock-timeout：文件锁获取超时
 * - io-failed：底层文件系统 I/O 失败
 * - invalid-request：请求字段非法
 * - verify-failed：verify(state) 校验失败（checksum 不匹配）
 */
export type P5RunStateStoreErrorKind =
  | "corrupted"
  | "not-found"
  | "already-exists"
  | "lock-timeout"
  | "io-failed"
  | "invalid-request"
  | "verify-failed";

/**
 * P5 RunState 持久化错误基类
 *
 * 所有 P5 RunState 持久化相关错误均继承自此基类，
 * 调用方可以通过 instanceof P5RunStateStoreError 统一捕获，
 * 也可通过 err.kind 区分具体错误类型分别处理。
 */
export class P5RunStateStoreError extends Error {
  /**
   * @param kind 错误类型（P5RunStateStoreErrorKind 之一）
   * @param detail 错误详情（人类可读）
   * @param runId 关联的 run-id（便于日志溯源）
   */
  constructor(
    public readonly kind: P5RunStateStoreErrorKind,
    public readonly detail: string,
    public readonly runId?: string
  ) {
    super(`P5 RunState 持久化错误 [${kind}]${runId ? ` runId=${runId}` : ""}：${detail}`);
    this.name = "P5RunStateStoreError";
    // 保持原型链（TypeScript 编译到 ES5 时需要）
    Object.setPrototypeOf(this, P5RunStateStoreError.prototype);
  }
}

/**
 * P5 RunState 校验失败错误（SHA256 不匹配 / JSON 解析失败 / 文件格式损坏）
 *
 * 调用方应拒绝恢复，引导用户从最近 milestone tag 手动恢复。
 */
export class P5RunStateCorruptedError extends P5RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param detail 错误详情（含具体行号与不匹配字段）
   */
  constructor(runId: string, detail: string) {
    super("corrupted", detail, runId);
    this.name = "P5RunStateCorruptedError";
    Object.setPrototypeOf(this, P5RunStateCorruptedError.prototype);
  }
}

/**
 * P5 RunState 不存在错误（run-id 对应的 JSONL 文件不存在）
 */
export class P5RunStateNotFoundError extends P5RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param jsonlPath JSONL 文件绝对路径
   */
  constructor(runId: string, jsonlPath: string) {
    super("not-found", `P5 RunState 文件不存在：${jsonlPath}`, runId);
    this.name = "P5RunStateNotFoundError";
    Object.setPrototypeOf(this, P5RunStateNotFoundError.prototype);
  }
}

/**
 * P5 RunState 已存在错误（initialize 时 run-id 已存在，避免覆盖既有状态）
 */
export class P5RunStateAlreadyExistsError extends P5RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param jsonlPath JSONL 文件绝对路径
   */
  constructor(runId: string, jsonlPath: string) {
    super("already-exists", `P5 RunState 文件已存在：${jsonlPath}`, runId);
    this.name = "P5RunStateAlreadyExistsError";
    Object.setPrototypeOf(this, P5RunStateAlreadyExistsError.prototype);
  }
}

/**
 * P5 RunState 校验失败错误（verify(state) 时 checksum 不匹配）
 *
 * 触发场景：传入的 state.localChecksum 或 state.cumulativeChecksum 与重新计算的结果不一致，
 * 表示状态对象被篡改或文件腐败。
 */
export class P5RunStateVerifyFailedError extends P5RunStateStoreError {
  /**
   * @param runId 关联的 run-id
   * @param detail 校验失败详情（含 expected 与 actual checksum）
   */
  constructor(runId: string, detail: string) {
    super("verify-failed", detail, runId);
    this.name = "P5RunStateVerifyFailedError";
    Object.setPrototypeOf(this, P5RunStateVerifyFailedError.prototype);
  }
}

// ============================================================================
// 3. 文件锁实现（基于 O_EXCL 原子创建，零新增依赖）
// ============================================================================

/**
 * 同步 sleep 辅助函数（基于 Atomics.wait，不阻塞事件循环之外的线程）
 *
 * @param ms 休眠毫秒数
 */
function sleepSync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 文件锁提供者（基于 fs.openSync + O_EXCL 原子创建）
 *
 * 算法：
 * 1. acquire：循环尝试 fs.openSync(lockPath, 'wx')（O_EXCL 标志保证原子性）
 *    - 成功：立即关闭 fd，返回锁文件路径
 *    - 失败（EEXIST）：休眠后重试
 *    - 超时：抛出 P5RunStateStoreError(lock-timeout)
 * 2. release：fs.unlinkSync(lockPath) 删除锁文件
 *
 * 设计理由（零新增依赖）：
 * - packages/core/package.json 不包含 proper-lockfile 等锁库
 * - 使用 fs.openSync + O_EXCL 自实现文件锁
 * - O_EXCL 是 POSIX 标志，保证跨进程原子性
 *
 * 注意：本实现不支持跨机器锁（NFS 等共享文件系统下 O_EXCL 不可靠），
 * 适用场景为单机多进程（CLI 工具的典型场景）。
 */
class P5FileLock {
  /**
   * 获取文件锁（阻塞直到获取成功或超时）
   *
   * @param lockPath 锁文件绝对路径
   * @throws P5RunStateStoreError 锁获取超时或 I/O 失败
   */
  async acquire(lockPath: string): Promise<void> {
    const startTime = Date.now();

    while (true) {
      try {
        // 'wx' 标志 = O_WRONLY | O_CREAT | O_EXCL，原子创建文件
        // 若文件已存在则抛 EEXIST 错误（预期行为，表示锁被占用）
        const fd = fs.openSync(lockPath, "wx");
        // 立即关闭 fd（只需文件存在作为锁标志，不写入内容）
        fs.closeSync(fd);
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          // 锁被占用，检查是否超时
          const elapsed = Date.now() - startTime;
          if (elapsed >= P5_LOCK_TIMEOUT_MS) {
            throw new P5RunStateStoreError("lock-timeout", `文件锁获取超时（${P5_LOCK_TIMEOUT_MS}ms）：${lockPath}`);
          }
          // 短暂休眠后重试
          await sleepSync(P5_LOCK_RETRY_INTERVAL_MS);
          continue;
        }
        // 其他 I/O 错误（如目录不存在）直接抛出
        throw new P5RunStateStoreError("io-failed", `文件锁获取失败：${lockPath} 错误：${e.message}`);
      }
    }
  }

  /**
   * 释放文件锁（删除锁文件）
   *
   * @param lockPath 锁文件绝对路径
   */
  async release(lockPath: string): Promise<void> {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // 锁文件已不存在，视为已释放（幂等）
        return;
      }
      throw new P5RunStateStoreError("io-failed", `文件锁释放失败：${lockPath} 错误：${e.message}`);
    }
  }
}

// ============================================================================
// 4. RunStateStore 主类
// ============================================================================

/**
 * 默认日志空函数（避免 undefined 判空）
 *
 * 对齐 long-horizon 模块的 noopLog 模式。
 */
function p5NoopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

/**
 * 日志回调函数类型
 *
 * - 第一个参数：日志消息
 * - 第二个参数：日志级别（"info" / "warn" / "error"）
 */
export type P5LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * RunState 持久化存储（P5 版，对齐架构师审查 §4.1）
 *
 * 算法：
 * 1. initialize：创建 .eag/p5/run-state/ 目录 + 初始化 JSONL 文件（首行写入初始状态快照）
 * 2. save：获取文件锁 → 读取最后一行 cumulativeChecksum → 构造新快照 → 追加写入 → 释放锁
 * 3. load：读取全部行 → 校验 SHA256 → 返回最后一行（最新状态）
 * 4. verify：重新计算 state 的 localChecksum + cumulativeChecksum → 与 state 内字段比对
 * 5. resume：load 最新状态 + 校验完整性 + 返回可继续执行的 RunState
 *
 * 并发安全：
 * - 单 run-id 同一时刻只允许一个写入方（文件锁保证）
 * - 多 run-id 之间无锁竞争（不同文件，独立锁）
 *
 * 使用方式：
 * ```typescript
 * const store = new P5RunStateStore();
 * // 初始化新 run
 * const initialState = await store.initialize({
 *   projectRoot: "/path/to/project",
 *   objective: "实现用户登录功能",
 *   maxIterations: 50,
 *   maxTokens: 200_000,
 * });
 * // 每轮迭代后保存完整状态
 * const updatedState = await store.save({
 *   ...initialState,
 *   iterIndex: 1,
 *   currentStage: "verify",
 *   completedStages: ["plan", "dev"],
 *   updatedAt: new Date().toISOString(),
 * });
 * // 跨会话恢复
 * const resumed = await store.resume(initialState.runId, "/path/to/project");
 * ```
 */
export class P5RunStateStore {
  /** 文件锁提供者 */
  private readonly fileLock: P5FileLock;
  /** 日志回调（默认 p5NoopLog） */
  private readonly log: P5LogCallback;

  /**
   * @param logger 日志回调（可选）
   */
  constructor(logger: P5LogCallback = p5NoopLog) {
    this.fileLock = new P5FileLock();
    this.log = logger;
  }

  // ------------------------------------------------------------------------
  // 公共 API
  // ------------------------------------------------------------------------

  /**
   * 初始化新 RunState（创建新 run）
   *
   * 算法：
   * 1. 生成 runId（如未提供，自动生成 12 位 UUID 前缀）
   * 2. 解析项目根目录（path.resolve 处理相对路径）
   * 3. 计算 JSONL 文件路径：<projectRoot>/.eag/p5/run-state/<runId>.jsonl
   * 4. 确保目录存在（mkdir -p）
   * 5. 获取文件锁
   * 6. 检查文件是否已存在 → 抛 P5RunStateAlreadyExistsError
   * 7. 构造初始状态快照（status="running"，iterIndex=0，currentStage="plan"）
   * 8. 计算 localChecksum + cumulativeChecksum（首快照累积 = 局部）
   * 9. 原子追加写入首行
   * 10. 释放锁
   * 11. 返回初始 RunState
   *
   * @param request 初始化请求
   * @returns 初始 RunState（status="running"）
   * @throws P5RunStateAlreadyExistsError 同 run-id 已存在
   * @throws P5RunStateStoreError 锁超时 / I/O 失败 / 请求非法
   */
  async initialize(
    request: Readonly<{
      /** 项目根目录（绝对或相对路径） */
      readonly projectRoot: string;
      /** 用户目标文本 */
      readonly objective: string;
      /** run-id（可选，未提供时自动生成 12 位 UUID 前缀） */
      readonly runId?: string;
      /** 初始 Loop 类型（默认 "design"） */
      readonly initialLoop?: P5LoopType;
      /** 最大迭代次数（默认 50，上限 1000） */
      readonly maxIterations?: number;
      /** 最大 Token 预算（默认 200000） */
      readonly maxTokens?: number;
      /** stop_when 确定性停止条件 */
      readonly stopWhen?: string;
    }>
  ): Promise<Readonly<P5RunState>> {
    // 1. 校验请求
    if (!request || typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "projectRoot 必须为非空字符串");
    }
    if (typeof request.objective !== "string" || request.objective.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "objective 必须为非空字符串");
    }

    // 2. 生成或校验 runId
    const runId = request.runId ?? this.generateRunId();
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "runId 必须为非空字符串");
    }
    // runId 仅允许字母/数字/连字符（防止路径穿越攻击）
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
      throw new P5RunStateStoreError("invalid-request", `runId 仅允许字母/数字/连字符，实际值：${runId}`);
    }

    // 3. 解析配置（应用默认值）
    const initialLoop: P5LoopType = request.initialLoop ?? "design";
    const maxIterations = request.maxIterations ?? 50;
    const maxTokens = request.maxTokens ?? 200_000;
    const stopWhen = request.stopWhen ?? "";

    // 4. 解析路径
    const projectRootAbs = path.resolve(request.projectRoot);
    const runStateDir = path.join(projectRootAbs, P5_DEFAULT_RUN_STATE_DIR);
    const jsonlPath = path.join(runStateDir, runId + P5_JSONL_EXTENSION);
    const lockPath = jsonlPath + P5_LOCK_FILE_SUFFIX;

    this.log(`P5 初始化 RunState：runId=${runId} path=${jsonlPath}`, "info");

    // 5. 确保目录存在（必须在获取锁之前完成，避免 FileLock 抛 ENOENT）
    fs.mkdirSync(runStateDir, { recursive: true });

    // 6. 获取文件锁
    await this.fileLock.acquire(lockPath);
    try {
      // 7. 检查文件是否已存在
      if (fs.existsSync(jsonlPath)) {
        throw new P5RunStateAlreadyExistsError(runId, jsonlPath);
      }

      // 8. 构造初始状态（不含 checksum 字段，由 buildStateWithChecksum 计算）
      const timestamp = new Date().toISOString();
      const stateWithoutChecksum: Omit<P5RunState, "localChecksum" | "cumulativeChecksum"> = {
        runId,
        projectRoot: projectRootAbs,
        objective: request.objective,
        startedAt: timestamp,
        updatedAt: timestamp,
        currentLoop: initialLoop,
        iterIndex: 0,
        currentStage: "plan",
        completedStages: Object.freeze([]),
        completedLoops: Object.freeze([]),
        totalLlmCallCount: 0,
        totalTokensUsed: 0,
        consecutiveFailures: 0,
        maxIterations,
        maxTokens,
        stopWhen,
        status: "running",
        lastGuardTriggered: null,
      };

      // 9. 构造带校验和的状态（首快照的 cumulativeChecksum = localChecksum）
      const initialState = this.buildStateWithChecksum(stateWithoutChecksum, "");

      // 10. 原子追加写入首行
      this.appendStateLine(jsonlPath, initialState);

      this.log(`P5 RunState 初始化完成：runId=${runId}`, "info");

      return initialState;
    } finally {
      // 释放锁（无论成功或失败）
      await this.fileLock.release(lockPath);
    }
  }

  /**
   * 保存 RunState 状态快照（每次迭代或阶段转换后调用）
   *
   * 算法：
   * 1. 校验入参（state.runId / projectRoot 必填）
   * 2. 解析路径 + 获取文件锁
   * 3. 检查文件存在 → 不存在抛 P5RunStateNotFoundError
   * 4. 读取现有全部快照（含 SHA256 校验）
   * 5. 取最后一行的 cumulativeChecksum 作为前置累积值
   * 6. 构造新状态快照（重算 localChecksum + cumulativeChecksum）
   * 7. 原子追加写入新行
   * 8. 释放锁
   * 9. 返回带新 checksum 的状态
   *
   * @param state 待保存的状态（不含 checksum 字段或含旧 checksum 均可，方法内部会重算）
   * @returns 带新 checksum 的状态
   * @throws P5RunStateNotFoundError run-id 不存在
   * @throws P5RunStateCorruptedError 现有文件 SHA256 校验失败
   * @throws P5RunStateStoreError 锁超时 / I/O 失败
   */
  async save(state: Readonly<Omit<P5RunState, "localChecksum" | "cumulativeChecksum">>): Promise<Readonly<P5RunState>> {
    // 1. 校验入参
    if (!state || typeof state.runId !== "string" || state.runId.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "state.runId 必须为非空字符串");
    }
    if (typeof state.projectRoot !== "string" || state.projectRoot.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "state.projectRoot 必须为非空字符串");
    }
    // runId 路径穿越防护
    if (!/^[a-zA-Z0-9-]+$/.test(state.runId)) {
      throw new P5RunStateStoreError("invalid-request", `runId 仅允许字母/数字/连字符，实际值：${state.runId}`);
    }

    // 2. 解析路径
    const projectRootAbs = path.resolve(state.projectRoot);
    const runStateDir = path.join(projectRootAbs, P5_DEFAULT_RUN_STATE_DIR);
    const jsonlPath = path.join(runStateDir, state.runId + P5_JSONL_EXTENSION);
    const lockPath = jsonlPath + P5_LOCK_FILE_SUFFIX;

    this.log(`P5 保存 RunState：runId=${state.runId} iterIndex=${state.iterIndex} stage=${state.currentStage}`, "info");

    // 3. 获取文件锁
    await this.fileLock.acquire(lockPath);
    try {
      // 4. 检查文件存在
      if (!fs.existsSync(jsonlPath)) {
        throw new P5RunStateNotFoundError(state.runId, jsonlPath);
      }

      // 5. 读取现有全部快照（含 SHA256 校验）
      const existingStates = this.readAndVerifyStates(state.runId, jsonlPath);
      // 6. 取前置累积 SHA256（首快照的前置为空字符串）
      const prevCumulative =
        existingStates.length > 0 ? existingStates[existingStates.length - 1].cumulativeChecksum : "";

      // 7. 构造新状态（重算 checksum，更新 updatedAt）
      const newState = this.buildStateWithChecksum(
        {
          ...state,
          updatedAt: new Date().toISOString(),
        },
        prevCumulative
      );

      // 8. 原子追加
      this.appendStateLine(jsonlPath, newState);

      this.log(`P5 RunState 保存成功：runId=${state.runId} iterIndex=${state.iterIndex}`, "info");

      return newState;
    } finally {
      await this.fileLock.release(lockPath);
    }
  }

  /**
   * 加载 RunState 最新状态
   *
   * 算法：
   * 1. 校验入参
   * 2. 解析路径 + 检查文件存在
   * 3. 读取全部行 + SHA256 校验
   * 4. 返回最后一行（最新状态）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 最新 RunState
   * @throws P5RunStateNotFoundError 文件不存在
   * @throws P5RunStateCorruptedError SHA256 校验失败
   */
  async load(runId: string, projectRoot: string): Promise<Readonly<P5RunState>> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "runId 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new P5RunStateStoreError("invalid-request", "projectRoot 必须为非空字符串");
    }

    // 2. 解析路径
    const projectRootAbs = path.resolve(projectRoot);
    const runStateDir = path.join(projectRootAbs, P5_DEFAULT_RUN_STATE_DIR);
    const jsonlPath = path.join(runStateDir, runId + P5_JSONL_EXTENSION);

    this.log(`P5 加载 RunState：runId=${runId} path=${jsonlPath}`, "info");

    // 3. 检查文件存在
    if (!fs.existsSync(jsonlPath)) {
      throw new P5RunStateNotFoundError(runId, jsonlPath);
    }

    // 4. 读取 + 校验（无需获取锁，读操作并发安全）
    const states = this.readAndVerifyStates(runId, jsonlPath);

    // 5. 返回最后一行（最新状态）
    return states[states.length - 1];
  }

  /**
   * 校验 RunState 完整性（不读取文件，仅校验传入 state 的 checksum 字段）
   *
   * 算法：
   * 1. 重新计算 state 的 localChecksum（基于除 checksum 字段外的全部字段）
   * 2. 比对 state.localChecksum 是否与重算结果一致
   * 3. 若提供 expectedCumulative，校验 state.cumulativeChecksum 是否匹配
   *
   * @param state 待校验的状态
   * @param expectedCumulative 期望的累积 checksum（可选，用于跨快照链式校验）
   * @returns 校验通过返回 true，否则抛出 P5RunStateVerifyFailedError
   * @throws P5RunStateVerifyFailedError checksum 不匹配
   */
  verify(state: Readonly<P5RunState>, expectedCumulative?: string): boolean {
    if (!state || typeof state.runId !== "string") {
      throw new P5RunStateStoreError("invalid-request", "state 必须包含 runId 字段");
    }

    // 1. 重新计算 localChecksum
    const expectedLocal = this.computeLocalChecksum(state);
    if (state.localChecksum !== expectedLocal) {
      throw new P5RunStateVerifyFailedError(
        state.runId,
        `localChecksum 不匹配：expected=${expectedLocal} actual=${state.localChecksum}`
      );
    }

    // 2. 若提供 expectedCumulative，校验累积 checksum
    if (expectedCumulative !== undefined) {
      const expectedCum = this.computeCumulativeChecksum(expectedCumulative, state.localChecksum);
      if (state.cumulativeChecksum !== expectedCum) {
        throw new P5RunStateVerifyFailedError(
          state.runId,
          `cumulativeChecksum 不匹配：expected=${expectedCum} actual=${state.cumulativeChecksum}`
        );
      }
    }

    return true;
  }

  /**
   * 断点续跑入口（加载最新状态 + 校验完整性 + 返回可继续执行的状态）
   *
   * 算法：
   * 1. 调用 load(runId, projectRoot) 加载最新状态
   * 2. 校验最新状态的 checksum 完整性
   * 3. 若状态为 completed/failed/aborted，返回原状态（不可继续）
   * 4. 若状态为 paused/running，重置为 running 并返回（可继续执行）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 可继续执行的 RunState（status="running"）
   * @throws P5RunStateNotFoundError 文件不存在
   * @throws P5RunStateCorruptedError SHA256 校验失败
   * @throws P5RunStateVerifyFailedError verify 校验失败
   */
  async resume(runId: string, projectRoot: string): Promise<Readonly<P5RunState>> {
    // 1. 加载最新状态
    const latestState = await this.load(runId, projectRoot);

    this.log(
      `P5 resume RunState：runId=${runId} status=${latestState.status} iterIndex=${latestState.iterIndex}`,
      "info"
    );

    // 2. 校验完整性（不传 expectedCumulative，仅校验 localChecksum）
    this.verify(latestState);

    // 3. 已终止的状态不可继续
    if (latestState.status === "completed" || latestState.status === "failed" || latestState.status === "aborted") {
      this.log(`P5 resume 拒绝：runId=${runId} 状态为 ${latestState.status}，不可继续执行`, "warn");
      return latestState;
    }

    // 4. paused/running 状态可继续，重置为 running
    if (latestState.status === "paused" || latestState.status === "running") {
      // 重置为 running 状态，更新 updatedAt，调用方需自行 save 持久化
      const resumedState = this.buildStateWithChecksum(
        {
          ...latestState,
          status: "running" as const,
          updatedAt: new Date().toISOString(),
        },
        latestState.cumulativeChecksum
      );
      return resumedState;
    }

    return latestState;
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 生成 12 位 UUID 前缀作为 runId
   *
   * 对齐 long-horizon RunStateStore.generateRunId 实现，保持 runId 格式一致性。
   *
   * @returns 12 位十六进制字符串
   */
  private generateRunId(): string {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return uuid.substring(0, 12);
  }

  /**
   * 计算状态的局部 SHA256 校验和
   *
   * 算法：
   * 1. 提取除 localChecksum / cumulativeChecksum 外的全部字段
   * 2. 序列化为规范 JSON（字段顺序固定，保证确定性）
   * 3. 计算 SHA256 hex，前缀 "sha256:"
   *
   * @param state 待计算的状态（含或不含 checksum 字段均可，计算时排除）
   * @returns 局部 SHA256 校验和（格式："sha256:abcdef..."）
   */
  private computeLocalChecksum(state: Readonly<Partial<P5RunState>>): string {
    // 提取核心字段（除 localChecksum / cumulativeChecksum 外）
    // 字段顺序固定，保证确定性
    const coreContent = JSON.stringify({
      runId: state.runId,
      projectRoot: state.projectRoot,
      objective: state.objective,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      currentLoop: state.currentLoop,
      iterIndex: state.iterIndex,
      currentStage: state.currentStage,
      completedStages: state.completedStages,
      completedLoops: state.completedLoops,
      totalLlmCallCount: state.totalLlmCallCount,
      totalTokensUsed: state.totalTokensUsed,
      consecutiveFailures: state.consecutiveFailures,
      maxIterations: state.maxIterations,
      maxTokens: state.maxTokens,
      stopWhen: state.stopWhen,
      status: state.status,
      lastGuardTriggered: state.lastGuardTriggered,
    });
    const hash = crypto.createHash("sha256").update(coreContent, "utf8").digest("hex");
    return `${P5_CHECKSUM_PREFIX}${hash}`;
  }

  /**
   * 计算累积 SHA256 校验和
   *
   * 算法：cumulativeChecksum = "sha256:" + sha256(prevCumulative + localChecksum)
   *
   * @param prevCumulative 前一状态的 cumulativeChecksum（首状态传空字符串）
   * @param localChecksum 本状态的 localChecksum
   * @returns 累积 SHA256 校验和
   */
  private computeCumulativeChecksum(prevCumulative: string, localChecksum: string): string {
    const input = prevCumulative + localChecksum;
    const hash = crypto.createHash("sha256").update(input, "utf8").digest("hex");
    return `${P5_CHECKSUM_PREFIX}${hash}`;
  }

  /**
   * 构造带校验和的 RunState（不可变，Object.freeze）
   *
   * @param stateWithoutChecksum 不含 checksum 字段的状态
   * @param prevCumulative 前一状态的 cumulativeChecksum（首状态传空字符串）
   * @returns 带 localChecksum + cumulativeChecksum 的冻结状态
   */
  private buildStateWithChecksum(
    stateWithoutChecksum: Omit<P5RunState, "localChecksum" | "cumulativeChecksum">,
    prevCumulative: string
  ): Readonly<P5RunState> {
    const localChecksum = this.computeLocalChecksum(stateWithoutChecksum);
    const cumulativeChecksum = this.computeCumulativeChecksum(prevCumulative, localChecksum);
    return Object.freeze({
      ...stateWithoutChecksum,
      localChecksum,
      cumulativeChecksum,
    });
  }

  /**
   * 原子追加状态行到 JSONL 文件
   *
   * 使用 fs.appendFileSync + O_APPEND 标志，操作系统保证追加操作的原子性。
   *
   * @param jsonlPath JSONL 文件绝对路径
   * @param state 待写入的状态
   */
  private appendStateLine(jsonlPath: string, state: Readonly<P5RunState>): void {
    const line = JSON.stringify(state) + "\n";
    try {
      fs.appendFileSync(jsonlPath, line, { encoding: "utf8", flag: "a" });
    } catch (err) {
      throw new P5RunStateStoreError("io-failed", `写入 JSONL 文件失败：${jsonlPath} 错误：${(err as Error).message}`);
    }
  }

  /**
   * 读取并校验 JSONL 文件全部状态快照
   *
   * 算法：
   * 1. 读取文件全部内容
   * 2. 按行拆分（过滤空行）
   * 3. 逐行 JSON.parse + 校验 localChecksum + 校验 cumulativeChecksum
   * 4. 任一行校验失败 → 抛 P5RunStateCorruptedError
   *
   * @param runId run-id（用于错误信息）
   * @param jsonlPath JSONL 文件路径
   * @returns 校验通过的状态列表
   * @throws P5RunStateCorruptedError 任一行校验失败
   */
  private readAndVerifyStates(runId: string, jsonlPath: string): ReadonlyArray<Readonly<P5RunState>> {
    let content: string;
    try {
      content = fs.readFileSync(jsonlPath, "utf8");
    } catch (err) {
      throw new P5RunStateStoreError(
        "io-failed",
        `读取 JSONL 文件失败：${jsonlPath} 错误：${(err as Error).message}`,
        runId
      );
    }

    // 按行拆分（过滤尾部空行）
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new P5RunStateCorruptedError(runId, "JSONL 文件为空（无状态快照）");
    }

    const states: P5RunState[] = [];
    let prevCumulative = "";

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // 解析 JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new P5RunStateCorruptedError(runId, `第 ${lineNum} 行 JSON 解析失败：${(err as Error).message}`);
      }

      // 校验字段完整性
      if (typeof parsed !== "object" || parsed === null) {
        throw new P5RunStateCorruptedError(runId, `第 ${lineNum} 行非对象`);
      }
      const obj = parsed as Record<string, unknown>;
      const requiredStringFields = [
        "runId",
        "projectRoot",
        "objective",
        "startedAt",
        "updatedAt",
        "currentLoop",
        "currentStage",
        "stopWhen",
        "status",
        "localChecksum",
        "cumulativeChecksum",
      ];
      for (const f of requiredStringFields) {
        if (typeof obj[f] !== "string") {
          throw new P5RunStateCorruptedError(runId, `第 ${lineNum} 行字段 ${f} 缺失或类型错误`);
        }
      }
      const requiredNumberFields = [
        "iterIndex",
        "totalLlmCallCount",
        "totalTokensUsed",
        "consecutiveFailures",
        "maxIterations",
        "maxTokens",
      ];
      for (const f of requiredNumberFields) {
        if (typeof obj[f] !== "number") {
          throw new P5RunStateCorruptedError(runId, `第 ${lineNum} 行字段 ${f} 缺失或类型错误`);
        }
      }
      if (!Array.isArray(obj.completedStages)) {
        throw new P5RunStateCorruptedError(runId, `第 ${lineNum} 行 completedStages 字段缺失或非数组`);
      }
      if (!Array.isArray(obj.completedLoops)) {
        throw new P5RunStateCorruptedError(runId, `第 ${lineNum} 行 completedLoops 字段缺失或非数组`);
      }

      // 构造状态对象（用于校验）
      const state = obj as unknown as P5RunState;

      // 重新计算 localChecksum 并校验
      const expectedLocal = this.computeLocalChecksum(state);
      if (state.localChecksum !== expectedLocal) {
        throw new P5RunStateCorruptedError(
          runId,
          `第 ${lineNum} 行 localChecksum 不匹配：expected=${expectedLocal} actual=${state.localChecksum}`
        );
      }

      // 重新计算 cumulativeChecksum 并校验
      const expectedCumulative = this.computeCumulativeChecksum(prevCumulative, state.localChecksum);
      if (state.cumulativeChecksum !== expectedCumulative) {
        throw new P5RunStateCorruptedError(
          runId,
          `第 ${lineNum} 行 cumulativeChecksum 不匹配：expected=${expectedCumulative} actual=${state.cumulativeChecksum}`
        );
      }

      // 校验通过，加入状态列表（冻结）
      states.push(Object.freeze({ ...state }));

      // 更新前置累积值
      prevCumulative = state.cumulativeChecksum;
    }

    return Object.freeze(states);
  }
}

// ============================================================================
// 5. 工厂函数与导出
// ============================================================================

/**
 * 创建默认 P5RunStateStore 实例
 *
 * @param logger 日志回调（可选）
 * @returns 默认 P5RunStateStore 实例
 */
export function createDefaultP5RunStateStore(logger?: P5LogCallback): P5RunStateStore {
  return new P5RunStateStore(logger);
}

/**
 * 导出常量（供测试断言）
 */
export {
  P5_LOCK_TIMEOUT_MS as P5_RUN_STATE_LOCK_TIMEOUT_MS,
  P5_LOCK_RETRY_INTERVAL_MS as P5_RUN_STATE_LOCK_RETRY_INTERVAL_MS,
  P5_DEFAULT_RUN_STATE_DIR,
  P5_JSONL_EXTENSION,
  P5_LOCK_FILE_SUFFIX,
  P5_CHECKSUM_PREFIX,
};
