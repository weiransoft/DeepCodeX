/**
 * EAG-P6 Phase 3 角色 prompt 定制器（RolePromptCustomizer）
 *
 * 本模块基于 RoleSignal 选择主角色 + 协作角色，注入角色 phaseKnowledgeSlice，
 * 生成角色身份 prompt + 阶段知识 prompt，供 FiveStagePromptAssembler 拼接到
 * TaskContext / HistoricalExperience 段。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §2 US-2（AC-2.1~AC-2.5：五段式 prompt + phaseKnowledgeSlice
 *   按阶段动态拼接 + skill 融合关键内容）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 3（RolePromptCustomizer）
 *   + §4 模块清单（D-4 phaseKnowledgeSlice 静态化 + 运行时拼接）
 * - EAG-P6-TASKS.md §3 TASK-P6-3-03（RolePromptCustomizer）
 * - EAG-P6-TEST-CASES.md TC-ROLE-001~025（5 角色 skill 融合断言）
 *
 * 主要接口：
 *   1. customize(role, phase) → RolePromptCustomization
 *      - 单角色定制：仅注入主角色 phaseKnowledgeSlice，无协作角色
 *      - 用于已知主角色、无需 RoleSignal 检测的场景
 *
 *   2. customizeFromSignals(signals, phase) → RolePromptCustomization
 *      - 多角色定制：基于 RoleSignal[] 选择主角色 + 协作角色
 *      - 主角色 = signals[0].role（confidence 最高）
 *      - 协作角色 = signals[1..maxCollaborators+1].role（confidence 排名 2-N）
 *      - 协作角色数量上限：DEFAULT_MAX_COLLABORATORS = 2
 *
 * 输出 RolePromptCustomization 字段：
 *   - primaryRole          ：主角色 ID
 *   - primarySlice         ：主角色 phaseKnowledgeSlice
 *   - collaboratorRoles    ：协作角色 ID 列表（可能为空）
 *   - collaboratorSlices   ：协作角色 phaseKnowledgeSlice 列表（与 collaboratorRoles 一一对应）
 *   - karpathyPreamble     ：Karpathy 4 原则 + Ponytail 16 红线前缀
 *   - roleIdentityPrompt   ：角色身份 prompt（主角色 + 协作角色身份说明）
 *   - phaseKnowledgePrompt ：阶段知识 prompt（主角色 + 协作角色切片拼接）
 *   - fullPrompt            ：完整角色 prompt（karpathyPreamble + roleIdentityPrompt + phaseKnowledgePrompt）
 *
 * skill 融合关键内容（AC-2.5，由 PHASE_KNOWLEDGE_SLICES 保证）：
 * - architect         ：含 "四步分析框架"
 * - product_manager   ：含 "bite-sized" 与 "每步 2-5 分钟可验证"
 * - solo_coder        ：含 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
 * - test_expert       ：含 "假设→插桩→复现→分析→修复→验证"
 * - ui_designer       ：含 "反 AI-slop" 与禁用字体清单
 *
 * 不可变优先原则（对齐 NFR-8）：
 * - 所有公开接口 readonly + ReadonlyArray + Object.freeze
 * - 输出 RolePromptCustomization 已 Object.freeze
 *
 * @module v2/prompt/role-prompt-customizer
 */

// 导入类型与常量
// P1-05 单一入口约束：V1 能力（KARPATHY_PREAMBLE）统一从 v1-adapters 导入
import { KARPATHY_PREAMBLE } from "../integration/v1-adapters.js";
import type { RoleKind, RolePhase, PhaseKnowledgeSlice } from "./role-knowledge-slices.js";
import { ROLE_KINDS, getPhaseKnowledgeSlice } from "./role-knowledge-slices.js";
import type { RoleSignal } from "./role-signal-detector.js";

// ============================================================================
// 1. 类型定义
// ============================================================================

/**
 * 角色 prompt 定制结果（RolePromptCustomization）
 *
 * 包含主角色 + 协作角色的 phaseKnowledgeSlice 注入，以及拼接好的
 * 角色 prompt 字符串（供 FiveStagePromptAssembler 直接使用）。
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后 Object.freeze。
 */
