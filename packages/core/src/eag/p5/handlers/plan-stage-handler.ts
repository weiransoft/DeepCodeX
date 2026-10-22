/**
 * EAG-P5 Phase 5.2 PlanStageHandler（TASK-P5-1.2-004）
 *
 * 本模块实现 `P5PlanStageHandler` 类，是 AutonomousOrchestrator 4 阶段循环
 * 的 plan 阶段处理器，负责"从 tasks.md 取下一任务卡 + G-A3a 范围锁预检"。
 *
 * 核心职责（对齐架构师审查 §3.1.3 + §4.1）：
 * 1. 读取 <projectRoot>/.eag/p5/tasks.md 文件（markdown 格式）
 * 2. 解析任务卡列表（每张卡含 id/title/requirement/status/dependencies/files/acceptance）
 * 3. 挑选下一张 pending 任务卡（依赖已满足 + status=pending）
 * 4. 调用 guardChain.execute() 做 G-A3a 范围锁预检（确保任务卡声明的文件在范围内）
 * 5. 返回任务卡信息作为 artifacts（供 dev/verify/fix 阶段消费）
 *
 * 关键技术决策：
 * - 任务卡格式：标准 markdown（## 标题 + 列表项），LLM 可直接消费
 * - 解析器：基于正则的逐行扫描（零新增依赖，不引入 gray-matter 等）
 * - 状态宽容读入：done / doing 等人工别名经 normalizeTaskCardStatus 归一化；
 *   完全未知状态告警后按 pending 处理（修复 2026-10-05 僵尸任务卡事故——
 *   done 被静默降级 pending 导致旧卡永不被视为已完成）
 * - 范围锁预检：调用 ScopeLockGuard 检查 declaredFiles 是否在任务卡声明范围内
 * - 无任务可执行时返回 success + artifacts.taskCard=null（Orchestrator 据此判断完成）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/p5/handlers/plan-stage-handler
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { P5StageContext, P5StageHandler, P5StageResult } from "./types";
import { buildGuardContext, createSuccessStageResult, createFailedStageResult, toGuardRecords } from "./types";
import type { TaskCard } from "../guards/types";
import { atomicWriteTextFile } from "../common/atomic-file";
import { readForeignActiveLeaseTaskIds } from "../task-lease";
// 领域专家匹配器集成：plan 阶段为任务卡匹配最合适的领域专家（可选增强）
// 注：DomainExpertMatchResult 类型定义在 team/types.ts，需从正确路径导入
import type { DomainExpertMatchResult } from "../../../team/types.js";
import { DomainExpertMatcher } from "../../../team/domain-expert-matcher";
import { DomainExpertRegistry } from "../../../team/domain-expert-registry";
import { registerAllExperts } from "../../../team/domain-experts/index";
// GuardCoordinator 集成：plan 阶段接入 team/cybernetics 守护协调器（可选增强）
import { GuardCoordinator } from "../../../team/cybernetics/guard-coordinator";
import type { ValidationResult } from "../../../team/cybernetics/guard-coordinator";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 任务卡标题正则：匹配 "## T-XXX 标题文本"
 *
 * 捕获组 1 = 任务 ID（如 T-001）
 * 捕获组 2 = 任务标题（如 "实现 refund() 方法"）
 */
const TASK_CARD_HEADER_RE = /^##\s+(T-\d+)\s+(.+)$/;

/**
 * 任务卡属性行正则：匹配 "- key: value"
 *
 * 捕获组 1 = 属性名（如 requirement/status/dependencies/files/acceptance）
 * 捕获组 2 = 属性值（字符串或数组）
 */
const TASK_CARD_PROPERTY_RE = /^-\s+([a-zA-Z_]+)\s*:\s*(.+)$/;

/**
 * 默认 tasks.md 文件名
 */
const DEFAULT_TASKS_FILENAME = "tasks.md" as const;

/**
 * plan 阶段结果原因码（方案 A §3.2/§3.6，架构师 P2-4：字面量提为常量，
 * 供 orchestrator 5d 完成判定精确分支，避免散落字符串比较）。
 */
/** tasks.md 不存在且 objective 为空：无可执行任务（5d 判 failed） */
export const PLAN_REASON_TASKS_FILE_NOT_FOUND = "tasks-file-not-found" as const;
/** tasks.md 存在但解析不到任何任务卡（5d 判 failed） */
export const PLAN_REASON_NO_TASK_CARDS = "no-task-cards" as const;
// 注：合成任务卡落盘后仍走统一选卡流程，选中卡 reason 恒为 task-card-selected，
// "本轮卡来自 objective 合成"这一事实由 artifacts.synthesized 布尔标志承载，
// 故不设独立的 objective-synthesized reason（曾预留该常量，无消费方，已移除）。
/** 清单内任务全部 completed（5d 仅在此 reason 且本轮无失败时才允许判 completed） */
export const PLAN_REASON_ALL_TASKS_COMPLETED = "all-tasks-completed" as const;
/** 存在未完成任务，但没有依赖已满足的 pending 卡（blocked/in-progress/依赖不满足，5d 判 failed） */
export const PLAN_REASON_TASKS_BLOCKED = "tasks-blocked" as const;
/** 正常选中一张可执行任务卡 */
export const PLAN_REASON_TASK_CARD_SELECTED = "task-card-selected" as const;
/**
 * LLM 规划器判定停止运行（2026-10-09 F-A2 新增）。
 *
 * plan 阶段动态规划返回 action=stop（或 replan 后无可执行卡）时，plan 以
 * success + taskCard=null + 本 reason 返回，走既有 5b-6.5 提前结束 +
 * 5d 判定路径（failed，不假完成）。
 */
export const PLAN_REASON_PLANNER_STOP = "planner-stop" as const;
/**
 * 能力预检拒绝 reason 码（历史保留：修复"能力/目标错配烧轮"2026-10-03）。
 * 同日用户决策开放 bash 后 plan 不再产生该 reason（fatal 拦截已移除）；
 * 保留导出仅为兼容外部对历史 RunState 制品的 reason 判别，勿新增消费方。
 */
export const PLAN_REASON_CAPABILITY_GAP = "capability-gap" as const;

/** 合成任务卡标题最大字符数（防止超长 objective 撑爆单行标题） */
const MAX_SYNTHESIZED_TITLE_CHARS = 200;

/**
 * 3.5 AUTO 卡语义守卫单轮拦截上限（2026-10-08 T-009/T-010 事故修复新增）。
 *
 * 有界循环每轮拦截一张无关 AUTO 旧卡（blocked 落盘 + 必要时追加合成卡）。
 * 正常场景 1-2 轮收敛（第一轮 blocked 旧卡并追加合成卡，第二轮新卡
 * titleEmbedded 命中即 break）。上限只防御"每张新选中卡都无关且每轮都能
 * 成功落盘"的病态清单，超限交给循环后的诚实兜底 fail-closed，
 * 绝不让守卫循环无界空转，也绝不静默放行错卡进 dev。
 */
const GUARD_MAX_ROUNDS = 10;

// ============================================================================
// 1.1 LLM 动态规划常量（2026-10-09 F-A2，docs/dev/eag-p5-llm-dynamic-planning.md）
// ============================================================================

/** 规划简报中 notesSnapshot 的截断长度（跨轮笔记可能很长，只保留近期要点） */
const PLANNER_NOTES_MAX_CHARS = 4000;

/** 规划简报中前序阶段摘要的截断长度 */
const PLANNER_PREV_RESULTS_MAX_CHARS = 2000;

/** 跨 run 失败记忆文本的截断长度 */
const PREVIOUS_RUN_CONTEXT_MAX_CHARS = 1500;

/** replan 决策允许的最大任务条目数（防御模型输出超长列表撑爆 tasks.md） */
const PLANNER_REPLAN_MAX_TASKS = 20;

/**
 * 读取跨 run 失败记忆（2026-10-09 F-A3）。
 *
 * 扫描 `<projectRoot>/.eag/p5/run-state/*.jsonl`，取同项目且 runId 不同于
 * 当前运行的最近一个**终态** run（status≠running）的末行快照，渲染为紧凑
 * 文本供规划简报与 artifacts 消费。磁盘是唯一事实源：上一轮为什么 aborted、
 * 烧了多少 token，全部来自真实 RunState 落盘，不虚构。
 *
 * @param projectRoot 项目根目录绝对路径
 * @param currentRunId 当前运行 runId（排除自身，避免读到本 run 的中间态）
 * @returns 记忆文本（无历史 run / 读取失败时为空串，绝不虚构）
 */
