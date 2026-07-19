/**
 * TESTING Loop 全部数据模型（EAG-P3 批次 10 基础层）
 *
 * 本模块定义 EAG 方案 §5.10.5 / §5.12.1 / §5.12.2 TESTING Loop 全部结构化数据类型，
 * 涵盖契约测试 / E2E 测试 / 覆盖率门禁 / 既有契约保护 / 编排请求产出 / 测试质量静态判定器
 * 六大子模块所需的全部契约。
 *
 * 设计依据：
 * - EAG 方案 §5.10.3 / §5.10.5 TESTING Loop 时序（契约测试 → E2E 测试 → 覆盖率门禁）
 * - EAG 方案 §5.2.4 评估器判定（领域层 ≥80% + 高风险符号必测）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - EAG-P3 批次 10 设计 §4.1 数据模型
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 工厂函数 createXxxRequest 统一返回 Object.freeze 冻结对象
 *
 * 外部类型复用：
 * - TaskDag / TaskCard / ModuleSplit：从 ../doc-driven/types 导入
 * - LLMClient：从 ../../providers/llm-provider 导入
 * - LoopGuard：从 ../../common/loop-guard 导入
 * - LoopEvent：从 ../loop/models 导入（仅 re-export）
 *
 * @module eag/testing/types
 */

// ============================================================================
// 1. 外部类型导入（仅 type-only import，避免运行期循环依赖）
// ============================================================================

import type { TaskDag } from "../doc-driven/types";
import type { LLMClient } from "../../providers/llm-provider";
import type { LoopGuard } from "../../common/loop-guard";
import type { LoopEvent } from "../loop/models";

// ============================================================================
// 2. 测试文件类型与生成产出
// ============================================================================

/**
 * 测试文件类型（字面量联合类型，对齐 TESTING Loop 产出物分类）
 *
 * - contract：契约测试（基于 OpenAPI / 接口签名生成，验证 API 兼容性）
 * - e2e：端到端测试（基于 PKC L3 K2 业务流程图生成，验证用户故事全链路）
 * - integration：集成测试（跨聚合 / 跨模块交互验证）
 * - compliance：合规场景测试（启用 ICP 时强制，覆盖 GMP/CFR/ALCOA+ 场景）
 * - regression：回归测试（里程碑间自动回归，复用历史测试用例集）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type TestFileKind = "contract" | "e2e" | "integration" | "compliance" | "regression";

/**
 * TEST_FILE_KINDS 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结。顺序对齐 TESTING Loop 产出物分类自然顺序。
 */
export const TEST_FILE_KINDS: ReadonlyArray<TestFileKind> = Object.freeze([
  "contract",
  "e2e",
  "integration",
  "compliance",
  "regression",
]);

/**
 * 生成的测试文件（TESTING Loop 产出物单元）
 *
 * 对应 EAG 方案 §5.10.5 时序"契约/集成/E2E 生成"产出。
 *
 * 字段全部 readonly——一经组装即不可变。
 *
 * 范例：
 *   {
 *     relativePath: "tests/contract/payment.callback.contract.test.ts",
 *     content: "import { test } from 'node:test'; ...",
 *     kind: "contract",
 *     requirementId: "F-001",
 *     sourceId: "/api/v1/orders/{orderId}",
 *     testCaseCount: 5,
 *     testCaseDescriptions: ["should return 200...", "should return 404..."]
 *   }
 */
export interface GeneratedTestFile {
  /** 文件相对路径（相对 projectRoot，如 "tests/contract/payment.callback.contract.test.ts"） */
  readonly relativePath: string;
  /** 测试文件内容（完整 TypeScript 代码，含 import / describe / it / 断言） */
  readonly content: string;
  /** 测试文件类型 */
  readonly kind: TestFileKind;
  /** 关联的验收标准 ID（F-NNN，用于需求溯源 + 覆盖率反向映射） */
  readonly requirementId: string;
  /**
   * 关联的接口签名或业务流程 ID
   * - contract 测试：接口路径（如 "/api/v1/orders/{orderId}"）
   * - e2e 测试：流程图节点 ID（如 "flow-order-create-pay-query"）
   * - integration / compliance / regression：其他业务标识
   */
  readonly sourceId: string;
  /** 测试用例数（describe/it 节点数，用于断言密度计算） */
  readonly testCaseCount: number;
  /** 测试用例描述（每用例一行，便于 PR 描述与里程碑报告渲染） */
  readonly testCaseDescriptions: ReadonlyArray<string>;
}

// ============================================================================
// 3. 契约测试规范（ContractTestGenerator 输入）
// ============================================================================

/**
 * 契约测试规范（ContractTestGenerator 输入单元）
 *
 * 来源：OpenAPI 3.x spec 解析 / TypeScript 接口签名 AST 提取（双通道降级）。
 *
 * 范例：
 *   {
 *     path: "/api/v1/orders/{orderId}",
 *     method: "GET",
 *     requestSchema: { type: "object", properties: { orderId: { type: "string" } } },
 *     responseSchemas: { "200": { type: "object", properties: { id: { type: "string" } } } },
 *     tsSignature: "getOrder(orderId: string): Promise<Order>",
 *     requirementId: "F-001",
 *     boundaryCases: ["无效 orderId 应返回 400", "orderId 不存在应返回 404"]
 *   }
 */
