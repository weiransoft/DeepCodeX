/**
 * 方案先行门禁类型定义（EAG-P2 批次 8 + 批次 9 + EAG-P3 批次 10）
 *
 * 本模块定义 EAG 方案 §5.12.1 方案先行门禁（Spec-First Gate）所需的全部结构化数据类型。
 * 门禁将"每次写代码前必先写方案、评审方案、按方案执行"从纪律变为系统门禁。
 *
 * 七道门禁：
 * - G-1：无已批准 spec/plan 禁入 CODING Loop（批次 8）
 * - G-2：方案必经多角色评审 + 用户批准（批次 8）
 * - G-3：方案偏离检测（任务卡声明变更 vs 实际变更）（批次 8）
 * - G-4：CODING Loop 进入门禁（任务卡完整性 + 模板可用性 + 技术栈锁定）（批次 9）
 * - G-5：CODING Loop 退出门禁（任务卡全 completed + STRICT 通过 + git clean + gitleaks）（批次 9）
 * - G-6：TESTING Loop 进入门禁（G-5 通过 + 单测全过 + spec.md approved + implementationRoot 非空）（批次 10）
 * - G-7：TESTING Loop 退出门禁（覆盖率达标 + 契约/E2E 测试全过 + 合规证据完整 + PR 描述就绪）（批次 10）
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 方案先行门禁
 * - §5.10.1 文档即门禁（文档状态机作为 Loop 流转条件）
 * - §5.12.4 A-3 任务范围锁（G-3 偏离检测的 autonomous 强化）
 * - §5.10.5 三 Loop 时序（design / coding / testing）
 * - EAG-P2 批次 9 §4.8 G-4/G-5 CODING Loop 进入与退出门禁
 * - EAG-P3 批次 10 §4.8 G-6/G-7 TESTING Loop 进入与退出门禁
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/gate/gate-types
 */

// ============================================================================
// 1. 共享类型：复用 doc-driven/types.ts 中已定义的 DocumentState 与 TaskCard
// ============================================================================

import type { DocumentState, TaskCard } from "../doc-driven/types";
import type { EvaluationReport } from "../evaluator/types";
import type { GeneratedFileKind } from "../coding/types";
// 复用 testing/types.ts 中已定义的 CoverageReport 与 GeneratedTestFile，
// 避免在 gate 模块内重复定义（DRY 原则 + 单一数据源）。
import type { CoverageReport, GeneratedTestFile } from "../testing/types";

/**
 * 文档状态类型（复用 doc-driven/types.ts 中的 DocumentState）
 *
 * 状态值：draft / reviewing / approved / rejected
 */
export type { DocumentState, TaskCard };

// 复用 testing/types.ts 中的 CoverageReport 与 GeneratedTestFile 类型，
// 重新导出供 gate 模块外部消费者从 gate/gate-types 统一导入。
export type { CoverageReport, GeneratedTestFile };

// ============================================================================
// 2. 评审记录类型
// ============================================================================

/**
 * 评审角色（字面量联合类型，对齐 §5.12.1 G-2 多角色评审要求）
 *
 * 四角色覆盖方案评审的完整视角：
 * - architect：架构师（系统设计 / 范式一致性 / 技术选型合理性）
 * - pm：产品经理（需求覆盖 / 优先级 / 验收标准可执行性）
 * - test-expert：测试专家（可测试性 / 验收卡 / 风险驱动用例）
 * - solo-coder：独立开发者（可实施性 / 工作量评估 / 技术债）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type ReviewRole = "architect" | "pm" | "test-expert" | "solo-coder";

/**
 * ReviewRole 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结。顺序对齐 §5.12.1 G-2 多角色评审 4 角色顺序。
 */
export const REVIEW_ROLES: ReadonlyArray<ReviewRole> = Object.freeze(["architect", "pm", "test-expert", "solo-coder"]);

