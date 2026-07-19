/**
 * EAG（Enterprise Application Generation，企业应用生成）体系根 Barrel
 *
 * 本文件是 EAG 体系 §1~§5.12 全部子模块的统一对外导出入口，
 * 为 session.ts / CLI / API / 集成测试等外部消费者提供单一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5 EAG 体系结构（§5.1~§5.12 共 12+ 子模块）
 * - EAG-P3 批次 10 设计 §2 目录树 `eag/index.ts ★ 新增：EAG 根 barrel（统一对外导出，落地 L-7）`
 * - EAG-P3 批次 10 设计 §1.2.5「EAG 根 barrel 落地——新增 eag/index.ts 统一对外导出，解决遗留 L-7」
 *
 * 导出范围（按 EAG 方案子模块顺序）：
 * 1. evaluator       —— 评估器协议（§5.4 IndependentEvaluator + EvaluationReport + decideVerdict/buildReport）
 * 2. redlines        —— 企业红线 E1~E8（§5.1.3 ENTERPRISE_REDLINES + 查询函数）
 * 3. loop            —— Loop Engineering 五步闭环（§5.2 LoopKernel + LoopScheduler + 4 协议 + 数据模型）
 * 4. rlis            —— 三层规则存储（§5.5 RuleStore + RuleInjector + RuleLearner + 10 条种子规则）
 * 5. eak             —— 企业架构范式库（§5.6 4 范式 + Skill 元数据注册表 + 范式锁定）
 * 6. etsb            —— 技术栈选择（§5.7 矩阵 + 蓝图 + TechStackSelector + SEED-06 锁定）
 * 7. edm             —— 企业域模型（§5.8 5 个公共内核域 + 信号检测 + 3 条红线）
 * 8. tcs             —— 技术组件规范（§5.9 5 组件 + 13 红线 + 26 fixtures）
 * 9. doc-driven      —— 文档驱动开发（§5.10 三文档契约 + 状态机 + 任务分解 + Git 过程）
 * 10. gate           —— 方案先行门禁（§5.12.1 G-1~G-7 七道门禁 + 编排器）
 * 11. design         —— DESIGN Loop（§5.10.5 PM/架构师/评估器三角色编排）
 * 12. discovery      —— 棕地 Discovery（§5.11 BrownfieldDiscovery + ChangeClassifier + ExistingContractGuard）
 * 13. coding         —— CODING Loop（§5.10.5 Phase A 骨架 + Phase B LLM 填充 + STRICT 评估 + FIX 回灌）
 * 14. testing        —— TESTING Loop（§5.10.5 契约测试 + E2E 测试 + 覆盖率门禁，批次 10 新增）
 * 15. long-horizon   —— 长程自动化（§5.12.2 RunState + 多 Loop DAG + /eag-run/resume/status 命令，批次 10 新增）
 *
 * 命名冲突处理说明（重要）：
 * TypeScript `export *` 规范：当多个 `export *` 来源导出同名成员时，该成员在目标模块中
 * 变得"模糊"（ambiguous），不会被自动 re-export，且对类型同名冲突会直接报错 TS2308。
 * 本文件对冲突成员采用显式 `export` / `export type` 明确从权威来源导出，避免歧义。
 *
 * 已知冲突及处理（共 9 项）：
 * 1. LOOP_TYPES（值冲突）：loop/models.ts 与 gate/gate-types.ts 均导出，值相同
 *    - 权威来源：loop/models.ts（EAG §5.2 数据模型层）
 *    - 处理：显式 `export { LOOP_TYPES } from "./loop/models"`
 *
 * 2. deepFreeze（值冲突）：edm/types.ts 与 tcs/types.ts 均导出，实现等价
 *    - 权威来源：tcs/types.ts（EAG §5.9 技术组件规范包，使用面更广）
 *    - 处理：显式 `export { deepFreeze } from "./tcs/types"`（见第 8 节 tcs 模块下方）
 *
 * 3. LogCallback（类型冲突，结构不同）：loop/models.ts、testing/types.ts、long-horizon/types.ts 均导出
 *    - loop/models.ts：`((message: string, level: "INFO" | "WARN") => void) | null`（大写级别 + 可空）
 *    - testing/long-horizon：`(message: string, level?: "info" | "warn" | "error") => void`（小写级别 + 可选）
 *    - 权威来源：loop/models.ts（LoopKernel 构造函数使用，含 `| null` 语义匹配 log 入参）
 *    - 处理：显式 `export type { LogCallback } from "./loop/models"`
 *
 * 4. LoopType（类型冲突，结构相同但来自不同模块）：loop/models.ts 与 gate/gate-types.ts 均导出
 *    - 权威来源：loop/models.ts（EAG §5.2 数据模型层）
 *    - 处理：显式 `export type { LoopType } from "./loop/models"`
 *
 * 5. PkcAccessor（类型冲突，独立声明）：coding/types.ts 与 testing/types.ts 均导出
 *    - 权威来源：coding/types.ts（CODING Loop 先于 TESTING Loop 落地）
 *    - 处理：显式 `export type { PkcAccessor } from "./coding/types"`
 *
 * 6. AcceptanceCriterion（类型冲突，独立声明）：design/design-models.ts 与 testing/types.ts 均导出
 *    - 权威来源：design/design-models.ts（DESIGN Loop 先于 TESTING Loop 落地）
 *    - 处理：显式 `export type { AcceptanceCriterion } from "./design/design-models"`
 *
 * 7. GateG6Context / GateG7Context（类型冲突，独立声明）：gate/gate-types.ts 与 testing/types.ts 均导出
 *    - 权威来源：gate/gate-types.ts（gate 模块是门禁的权威定义源）
 *    - 处理：显式 `export type { GateG6Context, GateG7Context } from "./gate/gate-types"`
 *
 * 8. DagValidationResult（类型冲突，独立声明）：doc-driven/task-decomposition.ts 与 long-horizon/types.ts 均导出
 *    - 权威来源：doc-driven/task-decomposition.ts（任务分解是 doc-driven 的核心职责）
 *    - 处理：显式 `export type { DagValidationResult } from "./doc-driven/task-decomposition"`
 *
 * 9. ModuleSplit（类型冲突，独立声明）：doc-driven/types.ts 与 long-horizon/multi-loop-planner.ts 均导出
 *    - 权威来源：doc-driven/types.ts（plan.md 模块拆分是 doc-driven 的核心产出）
 *    - 处理：显式 `export type { ModuleSplit } from "./doc-driven/types"`
 *
 * 消费者导引：如需 testing 风格的 LogCallback / PkcAccessor / AcceptanceCriterion /
 * GateG6Context / GateG7Context，或 long-horizon 风格的 DagValidationResult / ModuleSplit，
 * 请直接从子模块的 index.ts 导入（如 `import type { LogCallback } from "../eag/testing"`）。
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有子模块导出的常量均已 Object.freeze 冻结
 * - 所有接口字段均使用 readonly 修饰
 * - 顶层 barrel 不引入任何可变状态
 *
 * @module eag
 */