export interface ContractTestSpec {
  /** 接口路径（如 "/api/v1/orders/{orderId}"） */
  readonly path: string;
  /** HTTP 方法（GET/POST/PUT/DELETE/PATCH） */
  readonly method: string;
  /** 请求 schema（JSON Schema 格式，来自 OpenAPI requestBody） */
  readonly requestSchema?: Readonly<Record<string, unknown>>;
  /** 响应 schema（按状态码分组，来自 OpenAPI responses） */
  readonly responseSchemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** 接口签名（TypeScript 函数签名，AST 提取得来，OpenAPI 不可用时降级使用） */
  readonly tsSignature?: string;
  /** 关联需求 ID */
  readonly requirementId: string;
  /** 边界用例描述（如"无效 orderId 应返回 400"/"幂等键冲突应返回 409"） */
  readonly boundaryCases: ReadonlyArray<string>;
}

// ============================================================================
// 4. E2E 测试规范（E2eTestGenerator 输入）
// ============================================================================

/**
 * E2E 流程置信度（字面量联合类型）
 *
 * 对齐设计文档 §4.3.2——E2E 测试仅消费 documented/verified 流程，
 * inferred 流程转 HUMAN_CHECKPOINT 由用户确认。
 *
 * - documented：文档化流程（来自 spec.md / 需求文档，置信度最高）
 * - verified：已验证流程（来自代码 + 单测交叉验证）
 * - inferred：推断流程（仅基于代码静态分析推断，置信度最低，需人工确认）
 */
export type E2eFlowConfidence = "documented" | "inferred" | "verified";

/**
 * E2E_FLOW_CONFIDENCES 全部合法值（用于运行时枚举与过滤判定）
 */
export const E2E_FLOW_CONFIDENCES: ReadonlyArray<E2eFlowConfidence> = Object.freeze([
  "documented",
  "verified",
  "inferred",
]);

/**
 * E2E 流程步骤执行者（字面量联合类型）
 *
 * - user：用户角色（UI 交互 / 表单提交）
 * - system：系统角色（业务处理 / 状态流转）
 * - external-service：外部服务（支付网关回调 / 第三方 API）
 */
export type E2eFlowActor = "user" | "system" | "external-service";

/**
 * E2E 测试规范（E2eTestGenerator 输入单元）
 *
 * 来源：PKC L3 K2 业务流程图 + 用户故事。
 *
 * 范例：
 *   {
 *     flowId: "flow-order-create-pay-query",
 *     flowName: "下单→支付→订单查询",
 *     steps: [{ order: 1, actor: "user", action: "提交订单", ... }],
 *     userStory: "Given 用户已登录 / When 提交订单 / Then 创建订单成功",
 *     requirementId: "F-001",
 *     confidence: "documented"
 *   }
 */
export interface E2eTestSpec {
  /** 流程图节点 ID（来自 pkc/l3/business-flow-discoverer） */
  readonly flowId: string;
  /** 流程名称（如"下单→支付→订单查询"） */
  readonly flowName: string;
  /** 流程步骤（每步含 actor/action/input/output/stateTransition） */
  readonly steps: ReadonlyArray<E2eFlowStep>;
  /** 用户故事（Gherkin 语法：Given/When/Then） */
  readonly userStory: string;
  /** 关联需求 ID */
  readonly requirementId: string;
  /** 流程置信度（documented/inferred/verified，仅消费 documented/verified，inferred 转 HUMAN_CHECKPOINT） */
  readonly confidence: E2eFlowConfidence;
}

/**
 * E2E 流程步骤
 *
 * 描述业务流程中的一个原子步骤，包含执行者、动作、输入输出与状态转换。
 */
export interface E2eFlowStep {
  /** 步骤序号（从 1 开始） */
  readonly order: number;
  /** 执行者（user/system/external-service） */
  readonly actor: E2eFlowActor;
  /** 动作（如"提交订单"/"调用支付回调"/"更新订单状态"） */
  readonly action: string;
  /** 输入参数（键值对，如 { orderId: "order-001", amount: 100 }） */
  readonly input: Readonly<Record<string, unknown>>;
  /** 期望输出（键值对，如 { status: 200, body: { id: "order-001" } }） */
  readonly expectedOutput: Readonly<Record<string, unknown>>;
  /** 状态转换（如"pending→paid"） */
  readonly stateTransition?: string;
}

// ============================================================================
// 5. 覆盖率门禁类型
// ============================================================================

/**
 * 覆盖率阈值（对齐 §5.2.4 领域层 ≥80% + §8.6 高风险符号必测）
 *
 * 默认值：行 ≥80% / 分支 ≥70% / 函数 ≥85% / 高风险符号 100%
 */
export interface CoverageThreshold {
  /** 行覆盖率阈值（0~100，默认 80） */
  readonly lines: number;
  /** 分支覆盖率阈值（0~100，默认 70） */
  readonly branches: number;
  /** 函数覆盖率阈值（0~100，默认 85） */
  readonly functions: number;
  /** 高风险符号必测覆盖率（0~100，默认 100，对齐 §8.6 高风险符号必测） */
  readonly highRiskSymbols: number;
}

