/**
 * EAG-P1 批次 4 单元测试：角色域 + 功能权限域 + 数据权限域完整性
 *
 * 本测试文件合并测试 3 个域（角色域 / 功能权限域 / 数据权限域），
 * 以减少测试文件数量（任务要求合并测试以减少文件数）。
 *
 * 测试范围：
 * - R1. ROLE_DOMAIN 基本字段与冻结
 * - R2. RoleAggregate 聚合字段完整性（角色继承 + SoD 互斥）
 * - R3. RoleHierarchyVO / SoDConstraintVO 值对象字段
 * - R4. 4 个领域事件（RoleCreatedEvent/RoleAssignedEvent/RoleRevokedEvent/RoleInheritanceChangedEvent）
 * - R5. 角色域信号词完整性
 * - P1. PERMISSION_DOMAIN 基本字段与冻结
 * - P2. PermissionAggregate 聚合字段完整性（菜单/API/按钮三级资源）
 * - P3. PermissionResourceVO / PermissionActionVO 值对象字段
 * - P4. 3 个领域事件（PermissionGrantedEvent/PermissionRevokedEvent/MenuVisibilityChangedEvent）
 * - P5. 功能权限域信号词完整性
 * - D1. DATA_SCOPE_DOMAIN 基本字段与冻结
 * - D2. DataScopeAggregate 聚合字段完整性（行级五级 + 列级脱敏）
 * - D3. RowLevelScopeVO / ColumnMaskRuleVO 值对象字段
 * - D4. 2 个领域事件（DataScopeChangedEvent/FieldMaskAppliedEvent）
 * - D5. 数据权限域信号词完整性
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实域常量
 *
 * 设计依据：
 * - EAG 方案 §5.7.1 角色域/功能权限域/数据权限域设计决策
 * - eag/edm/edm-domains/role-domain.ts / permission-domain.ts / data-scope-domain.ts
 *
 * @module core/tests/eag-edm-role-domain
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_DOMAIN } from "../eag/edm/edm-domains/role-domain";
import { PERMISSION_DOMAIN } from "../eag/edm/edm-domains/permission-domain";
import { DATA_SCOPE_DOMAIN } from "../eag/edm/edm-domains/data-scope-domain";

// ============================================================================
// R1. ROLE_DOMAIN 基本字段与冻结
// ============================================================================

test("R1a. ROLE_DOMAIN.id 为 'role'", () => {
  assert.equal(ROLE_DOMAIN.id, "role");
});

test("R1b. ROLE_DOMAIN.name 为 '角色域'", () => {
  assert.equal(ROLE_DOMAIN.name, "角色域");
});

test("R1c. ROLE_DOMAIN.description 非空且含 SoD 或互斥关键词", () => {
  assert.ok(ROLE_DOMAIN.description.length >= 50);
  assert.ok(
    ROLE_DOMAIN.description.includes("SoD") || ROLE_DOMAIN.description.includes("互斥"),
    "角色域描述应提及 SoD 或互斥约束"
  );
});

test("R1d. ROLE_DOMAIN 已冻结", () => {
  assert.equal(Object.isFrozen(ROLE_DOMAIN), true);
});

// ============================================================================
// R2. RoleAggregate 聚合字段完整性
// ============================================================================

test("R2a. ROLE_DOMAIN 含 1 个聚合（RoleAggregate）", () => {
  assert.equal(ROLE_DOMAIN.aggregates.length, 1);
  assert.equal(ROLE_DOMAIN.aggregates[0].name, "RoleAggregate");
});

test("R2b. RoleAggregate.invariants 包含 DAG 约束（禁止循环继承）", () => {
  const invariants = ROLE_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(
    invariants.includes("DAG") || invariants.includes("循环继承"),
    "RoleAggregate 不变式应包含 DAG / 循环继承约束"
  );
});

test("R2c. RoleAggregate.invariants 包含 SoD 互斥约束", () => {
  const invariants = ROLE_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(invariants.includes("SoD") || invariants.includes("互斥"), "RoleAggregate 不变式应包含 SoD 互斥约束");
});

test("R2d. RoleAggregate.containedEntities 含 RoleAssignmentEntity", () => {
  const entities = ROLE_DOMAIN.aggregates[0].containedEntities;
  assert.ok(entities.includes("RoleAssignmentEntity"));
});

test("R2e. RoleAggregate.valueObjects 含 RoleHierarchyVO/SoDConstraintVO", () => {
  const voList = ROLE_DOMAIN.aggregates[0].valueObjects;
  assert.ok(voList.includes("RoleHierarchyVO"));
  assert.ok(voList.includes("SoDConstraintVO"));
});

// ============================================================================
// R3. RoleHierarchyVO / SoDConstraintVO 值对象字段
// ============================================================================

test("R3a. RoleHierarchyVO 含 parentRoleId/childRoleId 字段", () => {
  const vo = ROLE_DOMAIN.valueObjects.find((v) => v.name === "RoleHierarchyVO");
  assert.ok(vo);
  const attrNames = vo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("parentRoleId"));
  assert.ok(attrNames.includes("childRoleId"));
});

test("R3b. SoDConstraintVO 含 roleIdA/roleIdB/constraintType 字段", () => {
  const vo = ROLE_DOMAIN.valueObjects.find((v) => v.name === "SoDConstraintVO");
  assert.ok(vo);
  const attrNames = vo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("roleIdA"));
  assert.ok(attrNames.includes("roleIdB"));
  assert.ok(attrNames.includes("constraintType"));
});

// ============================================================================
// R4. 4 个领域事件完整性
// ============================================================================

test("R4a. ROLE_DOMAIN.domainEvents 含 4 个事件", () => {
  assert.equal(ROLE_DOMAIN.domainEvents.length, 4);
});

test("R4b. RoleAssignedEvent.payload 含 sodChecked 字段（SoD 校验标志）", () => {
  const evt = ROLE_DOMAIN.domainEvents.find((e) => e.name === "RoleAssignedEvent");
  assert.ok(evt);
  const payloadNames = evt.payload.map((p) => p.name);
  assert.ok(payloadNames.includes("sodChecked"), "RoleAssignedEvent.payload 应含 sodChecked 字段（对应 EDM-03 红线）");
});

test("R4c. RoleAssignedEvent 订阅者含 PermissionCacheInvalidator", () => {
  const evt = ROLE_DOMAIN.domainEvents.find((e) => e.name === "RoleAssignedEvent");
  assert.ok(evt);
  assert.ok(evt.subscribers.includes("PermissionCacheInvalidator"));
});

test("R4d. RoleInheritanceChangedEvent.payload 含 changeType 字段（add/remove）", () => {
  const evt = ROLE_DOMAIN.domainEvents.find((e) => e.name === "RoleInheritanceChangedEvent");
  assert.ok(evt);
  const changeTypeAttr = evt.payload.find((p) => p.name === "changeType");
  assert.ok(changeTypeAttr);
  assert.ok(changeTypeAttr.type.includes("add"));
  assert.ok(changeTypeAttr.type.includes("remove"));
});

// ============================================================================
// R5. 角色域信号词完整性
// ============================================================================

test("R5a. ROLE_DOMAIN.signalKeywords 含 6 个信号词", () => {
  assert.equal(ROLE_DOMAIN.signalKeywords.length, 6);
});

test("R5b. signalKeywords 包含角色/权限角色/角色继承/职责分离/SoD/互斥", () => {
  const keywords = ROLE_DOMAIN.signalKeywords;
  assert.ok(keywords.includes("角色"));
  assert.ok(keywords.includes("权限角色"));
  assert.ok(keywords.includes("角色继承"));
  assert.ok(keywords.includes("职责分离"));
  assert.ok(keywords.includes("SoD"));
  assert.ok(keywords.includes("互斥"));
});

// ============================================================================
// P1. PERMISSION_DOMAIN 基本字段与冻结
// ============================================================================

test("P1a. PERMISSION_DOMAIN.id 为 'permission'", () => {
  assert.equal(PERMISSION_DOMAIN.id, "permission");
});

test("P1b. PERMISSION_DOMAIN.name 为 '功能权限域'", () => {
  assert.equal(PERMISSION_DOMAIN.name, "功能权限域");
});

test("P1c. PERMISSION_DOMAIN.description 含三级资源关键词", () => {
  assert.ok(PERMISSION_DOMAIN.description.length >= 50);
  assert.ok(
    PERMISSION_DOMAIN.description.includes("菜单") &&
      PERMISSION_DOMAIN.description.includes("API") &&
      PERMISSION_DOMAIN.description.includes("按钮"),
    "功能权限域描述应提及菜单/API/按钮三级资源"
  );
});

test("P1d. PERMISSION_DOMAIN 已冻结", () => {
  assert.equal(Object.isFrozen(PERMISSION_DOMAIN), true);
});

// ============================================================================
// P2. PermissionAggregate 聚合字段完整性
// ============================================================================

test("P2a. PERMISSION_DOMAIN 含 1 个聚合（PermissionAggregate）", () => {
  assert.equal(PERMISSION_DOMAIN.aggregates.length, 1);
  assert.equal(PERMISSION_DOMAIN.aggregates[0].name, "PermissionAggregate");
});

test("P2b. PermissionAggregate.containedEntities 含 MenuEntity/ApiEntity/ButtonEntity（三级资源）", () => {
  const entities = PERMISSION_DOMAIN.aggregates[0].containedEntities;
  assert.ok(entities.includes("MenuEntity"));
  assert.ok(entities.includes("ApiEntity"));
  assert.ok(entities.includes("ButtonEntity"));
});

test("P2c. PermissionAggregate.invariants 含按钮归属约束", () => {
  const invariants = PERMISSION_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(invariants.includes("按钮"), "PermissionAggregate 不变式应包含按钮相关约束");
});

test("P2d. PermissionAggregate.publishedEvents 含 3 个事件", () => {
  assert.equal(PERMISSION_DOMAIN.aggregates[0].publishedEvents.length, 3);
});

// ============================================================================
// P3. PermissionResourceVO / PermissionActionVO 值对象字段
// ============================================================================

test("P3a. PermissionResourceVO 含 resourceType 字段（menu/api/button）", () => {
  const vo = PERMISSION_DOMAIN.valueObjects.find((v) => v.name === "PermissionResourceVO");
  assert.ok(vo);
  const resourceTypeAttr = vo.attributes.find((a) => a.name === "resourceType");
  assert.ok(resourceTypeAttr);
  assert.ok(resourceTypeAttr.type.includes("menu"));
  assert.ok(resourceTypeAttr.type.includes("api"));
  assert.ok(resourceTypeAttr.type.includes("button"));
});

test("P3b. PermissionActionVO 含 action 字段（create/read/update/delete 等）", () => {
  const vo = PERMISSION_DOMAIN.valueObjects.find((v) => v.name === "PermissionActionVO");
  assert.ok(vo);
  const actionAttr = vo.attributes.find((a) => a.name === "action");
  assert.ok(actionAttr);
  assert.ok(actionAttr.type.includes("create"));
  assert.ok(actionAttr.type.includes("read"));
  assert.ok(actionAttr.type.includes("update"));
  assert.ok(actionAttr.type.includes("delete"));
});

// ============================================================================
// P4. 3 个领域事件完整性
// ============================================================================

test("P4a. PERMISSION_DOMAIN.domainEvents 含 3 个事件", () => {
  assert.equal(PERMISSION_DOMAIN.domainEvents.length, 3);
});

test("P4b. PermissionGrantedEvent 订阅者含 PermissionCacheInvalidator", () => {
  const evt = PERMISSION_DOMAIN.domainEvents.find((e) => e.name === "PermissionGrantedEvent");
  assert.ok(evt);
  assert.ok(evt.subscribers.includes("PermissionCacheInvalidator"));
});

test("P4c. MenuVisibilityChangedEvent.payload 含 visible 字段（boolean）", () => {
  const evt = PERMISSION_DOMAIN.domainEvents.find((e) => e.name === "MenuVisibilityChangedEvent");
  assert.ok(evt);
  const visibleAttr = evt.payload.find((p) => p.name === "visible");
  assert.ok(visibleAttr);
  assert.ok(visibleAttr.type.includes("boolean"));
});

// ============================================================================
// P5. 功能权限域信号词完整性
// ============================================================================

test("P5a. PERMISSION_DOMAIN.signalKeywords 含 6 个信号词", () => {
  assert.equal(PERMISSION_DOMAIN.signalKeywords.length, 6);
});

test("P5b. signalKeywords 包含权限/菜单/API 权限/按钮/功能权限/RBAC", () => {
  const keywords = PERMISSION_DOMAIN.signalKeywords;
  assert.ok(keywords.includes("权限"));
  assert.ok(keywords.includes("菜单"));
  assert.ok(keywords.includes("API 权限"));
  assert.ok(keywords.includes("按钮"));
  assert.ok(keywords.includes("功能权限"));
  assert.ok(keywords.includes("RBAC"));
});

// ============================================================================
// D1. DATA_SCOPE_DOMAIN 基本字段与冻结
// ============================================================================

test("D1a. DATA_SCOPE_DOMAIN.id 为 'data-scope'", () => {
  assert.equal(DATA_SCOPE_DOMAIN.id, "data-scope");
});

test("D1b. DATA_SCOPE_DOMAIN.name 为 '数据权限域'", () => {
  assert.equal(DATA_SCOPE_DOMAIN.name, "数据权限域");
});

test("D1c. DATA_SCOPE_DOMAIN.description 含查询改写关键词", () => {
  assert.ok(DATA_SCOPE_DOMAIN.description.length >= 50);
  assert.ok(DATA_SCOPE_DOMAIN.description.includes("查询改写"), "数据权限域描述应提及'查询改写'（对应 EDM-02 红线）");
});

test("D1d. DATA_SCOPE_DOMAIN 已冻结", () => {
  assert.equal(Object.isFrozen(DATA_SCOPE_DOMAIN), true);
});

// ============================================================================
// D2. DataScopeAggregate 聚合字段完整性
// ============================================================================

test("D2a. DATA_SCOPE_DOMAIN 含 1 个聚合（DataScopeAggregate）", () => {
  assert.equal(DATA_SCOPE_DOMAIN.aggregates.length, 1);
  assert.equal(DATA_SCOPE_DOMAIN.aggregates[0].name, "DataScopeAggregate");
});

test("D2b. DataScopeAggregate.containedEntities 含 FieldMaskRuleEntity", () => {
  const entities = DATA_SCOPE_DOMAIN.aggregates[0].containedEntities;
  assert.ok(entities.includes("FieldMaskRuleEntity"));
});

test("D2c. DataScopeAggregate.invariants 含查询改写覆盖约束（对应 EDM-02）", () => {
  const invariants = DATA_SCOPE_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(
    invariants.includes("查询改写") && invariants.includes("覆盖"),
    "DataScopeAggregate 不变式应包含查询改写覆盖约束"
  );
});

test("D2d. DataScopeAggregate.invariants 含行级范围合法性约束（五级模型）", () => {
  const invariants = DATA_SCOPE_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(
    invariants.includes("SELF") || invariants.includes("五级"),
    "DataScopeAggregate 不变式应包含行级五级模型约束"
  );
});

// ============================================================================
// D3. RowLevelScopeVO / ColumnMaskRuleVO 值对象字段
// ============================================================================

test("D3a. RowLevelScopeVO.scopeType 含五级模型（SELF/DEPT/DEPT_AND_SUBTREE/CUSTOM_ORGS/ALL）", () => {
  const vo = DATA_SCOPE_DOMAIN.valueObjects.find((v) => v.name === "RowLevelScopeVO");
  assert.ok(vo);
  const scopeTypeAttr = vo.attributes.find((a) => a.name === "scopeType");
  assert.ok(scopeTypeAttr);
  assert.ok(scopeTypeAttr.type.includes("SELF"));
  assert.ok(scopeTypeAttr.type.includes("DEPT"));
  assert.ok(scopeTypeAttr.type.includes("DEPT_AND_SUBTREE"));
  assert.ok(scopeTypeAttr.type.includes("CUSTOM_ORGS"));
  assert.ok(scopeTypeAttr.type.includes("ALL"));
});

test("D3b. ColumnMaskRuleVO 含 fieldName/fieldType/maskStrategy 字段", () => {
  const vo = DATA_SCOPE_DOMAIN.valueObjects.find((v) => v.name === "ColumnMaskRuleVO");
  assert.ok(vo);
  const attrNames = vo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("fieldName"));
  assert.ok(attrNames.includes("fieldType"));
  assert.ok(attrNames.includes("maskStrategy"));
});

test("D3c. ColumnMaskRuleVO.fieldType 含 phone/idCard/bankCard（脱敏字段类型）", () => {
  const vo = DATA_SCOPE_DOMAIN.valueObjects.find((v) => v.name === "ColumnMaskRuleVO");
  assert.ok(vo);
  const fieldTypeAttr = vo.attributes.find((a) => a.name === "fieldType");
  assert.ok(fieldTypeAttr);
  assert.ok(fieldTypeAttr.type.includes("phone"));
  assert.ok(fieldTypeAttr.type.includes("idCard"));
  assert.ok(fieldTypeAttr.type.includes("bankCard"));
});

// ============================================================================
// D4. 2 个领域事件完整性
// ============================================================================

test("D4a. DATA_SCOPE_DOMAIN.domainEvents 含 2 个事件", () => {
  assert.equal(DATA_SCOPE_DOMAIN.domainEvents.length, 2);
});

test("D4b. DataScopeChangedEvent 订阅者含 DataScopeCacheInvalidator", () => {
  const evt = DATA_SCOPE_DOMAIN.domainEvents.find((e) => e.name === "DataScopeChangedEvent");
  assert.ok(evt);
  assert.ok(evt.subscribers.includes("DataScopeCacheInvalidator"));
});

test("D4c. DataScopeChangedEvent 订阅者含 QueryRewriterConfigRefresher（查询改写器配置刷新）", () => {
  const evt = DATA_SCOPE_DOMAIN.domainEvents.find((e) => e.name === "DataScopeChangedEvent");
  assert.ok(evt);
  assert.ok(
    evt.subscribers.includes("QueryRewriterConfigRefresher"),
    "DataScopeChangedEvent 订阅者应含 QueryRewriterConfigRefresher（数据范围变更需刷新查询改写器配置）"
  );
});

test("D4d. FieldMaskAppliedEvent.payload 含 queryPath 字段（脱敏应用的查询路径，用于审计）", () => {
  const evt = DATA_SCOPE_DOMAIN.domainEvents.find((e) => e.name === "FieldMaskAppliedEvent");
  assert.ok(evt);
  const payloadNames = evt.payload.map((p) => p.name);
  assert.ok(payloadNames.includes("queryPath"));
});

// ============================================================================
// D5. 数据权限域信号词完整性
// ============================================================================

test("D5a. DATA_SCOPE_DOMAIN.signalKeywords 含 6 个信号词", () => {
  assert.equal(DATA_SCOPE_DOMAIN.signalKeywords.length, 6);
});

test("D5b. signalKeywords 包含数据权限/行级权限/列级脱敏/数据范围/数据隔离/查询改写", () => {
  const keywords = DATA_SCOPE_DOMAIN.signalKeywords;
  assert.ok(keywords.includes("数据权限"));
  assert.ok(keywords.includes("行级权限"));
  assert.ok(keywords.includes("列级脱敏"));
  assert.ok(keywords.includes("数据范围"));
  assert.ok(keywords.includes("数据隔离"));
  assert.ok(keywords.includes("查询改写"));
});

// ============================================================================
// 跨域验证：3 个域 ID 唯一性
// ============================================================================

test("X1a. 3 个域 ID 唯一性（role/permission/data-scope 互不重复）", () => {
  const ids = [ROLE_DOMAIN.id, PERMISSION_DOMAIN.id, DATA_SCOPE_DOMAIN.id];
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 3);
});
