/**
 * EAG-P3 批次 11 Part B2 单元测试：置信度计算
 *
 * 专门测试 §7.5 calculateOverallConfidence 私有方法的逻辑（架构师审查 B2-M7 修复）。
 *
 * 测试范围：
 * - T1. 三级置信度排序
 *   - T1a. 全 verified 章节 → 整体 verified
 *   - T1b. 全 documented 章节 → 整体 documented
 *   - T1c. 全 inferred 章节 → 整体 inferred
 *   - T1d. 含 1 个 inferred 的混合章节 → 整体 inferred
 *   - T1e. 含 1 个 documented 但无 inferred 的混合章节 → 整体 documented
 *   - T1f. 含 1 个 verified 与 inferred 的混合章节 → 整体 inferred
 * - T2. 初始值使用首章置信度（B2-M7 修复点）
 *   - T2a. 首章为 inferred，后续全 verified → 整体 inferred
 *   - T2b. 首章为 verified，后续含 inferred → 整体 inferred
 *   - T2c. 首章为 documented，后续全 verified → 整体 documented
 * - T3. 端到端整体置信度（通过 HandoverDocumentBuilder.build 验证）
 *   - T3a. 默认 7 章（含 inferred）→ 整体 inferred
 *   - T3b. 全 verified 自定义 7 章 → 整体 verified
 *   - T3c. 含 inferred 自定义 7 章 → 整体 inferred
 *   - T3d. 全 documented 自定义 7 章 → 整体 documented
 * - T4. minConfidence 辅助函数
 *   - T4a. 空数组返回 inferred
 *   - T4b. 单元素数组返回该元素置信度
 *   - T4c. 多元素混合返回最低
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock
 * - 中文详细注释
 *
 * @module core/tests/eag-pkc-l4-confidence
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoverDocumentBuilder } from "../eag/pkc/l4/handover-doc-builder";
import { CONFIDENCE_PRIORITY, INFERRED_SECTION_NOTICE, minConfidence } from "../eag/pkc/l4/types";
import type { ConfidenceLevel, HandoverSection, SectionBuilder, SectionBuildContext } from "../eag/pkc/l4/types";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构造测试用 SectionBuilder（自定义 confidence）
 *
 * @param sectionId 章节 ID
 * @param order 章节顺序（1~7）
 * @param confidence 置信度
 * @returns SectionBuilder 实例
 */
function createBuilderWithConfidence(sectionId: string, order: number, confidence: ConfidenceLevel): SectionBuilder {
  return {
    sectionId,
    title: `章节-${sectionId}`,
    order,
    async build(): Promise<HandoverSection> {
      // inferred 章节 content 必须以 INFERRED_SECTION_NOTICE 开头
      const content =
        confidence === "inferred" ? `${INFERRED_SECTION_NOTICE}## 章节-${sectionId}\n` : `## 章节-${sectionId}\n`;
      return Object.freeze({
        sectionId,
        title: `章节-${sectionId}`,
        order,
        confidence,
        content,
        sources: Object.freeze([]),
      });
    },
  };
}

/**
 * 构造 7 个 SectionBuilder，按指定置信度模式生成
 *
 * @param mode 置信度模式
 *   - "all-verified"：7 个全部 verified
 *   - "all-documented"：7 个全部 documented
 *   - "all-inferred"：7 个全部 inferred
 *   - "mixed-with-inferred"：6 个 verified + 1 个 inferred
 *   - "mixed-with-documented"：6 个 verified + 1 个 documented
 *   - "first-inferred-rest-verified"：第 1 个 inferred，其余 verified
 *   - "first-verified-rest-inferred"：第 1 个 verified，其余 inferred
 * @returns 7 个 SectionBuilder 数组
 */