export interface RolePromptCustomization {
  /** 主角色 ID（architect / product_manager / solo_coder / test_expert / ui_designer） */
  readonly primaryRole: RoleKind;
  /** 主角色 phaseKnowledgeSlice（已冻结） */
  readonly primarySlice: PhaseKnowledgeSlice;
  /** 协作角色 ID 列表（按 confidence 降序，可能为空） */
  readonly collaboratorRoles: ReadonlyArray<RoleKind>;
  /** 协作角色 phaseKnowledgeSlice 列表（与 collaboratorRoles 一一对应） */
  readonly collaboratorSlices: ReadonlyArray<PhaseKnowledgeSlice>;
  /** Karpathy 4 原则 + Ponytail 16 红线前缀（共享常量） */
  readonly karpathyPreamble: string;
  /** 角色身份 prompt（主角色 + 协作角色身份说明） */
  readonly roleIdentityPrompt: string;
  /** 阶段知识 prompt（主角色 + 协作角色切片拼接） */
  readonly phaseKnowledgePrompt: string;
  /** 完整角色 prompt（karpathyPreamble + roleIdentityPrompt + phaseKnowledgePrompt） */
  readonly fullPrompt: string;
  /** Loop 阶段（design / coding / testing / handover） */
  readonly phase: RolePhase;
}

/**
 * 角色 prompt 定制器选项
 *
 * 用于控制协作角色数量上限等参数。
 */
export interface RolePromptCustomizerOptions {
  /** 协作角色数量上限（默认 2） */
  readonly maxCollaborators: number;
  /** 主角色置信度阈值（默认 0，表示只要 signals 非空就取第一个） */
  readonly primaryConfidenceThreshold: number;
  /** 协作角色置信度阈值（默认 0.1，低于此值的角色不作为协作角色） */
  readonly collaboratorConfidenceThreshold: number;
}

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 默认定制器选项
 *
 * - maxCollaborators = 2：最多 2 个协作角色（避免 prompt 过长）
 * - primaryConfidenceThreshold = 0：只要 signals 非空就取第一个为主角色
 * - collaboratorConfidenceThreshold = 0.1：协作角色置信度至少 0.1
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_CUSTOMIZER_OPTIONS: Readonly<RolePromptCustomizerOptions> = Object.freeze({
  maxCollaborators: 2,
  primaryConfidenceThreshold: 0,
  collaboratorConfidenceThreshold: 0.1,
});

/**
 * 5 角色身份描述（用于 roleIdentityPrompt 拼接）
 *
 * 与 multi-agent-team skill v2.7 的角色职责说明对齐。
 * 使用 Object.freeze 冻结。
 */
export const ROLE_IDENTITY_DESCRIPTIONS: Readonly<Record<RoleKind, string>> = Object.freeze({
  architect:
    "架构师（Architect）：负责设计系统性、前瞻性、可落地、可验证的架构。" +
    "使用四步分析框架（架构风格识别→核心组件→技术栈→扩展性评估）系统化推进。" +
    "输出 ADR + 接口定义 + 风险登记表。",
  product_manager:
    "产品经理（Product Manager）：负责定义用户价值清晰、需求明确、可落地、可验收的产品。" +
    "采用 bite-sized 任务粒度（每步 2-5 分钟可验证），将需求拆解为可执行的用户故事。" +
    "输出 PRD + 验收标准 + 优先级排序。",
  solo_coder:
    "独立开发者（Solo Coder）：负责编写完整、高质量、可维护、可测试的代码。" +
    "严格遵循 TDD 铁律：NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST。" +
    "采用 Karpathy Simplicity First + Surgical Changes 原则，最小代码、精准修改。",
  test_expert:
    "测试专家（Test Expert）：负责确保全面、深入、自动化、可量化的质量保障。" +
    "采用证据驱动调试法：假设→插桩→复现→分析→修复→验证。" +
    "输出测试用例 + 自动化脚本 + 质量门禁报告。",
  ui_designer:
    "UI 设计师（UI Designer）：负责创建独特、生产级的 UI 界面，高设计质量，" +
    '避免通用的 AI "slop" 美学。禁用字体清单：Inter / Roboto / Arial / system-ui。' +
    "采用 Bold aesthetic direction，输出视觉规范 + 设计系统 + UI 原型。",
});

// ============================================================================
// 3. 辅助函数
// ============================================================================

