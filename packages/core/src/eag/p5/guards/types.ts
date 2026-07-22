/**
 * EAG-P5 Phase 5.2 守护链共享类型定义（TASK-P5-5.2-001~007 通用契约）
 *
 * 本模块定义 6 层 15 条 BLOCKER 守护链的共享数据模型，包括：
 * - GuardLayer / GuardRuleId / GuardSeverity / GuardDecision 字面量联合类型
 * - GuardContext / GuardVerdict / GuardRule / GuardChain / GuardChainResult / GuardRecord 接口
 * - TaskCard / ChangeDiff / CompletionEvidence 辅助数据模型
 * - GuardViolationError 错误类型
 * - createPassVerdict / createDenyVerdict / createAskVerdict 工厂函数
 *
 * 设计依据：
 * - 架构师审查文档 §4.2 BlockerGuardChain 接口契约
 * - 需求文档 §3 FR-2 6 层 15 条 BLOCKER 护栏清单
 * - 不可变优先原则（NFR-8）：所有接口字段 readonly + Object.freeze 工厂函数
 *
 * 模块化决策：
 * - 共享类型独立成文件（types.ts），避免 guard 实现文件之间的循环依赖
 * - 6 个 Guard 类与 BlockerGuardChain 均从此文件 import 类型与工具函数
 * - 错误类型 GuardViolationError 集中定义，便于调用方统一捕获
 *
 * @module eag/p5/guards/types
 */

// ============================================================================
// 1. 字面量联合类型（编译期防止拼写错误）
// ============================================================================

/**
 * 护栏层级（6 层）
 *
 * 对应需求文档 §3 FR-2 的 6 大守护层：
 * - A-1：环境边界硬隔离（3 条 BLOCKER：G-A1a/A1b/A1c）
 * - A-2：危险命令拦截层（3 条 BLOCKER：G-A2a/A2b/A2c）
 * - A-3：任务范围锁（2 条 BLOCKER：G-A3a/A3b）
 * - A-4：防伪造完成（2 条 BLOCKER：G-A4a/A4b）
 * - A-5：防越权用凭证（2 条 BLOCKER：G-A5a/A5b）
 * - A-6：无人值守运行时约束（3 条 BLOCKER + 1 条 MAJOR：G-A6a/A6b/A6c/A6d）
 *
 * 守护链按 A-1 → A-2 → A-3 → A-4 → A-5 → A-6 顺序执行。
 */
export type GuardLayer = "A-1" | "A-2" | "A-3" | "A-4" | "A-5" | "A-6";

/**
 * 护栏规则 ID（15 条 BLOCKER + 1 条 MAJOR）
 *
 * 字面量联合类型，编译期防止拼写错误。
 * 命名规范：G-{layer}{sub}，如 G-A1a 表示 A-1 层的 a 子规则。
 *
 * 完整清单（对齐需求文档 §11 速查表）：
 * - G-A1a：路径牢笼（path jail），越界路径写入 DENY
 * - G-A1b：环境变量写保护，禁止修改 HOME/PATH/LD_* 等
 * - G-A1c：生产凭据不可达，启动前扫描检出生产凭据即 fail-closed
 * - G-A2a：黑名单永禁（30+ 模式，DENY 不可豁免）
 * - G-A2b：删除操作分级（默认 DENY→转人工；单文件 ∈ 待删清单可 AUTO；批量 >3 必须 AI）
 * - G-A2c：白名单收敛（AUTO 仅覆盖测试/lint/build/install/git 限定操作）
 * - G-A3a：行动依据唯一化（变更 diff vs 任务卡范围静态比对）
 * - G-A3b：清理类意图永禁 AUTO（cleanup/purge/reset 永远转人工）
 * - G-A4a：完成声明证据强制（测试退出码 + 覆盖率 + 评估器 verdict）
 * - G-A4b：stop_when 确定性判定（条件编译期校验）
 * - G-A5a：凭据文件读取白名单（.env, credentials, token, secret, SSH 私钥 等）
 * - G-A5b：commit 前密钥扫描（gitleaks 规则集）
 * - G-A6a：《无人值守确认卡》前置
 * - G-A6b：一键熔断与回滚
 * - G-A6c：心跳可观测（MAJOR 级，不计入 15 条 BLOCKER）
 * - G-A6d：上限不可自改（Object.freeze + 运行期改写尝试拦截）
 */
