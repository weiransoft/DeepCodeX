/**
 * EAG-P1 批次 4 单元测试：技术选型决策器 + SEED-06 锁定逻辑
 *
 * 测试范围：
 * - T1. TechStackSelector 基础选型流程（每层选 priority=1 首选）
 * - T2. 决策表结构完整性（10 层决策 + humanConfirmed=false）
 * - T3. 信号调整：concurrency=high → message-queue 选 Kafka
 *   - T3a. TypeScript + high → Kafka（替代 BullMQ）
 *   - T3b. Java + high → Kafka（替代 RocketMQ）
 *   - T3c. Python + high → Kafka（替代 Celery）
 *   - T3d. Go + high → 保持 Kafka（已是首选）
 *   - T3e. TypeScript + medium → 保持 BullMQ（不触发调整）
 * - T4. 信号调整：teamStackLegacy 覆盖 input.language
 *   - T4a. teamStackLegacy=java + language=typescript → 决策表 language=java
 *   - T4b. teamStackLegacy=typescript + language=typescript → 不覆盖（相同）
 *   - T4c. teamStackLegacy=python + language=go → 决策表 language=python
 * - T5. 信号调整：compliance=strict → auth 选企业级方案
 *   - T5a. TypeScript + strict → Casdoor（替代 JWT+Passport）
 *   - T5b. Java + strict → 保持 Spring Security（已是企业级首选）
 *   - T5c. TypeScript + general → 保持 JWT+Passport（不触发调整）
 * - T6. 信号调整：deployEnv=cloud-native → 理由中提及云原生蓝图
 * - T7. 选型理由与风险清单非空校验
 * - T8. SEED-06 锁定（lockTechStack）
 *   - T8a. 锁定后 locked=true
 *   - T8b. lockedAt 为有效 ISO 时间戳
 *   - T8c. lockedBy 正确设置
 *   - T8d. 锁定对象已冻结
 *   - T8e. 决策表层数不足 → 抛错
 *   - T8f. lockedBy 为空 → 抛错
 * - T9. SEED-06 解锁（unlockTechStack）
 *   - T9a. 解锁后 locked=false
 *   - T9b. 解锁后保留原 lockedAt 与 lockedBy
 *   - T9c. 解锁对象已冻结
 *   - T9d. 对已解锁对象再解锁 → 抛错
 *   - T9e. approvedBy 为空 → 抛错
 * - T10. SEED-06 依赖变更校验（validateDependencyChange）
 *   - T10a. 未锁定状态 → 所有变更合法
 *   - T10b. 锁定状态 + 匹配依赖 → 合法
 *   - T10c. 锁定状态 + 不匹配依赖 → 违规
 *   - T10d. 锁定状态 + 不匹配依赖 + approvedChanges → 合法
 *   - T10e. 锁定状态 + 混合依赖 → 部分违规
 *   - T10f. 违规信息包含依赖名与 SEED-06 提示
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 TECH_STACK_MATRIX 与 TechStackSelector
 * - 测试覆盖全部信号调整规则的真实逻辑
 *
 * @module core/tests/eag-etsb-tech-stack-selector
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TechStackSelector } from "../eag/etsb/tech-stack-selector";
import {
  lockTechStack,
  unlockTechStack,
  validateDependencyChange,
  TechStackLockError,
} from "../eag/etsb/tech-stack-lock";
import { TECH_STACK_MATRIX } from "../eag/etsb/tech-stack-registry";
import type { TechStackDecisionTable, TechStackLock, TechLanguage } from "../eag/etsb/types";

// ============================================================================
// 辅助函数：构造测试用决策表
// ============================================================================

/**
 * 构造测试用决策表（10 层，使用 TypeScript 默认首选）
 *
 * 用于 SEED-06 锁定测试的输入。
 */
function createTestDecisionTable(language: TechLanguage = "typescript"): TechStackDecisionTable {
  const selector = new TechStackSelector();
  return selector.select({ language });
}

// ============================================================================
// T1. TechStackSelector 基础选型流程
// ============================================================================

test("T1a. select() 返回决策表，language 与输入一致", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  assert.equal(table.language, "typescript");
});

test("T1b. select() 返回的决策表包含 10 层决策", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "java" });
  assert.equal(table.decisions.length, 10);
});