// ============================================================================
// 1. evaluator —— 评估器协议（§5.4）
// ============================================================================
//
// IndependentEvaluator 协议是 EAG 核心契约：Generator 与 Evaluator 严格分离——
// 写代码的模型不给自己打分。评估器按企业红线清单 + 范式一致性规则独立判定。
//
// 公开 API：
// - 类型：EvaluationMode / RedlineSeverity / EvaluationVerdict / RedlineDefinition /
//         RedlineResult / RedlineViolation / EvaluationContext / EvaluationReport / IndependentEvaluator
// - 函数：decideVerdict / buildReport
export * from "./evaluator/types";

// ============================================================================
// 2. redlines —— 企业红线 E1~E8（§5.1.3）
// ============================================================================
//
// 在 Ponytail 16 条红线基础上扩展企业级条目（事务边界/幂等性/审计/依赖方向/输入校验/
// 密钥与配置/贫血模型/API 契约），作为评估器 STRICT 模式的判定清单。
//
// 公开 API：
// - 常量：ENTERPRISE_REDLINES（E1~E8 共 8 条红线，Object.freeze 冻结）
// - 函数：getRedlinesBySeverity / getRedlineById / getEnterpriseRedlineCount
export * from "./redlines/enterprise-rules";

// ============================================================================
// 3. loop —— Loop Engineering 五步闭环（§5.2）
// ============================================================================
//
// LoopKernel 是 EAG 五步闭环编排核心：Discovery → Handoff → Verification → Persistence → Scheduling。
// 通过 Protocol 组合 DiscoveryProbe / HandoffAdapter / IndependentEvaluator / UnifiedMemoryLayer / Scheduler
// 五大可注入组件，支持单 Loop（run）与多 Loop 串联（scheduleMultiLoop，批次 10 新增）两种执行模式。
//
// 公开 API：
// - 数据模型：LoopType / DiscoveryMode / EvaluatorMode / LoopEventType / SchedulingAction /
//             LoopEngineeringConfig / DiscoveryResult / HandoffItem / LoopEvaluationVerdict /
//             LoopEvent / SchedulingDecision / LoopCycleResult / LoopRunReport 等
// - 协议接口：DiscoveryProbeProtocol / HandoffAdapterProtocol /
//             IndependentEvaluatorProtocol / UnifiedMemoryLayerProtocol
// - 类：LoopKernel（五步闭环编排器）/ LoopScheduler（调度决策器）
// - 工厂函数：createLoopEngineeringConfig
// - 常量：LOOP_TYPES / DISCOVERY_MODES / EVALUATOR_MODES / LOOP_EVENT_TYPES /
//         SCHEDULING_ACTIONS / DEFAULT_LOOP_ENGINEERING_CONFIG 等
export * from "./loop/models";
export * from "./loop/protocols";
export * from "./loop/kernel";
export * from "./loop/scheduler";