/**
 * 格式化单个 PhaseKnowledgeSlice 为可读字符串
 *
 * 格式：
 * ```
 * 【角色名 · 阶段】
 * 阶段目标：...
 * 关键检查项：
 *   - ...
 *   - ...
 * 常见陷阱：
 *   - ...
 *   - ...
 * 输出格式：...
 * 历史经验：...
 * ```
 *
 * @param slice PhaseKnowledgeSlice
 * @returns 格式化后的字符串
 */
function formatPhaseKnowledgeSlice(slice: PhaseKnowledgeSlice): string {
  const keyChecksText = slice.keyChecks.map((c) => `  - ${c}`).join("\n");
  const pitfallsText = slice.commonPitfalls.map((p) => `  - ${p}`).join("\n");
  return (
    `【${slice.role} · ${slice.phase}】\n` +
    `阶段目标：${slice.phaseGoal}\n` +
    `关键检查项：\n${keyChecksText}\n` +
    `常见陷阱：\n${pitfallsText}\n` +
    `输出格式：${slice.outputFormat}\n` +
    `历史经验：${slice.historicalExperience}`
  );
}

/**
 * 构建角色身份 prompt
 *
 * 格式：
 * ```
 * # 角色身份
 *
 * ## 主角色
 * <主角色身份描述>
 *
 * ## 协作角色
 * ### 协作角色 1：xxx
 * <协作角色 1 身份描述>
 * ### 协作角色 2：xxx
 * <协作角色 2 身份描述>
 * ```
 *
 * 若无协作角色，则省略 "## 协作角色" 段。
 *
 * @param primaryRole 主角色
 * @param collaboratorRoles 协作角色列表
 * @returns 角色身份 prompt 字符串
 */
function buildRoleIdentityPrompt(primaryRole: RoleKind, collaboratorRoles: ReadonlyArray<RoleKind>): string {
  const primaryDesc = ROLE_IDENTITY_DESCRIPTIONS[primaryRole];
  let prompt = `# 角色身份\n\n## 主角色\n${primaryDesc}`;
  if (collaboratorRoles.length > 0) {
    prompt += "\n\n## 协作角色";
    for (let i = 0; i < collaboratorRoles.length; i++) {
      const role = collaboratorRoles[i];
      if (role === undefined) continue;
      const desc = ROLE_IDENTITY_DESCRIPTIONS[role];
      prompt += `\n### 协作角色 ${i + 1}：${role}\n${desc}`;
    }
  }
  return prompt;
}

/**
 * 构建阶段知识 prompt
 *
 * 格式：
 * ```
 * # 阶段知识切片（phaseKnowledgeSlice）
 *
 * ## 主角色切片
 * <主角色 phaseKnowledgeSlice 格式化文本>
 *
 * ## 协作角色切片
 * ### 协作角色 1 切片：xxx
 * <协作角色 1 phaseKnowledgeSlice 格式化文本>
 * ```
 *
 * 若无协作角色，则省略 "## 协作角色切片" 段。
 *
 * @param primarySlice 主角色切片
 * @param collaboratorSlices 协作角色切片列表
 * @returns 阶段知识 prompt 字符串
 */
function buildPhaseKnowledgePrompt(
  primarySlice: PhaseKnowledgeSlice,
  collaboratorSlices: ReadonlyArray<PhaseKnowledgeSlice>
): string {
  const primaryText = formatPhaseKnowledgeSlice(primarySlice);
  let prompt = `# 阶段知识切片（phaseKnowledgeSlice）\n\n## 主角色切片\n${primaryText}`;
  if (collaboratorSlices.length > 0) {
    prompt += "\n\n## 协作角色切片";
    for (let i = 0; i < collaboratorSlices.length; i++) {
      const slice = collaboratorSlices[i];
      if (slice === undefined) continue;
      const text = formatPhaseKnowledgeSlice(slice);
      prompt += `\n### 协作角色 ${i + 1} 切片：${slice.role}\n${text}`;
    }
  }
  return prompt;
}

// ============================================================================
// 4. 主类 RolePromptCustomizer
// ============================================================================

/**
 * 角色 prompt 定制器
 *
 * 主入口：
 *   1. customize(role, phase) → RolePromptCustomization
 *   2. customizeFromSignals(signals, phase) → RolePromptCustomization
 *
 * 工作流程：
 * 1. 确定主角色（直接指定或从 signals[0] 取）
 * 2. 确定协作角色（从 signals[1..maxCollaborators+1] 取，过滤低置信度）
 * 3. 查询主角色 + 协作角色的 phaseKnowledgeSlice
 * 4. 拼接角色身份 prompt + 阶段知识 prompt
 * 5. 返回 RolePromptCustomization（已冻结）
 *
 * 不可变优先：
 * - options 在构造时 Object.freeze
 * - 输出 RolePromptCustomization 已 Object.freeze
 */
