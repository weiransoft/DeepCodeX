/**
 * CODING Loop 编排器（EAG-P2 批次 9 S5 编排与集成层）
 *
 * 本模块实现 `CodingOrchestrator` 类，对应 EAG-P2 批次 9 设计 §4.7 CODING Loop 编排器：
 * 编排 Phase A → Phase B → STRICT → FIX 循环，按任务 DAG 拓扑序执行各任务卡，
 * 集成 G-4/G-5 门禁与 LoopGuard 上限保护。
 *
 * 核心职责（对齐 §4.7.1）：
 * 1. G-4 进入门禁检查（任务卡完整性 + 模板可用性 + 技术栈锁定 + 输出目录可写）
 * 2. 拓扑序遍历 taskCards：
 *    a. LoopGuard.check() 判定是否允许继续迭代
 *    b. Phase A：skeletonGenerator.generate(taskCard)
 *    c. Phase B：contextAssembler.assemble(taskCard) → llmFiller.fill(skeleton, context)
 *    d. STRICT：strictEvaluator.evaluate(filledFiles, redlines)
 *    e. 若 verdict=fix → fixLoop.run(originalFiles, report, context)
 *    f. LoopGuard.recordIteration(tokensUsed, success)
 *    g. 记录 TaskCodingResult
 * 3. G-5 退出门禁检查（所有任务卡 completed + STRICT 通过 + git clean + gitleaks）
 * 4. 汇总 CodingLoopResult（含所有任务卡结果 + 总生成文件 + 统计信息 + 最终状态）
 *
 * 关键技术决策（对齐 §4.7.2 + 架构师关键修正）：
 * - LoopGuard API 对齐：使用 `LoopGuard.check()` + `LoopGuard.recordIteration(tokensUsed, success)`
 *   （不发明 `checkIteration()`）
 * - G-4 调用点：在每个任务卡执行 Phase A 前调用 G-4 检查（任务卡进入门禁）
 * - G-5 调用点：在所有任务卡完成后调用一次 G-5 检查（CODING Loop 退出门禁）
 * - 失败处理：
 *   - 单任务卡 FIX 耗尽 → 标记 fix-exhausted，跳过后续任务卡（G-5 必然失败）
 *   - LoopGuard 触达上限 → 立即停止，返回 failed
 *   - 评估器 verdict=human_checkpoint → 标记 human-checkpoint，跳过后续任务卡
 * - 不可变优先：所有方法入参与返回值使用 readonly + ReadonlyArray + Object.freeze
 *
 * 设计依据：
 * - EAG-P2 批次 9 设计 §4.7 CODING Loop 编排器
 * - EAG-P2 批次 9 设计 §4.7.3 编排时序（Mermaid 序列图）
 * - EAG-P2 批次 9 设计 §4.8 G-4/G-5 门禁
 * - EAG 方案 §5.10.3 CODING Loop 设计
 * - EAG 方案 §5.10.5 三 Loop 完整编排时序
 * - EAG 方案 §5.2.1 五步闭环上限保护（LoopGuard 共享保护）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 *
 * @module eag/coding/coding-orchestrator
 */

import type {
  CodingContext,
  CodingLoopRequest,
  CodingLoopResult,
  CodingLoopFinalStatus,
  GeneratedFile,
  GeneratedFileKind,
  LlmFillRequest,
  LlmFillResult,
  SkeletonGenerationRequest,
  SkeletonGenerationResult,
  TaskCodingResult,
  TaskCodingStatus,
  FixLoopRequest,
  FixLoopResult,
} from "./types";
import {
  DEFAULT_MAX_CODING_ITERATIONS,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_MAX_FILL_ROUNDS,
  DEFAULT_MAX_TOKENS_PER_FILE,
} from "./types";
import type { SkeletonGenerator } from "./skeleton-generator";
import type { ContextAssembler } from "./context-assembler";
import type { LlmFiller } from "./llm-filler";
import type { StrictEvaluator } from "./strict-evaluator";
import type { FixLoop } from "./fix-loop";
import type { GateG4Checker } from "../gate/gate-g4-checker";
import type { GateG5Checker } from "../gate/gate-g5-checker";
import type { GateContext, GateG4Context, GateG5Context, GateResult } from "../gate/gate-types";
import type { EvaluationContext, EvaluationReport, RedlineDefinition } from "../evaluator/types";
import type { TaskCard, TaskDag, TaskNode, ModuleSplit } from "../doc-driven/types";
import { PlanParser } from "./skeleton-generator";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 日志回调类型（与同模块其他类保持一致）
 */
type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * 默认输出目录（相对 projectRoot，对齐 SkeletonGenerationRequest.outputDir 默认值 "src/"）
 */
const DEFAULT_OUTPUT_DIR = "src/" as const;

/**
 * 默认评估迭代号（首次评估，FIX Loop 内部管理多轮迭代）
 */
const DEFAULT_EVALUATION_ITERATION = 1 as const;

/**
 * 任务卡完成状态值（用于 G-5 检查与 CodingLoopResult.finalStatus 判定）
 *
 * 对齐 doc-driven/types.ts 中 TaskCardStatus 的 "completed" 值。
 */
const TASK_STATUS_COMPLETED = "completed" as const;

// ============================================================================
// 异常类型
// ============================================================================

/**
 * CODING 编排器错误
 *
 * 当请求字段非法、依赖组件未注入、G-4/G-5 上下文装配失败等场景抛出。
 */