// ============================================================================
// 4. rlis —— 三层规则存储（§5.5）
// ============================================================================
//
// RLIS（Rule Learning & Injection System）三层规则存储（seed / global / project），
// 提供 10 条 SEED 规则 + 规则注入器 + 规则学习器，支撑 Loop 内规则的自助演进。
//
// 公开 API：
// - 类型：RuleCategory / RuleSeverity / RuleSource / RuleConfirmedBy / UserRule / RuleCandidate /
//         RuleStoreLayer / RuleStoreSnapshot / RuleInjectionConfig
// - 类：RuleStore / RuleInjector / RuleLearner
// - 函数：compareSeverity / getSeedRuleById / getSeedRulesBySeverity / getSeedRulesByCategory 等
// - 常量：RULE_CATEGORIES / RULE_SEVERITIES / RULE_SOURCES / RULE_STORE_LAYERS /
//         SEVERITY_PRIORITY / SEED_RULES 等
export * from "./rlis/index";

// ============================================================================
// 5. eak —— 企业架构范式库（§5.6）
// ============================================================================
//
// EAK（Enterprise Architecture Knowledge）维护 4 种架构范式（DDD 分层 / Clean Architecture /
// CQRS+ES / Microservice）+ 6 个 Skill 元数据注册表 + paradigm_lock 范式锁定机制。
//
// 公开 API：
// - 类型：ParadigmId / ApplicabilitySignals / ArchitectureParadigm / ParadigmLockConfig 等
// - 常量：PARADIGM_IDS / SKELETON_LANGUAGES / 4 个范式常量 / EAG_SKILLS
// - 函数：getParadigmById / getAllParadigms / selectParadigm / validateParadigmLock 等
// - Skill API：getAllEagSkills / getEagSkillById / getEagSkillsByPhase / getEagSkillsByParadigm
export * from "./eak/index";

// ============================================================================
// 6. etsb —— 技术栈选择（§5.7）
// ============================================================================
//
// ETSB（Enterprise Tech Stack Blueprint）维护 4 语言 × 10 层技术选型矩阵 + 3 套部署蓝图 +
// TechStackSelector 选型决策器 + SEED-06 技术栈锁定（变更须用户显式批准）。
//
// 公开 API：
// - 类型：TechLanguage / TechLayer / TechStackOption / TechStackMatrix / TechStackDecision /
//         DeploymentBlueprint / TechStackLock / TechStackSelectionInput 等
// - 常量：TECH_LANGUAGES / TECH_LAYERS / DEPLOYMENT_BLUEPRINT_IDS / TECH_STACK_MATRIX /
//         DEPLOYMENT_BLUEPRINTS
// - 类：TechStackSelector
// - 函数：getTechStackOptions / selectDeploymentBlueprint / lockTechStack / unlockTechStack /
//         validateDependencyChange 等
export * from "./etsb/index";