export type GuardRuleId =
  | "G-A1a"
  | "G-A1b"
  | "G-A1c"
  | "G-A2a"
  | "G-A2b"
  | "G-A2c"
  | "G-A3a"
  | "G-A3b"
  | "G-A4a"
  | "G-A4b"
  | "G-A5a"
  | "G-A5b"
  | "G-A6a"
  | "G-A6b"
  | "G-A6d"
  | "G-A6c"; // MAJOR 级

/**
 * 护栏规则严重性
 *
 * - BLOCKER：阻断级，触发即中止迭代（15 条 BLOCKER）
 * - MAJOR：重要级，触发转人工确认或仅记录（1 条 MAJOR：G-A6c）
 */
export type GuardSeverity = "BLOCKER" | "MAJOR";

/**
 * 护栏判定决策
 *
 * - PASS：通过，继续执行守护链下一层
 * - DENY：拒绝（BLOCKER 触发），立即中止迭代并回滚
 * - ASK：转人工确认（MAJOR 触发或 BLOCKER 软拦截）
 *
 * 决策优先级：DENY > ASK > PASS
 * 守护链中任一层返回 DENY 即短路中止，不再执行后续层。
 */
export type GuardDecision = "PASS" | "DENY" | "ASK";

// ============================================================================
// 2. 辅助数据模型（GuardContext 引用）
// ============================================================================

/**
 * 任务卡（tasks.md 中的任务单元）
 *
 * 对齐 eag/doc-driven/types.ts 的 TaskCard 接口，用于 G-A3a 范围锁比对。
 * 此处独立定义简化版，避免与 doc-driven 模块的循环依赖。
 * 字段全部 readonly，使用 ReadonlyArray<T> 保证不可变。
 */
export interface TaskCard {
  /** 任务 ID（如 "T-001"，遵循 T-NNN 三位数字编号规范） */
  readonly id: string;
  /** 任务标题（简洁描述任务） */
  readonly title: string;
  /** 需求溯源 ID（如 "F-001"，对齐 [REQ-F-xxx] 标记规范） */
  readonly requirementId: string;
  /** 依赖任务 ID 列表（必须在本任务启动前完成） */
  readonly dependencies: ReadonlyArray<string>;
  /** 验收标准列表（可执行的测试命令或自然语言断言） */
  readonly acceptanceCriteria: ReadonlyArray<string>;
  /** 任务状态（pending/in-progress/completed/blocked） */
  readonly status: "pending" | "in-progress" | "completed" | "blocked";
  /**
   * 任务卡声明受影响的符号 ID 列表（G-A3a 范围锁比对依据）
   *
   * 范例：
   *   ["src/services/UserService.ts:UserService.login",
   *    "src/domain/UserAggregate.ts:UserAggregate.constructor"]
   */
  readonly declaredSymbols: ReadonlyArray<string>;
  /**
   * 任务卡声明受影响的文件路径列表（G-A3a 范围锁文件级比对依据）
   *
   * 路径相对于 projectRoot，使用 POSIX 分隔符。
   * 范例：["src/services/UserService.ts", "src/domain/UserAggregate.ts"]
   */
  readonly declaredFiles: ReadonlyArray<string>;
  /**
   * 任务卡声明的待删文件清单（G-A2b 删除分级判定依据）
   *
   * 仅任务卡显式声明需删除的文件才允许在 AUTO 模式下单文件删除。
   * 范例：["src/legacy/old-service.ts"]
   */
  readonly declaredDeletions: ReadonlyArray<string>;
}

