/**
 * EAG-P2 批次 9 参数化测试：13 个 StaticChecker × redline-fixtures 样例库
 *
 * 测试范围：
 * - P1. manifest 完整性（P1a~P1e，5 项）
 * - P2. 样例加载（P2a~P2c，3 项）
 * - P3. violation 样例参数化判定（19 项，每 violation fixture 1 项）
 * - P4. compliant 样例参数化判定（19 项，每 compliant fixture 1 项）
 * - P5. 误报率统计（P5a~P5b，2 项）
 * - P6. 判定确定性（P6a，1 项）
 *
 * 合计：49 项测试
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，直接调用真实 fixtures 与 Checker 实例
 * - 每个 violation fixture 断言 status="violated" 且违规数 ≥ expectedViolationCount
 * - 每个 compliant fixture 断言 status="passed" 且违规数 = 0
 * - 违规描述需包含 manifest 声明的全部关键词（语义正确性）
 *
 * 设计依据：
 * - EAG-P2 批次 9 redline-fixtures 设计 §2 eag-coding-static-checkers.test.ts 参数化测试设计
 * - EAG 方案 §5.1.3 企业红线清单 + §5.8 TCS 红线清单
 *
 * @module core/tests/eag-coding-static-checkers
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadAllFixtures,
  getFixturesByKind,
  validateFixtureManifest,
  FIXTURE_MANIFEST,
} from "./fixtures/eag-redline/index";
import { DEFAULT_STATIC_CHECKERS, createContractGuardChecker } from "../eag/coding/static-checkers";
import type { StaticChecker } from "../eag/coding/types";
import type { RedlineDefinition } from "../eag/evaluator/types";
import { ENTERPRISE_REDLINES } from "../eag/redlines/enterprise-rules";
import { TCS_REDLINES } from "../eag/tcs/tcs-redlines";
import type { LoadedFixture } from "./fixtures/eag-redline/types";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 按 fixture 元数据路由到对应 Checker 实例
 *
 * 路由规则：
 * 1. 棕地专属（checkerClass === "ContractGuardChecker"）→ 通过 createContractGuardChecker
 *    注入该 fixture 专属的 existingApiContracts baseline（从 fixture 模块的 named export 读取）
 * 2. 其余 → DEFAULT_STATIC_CHECKERS.get(targetRedlineId)
 *
 * @param fixture 加载后的样例
 * @returns 对应的 StaticChecker 实例
 */
function resolveChecker(fixture: LoadedFixture): StaticChecker {
  if (fixture.checkerClass === "ContractGuardChecker") {
    // 棕地样例模块额外 export BROWNFIELD_BASELINE 常量
    const baseline = fixture.brownfieldBaseline ?? [];
    return createContractGuardChecker(baseline);
  }
  const checker = DEFAULT_STATIC_CHECKERS.get(fixture.meta.targetRedlineId);
  assert.ok(checker, `红线 ${fixture.meta.targetRedlineId} 未注册 Checker`);
  return checker;
}

/**
 * 按 redlineId 从企业红线 + TCS 红线清单查找 RedlineDefinition
 *
 * 棕地专属红线（ContractGuardChecker）构造合成 RedlineDefinition：
 * { id: "BROWNFIELD-CONTRACT", severity: "blocker", checkType: "static", ... }
 *
 * @param redlineId 红线 ID
 * @returns RedlineDefinition 实例
 */
function resolveRedline(redlineId: string): RedlineDefinition {
  const allRedlines = [...ENTERPRISE_REDLINES, ...TCS_REDLINES];
  const found = allRedlines.find((r) => r.id === redlineId);
  if (found) return found;
  // 棕地专属合成红线
  if (redlineId === "BROWNFIELD-CONTRACT") {
    return {
      id: "BROWNFIELD-CONTRACT",
      name: "既有契约保护",
      description: "棕地场景既有 API 契约保护",
      severity: "blocker",
      checkMethod: "API 签名兼容性比对",
      checkType: "static",
      fixGuidance: "保持向后兼容",
    };
  }
  throw new Error(`未找到红线定义：${redlineId}`);
}

// ============================================================================
// P1. manifest 完整性测试（5 项）
// ============================================================================

test("P1a. manifest 版本与总数校验", () => {
  assert.equal(FIXTURE_MANIFEST.version, "1.0.0", "manifest 版本应为 1.0.0");
  const allFixtures = loadAllFixtures();
  assert.equal(
    FIXTURE_MANIFEST.totalFixtures,
    allFixtures.length,
    `manifest.totalFixtures=${FIXTURE_MANIFEST.totalFixtures} 应与实际加载数=${allFixtures.length} 一致`
  );
});