/**
 * 评审结论（字面量联合类型）
 *
 * - approve：通过（无重大问题，可批准方案）
 * - reject：驳回（存在 BLOCKER 级问题，需修改后重审）
 * - conditional-approve：有条件通过（存在 MAJOR 级问题，但可修复，附条件批准）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type ReviewVerdict = "approve" | "reject" | "conditional-approve";

/**
 * 评审记录（单一角色对方案的评审产出）
 *
 * 对齐 §5.12.1 G-2——方案必须经多角色评审，评审记录写入文档头部。
 *
 * 范例：
 *   {
 *     role: "architect",
 *     reviewer: "Alice",
 *     verdict: "approve",
 *     comments: "架构设计合理，分层清晰，建议在领域层增加审计日志。",
 *     reviewedAt: "2026-07-19T10:00:00.000Z"
 *   }
 */
export interface ReviewRecord {
  /** 评审角色（architect/pm/test-expert/solo-coder） */
  readonly role: ReviewRole;
  /** 评审人姓名或 ID */
  readonly reviewer: string;
  /** 评审结论（approve/reject/conditional-approve） */
  readonly verdict: ReviewVerdict;
  /** 评审意见（含问题清单与建议） */
  readonly comments: string;
  /** 评审时间（ISO 8601 字符串） */
  readonly reviewedAt: string;
}

// ============================================================================
// 3. 文件变更与任务卡声明变更
// ============================================================================

/**
 * 文件变更类型（字面量联合类型）
 *
 * - added：新增文件
 * - modified：修改文件
 * - deleted：删除文件
 * - renamed：重命名文件
 *
 * 与 l2-types.ts 中的 GitDiffType 对齐，但此处独立定义以避免门禁模块耦合 L2。
 */
export type FileChangeType = "added" | "modified" | "deleted" | "renamed";

/**
 * 文件变更（单文件的实际变更信息）
 *
 * 用于 G-3 门禁比对"任务卡声明变更 vs 实际变更"。
 *
 * 范例：
 *   {
 *     type: "modified",
 *     filePath: "src/services/PaymentService.ts",
 *     declaredSymbolIds: ["src/services/PaymentService.ts:PaymentService.refund"],
 *     actualSymbolIds: [
 *       "src/services/PaymentService.ts:PaymentService.refund",
 *       "src/services/PaymentCallbackHandler.ts:PaymentCallbackHandler.handle"
 *     ]
 *   }
 */
export interface FileChange {
  /** 变更类型（added/modified/deleted/renamed） */
  readonly type: FileChangeType;
  /** 文件相对路径 */
  readonly filePath: string;
  /**
   * 任务卡声明的受影响符号 ID 列表（来自 TaskCard.declaredSymbols）
   *
   * 数据源契约：
   * - 上游来源：TaskNode.declaredSymbols（由 TaskDecomposer 在分解时填写）
   * - 透传路径：TaskNode.declaredSymbols → TasksGenerator.convertToTaskCards →
   *   TaskCard.declaredSymbols → GateContext.actualChanges[i].declaredSymbolIds
   * - 对齐 §5.12.4 A-3 任务范围锁的符号级偏离检测
   */
  readonly declaredSymbolIds: ReadonlyArray<string>;
  /** 实际变更涉及的符号 ID 列表（来自代码 diff 静态分析） */
  readonly actualSymbolIds: ReadonlyArray<string>;
}

// ============================================================================
// 4. Loop 类型与门禁上下文
// ============================================================================

/**
 * Loop 类型（字面量联合类型）—— 从 loop/models re-export（统一类型源头）
 *
 * 对齐 EAG 三 Loop 编排：
 * - design：DESIGN Loop（产出 spec.md + CONSTITUTION.md）
 * - coding：CODING Loop（产出 plan.md + tasks.md + 代码实现）
 * - testing：TESTING Loop（产出测试用例 + 合规证据 + PR 描述）
 *
 * 各 Loop 对应的门禁策略（详见 GateOrchestrator）：
 * - design：跳过 G-1/G-2/G-3（DESIGN Loop 是方案产出阶段，无门禁）
 * - coding：依次执行 G-1 → G-2 → G-3
 * - testing：跳过 G-1/G-2/G-3（TESTING Loop 验证已实施代码，无方案门禁）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 改造说明（EAG-P3 批次 11 S2 D-S2-1 + D-S2-4）：
 * - 原本 gate/gate-types.ts 独立声明了 LoopType 与 LOOP_TYPES，与 loop/models.ts 重复定义
 * - loop/models.ts 是 Loop 类型的权威来源（批次 1 落地），gate 模块作为消费者应复用
 * - 改为 type-only re-export + value re-export，消除运行期重复定义
 * - 本地通过 import type 引入 LoopType 供 GateContext.loopType 等字段使用
 */