// ============================================================================
// 7. edm —— 企业域模型（§5.8）
// ============================================================================
//
// EDM（Enterprise Data Model）维护 5 个公共内核域预定义模型（用户/组织/角色/功能权限/数据权限）+
// EdmSignalDetector 信号检测器 + 3 条 EDM 专属红线（EDM-01/02/03）。
//
// 公开 API：
// - 类型：EdmDomainId / EdmDomainDefinition / EdmDetectionResult / EdmRedlineViolation 等
// - 常量：EDM_DOMAIN_IDS / EDM_REDLINE_IDS / 5 个域定义常量 / EDM_ALL_DOMAINS / EDM_REDLINE_CHECKERS
// - 类：EdmSignalDetector
// - 函数：checkEdm01FrontendOnlyPermission / checkEdm02DataScopeQueryRewriteCoverage /
//         checkEdm03RoleMutualExclusionCheck
//
// 命名冲突处理：
// - edm/types.ts 与 tcs/types.ts 均导出 deepFreeze 函数（实现等价）
// - 在 `export *` 之后通过下方第 8 节 tcs 模块的显式 `export { deepFreeze } from "./tcs/types"`
//   锁定 tcs 为权威来源；edm 的 deepFreeze 不参与根 barrel 导出。
export * from "./edm/index";

// ============================================================================
// 8. tcs —— 技术组件规范（§5.9）
// ============================================================================
//
// TCS（Technical Component Specification）维护 5 大技术组件规范（对象存储/多级缓存/SQL 优化/
// LDAP 同步/漏洞扫描）+ 13 条 TCS 红线 + 26 个 redline-fixtures 样例（13 红线 × 2 样例）。
//
// 公开 API：
// - 类型：TcsRedlineId / ObjectStoragePort / CachePort / SqlOptimizationPort / LdapSyncPort /
//         VulnerabilityScanPort / RedlineFixture 等
// - 类：S3Adapter / OssAdapter / MinioAdapter / MultiLevelCache / BloomFilter /
//         IndexReviewer / NPlusOneDetector / PaginationChecker / SqlOptimizer /
//         LdapSynchronizer / VulnerabilityScanner
// - 函数：generateStorageKey / generateCacheKey / createObjectStorage / createCache /
//         createSqlOptimizer / createLdapSynchronizer / createVulnerabilityScanner 等
// - 常量：TCS_REDLINES / TCS_FIXTURES / 各类默认配置常量
//
// 命名冲突处理（deepFreeze）：
// - tcs/types.ts 与 edm/types.ts 均导出 deepFreeze 函数（实现等价）
// - 显式从 tcs/types 导出 deepFreeze，作为根 barrel 的权威来源
export * from "./tcs/index";
// 显式锁定 deepFreeze 权威来源为 tcs/types（避免与 edm/types 冲突导致 `export *` 模糊跳过）
export { deepFreeze } from "./tcs/types";

// ============================================================================
// 9. doc-driven —— 文档驱动开发（§5.10）
// ============================================================================
//
// 文档驱动开发 Loop：三文档契约（spec → plan → tasks）+ 文档状态机 + 任务分解 DAG +
// Git 过程管理自动化（分支/提交/PR/删除纪律）+ CONSTITUTION.md 构建器。
//
// 公开 API：
// - 类型：DocumentType / DocumentState / EagDocument / FunctionalRequirement / TaskNode /
//         TaskDag / CommitType / GitProcessConfig / ConstitutionInput / PrDescription 等
// - 类：DocumentStateMachine / TaskDecomposer / GitProcessManager / PlanGenerator / TasksGenerator
// - 函数：buildConstitution / createDefaultGitProcessConfig / createInitialDocument
// - 异常：DocumentStateMachineError / TaskDecompositionError / GitProcessError 等
export * from "./doc-driven/index";