test("T1c. 默认选型下每层 selectedOption 为 priority=1 的首选", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  for (const decision of table.decisions) {
    assert.equal(decision.selectedOption.priority, 1, `层 ${decision.layer} 的 selectedOption.priority 应为 1（首选）`);
  }
});

test("T1d. TypeScript frontend 默认选 React 18 + Ant Design", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  const frontendDecision = table.decisions.find((d) => d.layer === "frontend");
  assert.ok(frontendDecision);
  assert.ok(frontendDecision!.selectedOption.name.includes("React 18"));
  assert.ok(frontendDecision!.selectedOption.name.includes("Ant Design"));
});

test("T1e. Java backend-framework 默认选 Spring Boot 3", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "java" });
  const backendDecision = table.decisions.find((d) => d.layer === "backend-framework");
  assert.ok(backendDecision);
  assert.ok(backendDecision!.selectedOption.name.includes("Spring Boot 3"));
});

// ============================================================================
// T2. 决策表结构完整性
// ============================================================================

test("T2a. 决策表 humanConfirmed 默认为 false（待 HUMAN_CHECKPOINT 确认）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  assert.equal(table.humanConfirmed, false);
});

test("T2b. 决策表包含全部 10 层（按 TECH_LAYERS 顺序）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  const expectedLayers = [
    "frontend",
    "backend-framework",
    "orm",
    "cache",
    "message-queue",
    "object-storage",
    "search",
    "task-scheduler",
    "auth",
    "api-contract",
  ];
  const actualLayers = table.decisions.map((d) => d.layer);
  assert.deepEqual(actualLayers, expectedLayers);
});

test("T2c. 决策表已冻结（Object.isFrozen）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  assert.ok(Object.isFrozen(table));
  assert.ok(Object.isFrozen(table.decisions));
});

test("T2d. 每层决策的 alternatives 不包含 selectedOption", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  for (const decision of table.decisions) {
    for (const alt of decision.alternatives) {
      assert.notEqual(
        alt.name,
        decision.selectedOption.name,
        `层 ${decision.layer} 的 alternatives 不应包含 selectedOption`
      );
    }
  }
});

// ============================================================================
// T3. 信号调整：concurrency=high → message-queue 选 Kafka
// ============================================================================

test("T3a. TypeScript + concurrency=high → message-queue 选 Kafka（替代 BullMQ）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", concurrency: "high" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  assert.ok(
    mqDecision!.selectedOption.name.includes("Kafka"),
    `高并发应选 Kafka，实际选了 ${mqDecision!.selectedOption.name}`
  );
  // 原首选 BullMQ 应进入 alternatives
  const hasBullMQInAlts = mqDecision!.alternatives.some((a) => a.name.includes("BullMQ"));
  assert.ok(hasBullMQInAlts, "原首选 BullMQ 应进入 alternatives");
});

test("T3b. Java + concurrency=high → message-queue 选 Kafka（替代 RocketMQ）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "java", concurrency: "high" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  assert.ok(
    mqDecision!.selectedOption.name.includes("Kafka"),
    `Java 高并发应选 Kafka，实际选了 ${mqDecision!.selectedOption.name}`
  );
  // 原首选 RocketMQ 应进入 alternatives
  const hasRocketMQInAlts = mqDecision!.alternatives.some((a) => a.name.includes("RocketMQ"));
  assert.ok(hasRocketMQInAlts, "原首选 RocketMQ 应进入 alternatives");
});

test("T3c. Python + concurrency=high → message-queue 选 Kafka（替代 Celery）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "python", concurrency: "high" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  assert.ok(
    mqDecision!.selectedOption.name.includes("Kafka"),
    `Python 高并发应选 Kafka，实际选了 ${mqDecision!.selectedOption.name}`
  );
});

test("T3d. Go + concurrency=high → message-queue 保持 Kafka（已是首选）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "go", concurrency: "high" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  assert.ok(mqDecision!.selectedOption.name.includes("Kafka"));
  // Go 的 Kafka 已是 priority=1，无需调整
  assert.equal(mqDecision!.selectedOption.priority, 1);
});

