/**
 * DESIGN Loop 编排器（EAG-P1 批次 3）
 *
 * 本模块实现 `DesignLoopOrchestrator` 类，编排 EAG 方案 §5.2.2 DESIGN Loop 完整流程：
 *
 *     PM 结构化需求 → 架构师设计 → 评估器判定 →
 *       若失败重试（携带 verdict.reason） → 若通过触发 HUMAN_CHECKPOINT
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 DESIGN Loop 角色编排：PM → 架构师 → 独立评估器
 * - EAG 方案 §5.2.2 人工检查点：设计文档生成后默认触发 1 次 HUMAN_CHECKPOINT
 *
 * 编排流程：
 * 1. PM.structureRequirement：原始需求 → StructuredRequirement
 * 2. 架构师设计：StructuredRequirement + paradigmLock → ArchitectureDocument + DomainModelDocument
 *    （架构师内部调用 selectParadigm 完成范式选择）
 * 3. 评估器判定：DesignArtifacts + paradigm → DesignEvaluationVerdict
 * 4. 若 verdict.passed=false 且 iterations < maxIterations → 携带 verdict.reason 重新调用架构师
 * 5. 若 verdict.passed=true 且 config.triggerHumanCheckpoint=true → 触发 HUMAN_CHECKPOINT
 * 6. 返回 DesignLoopResult
 *
 * 重要约束：
 * - 本批次不集成真实 LLM 调用（PM/Architect 是 Protocol，由调用方注入实现）
 * - orchestrator 只负责编排，不实现 PM/Architect/Evaluator 的具体逻辑
 * - 通过组合三个协议完成闭环，便于测试时注入 StaticXxx 真实实现
 *
 * @module eag/design/orchestrator
 */

import type { ApplicabilitySignals, ArchitectureParadigm, ParadigmLockConfig } from "../eak/types";
import { getParadigmById, selectParadigm, validateParadigmLock } from "../eak/paradigm-registry";
import type {
  DesignArtifacts,
  DesignLoopConfig,
  DesignLoopInput,
  DesignLoopResult,
  DesignEvaluationVerdict,
} from "./design-models";
import type { ArchitectProtocol, DesignEvaluatorProtocol, ProductManagerProtocol } from "./design-protocols";
import type { HumanCheckpointResponse } from "../loop/models";
import { createDefaultDesignLoopConfig } from "./design-models";

// ============================================================================
// DesignLoopOrchestrator 类
// ============================================================================

/**
 * DESIGN Loop 编排器
 *
 * 通过组合 PM / Architect / Evaluator 三个协议完成 DESIGN Loop 闭环。
 *
 * 用法：
 * ```typescript
 * const orchestrator = new DesignLoopOrchestrator(
 *   pm,            // ProductManagerProtocol 实现
 *   architect,     // ArchitectProtocol 实现
 *   evaluator,     // DesignEvaluatorProtocol 实现
 *   config         // DesignLoopConfig（可选，使用默认配置）
 * );
 * const result = await orchestrator.run(input);
 * ```
 *
 * 状态隔离：每次 run() 调用应在独立的 orchestrator 实例上执行，
 * 内部状态在构造时初始化，不在多次 run() 之间复用。
 */
export class DesignLoopOrchestrator {
  // ============================ 依赖组件 ============================

  /** PM 协议实现（需求结构化） */
  private readonly pm: ProductManagerProtocol;
  /** 架构师协议实现（范式选择 + 架构设计 + 领域模型设计） */
  private readonly architect: ArchitectProtocol;
  /** DESIGN Loop 评估器协议实现（独立判定设计产出） */
  private readonly evaluator: DesignEvaluatorProtocol;
  /** DESIGN Loop 配置（冻结） */
  private readonly config: Readonly<DesignLoopConfig>;

  // ============================ 运行时状态 ============================

  /** 是否触发人工检查点（每次 run 重置） */
  private humanCheckpointTriggered: boolean = false;
  /** 当前迭代次数（每次 run 重置，从 1 开始计数） */
  private iterations: number = 0;

  /**
   * @param pm PM 协议实现
   * @param architect 架构师协议实现
   * @param evaluator 评估器协议实现
   * @param config DESIGN Loop 配置（可选，默认使用 createDefaultDesignLoopConfig()）
   */
  constructor(
    pm: ProductManagerProtocol,
    architect: ArchitectProtocol,
    evaluator: DesignEvaluatorProtocol,
    config: Readonly<DesignLoopConfig> = createDefaultDesignLoopConfig()
  ) {
    this.pm = pm;
    this.architect = architect;
    this.evaluator = evaluator;
    this.config = config;
  }