export function loadPreviousRunContext(projectRoot: string, currentRunId: string): string {
  const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
  let files: string[] = [];
  try {
    files = fs.readdirSync(runStateDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // 目录不存在（首次运行）或不可读 → 无历史记忆，空串兜底
    return "";
  }

  // 收集每个历史 run 的末行快照（末行 = 最终状态；中间行是过程快照）
  interface PreviousRunSnapshot {
    readonly runId: string;
    readonly updatedAt: string;
    readonly status: string;
    readonly currentStage: string;
    readonly totalTokensUsed: number;
    readonly totalLlmCallCount: number;
    readonly consecutiveFailures: number;
    /** 终止原因（aborted/failed 时非空，是"上一轮为什么失败"的核心记忆） */
    readonly abortReason: string;
  }
  const snapshots: PreviousRunSnapshot[] = [];
  for (const file of files) {
    const runId = file.replace(/\.jsonl$/, "");
    if (runId.length === 0 || runId === currentRunId) {
      continue;
    }
    try {
      const content = fs.readFileSync(path.join(runStateDir, file), "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        continue;
      }
      const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      const status = typeof last["status"] === "string" ? last["status"] : "";
      // 只取终态 run：running 的中间态（可能来自其他进行中的会话）不构成"失败记忆"
      if (status.length === 0 || status === "running") {
        continue;
      }
      snapshots.push({
        runId,
        updatedAt: typeof last["updatedAt"] === "string" ? last["updatedAt"] : "",
        status,
        currentStage: typeof last["currentStage"] === "string" ? last["currentStage"] : "",
        totalTokensUsed: typeof last["totalTokensUsed"] === "number" ? last["totalTokensUsed"] : 0,
        totalLlmCallCount: typeof last["totalLlmCallCount"] === "number" ? last["totalLlmCallCount"] : 0,
        consecutiveFailures: typeof last["consecutiveFailures"] === "number" ? last["consecutiveFailures"] : 0,
        abortReason: typeof last["abortReason"] === "string" ? last["abortReason"] : "",
      });
    } catch {
      // 单个文件损坏/不可读 → 跳过该文件，不影响其他历史 run
      continue;
    }
  }
  if (snapshots.length === 0) {
    return "";
  }
  // 按 updatedAt 降序取最近一次（ISO 8601 字符串字典序即时间序）
  snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const prev = snapshots[0]!;
  // 终止原因只在非空时拼接（completed 等正常终态无 abortReason）
  const abortReasonPart = prev.abortReason.length > 0 ? `，终止原因：${prev.abortReason}` : "";
  const text =
    `上一轮 run ${prev.runId} 于 ${prev.updatedAt} 以 ${prev.status} 终止` +
    `（最后活动阶段 ${prev.currentStage}，消耗 ${prev.totalTokensUsed} tokens / ` +
    `${prev.totalLlmCallCount} 次 LLM 请求，连续失败 ${prev.consecutiveFailures}${abortReasonPart}）。` +
    `若上一轮为 aborted/failed，请勿机械重跑同一张卡：优先分析失败原因、` +
    `换思路分解任务，或在不可行时输出 stop。`;
  return text.length > PREVIOUS_RUN_CONTEXT_MAX_CHARS ? text.slice(0, PREVIOUS_RUN_CONTEXT_MAX_CHARS) : text;
}

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * 解析后的任务卡（内部结构，比 TaskCard 接口更宽松，用于解析阶段）
 *
 * 解析完成后会转换为标准 TaskCard 接口。
 * 所有字段 readonly，符合不可变优先原则（NFR-8）。
 */
interface ParsedTaskCard {
  readonly id: string;
  readonly title: string;
  readonly requirementId: string;
  readonly status: "pending" | "in-progress" | "completed" | "blocked";
  readonly dependencies: ReadonlyArray<string>;
  readonly declaredFiles: ReadonlyArray<string>;
  readonly declaredDeletions: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly declaredSymbols: ReadonlyArray<string>;
}

/**
 * 解析过程中的可变任务卡结构（仅用于 parseTaskCards 解析阶段）
 *
 * 通过映射类型 `-readonly` 移除 ParsedTaskCard 的所有 readonly 修饰符，
 * 使解析器在逐行扫描时可以重新赋值字段。解析完成后通过 finalizeParsedCard
 * 转换为不可变的 ParsedTaskCard（Object.freeze 冻结）。
 *
 * 设计说明：
 * - 字段类型保持一致（如 ReadonlyArray<string> 不变），仅去除 readonly 修饰符
 * - 仅作为 Partial<> 使用，表示字段可能尚未填充
 * - 不导出，仅在本模块内部使用
 */
type MutableParsedTaskCard = {
  -readonly [K in keyof ParsedTaskCard]: ParsedTaskCard[K];
};

// ============================================================================
// 3. P5PlanStageHandler 类
// ============================================================================

/**
 * Plan 阶段处理器
 *
 * 设计原则（对齐 Karpathy Simplicity First）：
 *   1. 单一职责：仅负责"取下一任务卡 + 范围锁预检"
 *   2. 真实文件 I/O：使用 fs.readFileSync 读取 tasks.md（不模拟）
 *   3. 护栏先行：调用 guardChain.execute() 做范围锁预检后再返回任务卡
 *   4. 不可变产出：返回的 P5StageResult 为冻结对象
 *
 * 使用方式：
 * ```typescript
 * const handler = new P5PlanStageHandler();
 * const result = await handler.handle(ctx);
 * if (result.kind === "success") {
 *   const taskCard = result.artifacts["taskCard"] as TaskCard | null;
 *   if (taskCard === null) {
 *     // 无任务可执行，Orchestrator 据此判断完成
 *   }
 * }
 * ```
 */

// ============================================================================
// 3. 领域专家匹配器惰性初始化（模块级单例）
// ============================================================================

/**
 * 惰性初始化的领域专家匹配器（模块级单例，跨多次 handle 调用复用）
 *
 * 设计依据：DomainExpertRegistry 需要异步加载 30 个专家文件（8 个类别），
 * 每次 handle 调用都重新加载会严重影响性能。
 * 使用模块级单例 + Promise 缓存，确保只加载一次，并发 handle 调用复用同一 Promise。
 *
 * 降级策略（Ponytail R-02：必须显式错误处理）：
 * - 领域专家加载失败（如文件缺失/解析异常）→ 返回 null
 * - plan 阶段主流程不受影响（领域专家匹配是增强能力，非必需）
 *
 * 线程安全：Node.js 单线程事件循环，Promise 缓存模式无竞态条件
 */
let cachedMatcher: DomainExpertMatcher | null = null;
let matcherInitPromise: Promise<DomainExpertMatcher | null> | null = null;

/**
 * 获取领域专家匹配器单例（惰性初始化 + 并发安全）
 *
 * @returns DomainExpertMatcher 实例，加载失败时返回 null
 */
async function getDomainExpertMatcher(): Promise<DomainExpertMatcher | null> {
  // 已缓存 → 直接返回（快速路径）
  if (cachedMatcher !== null) return cachedMatcher;
  // 正在加载 → 等待已有 Promise（避免并发重复加载）
  if (matcherInitPromise !== null) return matcherInitPromise;
  // 首次加载 → 创建 Promise 并缓存
  matcherInitPromise = (async () => {
    try {
      const registry = new DomainExpertRegistry();
      // 并行加载 8 个类别共 30 个领域专家文件
      await registerAllExperts(registry);
      cachedMatcher = new DomainExpertMatcher(registry);
      return cachedMatcher;
    } catch {
      // 领域专家加载失败时降级，返回 null（不影响 plan 阶段主流程）
      return null;
    }
  })();
  return matcherInitPromise;
}

// ============================================================================
// 4. GuardCoordinator 惰性初始化（模块级单例）
// ============================================================================

/**
 * 惰性初始化的 GuardCoordinator 实例（模块级单例）
 *
 * 设计依据：team/cybernetics/guard-coordinator.ts 的 GuardCoordinator 提供
 * 执行前验证（preExecuteValidation）、实时监控（monitorExecution）、执行后审查
 * （postExecuteReview）三阶段守护协调能力。
 * plan 阶段在 guardChain.execute() PASS 后调用 preExecuteValidation，
 * 进行基于 Karpathy 4 原则的预验证（占位代码/投机代码/空假设等检测）。
 *
 * 降级策略（Ponytail R-02：必须显式错误处理）：
 * - GuardCoordinator 初始化失败 → 返回 null，plan 阶段主流程不受影响
 * - preExecuteValidation 调用失败 → 降级，不影响 plan 阶段主流程
 *
 * AI 增强：ai_provider 不提供时使用降级模式（无 AI 增强风险评估，
 * 仅依赖预置的 Karpathy 4 原则规则库）
 */
let cachedGuardCoordinator: GuardCoordinator | null = null;

/**
 * 获取 GuardCoordinator 单例（惰性初始化）
 *
 * @returns GuardCoordinator 实例，初始化失败时返回 null
 */
function getGuardCoordinator(): GuardCoordinator | null {
  // 已缓存 → 直接返回（快速路径）
  if (cachedGuardCoordinator !== null) return cachedGuardCoordinator;
  // 首次初始化 → 创建实例并缓存
  try {
    cachedGuardCoordinator = new GuardCoordinator({
      agent_id: "eag-p5-plan-stage",
      // ai_provider 不提供，使用降级模式（仅依赖预置规则库，无 AI 增强风险评估）
    });
    return cachedGuardCoordinator;
  } catch {
    // GuardCoordinator 初始化失败时降级，返回 null（不影响 plan 阶段主流程）
    return null;
  }
}

export class P5PlanStageHandler implements P5StageHandler {
  /**
   * 执行 plan 阶段处理
   *
   * 完整时序：
   * 1. 读取 tasks.md 文件（若不存在则返回 success + taskCard=null）
   * 2. 解析任务卡列表
   * 3. 挑选下一张 pending 任务卡（依赖已满足）
   * 4. 构造 GuardContext 并调用 guardChain.execute() 做范围锁预检
   * 5. 若护栏 DENY → 返回 fatal（BLOCKER 触发，中止迭代）
   * 6. 若护栏 ASK → 返回 failed（需用户确认）
   * 7. 若护栏 PASS → 返回 success + 任务卡信息
   *
   * @param ctx 阶段执行上下文
   * @returns 阶段执行结果
   */
  async handle(ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>> {
    const startTime = Date.now();
    // 本轮是否由 objective 合成了任务卡（合成状态需透传到选中卡 artifacts，
    // 供 verify 阶段收窄"无测试目标 → 诚实 skip"判定）
    let synthesized = false;

    try {
      // 1. 读取 tasks.md 文件
      const tasksFilePath = ctx.tasksFilePath || path.join(ctx.projectRoot, ".eag", "p5", DEFAULT_TASKS_FILENAME);
      if (!fs.existsSync(tasksFilePath)) {
        // 方案 A §3.2：文件不存在时，objective 非空则真实合成单卡任务清单并原子落盘，
        // 让 objective 首次被消费；objective 为空才维持"无任务"结果（5d 新语义判 failed）。
        const objective = typeof ctx.objective === "string" ? ctx.objective.trim() : "";
        if (objective.length === 0) {
          return createSuccessStageResult(
            "plan",
            `tasks.md 不存在（${tasksFilePath}）且 objective 为空，无任务可执行`,
            { taskCard: null, tasksFilePath, reason: PLAN_REASON_TASKS_FILE_NOT_FOUND },
            [],
            0,
            Date.now() - startTime
          );
        }

        try {
          // 能力 fatal 预检已随执行器开放 bash 而移除（2026-10-03 用户决策）：
          // objective 命中安装/远程/容器/服务/数据库语义时不再拒绝——执行器现在
          // 有 bash 工具可真实执行此类任务（高危命令由人工确认闸门兜底）。
          const synthesizedContent = buildSynthesizedTasksContent(objective, generateSynthesizedTaskId([]));
          // 原子落盘（同目录 tmp + rename），随后与手写清单走完全相同的"回读→解析"闭环
          atomicWriteTextFile(tasksFilePath, synthesizedContent);
          synthesized = true;
        } catch (writeError) {
          // 合成落盘失败属真实 I/O 故障：判 fatal，绝不回退到"空转成功"
          const message = writeError instanceof Error ? writeError.message : String(writeError);
          return createFailedStageResult(
            "plan",
            "fatal",
            "合成任务清单写入失败",
            `无法写入 ${tasksFilePath}：${message}`,
            { tasksFilePath, reason: "synthesis-write-failed" },
            [],
            0,
            Date.now() - startTime
          );
        }
      }

      const tasksContent = fs.readFileSync(tasksFilePath, "utf8");

      // 2. 解析任务卡列表（解析告警经 logger 进入运行日志，修复事故：非法状态静默降级）
      const parseWarnings: string[] = [];
      const pushParseWarning = (msg: string): void => {
        parseWarnings.push(msg);
        ctx.logger?.(`plan 解析告警：${msg}`, "warn");
      };
      let taskCards = parseTaskCards(tasksContent, pushParseWarning);

      // 2.1 空清单 + 非空 objective → 合成卡消费目标（与"tasks.md 不存在"分支的
      // 合成语义对齐：空文件与缺文件在"目标必须被消费"这一点上语义相同）
      const objectiveForEmpty = typeof ctx.objective === "string" ? ctx.objective.trim() : "";
      if (taskCards.length === 0 && objectiveForEmpty.length > 0) {
        try {
          atomicWriteTextFile(
            tasksFilePath,
            buildSynthesizedTasksContent(objectiveForEmpty, generateSynthesizedTaskId([]))
          );
          synthesized = true;
          ctx.logger?.(`plan 空清单合成：tasks.md 无任务卡，已按目标合成 T-001 落盘 ${tasksFilePath}`, "warn");
        } catch {
          // 落盘失败：维持"无任务卡"结果（5d 判 failed），不伪造成功
        }
        taskCards = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"), pushParseWarning);
      }

      if (taskCards.length === 0) {
        // 无任务卡 → 返回 success + taskCard=null（5d 对 NO_TASK_CARDS 判 failed，不再误报完成）
        return createSuccessStageResult(
          "plan",
          `tasks.md 无任务卡（${tasksFilePath}），无任务可执行`,
          { taskCard: null, tasksFilePath, reason: PLAN_REASON_NO_TASK_CARDS, totalCards: 0, parseWarnings },
          [],
          0,
          Date.now() - startTime
        );
      }

      // R3（2026-10-20 并发死锁修复，run 68acea2de182）：其他存活 run 声明为
      // 在途的任务卡集合（租约 mtime < TTL，读 .eag/p5/leases/*.json）。blocked
      // 落盘在本地规则下是单向门（pickNextPendingTask 只认 pending，无解锁通道），
      // 把并发 run 正在 dev 的卡在途期 blocked 会把对方推进永久死锁。消费方：
      // 3.5 AUTO 守卫 blocked 前避让、LLM replan 合并 blocked 改写避让。
      const foreignInFlight = readForeignActiveLeaseTaskIds(ctx.projectRoot, ctx.runId);

      // 3. 挑选下一张 pending 任务卡（依赖已满足）
      //    selectedCards/completedIds 为可变工作集：3.4 stale-state 守卫追加
      //    合成卡后会被替换为重新解析结果；taskCards 保持只读冻结不被篡改。
      let selectedCards: ReadonlyArray<ParsedTaskCard> = taskCards;
      const completedIds = new Set<string>(taskCards.filter((c) => c.status === "completed").map((c) => c.id));
      let nextTask = pickNextPendingTask(selectedCards, completedIds);

      // 3.4 stale-state 守卫（修复 2026-10-05 僵尸任务卡死循环事故）：
      // objective 非空且与现存**所有**任务卡文本零/弱相关时，说明本目录的
      // tasks.md 大概率是历史遗留清单（事故中 10-04 的"继续——已完成"卡与
      // 新目标"bio-backend 注册信息接收 API"完全无关）。旧行为"文件存在即
      // 复用"让新目标永远不被消费——无论旧卡是 pending（反复选中僵尸卡）
      // 还是全部 completed/blocked（被 5d 误判 all-tasks-completed 提前收尾）。
      // 新行为：自动把 objective 合成为新任务卡追加到清单尾部（原内容原样
      // 保留、旧 pending 卡不丢），再重新解析：
      // - 旧卡有 pending：追加后 pickNextPendingTask 按 ID 升序仍先消费旧卡；
      // - 旧卡全 completed/blocked：新合成卡直接成为本轮待执行卡。
      //
      // 触发时机必须在"无可执行 pending 卡"判定**之前**：若等到 nextTask 为
      // null 才检查，全部旧卡已完成的僵尸清单会先命中 all-tasks-completed
      // 直接收尾（5d 据此宣告运行完成），新目标依旧永不被追加执行。
      {
        const objectiveText = typeof ctx.objective === "string" ? ctx.objective.trim() : "";
        // 本轮卡已由 objective 合成（synthesized=true）时跳过守卫，避免自反触发
        if (objectiveText.length > 0 && !synthesized) {
          const cardTexts = taskCards.map((c) => `${c.title} ${c.requirementId}`);
          const relevance = computeObjectiveRelevance(objectiveText, cardTexts);
          // 双向包含快判（与僵尸完成守卫同构）：手写卡标题本身就是目标
          // （前缀/子串）时，卡与目标必然同义，无论文本长短都直接视为相关。
          // 否则短目标（如"运行测试任务 1"）对长卡标题（"测试任务 1"）的
          // Jaccard/min 归一比例会因目标侧词集滑窗膨胀而被稀释误判为无关
          // （Z8 事故复盘：误合成第二张 AUTO 卡导致 dev 重复执行、熔断器永不触发）。
          const titleEmbedded = taskCards.some(
            (c) => c.title.length > 0 && (objectiveText.includes(c.title) || c.title.includes(objectiveText))
          );
          if (!titleEmbedded && relevance < OBJECTIVE_RELEVANCE_MIN_RATIO) {
            // 防重复追加的"合成卡识别"必须同时满足：① T-001 标题是 objective 的
            // 前缀/子串（标题由 objective 截断而来，见 buildSynthesizedTasksContent）；
            // ② requirement 为 AUTO 合成标记。否则人工手写、标题恰好是 objective
            // 子串的旧卡（如 objective"重构支付模块并补测试"、旧卡"重构支付模块"）
            // 会被误判为已合成，导致新目标永远不被追加。
            const alreadySynthesized = taskCards.some(
              (c) => c.requirementId === "AUTO" && c.title.length > 0 && objectiveText.includes(c.title)
            );
            // 注：不得用 `tasksContent.includes("## T-001 ")` 做文件级判重——
            // 合成卡沿用 T-001 编号（见 Z5 用例"旧卡 done 不改号"），手写清单
            // 首张卡标题必然命中该子串，会把所有手写卡误判为"已合成"，
            // 导致守卫永不追加（2026-10-05 守卫时序修复时纠正）。
            if (!alreadySynthesized) {
              try {
                // 去首尾空白（含事故遗留 BOM）后补单个换行：与文件原有单换行结尾约定一致，
                // 保证追加后合成卡标题前恰好一个空行（原尾部 `/\s*$/` 贪婪剥除会把空行一并吃掉）
                const appended = `${tasksContent.replace(/\s+$/, "")}\n\n${buildSynthesizedTasksContent(objectiveText, generateSynthesizedTaskId(taskCards))}`;
                atomicWriteTextFile(tasksFilePath, appended);
                synthesized = true;
                ctx.logger?.(
                  `plan 目标相关性守卫：objective 与现存任务卡相关性过低` +
                    `（${(relevance * 100).toFixed(0)}% < ${(OBJECTIVE_RELEVANCE_MIN_RATIO * 100).toFixed(0)}%），` +
                    `已把目标合成为新任务卡追加到 ${tasksFilePath}`,
                  "warn"
                );
                // 重新解析（与首次解析同一闭环），新合成卡进入候选
                const reparsed = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"), (msg) => {
                  parseWarnings.push(msg);
                  ctx.logger?.(`plan 解析告警：${msg}`, "warn");
                });
                const reparsedCompletedIds = new Set<string>(
                  reparsed.filter((c) => c.status === "completed").map((c) => c.id)
                );
                const reparsedNext = pickNextPendingTask(reparsed, reparsedCompletedIds);
                if (reparsedNext !== null) {
                  selectedCards = reparsed;
                  completedIds.clear();
                  for (const id of reparsedCompletedIds) {
                    completedIds.add(id);
                  }
                  nextTask = reparsedNext;
                }
              } catch (appendError) {
                // 追加失败不阻断本轮（旧行为：继续用现存卡）；告警留痕供诊断
                const message = appendError instanceof Error ? appendError.message : String(appendError);
                ctx.logger?.(`plan 目标相关性守卫：合成新任务卡追加失败（${message}），本轮沿用现存任务卡`, "warn");
              }
            }
          }
        }
      }

      // 3.5 AUTO 卡语义相关性选后守卫（2026-10-07 新增，同日修复"内存态未落盘"空循环回归）：
      // pickNextPendingTask 只按 ID 升序取第一张 pending 卡，不检查目标相关性。
      // 3.4 守卫在"所有卡"层面追加新卡，但如果旧 AUTO 卡 prefix 更小（T-001 vs T-002），
      // pickNextPendingTask 仍先取旧卡——这是 3.4 守卫未覆盖的"旧 pending 卡抢先"路径。
      // 修复：取到 AUTO 卡（requirementId==="AUTO"）后，检查它与当前 objective 是否语义相关。
      // 不相关时：旧 AUTO 卡 status 真实写回 blocked + 新合成卡追加落盘（与 3.4 同构落盘），
      // 再从磁盘回读重解析。绝不走"内存态 patched"——曾因未落盘导致下一轮重读磁盘时
      // 旧卡仍 pending、守卫每轮重触发，形成空循环回归（2026-10-07 review 根因 1）。
      // 手写卡（requirementId≠AUTO）不做拦截——用户手写的卡必然有意，不应覆盖。
      // 注意：这里不能被 3.4 的 synthesized 标志跳过——3.4 追加新卡后
      // pickNextPendingTask 仍按 ID 升序选中旧 AUTO 卡（抢先路径恰恰发生在这里）；
      // 是否重复追加由下方 alreadySynthesized 判定决定。
      if (nextTask !== null) {
        const objectiveText = typeof ctx.objective === "string" ? ctx.objective.trim() : "";
        // 守卫落盘失败原因（若有）——供循环后的诚实兜底构造错误信息
        let guardWriteError: string | null = null;
        // foreignInFlight 已在选卡后统一定义（replan 合并共用），见 3.3 注释块
        // 因"他 run 在途"而放弃拦截的卡（供 fail-closed 兜底给出诚实成因）
        let leaseSkippedCard: string | null = null;
        // 有界拦截循环（2026-10-08 T-009/T-010 事故修复）：旧实现单发拦截后不复查
        // 新选中卡——落盘成功但下一张仍是无关 AUTO 旧卡时直接放行 dev 执行错卡。
        // 每轮：选中无关 AUTO 卡 → blocked 落盘 +（必要时）追加合成卡 → 回读重选卡。
        // 新合成卡 title=objective 截断 → titleEmbedded 命中 → break（正常 1-2 轮收敛）；
        // 手写卡/相关卡/判空立即 break；最多 GUARD_MAX_ROUNDS 轮后交给下方诚实兜底。
        for (let guardRound = 0; guardRound < GUARD_MAX_ROUNDS; guardRound += 1) {
          if (nextTask === null) break;
          const selectedIsAuto = nextTask.requirementId === "AUTO";
          if (!selectedIsAuto || objectiveText.length === 0) break;
          const titleEmbedded =
            nextTask.title.length > 0 &&
            (objectiveText.includes(nextTask.title) || nextTask.title.includes(objectiveText));
          const singleCardRelevance = computeObjectiveRelevance(objectiveText, [
            `${nextTask.title} ${nextTask.requirementId}`,
          ]);
          if (titleEmbedded || singleCardRelevance >= OBJECTIVE_RELEVANCE_MIN_RATIO) break;
          // R3 避让：该卡是其他存活 run 的在途执行卡——不得 blocked（对方正在
          // 执行，blocked 落盘 = 对方下一轮 plan 直接判死）。本轮放弃拦截，
          // 交由下方 fail-closed 兜底以"他 run 在途"的诚实口径收口。
          if (foreignInFlight.has(nextTask.id)) {
            leaseSkippedCard = nextTask.id;
            ctx.logger?.(
              `plan AUTO 卡语义守卫：${nextTask.id} 与 objective 无关，但该卡是其他存活 run 的在途执行卡` +
                `（租约避让，2026-10-20 并发死锁修复），本 run 不做 blocked 拦截`,
              "warn"
            );
            // E2E 增强（2026-10-21）：在途卡不可拦截 ≠ 本 run 无事可做——清单中
            // 可能存在本 run 可执行的其他卡（3.4 刚追加的本目标合成卡 / 历史未消费
            // 的相关卡）。排除全部他 run 在途卡后选下一张继续（纯内存选择，磁盘
            // 不碰对方卡），两 run 各执行各的卡并行推进；无备选时落入下方
            // fail-closed（诚实"对方在途，本 run 无法开工"收口）。
            // 注意必须从磁盘重读（E2E 双并发验证发现）：selectedCards 是进入
            // handler 时的旧快照，不含 3.4 守卫刚追加的本目标合成卡——旧快照
            // 选择会让避让路径永远看不到 3.4 的新卡，B run 被确定性熔断冤杀。
            // 与拦截循环的 reparsed 更新同构：selectedCards/completedIds 同步到
            // 磁盘最新态（磁盘是唯一事实源，含 3.4 刚追加的本 run 合成卡）
            const latestCards: ParsedTaskCard[] = [];
            let altNext: ParsedTaskCard | null = null;
            try {
              const reparsedLatest = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"));
              latestCards.push(...reparsedLatest);
              altNext = pickNextPendingTask(
                latestCards.filter((c) => !foreignInFlight.has(c.id)),
                new Set(latestCards.filter((c) => c.status === "completed").map((c) => c.id))
              );
            } catch {
              altNext = null; // 重读失败按无备选处理，落入 fail-closed
            }
            const latestForState: ParsedTaskCard[] = latestCards;
            if (altNext !== null) {
              ctx.logger?.(
                `plan AUTO 卡语义守卫：排除他 run 在途卡后为本 run 选中备选卡 ${altNext.id}「${altNext.title}」` +
                  `继续执行（并发不互扰）`,
                "warn"
              );
              selectedCards = latestForState;
              completedIds.clear();
              for (const c of latestForState) {
                if (c.status === "completed") completedIds.add(c.id);
              }
              nextTask = altNext;
              continue;
            }
            // 无备选（E2E 双并发验证发现的第二处冤杀）：排除外来在途卡后本 run
            // 视野已无 pending 卡——典型是本 run 目标卡已全部消费完，只剩他 run
            // 在途的无关卡。此时把外来卡从本 run 视野剔除（不 blocked、不执行、
            // 不计入统计），nextTask 置空交由下游 allCompleted/TASKS_BLOCKED 按
            // 本地卡真实状态诚实收尾。若不剔除，"目标已完成"的 run 会因外来卡
            // 避让 fail-closed 被确定性熔断冤杀（正确终态应为 completed）。
            const foreignFreeCards = latestForState.filter((c) => !foreignInFlight.has(c.id));
            selectedCards = foreignFreeCards;
            completedIds.clear();
            for (const c of foreignFreeCards) {
              if (c.status === "completed") completedIds.add(c.id);
            }
            nextTask = null;
            break;
          }
          ctx.logger?.(
            `plan AUTO 卡语义无关守卫：${nextTask.id}「${nextTask.title}」与 objective「${objectiveText}」` +
              `相关性 ${singleCardRelevance.toFixed(2)} < 阈值 ${OBJECTIVE_RELEVANCE_MIN_RATIO.toFixed(2)}，` +
              `旧卡 blocked 落盘并追加新合成卡`,
            "warn"
          );
          try {
            // 从磁盘重读最新内容：3.4 守卫可能已在上面追加过合成卡，tasksContent 变量是旧快照，
            // 直接用会丢掉 3.4 刚写入的卡
            const currentTasksContent = fs.readFileSync(tasksFilePath, "utf8");
            // 防重复追加判定（与 3.4 的 alreadySynthesized 同构）：3.4 可能刚把同一目标
            // 合成为 AUTO 卡（title=objective 截断）。此时 3.5 只需把旧卡 blocked，
            // 不得再追加同目标卡——否则同一目标落两张重复卡，浪费一轮执行。
            // 注意：必须用磁盘最新内容重新解析（taskCards 变量是进入 handler 时的旧快照，
            // 不含 3.4 刚追加的卡），否则判重失效、重复追加（N1/N2 回归测试发现）。
            const currentCards = parseTaskCards(currentTasksContent);
            const alreadySynthesized = currentCards.some(
              (c) => c.requirementId === "AUTO" && c.title.length > 0 && objectiveText.includes(c.title)
            );
            // 旧 AUTO 卡 status 真实改写为 blocked（内存文本）——blocked 落盘是关键：
            // 不落盘则下一轮重读磁盘时旧卡仍 pending，守卫每轮重触发
            const blockedContent = markTaskCardStatusInContent(currentTasksContent, nextTask.id, "blocked");
            const contentToWrite = alreadySynthesized
              ? blockedContent
              : `${blockedContent.replace(/\s+$/, "")}\n\n` +
                `${buildSynthesizedTasksContent(objectiveText, generateSynthesizedTaskId(taskCards))}`;
            atomicWriteTextFile(tasksFilePath, contentToWrite);
            synthesized = true;
            ctx.logger?.(
              `plan AUTO 卡语义守卫：${nextTask.id} 已 blocked 落盘` +
                `（新目标消费卡：${alreadySynthesized ? "复用 3.4 已合成的同目标卡，未重复追加" : "已追加新合成卡"}）→ ${tasksFilePath}`,
              "warn"
            );
            // 与首次解析同一闭环回读重解析（磁盘是唯一事实源）：
            // 新合成卡 title=objective 截断 → titleEmbedded 命中 → 下一轮不会再触发本守卫
            const reparsed = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"), (msg) => {
              parseWarnings.push(msg);
              ctx.logger?.(`plan 解析告警：${msg}`, "warn");
            });
            const reparsedCompletedIds = new Set<string>(
              reparsed.filter((c) => c.status === "completed").map((c) => c.id)
            );
            const reparsedNext = pickNextPendingTask(reparsed, reparsedCompletedIds);
            if (reparsedNext !== null) {
              selectedCards = reparsed;
              completedIds.clear();
              for (const id of reparsedCompletedIds) {
                completedIds.add(id);
              }
              nextTask = reparsedNext;
            } else {
              // reparsedNext 为 null（新卡也被 dependencies 挡住等）→ 显式判空，
              // 由下游"无可执行卡"路径透出诊断。旧实现"维持 nextTask 不变"会把
              // 刚被 blocked 落盘的旧卡继续送入 dev 执行（内存态与磁盘态分裂）。
              nextTask = null;
            }
          } catch (appendError) {
            // 落盘失败不再"沿用旧卡"（2026-10-08 T-009/T-010 事故修复）：失败原因
            // 记录后交由下方 fail-closed 兜底处理——沿用旧卡会让 dev 执行错卡且
            // synthesized=true 的 summary 谎报"已从目标合成并选取任务卡：<旧卡标题>"
            const message = appendError instanceof Error ? appendError.message : String(appendError);
            guardWriteError = message;
            ctx.logger?.(`plan AUTO 卡语义守卫：blocked 落盘/追加失败（${message}），交由 fail-closed 兜底`, "warn");
            break;
          }
        }
        // 诚实兜底（2026-10-08 T-009/T-010 事故修复）：有界循环后选中卡仍是与目标
        // 无关的 AUTO 卡（落盘失败、或无关旧卡数超过拦截上限），绝不能继续放行 dev
        // 执行错卡并输出误导性 summary——fail-closed 判 plan failed，错误信息指向
        // tasks.md 供人工介入。旧实现兜底是"静默沿用旧卡"，run 4923fdc21e5b 据此
        // 谎报"已从目标合成并选取任务卡：T-009 继续"并烧掉一轮 40 次 LLM 请求。
        if (nextTask !== null && objectiveText.length > 0 && nextTask.requirementId === "AUTO") {
          const finalTitleEmbedded =
            nextTask.title.length > 0 &&
            (objectiveText.includes(nextTask.title) || nextTask.title.includes(objectiveText));
          const finalRelevance = computeObjectiveRelevance(objectiveText, [
            `${nextTask.title} ${nextTask.requirementId}`,
          ]);
          if (!finalTitleEmbedded && finalRelevance < OBJECTIVE_RELEVANCE_MIN_RATIO) {
            const cause =
              leaseSkippedCard !== null
                ? `该卡为其他存活 run 的在途执行卡（租约避让），本 run 无法安全拦截替换，请等待对方完成或清理其租约`
                : guardWriteError !== null
                  ? `tasks.md 写入失败（${guardWriteError}）`
                  : `无关旧 AUTO 卡数量超过单轮拦截上限（${GUARD_MAX_ROUNDS} 轮）`;
            ctx.logger?.(
              `plan AUTO 卡语义守卫：${nextTask.id} 与 objective 仍未消除无关性（${cause}），fail-closed 避免错卡执行`,
              "error"
            );
            return createFailedStageResult(
              "plan",
              "failed",
              `任务卡 ${nextTask.id}「${nextTask.title}」与当前目标语义无关且守卫无法纠正（${cause}），中止以避免执行错误任务`,
              `objective「${objectiveText}」与卡「${nextTask.title}」相关性 ${finalRelevance.toFixed(2)}` +
                ` < 阈值 ${OBJECTIVE_RELEVANCE_MIN_RATIO}；守卫无法落盘合成卡替代。` +
                `请检查 ${tasksFilePath} 的可写性与内容，必要时手工清理过期的 pending AUTO 卡后重试`,
              {
                taskCardId: nextTask.id,
                reason: "auto-card-relevance-unresolvable",
                relevance: finalRelevance,
                guardWriteError,
              },
              [],
              0,
              Date.now() - startTime
            );
          }
        }
      }

      // F-A2b（2026-10-09 页面端到端复测发现）：无可执行卡（全部 blocked/依赖
      // 不满足/in-progress 残留）时不再提前 return——那正是跨 run 恢复最需要
      // LLM 动态规划的场景（本地规则永远解不开 blocked，LLM 可以 replan 解锁
      // AUTO 卡或诚实判 stop）。先把阻塞结果暂存，3.7 规划器执行后若仍未选出
      // 可执行卡再返回（保持诊断信息与 planner 审计完整）。
      let blockedResult: P5StageResult | null = null;

      if (nextTask === null) {
        // 方案 A §3.6：把旧的 all-tasks-done-or-blocked 拆成两种诚实语义。
        const completedCount = completedIds.size;
        const allCompleted = selectedCards.every((c) => c.status === "completed");
        // 僵尸 completed 守卫（修复 2026-10-05 事故第二轮空转）：
        // objective 与**全部**已完成卡零/弱相关时，"所有任务已完成"实为
        // 历史清单收尾假象——本轮目标从未被任何卡消费。不放行收尾，
        // 改为合成新卡消费本轮目标（与 3.4 守卫同一语义出口）。
        // 注意：allCompleted 时 3.4 守卫可能已追加过合成卡（synthesized=true），
        // 此时不重复追加，改判"无可执行卡"走下方阻塞路径透出诊断。
        if (allCompleted && !synthesized) {
          const objectiveText = typeof ctx.objective === "string" ? ctx.objective.trim() : "";
          if (objectiveText.length > 0) {
            const cardTexts = selectedCards.map((c) => `${c.title} ${c.requirementId}`);
            const relevance = computeObjectiveRelevance(objectiveText, cardTexts);
            // 双向包含快判（与 3.4 守卫同构）：卡标题与目标同义（互为前缀/子串）
            // 时视为真正的目标收尾，不触发僵尸合成。
            const titleEmbedded = selectedCards.some(
              (c) => c.title.length > 0 && (objectiveText.includes(c.title) || c.title.includes(objectiveText))
            );
            if (!titleEmbedded && relevance < OBJECTIVE_RELEVANCE_MIN_RATIO) {
              // 与 3.4 守卫同构：AUTO 合成标记 + objective 包含卡标题 双条件判
              // "已合成"，防止人工手写卡被误判；文件可能已被 3.4 之后的流程改动，
              // 以最新磁盘内容为准判重
              const freshContent = fs.readFileSync(tasksFilePath, "utf8");
              const freshCards = parseTaskCards(freshContent);
              const alreadySynthesized = freshCards.some(
                (c) => c.requirementId === "AUTO" && c.title.length > 0 && objectiveText.includes(c.title)
              );
              if (!alreadySynthesized) {
                try {
                  const appended = `${freshContent.replace(/\s+$/, "")}\n\n${buildSynthesizedTasksContent(objectiveText, generateSynthesizedTaskId(freshCards))}`;
                  atomicWriteTextFile(tasksFilePath, appended);
                  synthesized = true;
                  ctx.logger?.(
                    `plan 僵尸完成守卫：objective 与全部已完成卡相关性过低` +
                      `（${(relevance * 100).toFixed(0)}% < ${(OBJECTIVE_RELEVANCE_MIN_RATIO * 100).toFixed(0)}%），` +
                      `已把目标合成为新任务卡追加到 ${tasksFilePath}`,
                    "warn"
                  );
                  const reparsed = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"), (msg) => {
                    parseWarnings.push(msg);
                    ctx.logger?.(`plan 解析告警：${msg}`, "warn");
                  });
                  const reparsedCompletedIds = new Set<string>(
                    reparsed.filter((c) => c.status === "completed").map((c) => c.id)
                  );
                  const reparsedNext = pickNextPendingTask(reparsed, reparsedCompletedIds);
                  if (reparsedNext !== null) {
                    selectedCards = reparsed;
                    completedIds.clear();
                    for (const id of reparsedCompletedIds) {
                      completedIds.add(id);
                    }
                    nextTask = reparsedNext;
                  }
                } catch (appendError) {
                  const message = appendError instanceof Error ? appendError.message : String(appendError);
                  ctx.logger?.(`plan 僵尸完成守卫：合成新任务卡追加失败（${message}），按已完成收尾处理`, "warn");
                }
              }
            }
          }
        }

        if (nextTask === null) {
          if (allCompleted) {
            // 清单全部 completed：可能是真正收尾（5d 还要看本轮有无失败与终态守卫）
            return createSuccessStageResult(
              "plan",
              `所有任务已完成（completed=${completedCount}/${selectedCards.length}）`,
              {
                taskCard: null,
                tasksFilePath,
                reason: PLAN_REASON_ALL_TASKS_COMPLETED,
                totalCards: selectedCards.length,
                completedCards: completedCount,
              },
              [],
              0,
              Date.now() - startTime
            );
          }
        }

        // 3.6 AUTO 卡同目标重跑恢复守卫（2026-10-09 修复 run f2358227def5/5081a4c28cd7 死锁）：
        // 清单可能出现"标题与 objective 互含的 completed AUTO 卡"（历史运行把 dev
        // 中途失败的任务卡误标 completed、或用户对同一目标显式重跑），同时其余卡
        // 全部 blocked/依赖不满足 → pickNextPendingTask 返回 null → 本函数原本直接
        // 返回 TASKS_BLOCKED，同目标重跑幂等死锁（0 LLM / 0 秒 failed）。
        // 恢复语义：AUTO 卡由 objective 自动合成，"同目标重跑"的唯一合理解读是
        // 重新执行——把该卡真实写回 pending 落盘（与 3.5 守卫落盘同构，磁盘是
        // 唯一事实源）并回读重选。手写卡（requirementId≠AUTO）是人工完成事实，
        // 绝不重置。
        // 防运行内重入：本运行此前迭代的 plan 已真实选中过该卡（ctx.prevResults
        // 的 plan success artifacts.taskCard）时不重置——否则 iter0 完成 → iter1
        // 重置 → 反复执行同一卡烧穿 maxIterations。
        // fail-closed：落盘失败不伪造成功，维持 TASKS_BLOCKED 透出诊断信息。
        if (!synthesized) {
          const rerunObjective = typeof ctx.objective === "string" ? ctx.objective.trim() : "";
          if (rerunObjective.length > 0) {
            // 目标候选：completed + AUTO 合成标记 + 标题与 objective 互含（与 3.4
            // titleEmbedded 同口径——标题由 objective 截断而来，互含即同题）
            const rerunCandidate = selectedCards.find(
              (c) =>
                c.status === "completed" &&
                c.requirementId === "AUTO" &&
                c.title.length > 0 &&
                (rerunObjective.includes(c.title) || c.title.includes(rerunObjective))
            );
            // 防重入：本运行此前迭代已选过该卡 → 保持阻塞语义，不重置
            const alreadyRanThisRun =
              rerunCandidate !== undefined &&
              ctx.prevResults.some(
                (r) =>
                  r.stage === "plan" &&
                  r.kind === "success" &&
                  (r.artifacts["taskCard"] as TaskCard | null | undefined)?.id === rerunCandidate.id
              );
            if (rerunCandidate !== undefined && !alreadyRanThisRun) {
              try {
                // 以磁盘最新内容为基线改写（上方守卫可能已修改过文件）
                const freshContent = fs.readFileSync(tasksFilePath, "utf8");
                const resetContent = markTaskCardStatusInContent(freshContent, rerunCandidate.id, "pending");
                if (resetContent !== freshContent) {
                  atomicWriteTextFile(tasksFilePath, resetContent);
                  ctx.logger?.(
                    `plan 同目标重跑恢复：completed AUTO 卡 ${rerunCandidate.id}「${rerunCandidate.title}」` +
                      `已重置为 pending 落盘（同目标重跑语义）→ ${tasksFilePath}`,
                    "warn"
                  );
                  // 与首次解析同一闭环回读重解析（磁盘是唯一事实源）
                  const reparsed = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"), (msg) => {
                    parseWarnings.push(msg);
                    ctx.logger?.(`plan 解析告警：${msg}`, "warn");
                  });
                  const reparsedCompletedIds = new Set<string>(
                    reparsed.filter((c) => c.status === "completed").map((c) => c.id)
                  );
                  const reparsedNext = pickNextPendingTask(reparsed, reparsedCompletedIds);
                  if (reparsedNext !== null) {
                    selectedCards = reparsed;
                    completedIds.clear();
                    for (const id of reparsedCompletedIds) {
                      completedIds.add(id);
                    }
                    nextTask = reparsedNext;
                  }
                }
              } catch (resetError) {
                // 落盘失败不阻断收尾：维持 TASKS_BLOCKED 诚实透出诊断（不伪造成功）
                const message = resetError instanceof Error ? resetError.message : String(resetError);
                ctx.logger?.(
                  `plan 同目标重跑恢复：AUTO 卡 ${rerunCandidate.id} 重置落盘失败（${message}），维持任务阻塞语义`,
                  "warn"
                );
              }
            }
          }
        }

        // 3.6 恢复守卫可能已把 nextTask 从 null 恢复为可执行卡（同目标重跑语义），
        // blocked 返回必须重新判空——否则恢复出的卡会被无条件 TASKS_BLOCKED 吞掉，
        // 永远到不了下方第 4 步的护栏预检与 dev 执行（T-A5 回归测试发现的缺陷）。
        if (nextTask === null) {
          // 存在未完成任务却没有可执行 pending 卡：区分"显式 blocked / in-progress 残留"
          // 与"pending 但依赖未满足"，把任务 ID 与缺失依赖写入制品供最终报告诊断（P2-2）
          const blockedCardIds = selectedCards
            .filter((c) => c.status !== "completed" && c.status !== "pending")
            .map((c) => c.id);
          const waitingDependencies = selectedCards
            .filter((c) => c.status === "pending")
            .map((c) => ({
              id: c.id,
              missingDependencies: c.dependencies.filter((dep) => !completedIds.has(dep)),
            }))
            .filter((entry) => entry.missingDependencies.length > 0);
          // F-A2b：暂存阻塞结果（不提前 return），先给 3.7 规划器一个
          // replan 解锁 / stop 的机会；3.7 结束后仍未选出卡时再返回它
          blockedResult = createSuccessStageResult(
            "plan",
            `任务被阻塞（completed=${completedCount}/${selectedCards.length}，blocked=${blockedCardIds.length}，等待依赖=${waitingDependencies.length}）`,
            {
              taskCard: null,
              tasksFilePath,
              reason: PLAN_REASON_TASKS_BLOCKED,
              totalCards: selectedCards.length,
              completedCards: completedCount,
              blockedCardIds: Object.freeze(blockedCardIds),
              waitingDependencies: Object.freeze(waitingDependencies),
            },
            [],
            0,
            Date.now() - startTime
          );
        }
      }

      // 3.7 LLM 动态规划（2026-10-09 F-A2，架构师审查 P1-1 修正后的调用点）：
      // 全部本地守卫（2.1/3.4/3.5/3.6）已执行完毕、候选局面已定，此处调用执行器
      // 的 planIteration 做一次"无工具"LLM 规划调用，让模型基于"目标 + 卡清单 +
      // 跨 run 失败记忆 + 笔记 + 剩余预算"动态决定：选哪张卡（select）/
      // 重排 AUTO 卡集合（replan）/ 停止运行（stop）。规划失败/不可用 →
      // 保持本地选卡结果（行为与修复前一致，fail-open 但 warn 留痕）。
      const previousRunContext = loadPreviousRunContext(ctx.projectRoot, ctx.runId);
      let plannerTokensUsed = 0;
      let plannerAction = "skipped";
      let plannerReasoning = "";
      const planExecutor = ctx.taskExecutor ?? null;
      const planIterationFn = planExecutor?.planIteration;
      // 前置闸门：执行器无 planIteration 能力（旧宿主/测试替身）时跳过 LLM 规划。
      // 2026-10-20 R2b 修复（run 68acea2de182）：原实现以 perTaskBudget ≥ 3000
      // 作为闸门——而 perTaskBudget = max(0, 名义预算 - 已用) 在烧穿后归零，
      // 恰恰是"上一轮失败、最需要 replan 解锁 blocked"的时刻闸门被关死
      // （实测 iter1 plan 13ms 判死、0 次 LLM 调用）。规划请求是固定小请求
      // （PLANNER_MAX_TOKENS=2048 封顶），与运行级预算无耦合，闸门判据只保留
      // 能力检查；预算门槛由执行器侧 planIteration 的客户端与失败兜底承担。
      const plannerGateOpen = typeof planIterationFn === "function";
      if (plannerGateOpen) {
        // 可执行卡集合（与 pickNextPendingTask 同口径：pending + 依赖已满足），
        // select 决策只能从该集合选（架构师审查 P1-2 修正：防止选中依赖未满足的卡）
        const executableCards = selectedCards.filter(
          (c) => c.status === "pending" && c.dependencies.every((dep) => completedIds.has(dep))
        );
        // 卡清单总览：一行一卡，标注 requirement 来源与当前可执行性
        const tasksOverview = selectedCards
          .map((c) => {
            const executable = executableCards.some((e) => e.id === c.id);
            const deps = c.dependencies.length > 0 ? `，dependencies=[${c.dependencies.join(",")}]` : "";
            return `- ${c.id}「${c.title}」 status=${c.status} requirement=${c.requirementId}${deps}${executable ? " [可执行]" : ""}`;
          })
          .join("\n");
        // 本迭代前序阶段摘要（plan 是首个阶段时为空串）
        const prevStageSummaries =
          ctx.prevResults.length > 0
            ? ctx.prevResults
                .map((r) => `- ${r.stage}/${r.kind}：${r.summary.slice(0, 300)}`)
                .join("\n")
                .slice(0, PLANNER_PREV_RESULTS_MAX_CHARS)
            : "";
        try {
          const planResult = await planIterationFn.call(planExecutor, {
            projectRoot: ctx.projectRoot,
            runId: ctx.runId,
            iterIndex: ctx.iterIndex,
            objective: ctx.objective,
            tasksOverview,
            notesSnapshot: (ctx.notesSnapshot ?? "").slice(0, PLANNER_NOTES_MAX_CHARS),
            prevStageSummaries,
            previousRunContext,
            remainingTokenBudget: ctx.perTaskBudget ?? Number.MAX_SAFE_INTEGER,
            abortFlagPath: ctx.abortFlagPath ?? "",
            // 停止修复（2026-10-22）：宿主信号透传规划器（abort 时跳过规划请求）
            signal: ctx.signal,
          });
          // 规划调用的 token 消耗诚实计入 plan 阶段结果（此前 plan 恒 0）
          plannerTokensUsed = planResult.tokensUsed;
          if (!planResult.ok) {
            plannerAction = "failed";
            ctx.logger?.(`plan LLM 规划不可用，回退本地选卡：${planResult.error ?? "未知原因"}`, "warn");
          } else {
            plannerAction = planResult.action;
            plannerReasoning = planResult.reasoning;
            if (planResult.action === "stop") {
              // 规划器判定停止：走 5b-6.5 提前结束 + 5d 判定路径（failed，不假完成）
              ctx.logger?.(`plan LLM 规划判定停止：${planResult.reasoning}`, "warn");
              return createSuccessStageResult(
                "plan",
                `LLM 规划判定停止运行：${planResult.reasoning}`,
                {
                  taskCard: null,
                  tasksFilePath,
                  reason: PLAN_REASON_PLANNER_STOP,
                  plannerAction: "stop",
                  plannerReasoning: planResult.reasoning,
                  previousRunContext,
                  // 规划器单次请求审计：消耗了 token 即代表真实发起了 1 次 LLM 请求
                  llmRequests: plannerTokensUsed > 0 ? 1 : 0,
                },
                [],
                plannerTokensUsed,
                Date.now() - startTime
              );
            }
            if (planResult.action === "select") {
              const requested = planResult.taskId ?? "";
              const target = executableCards.find((c) => c.id === requested);
              if (target !== undefined) {
                // 合法 select：覆盖本地选卡（本地 pickNextPendingTask 的 ID 升序
                // 结果只是默认值，动态规划才是用户要求的决策来源）
                nextTask = target;
                ctx.logger?.(
                  `plan LLM 规划选卡：${target.id}「${target.title}」（理由：${planResult.reasoning}）`,
                  "info"
                );
              } else {
                plannerAction = "select-invalid";
                ctx.logger?.(`plan LLM 规划 select 非法（${requested} 不在可执行集合），回退本地选卡`, "warn");
              }
            } else if (planResult.action === "replan") {
              // replan 合并应用（架构师约束：只允许操作 requirement=AUTO 的卡；
              // completed 不允许由 LLM 设置——防假完成落盘；手写卡一律不动）
              const entries = (planResult.tasks ?? []).slice(0, PLANNER_REPLAN_MAX_TASKS);
              // 以磁盘最新内容为合并基线（上方守卫可能已修改过文件）
              let merged = fs.readFileSync(tasksFilePath, "utf8");
              for (const entry of entries) {
                if (entry.id !== undefined) {
                  const existing = selectedCards.find((c) => c.id === entry.id);
                  if (
                    existing !== undefined &&
                    existing.requirementId === "AUTO" &&
                    (entry.status === "pending" || entry.status === "blocked")
                  ) {
                    // R3 防御纵深（2026-10-20）：replan 同样不得把其他存活 run 的
                    // 在途卡改 blocked（租约避让，与 3.5 守卫同一事实源）
                    if (entry.status === "blocked" && foreignInFlight.has(entry.id)) {
                      ctx.logger?.(`plan replan：${entry.id} 为他 run 在途卡（租约避让），跳过 blocked 改写`, "warn");
                      continue;
                    }
                    merged = markTaskCardStatusInContent(merged, entry.id, entry.status);
                  }
                } else if (entry.title !== undefined && entry.title.trim().length > 0) {
                  // 追加新 AUTO 卡：编号由本地生成（防 LLM 撞号），标题单行截断
                  const newId = generateSynthesizedTaskId(parseTaskCards(merged));
                  merged =
                    `${merged.replace(/\s+$/, "")}\n\n` +
                    buildAutoTaskCardContent(entry.title.trim(), entry.dependencies ?? [], newId);
                }
              }
              try {
                atomicWriteTextFile(tasksFilePath, merged);
                // 与守卫同一闭环：回读重解析 + 本地 pickNextPendingTask 重选
                // （本地守门不变：LLM 只影响卡集合与状态，最终可执行性由本地判定）
                const reparsed = parseTaskCards(fs.readFileSync(tasksFilePath, "utf8"), (msg) => {
                  parseWarnings.push(msg);
                  ctx.logger?.(`plan 解析告警：${msg}`, "warn");
                });
                const reparsedCompletedIds = new Set<string>(
                  reparsed.filter((c) => c.status === "completed").map((c) => c.id)
                );
                const reparsedNext = pickNextPendingTask(reparsed, reparsedCompletedIds);
                if (reparsedNext !== null) {
                  selectedCards = reparsed;
                  completedIds.clear();
                  for (const id of reparsedCompletedIds) {
                    completedIds.add(id);
                  }
                  nextTask = reparsedNext;
                  ctx.logger?.(
                    `plan LLM 规划 replan 已落盘并重选 ${nextTask.id}「${nextTask.title}」（理由：${planResult.reasoning}）`,
                    "info"
                  );
                } else {
                  // replan 后无可执行卡 → 按规划器停止语义收尾（诚实透出理由）
                  ctx.logger?.(`plan LLM 规划 replan 后无可执行卡，按停止处理：${planResult.reasoning}`, "warn");
                  return createSuccessStageResult(
                    "plan",
                    `LLM 规划 replan 后无可执行卡：${planResult.reasoning}`,
                    {
                      taskCard: null,
                      tasksFilePath,
                      reason: PLAN_REASON_PLANNER_STOP,
                      plannerAction: "replan",
                      plannerReasoning: planResult.reasoning,
                      previousRunContext,
                      // 规划器单次请求审计：消耗了 token 即代表真实发起了 1 次 LLM 请求
                      llmRequests: plannerTokensUsed > 0 ? 1 : 0,
                    },
                    [],
                    plannerTokensUsed,
                    Date.now() - startTime
                  );
                }
              } catch (writeError) {
                // 落盘失败 fail-closed：维持本地选卡结果（不伪造 replan 成功）
                const message = writeError instanceof Error ? writeError.message : String(writeError);
                plannerAction = "replan-write-failed";
                ctx.logger?.(`plan LLM 规划 replan 落盘失败（${message}），回退本地选卡`, "warn");
              }
            }
            // action=none：不干预，保持本地选卡结果
          }
        } catch (plannerError) {
          // 规划调用异常（网络/中止等）→ 回退本地选卡，token 消耗仍诚实记录
          const message = plannerError instanceof Error ? plannerError.message : String(plannerError);
          plannerAction = "exception";
          ctx.logger?.(`plan LLM 规划异常，回退本地选卡：${message}`, "warn");
        }
      }

      // F-A2b 收尾：规划器执行后仍无可执行卡 → 返回暂存的阻塞结果。
      // 若规划器真实发起过请求（tokensUsed>0），tokensUsed 与 planner 审计
      // 字段诚实并入返回值（维持"消耗了 token 就必须记账"原则）。
      // 说明：nextTask===null 时 blockedResult 必然已由上方守卫块尾记录
      // （all-completed 合成、3.6 恢复、阻塞记录三出口覆盖），此处断言仅
      // 满足 TS 控制流分析；理论不可达分支兜底返回通用阻塞诊断。
      if (nextTask === null) {
        const blockedFallback =
          blockedResult ??
          createSuccessStageResult(
            "plan",
            `任务被阻塞（completed=${completedIds.size}/${selectedCards.length}）`,
            {
              taskCard: null,
              tasksFilePath,
              reason: PLAN_REASON_TASKS_BLOCKED,
              totalCards: selectedCards.length,
              completedCards: completedIds.size,
              blockedCardIds: Object.freeze(
                selectedCards.filter((c) => c.status !== "completed" && c.status !== "pending").map((c) => c.id)
              ),
              waitingDependencies: Object.freeze([]),
            },
            [],
            0,
            Date.now() - startTime
          );
        if (plannerTokensUsed > 0 || plannerAction !== "skipped") {
          return createSuccessStageResult(
            "plan",
            blockedFallback.summary,
            {
              ...blockedFallback.artifacts,
              plannerAction,
              plannerReasoning,
              previousRunContext,
              llmRequests: plannerTokensUsed > 0 ? 1 : 0,
            },
            [],
            plannerTokensUsed,
            Date.now() - startTime
          );
        }
        return blockedFallback;
      }

      // （3.5 任务卡级能力 fatal 预检已随执行器开放 bash 而移除，2026-10-03
      //  用户决策：docker/安装/服务类任务卡直接放行进 dev，由执行器 bash 真实
      //  执行；高危命令在执行器权限钩子处挂起等待人工确认。）

      // 4. 转换为标准 TaskCard 接口
      const taskCard: TaskCard = Object.freeze({
        id: nextTask.id,
        title: nextTask.title,
        requirementId: nextTask.requirementId,
        dependencies: Object.freeze([...nextTask.dependencies]),
        acceptanceCriteria: Object.freeze([...nextTask.acceptanceCriteria]),
        status: nextTask.status,
        declaredSymbols: Object.freeze([...nextTask.declaredSymbols]),
        declaredFiles: Object.freeze([...nextTask.declaredFiles]),
        declaredDeletions: Object.freeze([...nextTask.declaredDeletions]),
      });

      // 5. 构造 GuardContext 并调用 guardChain.execute() 做范围锁预检
      const guardContext = buildGuardContext(ctx, {
        currentTaskCard: taskCard,
        pendingReadFiles: Object.freeze([...nextTask.declaredFiles]),
      });

      const chainResult = await ctx.guardChain.execute(guardContext);
      const guardRecords = toGuardRecords(chainResult, ctx.iterIndex, "plan", ctx.loopType);

      // 6. 护栏 DENY → 返回 fatal（BLOCKER 触发，中止迭代）
      if (chainResult.overallDecision === "DENY") {
        const firstDenial = chainResult.firstDenial;
        return createFailedStageResult(
          "plan",
          "fatal",
          `范围锁预检被护栏拒绝（规则 ${firstDenial?.ruleId ?? "unknown"}）`,
          firstDenial?.reason ?? "未知原因",
          {
            taskCard,
            guardDecision: "DENY",
            guardRuleId: firstDenial?.ruleId ?? "",
            // 规划器单次请求审计（护栏拒绝不能抹掉真实请求记录）
            llmRequests: plannerTokensUsed > 0 ? 1 : 0,
          },
          guardRecords,
          // F-A2：规划调用已发生时 token 消耗诚实计入（护栏拒绝不能抹掉真实消耗）
          plannerTokensUsed,
          Date.now() - startTime
        );
      }

      // 7. 护栏 ASK → 返回 failed（需用户确认）
      if (chainResult.overallDecision === "ASK") {
        const firstAsk = chainResult.triggeredGuards.find((v) => v.decision === "ASK");
        return createFailedStageResult(
          "plan",
          "failed",
          `范围锁预检需用户确认（规则 ${firstAsk?.ruleId ?? "unknown"}）`,
          firstAsk?.reason ?? "需用户确认",
          {
            taskCard,
            guardDecision: "ASK",
            guardRuleId: firstAsk?.ruleId ?? "",
            // 规划器单次请求审计（待确认状态不能抹掉真实请求记录）
            llmRequests: plannerTokensUsed > 0 ? 1 : 0,
          },
          guardRecords,
          // F-A2：规划调用已发生时 token 消耗诚实计入（待确认状态不能抹掉真实消耗）
          plannerTokensUsed,
          Date.now() - startTime
        );
      }

      // 8. 领域专家匹配（可选增强，失败不影响主流程）
      // 为当前任务卡匹配最合适的领域专家，供 dev/verify/fix 阶段参考
      // 匹配维度：domainTag 40% / keyword 30% / capability 20% / skill 10%
      let domainExperts: ReadonlyArray<DomainExpertMatchResult> = [];
      try {
        const matcher = await getDomainExpertMatcher();
        if (matcher !== null) {
          // 使用任务卡标题和需求 ID 作为匹配输入
          domainExperts = matcher.matchExpertsSync(taskCard.title, taskCard.requirementId);
        }
      } catch {
        // 领域专家匹配失败时降级，不影响 plan 阶段主流程
      }

      // 9. GuardCoordinator 执行前验证（可选增强，失败不影响主流程）
      // 基于 Karpathy 4 原则的预验证：检测占位代码/投机代码/空假设等风险
      // 接入 team/cybernetics 守护协调器，与 EAG P5 的 6 层 BLOCKER 护栏形成双层防护
      let guardCoordinatorResult: ValidationResult | null = null;
      try {
        const coordinator = getGuardCoordinator();
        if (coordinator !== null) {
          // 构造验证上下文：任务卡信息 + 用户目标
          guardCoordinatorResult = await coordinator.preExecuteValidation({
            task_id: taskCard.id,
            task_title: taskCard.title,
            declared_files: [...taskCard.declaredFiles],
            objective: ctx.objective,
          });
        }
      } catch {
        // GuardCoordinator 验证失败时降级，不影响 plan 阶段主流程
      }

      // 10. 护栏 PASS → 返回 success + 任务卡信息 + 领域专家 + GuardCoordinator 验证结果
      return createSuccessStageResult(
        "plan",
        synthesized
          ? `已从目标合成并选取任务卡：${nextTask.id} ${nextTask.title}（范围锁预检通过）`
          : `选取下一任务卡：${nextTask.id} ${nextTask.title}（依赖已满足，范围锁预检通过）`,
        {
          taskCard,
          tasksFilePath,
          // 方案 A：精确 reason + synthesized 标志（verify/orchestrator 据此分流）
          reason: PLAN_REASON_TASK_CARD_SELECTED,
          synthesized,
          totalCards: selectedCards.length,
          completedCards: completedIds.size,
          pendingCards: selectedCards.length - completedIds.size,
          parseWarnings,
          guardDecision: "PASS",
          // F-A2 规划决策留痕（审计 + orchestrator 前端展示；skipped=未启用规划）
          plannerAction,
          plannerReasoning,
          // F-A3 跨 run 失败记忆透出（审计 + F-C dev 阶段失败反馈注入的数据源）
          previousRunContext,
          lastFailureFeedback: previousRunContext,
          // 规划器单次请求审计（orchestrator 据此累加 totalLlmCallCount）
          llmRequests: plannerTokensUsed > 0 ? 1 : 0,
          domainExperts, // 领域专家匹配结果（可选增强，供后续阶段参考）
          guardCoordinatorResult, // GuardCoordinator 执行前验证结果（可选增强）
        },
        guardRecords,
        // F-A2：规划调用真实消耗诚实计入（此前 plan 恒 0，导致 run 级预算虚高）
        plannerTokensUsed,
        Date.now() - startTime
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return createFailedStageResult(
        "plan",
        "fatal",
        `plan 阶段异常：${error.message}`,
        error.stack ?? error.message,
        {},
        [],
        0,
        Date.now() - startTime
      );
    }
  }
}