test("P1b. validateFixtureManifest 返回 null", () => {
  const errors = validateFixtureManifest();
  assert.equal(errors, null, `manifest 校验应通过，错误: ${errors ? errors.join("; ") : ""}`);
});

test("P1c. 每个 Checker 至少 1 对样例", () => {
  for (const checker of FIXTURE_MANIFEST.checkers) {
    const fixtures = checker.fixtures;
    assert.ok(fixtures.length >= 2, `Checker ${checker.checkerName} 应至少有 2 个样例（violation + compliant）`);
    const violations = fixtures.filter((f) => f.kind === "violation");
    const compliants = fixtures.filter((f) => f.kind === "compliant");
    assert.ok(violations.length >= 1, `Checker ${checker.checkerName} 应至少有 1 个 violation 样例`);
    assert.ok(compliants.length >= 1, `Checker ${checker.checkerName} 应至少有 1 个 compliant 样例`);
  }
});

test("P1d. 全部 redlineId 在 DEFAULT_STATIC_CHECKERS 中已注册（除 ContractGuard）", () => {
  for (const checker of FIXTURE_MANIFEST.checkers) {
    for (const fixture of checker.fixtures) {
      const redlineId = fixture.targetRedlineId;
      if (redlineId === "BROWNFIELD-CONTRACT") {
        // 棕地专属红线不在 DEFAULT_STATIC_CHECKERS 中注册
        continue;
      }
      assert.ok(
        DEFAULT_STATIC_CHECKERS.has(redlineId),
        `红线 ${redlineId} 应在 DEFAULT_STATIC_CHECKERS 中注册（Checker: ${checker.checkerName}）`
      );
    }
  }
});

test("P1e. fixtureId 全局唯一", () => {
  const fixtureIds = new Set<string>();
  for (const checker of FIXTURE_MANIFEST.checkers) {
    for (const fixture of checker.fixtures) {
      assert.ok(!fixtureIds.has(fixture.fixtureId), `fixtureId 重复：${fixture.fixtureId}`);
      fixtureIds.add(fixture.fixtureId);
    }
  }
});

// ============================================================================
// P2. 样例加载测试（3 项）
// ============================================================================

test("P2a. loadAllFixtures 返回非空数组", () => {
  const allFixtures = loadAllFixtures();
  assert.ok(allFixtures.length > 0, "loadAllFixtures 应返回非空数组");
  assert.equal(
    allFixtures.length,
    FIXTURE_MANIFEST.totalFixtures,
    `加载数量=${allFixtures.length} 应与 manifest.totalFixtures=${FIXTURE_MANIFEST.totalFixtures} 一致`
  );
});

test("P2b. 每个 LoadedFixture 的 artifacts 非空", () => {
  const allFixtures = loadAllFixtures();
  for (const fixture of allFixtures) {
    assert.ok(fixture.artifacts.length >= 1, `样例 ${fixture.meta.fixtureId} 的 artifacts 应非空`);
    for (const artifact of fixture.artifacts) {
      assert.ok(artifact.path.length > 0, `样例 ${fixture.meta.fixtureId} 的 artifact.path 应非空`);
      assert.ok(artifact.content.length > 0, `样例 ${fixture.meta.fixtureId} 的 artifact.content 应非空`);
    }
  }
});

test("P2c. 每个 TypeScript artifact.content 首行为路径注释", () => {
  const allFixtures = loadAllFixtures();
  for (const fixture of allFixtures) {
    for (const artifact of fixture.artifacts) {
      // 仅检查 TypeScript 文件（.ts 扩展名）；package.json 等非 TS 文件豁免
      if (!artifact.path.endsWith(".ts")) {
        continue;
      }
      const firstLine = artifact.content.split("\n")[0] ?? "";
      assert.ok(
        /^\/\/\s*\S+/.test(firstLine),
        `样例 ${fixture.meta.fixtureId} 的 TypeScript artifact 首行应为路径注释（// path），实际：${firstLine.slice(0, 50)}`
      );
    }
  }
});

// ============================================================================
// P3. violation 样例参数化判定（19 项）
// ============================================================================