// 本地 import type 供模块内部使用（GateContext.loopType / GateOrchestrationResult.loopType）
import type { LoopType } from "../loop/models";
// re-export 给外部消费者（统一类型源头，下游从 gate/gate-types 导入路径不变）
export type { LoopType } from "../loop/models";
export { LOOP_TYPES } from "../loop/models";

// ============================================================================
// 5. 门禁类型与结果
// ============================================================================

/**
 * 门禁 ID（字面量联合类型，对应八道门禁）
 *
 * - G-1：无已批准 spec/plan 禁入 CODING Loop
 * - G-2：方案必经多角色评审 + 用户批准
 * - G-3：方案偏离检测（任务卡声明变更 vs 实际变更）
 * - G-4：CODING Loop 进入门禁（任务卡完整性 + 模板可用性 + 技术栈锁定）
 * - G-5：CODING Loop 退出门禁（任务卡全 completed + STRICT 通过 + git clean + gitleaks）
 * - G-6：TESTING Loop 进入门禁（G-5 通过 + 单测全过 + spec.md approved + implementationRoot 非空）
 * - G-7：TESTING Loop 退出门禁（覆盖率达标 + 契约测试全过 + E2E 测试全过 + 合规证据完整 + PR 描述就绪）
 * - G-8：DEPLOY Loop 退出门禁（IaC 模板校验通过 + 部署成功 + 健康检查通过 + 烟雾测试通过 + 监控就绪 + 回滚预案存在）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：
 * - G-1~G-3：EAG 方案 §5.12.1 方案先行门禁（批次 8 落地）
 * - G-4/G-5：EAG-P2 批次 9 §4.8 基于方案 §5.10.5 三 Loop 时序与 §5.12.2 里程碑检查点合理外推
 * - G-6/G-7：EAG-P3 批次 10 §4.8 TESTING Loop 进入与退出门禁（同构外推 G-4/G-5 设计）
 * - G-8：EAG-P4 批次 13 §3.6 DEPLOY Loop 退出门禁（同构外推 G-5/G-7 设计）
 */
export type GateId = "G-1" | "G-2" | "G-3" | "G-4" | "G-5" | "G-6" | "G-7" | "G-8";

/**
 * GateId 全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对应门禁执行顺序：
 * - coding Loop 进入：G-1 → G-2 → G-3 → G-4
 * - coding Loop 退出：G-5
 * - testing Loop 进入：G-6
 * - testing Loop 退出：G-7
 * - deploy Loop 退出：G-8
 */
export const GATE_IDS: ReadonlyArray<GateId> = Object.freeze(["G-1", "G-2", "G-3", "G-4", "G-5", "G-6", "G-7", "G-8"]);

/**
 * 门禁严重性（与 RedlineSeverity 对齐，使用小写）
 *
 * 对齐 `eag/evaluator/types.ts` 中的 RedlineSeverity：
 * - blocker：阻塞级（不通过即打回，不可豁免）
 * - major：主要级（打回但可人工豁免）
 * - warning：警告级（仅提示不打回）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type GateSeverity = "blocker" | "major" | "warning";

/**
 * 门禁上下文（GateChecker.check 的入参）
 *
 * 携带门禁判定所需的全部信息：
 * - projectId / loopType：项目与 Loop 标识
 * - specStatus / planStatus：spec.md / plan.md 的文档状态（G-1 检查）
 * - reviewRecords：评审记录列表（G-2 检查）
 * - userApproved：用户批准标记（G-2 检查）
 * - taskCard：当前迭代的任务卡（G-3 检查）
 * - actualChanges：实际变更列表（G-3 检查）
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 *
 * 范例：
 *   {
 *     projectId: "order-system",
 *     loopType: "coding",
 *     specStatus: "approved",
 *     planStatus: "approved",
 *     reviewRecords: [...],
 *     userApproved: true,
 *     taskCard: { id: "T-001", ... },
 *     actualChanges: [...]
 *   }
 */