// ============================================================================
// 3.5 能力语义检测（原"能力预检 fatal 拒绝"，2026-10-03 bash 开放后降级为提示）
// ============================================================================

/**
 * 能力语义检测关键词表（识别需要 shell 命令执行的任务文本）。
 *
 * 语义：命中任一模式意味着任务完成的**必要步骤**需要执行命令
 * （安装软件 / 远程连接 / 容器操作 / 长驻服务 / 数据库变更）。
 *
 * 历史（修复"能力/目标错配烧轮"2026-10-03）：P5 执行器曾硬隔离无 bash，
 * 此类目标必败 → plan 阶段 fatal 拒绝。同日用户决策开放 bash 后，fatal
 * 拦截已移除（plan 不再消费本函数），当前唯一消费方为 LlmTaskExecutor
 * 的「能力提示」进度事件；破坏性命令的安全边界改由执行器
 * DANGEROUS_COMMAND_PATTERNS + 人工确认闸门承担。
 */
const CAPABILITY_GAP_PATTERNS: ReadonlyArray<Readonly<[RegExp, string]>> = Object.freeze([
  // 远程执行 / SSH（如"远程装 K3s CUDA""登录服务器部署"）。
  // "远程"后接词放宽为单字"做"形（装/部署/安装/执行/登录/连接/配置…），
  // 真实事故目标"远程装 K3s CUDA"中的"远程装"此前不命中枚举——漏检即白烧 36 次 LLM 调用。
  [/ssh|远程[装安执部登连配升更重启]?|跳板机|堡垒机|生产(服务|环?境)|线上(服务器|环境)/i, "远程执行（SSH/远程主机）"],
  // 软件安装 / 包管理（如"安装 CUDA""pip install""apt-get"）
  // 软件安装 / 包管理（如"安装 CUDA""装 K3s""pip install""apt-get"）。
  // 单字"装"须与上下文类别（容器/远程/系统/服务）同时出现才命中，
  // 防止"把逻辑装进适配器"之类纯编码表述误伤。
  [
    /安装|装(好|完)|install\b|pip\s+install|npm\s+(install|i)\b|apt(-get)?|yum\b|dnf\b|(装|部署)[^。;,，；]{0,12}(k3s|k8s|kubernetes|cuda|docker|服务|环境|中间件|mysql|redis)/i,
    "软件/包安装",
  ],
  // 容器与编排（如"拉镜像""部署 MySQL""kubectl apply"）
  [/docker|镜像|k3s|kubernetes|k8s|helm\b|podman/i, "容器/编排操作"],
  // 长驻服务与系统服务管理（如"启动 nginx""systemctl restart"）
  [/systemctl|service\s+(start|restart)|启动.*(服务|守护|中间件)|守护进程/i, "系统服务管理"],
  // 数据库初始化 / 迁移（需要数据库客户端连接执行）
  [/\bDDL\b|建库|建表|数据库初始化|数据初始化|初始化数据|迁移.*(执行|到库)|\bmigrate\b/i, "数据库变更执行"],
]);

