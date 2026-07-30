/**
 * G-4 进入门禁检查器（EAG-P2 批次 9 S3 核心组件层）
 *
 * 本模块实现 `GateG4Checker` 类，对应 EAG-P2 批次 9 设计 §4.8.2 G-4 门禁：
 * "CODING Loop 进入门禁——任务卡完整性 + 模板可用性 + 技术栈锁定 + 输出目录可写"。
 *
 * 核心职责（对齐 §4.8.2）：
 * G-4 在 G-1/G-2/G-3 通过基础上，额外校验 Phase A 骨架生成的前置条件：
 * 1. tasks.md 状态机为 approved（任务卡清单已批准）
 * 2. taskCard.declaredSymbols 非空（任务卡已声明受影响符号）
 * 3. taskCard.acceptanceCriteria 非空（任务卡已定义验收标准）
 * 4. fileCluster 非空（任务卡所属文件簇名已确定）
 * 5. requiredTemplateKinds 非空且全部在 TemplateRegistry 中已注册
 * 6. techStack 非空（技术栈锁定清单已配置）
 * 7. outputDir 非空（输出目录已配置）
 *
 * 任一失败 → 返回 passed=false, severity=blocker
 *
 * 设计依据：
 * - EAG-P2 批次 9 设计 §4.8.1 设计依据
 *   （基于 §5.10.5 三 Loop 时序与 §5.12.2 里程碑检查点合理外推）
 * - EAG-P2 批次 9 设计 §4.8.2 G-4 门禁判定规则
 * - EAG-P2 批次 9 设计 §4.8.4 GateG4Context 扩展字段
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 公开方法返回冻结对象
 * - 构造时注入的 TemplateRegistry 使用 readonly 包裹
 * - check() 返回的 GateResult 通过 Object.freeze 冻结
 *
 * @module eag/gate/gate-g4-checker
 */

import type { GateChecker, GateContext, GateResult, GateG4Context } from "./gate-types";
import type { TemplateRegistry, GeneratedFileKind } from "../coding/types";
import { DEFAULT_TEMPLATE_REGISTRY } from "../coding/templates/index";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-4 门禁失败时的引导消息（建议补齐任务卡完整性后重试）
 *
 * 对齐 §4.8.1 G-4 门禁失败处置：当任务卡完整性 / 模板可用性 / 技术栈 / 输出目录
 * 任一不满足时，CODING Loop 不得启动 Phase A 骨架生成，
 * 应回退到 CODING Loop 首轮（plan.md / tasks.md 生成阶段）补齐缺失字段。
 */
const G4_FAILURE_GUIDANCE: string =
  "建议回退到 CODING Loop 首轮，补齐 tasks.md 批准 / 任务卡 declaredSymbols / acceptanceCriteria / " +
  "fileCluster / requiredTemplateKinds / techStack / outputDir 后重试 G-4 门禁";

// ============================================================================
// GateG4Checker 类
// ============================================================================

/**
 * G-4 门禁检查器
 *
 * 实现 §4.8.2 G-4 门禁：CODING Loop 进入门禁。
 *
 * 检查规则（对齐 §4.8.2 判定规则）：
 * 1. context.tasksStatus 必须为 "approved"（tasks.md 已批准）
 * 2. context.taskCard.declaredSymbols 必须非空（任务卡已声明受影响符号）
 * 3. context.taskCard.acceptanceCriteria 必须非空（任务卡已定义验收标准）
 * 4. context.fileCluster 必须为非空字符串（任务卡所属文件簇名已确定）
 * 5. context.requiredTemplateKinds 必须非空且全部在 TemplateRegistry.listKinds() 中
 * 6. context.techStack 必须为非空数组（技术栈锁定清单已配置）
 * 7. context.outputDir 必须为非空字符串（输出目录已配置）
 *
 * 任一失败 → 返回 passed=false, severity=blocker
 *
 * 使用方式：
 * ```typescript
 * const checker = new GateG4Checker();
 * const result = checker.check(g4Context);
 * if (!result.passed) {
 *   // 阻止进入 Phase A 骨架生成，回退到 CODING Loop 首轮
 * }
 * ```
 *
 * 注：G-4 上下文（GateG4Context）继承自 GateContext，扩展了
 * tasksStatus / fileCluster / requiredTemplateKinds / techStack / outputDir 字段。
 * 调用方在装配 GateG4Context 时应确保所有字段已填充。
 */