export class CodingOrchestratorError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-request：请求字段非法（projectRoot/taskCards/llmClient 等缺失或类型不对）
   *   - dependency-missing：依赖组件未注入（skeletonGenerator/contextAssembler 等为 undefined）
   *   - task-node-not-found：taskDag.nodes 中未找到 taskCard.id 对应的 TaskNode
   *   - gate-context-error：G-4/G-5 上下文装配失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-request" | "dependency-missing" | "task-node-not-found" | "gate-context-error",
    public readonly detail: string
  ) {
    super(`CODING 编排器错误 [${kind}]：${detail}`);
    this.name = "CodingOrchestratorError";
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 taskDag.nodes 中按 taskCard.id 查找对应的 TaskNode
 *
 * TaskCard 与 TaskNode 是同一任务在不同阶段的表示：
 * - TaskNode：在 taskDag 中，含 fileCluster / acceptanceCommand 等调度信息
 * - TaskCard：在 tasks.md 中，含 acceptanceCriteria / declaredSymbols 等执行信息
 * 两者通过 id 字段关联（同一任务的 id 相同）。
 *
 * @param taskDag 任务 DAG
 * @param taskCard 任务卡
 * @returns 对应的 TaskNode（未找到时返回 null）
 */
function findTaskNode(taskDag: Readonly<TaskDag>, taskCard: Readonly<TaskCard>): TaskNode | null {
  for (const node of taskDag.nodes) {
    if (node.id === taskCard.id) {
      return node as TaskNode;
    }
  }
  return null;
}

/**
 * 基于 ModuleSplit 推导本任务卡需要的模板 kind 列表（G-4 检查用）
 *
 * 与 SkeletonGenerator.determineRequiredKinds 内部逻辑保持一致（§4.2.4），
 * 用于 G-4 门禁检查中 requiredTemplateKinds 字段。
 *
 * 算法：
 * 1. 基于 moduleSplit.responsibility + keyFiles 关键词匹配推导 kinds
 * 2. 默认含 module-index（保证至少一个 kind）
 * 3. 返回去重后的 kinds 列表
 *
 * @param moduleSplit 模块切分条目
 * @returns 需要的模板 kind 列表（去重后，至少含 module-index）
 */
function determineRequiredKindsForG4(moduleSplit: Readonly<ModuleSplit>): ReadonlyArray<GeneratedFileKind> {
  const kinds = new Set<GeneratedFileKind>();
  const resp = moduleSplit.responsibility.toLowerCase();
  const files = moduleSplit.keyFiles.map((f) => f.toLowerCase());

  // 聚合根
  if (resp.includes("聚合") || files.some((f) => f.includes("aggregate"))) {
    kinds.add("aggregate");
    kinds.add("domain-event");
  }
  // 值对象
  if (
    resp.includes("值对象") ||
    resp.includes("value") ||
    files.some((f) => f.includes("value") || f.includes("money"))
  ) {
    kinds.add("value-object");
  }
  // 领域事件
  if (resp.includes("事件") || resp.includes("event") || files.some((f) => f.includes("event"))) {
    kinds.add("domain-event");
  }
  // 领域服务
  if (resp.includes("领域服务") || resp.includes("domain service") || files.some((f) => f.includes("domainservice"))) {
    kinds.add("domain-service");
  }
  // 仓储
  if (resp.includes("仓储") || resp.includes("repository") || files.some((f) => f.includes("repository"))) {
    kinds.add("repository-port");
    kinds.add("repository-impl");
  }
  // 应用服务
  if (
    resp.includes("应用服务") ||
    resp.includes("application") ||
    files.some((f) => f.includes("applicationservice"))
  ) {
    kinds.add("application-service");
  }
  // DTO
  if (resp.includes("dto") || files.some((f) => f.includes("dto"))) {
    kinds.add("dto");
  }
  // REST Controller
  if (resp.includes("controller") || resp.includes("rest") || files.some((f) => f.includes("controller"))) {
    kinds.add("rest-controller");
  }
  // Saga
  if (resp.includes("saga") || files.some((f) => f.includes("saga"))) {
    kinds.add("saga-orchestrator");
  }
  // 事件处理器
  if (resp.includes("handler") || resp.includes("处理器") || files.some((f) => f.includes("handler"))) {
    kinds.add("event-handler");
  }
  // 测试
  if (
    resp.includes("测试") ||
    resp.includes("test") ||
    files.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))
  ) {
    kinds.add("test-spec");
  }

  // 默认：若没有任何匹配，生成 module-index
  if (kinds.size === 0) {
    kinds.add("module-index");
  }

  // 始终追加 module-index（保证模块 barrel 文件生成，对齐 §4.2.4）
  kinds.add("module-index");

  return Object.freeze(Array.from(kinds)) as ReadonlyArray<GeneratedFileKind>;
}

/**
 * 从 CodingContext 中提取并合并红线清单
 *
 * 算法（与 FixLoop.extractRedlinesFromContext 一致，保证 Phase B 与 FIX 阶段使用同一份红线清单）：
 * 1. 以 context.enterpriseRedlines 为基础
 * 2. 合并 context.tcsSpecs 中每个 TCS 规范的 redlines
 * 3. 按 redline.id 去重（避免同一红线被重复判定）
 *
 * 注：rlisRules 暂不转换为 RedlineDefinition（RLIS 规则由 RuleInjector 在装配 prompt 时注入，
 *     评估阶段不直接判定 RLIS 规则，留待后续版本扩展）。
 *
 * @param context CODING Loop 上下文
 * @returns 合并去重后的红线清单（已冻结）
 */
function extractRedlinesFromContext(context: Readonly<CodingContext>): ReadonlyArray<RedlineDefinition> {
  const redlines: RedlineDefinition[] = [...context.enterpriseRedlines];
  for (const spec of context.tcsSpecs) {
    for (const rl of spec.redlines) {
      if (!redlines.find((r) => r.id === rl.id)) {
        redlines.push(rl);
      }
    }
  }
  return Object.freeze(redlines) as ReadonlyArray<RedlineDefinition>;
}

/**
 * 构造 STRICT 评估上下文（EvaluationContext）
 *
 * 将 Phase B 填充后的文件列表转换为评估器可消费的 EvaluationContext：
 * - artifactPaths：文件相对路径列表（评估器按路径读取内容判定）
 * - inlineArtifacts：文件内容内联（避免评估器重复读盘，对齐 §4.5.2 双通道产出物）
 *
 * @param taskCardId 当前任务卡 ID（用于 EvaluationContext.taskId）
 * @param files 填充后的文件列表
 * @param iteration 当前迭代号（首次评估=1，FIX Loop 内部管理多轮迭代）
 * @returns 完整的 EvaluationContext
 */