/**
 * 能力提示检测结果（不再用于 fatal 拒绝，仅驱动执行器进度提示，2026-10-03）。
 */
export interface CapabilityPreflightResult {
  /** 目标/任务是否命中需要 shell 能力的语义 */
  readonly requiresShell: boolean;
  /** 命中的能力类别列表（去重后） */
  readonly capabilities: ReadonlyArray<string>;
}

/**
 * 对 objective + 任务卡文本做 shell 能力语义检测。
 *
 * 历史（修复"能力/目标错配烧轮"2026-10-03）：目标"远程装 K3s CUDA、部署
 * MySQL/Redis、拉镜像、初始化数据"曾被合成放行，dev 阶段执行器（当时无
 * bash）12 次 LLM 调用空转 ×3 轮才熔断 abort。当日用户决策开放 bash 后，
 * 本函数不再用于 fatal 拒绝，仅供 LlmTaskExecutor 在「思考过程」区提示
 * "任务将通过 bash 真实执行命令"。
 *
 * @param texts 待检测文本列表（objective、任务卡标题等）
 * @returns 检测结果（命中类别已去重）
 */
export function detectShellCapabilityGap(texts: ReadonlyArray<string>): CapabilityPreflightResult {
  const hits = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) {
      continue;
    }
    for (const [pattern, label] of CAPABILITY_GAP_PATTERNS) {
      if (pattern.test(text)) {
        hits.add(label);
      }
    }
  }
  return Object.freeze({
    requiresShell: hits.size > 0,
    capabilities: Object.freeze([...hits]),
  });
}