export interface GateContext {
  /** 项目 ID */
  readonly projectId: string;
  /** Loop 类型（design/coding/testing） */
  readonly loopType: LoopType;
  /** spec.md 的文档状态 */
  readonly specStatus: DocumentState;
  /** plan.md 的文档状态 */
  readonly planStatus: DocumentState;
  /** 评审记录列表（含多角色评审） */
  readonly reviewRecords: ReadonlyArray<ReviewRecord>;
  /** 用户是否已显式批准方案 */
  readonly userApproved: boolean;
  /** 当前迭代的任务卡 */
  readonly taskCard: TaskCard;
  /** 实际变更列表（来自 git diff 静态分析） */
  readonly actualChanges: ReadonlyArray<FileChange>;
}

/**
 * 门禁结果（GateChecker.check 的产出）
 *
 * 描述单道门禁的判定结果：
 * - passed：是否通过
 * - gate：门禁 ID（G-1/G-2/G-3）
 * - reason：判定理由（人类可读，含具体未通过项）
 * - guidance：引导消息（失败时建议下一步动作，如"进入 DESIGN Loop"）
 * - severity：严重性（blocker/major/warning）
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     passed: false,
 *     gate: "G-1",
 *     reason: "spec.md 状态为 reviewing，未批准",
 *     guidance: "建议进入 DESIGN Loop 完成 spec.md 评审与批准",
 *     severity: "blocker"
 *   }
 */
export interface GateResult {
  /** 是否通过（true=通过，false=不通过） */
  readonly passed: boolean;
  /** 门禁 ID（G-1/G-2/G-3） */
  readonly gate: GateId;
  /** 判定理由（人类可读，含具体未通过项） */
  readonly reason: string;
  /** 引导消息（失败时建议下一步动作） */
  readonly guidance?: string;
  /** 严重性（blocker/major/warning） */
  readonly severity: GateSeverity;
}

// ============================================================================
// 6. 门禁编排结果
// ============================================================================

/**
 * 门禁编排结果（GateOrchestrator.run 的产出）
 *
 * 描述一次 Loop 启动前所有门禁的编排判定结果：
 * - results：各门禁的判定结果列表（按执行顺序）
 * - allPassed：是否全部通过
 * - firstFailedGate：首个未通过的门禁（null 表示全部通过）
 * - loopType：当前 Loop 类型
 *
 * 范例：
 *   {
 *     results: [...],
 *     allPassed: false,
 *     firstFailedGate: "G-1",
 *     loopType: "coding"
 *   }
 */
export interface GateOrchestrationResult {
  /** 各门禁的判定结果列表（按执行顺序：G-1 → G-2 → G-3） */
  readonly results: ReadonlyArray<GateResult>;
  /** 是否全部通过 */
  readonly allPassed: boolean;
  /** 首个未通过的门禁（null 表示全部通过） */
  readonly firstFailedGate: GateId | null;
  /** 当前 Loop 类型 */
  readonly loopType: LoopType;
}

// ============================================================================
// 7. 门禁检查器协议（接口）
// ============================================================================

/**
 * 门禁检查器协议（G-1/G-2/G-3 检查器的统一接口）
 *
 * 所有门禁检查器必须实现此接口，便于 GateOrchestrator 统一编排。
 */
export interface GateChecker {
  /** 门禁 ID（G-1/G-2/G-3） */
  readonly gateId: GateId;
  /** 执行门禁检查 */
  check(context: GateContext): GateResult;
}