test("T3e. TypeScript + concurrency=medium → message-queue 保持 BullMQ（不触发调整）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", concurrency: "medium" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  assert.ok(mqDecision!.selectedOption.name.includes("BullMQ"), "中并发应保持首选 BullMQ，不触发 Kafka 调整");
});

test("T3f. TypeScript + concurrency=low → message-queue 保持 BullMQ", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", concurrency: "low" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  assert.ok(mqDecision!.selectedOption.name.includes("BullMQ"));
});

// ============================================================================
// T4. 信号调整：teamStackLegacy 覆盖 input.language
// ============================================================================

test("T4a. teamStackLegacy=java + language=typescript → 决策表 language=java", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    teamStackLegacy: "java",
  });
  assert.equal(table.language, "java", "teamStackLegacy=java 应覆盖 input.language=typescript");
  // 验证决策内容确实是 Java 系（backend-framework 应为 Spring Boot）
  const backendDecision = table.decisions.find((d) => d.layer === "backend-framework");
  assert.ok(backendDecision!.selectedOption.name.includes("Spring Boot"));
});

test("T4b. teamStackLegacy=typescript + language=typescript → 不覆盖（相同语言）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    teamStackLegacy: "typescript",
  });
  assert.equal(table.language, "typescript");
});

test("T4c. teamStackLegacy=python + language=go → 决策表 language=python", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "go",
    teamStackLegacy: "python",
  });
  assert.equal(table.language, "python");
  // 验证决策内容是 Python 系（backend-framework 应为 FastAPI）
  const backendDecision = table.decisions.find((d) => d.layer === "backend-framework");
  assert.ok(backendDecision!.selectedOption.name.includes("FastAPI"));
});

test("T4d. teamStackLegacy 覆盖时选型理由应提及团队栈覆盖", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    teamStackLegacy: "java",
  });
  // 至少有一个决策的理由应提及团队栈覆盖
  const hasOverrideReason = table.decisions.some((d) => d.reason.includes("团队存量栈"));
  assert.ok(hasOverrideReason, "teamStackLegacy 覆盖时选型理由应提及团队栈覆盖");
});

// ============================================================================
// T5. 信号调整：compliance=strict → auth 选企业级方案
// ============================================================================

test("T5a. TypeScript + compliance=strict → auth 选 Casdoor（替代 JWT+Passport）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", compliance: "strict" });
  const authDecision = table.decisions.find((d) => d.layer === "auth");
  assert.ok(authDecision);
  assert.ok(
    authDecision!.selectedOption.name.includes("Casdoor"),
    `严格合规应选 Casdoor，实际选了 ${authDecision!.selectedOption.name}`
  );
  // 原首选 JWT+Passport 应进入 alternatives
  const hasJWTInAlts = authDecision!.alternatives.some((a) => a.name.includes("JWT") && a.name.includes("Passport"));
  assert.ok(hasJWTInAlts, "原首选 JWT+Passport 应进入 alternatives");
});

test("T5b. Java + compliance=strict → auth 保持 Spring Security（已是企业级首选）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "java", compliance: "strict" });
  const authDecision = table.decisions.find((d) => d.layer === "auth");
  assert.ok(authDecision);
  assert.ok(authDecision!.selectedOption.name.includes("Spring Security"));
  assert.equal(authDecision!.selectedOption.priority, 1); // 已是首选，无需调整
});

test("T5c. TypeScript + compliance=general → auth 保持 JWT+Passport（不触发调整）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", compliance: "general" });
  const authDecision = table.decisions.find((d) => d.layer === "auth");
  assert.ok(authDecision);
  assert.ok(authDecision!.selectedOption.name.includes("JWT"));
  assert.ok(authDecision!.selectedOption.name.includes("Passport"));
});

test("T5d. compliance=strict 时选型理由应提及合规要求", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", compliance: "strict" });
  const authDecision = table.decisions.find((d) => d.layer === "auth");
  assert.ok(authDecision);
  assert.ok(
    authDecision!.reason.includes("合规"),
    `严格合规时 auth 选型理由应提及合规，实际理由：${authDecision!.reason}`
  );
});

// ============================================================================
// T6. 信号调整：deployEnv=cloud-native → 理由中提及云原生蓝图
// ============================================================================