// ============================================================================
// 4. 任务卡解析器（基于正则的逐行扫描）
// ============================================================================

/**
 * 任务卡状态别名归一化映射表（修复 2026-10-05 僵尸任务卡死循环事故）。
 *
 * 背景：人工在 tasks.md 里把任务写成 `- status: done` 时，旧解析器白名单
 * 只认 pending / in-progress / completed / blocked 四个值，done 不在其中，
 * 被静默降级回默认值 pending——一张已完成的任务卡从此变成"永远 pending 的
 * 僵尸卡"，每轮 plan 都选中它 → dev 执行器拿到自相矛盾的任务描述 → bash
 * 盲目探索烧满 12 轮 → 失败 → 下轮再选同一张卡，直到连续失败 3 次才 abort。
 *
 * 归一化策略（宽容读入）：
 * - done / finished / complete / closed / 已完成 / 完成 → completed
 * - doing / ongoing / wip / 进行中 → in-progress
 * - 大小写不敏感（先 trim + toLowerCase 再查表；中文值不受 toLowerCase 影响）
 * - 输入已是大写规范值（pending 等）时映射表同样命中，行为与旧版一致
 * - 未知状态返回 null，由调用方决定降级策略（见 parseTaskCards 的 status 分支）
 *
 * @param raw 原始状态文本（已 trim）
 * @returns 归一化后的合法状态；无法识别（含空串）返回 null
 */