const violationFixtures = getFixturesByKind("violation");
for (const fixture of violationFixtures) {
  test(`P3. [${fixture.meta.fixtureId}] violation 样例 → status=violated`, () => {
    // 1. 路由 Checker
    const checker = resolveChecker(fixture);
    // 2. 构造 RedlineDefinition
    const redline = resolveRedline(fixture.meta.targetRedlineId);
    // 3. 执行判定
    const result = checker.check(fixture.artifacts, redline);
    // 4. 断言判定结果
    assert.equal(
      result.status,
      "violated",
      `[${fixture.meta.fixtureId}] 预期 violated，实际 ${result.status}（误报为 passed）`
    );
    assert.ok(
      result.violations.length >= fixture.meta.expectedViolationCount,
      `[${fixture.meta.fixtureId}] 预期至少 ${fixture.meta.expectedViolationCount} 个违规，实际 ${result.violations.length}`
    );
    // 5. 语义正确性：违规描述含预期关键词
    const allDescriptions = result.violations.map((v) => v.description).join("\n");
    for (const pattern of fixture.meta.expectedViolationPatterns) {
      assert.ok(
        allDescriptions.includes(pattern),
        `[${fixture.meta.fixtureId}] 违规描述应包含关键词 "${pattern}"，实际描述：${allDescriptions.slice(0, 200)}...`
      );
    }
  });
}

// ============================================================================
// P4. compliant 样例参数化判定（19 项）
// ============================================================================

const compliantFixtures = getFixturesByKind("compliant");
for (const fixture of compliantFixtures) {
  test(`P4. [${fixture.meta.fixtureId}] compliant 样例 → status=passed`, () => {
    const checker = resolveChecker(fixture);
    const redline = resolveRedline(fixture.meta.targetRedlineId);
    const result = checker.check(fixture.artifacts, redline);
    assert.equal(
      result.status,
      "passed",
      `[${fixture.meta.fixtureId}] 预期 passed，实际 ${result.status}（误报！违规：${JSON.stringify(result.violations)}）`
    );
    assert.equal(result.violations.length, 0, `[${fixture.meta.fixtureId}] compliant 样例违规数应为 0`);
  });
}

// ============================================================================
// P5. 误报率统计测试（2 项）
// ============================================================================

test("P5a. compliant 样例误报率 = 0%", () => {
  const falsePositives: Array<{ fixtureId: string; status: string; violations: number }> = [];
  for (const fixture of compliantFixtures) {
    const checker = resolveChecker(fixture);
    const redline = resolveRedline(fixture.meta.targetRedlineId);
    const result = checker.check(fixture.artifacts, redline);
    if (result.status !== "passed") {
      falsePositives.push({
        fixtureId: fixture.meta.fixtureId,
        status: result.status,
        violations: result.violations.length,
      });
    }
  }
  assert.equal(
    falsePositives.length,
    0,
    `compliant 样例误报率应为 0%，误报清单：${JSON.stringify(falsePositives, null, 2)}`
  );
});

test("P5b. violation 样例漏报率 = 0%", () => {
  const falseNegatives: Array<{ fixtureId: string; status: string }> = [];
  for (const fixture of violationFixtures) {
    const checker = resolveChecker(fixture);
    const redline = resolveRedline(fixture.meta.targetRedlineId);
    const result = checker.check(fixture.artifacts, redline);
    if (result.status !== "violated") {
      falseNegatives.push({
        fixtureId: fixture.meta.fixtureId,
        status: result.status,
      });
    }
  }
  assert.equal(
    falseNegatives.length,
    0,
    `violation 样例漏报率应为 0%，漏报清单：${JSON.stringify(falseNegatives, null, 2)}`
  );
});

// ============================================================================
// P6. 判定确定性测试（1 项）
// ============================================================================

test("P6a. 同一 fixture 重复判定 3 次结果一致", () => {
  const allFixtures = loadAllFixtures();
  // 随机抽 5 个 fixture（或全部若不足 5 个）
  const sampleSize = Math.min(5, allFixtures.length);
  const sampled = allFixtures.slice(0, sampleSize);

  for (const fixture of sampled) {
    const checker = resolveChecker(fixture);
    const redline = resolveRedline(fixture.meta.targetRedlineId);

    // 连续判定 3 次
    const results = [
      checker.check(fixture.artifacts, redline),
      checker.check(fixture.artifacts, redline),
      checker.check(fixture.artifacts, redline),
    ];

    // 断言 3 次结果完全一致
    const firstStatus = results[0].status;
    const firstViolationCount = results[0].violations.length;
    for (let i = 1; i < results.length; i++) {
      assert.equal(
        results[i].status,
        firstStatus,
        `[${fixture.meta.fixtureId}] 第 ${i + 1} 次判定状态=${results[i].status} 应与第 1 次=${firstStatus} 一致`
      );
      assert.equal(
        results[i].violations.length,
        firstViolationCount,
        `[${fixture.meta.fixtureId}] 第 ${i + 1} 次判定违规数=${results[i].violations.length} 应与第 1 次=${firstViolationCount} 一致`
      );
    }
  }
});