/**
 * 代码变更 diff（dev 阶段产生的代码变更）
 *
 * 用于 G-A3a 范围锁比对：currentDiff.changedFiles 必须映射到 currentTaskCard.declaredFiles。
 */
export interface ChangeDiff {
  /** 变更的文件列表（每文件含路径/新增行数/删除行数/变更类型） */
  readonly changedFiles: ReadonlyArray<Readonly<ChangedFile>>;
  /** 变更涉及的符号 ID 列表（符号级偏离检测依据，可选） */
  readonly affectedSymbols?: ReadonlyArray<string>;
  /** diff 总新增行数 */
  readonly totalAdditions: number;
  /** diff 总删除行数 */
  readonly totalDeletions: number;
}

/**
 * 单文件变更记录
 */
export interface ChangedFile {
  /** 文件相对路径（相对于 projectRoot，使用 POSIX 分隔符） */
  readonly filePath: string;
  /** 变更类型（新增/修改/删除/重命名） */
  readonly changeType: "added" | "modified" | "deleted" | "renamed";
  /** 新增行数 */
  readonly additions: number;
  /** 删除行数 */
  readonly deletions: number;
  /** 重命名时的旧路径（changeType=renamed 时填写） */
  readonly oldFilePath?: string;
}

/**
 * 完成声明证据（verify 阶段产出）
 *
 * G-A4a 完成声明证据强制：任务/迭代"完成"声明必须附客观证据。
 * 禁止自然语言"已验证/已完成"声明（Evaluator STRICT 只采信客观指标）。
 */
export interface CompletionEvidence {
  /** 测试命令（如 "npm test"） */
  readonly testCommand: string;
  /** 测试命令退出码（0=成功，非 0=失败） */
  readonly testExitCode: number;
  /** 测试输出摘要（前 N 行或关键行，禁止自然语言"已验证"声明） */
  readonly testOutputSummary: string;
  /** 测试覆盖率数值（0-100，百分比） */
  readonly coveragePercent: number;
  /** 评估器 verdict（pass/fail/inconclusive） */
  readonly evaluatorVerdict: "pass" | "fail" | "inconclusive";
  /** 测试执行时间戳（ISO 8601） */
  readonly executedAt: string;
}

// ============================================================================
// 3. 守护链核心接口
// ============================================================================

/**
 * 护栏判定上下文
 *
 * 每次迭代每阶段执行前构造，传入护栏守护链。
 * 字段全部 readonly，使用 ReadonlyArray<T> 保证不可变。
 *
 * 字段使用规则：
 * - runId / iterIndex / stage / loopType / projectRoot / worktreePath：必填，所有层共用
 * - currentTaskCard：plan 阶段必填，G-A3a 范围锁比对依据
 * - pendingCommand：dev/verify 阶段必填，G-A2a/A2b/A2c 命令判定依据
 * - currentDiff：dev 阶段必填，G-A3a 范围锁比对依据
 * - completionEvidence：verify 阶段必填，G-A4a 证据强制判定依据
 * - pendingReadFiles：dev 阶段必填，G-A5a 凭据读取白名单判定依据
 * - pendingCommitFiles：commit 前必填，G-A5b 密钥扫描判定依据
 */