function normalizeTaskCardStatus(raw: string): ParsedTaskCard["status"] | null {
  switch (raw.trim().toLowerCase()) {
    case "pending":
    case "todo":
    case "待办":
    case "待执行":
      return "pending";
    case "in-progress":
    case "in_progress":
    case "doing":
    case "ongoing":
    case "wip":
    case "进行中":
      return "in-progress";
    case "completed":
    case "done":
    case "finished":
    case "complete":
    case "closed":
    case "已完成":
    case "完成":
      return "completed";
    case "blocked":
    case "阻塞":
      return "blocked";
    default:
      return null;
  }
}

/**
 * 解析 tasks.md 文件内容为任务卡列表
 *
 * 格式约定：
 * ```
 * ## T-001 实现 refund() 方法
 * - requirement: F-001
 * - status: pending
 * - dependencies: T-000
 * - files: src/services/OrderService.ts, src/services/RefundService.ts
 * - deletions: src/legacy/OrderService.ts
 * - symbols: OrderService.refund, RefundService
 * - acceptance: 退款金额正确, 退款状态更新
 *
 * ## T-002 添加单元测试
 * - requirement: F-002
 * ...
 * ```
 *
 * @param content tasks.md 文件内容
 * @param onWarning 可选告警回调：状态值无法归一化时以"卡 ID + 原始值 +
 *   降级策略"告警（修复 2026-10-05 僵尸任务卡事故：done 等非法状态被静默
 *   降级 pending，运维完全无感知）；未提供时静默保持向后兼容
 * @returns 任务卡列表（readonly）
 */
