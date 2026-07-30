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

    try {
      // 1. 读取 tasks.md 文件
      const tasksFilePath = ctx.tasksFilePath || path.join(ctx.projectRoot, ".eag", "p5", DEFAULT_TASKS_FILENAME);
      if (!fs.existsSync(tasksFilePath)) {
        // tasks.md 不存在 → 无任务可执行，返回 success + taskCard=null
        return createSuccessStageResult(
          "plan",
          `tasks.md 不存在（${tasksFilePath}），无任务可执行`,
          { taskCard: null, tasksFilePath, reason: "tasks-file-not-found" },
          [],
          0,
          Date.now() - startTime
        );
      }

      const tasksContent = fs.readFileSync(tasksFilePath, "utf8");

      // 2. 解析任务卡列表
      const taskCards = parseTaskCards(tasksContent);
      if (taskCards.length === 0) {
        // 无任务卡 → 返回 success + taskCard=null
        return createSuccessStageResult(
          "plan",
          `tasks.md 无任务卡（${tasksFilePath}），无任务可执行`,
          { taskCard: null, tasksFilePath, reason: "no-task-cards", totalCards: 0 },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 3. 挑选下一张 pending 任务卡（依赖已满足）
      const completedIds = new Set<string>(taskCards.filter((c) => c.status === "completed").map((c) => c.id));
      const nextTask = pickNextPendingTask(taskCards, completedIds);

      if (nextTask === null) {
        // 所有任务已完成或被阻塞 → 返回 success + taskCard=null
        const completedCount = completedIds.size;
        return createSuccessStageResult(
          "plan",
          `所有任务已完成或被阻塞（completed=${completedCount}/${taskCards.length}）`,
          {
            taskCard: null,
            tasksFilePath,
            reason: "all-tasks-done-or-blocked",
            totalCards: taskCards.length,
            completedCards: completedCount,
          },
          [],
          0,
          Date.now() - startTime
        );
      }

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
          },
          guardRecords,
          0,
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
          },
          guardRecords,
          0,
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
        `选取下一任务卡：${nextTask.id} ${nextTask.title}（依赖已满足，范围锁预检通过）`,
        {
          taskCard,
          tasksFilePath,
          totalCards: taskCards.length,
          completedCards: completedIds.size,
          pendingCards: taskCards.length - completedIds.size,
          guardDecision: "PASS",
          domainExperts, // 领域专家匹配结果（可选增强，供后续阶段参考）
          guardCoordinatorResult, // GuardCoordinator 执行前验证结果（可选增强）
        },
        guardRecords,
        0,
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
// 4. 任务卡解析器（基于正则的逐行扫描）
// ============================================================================

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
 * @returns 任务卡列表（readonly）
 */
export function parseTaskCards(content: string): ReadonlyArray<ParsedTaskCard> {
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
          const status = value as ParsedTaskCard["status"];
          if (status === "pending" || status === "in-progress" || status === "completed" || status === "blocked") {
            currentCard.status = status;
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
 * 工厂函数：创建默认 P5PlanStageHandler 实例
 *
 * @returns P5PlanStageHandler 实例
 */
export function createPlanStageHandler(): P5PlanStageHandler {
  return new P5PlanStageHandler();
}