// ============================================================================
// 8. 默认配置常量
// ============================================================================

/**
 * G-2 门禁要求的最少评审角色数（对齐 §5.12.1 G-2 多角色评审至少 2 角色）
 *
 * 数值依据：§5.12.1 G-2 明确要求"多角色评审（架构师 + 测试专家至少 2 角色）"。
 *
 * 使用 `as const` 字面量断言——数字本身已是不可变原始值，
 * `Object.freeze(number)` 是冗余操作（冻结原始值无任何效果），改用 `as const` 更直观。
 */
export const G2_MIN_REVIEW_ROLES = 2 as const;

/**
 * G-2 门禁要求的全部评审角色数（4 角色：架构师/PM/测试专家/独立开发者）
 *
 * 数值依据：§5.12.1 G-2 描述"方案文档必须经多角色评审（架构师 + 测试专家至少 2 角色）"，
 * 此处要求"至少 2 角色"为下限；上限为 4 角色（完整评审）。
 * G2_MIN_REVIEW_ROLES 用于硬约束，G2_FULL_REVIEW_ROLES 用于完整性评分。
 *
 * 使用 `as const` 字面量断言（数字本身已是不可变原始值，无需 Object.freeze）。
 */
export const G2_FULL_REVIEW_ROLES = 4 as const;

/**
 * G-3 门禁偏离阈值（≥3 个符号级偏离即触发 HUMAN_CHECKPOINT）
 *
 * 数值依据：§5.12.1 G-3 偏离定义——"变更波及任务卡未声明的符号（≥3 个符号级偏离）"。
 *
 * 使用 `as const` 字面量断言（数字本身已是不可变原始值，无需 Object.freeze）。
 */
export const G3_DEVIATION_THRESHOLD = 3 as const;

// ============================================================================
// 9. G-4/G-5 专属上下文类型（EAG-P2 批次 9 §4.8.4）
// ============================================================================

/**
 * G-4 门禁上下文（继承 GateContext，扩展 CODING Loop 进入门禁所需字段）
 *
 * 对应 EAG-P2 批次 9 设计 §4.8.4 GateG4Context：
 * 在 G-1/G-2/G-3 通过基础上，G-4 额外校验 Phase A 骨架生成的前置条件。
 *
 * 扩展字段语义：
 * - tasksStatus：tasks.md 文档状态（G-4 要求 tasks.md 已批准）
 * - fileCluster：任务卡所属文件簇名（来自 TaskNode.fileCluster，G-4 校验其非空）
 * - requiredTemplateKinds：本任务卡需要的模板 kind 列表（G-4 校验 TemplateRegistry 已注册）
 * - techStack：技术栈锁定清单（G-4 校验非空，对齐 CONSTITUTION.techStackLocks）
 * - outputDir：输出目录（G-4 校验可写，骨架文件写入此目录）
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 *
 * 范例：
 *   {
 *     projectId: "order-system",
 *     loopType: "coding",
 *     specStatus: "approved",
 *     planStatus: "approved",
 *     reviewRecords: [...],
 *     userApproved: true,
 *     taskCard: { id: "T-001", ... },
 *     actualChanges: [],
 *     tasksStatus: "approved",
 *     fileCluster: "OrderAggregate",
 *     requiredTemplateKinds: ["aggregate", "domain-event"],
 *     techStack: ["TypeScript", "NestJS", "PostgreSQL"],
 *     outputDir: "src/"
 *   }
 */
export interface GateG4Context extends GateContext {
  /** tasks.md 文档状态（G-4 要求 tasks.md 已批准） */
  readonly tasksStatus: DocumentState;
  /** 任务卡所属文件簇名（来自 TaskNode.fileCluster） */
  readonly fileCluster: string;
  /** 本任务卡需要的模板 kind 列表（G-4 校验 TemplateRegistry 已注册） */
  readonly requiredTemplateKinds: ReadonlyArray<GeneratedFileKind>;
  /** 技术栈锁定清单（CONSTITUTION.techStackLocks，G-4 校验非空） */
  readonly techStack: ReadonlyArray<string>;
  /** 输出目录（相对 projectRoot，G-4 校验非空字符串） */
  readonly outputDir: string;
}