export function parseTaskCards(
  content: string,
  onWarning: (message: string) => void = () => {}
): ReadonlyArray<ParsedTaskCard> {
  const cards: ParsedTaskCard[] = [];
  const lines = content.split(/\r?\n/);

  // 使用可变类型作为解析中间态，逐行扫描时需重新赋值字段
  let currentCard: Partial<MutableParsedTaskCard> | null = null;

  for (const line of lines) {
    // 匹配任务卡标题行 "## T-XXX 标题"
    const headerMatch = TASK_CARD_HEADER_RE.exec(line);
    if (headerMatch) {
      // 保存上一张卡（若有）
      if (currentCard && currentCard.id) {
        cards.push(finalizeParsedCard(currentCard));
      }
      // 开始新卡片
      currentCard = {
        id: headerMatch[1]!,
        title: headerMatch[2]!.trim(),
        requirementId: "",
        status: "pending",
        dependencies: [],
        declaredFiles: [],
        declaredDeletions: [],
        acceptanceCriteria: [],
        declaredSymbols: [],
      };
      continue;
    }

    // 匹配属性行 "- key: value"
    const propMatch = TASK_CARD_PROPERTY_RE.exec(line);
    if (propMatch && currentCard) {
      const key = propMatch[1]!;
      const value = propMatch[2]!.trim();
      switch (key) {
        case "requirement":
          currentCard.requirementId = value;
          break;
        case "status": {
          // 宽容读入 + 显式告警（修复 2026-10-05 僵尸任务卡死循环事故）：
          // 1) done/doing/已完成 等人工书写别名经归一化映射为合法状态；
          // 2) 完全无法识别的值通过 onWarning 告警后按 pending 保守处理，
          //    绝不静默吞掉——旧实现直接把 done 降级成 pending，把人工已
          //    完成的卡变成永远选不掉的僵尸卡。
          const normalized = normalizeTaskCardStatus(value);
          if (normalized !== null) {
            currentCard.status = normalized;
          } else {
            // status 属性行先于标题行出现（畸形文件）时 id 尚未赋值，取默认占位
            onWarning(
              `任务卡 ${currentCard.id ?? "(未知)"} 的 status 值 "${value}" 无法识别` +
                `（合法值：pending / in-progress / completed / blocked 及 done、doing 等常见别名），` +
                `按 pending 处理——若该卡实际已完成，请改写为 completed 或 done`
            );
            currentCard.status = "pending";
          }
          break;
        }
        case "dependencies":
          currentCard.dependencies = parseStringList(value);
          break;
        case "files":
          currentCard.declaredFiles = parseStringList(value);
          break;
        case "deletions":
          currentCard.declaredDeletions = parseStringList(value);
          break;
        case "symbols":
          currentCard.declaredSymbols = parseStringList(value);
          break;
        case "acceptance":
          currentCard.acceptanceCriteria = parseStringList(value);
          break;
        default:
          // 未知属性忽略（前向兼容）
          break;
      }
    }
  }

  // 保存最后一张卡（若有）
  if (currentCard && currentCard.id) {
    cards.push(finalizeParsedCard(currentCard));
  }

  return Object.freeze(cards);
}

/**
 * 把 Partial<MutableParsedTaskCard> 转换为完整的 ParsedTaskCard（含默认值）
 *
 * 解析阶段的可变中间态在此处转换为不可变的 ParsedTaskCard，
 * 所有数组字段通过 Object.freeze 冻结，符合 NFR-8 不可变优先原则。
 *
 * @param card 部分填充的可变任务卡
 * @returns 完整的任务卡（readonly + Object.freeze）
 */
function finalizeParsedCard(card: Partial<MutableParsedTaskCard>): ParsedTaskCard {
  return Object.freeze({
    id: card.id ?? "",
    title: card.title ?? "",
    requirementId: card.requirementId ?? "",
    status: card.status ?? "pending",
    dependencies: Object.freeze([...(card.dependencies ?? [])]),
    declaredFiles: Object.freeze([...(card.declaredFiles ?? [])]),
    declaredDeletions: Object.freeze([...(card.declaredDeletions ?? [])]),
    acceptanceCriteria: Object.freeze([...(card.acceptanceCriteria ?? [])]),
    declaredSymbols: Object.freeze([...(card.declaredSymbols ?? [])]),
  });
}

/**
 * 解析字符串列表（逗号分隔，支持 [] 包裹）
 *
 * 输入范例：
 *   "T-001, T-002" → ["T-001", "T-002"]
 *   "[T-001, T-002]" → ["T-001", "T-002"]
 *   "" → []
 *
 * @param value 原始字符串
 * @returns 字符串数组（readonly）
 */
function parseStringList(value: string): ReadonlyArray<string> {
  if (!value) return [];
  // 去除 [] 包裹
  let trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    trimmed = trimmed.slice(1, -1);
  }
  if (!trimmed) return [];
  return Object.freeze(
    trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

// ============================================================================
// 5. 任务卡选取器
// ============================================================================

/**
 * 英文/技术 token：带字母的连续标识符（小写化后作为相关性词集元素）。
 *
 * 例："bio-backend API" → {"bio", "backend", "api"}；
 * docker / git / kubectl / 注册信息 等中文以外的技术词全部命中。
 */
const WORD_TOKEN_RE = /[A-Za-z][A-Za-z0-9_.+-]*/g;

/**
 * 中文词组提取的块切分正则：匹配连续汉字段（≥2 字）。
 *
 * 中文无空格分词，提取策略是"先按非汉字字符切出连续汉字块，块内再做
 * 2-4 字滑窗"（见 extractRelevanceTokens），滑窗绝不跨数字、标点、
 * 英文等非汉字边界："运行测试任务 1" 的"1"会把汉字段切成
 * "运行测试任务" 一块，滑窗只在块内滑动。
 * 滑窗会产出交叉重复片段，但 Jaccard 是对称度量，双方同样膨胀，不影响判定。
 */
const CJK_BLOCK_RE = /[\u4e00-\u9fff]{2,}/g;

/**
 * 目标相关性判定阈值（Jaccard 相似度系数）。
 *
 * 选中卡文本词集与 objective 词集的交集占两者较小者的比例 ≥ 0.3 视为相关；
 * 低于阈值说明 tasks.md 与本次目标大概率无关（stale-state，事故中 10-04 的
 * 僵尸卡与新目标 bio-backend API 零词重合），触发 objective 补充合成新卡。
 */
const OBJECTIVE_RELEVANCE_MIN_RATIO = 0.3;

/**
 * 提取文本的相关性词集（英文 token + 中文连续字块 + 字块内 2-4 字滑窗）。
 *
 * 中文分词策略说明（修复 2026-10-05 "运行测试任务 1" vs "测试任务 1"
 * 零重合误判）：CJK 滑窗**必须限定在连续汉字段内部**，不得跨数字、
 * 标点、英文等非汉字边界——否则"运行测试任务 1"中的滑窗"行测试"会
 * 跨越"运行/测试任务"的语义边界，与"测试任务 1"产生虚假匹配。
 * 块内滑窗保证候选词都是真实相邻子串；连续 ≥5 字的大块因同起点产生的
 * 长公共前缀（如 3 字窗口重合 ≥3 个），按 min 归一后占比可达阈值。
 *
 * @param text 输入文本（标题 / requirement / objective）
 * @returns 词集（Set<string>）
 */
function extractRelevanceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  if (typeof text !== "string" || text.length === 0) {
    return tokens;
  }
  for (const m of text.matchAll(WORD_TOKEN_RE)) {
    tokens.add(m[0]!.toLowerCase());
  }
  // 先按非汉字字符切出连续汉字块（CJK_BLOCK_RE），再在块内做 2-4 字滑窗（不跨块）
  for (const blockMatch of text.matchAll(CJK_BLOCK_RE)) {
    const block = blockMatch[0]!;
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= block.length; i += 1) {
        tokens.add(block.slice(i, i + len));
      }
    }
  }
  return tokens;
}

/**
 * 计算 objective 与一组任务卡文本的相关性比例。
 *
 * 语义：
 * - objective 词集为空（无法比较）→ 返回 1（视为相关，不触发补充合成）；
 * - 任务卡文本全空（纯合成卡等）→ 返回 0（视为不相关，新目标应重新合成）；
 * - 否则：对每张卡计算 Jaccard 比例（交集 / 较小词集），取所有卡的最大值，
 *   只要有一张卡与目标显著相关即视为清单相关。
 *
 * @param objective 用户目标文本
 * @param cardTexts 每张任务卡的文本（标题 + requirement 拼接）
 * @returns 相关性比例 ∈ [0, 1]
 */
export function computeObjectiveRelevance(objective: string, cardTexts: ReadonlyArray<string>): number {
  const objectiveTokens = extractRelevanceTokens(objective);
  if (objectiveTokens.size === 0) {
    return 1;
  }
  let bestRatio = 0;
  for (const cardText of cardTexts) {
    const cardTokens = extractRelevanceTokens(cardText);
    if (cardTokens.size === 0) {
      continue;
    }
    let intersection = 0;
    for (const token of cardTokens) {
      if (objectiveTokens.has(token)) {
        intersection += 1;
      }
    }
    const ratio = intersection / Math.min(objectiveTokens.size, cardTokens.size);
    if (ratio > bestRatio) {
      bestRatio = ratio;
    }
  }
  return bestRatio;
}

