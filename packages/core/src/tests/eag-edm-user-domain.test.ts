/**
 * EAG-P1 批次 4 单元测试：用户域预定义模型完整性
 *
 * 测试范围：
 * - U1. USER_DOMAIN 基本字段（id/name/description）
 * - U2. USER_DOMAIN 已冻结（Object.isFrozen）
 * - U3. UserAggregate 聚合字段完整性（name/rootEntity/invariants/containedEntities/valueObjects/publishedEvents）
 * - U4. UserAggregate 不变式约束非空且描述充分
 * - U5. CredentialVO 值对象字段完整性（凭证与身份分离）
 * - U6. UserProfileVO 值对象字段完整性
 * - U7. PasswordPolicyVO 值对象字段完整性（密码策略）
 * - U8. 5 个领域事件完整性（UserCreatedEvent/UserActivatedEvent/UserSuspendedEvent/UserDeactivatedEvent/CredentialBoundEvent）
 * - U9. 信号词完整性（登录/账号/用户/密码/凭证/注册）
 * - U10. 描述长度约束（避免占位实现）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实 USER_DOMAIN 常量
 *
 * 设计依据：
 * - EAG 方案 §5.7.1 用户域设计决策
 * - eag/edm/edm-domains/user-domain.ts 用户域定义文件
 *
 * @module core/tests/eag-edm-user-domain
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { USER_DOMAIN } from "../eag/edm/edm-domains/user-domain";
import type { EdmDomainDefinition } from "../eag/edm/types";

// ============================================================================
// U1. USER_DOMAIN 基本字段
// ============================================================================

test("U1a. USER_DOMAIN.id 为 'user'", () => {
  assert.equal(USER_DOMAIN.id, "user");
});

test("U1b. USER_DOMAIN.name 为 '用户域'", () => {
  assert.equal(USER_DOMAIN.name, "用户域");
});

test("U1c. USER_DOMAIN.description 非空且描述充分（>= 50 字符）", () => {
  assert.ok(USER_DOMAIN.description.length >= 50);
  // 描述应包含关键词"账号生命周期"或"凭证"或"密码策略"
  assert.ok(
    USER_DOMAIN.description.includes("账号生命周期") ||
      USER_DOMAIN.description.includes("凭证") ||
      USER_DOMAIN.description.includes("密码策略")
  );
});

// ============================================================================
// U2. USER_DOMAIN 已冻结
// ============================================================================

test("U2a. USER_DOMAIN 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(USER_DOMAIN), true);
});

test("U2b. USER_DOMAIN.aggregates 数组已冻结", () => {
  assert.equal(Object.isFrozen(USER_DOMAIN.aggregates), true);
});

test("U2c. USER_DOMAIN.signalKeywords 数组已冻结", () => {
  assert.equal(Object.isFrozen(USER_DOMAIN.signalKeywords), true);
});

// ============================================================================
// U3. UserAggregate 聚合字段完整性
// ============================================================================

test("U3a. USER_DOMAIN 含 1 个聚合（UserAggregate）", () => {
  assert.equal(USER_DOMAIN.aggregates.length, 1);
  assert.equal(USER_DOMAIN.aggregates[0].name, "UserAggregate");
});

test("U3b. UserAggregate.rootEntity 为 'UserEntity'", () => {
  assert.equal(USER_DOMAIN.aggregates[0].rootEntity, "UserEntity");
});

test("U3c. UserAggregate.invariants 非空（至少 3 条不变式）", () => {
  assert.ok(USER_DOMAIN.aggregates[0].invariants.length >= 3);
});

test("U3d. UserAggregate.invariants 包含账号生命周期状态机约束", () => {
  const invariants = USER_DOMAIN.aggregates[0].invariants.join(" ");
  assert.ok(invariants.includes("生命周期状态机"), "UserAggregate 不变式应包含'生命周期状态机'约束");
});

test("U3e. UserAggregate.valueObjects 包含 CredentialVO/UserProfileVO/PasswordPolicyVO", () => {
  const voList = USER_DOMAIN.aggregates[0].valueObjects;
  assert.ok(voList.includes("CredentialVO"));
  assert.ok(voList.includes("UserProfileVO"));
  assert.ok(voList.includes("PasswordPolicyVO"));
});

test("U3f. UserAggregate.publishedEvents 包含 5 个用户事件", () => {
  const events = USER_DOMAIN.aggregates[0].publishedEvents;
  assert.equal(events.length, 5);
  assert.ok(events.includes("UserCreatedEvent"));
  assert.ok(events.includes("UserActivatedEvent"));
  assert.ok(events.includes("UserSuspendedEvent"));
  assert.ok(events.includes("UserDeactivatedEvent"));
  assert.ok(events.includes("CredentialBoundEvent"));
});

// ============================================================================
// U4. UserAggregate 不变式约束描述充分
// ============================================================================

test("U4a. 每条不变式描述 >= 20 字符（避免占位实现）", () => {
  for (const inv of USER_DOMAIN.aggregates[0].invariants) {
    assert.ok(inv.length >= 20, `不变式描述过短（< 20 字符）：${inv}`);
  }
});

// ============================================================================
// U5. CredentialVO 值对象字段完整性
// ============================================================================

test("U5a. USER_DOMAIN.valueObjects 含 3 个值对象", () => {
  assert.equal(USER_DOMAIN.valueObjects.length, 3);
});

test("U5b. CredentialVO 含 credentialType/credentialValue/verified 字段", () => {
  const credVo = USER_DOMAIN.valueObjects.find((vo) => vo.name === "CredentialVO");
  assert.ok(credVo, "CredentialVO 不存在");
  const attrNames = credVo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("credentialType"));
  assert.ok(attrNames.includes("credentialValue"));
  assert.ok(attrNames.includes("verified"));
});

test("U5c. CredentialVO.immutabilityGuarantee 非空", () => {
  const credVo = USER_DOMAIN.valueObjects.find((vo) => vo.name === "CredentialVO");
  assert.ok(credVo);
  assert.ok(credVo.immutabilityGuarantee.length > 0);
});

// ============================================================================
// U6. UserProfileVO 值对象字段完整性
// ============================================================================

test("U6a. UserProfileVO 含 displayName 字段（必填）", () => {
  const profileVo = USER_DOMAIN.valueObjects.find((vo) => vo.name === "UserProfileVO");
  assert.ok(profileVo, "UserProfileVO 不存在");
  const displayNameAttr = profileVo.attributes.find((a) => a.name === "displayName");
  assert.ok(displayNameAttr, "UserProfileVO 缺少 displayName 字段");
  assert.equal(displayNameAttr.required, true);
});

// ============================================================================
// U7. PasswordPolicyVO 值对象字段完整性
// ============================================================================

test("U7a. PasswordPolicyVO 含密码强度字段（minLength/requireUppercase 等）", () => {
  const policyVo = USER_DOMAIN.valueObjects.find((vo) => vo.name === "PasswordPolicyVO");
  assert.ok(policyVo, "PasswordPolicyVO 不存在");
  const attrNames = policyVo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("minLength"));
  assert.ok(attrNames.includes("requireUppercase"));
  assert.ok(attrNames.includes("requireLowercase"));
  assert.ok(attrNames.includes("requireDigit"));
  assert.ok(attrNames.includes("requireSpecialChar"));
});

test("U7b. PasswordPolicyVO 含过期与历史去重字段（expireDays/passwordHistoryCount）", () => {
  const policyVo = USER_DOMAIN.valueObjects.find((vo) => vo.name === "PasswordPolicyVO");
  assert.ok(policyVo);
  const attrNames = policyVo.attributes.map((a) => a.name);
  assert.ok(attrNames.includes("expireDays"));
  assert.ok(attrNames.includes("passwordHistoryCount"));
});

// ============================================================================
// U8. 5 个领域事件完整性
// ============================================================================

test("U8a. USER_DOMAIN.domainEvents 含 5 个事件", () => {
  assert.equal(USER_DOMAIN.domainEvents.length, 5);
});

test("U8b. UserCreatedEvent 发布者为 UserAggregate", () => {
  const evt = USER_DOMAIN.domainEvents.find((e) => e.name === "UserCreatedEvent");
  assert.ok(evt);
  assert.equal(evt.publisher, "UserAggregate");
});

test("U8c. UserCreatedEvent.payload 含 userId/username/createdAt", () => {
  const evt = USER_DOMAIN.domainEvents.find((e) => e.name === "UserCreatedEvent");
  assert.ok(evt);
  const payloadNames = evt.payload.map((p) => p.name);
  assert.ok(payloadNames.includes("userId"));
  assert.ok(payloadNames.includes("username"));
  assert.ok(payloadNames.includes("createdAt"));
});

test("U8d. UserDeactivatedEvent 订阅者含 SessionInvalidator（注销时使会话失效）", () => {
  const evt = USER_DOMAIN.domainEvents.find((e) => e.name === "UserDeactivatedEvent");
  assert.ok(evt);
  assert.ok(evt.subscribers.includes("SessionInvalidator"), "UserDeactivatedEvent 订阅者应包含 SessionInvalidator");
});

test("U8e. CredentialBoundEvent.payload 含 credentialType 字段", () => {
  const evt = USER_DOMAIN.domainEvents.find((e) => e.name === "CredentialBoundEvent");
  assert.ok(evt);
  const payloadNames = evt.payload.map((p) => p.name);
  assert.ok(payloadNames.includes("credentialType"));
});

// ============================================================================
// U9. 信号词完整性
// ============================================================================

test("U9a. USER_DOMAIN.signalKeywords 含 6 个信号词", () => {
  assert.equal(USER_DOMAIN.signalKeywords.length, 6);
});

test("U9b. signalKeywords 包含登录/账号/用户/密码/凭证/注册", () => {
  const keywords = USER_DOMAIN.signalKeywords;
  assert.ok(keywords.includes("登录"));
  assert.ok(keywords.includes("账号"));
  assert.ok(keywords.includes("用户"));
  assert.ok(keywords.includes("密码"));
  assert.ok(keywords.includes("凭证"));
  assert.ok(keywords.includes("注册"));
});

// ============================================================================
// U10. 描述长度约束（避免占位实现）
// ============================================================================

test("U10a. 每个值对象的 immutabilityGuarantee >= 20 字符", () => {
  for (const vo of USER_DOMAIN.valueObjects) {
    assert.ok(
      vo.immutabilityGuarantee.length >= 20,
      `值对象 ${vo.name} 的 immutabilityGuarantee 描述过短（< 20 字符）`
    );
  }
});

test("U10b. 每个领域事件的 payload 非空（至少 1 个字段）", () => {
  for (const evt of USER_DOMAIN.domainEvents) {
    assert.ok(evt.payload.length >= 1, `事件 ${evt.name} 的 payload 为空`);
  }
});

test("U10c. USER_DOMAIN 符合 EdmDomainDefinition 类型契约", () => {
  // 通过类型系统验证 USER_DOMAIN 符合 EdmDomainDefinition 接口
  const domain: EdmDomainDefinition = USER_DOMAIN;
  assert.equal(domain.id, "user");
});