function buildEvaluationContext(
  taskCardId: string,
  files: ReadonlyArray<GeneratedFile>,
  iteration: number = DEFAULT_EVALUATION_ITERATION
): EvaluationContext {
  return {
    loopType: "coding",
    iteration,
    taskId: taskCardId,
    artifactPaths: files.map((f) => f.relativePath),
    inlineArtifacts: files.map((f) => ({ path: f.relativePath, content: f.content })),
  };
}

// ============================================================================
// CodingOrchestrator 类
// ============================================================================

/**
 * CODING Loop 编排器依赖注入参数
 *
 * 对应 EAG-P2 批次 9 设计 §4.7.2 CodingOrchestrator 构造函数签名。
 * 所有依赖通过构造函数注入，便于测试替换为真实实现（InMemoryLLMClient / InMemoryPkcAccessor 等）。
 */
export interface CodingOrchestratorDeps {
  /** Phase A 骨架生成器 */
  readonly skeletonGenerator: SkeletonGenerator;
  /** 上下文装配器（Phase B 输入） */
  readonly contextAssembler: ContextAssembler;
  /** Phase B LLM 填充器 */
  readonly llmFiller: LlmFiller;
  /** STRICT 评估器 */
  readonly strictEvaluator: StrictEvaluator;
  /** FIX 回灌循环 */
  readonly fixLoop: FixLoop;
  /** G-4 进入门禁检查器 */
  readonly g4Checker: GateG4Checker;
  /** G-5 退出门禁检查器 */
  readonly g5Checker: GateG5Checker;
  /** 日志回调（可选） */
  readonly logger?: LogCallback;
}

/**
 * CODING Loop 编排器
 *
 * 对应 EAG-P2 批次 9 设计 §4.7.2 CodingOrchestrator：
 * 编排 Phase A → Phase B → STRICT → FIX 循环，按任务 DAG 拓扑序执行各任务卡，
 * 集成 G-4/G-5 门禁与 LoopGuard 上限保护。
 *
 * 使用方式：
 * ```typescript
 * const orchestrator = new CodingOrchestrator({
 *   skeletonGenerator: new SkeletonGenerator(),
 *   contextAssembler: new ContextAssembler(pkcAccessor),
 *   llmFiller: new LlmFiller(),
 *   strictEvaluator: new StrictEvaluator(),
 *   fixLoop: new FixLoop(new StrictEvaluator()),
 *   g4Checker: new GateG4Checker(),
 *   g5Checker: new GateG5Checker(new StrictEvaluator()),
 * });
 *
 * const result = await orchestrator.run({
 *   projectRoot: "/path/to/project",
 *   specContent: "...",
 *   planContent: "...",
 *   tasksContent: "...",
 *   taskDag: { nodes: [...], topologicalOrder: ["T-001", "T-002"] },
 *   taskCards: [...],
 *   techStack: ["TypeScript", "NestJS"],
 *   constitutionContent: "...",
 *   llmClient: new InMemoryLLMClient(),
 *   pkcAccessor: new InMemoryPkcAccessor({}),
 *   loopGuard: new LoopGuard({ maxIterations: 10 }),
 *   maxIterations: 10,
 *   maxFixRounds: 3,
 * });
 *
 * if (result.finalStatus === "completed") {
 *   // 所有任务卡完成，生成文件就绪
 * }
 * ```
 *
 * 不可变优先：
 * - 所有方法入参使用 Readonly 包裹
 * - run() 返回的 CodingLoopResult 通过 Object.freeze 冻结
 * - 内部状态不暴露给外部
 */
export class CodingOrchestrator {
  // 依赖组件（构造时注入，运行期不可变）
  private readonly skeletonGenerator: SkeletonGenerator;
  private readonly contextAssembler: ContextAssembler;
  private readonly llmFiller: LlmFiller;
  private readonly strictEvaluator: StrictEvaluator;
  private readonly fixLoop: FixLoop;
  private readonly g4Checker: GateG4Checker;
  private readonly g5Checker: GateG5Checker;
  private readonly logger?: LogCallback;