/**
 * 动态生成新合成卡的任务 ID：扫描现有最大 T-xxx 编号 +1。
 *
 * 解决"多卡共用固定 T-001 导致 pickNextPendingTask 永远取文件序第一张旧卡"的劫持问题
 * （docs/dev/eag-task-id-and-web-session-isolation.md §1.1）。
 * 空清单回退 T-001（与修复前行为一致）。
 *
 * @param cards 当前已解析的任务卡列表（可为空）
 * @returns 新合成卡的唯一 ID，格式 T-XXX（零填充 3 位；超 3 位时按实际位数输出）
 */
export function generateSynthesizedTaskId(cards: ReadonlyArray<ParsedTaskCard>): string {
  let maxNum = 0;
  for (const card of cards) {
    const match = card.id.match(/^T-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxNum) maxNum = num;
    }
  }
  const nextNum = maxNum + 1;
  // 零填充到 3 位（T-001 ~ T-999 足够日常使用）
  return nextNum < 100 ? `T-${String(nextNum).padStart(3, "0")}` : `T-${nextNum}`;
}

/**
 * 挑选下一张 pending 任务卡（依赖已满足）
 *
 * 选取规则：
 * 1. status === "pending"
 * 2. 所有 dependencies 都在 completedIds 中
 * 3. 按 id 升序取第一张（确保执行顺序稳定）
 *
 * @param cards 任务卡列表
 * @param completedIds 已完成的任务卡 ID 集合
 * @returns 下一张 pending 任务卡，若无则返回 null
 */
export function pickNextPendingTask(
  cards: ReadonlyArray<ParsedTaskCard>,
  completedIds: ReadonlySet<string>
): ParsedTaskCard | null {
  // 过滤出 pending 且依赖已满足的任务卡
  const candidates = cards.filter(
    (card) => card.status === "pending" && card.dependencies.every((dep) => completedIds.has(dep))
  );

  if (candidates.length === 0) {
    return null;
  }

  // 按 id 升序排序，取第一张（确保执行顺序稳定）
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  return sorted[0]!;
}

// ============================================================================
// 6. 工厂函数
// ============================================================================

/**
 * 从用户目标构造合成 tasks.md 内容（方案 A §3.2）。
 *
 * 合成清单为单卡 T-001，格式与 parseTaskCards 的解析正则严格兼容：
 * - 标题行 `## T-001 <单行目标>`；
 * - 空值属性行（dependencies/files/deletions/symbols/acceptance）故意写成 `- key:`
 *   （属性正则要求冒号后至少一个字符，空行不匹配 → 解析器取默认空数组，等价于"未声明"）；
 * - status=pending，requirement=AUTO 标记其来源为自动合成。
 *
 * @param objective 已 trim 的用户目标文本（非空）
 * @param taskId 新合成卡的唯一 ID（由 generateSynthesizedTaskId 生成，调用方保证唯一性）
 * @returns tasks.md 完整文本
 */
export function buildSynthesizedTasksContent(objective: string, taskId: string): string {
  // 标题必须单行：折叠所有换行/制表符为空格并压缩连续空白，超长截断
  const singleLineTitle = objective
    .replace(/\r?\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SYNTHESIZED_TITLE_CHARS);

  // ======== 合成卡复杂度守卫（2026-10-14 P1 修复"元任务整段下发"根因） ========
  // 历史痛点（run add68b75f656 T-025）：objective="完成后续修复+调查eag不执行Bug"
  // 被折叠成单行单卡 → 40 轮/200K 执行器根本跑不完 → 折叠续跑也跑不完 →
  // 死折叠 + 误报"工具循环达上限"。执行器 40 轮硬上限内不存在可达终态。
  //
  // 守卫策略（保守收敛，不破坏单卡返回契约）：
  // 1. 标题超长（>MAX_SYNTHESIZED_TITLE_CHARS 说明 objective 本身被截断了，
  //    有实质内容被吞掉）；且
  // 2. 含多个阶段标记动词（修复/调查/实现/完成/添加/移除/重构等任一 ≥2 次）；
  // → 在 acceptance 里把 objective 按句号/分号拆成多条 bullet point，
  //    给执行器模型明确的子任务边界（"要做 A、B、C 三件事，一件一件来"），
  //    同时追加一条说明提示"本卡目标较长，建议拆分为多张"。
  //
  // 不主动拆卡的原因：buildSynthesizedTasksContent 返回值被调用方当作
  // "完整 tasks.md 内容"消费，改成多张卡会破坏依赖方假设（parseTasks
  // 期待 AUTO 合成卡只有 T-001）。acceptance 拆条既安全又有效。
  const originalTrimmed = objective.trim();
  const titleTruncated = originalTrimmed.length > MAX_SYNTHESIZED_TITLE_CHARS;
  // 阶段标记动词（中文 + 英文都覆盖，按出现次数判多阶段）
  const PHASE_VERB_PATTERN =
    /(修复|调查|实现|完成|添加|移除|重构|开发|部署|测试|修|加|改|删|fix|investigate|implement|complete|add|remove|refactor|develop|deploy|test)/gi;
  const phaseVerbMatches = originalTrimmed.match(PHASE_VERB_PATTERN);
  const phaseVerbCount = phaseVerbMatches ? phaseVerbMatches.length : 0;
  const isComplexObjective = titleTruncated || phaseVerbCount >= 2;

  // acceptance 行：正常单卡留空；复杂目标追加拆条说明
  const acceptanceLine = isComplexObjective
    ? `- acceptance: ${buildComplexAcceptanceHint(originalTrimmed)}`
    : "- acceptance:";

  // 记录 warn（调用方可通过 ctx.logger 消费；此函数为纯函数，log 由调用方执行）
  // 注意：此函数是导出的纯工厂，不可引入 ctx.logger——warn 语义通过注释+acceptance 拆条承载
  if (titleTruncated || phaseVerbCount >= 3) {
    console.warn(
      `[EAG-P5] buildSynthesizedTasksContent：目标复杂度较高（长度 ${originalTrimmed.length}，` +
        `阶段动词 ${phaseVerbCount} 次），合成卡 ${taskId} 已追加 acceptance 拆条。` +
        `建议调用方考虑拆分为多张范围明确的任务卡。`
    );
  }

  return [
    "<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->",
    "",
    `## ${taskId} ${singleLineTitle}`,
    "- requirement: AUTO",
    "- status: pending",
    "- dependencies:",
    "- files:",
    "- deletions:",
    "- symbols:",
    acceptanceLine,
    "",
  ].join("\n");
}

/**
 * 为复杂目标构造 acceptance 拆条（辅助函数，2026-10-14 P1）。
 *
 * 把超长/多阶段 objective 按句号、分号、换行拆成多条 bullet point，
 * 给执行器明确子任务边界。每条截断到 120 字符（acceptance 单行不宜过长）。
 * 末尾追加一条提示，明确告知"本卡目标较长，建议一件一件完成"。
 *
 * @param objective 原始 objective 文本
 * @returns 以 "完成 [x]；[y]；[z]；注意：目标较长请一件一件推进" 格式拼接的单行 acceptance 值
 */
function buildComplexAcceptanceHint(objective: string): string {
  // 按句号、分号、问号、感叹号、换行、中文"然后"、"之后"拆
  const rawParts = objective
    .split(/[。！？!?;；\n\r]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // 每个片段截断到 120 字符（acceptance 行不宜过长，单行超限会让 markdown 解析器困惑）
  const truncated = rawParts.map((p) => (p.length > 120 ? p.slice(0, 120) + "..." : p));
  // 拼回单行：最多保留前 5 个片段（再长 acceptance 行就太臃肿了）
  const capped = truncated.slice(0, 5);
  const joined = capped.join("；");
  const suffix = "（本卡目标较长，含多个子阶段，请一件一件完成后再进入下一件——避免一次性打包在 40 轮内烧完而无终态）";
  return joined + suffix;
}

/**
 * 构造单张 AUTO 任务卡的 markdown 区段文本（2026-10-09 F-A2 replan 决策新增）。
 *
 * 背景：plan 阶段 LLM 规划器输出 replan 决策并要求新增任务卡时，新增卡由
 * 本地生成 AUTO 编号并追加到 tasks.md——本函数负责把一条 LLM 描述渲染成
 * 与 parseTaskCards 解析正则严格兼容的卡区段（与 buildSynthesizedTasksContent
 * 的单卡格式同构，但允许显式声明依赖）。
 *
 * 格式要点（与解析器约束对齐）：
 * - 标题必须单行：折叠换行/制表符为空格并压缩连续空白，超长截断（防跨区段注入）；
 * - `- requirement: AUTO` 标记来源为 LLM 动态规划（AUTO 卡语义守卫的判定依据）；
 * - `- dependencies: T-001, T-002` 逗号分隔（无依赖时冒号后留空，解析器取默认空数组）；
 * - status 固定 pending（completed 不允许由 LLM 设置——防假完成，见端口协议注释）。
 *
 * @param title 已 trim 的任务标题（调用方保证非空）
 * @param dependencies 依赖卡 ID 列表（可为空数组）
 * @param taskId 新卡的唯一 ID（由 generateSynthesizedTaskId 生成，调用方保证唯一性）
 * @returns 单张卡区段的 markdown 文本（以换行结尾，可直接拼接追加）
 */
export function buildAutoTaskCardContent(title: string, dependencies: ReadonlyArray<string>, taskId: string): string {
  // 标题单行化：折叠所有换行/制表符为空格并压缩连续空白，超长截断（与合成卡同规则）
  const singleLineTitle = title
    .replace(/\r?\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SYNTHESIZED_TITLE_CHARS);
  // 依赖行：无依赖时冒号后留空（解析器属性正则要求冒号后至少一个字符才命中，
  // 空行不匹配 → 取默认空数组，与 buildSynthesizedTasksContent 的空值行语义一致）
  const dependenciesLine = dependencies.length > 0 ? `- dependencies: ${dependencies.join(", ")}` : "- dependencies:";

  return [
    `## ${taskId} ${singleLineTitle}`,
    "- requirement: AUTO",
    "- status: pending",
    dependenciesLine,
    "- files:",
    "- deletions:",
    "- symbols:",
    "- acceptance:",
    "",
  ].join("\n");
}

/**
 * 在 tasks.md 文本中将指定任务卡的 status 行改写为 newState（仅改内存文本，落盘由调用方负责）。
 *
 * 2026-10-07 为 3.5 AUTO 卡语义守卫新增：守卫在拦截旧 AUTO 卡后需要把它的
 * status 真实写回为 blocked——若只在内存改状态而不落盘，下一轮 plan 从磁盘
 * 重新 parseTaskCards 时旧卡仍为 pending，守卫每轮重触发，形成空循环回归。
 *
 * 区段定位规则：
 * - 目标卡区段从 `## <taskId> ` 标题行开始；
 * - 到下一张卡的 `## ` 标题行或文件尾结束；
 * - 区段内第一条 `- status: <value>` 行被改写为 `- status: <newState>`。
 *
 * 兜底语义：若目标卡区段内没有 status 行（解析器默认按 pending 处理），
 * 则在标题行后插入一行 `- status: <newState>`——否则旧卡在磁盘上仍是
 * pending，守卫会永远重触发（空循环回归的根因之一）。
 *
 * @param content tasks.md 完整文本
 * @param taskId 目标任务卡 ID（如 "T-001"）
 * @param newState 新状态值（如 "blocked"）
 * @returns 改写后的 tasks.md 完整文本（未找到目标卡标题时原样返回）
 */
export function markTaskCardStatusInContent(content: string, taskId: string, newState: string): string {
  // taskId 进入正则前转义（防御手写清单中出现非常规 ID 字符）
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^##\\s+${escapedTaskId}(?=\\s|$)`);
  const statusLineRe = /^(\s*-\s*status:)\s*\S.*$/;
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let inTargetCard = false;
  let replaced = false;

  for (const line of lines) {
    if (headingRe.test(line)) {
      // 命中目标卡标题 → 进入其区段
      inTargetCard = true;
      output.push(line);
      continue;
    }
    if (inTargetCard && /^##\s/.test(line)) {
      // 进入下一张卡的区段 → 目标卡区段结束
      inTargetCard = false;
      output.push(line);
      continue;
    }
    if (inTargetCard && !replaced && statusLineRe.test(line)) {
      // 区段内第一条 status 行 → 改写状态
      replaced = true;
      output.push(line.replace(statusLineRe, `$1 ${newState}`));
      continue;
    }
    output.push(line);
  }

  // 兜底：目标卡区段没有任何 status 行 → 在标题行后插入一行，确保磁盘状态真实变更
  if (inTargetCard && !replaced) {
    const headingIndex = output.findIndex((l) => headingRe.test(l));
    output.splice(headingIndex + 1, 0, `- status: ${newState}`);
  }
  return output.join("\n");
}

/**
 * 工厂函数：创建默认 P5PlanStageHandler 实例
 *
 * @returns P5PlanStageHandler 实例
 */
export function createPlanStageHandler(): P5PlanStageHandler {
  return new P5PlanStageHandler();
}
