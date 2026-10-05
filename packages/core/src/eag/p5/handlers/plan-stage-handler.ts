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
 * 能力预检拒绝 reason 码（历史保留：修复"能力/目标错配烧轮"2026-10-03）。
 * 同日用户决策开放 bash 后 plan 不再产生该 reason（fatal 拦截已移除）；
 * 保留导出仅为兼容外部对历史 RunState 制品的 reason 判别，勿新增消费方。
 */
export const PLAN_REASON_CAPABILITY_GAP = "capability-gap" as const;

/** 合成任务卡 ID（单 goal 合成固定为 T-001，手写清单可继续追加 T-002…） */
const SYNTHESIZED_TASK_ID = "T-001" as const;

/** 合成任务卡标题最大字符数（防止超长 objective 撑爆单行标题） */
const MAX_SYNTHESIZED_TITLE_CHARS = 200;

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
          const synthesizedContent = buildSynthesizedTasksContent(objective);
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
          atomicWriteTextFile(tasksFilePath, buildSynthesizedTasksContent(objectiveForEmpty));
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
              (c) =>
                c.id === SYNTHESIZED_TASK_ID &&
                c.requirementId === "AUTO" &&
                c.title.length > 0 &&
                objectiveText.includes(c.title)
            );
            // 注：不得用 `tasksContent.includes("## T-001 ")` 做文件级判重——
            // 合成卡沿用 T-001 编号（见 Z5 用例"旧卡 done 不改号"），手写清单
            // 首张卡标题必然命中该子串，会把所有手写卡误判为"已合成"，
            // 导致守卫永不追加（2026-10-05 守卫时序修复时纠正）。
            if (!alreadySynthesized) {
              try {
                // 去首尾空白（含事故遗留 BOM）后补单个换行：与文件原有单换行结尾约定一致，
                // 保证追加后合成卡标题前恰好一个空行（原尾部 `/\s*$/` 贪婪剥除会把空行一并吃掉）
                const appended = `${tasksContent.replace(/\s+$/, "")}\n\n${buildSynthesizedTasksContent(objectiveText)}`;
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
                (c) =>
                  c.id === SYNTHESIZED_TASK_ID &&
                  c.requirementId === "AUTO" &&
                  c.title.length > 0 &&
                  objectiveText.includes(c.title)
              );
              if (!alreadySynthesized) {
                try {
                  const appended = `${freshContent.replace(/\s+$/, "")}\n\n${buildSynthesizedTasksContent(objectiveText)}`;
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
        return createSuccessStageResult(
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
 * @returns tasks.md 完整文本
 */
export function buildSynthesizedTasksContent(objective: string): string {
  // 标题必须单行：折叠所有换行/制表符为空格并压缩连续空白，超长截断
  const singleLineTitle = objective
    .replace(/\r?\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SYNTHESIZED_TITLE_CHARS);

  return [
    "<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->",
    "",
    `## ${SYNTHESIZED_TASK_ID} ${singleLineTitle}`,
    "- requirement: AUTO",
    "- status: pending",
    "- dependencies:",
    "- files:",
    "- deletions:",
    "- symbols:",
    "- acceptance:",
    "",
  ].join("\n");
}

/**
 * 工厂函数：创建默认 P5PlanStageHandler 实例
 *
 * @returns P5PlanStageHandler 实例
 */
export function createPlanStageHandler(): P5PlanStageHandler {
  return new P5PlanStageHandler();
}