export interface GuardContext {
  /** 当前 run-id */
  readonly runId: string;
  /** 当前迭代号（0-based） */
  readonly iterIndex: number;
  /** 当前阶段（plan/dev/verify/fix） */
  readonly stage: "plan" | "dev" | "verify" | "fix";
  /** 当前 Loop 类型 */
  readonly loopType: "design" | "coding" | "testing" | "deploy";
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** worktree 路径（路径牢笼边界，绝对路径） */
  readonly worktreePath: string;
  /** 当前任务卡（plan 阶段从 tasks.md 取出） */
  readonly currentTaskCard?: Readonly<TaskCard>;
  /** 当前命令（dev/verify 阶段即将执行的命令） */
  readonly pendingCommand?: string;
  /** 当前变更 diff（dev 阶段产生的代码变更） */
  readonly currentDiff?: Readonly<ChangeDiff>;
  /** 完成声明证据（verify 阶段产出） */
  readonly completionEvidence?: Readonly<CompletionEvidence>;
  /** 待读取的文件路径列表（dev 阶段即将读取，相对路径） */
  readonly pendingReadFiles?: ReadonlyArray<string>;
  /** 待提交的 git 变更（commit 前扫描，相对路径） */
  readonly pendingCommitFiles?: ReadonlyArray<string>;
  /**
   * 环境变量快照（G-A1c 生产凭据扫描依据）
   *
   * 键值对形式，如 { "DATABASE_URL": "postgres://...", "AWS_ACCESS_KEY_ID": "..." }
   * 缺省时取 process.env 的快照。
   */
  readonly envSnapshot?: Readonly<Record<string, string>>;
  /**
   * 上限配置快照（G-A6d 上限不可自改判定依据）
   *
   * 包含 maxIterations / maxTokens / maxConsecutiveFailures。
   * 构造时由调用方从 LoopGuard.getConfig() 取快照传入。
   */
  readonly loopGuardConfig?: Readonly<{
    maxIterations: number;
    maxTokens: number;
    maxConsecutiveFailures: number;
  }>;
  /**
   * 确认卡是否已确认（G-A6a 确认卡前置判定依据）
   *
   * true 表示用户已显式确认进入无人值守模式；
   * false 或 undefined 表示未确认，进入循环前必须拦截。
   */
  readonly confirmationCardAccepted?: boolean;
  /**
   * 熔断请求标志（G-A6b 一键熔断与回滚判定依据）
   *
   * true 表示外部已发起 /eag-autonomous-stop <run-id> 熔断请求；
   * 守护链检测到 true 时立即 DENY 并触发回滚。
   */
  readonly emergencyStopRequested?: boolean;
  /**
   * stop_when 停止条件表达式（G-A4b 确定性判定依据）
   *
   * 如 "all tests pass" / "coverage >= 80%"。
   * 守护链对表达式做编译期校验，拒绝无法确定化的条件。
   */
  readonly stopWhenExpression?: string;
}

/**
 * 护栏判定结果
 *
 * 每个 GuardRule.check() 返回此结构。
 * 字段全部 readonly，使用 Object.freeze 冻结。
 */
export interface GuardVerdict {
  /** 决策（PASS/DENY/ASK） */
  readonly decision: GuardDecision;
  /** 触发的规则 ID（PASS 时为空字符串） */
  readonly ruleId: GuardRuleId | "";
  /** 规则严重性（PASS 时为空字符串） */
  readonly severity: GuardSeverity | "";
  /** 拦截原因（DENY/ASK 时填写，PASS 时为空字符串） */
  readonly reason: string;
  /** 建议动作（如"转人工确认"/"回滚到 m2"/"中止迭代"） */
  readonly suggestedAction: string;
  /** 拦截时间戳（ISO 8601） */
  readonly timestamp: string;
}

/**
 * 护栏规则接口（每条 BLOCKER 一个实现）
 *
 * 所有 Guard 类必须实现此接口。
 * check() 方法支持同步或异步返回（Promise<GuardVerdict> | GuardVerdict）。
 */
export interface GuardRule {
  /** 规则 ID */
  readonly ruleId: GuardRuleId;
  /** 所属层级 */
  readonly layer: GuardLayer;
  /** 严重性 */
  readonly severity: GuardSeverity;
  /**
   * 判定函数
   *
   * @param context 判定上下文（readonly，不可修改）
   * @returns 判定结果（readonly GuardVerdict）
   */
  check(context: Readonly<GuardContext>): Promise<Readonly<GuardVerdict>> | Readonly<GuardVerdict>;
}

/**
 * 守护链执行结果
 *
 * BlockerGuardChain.execute() 返回此结构。
 * 字段全部 readonly，使用 ReadonlyArray<T>。
 */