test("T6. deployEnv=cloud-native → 选型理由应提及云原生蓝图", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    deployEnv: "cloud-native",
  });
  // 至少有一个决策的理由应提及云原生
  const hasCloudNativeReason = table.decisions.some((d) => d.reason.includes("云原生"));
  assert.ok(hasCloudNativeReason, "deployEnv=cloud-native 时选型理由应提及云原生蓝图");
});

// ============================================================================
// T7. 选型理由与风险清单非空校验
// ============================================================================

test("T7a. 每层决策的 reason 非空", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  for (const decision of table.decisions) {
    assert.ok(decision.reason.length > 0, `层 ${decision.layer} 的 reason 不能为空`);
  }
});

test("T7b. 每层决策的 risks 至少 1 条（SEED-06 通用风险）", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript" });
  for (const decision of table.decisions) {
    assert.ok(decision.risks.length >= 1, `层 ${decision.layer} 的 risks 应至少 1 条（含 SEED-06 通用风险）`);
    // 验证包含 SEED-06 通用风险
    const hasSeed06Risk = decision.risks.some((r) => r.includes("SEED-06"));
    assert.ok(hasSeed06Risk, `层 ${decision.layer} 的 risks 应包含 SEED-06 通用风险`);
  }
});

test("T7c. message-queue 选 Kafka 时 risks 应提及运维复杂度", () => {
  const selector = new TechStackSelector();
  const table = selector.select({ language: "typescript", concurrency: "high" });
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision);
  const hasOpsRisk = mqDecision!.risks.some((r) => r.includes("运维"));
  assert.ok(hasOpsRisk, "选 Kafka 时 risks 应提及运维复杂度");
});

// ============================================================================
// T8. SEED-06 锁定（lockTechStack）
// ============================================================================

test("T8a. lockTechStack 返回 locked=true", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  assert.equal(lock.locked, true);
});

test("T8b. lockTechStack 设置 lockedAt 为有效 ISO 时间戳", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  // 验证是有效 ISO 时间戳（可被 Date.parse 解析）
  const parsed = Date.parse(lock.lockedAt);
  assert.ok(!isNaN(parsed), `lockedAt 应为有效 ISO 时间戳，实际：${lock.lockedAt}`);
});

test("T8c. lockTechStack 设置 lockedBy", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  assert.equal(lock.lockedBy, "架构师张三");
});

test("T8d. lockTechStack 返回的锁定对象已冻结", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  assert.ok(Object.isFrozen(lock));
});

test("T8e. lockTechStack 决策表层数不足 → 抛 TechStackLockError", () => {
  // 构造一个只有 5 层的非法决策表
  const invalidTable: TechStackDecisionTable = {
    language: "typescript",
    decisions: ["frontend", "backend-framework", "orm", "cache", "message-queue"].map((layer) => ({
      layer: layer as any,
      selectedOption: { name: "测试", priority: 1 },
      reason: "测试",
      alternatives: [],
      risks: [],
    })),
    humanConfirmed: false,
  };
  assert.throws(
    () => lockTechStack(invalidTable, "架构师"),
    (err: unknown) => {
      assert.ok(err instanceof TechStackLockError);
      assert.equal((err as TechStackLockError).field, "decisionTable.decisions");
      return true;
    }
  );
});

test("T8f. lockTechStack lockedBy 为空 → 抛 TechStackLockError", () => {
  const table = createTestDecisionTable();
  assert.throws(
    () => lockTechStack(table, ""),
    (err: unknown) => {
      assert.ok(err instanceof TechStackLockError);
      assert.equal((err as TechStackLockError).field, "lockedBy");
      return true;
    }
  );
});

test("T8g. lockTechStack lockedBy 为空白字符串 → 抛 TechStackLockError", () => {
  const table = createTestDecisionTable();
  assert.throws(
    () => lockTechStack(table, "   "),
    (err: unknown) => {
      assert.ok(err instanceof TechStackLockError);
      return true;
    }
  );
});

test("T8h. lockTechStack 保留决策表内容", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  assert.equal(lock.decisionTable, table); // 同引用（冻结对象可安全共享）
  assert.equal(lock.decisionTable.language, "typescript");
  assert.equal(lock.decisionTable.decisions.length, 10);
});