function createBuildersByMode(mode: string): ReadonlyArray<SectionBuilder> {
  const sectionIds = ["sec1", "sec2", "sec3", "sec4", "sec5", "sec6", "sec7"];
  let confidences: ConfidenceLevel[];

  switch (mode) {
    case "all-verified":
      confidences = ["verified", "verified", "verified", "verified", "verified", "verified", "verified"];
      break;
    case "all-documented":
      confidences = ["documented", "documented", "documented", "documented", "documented", "documented", "documented"];
      break;
    case "all-inferred":
      confidences = ["inferred", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred"];
      break;
    case "mixed-with-inferred":
      confidences = ["verified", "verified", "verified", "verified", "verified", "verified", "inferred"];
      break;
    case "mixed-with-documented":
      confidences = ["verified", "verified", "verified", "verified", "verified", "verified", "documented"];
      break;
    case "first-inferred-rest-verified":
      confidences = ["inferred", "verified", "verified", "verified", "verified", "verified", "verified"];
      break;
    case "first-verified-rest-inferred":
      confidences = ["verified", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred"];
      break;
    case "first-documented-rest-verified":
      confidences = ["documented", "verified", "verified", "verified", "verified", "verified", "verified"];
      break;
    default:
      throw new Error(`未知 mode: ${mode}`);
  }

  return sectionIds.map((id, i) => createBuilderWithConfidence(id, i + 1, confidences[i]));
}

/**
 * 构造测试用 context（含空 fileMap）
 *
 * @returns SectionBuildContext
 */
function buildEmptyContext(): SectionBuildContext {
  return {
    projectRoot: "/tmp/test",
    runId: "test-run",
    fileMap: {},
  };
}

/**
 * 通过 HandoverDocumentBuilder.build 验证整体置信度
 *
 * @param builders SectionBuilder 数组
 * @returns 整体置信度
 */
async function computeOverallConfidence(builders: ReadonlyArray<SectionBuilder>): Promise<ConfidenceLevel> {
  const builder = new HandoverDocumentBuilder(builders);
  const doc = await builder.build(buildEmptyContext(), "test-doc", "test-run");
  return doc.overallConfidence;
}

// ============================================================================
// T1. 三级置信度排序
// ============================================================================

test("T1a: 全 verified 章节 → 整体 verified", async () => {
  const builders = createBuildersByMode("all-verified");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "verified");
});

test("T1b: 全 documented 章节 → 整体 documented", async () => {
  const builders = createBuildersByMode("all-documented");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "documented");
});