// ============================================================================
// 10. gate —— 方案先行门禁（§5.12.1）
// ============================================================================
//
// 七道门禁（G-1~G-7）+ GateOrchestrator 编排器：
// - G-1：无已批准 spec/plan 禁入 CODING Loop
// - G-2：方案必经多角色评审 + 用户批准
// - G-3：方案偏离检测（≥3 符号级偏离触发 HUMAN_CHECKPOINT）
// - G-4：CODING Loop 进入门禁（任务卡完整性 + 模板可用性 + 技术栈锁定 + 输出目录可写）
// - G-5：CODING Loop 退出门禁（任务卡全 completed + STRICT 通过 + git clean + gitleaks）
// - G-6：TESTING Loop 进入门禁（G-5 通过 + 单测全过 + spec.md approved）（批次 10 新增）
// - G-7：TESTING Loop 退出门禁（覆盖率达标 + 契约/E2E 全过 + 合规证据 + PR 描述就绪）（批次 10 新增）
//
// 公开 API：
// - 类型：GateId / GateSeverity / GateContext / GateResult / GateOrchestrationResult /
//         GateG4Context / GateG5Context / GateG6Context / GateG7Context / TestExecutionResult 等
// - 类：GateG1Checker / GateG2Checker / GateG3Checker / GateG4Checker / GateG5Checker /
//       GateG6Checker / GateG7Checker / GateOrchestrator
// - 常量：GATE_IDS / REVIEW_ROLES / G2_MIN_REVIEW_ROLES / G2_FULL_REVIEW_ROLES / G3_DEVIATION_THRESHOLD
// - 异常：GateOrchestratorError
//
// 命名冲突处理（LOOP_TYPES）：
// - gate/gate-types.ts 与 loop/models.ts 均导出 LOOP_TYPES 常量（值相同：["design","coding","testing"]）
// - 在 `export *` 之后通过下方显式 `export { LOOP_TYPES } from "./loop/models"`
//   锁定 loop/models 为权威来源；gate/gate-types 的 LOOP_TYPES 不参与根 barrel 导出。
// - gate 的其他成员（GateG1Checker~GateG7Checker / GateOrchestrator / GATE_IDS / REVIEW_ROLES 等）正常导出。
export * from "./gate/index";

// ============================================================================
// 11. design —— DESIGN Loop（§5.10.5）
// ============================================================================
//
// DESIGN Loop 三角色编排（PM / Architect / DesignEvaluator）+ 文档 schema 渲染器/校验器 +
// StaticDesignEvaluator 真实判定实现 + DesignLoopOrchestrator 编排器。
//
// 公开 API：
// - 类型：DesignLoopInput / ProjectContext / UserStory / StructuredRequirement /
//         ArchitectureDocument / DomainModelDocument / DesignArtifacts / DesignEvaluationVerdict 等
// - 常量：DEFAULT_DESIGN_LOOP_CONFIG / ARCHITECTURE_MD_SECTIONS / DOMAIN_MODEL_MD_SECTIONS
// - 协议接口：ProductManagerProtocol / ArchitectProtocol / DesignEvaluatorProtocol
// - 渲染器与校验器：renderArchitectureMd / renderDomainModelMd / validateArchitectureMd / validateDomainModelMd
// - 评估器实现：StaticDesignEvaluator
// - 编排器：DesignLoopOrchestrator
export * from "./design/index";

// ============================================================================
// 12. discovery —— 棕地 Discovery（§5.11）
// ============================================================================
//
// 棕地项目 Discovery 流程：BrownfieldDiscovery 流程编排 + ChangeClassifier 变更分类器 +
// ExistingContractGuard 既有契约保护判定器（API 兼容性检测）。
//
// 公开 API：
// - 类型：ChangeType / ExistingModelSnapshot / IncrementalChange / ContractViolation /
//         ContractViolationType / TechDebtReport 等
// - 类：BrownfieldDiscovery / ChangeClassifier / ExistingContractGuard
// - 常量：CHANGE_TYPES / CONTRACT_VIOLATION_TYPES / REQUIREMENT_KEYWORD_MAPPING
export * from "./discovery/index";

// ============================================================================
// 13. coding —— CODING Loop（§5.10.5）
// ============================================================================
//
// CODING Loop 五阶段实现：Phase A 骨架生成（EJS 模板）+ Phase B LLM 填充 + STRICT 评估 +
// FIX 回灌循环 + CodingOrchestrator 编排器 + 13 个静态判定器 + 13 个 EJS 模板。
//
// 公开 API：
// - 类型：GeneratedFileKind / GeneratedFile / SkeletonGenerationRequest / LlmFillRequest /
//         CodingContext / StrictEvaluationRequest / FixLoopRequest / CodingLoopRequest 等
// - 类：SkeletonGenerator / ContextAssembler / StrictEvaluator / LlmFiller / FixLoop /
//         UnifiedDiffApplier / InMemoryLLMClient / CodingOrchestrator
// - 模板：DEFAULT_TEMPLATE_REGISTRY + 13 种 EJS 模板（AGGREGATE_TEMPLATE 等）
// - 工厂函数：createSkeletonGenerationRequest / createLlmFillRequest / createCodingLoopRequest 等
// - 异常：SkeletonGeneratorError / LlmFillerError / FixLoopError / CodingOrchestratorError 等
export * from "./coding/index";