// ============================================================================
// T9. SEED-06 解锁（unlockTechStack）
// ============================================================================

test("T9a. unlockTechStack 返回 locked=false", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  const unlocked = unlockTechStack(lock, "用户李四");
  assert.equal(unlocked.locked, false);
});

test("T9b. unlockTechStack 保留原 lockedAt 与 lockedBy（审计追溯）", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  const originalLockedAt = lock.lockedAt;
  const originalLockedBy = lock.lockedBy;
  const unlocked = unlockTechStack(lock, "用户李四");
  // 解锁后保留原锁定信息供审计
  assert.equal(unlocked.lockedAt, originalLockedAt);
  assert.equal(unlocked.lockedBy, originalLockedBy);
});

test("T9c. unlockTechStack 返回的解锁对象已冻结", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  const unlocked = unlockTechStack(lock, "用户李四");
  assert.ok(Object.isFrozen(unlocked));
});

test("T9d. unlockTechStack 对已解锁对象再解锁 → 抛 TechStackLockError", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  const unlocked = unlockTechStack(lock, "用户李四");
  // 对已解锁对象再解锁应抛错
  assert.throws(
    () => unlockTechStack(unlocked, "用户李四"),
    (err: unknown) => {
      assert.ok(err instanceof TechStackLockError);
      assert.equal((err as TechStackLockError).field, "lock.locked");
      return true;
    }
  );
});

test("T9e. unlockTechStack approvedBy 为空 → 抛 TechStackLockError", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  assert.throws(
    () => unlockTechStack(lock, ""),
    (err: unknown) => {
      assert.ok(err instanceof TechStackLockError);
      assert.equal((err as TechStackLockError).field, "approvedBy");
      return true;
    }
  );
});

// ============================================================================
// T10. SEED-06 依赖变更校验（validateDependencyChange）
// ============================================================================

test("T10a. 未锁定状态 → 所有变更合法", () => {
  const table = createTestDecisionTable();
  const lock = lockTechStack(table, "架构师张三");
  const unlocked = unlockTechStack(lock, "用户李四");
  // 未锁定状态下，任何依赖都应合法
  const result = validateDependencyChange(unlocked, ["react", "vue", "anything"]);
  assert.equal(result.valid, true);
  assert.equal(result.violations.length, 0);
});

test("T10b. 锁定状态 + 匹配依赖（TypeScript 栈）→ 合法", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  // react 匹配 frontend 的 "React 18"，nestjs 匹配 backend-framework 的 "NestJS"
  const result = validateDependencyChange(lock, ["react", "@nestjs/core", "prisma"]);
  assert.equal(result.valid, true);
  assert.equal(result.violations.length, 0);
});

test("T10c. 锁定状态 + 不匹配依赖 → 违规", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  // vue 不匹配锁定栈（锁定为 React），应违规
  const result = validateDependencyChange(lock, ["vue"]);
  assert.equal(result.valid, false);
  assert.ok(result.violations.length >= 1);
  assert.ok(result.violations[0].includes("vue"));
});

test("T10d. 锁定状态 + 不匹配依赖 + approvedChanges → 合法", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  // vue 本不匹配，但用户显式批准后应合法
  const result = validateDependencyChange(lock, ["vue"], ["vue"]);
  assert.equal(result.valid, true);
  assert.equal(result.violations.length, 0);
});

test("T10e. 锁定状态 + 混合依赖（部分匹配部分不匹配）→ 部分违规", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  // react 匹配，vue 不匹配，prisma 匹配
  const result = validateDependencyChange(lock, ["react", "vue", "prisma"]);
  assert.equal(result.valid, false);
  // 应只有 vue 一条违规
  assert.equal(result.violations.length, 1);
  assert.ok(result.violations[0].includes("vue"));
});

test("T10f. 违规信息包含依赖名与 SEED-06 提示", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  const result = validateDependencyChange(lock, ["vue"]);
  assert.equal(result.violations.length, 1);
  const violation = result.violations[0];
  assert.ok(violation.includes("vue"), "违规信息应包含依赖名");
  assert.ok(violation.includes("SEED-06"), "违规信息应包含 SEED-06 提示");
});