/**
 * G-5 门禁上下文（继承 GateContext，扩展 CODING Loop 退出门禁所需字段）
 *
 * 对应 EAG-P2 批次 9 设计 §4.8.4 GateG5Context：
 * G-5 校验所有任务卡完成 + STRICT 评估通过 + git 工作区干净 + gitleaks 通过。
 *
 * 扩展字段语义：
 * - allTaskCards：所有任务卡列表（G-5 校验 status 全为 completed）
 * - finalEvaluationReport：最终 STRICT 评估报告（G-5 校验 verdict=pass）
 * - gitClean：git 工作区是否干净（无未提交变更）
 * - gitleaksPassed：gitleaks 扫描是否通过（无密钥泄露）
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 *
 * 范例：
 *   {
 *     projectId: "order-system",
 *     loopType: "coding",
 *     specStatus: "approved",
 *     planStatus: "approved",
 *     reviewRecords: [...],
 *     userApproved: true,
 *     taskCard: { id: "T-001", status: "completed", ... },
 *     actualChanges: [],
 *     allTaskCards: [{ id: "T-001", status: "completed", ... }, ...],
 *     finalEvaluationReport: { verdict: "pass", ... },
 *     gitClean: true,
 *     gitleaksPassed: true
 *   }
 */
export interface GateG5Context extends GateContext {
  /** 所有任务卡列表（G-5 校验 status 全为 completed） */
  readonly allTaskCards: ReadonlyArray<TaskCard>;
  /** 最终 STRICT 评估报告（G-5 校验 verdict=pass） */
  readonly finalEvaluationReport: Readonly<EvaluationReport>;
  /** git 工作区是否干净（无未提交变更） */
  readonly gitClean: boolean;
  /** gitleaks 扫描是否通过（无密钥泄露） */
  readonly gitleaksPassed: boolean;
}

// ============================================================================
// 10. G-6/G-7 专属上下文类型（EAG-P3 批次 10 §4.8.4）
// ============================================================================

/**
 * 测试执行结果（单次测试文件执行产出）
 *
 * 对应 EAG-P3 批次 10 设计 §4.8.4 TestExecutionResult：
 * 描述单个测试文件（契约测试 / E2E 测试）执行后的结果信息，
 * 供 G-7 门禁校验"全部测试通过"使用。
 *
 * 字段全部 readonly——执行结果一经采集即不可变。
 *
 * 范例：
 *   {
 *     filePath: "tests/contract/payment.callback.contract.test.ts",
 *     exitCode: 0,
 *     durationMs: 1200,
 *     failedCount: 0,
 *     passedCount: 5
 *   }
 */
export interface TestExecutionResult {
  /** 测试文件路径（相对 projectRoot，与 GeneratedTestFile.relativePath 对齐） */
  readonly filePath: string;
  /** 退出码（0=通过，非 0=失败，由 node --test 或 npm test 返回） */
  readonly exitCode: number;
  /** 执行耗时（毫秒，用于性能审计与超时分析） */
  readonly durationMs: number;
  /** 失败用例数（exitCode=0 时应为 0） */
  readonly failedCount: number;
  /** 通过用例数（exitCode=0 时 ≥1） */
  readonly passedCount: number;
}

/**
 * G-6 门禁上下文（继承 GateContext，扩展 TESTING Loop 进入门禁所需字段）
 *
 * 对应 EAG-P3 批次 10 设计 §4.8.4 GateG6Context：
 * 在 G-1~G-5 通过基础上，G-6 校验 TESTING Loop 启动前的前置条件——
 * CODING Loop 已退出（G-5 通过）+ 单测全过 + spec.md 已批准 + 实现根目录非空。
 *
 * 扩展字段语义：
 * - g5Passed：G-5 门禁是否已通过（CODING Loop 退出门禁通过证据）
 * - unitTestsPassed：单元测试是否全过（npm test 退出码 0 验证）
 * - implementationRoot：CODING Loop 产出目录（G-6 校验非空字符串，用于 TESTING Loop 读取被测代码）
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 *
 * 范例：
 *   {
 *     projectId: "order-system",
 *     loopType: "testing",
 *     specStatus: "approved",
 *     planStatus: "approved",
 *     reviewRecords: [...],
 *     userApproved: true,
 *     taskCard: { id: "T-001", ... },
 *     actualChanges: [],
 *     g5Passed: true,
 *     unitTestsPassed: true,
 *     implementationRoot: "src/"
 *   }
 */