export class RolePromptCustomizer {
  /** 定制器选项（已冻结） */
  private readonly options: Readonly<RolePromptCustomizerOptions>;

  /**
   * 构造函数
   *
   * @param options 定制器选项（可选，默认使用 DEFAULT_CUSTOMIZER_OPTIONS）
   */
  constructor(options?: Partial<RolePromptCustomizerOptions>) {
    this.options = Object.freeze({
      ...DEFAULT_CUSTOMIZER_OPTIONS,
      ...options,
    });
  }

  /**
   * 单角色定制：仅注入主角色 phaseKnowledgeSlice，无协作角色
   *
   * 适用场景：
   * - 已知主角色、无需 RoleSignal 检测的场景
   * - 测试场景：直接指定角色 + 阶段，验证 phaseKnowledgeSlice 注入
   *
   * @param role 主角色 ID
   * @param phase Loop 阶段（design / coding / testing / handover）
   * @returns RolePromptCustomization（已冻结）
   * @throws {Error} role 或 phase 非法时抛错（由 getPhaseKnowledgeSlice 校验）
   */
  customize(role: RoleKind, phase: RolePhase): RolePromptCustomization {
    // ---------- 1. 校验主角色 ----------
    if (!ROLE_KINDS.includes(role)) {
      throw new Error(`非法 RoleKind: ${String(role)}，合法值: ${ROLE_KINDS.join(" / ")}`);
    }

    // ---------- 2. 查询主角色切片 ----------
    const primarySlice = getPhaseKnowledgeSlice(role, phase);

    // ---------- 3. 单角色定制：无协作角色 ----------
    const collaboratorRoles: ReadonlyArray<RoleKind> = Object.freeze([]);
    const collaboratorSlices: ReadonlyArray<PhaseKnowledgeSlice> = Object.freeze([]);

    // ---------- 4. 拼接 prompt ----------
    return this.buildCustomization(role, primarySlice, collaboratorRoles, collaboratorSlices, phase);
  }

  /**
   * 多角色定制：基于 RoleSignal[] 选择主角色 + 协作角色
   *
   * 主角色选择规则：
   * - 取 signals[0].role（confidence 最高，signals 已按 confidence 降序排序）
   * - 若 signals 为空，抛错（无法选择主角色）
   * - 若 signals[0].confidence < primaryConfidenceThreshold，抛错（主角色置信度不足）
   *
   * 协作角色选择规则：
   * - 从 signals[1..maxCollaborators+1] 中选取
   * - 过滤 confidence < collaboratorConfidenceThreshold 的角色
   * - 过滤与主角色相同的角色（避免重复）
   * - 最多选取 maxCollaborators 个协作角色
   *
   * @param signals RoleSignal 列表（应按 confidence 降序排序，由 RoleSignalDetector.detect 保证）
   * @param phase Loop 阶段（design / coding / testing / handover）
   * @returns RolePromptCustomization（已冻结）
   * @throws {Error} signals 为空或主角色置信度不足时抛错
   */
  customizeFromSignals(signals: ReadonlyArray<RoleSignal>, phase: RolePhase): RolePromptCustomization {
    // ---------- 1. 校验 signals 非空 ----------
    if (signals.length === 0) {
      throw new Error("signals 不能为空：customizeFromSignals 需要至少 1 个 RoleSignal 来选择主角色");
    }

    // ---------- 2. 选择主角色（signals[0]） ----------
    const primarySignal = signals[0];
    if (primarySignal === undefined) {
      // 防御性处理：signals[0] 不应为 undefined（已校验 length > 0）
      throw new Error("signals[0] 不应为 undefined");
    }
    if (primarySignal.confidence < this.options.primaryConfidenceThreshold) {
      throw new Error(
        `主角色置信度不足：${primarySignal.confidence} < ${this.options.primaryConfidenceThreshold}（${primarySignal.role}）`
      );
    }
    const primaryRole = primarySignal.role;

    // ---------- 3. 查询主角色切片 ----------
    const primarySlice = getPhaseKnowledgeSlice(primaryRole, phase);

    // ---------- 4. 选择协作角色 ----------
    const collaboratorRoles: RoleKind[] = [];
    const collaboratorSlices: PhaseKnowledgeSlice[] = [];
    const seenRoles = new Set<RoleKind>([primaryRole]); // 用于去重（避免主角色与协作角色相同）

    for (let i = 1; i < signals.length; i++) {
      // 达到协作角色数量上限，停止
      if (collaboratorRoles.length >= this.options.maxCollaborators) {
        break;
      }
      const signal = signals[i];
      if (signal === undefined) continue;
      // 过滤置信度不足的角色
      if (signal.confidence < this.options.collaboratorConfidenceThreshold) {
        continue;
      }
      // 过滤与主角色或已选协作角色相同的角色
      if (seenRoles.has(signal.role)) {
        continue;
      }
      // 加入协作角色列表
      collaboratorRoles.push(signal.role);
      seenRoles.add(signal.role);
      // 查询协作角色切片
      collaboratorSlices.push(getPhaseKnowledgeSlice(signal.role, phase));
    }

    // ---------- 5. 拼接 prompt ----------
    return this.buildCustomization(
      primaryRole,
      primarySlice,
      Object.freeze(collaboratorRoles),
      Object.freeze(collaboratorSlices),
      phase
    );
  }