/**
 * DEFAULT_COVERAGE_THRESHOLD 默认覆盖率阈值
 *
 * 数值依据：EAG 方案 §5.2.4"领域层 ≥80%" + 行业最佳实践（分支 70% / 函数 85%）。
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
export const DEFAULT_COVERAGE_THRESHOLD: Readonly<CoverageThreshold> = Object.freeze({
  lines: 80,
  branches: 70,
  functions: 85,
  highRiskSymbols: 100,
});

/**
 * 未覆盖符号（高风险符号未被测试覆盖的记录）
 *
 * 用于 CoverageGapChecker 判定与 CoverageReport 渲染。
 */
export interface UncoveredSymbol {
  /** 符号 ID（如 "src/services/PaymentService.ts:PaymentService.refund"） */
  readonly symbolId: string;
  /** 文件路径 */
  readonly filePath: string;
  /**
   * 未覆盖原因
   * - "no-test"：无任何测试覆盖
   * - "test-exists-but-branch-missed"：有测试但分支未覆盖
   * - "high-risk-no-test"：高风险符号无测试
   */
  readonly reason: string;
  /** 风险评分（来自 PKC L1 风险热点，0~1） */
  readonly riskScore: number;
}

/**
 * 覆盖率未达标维度（字面量联合类型）
 *
 * 用于 CoverageReport.failedDimensions 字段，标识哪些维度未达标。
 */
export type CoverageFailedDimension = "lines" | "branches" | "functions" | "highRiskSymbols";

/**
 * COVERAGE_FAILED_DIMENSIONS 全部合法值
 */
export const COVERAGE_FAILED_DIMENSIONS: ReadonlyArray<CoverageFailedDimension> = Object.freeze([
  "lines",
  "branches",
  "functions",
  "highRiskSymbols",
]);

/**
 * 覆盖率报告（CoverageGate 产出）
 *
 * 含各维度覆盖率数值 + 未覆盖符号列表 + 是否达标判定 + 原始 c8 报告。
 */
export interface CoverageReport {
  /** 行覆盖率（0~100） */
  readonly lines: number;
  /** 分支覆盖率（0~100） */
  readonly branches: number;
  /** 函数覆盖率（0~100） */
  readonly functions: number;
  /** 高风险符号覆盖率（0~100） */
  readonly highRiskSymbols: number;
  /** 未覆盖的高风险符号列表（symbolId + filePath + reason） */
  readonly uncoveredHighRiskSymbols: ReadonlyArray<UncoveredSymbol>;
  /** 未覆盖文件列表（相对路径） */
  readonly uncoveredFiles: ReadonlyArray<string>;
  /** 是否达标 */
  readonly passed: boolean;
  /** 未达标维度（passed=false 时填写） */
  readonly failedDimensions: ReadonlyArray<CoverageFailedDimension>;
  /** 原始 c8 报告 JSON（用于审计与 PR 描述链接） */
  readonly rawReport: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 6. 验收标准
// ============================================================================

/**
 * 验收标准（从 spec.md F-NNN 解析）
 *
 * 对齐 EAG-P3 批次 10 设计 §4.1.2 AcceptanceCriterion：
 * 每条验收标准关联需求 ID + 模块名，用于 PR 描述与里程碑报告渲染。
 */
export interface AcceptanceCriterion {
  /** 需求 ID（F-NNN） */
  readonly requirementId: string;
  /** 验收标准描述（Gherkin 语法 Given/When/Then） */
  readonly description: string;
  /** 关联的模块名（来自 plan.md moduleSplits） */
  readonly moduleName: string;
}

// ============================================================================
// 7. PKC 知识库访问器协议（TESTING Loop 专属）
// ============================================================================

/**
 * PKC 知识库访问器协议（与 coding/types.ts PkcAccessor 一致，本模块独立声明避免循环依赖）
 *
 * TESTING Loop 仅依赖此协议而非 PKC 具体类，调用方负责注入具体实现
 * （生产环境用真实 PKC，测试用 InMemoryPkcAccessor 真实实现）。
 *
 * 设计依据：依赖倒置原则（DIP）+ 用户规则"禁止 mock PKC"。
 *
 * 实现方负责：
 * 1. queryBusinessFlows：返回 K2 业务流程图（E2E 测试输入）
 * 2. queryRiskHotspots：返回 L1 风险热点（覆盖率门禁高风险符号输入）
 * 3. queryL1GlobalView：返回 L1 全局视野（覆盖率空白检测输入）
 */
export interface PkcAccessor {
  /**
   * 查询 L3 K2 业务流程图（E2E 测试输入）
   *
   * @param projectRoot 项目根目录（绝对路径）
   * @returns K2 业务流程图列表（每个流程对应一个 E2eTestSpec）
   */
  queryBusinessFlows(projectRoot: string): Promise<ReadonlyArray<E2eTestSpec>>;

  /**
   * 查询 L1 风险热点（覆盖率门禁高风险符号输入）
   *
   * @param projectRoot 项目根目录（绝对路径）
   * @param topN 返回的 Top-N 个高风险符号（默认 10）
   * @returns 高风险符号列表（含风险评分，按评分降序）
   */
  queryRiskHotspots(projectRoot: string, topN?: number): Promise<ReadonlyArray<UncoveredSymbol>>;