test("T10g. 锁定 Java 栈 + Spring 相关依赖 → 合法", () => {
  const table = createTestDecisionTable("java");
  const lock = lockTechStack(table, "架构师张三");
  // Java 栈包含 Spring Boot, MyBatis-Plus, Redis 等
  const result = validateDependencyChange(lock, ["spring-boot-starter", "mybatis-plus", "redis"]);
  assert.equal(result.valid, true);
});

test("T10h. 锁定 Java 栈 + NestJS 依赖（属于 TypeScript 栈）→ 违规", () => {
  const table = createTestDecisionTable("java");
  const lock = lockTechStack(table, "架构师张三");
  // Java 栈锁定为 Spring Boot，引入 NestJS 应违规
  const result = validateDependencyChange(lock, ["@nestjs/core"]);
  assert.equal(result.valid, false);
  assert.ok(result.violations[0].includes("@nestjs/core"));
});

test("T10i. @scope/name 格式依赖通过 scope 匹配关键词", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  // @nestjs/core 的 scope 是 nestjs，应匹配 NestJS 关键词
  const result = validateDependencyChange(lock, ["@nestjs/core", "@nestjs/common"]);
  assert.equal(result.valid, true);
});

test("T10j. 空依赖列表 → 合法（无变更）", () => {
  const table = createTestDecisionTable("typescript");
  const lock = lockTechStack(table, "架构师张三");
  const result = validateDependencyChange(lock, []);
  assert.equal(result.valid, true);
  assert.equal(result.violations.length, 0);
});

// ============================================================================
// T11. 综合场景：多信号组合
// ============================================================================

test("T11a. 多信号组合：high + strict + cloud-native 同时生效", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    concurrency: "high",
    compliance: "strict",
    deployEnv: "cloud-native",
  });
  // message-queue 应选 Kafka
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision!.selectedOption.name.includes("Kafka"));
  // auth 应选 Casdoor
  const authDecision = table.decisions.find((d) => d.layer === "auth");
  assert.ok(authDecision!.selectedOption.name.includes("Casdoor"));
  // 至少一个理由提及云原生
  const hasCloudNative = table.decisions.some((d) => d.reason.includes("云原生"));
  assert.ok(hasCloudNative);
});

test("T11b. teamStackLegacy + concurrency + compliance 三信号组合", () => {
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    teamStackLegacy: "java",
    concurrency: "high",
    compliance: "strict",
  });
  // 语言应被覆盖为 java
  assert.equal(table.language, "java");
  // message-queue 应选 Kafka（Java 高并发）
  const mqDecision = table.decisions.find((d) => d.layer === "message-queue");
  assert.ok(mqDecision!.selectedOption.name.includes("Kafka"));
  // auth 应保持 Spring Security（Java 已是企业级首选）
  const authDecision = table.decisions.find((d) => d.layer === "auth");
  assert.ok(authDecision!.selectedOption.name.includes("Spring Security"));
});

test("T11c. 完整选型 + 锁定 + 校验 + 解锁流程", () => {
  // 1. 选型
  const selector = new TechStackSelector();
  const table = selector.select({
    language: "typescript",
    concurrency: "high",
    compliance: "strict",
  });
  assert.equal(table.decisions.length, 10);

  // 2. 锁定
  const lock = lockTechStack(table, "架构师张三");
  assert.equal(lock.locked, true);
  assert.equal(lock.lockedBy, "架构师张三");

  // 3. 校验依赖（匹配的依赖合法）
  const validResult = validateDependencyChange(lock, ["react", "@nestjs/core"]);
  assert.equal(validResult.valid, true);

  // 4. 校验依赖（不匹配的依赖违规）
  const invalidResult = validateDependencyChange(lock, ["vue"]);
  assert.equal(invalidResult.valid, false);

  // 5. 校验依赖（不匹配但已批准的依赖合法）
  const approvedResult = validateDependencyChange(lock, ["vue"], ["vue"]);
  assert.equal(approvedResult.valid, true);

  // 6. 解锁
  const unlocked = unlockTechStack(lock, "用户李四");
  assert.equal(unlocked.locked, false);

  // 7. 解锁后所有依赖合法
  const afterUnlockResult = validateDependencyChange(unlocked, ["vue", "anything"]);
  assert.equal(afterUnlockResult.valid, true);
});