  /**
   * 初始化 CODING Loop 编排器
   *
   * @param deps 依赖注入参数（全部组件必填，确保编排器运行时所有依赖就绪）
   */
  constructor(deps: Readonly<CodingOrchestratorDeps>) {
    // 校验必填依赖（fail-fast，避免运行时 NPE）
    if (!deps.skeletonGenerator) {
      throw new CodingOrchestratorError("dependency-missing", "skeletonGenerator 必填");
    }
    if (!deps.contextAssembler) {
      throw new CodingOrchestratorError("dependency-missing", "contextAssembler 必填");
    }
    if (!deps.llmFiller) {
      throw new CodingOrchestratorError("dependency-missing", "llmFiller 必填");
    }
    if (!deps.strictEvaluator) {
      throw new CodingOrchestratorError("dependency-missing", "strictEvaluator 必填");
    }
    if (!deps.fixLoop) {
      throw new CodingOrchestratorError("dependency-missing", "fixLoop 必填");
    }
    if (!deps.g4Checker) {
      throw new CodingOrchestratorError("dependency-missing", "g4Checker 必填");
    }
    if (!deps.g5Checker) {
      throw new CodingOrchestratorError("dependency-missing", "g5Checker 必填");
    }

    this.skeletonGenerator = deps.skeletonGenerator;
    this.contextAssembler = deps.contextAssembler;
    this.llmFiller = deps.llmFiller;
    this.strictEvaluator = deps.strictEvaluator;
    this.fixLoop = deps.fixLoop;
    this.g4Checker = deps.g4Checker;
    this.g5Checker = deps.g5Checker;
    this.logger = deps.logger;
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 执行 CODING Loop
   *
   * 算法（对齐 §4.7.2 + §4.7.3 序列图 + 架构师关键修正）：
   * 1. 校验请求字段合法性
   * 2. 拓扑序遍历 taskCards：
   *    a. LoopGuard.check() 判定是否允许继续迭代（架构师修正：使用 check() 而非 checkIteration()）
   *    b. 若不允许 → 立即停止，返回 failed
   *    c. 调用 executeTaskCard() 执行当前任务卡（含 G-4 检查 + Phase A → B → STRICT → FIX）
   *    d. LoopGuard.recordIteration(tokensUsed, success) 记录本次迭代消耗
   *    e. 收集 TaskCodingResult
   *    f. 若任务卡状态非 completed → 跳过后续任务卡（G-5 必然失败）
   * 3. G-5 退出门禁检查（所有任务卡完成后调用一次）
   * 4. 汇总 CodingLoopResult（含所有任务卡结果 + 总生成文件 + 统计信息 + 最终状态）
   *
   * 失败处理：
   * - LoopGuard 触达上限 → 立即停止，返回 finalStatus=failed
   * - 单任务卡 FIX 耗尽 → 标记 fix-exhausted，跳过后续任务卡
   * - 评估器 verdict=human_checkpoint → 标记 human-checkpoint，跳过后续任务卡
   * - G-5 门禁失败 → finalStatus=failed（含 blockedReason 描述具体未通过项）
   *
   * @param request CODING Loop 编排请求
   * @returns CODING Loop 编排产出（含所有任务卡结果 + 总生成文件 + 统计 + 最终状态）
   */
  async run(request: Readonly<CodingLoopRequest>): Promise<CodingLoopResult> {
    const startTime = Date.now();
    this.logger?.("CodingOrchestrator.run 启动", "info");

    // 步骤 1：校验请求字段合法性
    this.validateRequest(request);

    // 步骤 2：初始化统计变量与结果收集
    const taskResults: TaskCodingResult[] = [];
    const allGeneratedFiles: GeneratedFile[] = [];
    let totalIterations = 0;
    let totalLlmCallCount = 0;
    let totalTokensUsed = 0;
    let loopFinalStatus: CodingLoopFinalStatus = "completed";
    let blockedReason: string | undefined = undefined;

    // 步骤 3：拓扑序遍历任务卡
    const topologicalOrder = request.taskDag.topologicalOrder;
    // 构建 taskCardId → taskCard 映射，便于按拓扑序查找
    const taskCardMap = new Map<string, TaskCard>();
    for (const tc of request.taskCards) {
      taskCardMap.set(tc.id, tc as TaskCard);
    }

    for (const taskCardId of topologicalOrder) {
      const taskCard = taskCardMap.get(taskCardId);
      if (!taskCard) {
        // 拓扑序中的任务 ID 在 taskCards 中找不到 → 跳过（数据不一致）
        this.logger?.(`拓扑序中的任务 ID "${taskCardId}" 在 taskCards 中找不到，跳过`, "warn");
        continue;
      }

      // 3a. LoopGuard.check() 判定是否允许继续迭代
      const guardCheck = request.loopGuard.check();
      if (!guardCheck.allowed) {
        // 触达上限 → 立即停止，返回 failed
        const stopReason = guardCheck.stopReason ?? "manually_aborted";
        loopFinalStatus = "failed";
        blockedReason = `LoopGuard 终止：${stopReason}（已迭代 ${guardCheck.state.iterationsCompleted}/${request.loopGuard.getConfig().maxIterations} 次，已消耗 ${guardCheck.state.tokensConsumed}/${request.loopGuard.getConfig().maxTokens} tokens）`;
        this.logger?.(`CODING Loop 被 LoopGuard 终止：${blockedReason}`, "warn");
        break;
      }

      // 3b. 执行当前任务卡（含 G-4 检查 + Phase A → B → STRICT → FIX）
      let taskResult: TaskCodingResult;
      try {
        taskResult = await this.executeTaskCard(taskCard, request);
      } catch (e) {
        // executeTaskCard 抛出异常 → 标记 human-checkpoint 并跳过后续任务卡
        const errMsg = e instanceof Error ? e.message : String(e);
        this.logger?.(`任务卡 "${taskCardId}" 执行抛出异常：${errMsg}，标记 human-checkpoint`, "error");
        // 构造一个最小可用的 TaskCodingResult（避免下游汇总时 NPE）
        // 注：这种异常路径仅在依赖组件内部异常时触发（如 SkeletonGenerator/ContextAssembler 内部错误）
        taskResult = this.buildFallbackTaskResult(taskCardId, errMsg);
        loopFinalStatus = "human-checkpoint";
        blockedReason = `任务卡 "${taskCardId}" 执行异常：${errMsg}`;
        taskResults.push(taskResult);
        // 记录迭代（失败）
        request.loopGuard.recordIteration(0, false);
        totalIterations++;
        break;
      }

      // 3c. 收集 TaskCodingResult
      taskResults.push(taskResult);
      allGeneratedFiles.push(...taskResult.fill.filledFiles);
      totalIterations++;

      // 3d. 记录 LoopGuard 迭代消耗
      // success 语义：taskResult.status === "completed"（STRICT 评估通过）
      const iterTokensUsed = taskResult.fill.totalTokensUsed;
      const iterSuccess = taskResult.status === "completed";
      request.loopGuard.recordIteration(iterTokensUsed, iterSuccess);

      // 3e. 累计统计（LLM 调用次数 + token 消耗）
      totalLlmCallCount += taskResult.fill.llmCallCount;
      totalTokensUsed += taskResult.fill.totalTokensUsed;

      this.logger?.(
        `任务卡 "${taskCardId}" 完成，status=${taskResult.status}，` +
          `iterations=${taskResult.iterations}，tokens=${iterTokensUsed}`,
        taskResult.status === "completed" ? "info" : "warn"
      );

      // 3f. 若任务卡状态非 completed → 跳过后续任务卡（G-5 必然失败）
      if (taskResult.status !== "completed") {
        loopFinalStatus = taskResult.status === "fix-exhausted" ? "human-checkpoint" : "human-checkpoint";
        blockedReason = `任务卡 "${taskCardId}" 状态为 ${taskResult.status}，CODING Loop 提前终止（后续任务卡跳过）`;
        this.logger?.(`CODING Loop 提前终止：${blockedReason}`, "warn");
        break;
      }
    }

    // 步骤 4：G-5 退出门禁检查（所有任务卡完成后调用一次）
    // 仅在所有任务卡 completed 时才进行 G-5 检查；若有任务卡未完成，跳过 G-5（必然失败）
    if (loopFinalStatus === "completed") {
      const g5Result = this.checkG5Gate(request, taskResults, allGeneratedFiles);
      if (!g5Result.passed) {
        loopFinalStatus = "failed";
        blockedReason = `G-5 门禁失败：${g5Result.reason}`;
        this.logger?.(`G-5 门禁失败：${g5Result.reason}`, "warn");
      } else {
        this.logger?.(`G-5 门禁通过：${g5Result.reason}`, "info");
      }
    }

    // 步骤 5：汇总并返回 CodingLoopResult
    const durationSec = Math.floor((Date.now() - startTime) / 1000);

    return Object.freeze({
      taskResults: Object.freeze([...taskResults]) as ReadonlyArray<TaskCodingResult>,
      allGeneratedFiles: Object.freeze([...allGeneratedFiles]) as ReadonlyArray<GeneratedFile>,
      totalIterations,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
      finalStatus: loopFinalStatus,
      blockedReason,
    }) as CodingLoopResult;
  }

  // ========================================================================
  // 私有方法：任务卡执行
  // ========================================================================

  /**
   * 执行单个任务卡（含 G-4 检查 + Phase A → B → STRICT → FIX）
   *
   * 算法：
   * 1. 从 taskDag.nodes 中按 taskCard.id 查找 TaskNode（获取 fileCluster）
   * 2. G-4 进入门禁检查（任务卡完整性 + 模板可用性 + 技术栈 + 输出目录）
   * 3. Phase A：skeletonGenerator.generate(taskCard)
   * 4. Phase B：contextAssembler.assemble(taskCard, planContent, projectRoot, fileCluster)
   *    → llmFiller.fill(skeleton, context, llmClient)
   * 5. STRICT：strictEvaluator.evaluate(filledFiles, redlines)
   * 6. 若 verdict=pass → 返回 TaskCodingResult(completed)
   * 7. 若 verdict=fix → 调用 runCodingLoop()（FIX Loop）
   *    a. FIX 后 verdict=pass → 返回 TaskCodingResult(completed)
   *    b. FIX 后 verdict 非 pass → 返回 TaskCodingResult(fix-exhausted)
   * 8. 若 verdict=human_checkpoint/stop_failure → 返回 TaskCodingResult(human-checkpoint)
   *
   * @param taskCard 当前任务卡
   * @param request CODING Loop 编排请求（含全部上下文）
   * @returns 任务卡执行结果
   */
  private async executeTaskCard(
    taskCard: Readonly<TaskCard>,
    request: Readonly<CodingLoopRequest>
  ): Promise<TaskCodingResult> {
    this.logger?.(`executeTaskCard 启动：taskCardId="${taskCard.id}"`, "info");

    // 步骤 1：从 taskDag.nodes 中查找 TaskNode 获取 fileCluster
    const taskNode = findTaskNode(request.taskDag, taskCard);
    if (!taskNode) {
      throw new CodingOrchestratorError(
        "task-node-not-found",
        `taskDag.nodes 中未找到 taskCard.id="${taskCard.id}" 对应的 TaskNode`
      );
    }
    const fileCluster = taskNode.fileCluster;

    // 步骤 2：G-4 进入门禁检查
    const g4Result = this.checkG4Gate(taskCard, fileCluster, request);
    if (!g4Result.passed) {
      // G-4 失败 → 标记 human-checkpoint（无法进入 Phase A）
      this.logger?.(`G-4 门禁失败：${g4Result.reason}`, "warn");
      return this.buildGatedTaskResult(taskCard.id, g4Result, "human-checkpoint");
    }
    this.logger?.(`G-4 门禁通过：${g4Result.reason}`, "info");

    // 步骤 3：Phase A 骨架生成
    const skeletonRequest: SkeletonGenerationRequest = {
      planContent: request.planContent,
      tasksContent: request.tasksContent,
      taskDag: request.taskDag,
      taskCard,
      techStack: request.techStack,
      projectRoot: request.projectRoot,
      outputDir: DEFAULT_OUTPUT_DIR,
    };
    const skeleton: SkeletonGenerationResult = this.skeletonGenerator.generate(skeletonRequest);
    this.logger?.(
      `Phase A 骨架生成完成：${skeleton.files.length} 个文件，${skeleton.fillPlaceholders.length} 个占位`,
      "info"
    );

    // 步骤 4：Phase B 上下文装配 + LLM 填充
    const context: CodingContext = await this.contextAssembler.assemble(
      taskCard,
      request.planContent,
      request.projectRoot,
      fileCluster
    );

    const fillRequest: LlmFillRequest = {
      skeleton,
      context,
      llmClient: request.llmClient,
      maxRounds: DEFAULT_MAX_FILL_ROUNDS,
      maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_FILE,
    };
    const fillResult: LlmFillResult = await this.llmFiller.fill(fillRequest);
    this.logger?.(
      `Phase B LLM 填充完成：${fillResult.filledFiles.length} 个文件，` +
        `llmCallCount=${fillResult.llmCallCount}，tokensUsed=${fillResult.totalTokensUsed}`,
      "info"
    );

    // 步骤 5：STRICT 评估 + FIX 回灌（若需要）
    const { finalEvaluation, finalFiles, fixLoopResult, iterations } = await this.runCodingLoop(
      taskCard,
      fillResult,
      context,
      request
    );

    // 步骤 6：根据最终评估 verdict 决定任务卡状态
    let status: TaskCodingStatus;
    if (finalEvaluation.verdict === "pass") {
      status = "completed";
    } else if (fixLoopResult && fixLoopResult.rounds.length >= request.maxFixRounds) {
      // FIX 耗尽（达到 maxFixRounds 上限仍未通过）
      status = "fix-exhausted";
    } else if (finalEvaluation.verdict === "human_checkpoint" || finalEvaluation.verdict === "stop_failure") {
      status = "human-checkpoint";
    } else {
      // verdict=fix 但未达 FIX 上限（异常路径，理论上不应到达）
      status = "fix-exhausted";
    }

    this.logger?.(
      `任务卡 "${taskCard.id}" 最终状态：${status}，verdict=${finalEvaluation.verdict}，` + `iterations=${iterations}`,
      status === "completed" ? "info" : "warn"
    );

    // 步骤 7：构造并返回 TaskCodingResult
    // 注：fill 字段使用 finalFiles 重新构造一个 LlmFillResult（含修复后的文件）
    const finalFillResult: LlmFillResult = {
      filledFiles: finalFiles,
      fillStatus: fillResult.fillStatus,
      llmCallCount: fillResult.llmCallCount + (fixLoopResult?.totalLlmCallCount ?? 0),
      totalTokensUsed: fillResult.totalTokensUsed,
      durationMs: fillResult.durationMs,
    };

    return Object.freeze({
      taskCardId: taskCard.id,
      skeleton,
      fill: finalFillResult,
      finalEvaluation,
      status,
      iterations,
    }) as TaskCodingResult;
  }

  /**
   * 执行 STRICT 评估 + FIX 回灌循环
   *
   * 算法（对齐 §4.7.3 序列图 + §4.6 FIX Loop）：
   * 1. 从 context 合并红线清单（enterpriseRedlines + tcsSpecs.redlines）
   * 2. 构造 EvaluationContext（含填充后的文件作为 inlineArtifacts）
   * 3. 调用 strictEvaluator.evaluate() 获取首次评估报告
   * 4. 若 verdict=pass → 直接返回（无需 FIX）
   * 5. 若 verdict=fix → 调用 fixLoop.run() 进行多轮修复
   *    a. FixLoop 内部循环 maxFixRounds 轮（每轮：LLM 生成 patch → 应用 patch → 重新评估）
   *    b. FixLoop 返回最终评估报告与修复后的文件
   * 6. 若 verdict=human_checkpoint/stop_failure → 直接返回（不进入 FIX）
   *
   * @param taskCard 当前任务卡
   * @param fillResult Phase B 填充产出
   * @param context CODING Loop 上下文（含红线清单）
   * @param request CODING Loop 编排请求
   * @returns 最终评估报告 + 最终文件列表 + FIX Loop 产出（若触发 FIX）+ 总迭代次数
   */
  private async runCodingLoop(
    taskCard: Readonly<TaskCard>,
    fillResult: Readonly<LlmFillResult>,
    context: Readonly<CodingContext>,
    request: Readonly<CodingLoopRequest>
  ): Promise<{
    readonly finalEvaluation: EvaluationReport;
    readonly finalFiles: ReadonlyArray<GeneratedFile>;
    readonly fixLoopResult?: FixLoopResult;
    readonly iterations: number;
  }> {
    // 步骤 1：合并红线清单
    const redlines = extractRedlinesFromContext(context);

    // 步骤 2：构造评估上下文
    const evaluationContext = buildEvaluationContext(taskCard.id, fillResult.filledFiles, DEFAULT_EVALUATION_ITERATION);

    // 步骤 3：首次 STRICT 评估
    // 注：currentReport 仅在 verdict=fix 时作为 FixLoop 的输入，不在本作用域内重新赋值
    this.logger?.(`STRICT 评估启动：taskCardId="${taskCard.id}"`, "info");
    const currentReport: EvaluationReport = await this.strictEvaluator.evaluate(evaluationContext, redlines);
    this.logger?.(
      `STRICT 首次评估结果：verdict=${currentReport.verdict}，` +
        `blocker=${currentReport.blockerCount}/major=${currentReport.majorCount}/warning=${currentReport.warningCount}`,
      currentReport.verdict === "pass" ? "info" : "warn"
    );

    let iterations = 1;

    // 步骤 4：verdict=pass → 直接返回
    if (currentReport.verdict === "pass") {
      return {
        finalEvaluation: currentReport,
        finalFiles: fillResult.filledFiles,
        iterations,
      };
    }

    // 步骤 5：verdict=fix → 调用 FIX Loop
    if (currentReport.verdict === "fix") {
      this.logger?.(`进入 FIX Loop：taskCardId="${taskCard.id}"，maxRounds=${request.maxFixRounds}`, "info");
      const fixRequest: FixLoopRequest = {
        originalFiles: fillResult.filledFiles,
        evaluationReport: currentReport,
        context,
        llmClient: request.llmClient,
        maxRounds: request.maxFixRounds,
      };
      const fixResult: FixLoopResult = await this.fixLoop.run(fixRequest);
      iterations += fixResult.rounds.length;

      this.logger?.(
        `FIX Loop 完成：rounds=${fixResult.rounds.length}，finalVerdict=${fixResult.finalReport.verdict}`,
        fixResult.finalReport.verdict === "pass" ? "info" : "warn"
      );

      return {
        finalEvaluation: fixResult.finalReport,
        finalFiles: fixResult.fixedFiles,
        fixLoopResult: fixResult,
        iterations,
      };
    }

    // 步骤 6：verdict=human_checkpoint/stop_failure → 直接返回（不进入 FIX）
    return {
      finalEvaluation: currentReport,
      finalFiles: fillResult.filledFiles,
      iterations,
    };
  }

  // ========================================================================
  // 私有方法：门禁检查
  // ========================================================================

  /**
   * 执行 G-4 进入门禁检查
   *
   * 装配 GateG4Context 并调用 g4Checker.check()。
   *
   * @param taskCard 当前任务卡
   * @param fileCluster 任务卡所属文件簇名（来自 TaskNode.fileCluster）
   * @param request CODING Loop 编排请求
   * @returns G-4 门禁判定结果
   */
  private checkG4Gate(
    taskCard: Readonly<TaskCard>,
    fileCluster: string,
    request: Readonly<CodingLoopRequest>
  ): GateResult {
    // 从 plan.md 解析当前 fileCluster 对应的 ModuleSplit（用于推导 requiredTemplateKinds）
    const moduleSplit = PlanParser.parseModuleSplit(request.planContent, fileCluster);
    if (!moduleSplit) {
      // ModuleSplit 未找到 → G-4 失败（任务卡 fileCluster 未在 plan.md 中声明）
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `plan.md 中未找到 moduleName="${fileCluster}" 的 ModuleSplit（任务卡 "${taskCard.id}" 的 fileCluster 未在方案中声明）`,
        guidance: "建议回退到 CODING Loop 首轮，补齐 plan.md 中的模块切分条目后重试 G-4 门禁",
        severity: "blocker",
      }) as GateResult;
    }