  /**
   * 查询 L1 全局视野（覆盖率空白检测输入）
   *
   * @param projectRoot 项目根目录（绝对路径）
   * @returns L1 全局视野（模块聚类 + 入口点 + 爆炸半径 Top-N）
   */
  queryL1GlobalView(projectRoot: string): Promise<Readonly<Record<string, unknown>>>;
}

// ============================================================================
// 8. TESTING Loop 编排请求与产出
// ============================================================================

/**
 * TESTING Loop 最终状态（字面量联合类型）
 *
 * - success：成功完成（所有测试生成 + 覆盖率达标 + G-7 通过）
 * - human_checkpoint：人工介入（inferred 流程需确认 / 覆盖率连续 2 次 BLOCKER / G-7 失败）
 * - stop_failure：失败停止（LoopGuard 触达上限 / 不可恢复错误）
 */
export type TestingLoopFinalStatus = "success" | "human_checkpoint" | "stop_failure";

/**
 * TESTING_LOOP_FINAL_STATUSES 全部合法值
 */
export const TESTING_LOOP_FINAL_STATUSES: ReadonlyArray<TestingLoopFinalStatus> = Object.freeze([
  "success",
  "human_checkpoint",
  "stop_failure",
]);

/**
 * TESTING Loop 编排请求
 *
 * 对应 EAG 方案 §5.10.5 时序"TESTING Loop"段——输入 CODING Loop 产出物 + spec/plan/tasks。
 *
 * 字段全部 readonly。LoopGuard 必填——所有 Loop 必须有上限保护。
 */
export interface TestingLoopRequest {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 已批准的 spec.md 内容（用于验收标准反向映射） */
  readonly specContent: string;
  /** 已批准的 plan.md 内容（用于模块切分 + 接口契约提取） */
  readonly planContent: string;
  /** 已批准的 tasks.md 内容（用于任务卡 → 测试用例映射） */
  readonly tasksContent: string;
  /** CODING Loop 产出目录（相对 projectRoot，默认 "src/"） */
  readonly implementationRoot: string;
  /** 任务 DAG（复用 doc-driven/task-decomposition） */
  readonly taskDag: Readonly<TaskDag>;
  /** 验收标准列表（从 spec.md 解析） */
  readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
  /** LLM 客户端（用于生成测试用例骨架与断言） */
  readonly llmClient: LLMClient;
  /** PKC 知识库访问器（L3 K2 业务流程图 + L1 风险热点） */
  readonly pkcAccessor: PkcAccessor;
  /** LoopGuard 实例（上限保护） */
  readonly loopGuard: LoopGuard;
  /** 覆盖率阈值（默认 DEFAULT_COVERAGE_THRESHOLD） */
  readonly coverageThreshold: Readonly<CoverageThreshold>;
  /** OpenAPI spec 文件路径（可选，棕地场景从既有 spec 读取，绿地场景从 CODING 产出推导） */
  readonly openapiSpecPath?: string;
  /** 启用的 ICP 合规包 ID 列表（可选，P3 批次 11 接入；本批次预留字段） */
  readonly compliancePackIds?: ReadonlyArray<string>;
  /** 最大迭代次数（默认 5） */
  readonly maxIterations: number;
  /** 当前 run-id（长程自动化串联时传入，独立运行时由编排器生成） */
  readonly runId?: string;
}

/**
 * TESTING Loop 编排产出
 *
 * 含全部生成测试文件 / 覆盖率报告 / PR 描述 / Loop 事件流 / 最终状态。
 */
export interface TestingLoopResult {
  /** run-id（与请求一致或新生成） */
  readonly runId: string;
  /** 最终状态 */
  readonly finalStatus: TestingLoopFinalStatus;
  /** 生成的契约测试文件列表 */
  readonly contractTests: ReadonlyArray<GeneratedTestFile>;
  /** 生成的 E2E 测试文件列表 */
  readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
  /** 生成的集成测试文件列表（如有） */
  readonly integrationTests: ReadonlyArray<GeneratedTestFile>;
  /** 合规场景测试文件列表（启用 ICP 时产出，本批次预留） */
  readonly complianceTests: ReadonlyArray<GeneratedTestFile>;
  /** 覆盖率报告 */
  readonly coverageReport: Readonly<CoverageReport>;
  /** 合规证据报告（启用 ICP 时产出，本批次预留字段，批次 11 实现） */
  readonly complianceEvidence?: Readonly<Record<string, unknown>>;
  /** 自动生成的 PR 描述（对齐 §5.10.4 交付门禁） */
  readonly prDescription: string;
  /** 阻塞原因（finalStatus != success 时填写） */
  readonly blockedReason?: string;
  /** 总 LLM 调用次数 */
  readonly totalLlmCallCount: number;
  /** 总 token 消耗 */
  readonly totalTokensUsed: number;
  /** 总耗时（秒） */
  readonly durationSec: number;
  /** Loop 事件流（写入 events.jsonl） */
  readonly events: ReadonlyArray<LoopEvent>;
}

// ============================================================================
// 9. 既有契约保护类型
// ============================================================================

/**
 * 既有契约保护请求（BrownfieldContractGuard 输入）
 */
export interface BrownfieldContractGuardRequest {
  /** 项目根目录 */
  readonly projectRoot: string;
  /** CODING Loop 产出的契约测试规范列表 */
  readonly newContractSpecs: ReadonlyArray<ContractTestSpec>;
  /** 既有 API 契约清单路径（可选，默认从 discovery 模块加载） */
  readonly existingContractsPath?: string;
}

/**
 * breaking change 类型（字面量联合类型）
 *
 * - api-removed：API 被删除
 * - required-field-added：必填字段新增（请求方需补充字段才能调用）
 * - field-type-changed：字段类型变更（不兼容）
 * - response-field-removed：响应字段删除（调用方依赖该字段会失败）
 */
export type BreakingChangeKind =
  | "api-removed"
  | "required-field-added"
  | "field-type-changed"
  | "response-field-removed";

/**
 * BREAKING_CHANGE_KINDS 全部合法值
 */
export const BREAKING_CHANGE_KINDS: ReadonlyArray<BreakingChangeKind> = Object.freeze([
  "api-removed",
  "required-field-added",
  "field-type-changed",
  "response-field-removed",
]);

/**
 * breaking change 单元
 */
export interface BreakingChange {
  /** 变更类型 */
  readonly kind: BreakingChangeKind;
  /** 影响 API 路径 */
  readonly apiPath: string;
  /** 影响字段 */
  readonly field?: string;
  /** 既有契约 */
  readonly oldValue?: string;
  /** 新契约 */
  readonly newValue?: string;
  /** 影响范围描述 */
  readonly impact: string;
}

/**
 * 兼容变更单元（非 breaking change）
 */
export interface CompatibleChange {
  /** 变更类型（"api-added" / "optional-field-added" / "response-field-added"） */
  readonly kind: "api-added" | "optional-field-added" | "response-field-added";
  /** 影响 API 路径 */
  readonly apiPath: string;
  /** 影响字段 */
  readonly field?: string;
  /** 描述 */
  readonly description: string;
}

/**
 * 契约兼容性报告（BrownfieldContractGuard 产出）
 */
export interface ContractCompatibilityReport {
  /** 是否兼容（true=无 breaking change） */
  readonly compatible: boolean;
  /** breaking change 列表 */
  readonly breakingChanges: ReadonlyArray<BreakingChange>;
  /** 兼容变更列表（新增 API / 可选字段新增） */
  readonly compatibleChanges: ReadonlyArray<CompatibleChange>;
}

// ============================================================================
// 10. 测试质量静态判定器协议
// ============================================================================

/**
 * 测试质量静态判定器协议
 *
 * 所有测试质量 Checker 必须实现此协议。
 * 与批次 9 coding/static-checkers 的 StaticChecker 协议对齐设计。
 *
 * 实现方负责：
 * 1. 声明 checkerId（如 "assertion-density"）
 * 2. 实现 check() 方法对测试文件做静态质量判定
 *
 * 调用方（TestingOrchestrator）负责：
 * 1. 维护 checkerId → TestQualityChecker 实例的注册表（DEFAULT_TEST_QUALITY_CHECKERS）
 * 2. 调用所有 Checker 收集 TestQualityResult 列表
 */
export interface TestQualityChecker {
  /** Checker ID（如 "assertion-density" / "test-naming" / "coverage-gap"） */
  readonly checkerId: string;
  /** 严重级（blocker/warning） */
  readonly severity: TestQualitySeverity;
  /**
   * 执行静态判定
   *
   * @param testFiles 待判定的测试文件列表
   * @param context 测试质量上下文（含高风险符号列表）
   * @returns 判定结果（含违规项列表）
   */
  check(testFiles: ReadonlyArray<GeneratedTestFile>, context: Readonly<TestQualityContext>): TestQualityResult;
}

/**
 * 测试质量严重级（字面量联合类型）
 *
 * 对齐 §4.7.2 表格：
 * - blocker：阻断级（不通过即打回）
 * - warning：警告级（仅提示不打回）
 */
export type TestQualitySeverity = "blocker" | "warning";

/**
 * TEST_QUALITY_SEVERITIES 全部合法值
 */
export const TEST_QUALITY_SEVERITIES: ReadonlyArray<TestQualitySeverity> = Object.freeze(["blocker", "warning"]);

/**
 * 测试质量上下文
 */
export interface TestQualityContext {
  /** 高风险符号列表（CoverageGapChecker 使用） */
  readonly highRiskSymbols: ReadonlyArray<UncoveredSymbol>;
  /** 项目根目录 */
  readonly projectRoot: string;
}

/**
 * 测试质量判定结果
 */
export interface TestQualityResult {
  /** Checker ID */
  readonly checkerId: string;
  /** 是否通过 */
  readonly passed: boolean;
  /** 违规项列表 */
  readonly violations: ReadonlyArray<TestQualityViolation>;
  /** 严重级（blocker/warning） */
  readonly severity: TestQualitySeverity;
}

/**
 * 测试质量违规项
 */
export interface TestQualityViolation {
  /** 文件路径 */
  readonly filePath: string;
  /** 行号 */
  readonly line: number;
  /** 违规描述 */
  readonly description: string;
  /** 修复建议 */
  readonly suggestion: string;
}

// ============================================================================
// 11. Loop 事件复用导出
// ============================================================================

/**
 * 复用 loop/models.ts 中的 LoopEvent 类型，避免重复定义
 *
 * TESTING Loop 编排器产出的 Loop 事件流使用统一 LoopEvent 结构，
 * 与 design/coding Loop 保持一致，便于跨 Loop 事件聚合与审计。
 *
 * 注：LoopEvent 已在文件顶部通过 type-only import 引入供本模块内部使用，
 * 此处通过 export type 重新导出供外部模块从 testing/types 统一导入。
 */
export type { LoopEvent };

// ============================================================================
// 12. 默认配置常量
// ============================================================================

/**
 * 默认 TESTING Loop 最大迭代次数
 *
 * 数值依据（§4.5.2）：
 * - 5 次迭代覆盖大多数企业测试任务的迭代需求
 * - 由 LoopGuard 强制执行，LLM 不可自改
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MAX_TESTING_ITERATIONS = 5 as const;

/**
 * 默认单文件最大 token 上限（与 CODING Loop 一致，对齐 §4.4.2）
 */
export const DEFAULT_MAX_TOKENS_PER_TEST_FILE = 4000 as const;

/**
 * 默认单次 LLM 调用最大 token 上限（与 CODING Loop 一致）
 */
export const DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL = 8000 as const;

/**
 * 默认 LLM 调用温度（测试代码生成场景，对齐 §4.2.2）
 *
 * 0.2 低温代码生成——测试代码需要确定性，避免高温度产生幻觉断言。
 */
export const DEFAULT_TEST_GENERATION_TEMPERATURE = 0.2 as const;

/**
 * 默认契约测试输出目录（相对 projectRoot）
 */
export const DEFAULT_CONTRACT_TEST_OUTPUT_DIR = "tests/contract/" as const;

/**
 * 默认 E2E 测试输出目录（相对 projectRoot）
 */
export const DEFAULT_E2E_TEST_OUTPUT_DIR = "tests/e2e/" as const;

/**
 * 默认集成测试输出目录（相对 projectRoot）
 */
export const DEFAULT_INTEGRATION_TEST_OUTPUT_DIR = "tests/integration/" as const;

/**
 * 默认高风险符号 Top-N（覆盖率门禁查询时使用）
 */
export const DEFAULT_HIGH_RISK_TOP_N = 10 as const;

/**
 * 覆盖率连续失败升级阈值（对齐 §4.4.2 R-P3-3 风险缓解）
 *
 * 连续 2 次覆盖率 BLOCKER 失败 → 升级为 HUMAN_CHECKPOINT。
 */
export const COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD = 2 as const;

/**
 * 高风险符号风险评分阈值（用于 CoverageGapChecker 判定）
 *
 * 风险评分 ≥0.7 的符号强制必测（对齐 §4.7.6）。
 */
export const HIGH_RISK_SCORE_THRESHOLD = 0.7 as const;

/**
 * 测试用例最小断言密度（每个 it/test 节点至少 1 个断言）
 *
 * 对齐 §4.7.4 AssertionDensityChecker 判定规则。
 */
export const MIN_ASSERTIONS_PER_TEST_CASE = 1 as const;

/**
 * TESTING 默认配置汇总（含所有默认值的只读快照）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
export const TESTING_DEFAULTS: Readonly<{
  readonly maxTestingIterations: number;
  readonly maxTokensPerTestFile: number;
  readonly maxTokensPerTestLlmCall: number;
  readonly testGenerationTemperature: number;
  readonly contractTestOutputDir: string;
  readonly e2eTestOutputDir: string;
  readonly integrationTestOutputDir: string;
  readonly highRiskTopN: number;
  readonly coverageConsecutiveFailureThreshold: number;
  readonly highRiskScoreThreshold: number;
  readonly minAssertionsPerTestCase: number;
}> = Object.freeze({
  maxTestingIterations: DEFAULT_MAX_TESTING_ITERATIONS,
  maxTokensPerTestFile: DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  maxTokensPerTestLlmCall: DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL,
  testGenerationTemperature: DEFAULT_TEST_GENERATION_TEMPERATURE,
  contractTestOutputDir: DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
  e2eTestOutputDir: DEFAULT_E2E_TEST_OUTPUT_DIR,
  integrationTestOutputDir: DEFAULT_INTEGRATION_TEST_OUTPUT_DIR,
  highRiskTopN: DEFAULT_HIGH_RISK_TOP_N,
  coverageConsecutiveFailureThreshold: COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD,
  highRiskScoreThreshold: HIGH_RISK_SCORE_THRESHOLD,
  minAssertionsPerTestCase: MIN_ASSERTIONS_PER_TEST_CASE,
});

// ============================================================================
// 13. 日志回调类型
// ============================================================================

/**
 * 日志回调类型（与 coding 模块对齐，便于跨模块统一日志接口）
 *
 * @param message 日志消息
 * @param level 日志级别（info / warn / error）
 */
export type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

// ============================================================================
// 14. 工厂函数（统一返回 Object.freeze 冻结对象）
// ============================================================================

/**
 * TESTING Loop 编排请求校验错误
 *
 * 当 TestingLoopRequest 的字段非法时抛出。
 */
export class TestingLoopRequestError extends Error {
  /**
   * @param field 非法字段名
   * @param value 非法字段值
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`TestingLoopRequest 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "TestingLoopRequestError";
  }
}

/**
 * 创建 TESTING Loop 编排请求（带字段校验 + 冻结）
 *
 * 工厂函数模式：调用方传入部分字段，工厂函数完成校验并 Object.freeze 冻结。
 *
 * 校验规则：
 * - projectRoot / specContent / planContent / tasksContent 必须为非空字符串
 * - implementationRoot 必须为非空字符串（默认 "src/"）
 * - taskDag 必须含 nodes 数组
 * - acceptanceCriteria 必须为数组（可空）
 * - llmClient 必须实现 LLMClient 接口（含 createMessage 方法）
 * - pkcAccessor 必须实现 PkcAccessor 接口（含 queryBusinessFlows 方法）
 * - loopGuard 必须含 check 与 recordIteration 方法
 * - coverageThreshold 必须含 lines/branches/functions/highRiskSymbols 字段
 * - maxIterations 必须为 ≥1 的数字
 *
 * @param input 请求字段
 * @returns 冻结后的 TestingLoopRequest 对象
 * @throws {TestingLoopRequestError} 任一字段非法时抛出
 */
export function createTestingLoopRequest(input: Readonly<TestingLoopRequest>): Readonly<TestingLoopRequest> {
  // 校验必填字符串字段
  if (typeof input.projectRoot !== "string" || input.projectRoot.trim().length === 0) {
    throw new TestingLoopRequestError("projectRoot", input.projectRoot, "必须为非空字符串");
  }
  if (typeof input.specContent !== "string" || input.specContent.trim().length === 0) {
    throw new TestingLoopRequestError("specContent", input.specContent, "必须为非空字符串");
  }
  if (typeof input.planContent !== "string" || input.planContent.trim().length === 0) {
    throw new TestingLoopRequestError("planContent", input.planContent, "必须为非空字符串");
  }
  if (typeof input.tasksContent !== "string" || input.tasksContent.trim().length === 0) {
    throw new TestingLoopRequestError("tasksContent", input.tasksContent, "必须为非空字符串");
  }
  if (typeof input.implementationRoot !== "string" || input.implementationRoot.trim().length === 0) {
    throw new TestingLoopRequestError("implementationRoot", input.implementationRoot, "必须为非空字符串");
  }

  // 校验 taskDag
  if (!input.taskDag || !Array.isArray(input.taskDag.nodes)) {
    throw new TestingLoopRequestError("taskDag", input.taskDag, "必须含 nodes 数组");
  }

  // 校验 acceptanceCriteria（允许空数组）
  if (!Array.isArray(input.acceptanceCriteria)) {
    throw new TestingLoopRequestError("acceptanceCriteria", input.acceptanceCriteria, "必须为数组");
  }

  // 校验 llmClient（duck-typing：检查 createMessage 方法）
  if (!input.llmClient || typeof input.llmClient.createMessage !== "function") {
    throw new TestingLoopRequestError("llmClient", input.llmClient, "必须实现 LLMClient 接口（含 createMessage 方法）");
  }

  // 校验 pkcAccessor（duck-typing：检查 queryBusinessFlows 方法）
  if (!input.pkcAccessor || typeof input.pkcAccessor.queryBusinessFlows !== "function") {
    throw new TestingLoopRequestError(
      "pkcAccessor",
      input.pkcAccessor,
      "必须实现 PkcAccessor 接口（含 queryBusinessFlows 方法）"
    );
  }

  // 校验 loopGuard（duck-typing：检查 check 与 recordIteration 方法）
  if (
    !input.loopGuard ||
    typeof input.loopGuard.check !== "function" ||
    typeof input.loopGuard.recordIteration !== "function"
  ) {
    throw new TestingLoopRequestError("loopGuard", input.loopGuard, "必须含 check() 与 recordIteration() 方法");
  }

  // 校验 coverageThreshold
  if (
    !input.coverageThreshold ||
    typeof input.coverageThreshold.lines !== "number" ||
    typeof input.coverageThreshold.branches !== "number" ||
    typeof input.coverageThreshold.functions !== "number" ||
    typeof input.coverageThreshold.highRiskSymbols !== "number"
  ) {
    throw new TestingLoopRequestError(
      "coverageThreshold",
      input.coverageThreshold,
      "必须含 lines/branches/functions/highRiskSymbols 数字字段"
    );
  }

  // 校验 maxIterations
  if (typeof input.maxIterations !== "number" || input.maxIterations < 1) {
    throw new TestingLoopRequestError("maxIterations", input.maxIterations, "必须为 ≥1 的数字");
  }

  // 校验 compliancePackIds（可选字段，提供时必须为数组）
  if (input.compliancePackIds !== undefined && !Array.isArray(input.compliancePackIds)) {
    throw new TestingLoopRequestError("compliancePackIds", input.compliancePackIds, "提供时必须为数组");
  }

  // 校验 openapiSpecPath（可选字段，提供时必须为字符串）
  if (input.openapiSpecPath !== undefined && typeof input.openapiSpecPath !== "string") {
    throw new TestingLoopRequestError("openapiSpecPath", input.openapiSpecPath, "提供时必须为字符串");
  }

  // 校验 runId（可选字段，提供时必须为非空字符串）
  if (input.runId !== undefined && (typeof input.runId !== "string" || input.runId.trim().length === 0)) {
    throw new TestingLoopRequestError("runId", input.runId, "提供时必须为非空字符串");
  }

  // 组装并冻结
  return Object.freeze({
    projectRoot: input.projectRoot,
    specContent: input.specContent,
    planContent: input.planContent,
    tasksContent: input.tasksContent,
    implementationRoot: input.implementationRoot,
    taskDag: input.taskDag,
    acceptanceCriteria: Object.freeze([...input.acceptanceCriteria]),
    llmClient: input.llmClient,
    pkcAccessor: input.pkcAccessor,
    loopGuard: input.loopGuard,
    coverageThreshold: Object.freeze({ ...input.coverageThreshold }),
    openapiSpecPath: input.openapiSpecPath,
    compliancePackIds: input.compliancePackIds ? Object.freeze([...input.compliancePackIds]) : undefined,
    maxIterations: input.maxIterations,
    runId: input.runId,
  });
}

/**
 * 创建契约测试规范（带字段校验 + 冻结）
 *
 * @param input 契约测试规范字段
 * @returns 冻结后的 ContractTestSpec
 * @throws {TestingLoopRequestError} 任一字段非法时抛出
 */
export function createContractTestSpec(input: Readonly<ContractTestSpec>): Readonly<ContractTestSpec> {
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    throw new TestingLoopRequestError("path", input.path, "必须为非空字符串");
  }
  if (typeof input.method !== "string" || input.method.trim().length === 0) {
    throw new TestingLoopRequestError("method", input.method, "必须为非空字符串");
  }
  if (!input.responseSchemas || typeof input.responseSchemas !== "object") {
    throw new TestingLoopRequestError("responseSchemas", input.responseSchemas, "必须为对象");
  }
  if (typeof input.requirementId !== "string" || input.requirementId.trim().length === 0) {
    throw new TestingLoopRequestError("requirementId", input.requirementId, "必须为非空字符串");
  }
  if (!Array.isArray(input.boundaryCases)) {
    throw new TestingLoopRequestError("boundaryCases", input.boundaryCases, "必须为数组");
  }