// ============================================================================
// 14. testing —— TESTING Loop（§5.10.5，批次 10 新增）
// ============================================================================
//
// TESTING Loop 主体：契约测试生成（OpenAPI/接口签名 AST 双通道）+ E2E 测试生成
// （PKC L3 K2 业务流程图 + 用户故事）+ 覆盖率门禁（c8 + 高风险符号必测）+
// 既有契约保护判定 + TestingOrchestrator 编排器 + 3 个测试质量静态判定器。
//
// 公开 API：
// - 类型：TestFileKind / GeneratedTestFile / ContractTestSpec / E2eTestSpec / CoverageReport /
//         TestingLoopRequest / TestingLoopResult / BrownfieldContractGuardRequest 等
// - 类：ContractTestGenerator / OpenApiSpecParser / TsSignatureExtractor /
//         E2eTestGenerator / CoverageGate / C8ReportParser / BrownfieldContractGuard /
//         TestingOrchestrator / AssertionDensityChecker / TestNamingChecker / CoverageGapChecker
// - 工厂函数：createDefaultContractTestGenerator / createDefaultE2eTestGenerator /
//         createDefaultCoverageGate / createDefaultTestingOrchestrator 等
// - 常量：TEST_FILE_KINDS / DEFAULT_COVERAGE_THRESHOLD / TESTING_DEFAULTS 等
//
// 命名冲突处理（LogCallback）：
// - testing/types.ts 与 loop/models.ts 均导出 LogCallback 类型，但结构不同：
//   - loop/models.ts：`((message: string, level: "INFO" | "WARN") => void) | null`（大写级别 + 可空）
//   - testing/types.ts：`(message: string, level?: "info" | "warn" | "error") => void`（小写级别 + 可选）
// - 在 `export *` 之后通过下方 loop 模块的显式 `export type { LogCallback } from "./loop/models"`
//   锁定 loop/models 为权威来源；testing 的 LogCallback 不参与根 barrel 导出。
// - 消费者如需 testing 风格的 LogCallback，请从 `../eag/testing` 直接导入。
export * from "./testing/index";

// ============================================================================
// 15. long-horizon —— 长程自动化（§5.12.2，批次 10 新增）
// ============================================================================
//
// 长程任务自动化基础：RunState JSONL 持久化（SHA256 防腐化）+ 多 Loop 串联计划
// （DESIGN→CODING→TESTING DAG）+ /eag-run 自动流转 + /eag-resume 断点续跑 +
// /eag-status 进度报告 + 里程碑 tag 自动回归 + 阻塞分析报告。
//
// 公开 API：
// - 类型：RunState / MilestoneRecord / MultiLoopPlan / MultiLoopNode / LoopTransition /
//         BlockageReport / RootCauseHypothesis / MultiLoopRunReport 等
// - 类：RunStateStore / FileLockProvider / MultiLoopPlanner / EagRunHandler /
//         EagResumeHandler / EagStatusHandler / MilestoneTagger / HealthScoreCalculator /
//         BlockageAnalyzer / RootCauseRuleMatcher
// - 常量：RUN_STATE_STATUSES / DEFAULT_LOOP_TRANSITIONS / DEFAULT_ROOT_CAUSE_RULES /
//         LONG_HORIZON_DEFAULTS 等
// - 异常：RunStateStoreError / RunStateCorruptedError / MultiLoopPlannerError /
//         EagRunHandlerError / EagResumeHandlerError / EagStatusHandlerError /
//         MilestoneTaggerError / BlockageAnalyzerError 等
//
// 命名冲突处理（LogCallback / LoopType / LoopEvent / LoopRunReport）：
// - long-horizon/types.ts 通过 `export type` 透传导出 loop/models 的 LoopType / LoopEvent / LoopRunReport
//   （type-only re-export，与 loop/models 同源，TypeScript `export *` 自动合并，不冲突）
// - long-horizon/types.ts 独立声明 LogCallback（结构同 testing，与 loop 不同）：
//   通过下方 loop 模块的显式 `export type { LogCallback } from "./loop/models"`
//   锁定 loop/models 为权威来源；long-horizon 的 LogCallback 不参与根 barrel 导出。
export * from "./long-horizon/index";