export interface GateG6Context extends GateContext {
  /** G-5 门禁是否已通过（CODING Loop 退出证据） */
  readonly g5Passed: boolean;
  /** 单元测试是否全过（npm test 退出码 0） */
  readonly unitTestsPassed: boolean;
  /** CODING Loop 产出目录（相对 projectRoot，G-6 校验非空字符串） */
  readonly implementationRoot: string;
}

/**
 * G-7 门禁上下文（继承 GateContext，扩展 TESTING Loop 退出门禁所需字段）
 *
 * 对应 EAG-P3 批次 10 设计 §4.8.4 GateG7Context：
 * G-7 校验 TESTING Loop 退出的 5 个前置条件——
 * 覆盖率达标 + 契约测试全过 + E2E 测试全过 + 合规证据完整（如启用 ICP）+ PR 描述就绪。
 *
 * 扩展字段语义：
 * - coverageReport：覆盖率报告（G-7 校验 passed=true，含行/分支/函数/高风险符号覆盖率）
 * - contractTests：契约测试文件列表（G-7 校验非空）
 * - contractTestResults：契约测试执行结果（G-7 校验全部 exitCode=0）
 * - e2eTests：E2E 测试文件列表（G-7 校验非空）
 * - e2eTestResults：E2E 测试执行结果（G-7 校验全部 exitCode=0）
 * - complianceEvidence：合规证据报告（启用 ICP 时必填，对齐 §5.9.2）
 * - prDescription：PR 描述（G-7 校验非空 + 含四段结构）
 *
 * PR 描述四段结构（对齐 §5.10.4 交付门禁）：
 * 1. 变更摘要（## 变更摘要 / ## Change Summary）
 * 2. 需求映射（## 需求映射 / ## Requirement Mapping）
 * 3. 测试报告（## 测试报告 / ## Test Report）
 * 4. 合规证据链接（## 合规证据 / ## Compliance Evidence）
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 */
export interface GateG7Context extends GateContext {
  /** 覆盖率报告（G-7 校验 passed=true） */
  readonly coverageReport: Readonly<CoverageReport>;
  /** 契约测试文件列表（G-7 校验非空 + 全部执行通过） */
  readonly contractTests: ReadonlyArray<GeneratedTestFile>;
  /** 契约测试执行结果（每文件 exitCode，G-7 校验全部 exitCode=0） */
  readonly contractTestResults: ReadonlyArray<TestExecutionResult>;
  /** E2E 测试文件列表（G-7 校验非空 + 全部执行通过） */
  readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
  /** E2E 测试执行结果（每文件 exitCode，G-7 校验全部 exitCode=0） */
  readonly e2eTestResults: ReadonlyArray<TestExecutionResult>;
  /**
   * 启用的 ICP 合规包 ID 列表（可选）
   *
   * 数据源：TestingLoopRequest.compliancePackIds 透传。
   * G-7 判定规则：若非空 → complianceEvidence 必填。
   * 对齐 testing-orchestrator.ts 中 GateG7Context 的同名字段（保证两套类型一致）。
   */
  readonly compliancePackIds?: ReadonlyArray<string>;
  /** 合规证据报告（启用 ICP 时必填，对齐 §5.9.2） */
  readonly complianceEvidence?: Readonly<Record<string, unknown>>;
  /** PR 描述（G-7 校验非空 + 含变更摘要/需求映射/测试报告/合规证据链接四段） */
  readonly prDescription: string;
}