  return Object.freeze({
    path: input.path,
    method: input.method.toUpperCase(),
    requestSchema: input.requestSchema ? Object.freeze({ ...input.requestSchema }) : undefined,
    responseSchemas: Object.freeze({ ...input.responseSchemas }),
    tsSignature: input.tsSignature,
    requirementId: input.requirementId,
    boundaryCases: Object.freeze([...input.boundaryCases]),
  });
}

/**
 * 创建 E2E 测试规范（带字段校验 + 冻结）
 *
 * @param input E2E 测试规范字段
 * @returns 冻结后的 E2eTestSpec
 * @throws {TestingLoopRequestError} 任一字段非法时抛出
 */
export function createE2eTestSpec(input: Readonly<E2eTestSpec>): Readonly<E2eTestSpec> {
  if (typeof input.flowId !== "string" || input.flowId.trim().length === 0) {
    throw new TestingLoopRequestError("flowId", input.flowId, "必须为非空字符串");
  }
  if (typeof input.flowName !== "string" || input.flowName.trim().length === 0) {
    throw new TestingLoopRequestError("flowName", input.flowName, "必须为非空字符串");
  }
  if (!Array.isArray(input.steps)) {
    throw new TestingLoopRequestError("steps", input.steps, "必须为数组");
  }
  if (typeof input.userStory !== "string" || input.userStory.trim().length === 0) {
    throw new TestingLoopRequestError("userStory", input.userStory, "必须为非空字符串");
  }
  if (typeof input.requirementId !== "string" || input.requirementId.trim().length === 0) {
    throw new TestingLoopRequestError("requirementId", input.requirementId, "必须为非空字符串");
  }
  if (!E2E_FLOW_CONFIDENCES.includes(input.confidence)) {
    throw new TestingLoopRequestError("confidence", input.confidence, `必须为 ${E2E_FLOW_CONFIDENCES.join("/")} 之一`);
  }

  return Object.freeze({
    flowId: input.flowId,
    flowName: input.flowName,
    steps: Object.freeze([...input.steps]),
    userStory: input.userStory,
    requirementId: input.requirementId,
    confidence: input.confidence,
  });
}

/**
 * 创建生成的测试文件（带字段校验 + 冻结）
 *
 * @param input 测试文件字段
 * @returns 冻结后的 GeneratedTestFile
 * @throws {TestingLoopRequestError} 任一字段非法时抛出
 */
export function createGeneratedTestFile(input: Readonly<GeneratedTestFile>): Readonly<GeneratedTestFile> {
  if (typeof input.relativePath !== "string" || input.relativePath.trim().length === 0) {
    throw new TestingLoopRequestError("relativePath", input.relativePath, "必须为非空字符串");
  }
  if (typeof input.content !== "string") {
    throw new TestingLoopRequestError("content", input.content, "必须为字符串");
  }
  if (!TEST_FILE_KINDS.includes(input.kind)) {
    throw new TestingLoopRequestError("kind", input.kind, `必须为 ${TEST_FILE_KINDS.join("/")} 之一`);
  }
  if (typeof input.requirementId !== "string" || input.requirementId.trim().length === 0) {
    throw new TestingLoopRequestError("requirementId", input.requirementId, "必须为非空字符串");
  }
  if (typeof input.sourceId !== "string" || input.sourceId.trim().length === 0) {
    throw new TestingLoopRequestError("sourceId", input.sourceId, "必须为非空字符串");
  }
  if (typeof input.testCaseCount !== "number" || input.testCaseCount < 0) {
    throw new TestingLoopRequestError("testCaseCount", input.testCaseCount, "必须为 ≥0 的数字");
  }
  if (!Array.isArray(input.testCaseDescriptions)) {
    throw new TestingLoopRequestError("testCaseDescriptions", input.testCaseDescriptions, "必须为数组");
  }

  return Object.freeze({
    relativePath: input.relativePath,
    content: input.content,
    kind: input.kind,
    requirementId: input.requirementId,
    sourceId: input.sourceId,
    testCaseCount: input.testCaseCount,
    testCaseDescriptions: Object.freeze([...input.testCaseDescriptions]),
  });
}
