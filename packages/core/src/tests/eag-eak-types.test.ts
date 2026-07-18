/**
 * EAG-P1 批次 2 单元测试：EAK 核心类型定义完整性
 *
 * 测试范围：
 * - T1. ParadigmId 类型与 PARADIGM_IDS 常量
 * - T2. ApplicabilitySignals 接口字段可正确赋值
 * - T3. SignalEvidence 类型支持 Readonly<Record>
 * - T4. SkeletonTemplate 接口与 SKELETON_LANGUAGES 常量
 * - T5. DependencyRule 接口
 * - T6. NamingConvention 与 NamingElement
 * - T7. AntiPattern 接口
 * - T8. ArchitectureParadigm 接口聚合性
 * - T9. ParadigmLockConfig 接口
 * - T10. PARADIGM_IDS 已冻结（Object.isFrozen）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例（构造真实对象验证字段赋值）
 * - 类型层面验证通过构造真实对象 + 字段访问实现
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 架构范式库定义
 * - eag/eak/types.ts 源文件（被测对象）
 *
 * @module core/tests/eag-eak-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PARADIGM_IDS,
  SKELETON_LANGUAGES,
  type ParadigmId,
  type ApplicabilitySignals,
  type SignalEvidence,
  type SkeletonTemplate,
  type DependencyRule,
  type NamingElement,
  type NamingConvention,
  type AntiPattern,
  type ArchitectureParadigm,
  type ParadigmLockConfig,
} from "../eag/eak/types";

// ============================================================================
// T1. ParadigmId 类型与 PARADIGM_IDS 常量
// ============================================================================

test("T1a. PARADIGM_IDS 长度 = 4", () => {
  assert.equal(PARADIGM_IDS.length, 4);
});

test("T1b. PARADIGM_IDS 包含全部 4 个范式 ID", () => {
  const expectedIds: ParadigmId[] = ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"];
  assert.deepEqual([...PARADIGM_IDS], expectedIds);
});

test("T1c. PARADIGM_IDS 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(PARADIGM_IDS));
});

test("T1d. ParadigmId 类型可正确赋值 4 个字面量", () => {
  // 通过赋值验证字面量联合类型合法
  const ids: ParadigmId[] = ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"];
  assert.equal(ids.length, 4);
});

// ============================================================================
// T2. ApplicabilitySignals 接口字段可正确赋值
// ============================================================================

test("T2. ApplicabilitySignals 接口字段可正确赋值（4 维度全部取值）", () => {
  // 构造真实信号对象验证字段可赋值
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  assert.equal(signals.domainComplexity, "high");
  assert.equal(signals.consistencyRequirement, "strong");
  assert.equal(signals.readWritePattern, "balanced");
  assert.equal(signals.integrationComplexity, "monolith");
});

test("T2b. ApplicabilitySignals 所有合法取值都可赋值", () => {
  // domainComplexity 三档
  const complexities: ApplicabilitySignals["domainComplexity"][] = ["low", "medium", "high"];
  assert.equal(complexities.length, 3);

  // consistencyRequirement 两档
  const consistencies: ApplicabilitySignals["consistencyRequirement"][] = ["strong", "eventual"];
  assert.equal(consistencies.length, 2);

  // readWritePattern 三档
  const patterns: ApplicabilitySignals["readWritePattern"][] = ["balanced", "read-heavy", "write-heavy"];
  assert.equal(patterns.length, 3);

  // integrationComplexity 三档
  const integrations: ApplicabilitySignals["integrationComplexity"][] = [
    "monolith",
    "few-integrations",
    "many-systems",
  ];
  assert.equal(integrations.length, 3);
});

// ============================================================================
// T3. SignalEvidence 类型支持 Readonly<Record>
// ============================================================================

test("T3. SignalEvidence 类型支持 Readonly<Record>（键值对赋值）", () => {
  const evidence: SignalEvidence = {
    domainComplexity: "需求中提到'订单/库存/支付多个领域对象'",
    consistencyRequirement: "需求要求'扣款与扣库存必须同时成功'",
  };
  assert.equal(Object.keys(evidence).length, 2);
  assert.equal(evidence.domainComplexity, "需求中提到'订单/库存/支付多个领域对象'");
});

// ============================================================================
// T4. SkeletonTemplate 接口与 SKELETON_LANGUAGES 常量
// ============================================================================

test("T4a. SKELETON_LANGUAGES 长度 = 4（typescript/java/python/go）", () => {
  assert.equal(SKELETON_LANGUAGES.length, 4);
});

test("T4b. SKELETON_LANGUAGES 包含全部 4 个语言", () => {
  const expectedLangs = ["typescript", "java", "python", "go"];
  assert.deepEqual([...SKELETON_LANGUAGES], expectedLangs);
});

test("T4c. SKELETON_LANGUAGES 已冻结", () => {
  assert.ok(Object.isFrozen(SKELETON_LANGUAGES));
});

test("T4d. SkeletonTemplate 接口可正确赋值（含嵌套 entryFiles 数组）", () => {
  const template: SkeletonTemplate = {
    language: "typescript",
    directories: ["src/domain", "src/application"],
    entryFiles: [
      { path: "src/domain/aggregate.ts", purpose: "聚合根定义" },
      { path: "src/application/service.ts", purpose: "应用服务" },
    ],
    configFile: "tsconfig.json",
  };
  assert.equal(template.language, "typescript");
  assert.equal(template.directories.length, 2);
  assert.equal(template.entryFiles.length, 2);
  assert.equal(template.configFile, "tsconfig.json");
  assert.equal(template.entryFiles[0].path, "src/domain/aggregate.ts");
  assert.equal(template.entryFiles[0].purpose, "聚合根定义");
});

// ============================================================================
// T5. DependencyRule 接口
// ============================================================================

test("T5. DependencyRule 接口可正确赋值（含 severity 三档）", () => {
  const rule: DependencyRule = {
    id: "DEP-DOM-01",
    description: "领域层不得依赖基础设施层",
    fromLayer: "domain",
    forbiddenToLayers: ["infrastructure", "application", "interfaces"],
    severity: "blocker",
  };
  assert.equal(rule.id, "DEP-DOM-01");
  assert.equal(rule.fromLayer, "domain");
  assert.equal(rule.forbiddenToLayers.length, 3);
  assert.equal(rule.severity, "blocker");
});

test("T5b. DependencyRule severity 三档全部合法", () => {
  const severities: DependencyRule["severity"][] = ["blocker", "major", "warning"];
  assert.equal(severities.length, 3);
});

// ============================================================================
// T6. NamingConvention 与 NamingElement
// ============================================================================

test("T6a. NamingElement 全部 7 个元素类型合法", () => {
  const elements: NamingElement[] = [
    "aggregate-root",
    "entity",
    "value-object",
    "domain-event",
    "application-service",
    "repository",
    "factory",
  ];
  assert.equal(elements.length, 7);
});

test("T6b. NamingConvention 接口可正确赋值", () => {
  const convention: NamingConvention = {
    element: "aggregate-root",
    pattern: "XxxAggregate",
    description: "聚合根类名以 Aggregate 后缀结尾",
  };
  assert.equal(convention.element, "aggregate-root");
  assert.equal(convention.pattern, "XxxAggregate");
  assert.ok(convention.description.length > 0);
});

// ============================================================================
// T7. AntiPattern 接口
// ============================================================================

test("T7. AntiPattern 接口可正确赋值（含 detection 与 severity）", () => {
  const antiPattern: AntiPattern = {
    id: "AP-ANEMIC-01",
    name: "anemic-domain-model",
    description: "贫血模型——实体仅有 getter/setter 无业务方法",
    detection: "reasoning",
    severity: "warning",
  };
  assert.equal(antiPattern.id, "AP-ANEMIC-01");
  assert.equal(antiPattern.name, "anemic-domain-model");
  assert.equal(antiPattern.detection, "reasoning");
  assert.equal(antiPattern.severity, "warning");
});

test("T7b. AntiPattern detection 两档（static / reasoning）全部合法", () => {
  const detections: AntiPattern["detection"][] = ["static", "reasoning"];
  assert.equal(detections.length, 2);
});

// ============================================================================
// T8. ArchitectureParadigm 接口聚合性
// ============================================================================

test("T8. ArchitectureParadigm 接口聚合所有子类型字段", () => {
  // 构造完整的 ArchitectureParadigm 实例验证字段聚合性
  const paradigm: ArchitectureParadigm = {
    id: "ddd-layered",
    name: "DDD 分层架构",
    description: "领域驱动设计四层架构",
    applicabilitySignals: {
      domainComplexity: "high",
      consistencyRequirement: "strong",
      readWritePattern: "balanced",
      integrationComplexity: "monolith",
    },
    skeletonTemplates: [
      {
        language: "typescript",
        directories: ["src/domain"],
        entryFiles: [{ path: "src/domain/aggregate.ts", purpose: "聚合根" }],
        configFile: "tsconfig.json",
      },
    ],
    dependencyRules: [
      {
        id: "DEP-DOM-01",
        description: "domain 不得依赖 infrastructure",
        fromLayer: "domain",
        forbiddenToLayers: ["infrastructure"],
        severity: "blocker",
      },
    ],
    namingConventions: [
      {
        element: "aggregate-root",
        pattern: "XxxAggregate",
        description: "聚合根命名规范",
      },
    ],
    antiPatterns: [
      {
        id: "AP-ANEMIC-01",
        name: "anemic-domain-model",
        description: "贫血模型",
        detection: "reasoning",
        severity: "warning",
      },
    ],
  };

  // 验证字段聚合性
  assert.equal(paradigm.id, "ddd-layered");
  assert.equal(paradigm.name, "DDD 分层架构");
  assert.equal(paradigm.applicabilitySignals.domainComplexity, "high");
  assert.equal(paradigm.skeletonTemplates.length, 1);
  assert.equal(paradigm.dependencyRules.length, 1);
  assert.equal(paradigm.namingConventions.length, 1);
  assert.equal(paradigm.antiPatterns.length, 1);
});

test("T8b. ArchitectureParadigm signalEvidence 字段可选", () => {
  // 不提供 signalEvidence 也合法
  const paradigm: ArchitectureParadigm = {
    id: "clean-architecture",
    name: "Clean Architecture",
    description: "整洁架构",
    applicabilitySignals: {
      domainComplexity: "medium",
      consistencyRequirement: "strong",
      readWritePattern: "balanced",
      integrationComplexity: "few-integrations",
    },
    skeletonTemplates: [],
    dependencyRules: [],
    namingConventions: [],
    antiPatterns: [],
  };
  assert.equal(paradigm.signalEvidence, undefined);
});

test("T8c. ArchitectureParadigm signalEvidence 可选字段可赋值", () => {
  const paradigm: ArchitectureParadigm = {
    id: "cqrs-es",
    name: "CQRS + Event Sourcing",
    description: "命令查询分离 + 事件溯源",
    applicabilitySignals: {
      domainComplexity: "high",
      consistencyRequirement: "eventual",
      readWritePattern: "read-heavy",
      integrationComplexity: "many-systems",
    },
    signalEvidence: {
      domainComplexity: "需求中提到'订单状态机复杂'",
      consistencyRequirement: "需求允许'读模型滞后几秒'",
    },
    skeletonTemplates: [],
    dependencyRules: [],
    namingConventions: [],
    antiPatterns: [],
  };
  assert.ok(paradigm.signalEvidence !== undefined);
  assert.equal(Object.keys(paradigm.signalEvidence!).length, 2);
});

// ============================================================================
// T9. ParadigmLockConfig 接口
// ============================================================================

test("T9a. ParadigmLockConfig 接口可正确赋值（locked=true 场景）", () => {
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "clean-architecture",
    reason: "组织规范要求采用 Clean Architecture",
  };
  assert.equal(lock.locked, true);
  assert.equal(lock.paradigmId, "clean-architecture");
  assert.ok(lock.reason.length > 0);
});

test("T9b. ParadigmLockConfig 接口可正确赋值（locked=false 场景）", () => {
  const lock: ParadigmLockConfig = {
    locked: false,
    paradigmId: null,
    reason: "未锁定，按信号匹配",
  };
  assert.equal(lock.locked, false);
  assert.equal(lock.paradigmId, null);
});

// ============================================================================
// T10. PARADIGM_IDS 已冻结（Object.isFrozen）
// ============================================================================

test("T10a. PARADIGM_IDS 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(PARADIGM_IDS));
});

test("T10b. SKELETON_LANGUAGES 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(SKELETON_LANGUAGES));
});
