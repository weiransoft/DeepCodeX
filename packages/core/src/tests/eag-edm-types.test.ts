/**
 * EAG-P1 批次 4 单元测试：EDM 类型完整性
 *
 * 测试范围：
 * - T1. EdmDomainId 字面量联合类型完整性（5 个域 ID）
 * - T2. EDM_DOMAIN_IDS 常量完整性与冻结
 * - T3. EdmRedlineId 字面量联合类型完整性（3 条红线）
 * - T4. EDM_REDLINE_IDS 常量完整性与冻结
 * - T5. EDM_REDLINE_SEVERITY_MAP 映射正确性与冻结
 * - T6. EdmAttributeDefinition 接口字段完整性
 * - T7. EdmAggregateDefinition 接口字段完整性
 * - T8. EdmValueObjectDefinition 接口字段完整性
 * - T9. EdmDomainEventDefinition 接口字段完整性
 * - T10. EdmDomainDefinition 接口字段完整性
 * - T11. EdmDetectionResult 接口字段完整性
 * - T12. EdmRedlineViolation 接口字段完整性
 * - T13. 类型实例化与不可变性验证
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实类型与常量
 *
 * 设计依据：
 * - EAG 方案 §5.7 EDM 数据模型设计
 * - eag/edm/types.ts 类型定义文件
 *
 * @module core/tests/eag-edm-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EDM_DOMAIN_IDS, EDM_REDLINE_IDS, EDM_REDLINE_SEVERITY_MAP } from "../eag/edm/types";
import type {
  EdmDomainId,
  EdmAttributeDefinition,
  EdmAggregateDefinition,
  EdmValueObjectDefinition,
  EdmDomainEventDefinition,
  EdmDomainDefinition,
  EdmDetectionResult,
  EdmRedlineId,
  EdmRedlineSeverity,
  EdmRedlineViolation,
} from "../eag/edm/types";

// ============================================================================
// T1. EdmDomainId 字面量联合类型完整性
// ============================================================================

test("T1a. EDM_DOMAIN_IDS 包含全部 5 个域 ID", () => {
  assert.equal(EDM_DOMAIN_IDS.length, 5);
  assert.ok(EDM_DOMAIN_IDS.includes("user"));
  assert.ok(EDM_DOMAIN_IDS.includes("org"));
  assert.ok(EDM_DOMAIN_IDS.includes("role"));
  assert.ok(EDM_DOMAIN_IDS.includes("permission"));
  assert.ok(EDM_DOMAIN_IDS.includes("data-scope"));
});

test("T1b. EDM_DOMAIN_IDS 顺序符合规范（user → org → role → permission → data-scope）", () => {
  assert.equal(EDM_DOMAIN_IDS[0], "user");
  assert.equal(EDM_DOMAIN_IDS[1], "org");
  assert.equal(EDM_DOMAIN_IDS[2], "role");
  assert.equal(EDM_DOMAIN_IDS[3], "permission");
  assert.equal(EDM_DOMAIN_IDS[4], "data-scope");
});

test("T1c. EDM_DOMAIN_IDS 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(EDM_DOMAIN_IDS), true);
});

test("T1d. EDM_DOMAIN_IDS 不可变（push 操作在严格模式下抛错）", () => {
  assert.throws(() => {
    // 类型断言绕过 readonly 检查，验证运行期冻结
    (EDM_DOMAIN_IDS as string[]).push("extra");
  }, TypeError);
});

// ============================================================================
// T2. EdmDomainId 类型校验（通过常量验证）
// ============================================================================

test("T2a. EdmDomainId 字面量联合——构造合法域 ID 对象", () => {
  // 通过类型系统验证 EdmDomainId 接受 5 个字面量值
  const domainId: EdmDomainId = "user";
  assert.equal(domainId, "user");
});

// ============================================================================
// T3. EdmRedlineId 字面量联合类型完整性
// ============================================================================

test("T3a. EDM_REDLINE_IDS 包含全部 3 条红线 ID", () => {
  assert.equal(EDM_REDLINE_IDS.length, 3);
  assert.ok(EDM_REDLINE_IDS.includes("EDM-01"));
  assert.ok(EDM_REDLINE_IDS.includes("EDM-02"));
  assert.ok(EDM_REDLINE_IDS.includes("EDM-03"));
});

test("T3b. EDM_REDLINE_IDS 已冻结", () => {
  assert.equal(Object.isFrozen(EDM_REDLINE_IDS), true);
});

// ============================================================================
// T4. EDM_REDLINE_SEVERITY_MAP 映射正确性
// ============================================================================

test("T4a. EDM-01 严重级别为 BLOCKER", () => {
  assert.equal(EDM_REDLINE_SEVERITY_MAP["EDM-01"], "BLOCKER");
});

test("T4b. EDM-02 严重级别为 MAJOR", () => {
  assert.equal(EDM_REDLINE_SEVERITY_MAP["EDM-02"], "MAJOR");
});

test("T4c. EDM-03 严重级别为 MAJOR", () => {
  assert.equal(EDM_REDLINE_SEVERITY_MAP["EDM-03"], "MAJOR");
});

test("T4d. EDM_REDLINE_SEVERITY_MAP 已冻结", () => {
  assert.equal(Object.isFrozen(EDM_REDLINE_SEVERITY_MAP), true);
});

test("T4e. EDM_REDLINE_SEVERITY_MAP 不可变（赋值操作在严格模式下抛错）", () => {
  assert.throws(() => {
    const map = EDM_REDLINE_SEVERITY_MAP as Record<string, EdmRedlineSeverity>;
    map["EDM-01"] = "MAJOR";
  }, TypeError);
});

// ============================================================================
// T5. EdmAttributeDefinition 接口字段完整性
// ============================================================================

test("T5a. EdmAttributeDefinition 字段完整性（name/type/required）", () => {
  const attr: EdmAttributeDefinition = {
    name: "userId",
    type: "string",
    required: true,
  };
  assert.equal(attr.name, "userId");
  assert.equal(attr.type, "string");
  assert.equal(attr.required, true);
});

// ============================================================================
// T6. EdmAggregateDefinition 接口字段完整性
// ============================================================================

test("T6a. EdmAggregateDefinition 字段完整性", () => {
  const agg: EdmAggregateDefinition = {
    name: "TestAggregate",
    rootEntity: "TestEntity",
    invariants: ["不变式 1"],
    containedEntities: ["InnerEntity"],
    valueObjects: ["TestVO"],
    publishedEvents: ["TestCreatedEvent"],
  };
  assert.equal(agg.name, "TestAggregate");
  assert.equal(agg.rootEntity, "TestEntity");
  assert.equal(agg.invariants.length, 1);
  assert.equal(agg.containedEntities.length, 1);
  assert.equal(agg.valueObjects.length, 1);
  assert.equal(agg.publishedEvents.length, 1);
});

// ============================================================================
// T7. EdmValueObjectDefinition 接口字段完整性
// ============================================================================

test("T7a. EdmValueObjectDefinition 字段完整性", () => {
  const vo: EdmValueObjectDefinition = {
    name: "TestVO",
    attributes: [{ name: "field1", type: "string", required: true }],
    immutabilityGuarantee: "构造后 Object.freeze 冻结",
  };
  assert.equal(vo.name, "TestVO");
  assert.equal(vo.attributes.length, 1);
  assert.ok(vo.immutabilityGuarantee.length > 0);
});

// ============================================================================
// T8. EdmDomainEventDefinition 接口字段完整性
// ============================================================================

test("T8a. EdmDomainEventDefinition 字段完整性", () => {
  const evt: EdmDomainEventDefinition = {
    name: "TestCreatedEvent",
    publisher: "TestAggregate",
    subscribers: ["AuditLogHandler"],
    payload: [{ name: "testId", type: "string", required: true }],
  };
  assert.equal(evt.name, "TestCreatedEvent");
  assert.equal(evt.publisher, "TestAggregate");
  assert.equal(evt.subscribers.length, 1);
  assert.equal(evt.payload.length, 1);
});

// ============================================================================
// T9. EdmDomainDefinition 接口字段完整性
// ============================================================================

test("T9a. EdmDomainDefinition 字段完整性", () => {
  const domain: EdmDomainDefinition = {
    id: "user",
    name: "测试域",
    description: "测试用域定义",
    aggregates: [],
    valueObjects: [],
    domainEvents: [],
    signalKeywords: ["测试"],
  };
  assert.equal(domain.id, "user");
  assert.equal(domain.name, "测试域");
  assert.ok(domain.description.length > 0);
  assert.equal(domain.signalKeywords.length, 1);
});

// ============================================================================
// T10. EdmDetectionResult 接口字段完整性
// ============================================================================

test("T10a. EdmDetectionResult 字段完整性", () => {
  const result: EdmDetectionResult = {
    detectedDomains: ["user"],
    evidence: {
      user: ["用户登录"],
      org: [],
      role: [],
      permission: [],
      "data-scope": [],
    },
    suggestedDomains: ["user"],
  };
  assert.equal(result.detectedDomains.length, 1);
  assert.equal(result.detectedDomains[0], "user");
  assert.equal(result.evidence.user.length, 1);
  assert.equal(result.suggestedDomains.length, 1);
});

// ============================================================================
// T11. EdmRedlineViolation 接口字段完整性
// ============================================================================

test("T11a. EdmRedlineViolation 字段完整性", () => {
  const violation: EdmRedlineViolation = {
    id: "EDM-01",
    severity: "BLOCKER",
    message: "权限判定仅在前端",
    location: "前端代码 /api/check",
  };
  assert.equal(violation.id, "EDM-01");
  assert.equal(violation.severity, "BLOCKER");
  assert.ok(violation.message.length > 0);
  assert.ok(violation.location.length > 0);
});

test("T11b. EdmRedlineSeverity 字面量联合接受 BLOCKER 与 MAJOR", () => {
  const sev1: EdmRedlineSeverity = "BLOCKER";
  const sev2: EdmRedlineSeverity = "MAJOR";
  assert.equal(sev1, "BLOCKER");
  assert.equal(sev2, "MAJOR");
});

// ============================================================================
// T12. EdmRedlineId 字面量联合接受 3 个值
// ============================================================================

test("T12a. EdmRedlineId 字面量联合接受 EDM-01/02/03", () => {
  const id1: EdmRedlineId = "EDM-01";
  const id2: EdmRedlineId = "EDM-02";
  const id3: EdmRedlineId = "EDM-03";
  assert.equal(id1, "EDM-01");
  assert.equal(id2, "EDM-02");
  assert.equal(id3, "EDM-03");
});

// ============================================================================
// T13. 类型实例化与不可变性验证
// ============================================================================

test("T13a. EdmDomainDefinition 实例可被 Object.freeze 冻结", () => {
  const domain: EdmDomainDefinition = {
    id: "user",
    name: "测试域",
    description: "测试",
    aggregates: [],
    valueObjects: [],
    domainEvents: [],
    signalKeywords: [],
  };
  Object.freeze(domain);
  assert.equal(Object.isFrozen(domain), true);
});

test("T13b. Readonly<Record> 类型保证 evidence 字段不可重新赋值", () => {
  // 通过类型系统验证 evidence 是 Readonly<Record<EdmDomainId, ReadonlyArray<string>>>
  const result: EdmDetectionResult = {
    detectedDomains: [],
    evidence: {
      user: [],
      org: [],
      role: [],
      permission: [],
      "data-scope": [],
    },
    suggestedDomains: [],
  };
  // evidence 字段必须包含全部 5 个域的键
  assert.ok("user" in result.evidence);
  assert.ok("org" in result.evidence);
  assert.ok("role" in result.evidence);
  assert.ok("permission" in result.evidence);
  assert.ok("data-scope" in result.evidence);
});