export interface GuardChainResult {
  /** 总体决策（任一 BLOCKER 触发即 DENY，任一 MAJOR 触发即 ASK，全部 PASS 即 PASS） */
  readonly overallDecision: GuardDecision;
  /** 触发的护栏记录列表（按层级顺序，含所有非 PASS 的判定） */
  readonly triggeredGuards: ReadonlyArray<Readonly<GuardVerdict>>;
  /** 第一个 DENY 的护栏（无 DENY 时为 null） */
  readonly firstDenial: Readonly<GuardVerdict> | null;
  /** 执行耗时（毫秒，用于性能监控 NFR-7） */
  readonly durationMs: number;
  /** 全部已执行的护栏判定（含 PASS，按层级顺序，用于审计） */
  readonly allVerdicts: ReadonlyArray<Readonly<GuardVerdict>>;
}

/**
 * 护栏触发记录（持久化到 events.jsonl）
 *
 * 对齐架构师审查 §4.2 GuardRecord 接口。
 */
export interface GuardRecord {
  /** 触发时间戳（ISO 8601） */
  readonly triggeredAt: string;
  /** 规则 ID */
  readonly ruleId: GuardRuleId;
  /** 严重性 */
  readonly severity: GuardSeverity;
  /** 决策 */
  readonly decision: GuardDecision;
  /** 拦截原因 */
  readonly reason: string;
  /** 当前迭代号 */
  readonly iterIndex: number;
  /** 当前阶段 */
  readonly stage: "plan" | "dev" | "verify" | "fix";
  /** 当前 Loop 类型 */
  readonly loopType: "design" | "coding" | "testing" | "deploy";
}

// ============================================================================
// 4. 错误类型
// ============================================================================

/**
 * 守护链违规错误
 *
 * 当 BlockerGuardChain 检测到 BLOCKER 触发时抛出此错误，
 * 调用方（如 AutonomousOrchestrator）应捕获此错误并触发回滚 + 写 events.jsonl。
 *
 * 错误信息包含：
 * - ruleId：触发的规则 ID
 * - layer：所属层级
 * - reason：拦截原因
 * - verdict：完整判定结果
 */
export class GuardViolationError extends Error {
  /**
   * @param verdict 触发 BLOCKER 的判定结果
   * @param layer 所属层级
   */
  constructor(
    public readonly verdict: Readonly<GuardVerdict>,
    public readonly layer: GuardLayer
  ) {
    super(
      `守护链 BLOCKER 违规 [${verdict.ruleId}] 层级 ${layer}：${verdict.reason}（建议动作：${verdict.suggestedAction}）`
    );
    this.name = "GuardViolationError";
    // 保持原型链（TypeScript 编译到 ES5 时需要）
    Object.setPrototypeOf(this, GuardViolationError.prototype);
  }
}

// ============================================================================
// 5. 工厂函数（不可变优先，Object.freeze 冻结返回值）
// ============================================================================

/**
 * 创建 PASS 判定结果
 *
 * @param timestamp 时间戳（可选，缺省取当前时间）
 * @returns 冻结的 GuardVerdict（decision=PASS，ruleId 为空字符串）
 */