export class GateG4Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-4"） */
  public readonly gateId = "G-4" as const;

  /**
   * 模板注册表（用于校验 requiredTemplateKinds 是否全部已注册）
   *
   * 默认为 DEFAULT_TEMPLATE_REGISTRY（13 种内置模板）。
   * 测试场景可注入自定义注册表以验证扩展模板。
   */
  private readonly templateRegistry: Readonly<TemplateRegistry>;

  /**
   * 初始化 G-4 门禁检查器
   *
   * @param templateRegistry 模板注册表（默认 DEFAULT_TEMPLATE_REGISTRY）
   */
  constructor(templateRegistry: Readonly<TemplateRegistry> = DEFAULT_TEMPLATE_REGISTRY) {
    this.templateRegistry = templateRegistry;
  }

  /**
   * 执行 G-4 门禁检查
   *
   * 检查顺序（短路求值，首个失败即返回）：
   * 1. tasksStatus === "approved"
   * 2. taskCard.declaredSymbols 非空
   * 3. taskCard.acceptanceCriteria 非空
   * 4. fileCluster 非空字符串
   * 5. requiredTemplateKinds 非空且全部在 TemplateRegistry 中已注册
   * 6. techStack 非空数组
   * 7. outputDir 非空字符串
   *
   * @param context 门禁上下文（GateG4Context，含 G-4 扩展字段）
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过）
   */
  public check(context: GateContext): GateResult {
    // G-4 上下文需为 GateG4Context（含扩展字段）
    // 由于 GateChecker 协议定义 check(context: GateContext)，此处需类型断言
    const g4Context = context as GateG4Context;

    // 检查 1：tasksStatus 必须为 approved
    if (g4Context.tasksStatus !== "approved") {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `tasks.md 状态为 "${g4Context.tasksStatus}"，未批准（G-4 要求 tasks.md 已批准方可进入 Phase A）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 2：taskCard.declaredSymbols 必须非空
    const declaredSymbols = g4Context.taskCard.declaredSymbols;
    if (!Array.isArray(declaredSymbols) || declaredSymbols.length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `taskCard.declaredSymbols 为空（任务卡 "${g4Context.taskCard.id}" 必须声明受影响符号列表，对齐 §5.12.4 A-3 任务范围锁）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 3：taskCard.acceptanceCriteria 必须非空
    const acceptanceCriteria = g4Context.taskCard.acceptanceCriteria;
    if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `taskCard.acceptanceCriteria 为空（任务卡 "${g4Context.taskCard.id}" 必须定义可执行的验收标准）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 4：fileCluster 必须为非空字符串
    const fileCluster = g4Context.fileCluster;
    if (typeof fileCluster !== "string" || fileCluster.trim().length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `fileCluster 为空（任务卡 "${g4Context.taskCard.id}" 必须确定所属文件簇名，对应 plan.md 中的 ModuleSplit.moduleName）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 5：requiredTemplateKinds 必须非空且全部在 TemplateRegistry 中已注册
    const requiredKinds = g4Context.requiredTemplateKinds;
    if (!Array.isArray(requiredKinds) || requiredKinds.length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `requiredTemplateKinds 为空（任务卡 "${g4Context.taskCard.id}" 必须确定需要的模板 kind 列表）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 校验每个 kind 是否在 TemplateRegistry 中注册
    const registeredKinds = new Set<GeneratedFileKind>(this.templateRegistry.listKinds());
    const unregisteredKinds: GeneratedFileKind[] = [];
    for (const kind of requiredKinds) {
      if (!registeredKinds.has(kind)) {
        unregisteredKinds.push(kind);
      }
    }
    if (unregisteredKinds.length > 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `requiredTemplateKinds 中有未注册的模板 kind：${unregisteredKinds.join(", ")}（已注册：${Array.from(registeredKinds).join(", ")}）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 6：techStack 必须为非空数组
    const techStack = g4Context.techStack;
    if (!Array.isArray(techStack) || techStack.length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `techStack 为空（CONSTITUTION.techStackLocks 必须配置技术栈锁定清单，未经用户批准不得变更）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 7：outputDir 必须为非空字符串
    const outputDir = g4Context.outputDir;
    if (typeof outputDir !== "string" || outputDir.trim().length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-4",
        reason: `outputDir 为空（必须配置输出目录，骨架文件将写入此目录）`,
        guidance: G4_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 全部通过
    return Object.freeze({
      passed: true,
      gate: "G-4",
      reason:
        `G-4 门禁通过：tasks.md 已批准，任务卡 "${g4Context.taskCard.id}" 完整性校验通过，` +
        `fileCluster="${fileCluster}"，requiredTemplateKinds=${requiredKinds.length} 个，` +
        `techStack=${techStack.length} 项，outputDir="${outputDir}"`,
      severity: "blocker",
    }) as GateResult;
  }
}