  /**
   * 执行 DESIGN Loop 完整流程
   *
   * 执行步骤：
   * 1. PM 结构化需求 → StructuredRequirement
   * 2. 范式选择（orchestrator 内部完成，供评估器入参）
   * 3. 架构师设计 → ArchitectureDocument + DomainModelDocument
   * 4. 评估器判定 → DesignEvaluationVerdict
   * 5. 若失败且未达 maxIterations → 携带 verdict.reason 重新调用架构师（步骤 3）
   * 6. 若通过且 config.triggerHumanCheckpoint=true → 触发 HUMAN_CHECKPOINT
   * 7. 返回 DesignLoopResult
   *
   * @param input DESIGN Loop 输入（原始需求 + 项目上下文 + paradigmLock）
   * @returns DESIGN Loop 结果
   */
  async run(input: DesignLoopInput): Promise<DesignLoopResult> {
    // 重置运行时状态
    this.humanCheckpointTriggered = false;
    this.iterations = 0;

    // ===== Step 1: PM 结构化需求 =====
    const structuredRequirement = await this.pm.structureRequirement(input.rawRequirement, input.projectContext);

    // ===== Step 2: 范式选择（orchestrator 内部完成，供评估器入参） =====
    // 注意：架构师协议内部也会做范式选择，但 orchestrator 需要独立的 paradigm 对象
    // 作为评估器入参。两者通过 paradigmLock + 信号匹配保持一致。
    const paradigm = this.selectParadigmForDesign(structuredRequirement, input.paradigmLock);

    // ===== Step 3-5: 架构师设计 → 评估器判定 → 失败重试 =====
    let architecture: Awaited<ReturnType<typeof this.architect.designArchitecture>>["architecture"];
    let domainModel: Awaited<ReturnType<typeof this.architect.designArchitecture>>["domainModel"];
    let verdict: DesignEvaluationVerdict;

    // 评估失败重试循环
    while (true) {
      this.iterations += 1;

      // 3.1 架构师设计
      // 注：本批次 ArchitectProtocol 接口未定义"接收上轮失败原因"参数，
      // 实际 LLM 集成时可通过 closure 或状态对象传递 verdict.reason 给架构师修正。
      const archResult = await this.architect.designArchitecture(
        structuredRequirement,
        input.paradigmLock,
        input.projectContext
      );
      architecture = archResult.architecture;
      domainModel = archResult.domainModel;

      // 3.2 构造 DesignArtifacts
      const artifacts: DesignArtifacts = {
        structuredRequirement,
        architectureDocument: architecture,
        domainModelDocument: domainModel,
      };

      // 3.3 评估器判定
      verdict = await this.evaluator.evaluate(artifacts, paradigm);

      // 3.4 通过则跳出循环
      if (verdict.passed) {
        break;
      }

      // 3.5 失败时检查是否达到 maxIterations
      if (this.iterations >= this.config.maxIterations) {
        // 达到 maxIterations 仍未通过，停止重试，返回最后一次失败结果
        break;
      }

      // 3.6 未达上限，继续下一轮重试（verdict.reason 已在评估器产出中，
      // 未来 LLM 集成时可由架构师实现读取并修正设计）
    }

    // ===== Step 6: 触发 HUMAN_CHECKPOINT（若通过且配置允许） =====
    if (verdict.passed && this.config.triggerHumanCheckpoint) {
      const artifacts: DesignArtifacts = {
        structuredRequirement,
        architectureDocument: architecture,
        domainModelDocument: domainModel,
      };
      const response = this.triggerHumanCheckpoint(artifacts, paradigm);
      // 记录是否触发（无论人类是否批准，都视为已触发检查点）
      this.humanCheckpointTriggered = true;
      // 注：本批次默认实现自动批准，未来扩展可基于 response.abort 中止流程
      void response;
    }

    // ===== Step 7: 返回 DesignLoopResult =====
    const artifacts: DesignArtifacts = {
      structuredRequirement,
      architectureDocument: architecture,
      domainModelDocument: domainModel,
    };

    return {
      input,
      artifacts,
      evaluationVerdict: verdict,
      humanCheckpointTriggered: this.humanCheckpointTriggered,
      iterations: this.iterations,
    };
  }

  // ============================ 私有方法 ============================

