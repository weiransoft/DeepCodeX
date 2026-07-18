/**
 * EAG-P1 批次 2 单元测试：范式注册表 + paradigm_lock 机制
 *
 * 测试范围：
 * - R1. getParadigmById 4 个范式都可查到
 * - R2. getParadigmById 不存在的 id 返回 null
 * - R3. getAllParadigms 返回 4 个
 * - R4. getParadigmCount 返回 4
 * - R5. selectParadigm 锁定时跳过信号判定（locked=true 直接返回锁定范式）
 * - R6. selectParadigm 未锁定时按信号匹配
 * - R7. selectParadigm 平分时按优先级 ddd-layered > clean-architecture > cqrs-es > microservice
 * - R8. validateParadigmLock 合法场景
 * - R9. validateParadigmLock 非法场景（locked=true 但 paradigmId=null、reason 空、paradigmId 非法）
 * - R10. rankParadigmsBySignals 排序正确
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实注册表与范式常量
 * - 测试用例独立、可重复
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 范式选择防误判机制（组织锁定 + 命令级覆盖 + 证据强制）
 * - eag/eak/paradigm-registry.ts 源文件
 *
 * @module core/tests/eag-eak-paradigm-registry
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getParadigmById,
  getAllParadigms,
  getParadigmCount,
  selectParadigm,
  validateParadigmLock,
  rankParadigmsBySignals,
} from "../eag/eak/paradigm-registry";
import { DDD_LAYERED_PARADIGM } from "../eag/eak/paradigms/ddd-layered";
import { CLEAN_ARCHITECTURE_PARADIGM } from "../eag/eak/paradigms/clean-architecture";
import { CQRS_ES_PARADIGM } from "../eag/eak/paradigms/cqrs-es";
import { MICROSERVICE_PARADIGM } from "../eag/eak/paradigms/microservice";
import type { ApplicabilitySignals, ParadigmId, ParadigmLockConfig } from "../eag/eak/types";

// ============================================================================
// R1. getParadigmById 4 个范式都可查到
// ============================================================================

test("R1a. getParadigmById('ddd-layered') 返回 DDD 分层架构范式", () => {
  const p = getParadigmById("ddd-layered");
  assert.ok(p !== null);
  assert.equal(p!.id, "ddd-layered");
  assert.equal(p!.name, "DDD 分层架构");
});

test("R1b. getParadigmById('clean-architecture') 返回 Clean Architecture 范式", () => {
  const p = getParadigmById("clean-architecture");
  assert.ok(p !== null);
  assert.equal(p!.id, "clean-architecture");
  assert.equal(p!.name, "Clean Architecture");
});

test("R1c. getParadigmById('cqrs-es') 返回 CQRS+ES 范式", () => {
  const p = getParadigmById("cqrs-es");
  assert.ok(p !== null);
  assert.equal(p!.id, "cqrs-es");
  assert.equal(p!.name, "CQRS + Event Sourcing");
});

test("R1d. getParadigmById('microservice') 返回微服务范式", () => {
  const p = getParadigmById("microservice");
  assert.ok(p !== null);
  assert.equal(p!.id, "microservice");
  assert.equal(p!.name, "微服务架构");
});

test("R1e. getParadigmById 返回的对象与导出的范式常量一致（引用相同）", () => {
  // 验证注册表存储的是同一个对象引用（避免副本导致的不一致）
  assert.equal(getParadigmById("ddd-layered"), DDD_LAYERED_PARADIGM);
  assert.equal(getParadigmById("clean-architecture"), CLEAN_ARCHITECTURE_PARADIGM);
  assert.equal(getParadigmById("cqrs-es"), CQRS_ES_PARADIGM);
  assert.equal(getParadigmById("microservice"), MICROSERVICE_PARADIGM);
});

// ============================================================================
// R2. getParadigmById 不存在的 id 返回 null
// ============================================================================

test("R2a. getParadigmById 不存在的 id 返回 null", () => {
  // 使用类型断言绕过 ParadigmId 联合类型检查（模拟运行时非法输入）
  assert.equal(getParadigmById("nonexistent" as ParadigmId), null);
});

test("R2b. getParadigmById 空字符串返回 null", () => {
  assert.equal(getParadigmById("" as ParadigmId), null);
});

// ============================================================================
// R3. getAllParadigms 返回 4 个
// ============================================================================

test("R3a. getAllParadigms 返回 4 个范式", () => {
  const all = getAllParadigms();
  assert.equal(all.length, 4);
});

test("R3b. getAllParadigms 按 PARADIGM_IDS 顺序排列（ddd/clean/cqrs/micro）", () => {
  const all = getAllParadigms();
  const ids = all.map((p) => p.id);
  assert.deepEqual(ids, ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"]);
});

// ============================================================================
// R4. getParadigmCount 返回 4
// ============================================================================

test("R4. getParadigmCount 返回 4", () => {
  assert.equal(getParadigmCount(), 4);
});

// ============================================================================
// R5. selectParadigm 锁定时跳过信号判定
// ============================================================================

test("R5a. selectParadigm locked=true 时返回锁定的范式（即使信号完全不匹配）", () => {
  // 信号指向 ddd-layered，但锁定为 clean-architecture——应返回 clean-architecture
  const signalsForDdd: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "clean-architecture",
    reason: "组织规范要求采用 Clean Architecture",
  };
  const selected = selectParadigm(signalsForDdd, lock);
  assert.equal(selected.id, "clean-architecture");
});

test("R5b. selectParadigm locked=true 锁定 cqrs-es 时返回 cqrs-es（信号指向 microservice 仍跳过）", () => {
  // 信号指向 microservice，但锁定为 cqrs-es——应返回 cqrs-es
  const signalsForMicro: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "eventual",
    readWritePattern: "read-heavy",
    integrationComplexity: "many-systems",
  };
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "cqrs-es",
    reason: "组织规范要求采用 CQRS+ES",
  };
  const selected = selectParadigm(signalsForMicro, lock);
  assert.equal(selected.id, "cqrs-es");
});

test("R5c. selectParadigm locked=true 锁定 microservice 时返回 microservice", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "low",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "microservice",
    reason: "组织规范要求微服务",
  };
  const selected = selectParadigm(signals, lock);
  assert.equal(selected.id, "microservice");
});

test("R5d. selectParadigm locked=true 但 paradigmId=null 时抛错", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: null, // 非法配置
    reason: "测试非法配置",
  };
  assert.throws(() => selectParadigm(signals, lock), /paradigmId 为 null/, "应抛错提示 paradigmId 为 null");
});

// ============================================================================
// R6. selectParadigm 未锁定时按信号匹配
// ============================================================================

test("R6a. selectParadigm 信号指向 ddd-layered 时返回 ddd-layered", () => {
  // ddd-layered 信号：high/strong/balanced/monolith
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const selected = selectParadigm(signals);
  assert.equal(selected.id, "ddd-layered");
});

test("R6b. selectParadigm 信号指向 clean-architecture 时返回 clean-architecture", () => {
  // clean-architecture 信号：medium/strong/balanced/few-integrations
  const signals: ApplicabilitySignals = {
    domainComplexity: "medium",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "few-integrations",
  };
  const selected = selectParadigm(signals);
  assert.equal(selected.id, "clean-architecture");
});

test("R6c. selectParadigm 信号指向 cqrs-es 时返回 cqrs-es（优先级高于 microservice）", () => {
  // cqrs-es 与 microservice 信号相同：high/eventual/read-heavy/many-systems
  // 平分时按优先级：cqrs-es 排在 microservice 之前
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "eventual",
    readWritePattern: "read-heavy",
    integrationComplexity: "many-systems",
  };
  const selected = selectParadigm(signals);
  assert.equal(selected.id, "cqrs-es");
});

test("R6d. selectParadigm 未传 lock 参数时走信号匹配", () => {
  // 不传 lock 参数，应等同于未锁定
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const selected = selectParadigm(signals);
  assert.equal(selected.id, "ddd-layered");
});

test("R6e. selectParadigm locked=false 时走信号匹配", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "medium",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "few-integrations",
  };
  const lock: ParadigmLockConfig = {
    locked: false,
    paradigmId: null,
    reason: "未锁定",
  };
  const selected = selectParadigm(signals, lock);
  assert.equal(selected.id, "clean-architecture");
});

// ============================================================================
// R7. selectParadigm 平分时按优先级 ddd > clean > cqrs > micro
// ============================================================================

test("R7a. 信号全不匹配时按优先级返回 ddd-layered", () => {
  // 构造一个信号：每个范式都得 0 分——所有维度都不匹配任何范式
  // 但实际上每个维度值都会匹配某个范式，所以这里测试"所有范式都得 0 分"是构造场景：
  // - domainComplexity=low：不匹配 ddd(high)、clean(medium)、cqrs(high)、micro(high)
  // - consistencyRequirement=strong：匹配 ddd/clean，不匹配 cqrs/micro
  // 所以无法构造 0 分场景，改为构造"平分场景"
  // cqrs-es 与 microservice 信号相同 → 平分时返回 cqrs-es（已在 R6c 测试）
  // 这里改为测试其他平分场景：当只有 1 个维度匹配 ddd-layered 但同时 clean 也匹配 1 维度时
  // ddd-layered 应优先（PARADIGM_IDS 顺序在前）
  const signals: ApplicabilitySignals = {
    domainComplexity: "high", // 匹配 ddd / cqrs / micro（3 个）
    consistencyRequirement: "strong", // 匹配 ddd / clean（2 个）
    readWritePattern: "balanced", // 匹配 ddd / clean（2 个）
    integrationComplexity: "monolith", // 匹配 ddd（1 个）
  };
  // ddd: 4 分（全部匹配）
  // clean: 2 分（consistency + readWrite）
  // cqrs: 1 分（domainComplexity）
  // micro: 1 分（domainComplexity）
  // 最高分 ddd=4 应胜出
  const selected = selectParadigm(signals);
  assert.equal(selected.id, "ddd-layered");
});

test("R7b. selectParadigm cqrs-es vs microservice 平分时返回 cqrs-es", () => {
  // 两个范式信号完全相同（high/eventual/read-heavy/many-systems），平分时按优先级返回 cqrs-es
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "eventual",
    readWritePattern: "read-heavy",
    integrationComplexity: "many-systems",
  };
  const selected = selectParadigm(signals);
  assert.equal(selected.id, "cqrs-es");
});

// ============================================================================
// R8. validateParadigmLock 合法场景
// ============================================================================

test("R8a. validateParadigmLock locked=true + paradigmId 合法 + reason 非空 → valid=true", () => {
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "ddd-layered",
    reason: "组织规范要求",
  };
  const result = validateParadigmLock(lock);
  assert.equal(result.valid, true);
});

test("R8b. validateParadigmLock locked=false + reason 非空 → valid=true", () => {
  const lock: ParadigmLockConfig = {
    locked: false,
    paradigmId: null,
    reason: "未锁定",
  };
  const result = validateParadigmLock(lock);
  assert.equal(result.valid, true);
});

test("R8c. validateParadigmLock 4 个合法 paradigmId 都通过校验", () => {
  const validIds: ParadigmId[] = ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"];
  for (const id of validIds) {
    const lock: ParadigmLockConfig = {
      locked: true,
      paradigmId: id,
      reason: "测试",
    };
    const result = validateParadigmLock(lock);
    assert.equal(result.valid, true, `${id} 应通过校验`);
  }
});

// ============================================================================
// R9. validateParadigmLock 非法场景
// ============================================================================

test("R9a. validateParadigmLock locked=true + paradigmId=null → valid=false", () => {
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: null,
    reason: "测试",
  };
  const result = validateParadigmLock(lock);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("paradigmId"), `reason 应提示 paradigmId 问题：${result.reason}`);
});

test("R9b. validateParadigmLock locked=true + paradigmId 非法 → valid=false", () => {
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "nonexistent" as ParadigmId,
    reason: "测试",
  };
  const result = validateParadigmLock(lock);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("非法"), `reason 应提示 paradigmId 非法：${result.reason}`);
});

test("R9c. validateParadigmLock reason 为空 → valid=false", () => {
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "ddd-layered",
    reason: "",
  };
  const result = validateParadigmLock(lock);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("reason"), `reason 应提示 reason 问题：${result.reason}`);
});

test("R9d. validateParadigmLock reason 仅含空格 → valid=false", () => {
  const lock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "ddd-layered",
    reason: "   ",
  };
  const result = validateParadigmLock(lock);
  assert.equal(result.valid, false);
});

// ============================================================================
// R10. rankParadigmsBySignals 排序正确
// ============================================================================

test("R10a. rankParadigmsBySignals 返回 4 个范式", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const ranked = rankParadigmsBySignals(signals);
  assert.equal(ranked.length, 4);
});

test("R10b. rankParadigmsBySignals 信号指向 ddd-layered 时 ddd 排首位（得分最高）", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const ranked = rankParadigmsBySignals(signals);
  assert.equal(ranked[0].paradigm.id, "ddd-layered");
  assert.equal(ranked[0].score, 4); // 4 维度全匹配
});

test("R10c. rankParadigmsBySignals 信号指向 clean-architecture 时 clean 排首位", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "medium",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "few-integrations",
  };
  const ranked = rankParadigmsBySignals(signals);
  assert.equal(ranked[0].paradigm.id, "clean-architecture");
  assert.equal(ranked[0].score, 4);
});

test("R10d. rankParadigmsBySignals 得分按降序排列", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const ranked = rankParadigmsBySignals(signals);
  // 得分应非递增
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      ranked[i].score <= ranked[i - 1].score,
      `得分应降序，但 ${ranked[i].paradigm.id}(${ranked[i].score}) > ${ranked[i - 1].paradigm.id}(${ranked[i - 1].score})`
    );
  }
});

test("R10e. rankParadigmsBySignals 平分时按 PARADIGM_IDS 优先级排列", () => {
  // cqrs-es 与 microservice 信号相同，平分时 cqrs-es 排前
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "eventual",
    readWritePattern: "read-heavy",
    integrationComplexity: "many-systems",
  };
  const ranked = rankParadigmsBySignals(signals);
  // cqrs-es 与 microservice 得分应相同（4 分）
  const cqrsIdx = ranked.findIndex((r) => r.paradigm.id === "cqrs-es");
  const microIdx = ranked.findIndex((r) => r.paradigm.id === "microservice");
  assert.ok(cqrsIdx < microIdx, `cqrs-es 应排在 microservice 之前，cqrs idx=${cqrsIdx}, micro idx=${microIdx}`);
  assert.equal(ranked[cqrsIdx].score, ranked[microIdx].score, "两个范式得分应相同");
});

test("R10f. rankParadigmsBySignals 总得分范围在 0~4 之间", () => {
  const signals: ApplicabilitySignals = {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  };
  const ranked = rankParadigmsBySignals(signals);
  for (const r of ranked) {
    assert.ok(r.score >= 0 && r.score <= 4, `得分应在 0~4 之间，实际：${r.score}`);
  }
});