  /**
   * 构建 RolePromptCustomization（内部共用方法）
   *
   * @param primaryRole 主角色
   * @param primarySlice 主角色切片
   * @param collaboratorRoles 协作角色列表（已冻结）
   * @param collaboratorSlices 协作角色切片列表（已冻结）
   * @param phase Loop 阶段
   * @returns RolePromptCustomization（已冻结）
   */
  private buildCustomization(
    primaryRole: RoleKind,
    primarySlice: PhaseKnowledgeSlice,
    collaboratorRoles: ReadonlyArray<RoleKind>,
    collaboratorSlices: ReadonlyArray<PhaseKnowledgeSlice>,
    phase: RolePhase
  ): RolePromptCustomization {
    // ---------- 1. 拼接角色身份 prompt ----------
    const roleIdentityPrompt = buildRoleIdentityPrompt(primaryRole, collaboratorRoles);

    // ---------- 2. 拼接阶段知识 prompt ----------
    const phaseKnowledgePrompt = buildPhaseKnowledgePrompt(primarySlice, collaboratorSlices);

    // ---------- 3. 拼接完整 prompt ----------
    const fullPrompt = `${KARPATHY_PREAMBLE}\n\n${roleIdentityPrompt}\n\n${phaseKnowledgePrompt}`;

    // ---------- 4. 构建并冻结 RolePromptCustomization ----------
    return Object.freeze({
      primaryRole,
      primarySlice,
      collaboratorRoles,
      collaboratorSlices,
      karpathyPreamble: KARPATHY_PREAMBLE,
      roleIdentityPrompt,
      phaseKnowledgePrompt,
      fullPrompt,
      phase,
    });
  }

  /**
   * 获取定制器选项（已冻结，不可变）
   *
   * @returns 定制器选项的只读副本
   */
  getOptions(): Readonly<RolePromptCustomizerOptions> {
    return this.options;
  }
}

// ============================================================================
// 5. 顶层便捷函数
// ============================================================================

/**
 * 顶层便捷函数：单角色定制
 *
 * 使用默认选项创建 RolePromptCustomizer 实例并执行 customize()。
 *
 * @param role 主角色 ID
 * @param phase Loop 阶段（design / coding / testing / handover）
 * @returns RolePromptCustomization（已冻结）
 */
export function customizeRolePrompt(role: RoleKind, phase: RolePhase): RolePromptCustomization {
  const customizer = new RolePromptCustomizer();
  return customizer.customize(role, phase);
}

/**
 * 顶层便捷函数：多角色定制（基于 RoleSignal[]）
 *
 * 使用默认选项创建 RolePromptCustomizer 实例并执行 customizeFromSignals()。
 *
 * @param signals RoleSignal 列表（应按 confidence 降序排序）
 * @param phase Loop 阶段（design / coding / testing / handover）
 * @returns RolePromptCustomization（已冻结）
 */
export function customizeRolePromptFromSignals(
  signals: ReadonlyArray<RoleSignal>,
  phase: RolePhase
): RolePromptCustomization {
  const customizer = new RolePromptCustomizer();
  return customizer.customizeFromSignals(signals, phase);
}