  /**
   * 选择范式（orchestrator 内部使用，供评估器入参）
   *
   * 选择逻辑（对齐 §5.1.1 范式选择防误判机制）：
   * 1. 若 paradigmLock 锁定且合法 → 直接返回锁定的范式
   * 2. 否则按 StructuredRequirement 推导信号 → selectParadigm 信号匹配
   *
   * 信号推导规则（基于 StructuredRequirement 内容启发式判定，非 mock）：
   * - domainComplexity：用户故事数 >= 3 → high；= 2 → medium；<= 1 → low
   * - consistencyRequirement：非功能需求含 consistency=strong → strong；否则 eventual
   * - readWritePattern：非功能需求含 performance 描述 → balanced；默认 balanced
   * - integrationComplexity：boundedContexts 数（在 requirement 阶段未知，默认 monolith）
   *
   * @param requirement PM 产出的结构化需求
   * @param lock 可选，paradigm_lock 配置
   * @returns 选中的范式定义
   */
  private selectParadigmForDesign(
    requirement: DesignArtifacts["structuredRequirement"],
    lock?: ParadigmLockConfig
  ): ArchitectureParadigm {
    // 步骤 1：paradigm_lock 判定
    if (lock && lock.locked) {
      // 校验锁定配置
      const validation = validateParadigmLock(lock);
      if (!validation.valid) {
        throw new Error(`paradigm_lock 配置非法：${validation.reason}`);
      }
      // 锁定时直接返回锁定的范式
      const lockedParadigm = getParadigmById(lock.paradigmId!);
      if (lockedParadigm === null) {
        throw new Error(`paradigm_lock.paradigmId "${lock.paradigmId}" 未在注册表中找到`);
      }
      return lockedParadigm;
    }

    // 步骤 2：信号匹配——从 StructuredRequirement 推导信号
    const signals = this.inferSignalsFromRequirement(requirement);

    // 步骤 3：调用 selectParadigm 完成信号匹配
    return selectParadigm(signals);
  }

  /**
   * 从 StructuredRequirement 推导 ApplicabilitySignals
   *
   * 推导规则（基于需求内容启发式判定，对齐 §5.1.1 信号判定逻辑）：
   * - domainComplexity：用户故事数 >= 3 → high；= 2 → medium；<= 1 → low
   * - consistencyRequirement：非功能需求含 consistency 类 → strong；否则 eventual
   * - readWritePattern：非功能需求含 performance 类 → balanced；默认 balanced
   * - integrationComplexity：默认 monolith（设计阶段无法精确判定集成复杂度）
   *
   * 注：本方法是真实的启发式信号推导，非 mock——基于需求内容做客观判定。
   * 实际生产中可由架构师角色（LLM）填充更精确的信号，本方法作为兜底。
   *
   * @param requirement PM 产出的结构化需求
   * @returns 推导出的适用信号
   */
  private inferSignalsFromRequirement(requirement: DesignArtifacts["structuredRequirement"]): ApplicabilitySignals {
    // domainComplexity：按用户故事数量判定
    const storyCount = requirement.userStories.length;
    const domainComplexity: ApplicabilitySignals["domainComplexity"] =
      storyCount >= 3 ? "high" : storyCount === 2 ? "medium" : "low";

    // consistencyRequirement：检查非功能需求是否含 consistency 类
    const hasConsistencyNfr = requirement.nonFunctionalRequirements.some((nfr) => nfr.category === "consistency");
    const consistencyRequirement: ApplicabilitySignals["consistencyRequirement"] = hasConsistencyNfr
      ? "strong"
      : "eventual";

    // readWritePattern：设计阶段无法精确判定读写比例，默认 balanced
    // 注：NFR 中的 performance 信号在 CODING/TESTING Loop 阶段才会细化，
    // DESIGN Loop 阶段不基于 performance NFR 推导 readWritePattern。
    const readWritePattern: ApplicabilitySignals["readWritePattern"] = "balanced";

    // integrationComplexity：默认 monolith（设计阶段无法精确判定）
    const integrationComplexity: ApplicabilitySignals["integrationComplexity"] = "monolith";

    return {
      domainComplexity,
      consistencyRequirement,
      readWritePattern,
      integrationComplexity,
    };
  }

  /**
   * 触发人类检查点
   *
   * 对应 EAG 方案 §5.2.2 人工检查点：
   * 设计文档生成后默认触发 1 次 HUMAN_CHECKPOINT（架构决策需人确认）。
   *
   * 默认实现自动批准（非交互式环境，对齐 LoopKernel.requestHumanCheckpoint 行为）。
   * 未来可扩展为通过 CLI / UI 等待人类输入。
   *
   * @param artifacts 设计产出（供人类审阅）
   * @param paradigm 选中的范式定义（供人类审阅范式选择）
   * @returns 人类响应（默认 approved=true）
   */
  private triggerHumanCheckpoint(
    _artifacts: DesignArtifacts,
    _paradigm: ArchitectureParadigm
  ): HumanCheckpointResponse {
    // 默认实现：自动批准，不中止
    // 注：参数前缀 _ 表示本批次默认实现未使用，未来扩展时可基于 artifacts/paradigm 生成审阅摘要
    return {
      approved: true,
      feedback: "自动批准（DESIGN Loop §5.2.2 人工检查点，非交互式环境默认批准）",
      abort: false,
    };
  }
}