// ============================================================================
// 显式锁定命名冲突成员的权威来源
// ============================================================================
//
// 以下显式 export 用于解决 `export *` 在多个子模块间遇到同名成员时的"模糊跳过"问题，
// 明确从权威来源导出，避免消费者在根 barrel 中找不到这些成员。
//
// 1. LOOP_TYPES（值冲突）：loop/models.ts 为权威来源（EAG §5.2 数据模型层）
//    - gate/gate-types.ts 中的 LOOP_TYPES 值相同，但不参与根 barrel 导出
//    - 消费者从根 barrel 导入的 LOOP_TYPES 即 loop/models 的版本
export { LOOP_TYPES } from "./loop/models";

// 2. deepFreeze（值冲突）：tcs/types.ts 为权威来源（EAG §5.9 技术组件规范包，使用面更广）
//    - edm/types.ts 中的 deepFreeze 实现等价，但不参与根 barrel 导出
//    - 消费者从根 barrel 导入的 deepFreeze 即 tcs/types 的版本
//    （已在第 8 节 tcs 模块下方显式导出，此处不再重复）

// 3. LogCallback（类型冲突，结构不同）：loop/models.ts 为权威来源
//    （EAG §5.2 Loop Engineering 核心数据模型，被 LoopKernel 构造函数使用，含 `| null` 语义匹配 log 入参）
//    - testing/types.ts 与 long-horizon/types.ts 的 LogCallback 结构不同（小写级别 + 可选 level）
//    - 消费者如需 testing/long-horizon 风格的 LogCallback，请从子模块直接导入：
//      `import type { LogCallback } from "../eag/testing"` 或 `"../eag/long-horizon"`
export type { LogCallback } from "./loop/models";

// 4. LoopType（类型冲突，结构相同但来自不同模块）：loop/models.ts 为权威来源
//    - gate/gate-types.ts 中独立声明了 `export type LoopType = "design" | "coding" | "testing"`
//      （虽与 loop/models 结构相同，但 TypeScript `export *` 视为冲突）
//    - 显式从 loop/models 导出，gate/gate-types 的 LoopType 不参与根 barrel 导出
export type { LoopType } from "./loop/models";

// 5. PkcAccessor（类型冲突，结构相似但独立声明）：coding/types.ts 为权威来源
//    - coding/types.ts 与 testing/types.ts 都独立声明了 `export interface PkcAccessor`
//      （testing 模块为避免循环依赖，独立声明而非 re-export）
//    - 显式从 coding/types 导出，testing 的 PkcAccessor 不参与根 barrel 导出
//    - 消费者如需 testing 风格的 PkcAccessor（含 queryBusinessFlows 等方法），结构兼容，可直接使用
export type { PkcAccessor } from "./coding/types";

// 6. AcceptanceCriterion（类型冲突，结构相似但独立声明）：design/design-models.ts 为权威来源
//    - design/design-models.ts 与 testing/types.ts 都独立声明了 `export interface AcceptanceCriterion`
//    - 显式从 design/design-models 导出，testing 的 AcceptanceCriterion 不参与根 barrel 导出
export type { AcceptanceCriterion } from "./design/design-models";

// 7. GateG6Context / GateG7Context（类型冲突，结构相似但独立声明）：gate/gate-types.ts 为权威来源
//    - gate/gate-types.ts 与 testing/types.ts 都独立声明了 GateG6Context / GateG7Context
//    - 显式从 gate/gate-types 导出，testing 的同名类型不参与根 barrel 导出
export type { GateG6Context, GateG7Context } from "./gate/gate-types";

// 8. DagValidationResult（类型冲突，结构相似但独立声明）：doc-driven/task-decomposition.ts 为权威来源
//    - doc-driven/task-decomposition.ts 与 long-horizon/types.ts 都独立声明了 `export interface DagValidationResult`
//    - 显式从 doc-driven/task-decomposition 导出，long-horizon 的 DagValidationResult 不参与根 barrel 导出
export type { DagValidationResult } from "./doc-driven/task-decomposition";

// 9. ModuleSplit（类型冲突，结构相似但独立声明）：doc-driven/types.ts 为权威来源
//    - doc-driven/types.ts 与 long-horizon/multi-loop-planner.ts 都独立声明了 `export interface ModuleSplit`
//    - 显式从 doc-driven/types 导出，long-horizon/multi-loop-planner 的 ModuleSplit 不参与根 barrel 导出
export type { ModuleSplit } from "./doc-driven/types";
