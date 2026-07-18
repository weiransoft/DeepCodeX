/**
 * EAG-P1 单元测试：E1~E8 企业红线清单
 *
 * 测试范围：
 * - R1. ENTERPRISE_REDLINES 长度 = 8
 * - R2. 每条红线字段完整性（id / name / description / severity / checkMethod / checkType / fixGuidance）
 * - R3. severity 分布（E4/E6/E8 为 BLOCKER，E1/E2/E3/E5 为 MAJOR，E7 为 WARNING）
 * - R4. id 唯一性（E1~E8 无重复）
 * - R5. getRedlinesBySeverity 正确过滤
 * - R6. getRedlineById 正确查找
 * - R7. getEnterpriseRedlineCount = 8
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实常量与函数
 * - 每个测试用例独立
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单（BLOCKER/MAJOR/WARNING 三级）
 * - eag/redlines/enterprise-rules.ts 源文件（被测对象）
 * - 复用 P0 eag/evaluator/types.ts 的 RedlineDefinition 接口
 *
 * @module core/tests/eag-enterprise-rules
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTERPRISE_REDLINES,
  getRedlinesBySeverity,
  getRedlineById,
  getEnterpriseRedlineCount,
} from "../eag/redlines/enterprise-rules";
import type { RedlineDefinition, RedlineSeverity } from "../eag/evaluator/types";

// ============================================================================
// R1. ENTERPRISE_REDLINES 长度 = 8
// ============================================================================

test("R1. ENTERPRISE_REDLINES 长度 = 8（E1~E8）", () => {
  assert.equal(ENTERPRISE_REDLINES.length, 8);
});

test("R1b. getEnterpriseRedlineCount 返回 8", () => {
  assert.equal(getEnterpriseRedlineCount(), 8);
});

test("R1c. ENTERPRISE_REDLINES 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(ENTERPRISE_REDLINES));
});

// ============================================================================
// R2. 每条红线字段完整性
// ============================================================================

test("R2. 每条红线字段完整性（id/name/description/severity/checkMethod/checkType/fixGuidance）", () => {
  for (const redline of ENTERPRISE_REDLINES) {
    // id：非空字符串，形如 "E1"~"E8"
    assert.ok(typeof redline.id === "string" && redline.id.length > 0);
    assert.ok(/^E[1-8]$/.test(redline.id), `id 应匹配 E1~E8 模式，实际：${redline.id}`);

    // name：非空字符串
    assert.ok(typeof redline.name === "string" && redline.name.length > 0);

    // description：非空字符串，描述应足够详细（长度 >= 30 字符）
    assert.ok(
      typeof redline.description === "string" && redline.description.length >= 30,
      `${redline.id} description 应详细（>=30 字符）`
    );

    // severity：合法值
    const validSeverities: RedlineSeverity[] = ["blocker", "major", "warning"];
    assert.ok(
      validSeverities.includes(redline.severity),
      `${redline.id} severity 应为 blocker/major/warning，实际：${redline.severity}`
    );

    // checkMethod：非空字符串
    assert.ok(typeof redline.checkMethod === "string" && redline.checkMethod.length > 0);

    // checkType：static 或 reasoning
    const validCheckTypes: Array<RedlineDefinition["checkType"]> = ["static", "reasoning"];
    assert.ok(
      validCheckTypes.includes(redline.checkType),
      `${redline.id} checkType 应为 static/reasoning，实际：${redline.checkType}`
    );

    // fixGuidance：非空字符串，应包含具体修复步骤
    assert.ok(
      typeof redline.fixGuidance === "string" && redline.fixGuidance.length > 0,
      `${redline.id} fixGuidance 应非空`
    );
  }
});

// ============================================================================
// R3. severity 分布（E4/E6/E8 为 BLOCKER，E1/E2/E3/E5 为 MAJOR，E7 为 WARNING）
// ============================================================================

test("R3a. E4 依赖方向 为 BLOCKER", () => {
  const e4 = getRedlineById("E4");
  assert.ok(e4 !== null);
  assert.equal(e4!.severity, "blocker");
});

test("R3b. E6 密钥与配置 为 BLOCKER", () => {
  const e6 = getRedlineById("E6");
  assert.ok(e6 !== null);
  assert.equal(e6!.severity, "blocker");
});

test("R3c. E8 API 契约 为 BLOCKER", () => {
  const e8 = getRedlineById("E8");
  assert.ok(e8 !== null);
  assert.equal(e8!.severity, "blocker");
});

test("R3d. E1 事务边界 为 MAJOR", () => {
  const e1 = getRedlineById("E1");
  assert.ok(e1 !== null);
  assert.equal(e1!.severity, "major");
});

test("R3e. E2 幂等性 为 MAJOR", () => {
  const e2 = getRedlineById("E2");
  assert.ok(e2 !== null);
  assert.equal(e2!.severity, "major");
});

test("R3f. E3 审计 为 MAJOR", () => {
  const e3 = getRedlineById("E3");
  assert.ok(e3 !== null);
  assert.equal(e3!.severity, "major");
});

test("R3g. E5 输入校验 为 MAJOR", () => {
  const e5 = getRedlineById("E5");
  assert.ok(e5 !== null);
  assert.equal(e5!.severity, "major");
});

test("R3h. E7 贫血模型禁令 为 WARNING", () => {
  const e7 = getRedlineById("E7");
  assert.ok(e7 !== null);
  assert.equal(e7!.severity, "warning");
});

test("R3i. severity 分布统计：BLOCKER=3 / MAJOR=4 / WARNING=1", () => {
  const blockers = getRedlinesBySeverity("blocker");
  const majors = getRedlinesBySeverity("major");
  const warnings = getRedlinesBySeverity("warning");
  assert.equal(blockers.length, 3);
  assert.equal(majors.length, 4);
  assert.equal(warnings.length, 1);
  // 验证 BLOCKER 集合为 E4/E6/E8
  const blockerIds = blockers.map((r) => r.id).sort();
  assert.deepEqual(blockerIds, ["E4", "E6", "E8"]);
  // 验证 MAJOR 集合为 E1/E2/E3/E5
  const majorIds = majors.map((r) => r.id).sort();
  assert.deepEqual(majorIds, ["E1", "E2", "E3", "E5"]);
  // 验证 WARNING 集合为 E7
  const warningIds = warnings.map((r) => r.id);
  assert.deepEqual(warningIds, ["E7"]);
});

// ============================================================================
// R4. id 唯一性（E1~E8 无重复）
// ============================================================================

test("R4. id 唯一性——E1~E8 无重复", () => {
  const ids = ENTERPRISE_REDLINES.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, `id 存在重复：${ids.join(",")}`);
});

test("R4b. id 完整性——包含 E1~E8 全部 8 个 id", () => {
  const ids = new Set(ENTERPRISE_REDLINES.map((r) => r.id));
  for (let i = 1; i <= 8; i++) {
    const expectedId = `E${i}`;
    assert.ok(ids.has(expectedId), `缺少红线 ${expectedId}`);
  }
});

test("R4c. ENTERPRISE_REDLINES 按 E1~E8 顺序排列", () => {
  const expectedOrder = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];
  const actualOrder = ENTERPRISE_REDLINES.map((r) => r.id);
  assert.deepEqual(actualOrder, expectedOrder);
});

// ============================================================================
// R5. getRedlinesBySeverity 正确过滤
// ============================================================================

test("R5a. getRedlinesBySeverity('blocker') 返回 3 条 BLOCKER 红线", () => {
  const blockers = getRedlinesBySeverity("blocker");
  assert.equal(blockers.length, 3);
  for (const r of blockers) {
    assert.equal(r.severity, "blocker");
  }
});

test("R5b. getRedlinesBySeverity('major') 返回 4 条 MAJOR 红线", () => {
  const majors = getRedlinesBySeverity("major");
  assert.equal(majors.length, 4);
  for (const r of majors) {
    assert.equal(r.severity, "major");
  }
});

test("R5c. getRedlinesBySeverity('warning') 返回 1 条 WARNING 红线", () => {
  const warnings = getRedlinesBySeverity("warning");
  assert.equal(warnings.length, 1);
  for (const r of warnings) {
    assert.equal(r.severity, "warning");
  }
});

test("R5d. getRedlinesBySeverity 三个级别总和 = 8", () => {
  const total =
    getRedlinesBySeverity("blocker").length +
    getRedlinesBySeverity("major").length +
    getRedlinesBySeverity("warning").length;
  assert.equal(total, 8);
});

// ============================================================================
// R6. getRedlineById 正确查找
// ============================================================================

test("R6a. getRedlineById('E1') 返回事务边界红线", () => {
  const e1 = getRedlineById("E1");
  assert.ok(e1 !== null);
  assert.equal(e1!.id, "E1");
  assert.equal(e1!.name, "事务边界");
  assert.equal(e1!.severity, "major");
});

test("R6b. getRedlineById 逐条验证 E1~E8", () => {
  const expectedNames: Record<string, string> = {
    E1: "事务边界",
    E2: "幂等性",
    E3: "审计",
    E4: "依赖方向",
    E5: "输入校验",
    E6: "密钥与配置",
    E7: "贫血模型禁令",
    E8: "API 契约",
  };
  for (let i = 1; i <= 8; i++) {
    const id = `E${i}`;
    const redline = getRedlineById(id);
    assert.ok(redline !== null, `${id} 应存在`);
    assert.equal(redline!.id, id);
    assert.equal(redline!.name, expectedNames[id], `${id} name 应为 ${expectedNames[id]}`);
  }
});

test("R6c. getRedlineById 不存在的 id 返回 null", () => {
  assert.equal(getRedlineById("E9"), null);
  assert.equal(getRedlineById(""), null);
  assert.equal(getRedlineById("nonexistent"), null);
});

// ============================================================================
// R7. getEnterpriseRedlineCount = 8（额外验证）
// ============================================================================

test("R7. getEnterpriseRedlineCount 返回 8", () => {
  assert.equal(getEnterpriseRedlineCount(), 8);
});

test("R7b. getEnterpriseRedlineCount 与 ENTERPRISE_REDLINES.length 一致", () => {
  assert.equal(getEnterpriseRedlineCount(), ENTERPRISE_REDLINES.length);
});

// ============================================================================
// 附加：checkType 分布验证
// ============================================================================

test("R8a. checkType 分布——BLOCKER 红线（E4/E6/E8）均为 static 静态可判", () => {
  const blockers = getRedlinesBySeverity("blocker");
  for (const r of blockers) {
    assert.equal(r.checkType, "static", `${r.id}（BLOCKER）应为 static 静态可判，实际：${r.checkType}`);
  }
});

test("R8b. E3 审计 与 E7 贫血模型禁令 为 reasoning 推理判定", () => {
  const e3 = getRedlineById("E3");
  const e7 = getRedlineById("E7");
  assert.ok(e3 !== null && e7 !== null);
  assert.equal(e3!.checkType, "reasoning");
  assert.equal(e7!.checkType, "reasoning");
});

test("R8c. checkType 分布统计——static=6 / reasoning=2", () => {
  const staticCount = ENTERPRISE_REDLINES.filter((r) => r.checkType === "static").length;
  const reasoningCount = ENTERPRISE_REDLINES.filter((r) => r.checkType === "reasoning").length;
  assert.equal(staticCount, 6);
  assert.equal(reasoningCount, 2);
});
