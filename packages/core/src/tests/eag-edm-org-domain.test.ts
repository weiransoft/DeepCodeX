/**
 * EAG-P1 批次 4 单元测试：组织域预定义模型完整性
 *
 * 测试范围：
 * - O1. ORG_DOMAIN 基本字段（id/name/description）
 * - O2. ORG_DOMAIN 已冻结（Object.isFrozen）
 * - O3. OrgUnitAggregate 聚合字段完整性（树形 + 物化路径 + 左右值双写）
 * - O4. OrgUnitAggregate 不变式约束（树结构完整性）
 * - O5. OrgUnitAggregate 内部实体（PositionEntity/ReportingLineEntity）
 * - O6. MaterializedPathVO 值对象字段完整性
 * - O7. OrgNodeVO 值对象字段完整性（含 lft/rgt）
 * - O8. 3 个领域事件完整性（OrgChangedEvent/OrgUnitCreatedEvent/PositionChangedEvent）
 * - O9. OrgChangedEvent 订阅者含权限缓存失效处理器
 * - O10. 信号词完整性（部门/组织/组织架构/汇报/岗位/组织树）
 * - O11. 描述长度约束
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实 ORG_DOMAIN 常量
 *
 * 设计依据：
 * - EAG 方案 §5.7.1 组织域设计决策 + §5.8.3 查询优化
 * - eag/edm/edm-domains/org-domain.ts 组织域定义文件
 *
 * @module core/tests/eag-edm-org-domain
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ORG_DOMAIN } from "../eag/edm/edm-domains/org-domain";

// ============================================================================
// O1. ORG_DOMAIN 基本字段
// ============================================================================

test("O1a. ORG_DOMAIN.id 为 'org'", () => {
  assert.equal(ORG_DOMAIN.id, "org");
});

test("O1b. ORG_DOMAIN.name 为 '组织域'", () => {
  assert.equal(ORG_DOMAIN.name, "组织域");
});

test("O1c. ORG_DOMAIN.description 非空且描述充分（>= 50 字符）", () => {
  assert.ok(ORG_DOMAIN.description.length >= 50);
  // 描述应包含关键词"物化路径"或"左右值"或"岗位"
  assert.ok(
    ORG_DOMAIN.description.includes("物化路径") ||
      ORG_DOMAIN.description.includes("左右值") ||
      ORG_DOMAIN.description.includes("岗位")
  );
});

// ============================================================================
// O2. ORG_DOMAIN 已冻结
// ============================================================================

test("O2a. ORG_DOMAIN 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(ORG_DOMAIN), true);
});

test("O2b. ORG_DOMAIN.aggregates 数组已冻结", () => {
  assert.equal(Object.isFrozen(ORG_DOMAIN.aggregates), true);
});

test("O2c. ORG_DOMAIN.domainEvents 数组已冻结", () => {
  assert.equal(Object.isFrozen(ORG_DOMAIN.domainEvents), true);
});

// ============================================================================
// O3. OrgUnitAggregate 聚合字段完整性
// ============================================================================

test("O3a. ORG_DOMAIN 含 1 个聚合（OrgUnitAggregate）", () => {
  assert.equal(ORG_DOMAIN.aggregates.length, 1);
  assert.equal(ORG_DOMAIN.aggregates[0].name, "OrgUnitAggregate");
});

test("O3b. OrgUnitAggregate.rootEntity 为 'OrgUnitEntity'", () => {
  assert.equal(ORG_DOMAIN.aggregates[0].rootEntity, "OrgUnitEntity");
});

test("O3c. OrgUnitAggregate.invariants 非空（至少 3 条不变式）", () => {
  assert.ok(ORG_DOMAIN.aggregates[0].invariants.length >= 3);
});

test("O3d. OrgUnitAggregate.invariants 包含组织树循环引用禁止约束", () => {
  const invariants = ORG_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(invariants.includes("循环引用"), "OrgUnitAggregate 不变式应包含'循环引用'禁止约束");
});

test("O3e. OrgUnitAggregate.invariants 包含物化路径与左右值双写一致性约束", () => {
  const invariants = ORG_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(
    invariants.includes("物化路径") && invariants.includes("左右值"),
    "OrgUnitAggregate 不变式应包含物化路径与左右值双写一致性约束"
  );
});

// ============================================================================
// O4. OrgUnitAggregate 内部实体
// ============================================================================

test("O4a. OrgUnitAggregate.containedEntities 含 PositionEntity（岗位）", () => {
  const entities = ORG_DOMAIN.aggregates[0].containedEntities;
  assert.ok(entities.includes("PositionEntity"));
});

test("O4b. OrgUnitAggregate.containedEntities 含 ReportingLineEntity（汇报关系）", () => {
  const entities = ORG_DOMAIN.aggregates[0].containedEntities;
  assert.ok(entities.includes("ReportingLineEntity"));
});

test("O4c. OrgUnitAggregate.valueObjects 含 MaterializedPathVO/OrgNodeVO", () => {
  const voList = ORG_DOMAIN.aggregates[0].valueObjects;
  assert.ok(voList.includes("MaterializedPathVO"));
  assert.ok(voList.includes("OrgNodeVO"));
});

// ============================================================================
// O5. MaterializedPathVO 值对象字段完整性
// ============================================================================

test("O5a. MaterializedPathVO 含 path/depth/ancestorIds 字段", () => {
  const vo = ORG_DOMAIN.valueObjects.find((v) => v.name === "MaterializedPathVO");
  assert.ok(vo, "MaterializedPathVO 不存在");
  const attrNames = vo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("path"));
  assert.ok(attrNames.includes("depth"));
  assert.ok(attrNames.includes("ancestorIds"));
});

test("O5b. MaterializedPathVO.path 必填", () => {
  const vo = ORG_DOMAIN.valueObjects.find((v) => v.name === "MaterializedPathVO");
  assert.ok(vo);
  const pathAttr = vo.attributes.find((a) => a.name === "path");
  assert.ok(pathAttr);
  assert.equal(pathAttr.required, true);
});

// ============================================================================
// O6. OrgNodeVO 值对象字段完整性（含 lft/rgt）
// ============================================================================

test("O6a. OrgNodeVO 含 lft/rgt 字段（左右值双写）", () => {
  const vo = ORG_DOMAIN.valueObjects.find((v) => v.name === "OrgNodeVO");
  assert.ok(vo, "OrgNodeVO 不存在");
  const attrNames = vo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("lft"));
  assert.ok(attrNames.includes("rgt"));
});

test("O6b. OrgNodeVO 含 path 字段（类型为 MaterializedPathVO）", () => {
  const vo = ORG_DOMAIN.valueObjects.find((v) => v.name === "OrgNodeVO");
  assert.ok(vo);
  const pathAttr = vo.attributes.find((a) => a.name === "path");
  assert.ok(pathAttr);
  assert.ok(pathAttr.type.includes("MaterializedPathVO"));
});

// ============================================================================
// O7. 3 个领域事件完整性
// ============================================================================

test("O7a. ORG_DOMAIN.domainEvents 含 3 个事件", () => {
  assert.equal(ORG_DOMAIN.domainEvents.length, 3);
});

test("O7b. OrgChangedEvent 发布者为 OrgUnitAggregate", () => {
  const evt = ORG_DOMAIN.domainEvents.find((e) => e.name === "OrgChangedEvent");
  assert.ok(evt);
  assert.equal(evt.publisher, "OrgUnitAggregate");
});

test("O7c. OrgChangedEvent 订阅者含 PermissionCacheInvalidator（权限缓存失效）", () => {
  const evt = ORG_DOMAIN.domainEvents.find((e) => e.name === "OrgChangedEvent");
  assert.ok(evt);
  assert.ok(
    evt.subscribers.includes("PermissionCacheInvalidator"),
    "OrgChangedEvent 订阅者应包含 PermissionCacheInvalidator（组织变更驱动权限缓存失效）"
  );
});

test("O7d. OrgChangedEvent 订阅者含 DataScopeCacheInvalidator（数据权限缓存失效）", () => {
  const evt = ORG_DOMAIN.domainEvents.find((e) => e.name === "OrgChangedEvent");
  assert.ok(evt);
  assert.ok(
    evt.subscribers.includes("DataScopeCacheInvalidator"),
    "OrgChangedEvent 订阅者应包含 DataScopeCacheInvalidator（组织变更驱动数据权限缓存失效）"
  );
});

test("O7e. OrgChangedEvent.payload 含 changeType 字段（move/delete/rename）", () => {
  const evt = ORG_DOMAIN.domainEvents.find((e) => e.name === "OrgChangedEvent");
  assert.ok(evt);
  const changeTypeAttr = evt.payload.find((p) => p.name === "changeType");
  assert.ok(changeTypeAttr);
  assert.ok(changeTypeAttr.type.includes("move"));
  assert.ok(changeTypeAttr.type.includes("delete"));
  assert.ok(changeTypeAttr.type.includes("rename"));
});

test("O7f. PositionChangedEvent.payload 含 userId 与 newPosition", () => {
  const evt = ORG_DOMAIN.domainEvents.find((e) => e.name === "PositionChangedEvent");
  assert.ok(evt);
  const payloadNames = evt.payload.map((p) => p.name);
  assert.ok(payloadNames.includes("userId"));
  assert.ok(payloadNames.includes("newPosition"));
});

// ============================================================================
// O8. 信号词完整性
// ============================================================================

test("O8a. ORG_DOMAIN.signalKeywords 含 6 个信号词", () => {
  assert.equal(ORG_DOMAIN.signalKeywords.length, 6);
});

test("O8b. signalKeywords 包含部门/组织/组织架构/汇报/岗位/组织树", () => {
  const keywords = ORG_DOMAIN.signalKeywords;
  assert.ok(keywords.includes("部门"));
  assert.ok(keywords.includes("组织"));
  assert.ok(keywords.includes("组织架构"));
  assert.ok(keywords.includes("汇报"));
  assert.ok(keywords.includes("岗位"));
  assert.ok(keywords.includes("组织树"));
});

// ============================================================================
// O9. 描述长度约束
// ============================================================================

test("O9a. 每条不变式描述 >= 20 字符", () => {
  for (const inv of ORG_DOMAIN.aggregates[0].invariants) {
    assert.ok(inv.length >= 20, `不变式描述过短：${inv}`);
  }
});

test("O9b. 每个领域事件的订阅者非空（至少 1 个）", () => {
  for (const evt of ORG_DOMAIN.domainEvents) {
    assert.ok(evt.subscribers.length >= 1, `事件 ${evt.name} 无订阅者`);
  }
});