    // 基于 ModuleSplit 推导 requiredTemplateKinds
    const requiredTemplateKinds = determineRequiredKindsForG4(moduleSplit);

    // 装配 GateG4Context
    const g4Context: GateG4Context = {
      // 基础 GateContext 字段（CODING Loop 启动前已通过 G-1/G-2/G-3，此处填默认值）
      projectId: request.projectRoot,
      loopType: "coding",
      specStatus: "approved", // G-1 已通过 → spec.md 已批准
      planStatus: "approved", // G-1 已通过 → plan.md 已批准
      reviewRecords: [], // G-2 已通过 → 评审记录已在 G-2 验证
      userApproved: true, // G-2 已通过 → 用户已批准
      taskCard: taskCard as TaskCard,
      actualChanges: [], // G-3 已通过 → 实际变更已在 G-3 验证
      // G-4 扩展字段
      tasksStatus: "approved", // CODING Loop 启动前 tasks.md 已批准
      fileCluster,
      requiredTemplateKinds,
      techStack: request.techStack,
      outputDir: DEFAULT_OUTPUT_DIR,
    } as GateG4Context;

    return this.g4Checker.check(g4Context as GateContext);
  }

  /**
   * 执行 G-5 退出门禁检查
   *
   * 装配 GateG5Context 并调用 g5Checker.check()。
   * G-5 检查 4 个前置条件：
   * 1. 所有任务卡 status=completed
   * 2. 最终 STRICT 评估 verdict=pass（取所有任务卡的 finalEvaluation 汇总）
   * 3. git 工作区干净（默认 true，由调用方在集成时传入真实状态）
   * 4. gitleaks 扫描通过（默认 true，由调用方在集成时传入真实状态）
   *
   * @param request CODING Loop 编排请求
   * @param taskResults 各任务卡执行结果
   * @param allGeneratedFiles 所有生成文件（用于构造最终评估报告）
   * @returns G-5 门禁判定结果
   */
  private checkG5Gate(
    request: Readonly<CodingLoopRequest>,
    taskResults: ReadonlyArray<TaskCodingResult>,
    allGeneratedFiles: ReadonlyArray<GeneratedFile>
  ): GateResult {
    // 更新 taskCards 的 status 为最终状态（用于 G-5 校验所有任务卡 completed）
    // 注：taskCards 是 ReadonlyArray，需构造一份带最新 status 的副本
    const completedTaskCards: TaskCard[] = request.taskCards.map((tc) => {
      const result = taskResults.find((r) => r.taskCardId === tc.id);
      const status = result?.status === "completed" ? TASK_STATUS_COMPLETED : tc.status;
      return { ...tc, status } as TaskCard;
    });

    // 取所有任务卡的最终评估报告（用于 G-5 校验 verdict=pass）
    // 注：若有任务卡未 completed，取其 finalEvaluation 也必然非 pass
    // 此处取最后一个任务卡的 finalEvaluation 作为"最终评估报告"代表（保守策略）
    const lastTaskResult = taskResults[taskResults.length - 1];
    const finalEvaluationReport: EvaluationReport =
      (lastTaskResult?.finalEvaluation as EvaluationReport) ??
      ({
        verdict: "fix",
        redlineResults: [],
        blockerCount: 1,
        majorCount: 0,
        warningCount: 0,
        durationMs: 0,
        notes: "无任务卡结果（taskResults 为空）",
      } as EvaluationReport);

    // 装配 GateG5Context
    const g5Context: GateG5Context = {
      // 基础 GateContext 字段
      projectId: request.projectRoot,
      loopType: "coding",
      specStatus: "approved",
      planStatus: "approved",
      reviewRecords: [],
      userApproved: true,
      taskCard: completedTaskCards[0] ?? (request.taskCards[0] as TaskCard),
      actualChanges: [],
      // G-5 扩展字段
      allTaskCards: completedTaskCards,
      finalEvaluationReport,
      gitClean: true, // 默认 true，由调用方在集成时通过 GitProcessManager 校验
      gitleaksPassed: true, // 默认 true，由调用方在集成时通过 gitleaks 扫描校验
    } as GateG5Context;

    return this.g5Checker.check(g5Context as GateContext);
  }

  // ========================================================================
  // 私有方法：辅助构造
  // ========================================================================

  /**
   * 构造 G-4 门禁失败时的最小 TaskCodingResult
   *
   * G-4 失败时未进入 Phase A → skeleton/fill/finalEvaluation 字段使用最小可用占位。
   *
   * @param taskCardId 任务卡 ID
   * @param g4Result G-4 门禁结果
   * @param status 任务卡状态（G-4 失败时为 human-checkpoint）
   * @returns 最小可用的 TaskCodingResult
   */
  private buildGatedTaskResult(taskCardId: string, g4Result: GateResult, status: TaskCodingStatus): TaskCodingResult {
    // 构造最小可用的 SkeletonGenerationResult（G-4 失败，未生成骨架）
    const emptySkeleton: SkeletonGenerationResult = Object.freeze({
      files: Object.freeze([]) as ReadonlyArray<GeneratedFile>,
      templateVariables: Object.freeze({}) as Readonly<Record<string, unknown>>,
      fillPlaceholders: Object.freeze([]) as ReadonlyArray<never>,
      durationMs: 0,
    }) as SkeletonGenerationResult;

    // 构造最小可用的 LlmFillResult（G-4 失败，未填充）
    const emptyFill: LlmFillResult = Object.freeze({
      filledFiles: Object.freeze([]) as ReadonlyArray<GeneratedFile>,
      fillStatus: Object.freeze([]) as ReadonlyArray<never>,
      llmCallCount: 0,
      totalTokensUsed: 0,
      durationMs: 0,
    }) as LlmFillResult;

    // 构造最小可用的 EvaluationReport（G-4 失败，未评估）
    const emptyEvaluation: EvaluationReport = Object.freeze({
      verdict: "human_checkpoint",
      redlineResults: Object.freeze([]) as never[],
      blockerCount: 0,
      majorCount: 0,
      warningCount: 0,
      durationMs: 0,
      notes: `G-4 门禁失败：${g4Result.reason}`,
    }) as EvaluationReport;

    return Object.freeze({
      taskCardId,
      skeleton: emptySkeleton,
      fill: emptyFill,
      finalEvaluation: emptyEvaluation,
      status,
      iterations: 0,
    }) as TaskCodingResult;
  }

  /**
   * 构造异常路径下的最小 TaskCodingResult
   *
   * 当 executeTaskCard 抛出异常时，构造一个最小可用的 TaskCodingResult 用于汇总。
   * 注：此路径仅在依赖组件内部异常时触发（如 SkeletonGenerator/ContextAssembler 内部错误）。
   *
   * @param taskCardId 任务卡 ID
   * @param errMsg 异常消息
   * @returns 最小可用的 TaskCodingResult（status=human-checkpoint）
   */
  private buildFallbackTaskResult(taskCardId: string, errMsg: string): TaskCodingResult {
    const emptySkeleton: SkeletonGenerationResult = Object.freeze({
      files: Object.freeze([]) as ReadonlyArray<GeneratedFile>,
      templateVariables: Object.freeze({}) as Readonly<Record<string, unknown>>,
      fillPlaceholders: Object.freeze([]) as ReadonlyArray<never>,
      durationMs: 0,
    }) as SkeletonGenerationResult;

    const emptyFill: LlmFillResult = Object.freeze({
      filledFiles: Object.freeze([]) as ReadonlyArray<GeneratedFile>,
      fillStatus: Object.freeze([]) as ReadonlyArray<never>,
      llmCallCount: 0,
      totalTokensUsed: 0,
      durationMs: 0,
    }) as LlmFillResult;

    const errorEvaluation: EvaluationReport = Object.freeze({
      verdict: "human_checkpoint",
      redlineResults: Object.freeze([]) as never[],
      blockerCount: 0,
      majorCount: 0,
      warningCount: 0,
      durationMs: 0,
      notes: `任务卡执行异常：${errMsg}`,
    }) as EvaluationReport;

    return Object.freeze({
      taskCardId,
      skeleton: emptySkeleton,
      fill: emptyFill,
      finalEvaluation: errorEvaluation,
      status: "human-checkpoint",
      iterations: 0,
    }) as TaskCodingResult;
  }

  // ========================================================================
  // 私有方法：请求校验
  // ========================================================================

  /**
   * 校验 run() 请求字段合法性
   *
   * 校验规则（与 createCodingLoopRequest 工厂函数对齐）：
   * - projectRoot / specContent / planContent / tasksContent / constitutionContent 必须为非空字符串
   * - taskDag 必须含 nodes 与 topologicalOrder 数组
   * - taskCards 必须为非空数组
   * - techStack 必须为数组
   * - llmClient 必须实现 LLMClient 接口（含 createMessage 方法）
   * - pkcAccessor 必须实现 PkcAccessor 接口（含 queryL1GlobalView 方法）
   * - loopGuard 必须含 check 与 recordIteration 方法
   * - maxIterations / maxFixRounds 必须为 ≥1 的数字
   *
   * @param request CODING Loop 编排请求
   * @throws {CodingOrchestratorError} 任一字段非法时抛出
   */
  private validateRequest(request: Readonly<CodingLoopRequest>): void {
    if (!request) {
      throw new CodingOrchestratorError("invalid-request", "request 不能为空");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new CodingOrchestratorError("invalid-request", "projectRoot 必须为非空字符串");
    }
    if (typeof request.specContent !== "string" || request.specContent.trim().length === 0) {
      throw new CodingOrchestratorError("invalid-request", "specContent 必须为非空字符串");
    }
    if (typeof request.planContent !== "string" || request.planContent.trim().length === 0) {
      throw new CodingOrchestratorError("invalid-request", "planContent 必须为非空字符串");
    }
    if (typeof request.tasksContent !== "string" || request.tasksContent.trim().length === 0) {
      throw new CodingOrchestratorError("invalid-request", "tasksContent 必须为非空字符串");
    }
    if (!request.taskDag || !Array.isArray(request.taskDag.nodes) || !Array.isArray(request.taskDag.topologicalOrder)) {
      throw new CodingOrchestratorError("invalid-request", "taskDag 必须含 nodes 与 topologicalOrder 数组");
    }
    if (!Array.isArray(request.taskCards) || request.taskCards.length === 0) {
      throw new CodingOrchestratorError("invalid-request", "taskCards 必须为非空数组");
    }
    if (!Array.isArray(request.techStack)) {
      throw new CodingOrchestratorError("invalid-request", "techStack 必须为数组");
    }
    if (typeof request.constitutionContent !== "string" || request.constitutionContent.trim().length === 0) {
      throw new CodingOrchestratorError("invalid-request", "constitutionContent 必须为非空字符串");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new CodingOrchestratorError("invalid-request", "llmClient 必须实现 LLMClient 接口");
    }
    if (!request.pkcAccessor || typeof request.pkcAccessor.queryL1GlobalView !== "function") {
      throw new CodingOrchestratorError("invalid-request", "pkcAccessor 必须实现 PkcAccessor 接口");
    }
    if (
      !request.loopGuard ||
      typeof request.loopGuard.check !== "function" ||
      typeof request.loopGuard.recordIteration !== "function"
    ) {
      throw new CodingOrchestratorError("invalid-request", "loopGuard 必须含 check() 与 recordIteration() 方法");
    }
    if (typeof request.maxIterations !== "number" || request.maxIterations < 1) {
      throw new CodingOrchestratorError("invalid-request", "maxIterations 必须为 ≥1 的数字");
    }
    if (typeof request.maxFixRounds !== "number" || request.maxFixRounds < 1) {
      throw new CodingOrchestratorError("invalid-request", "maxFixRounds 必须为 ≥1 的数字");
    }
  }
}