export function createPassVerdict(timestamp?: string): Readonly<GuardVerdict> {
  return Object.freeze({
    decision: "PASS" as const,
    ruleId: "" as const,
    severity: "" as const,
    reason: "",
    suggestedAction: "",
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

/**
 * 创建 DENY 判定结果
 *
 * @param ruleId 触发的规则 ID
 * @param severity 严重性（应为 BLOCKER）
 * @param reason 拦截原因
 * @param suggestedAction 建议动作
 * @param timestamp 时间戳（可选，缺省取当前时间）
 * @returns 冻结的 GuardVerdict（decision=DENY）
 */
export function createDenyVerdict(
  ruleId: GuardRuleId,
  severity: GuardSeverity,
  reason: string,
  suggestedAction: string,
  timestamp?: string
): Readonly<GuardVerdict> {
  return Object.freeze({
    decision: "DENY" as const,
    ruleId,
    severity,
    reason,
    suggestedAction,
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

/**
 * 创建 ASK 判定结果
 *
 * @param ruleId 触发的规则 ID
 * @param severity 严重性（BLOCKER 或 MAJOR）
 * @param reason 拦截原因
 * @param suggestedAction 建议动作
 * @param timestamp 时间戳（可选，缺省取当前时间）
 * @returns 冻结的 GuardVerdict（decision=ASK）
 */
export function createAskVerdict(
  ruleId: GuardRuleId,
  severity: GuardSeverity,
  reason: string,
  suggestedAction: string,
  timestamp?: string
): Readonly<GuardVerdict> {
  return Object.freeze({
    decision: "ASK" as const,
    ruleId,
    severity,
    reason,
    suggestedAction,
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

// ============================================================================
// 6. 常量（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * 6 层守护链执行顺序
 *
 * 对齐架构师审查 §6 守护链架构图：A-1 → A-2 → A-3 → A-4 → A-5 → A-6。
 * 任一层 BLOCKER 触发即短路中止，不再执行后续层。
 */
export const GUARD_LAYER_ORDER: ReadonlyArray<GuardLayer> = Object.freeze(["A-1", "A-2", "A-3", "A-4", "A-5", "A-6"]);

/**
 * 15 条 BLOCKER + 1 条 MAJOR 规则 ID 全集（用于校验与遍历）
 *
 * 对齐需求文档 §11 速查表。
 * 注意 G-A6c 为 MAJOR 级，不计入 15 条 BLOCKER。
 */
export const ALL_GUARD_RULE_IDS: ReadonlyArray<GuardRuleId> = Object.freeze([
  "G-A1a",
  "G-A1b",
  "G-A1c",
  "G-A2a",
  "G-A2b",
  "G-A2c",
  "G-A3a",
  "G-A3b",
  "G-A4a",
  "G-A4b",
  "G-A5a",
  "G-A5b",
  "G-A6a",
  "G-A6b",
  "G-A6d",
  "G-A6c", // MAJOR 级
]);

/**
 * 规则 ID → 层级映射表
 *
 * 用于快速查询规则所属层级。
 */
export const RULE_TO_LAYER: Readonly<Record<GuardRuleId, GuardLayer>> = Object.freeze({
  "G-A1a": "A-1",
  "G-A1b": "A-1",
  "G-A1c": "A-1",
  "G-A2a": "A-2",
  "G-A2b": "A-2",
  "G-A2c": "A-2",
  "G-A3a": "A-3",
  "G-A3b": "A-3",
  "G-A4a": "A-4",
  "G-A4b": "A-4",
  "G-A5a": "A-5",
  "G-A5b": "A-5",
  "G-A6a": "A-6",
  "G-A6b": "A-6",
  "G-A6d": "A-6",
  "G-A6c": "A-6",
});

/**
 * 规则 ID → 严重性映射表
 *
 * 对齐需求文档 §11 速查表，G-A6c 为 MAJOR 级，其余 15 条均为 BLOCKER。
 */
export const RULE_TO_SEVERITY: Readonly<Record<GuardRuleId, GuardSeverity>> = Object.freeze({
  "G-A1a": "BLOCKER",
  "G-A1b": "BLOCKER",
  "G-A1c": "BLOCKER",
  "G-A2a": "BLOCKER",
  "G-A2b": "BLOCKER",
  "G-A2c": "BLOCKER",
  "G-A3a": "BLOCKER",
  "G-A3b": "BLOCKER",
  "G-A4a": "BLOCKER",
  "G-A4b": "BLOCKER",
  "G-A5a": "BLOCKER",
  "G-A5b": "BLOCKER",
  "G-A6a": "BLOCKER",
  "G-A6b": "BLOCKER",
  "G-A6d": "BLOCKER",
  "G-A6c": "MAJOR",
});