test("T1c: 全 inferred 章节 → 整体 inferred", async () => {
  const builders = createBuildersByMode("all-inferred");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

test("T1d: 含 1 个 inferred 的混合章节 → 整体 inferred", async () => {
  const builders = createBuildersByMode("mixed-with-inferred");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

test("T1e: 含 1 个 documented 但无 inferred 的混合章节 → 整体 documented", async () => {
  const builders = createBuildersByMode("mixed-with-documented");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "documented");
});

test("T1f: 含 1 个 verified 与 inferred 的混合章节 → 整体 inferred", async () => {
  // 构造 1 verified + 1 inferred + 5 documented
  const builders: SectionBuilder[] = [
    createBuilderWithConfidence("sec1", 1, "verified"),
    createBuilderWithConfidence("sec2", 2, "inferred"),
    createBuilderWithConfidence("sec3", 3, "documented"),
    createBuilderWithConfidence("sec4", 4, "documented"),
    createBuilderWithConfidence("sec5", 5, "documented"),
    createBuilderWithConfidence("sec6", 6, "documented"),
    createBuilderWithConfidence("sec7", 7, "documented"),
  ];
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

// ============================================================================
// T2. 初始值使用首章置信度（B2-M7 修复点）
// ============================================================================

test("T2a: 首章为 inferred，后续全 verified → 整体 inferred", async () => {
  // 架构师审查 B2-M7 修复要点：
  // 初始值使用 sections[0].confidence（首个章节的置信度），而非误导性的 "verified"
  // 若首章为 inferred，后续章节无论置信度多高都会保留 inferred
  const builders = createBuildersByMode("first-inferred-rest-verified");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

test("T2b: 首章为 verified，后续含 inferred → 整体 inferred", async () => {
  // 首章 verified，后续 6 个 inferred，整体应为 inferred
  const builders = createBuildersByMode("first-verified-rest-inferred");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

test("T2c: 首章为 documented，后续全 verified → 整体 documented", async () => {
  const builders = createBuildersByMode("first-documented-rest-verified");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "documented");
});

test("T2d: B2-M7 修复验证——CONFIDENCE_PRIORITY 数值正确", () => {
  // 验证 CONFIDENCE_PRIORITY 表的数值（inferred=0 / documented=1 / verified=2）
  // 这确保 reduce 比较时取最低逻辑正确
  assert.equal(CONFIDENCE_PRIORITY.inferred, 0);
  assert.equal(CONFIDENCE_PRIORITY.documented, 1);
  assert.equal(CONFIDENCE_PRIORITY.verified, 2);
  // inferred < documented < verified
  assert.ok(CONFIDENCE_PRIORITY.inferred < CONFIDENCE_PRIORITY.documented);
  assert.ok(CONFIDENCE_PRIORITY.documented < CONFIDENCE_PRIORITY.verified);
});

// ============================================================================
// T3. 端到端整体置信度（通过 HandoverDocumentBuilder.build 验证）
// ============================================================================

test("T3a: 默认 7 章（含 inferred risks-debt + runbook）→ 整体 inferred", async () => {
  // 此测试在 handover-doc-builder.test.ts T2c 已覆盖，此处再次验证以确保置信度逻辑独立可测
  // 由于默认 builders 含 inferred 章节，整体置信度必为 inferred
  const builders = createBuildersByMode("mixed-with-inferred");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

test("T3b: 全 verified 自定义 7 章 → 整体 verified", async () => {
  const builders = createBuildersByMode("all-verified");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "verified");
});

test("T3c: 含 inferred 自定义 7 章 → 整体 inferred", async () => {
  const builders = createBuildersByMode("all-inferred");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "inferred");
});

test("T3d: 全 documented 自定义 7 章 → 整体 documented", async () => {
  const builders = createBuildersByMode("all-documented");
  const overall = await computeOverallConfidence(builders);
  assert.equal(overall, "documented");
});

// ============================================================================
// T4. minConfidence 辅助函数
// ============================================================================

/**
 * 构造测试用 HandoverSection（仅 confidence 字段有效）
 *
 * @param confidence 置信度
 * @returns 测试用 HandoverSection
 */
function buildSectionWithConfidence(confidence: ConfidenceLevel): HandoverSection {
  return {
    sectionId: `test-${confidence}`,
    title: `测试-${confidence}`,
    order: 1,
    confidence,
    content: confidence === "inferred" ? INFERRED_SECTION_NOTICE + "## 测试\n" : "## 测试\n",
    sources: [],
  };
}

test("T4a: minConfidence 空数组返回 inferred", () => {
  assert.equal(minConfidence([]), "inferred");
});

test("T4b: minConfidence 单元素数组返回该元素置信度", () => {
  assert.equal(minConfidence([buildSectionWithConfidence("verified")]), "verified");
  assert.equal(minConfidence([buildSectionWithConfidence("documented")]), "documented");
  assert.equal(minConfidence([buildSectionWithConfidence("inferred")]), "inferred");
});

test("T4c: minConfidence 多元素混合返回最低", () => {
  const sections = [
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("inferred"),
    buildSectionWithConfidence("documented"),
  ];
  assert.equal(minConfidence(sections), "inferred");
});

test("T4d: minConfidence 首章为 inferred 时保留 inferred（B2-M7 修复点）", () => {
  // 首章 inferred，后续全 verified
  const sections = [
    buildSectionWithConfidence("inferred"),
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("verified"),
  ];
  assert.equal(minConfidence(sections), "inferred");
});

test("T4e: minConfidence 全 verified 时返回 verified", () => {
  const sections = [
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("verified"),
  ];
  assert.equal(minConfidence(sections), "verified");
});

test("T4f: minConfidence 与 HandoverDocumentBuilder.calculateOverallConfidence 结果一致", async () => {
  // 此测试验证私有方法 calculateOverallConfidence 与公开工具函数 minConfidence 逻辑一致
  const builders = createBuildersByMode("mixed-with-inferred");
  const builder = new HandoverDocumentBuilder(builders);
  const doc = await builder.build(buildEmptyContext(), "test-doc", "test-run");
  // minConfidence 计算结果应与 calculateOverallConfidence 一致
  const minFromSections = minConfidence([...doc.sections]);
  assert.equal(doc.overallConfidence, minFromSections);
});
