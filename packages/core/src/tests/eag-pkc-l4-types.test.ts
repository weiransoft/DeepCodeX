/**
 * EAG-P3 批次 11 Part B2 单元测试：PKC L4 交接文档层类型与常量
 *
 * 测试范围：
 * - T1. ConfidenceLevel 字面量联合类型与 CONFIDENCE_LEVELS 常量
 *   - T1a. CONFIDENCE_LEVELS 顺序为 inferred < documented < verified
 *   - T1b. CONFIDENCE_LEVELS 被 Object.freeze 冻结
 *   - T1c. CONFIDENCE_PRIORITY 数值表（inferred=0 / documented=1 / verified=2）
 *   - T1d. CONFIDENCE_PRIORITY 被 Object.freeze 冻结
 * - T2. INFERRED_SECTION_NOTICE 常量
 *   - T2a. 含人工审核提示文案
 *   - T2b. 以两个换行结尾（用于 Markdown 段落分隔）
 * - T3. HandoverSection 接口（运行时校验通过 createHandoverSection 工厂函数）
 *   - T3a. 合法字段创建成功
 *   - T3b. sectionId 非法时抛错
 *   - T3c. order 超出 1~7 时抛错
 *   - T3d. confidence 非法时抛错
 *   - T3e. inferred 章节 content 必须以 INFERRED_SECTION_NOTICE 开头
 *   - T3f. 返回对象被 Object.freeze 冻结
 *   - T3g. sources 数组被 Object.freeze 冻结
 * - T4. SECTION_DEFINITIONS 七章结构定义表
 *   - T4a. 长度 === 7
 *   - T4b. order 1~7 互不重复
 *   - T4c. sectionId 互不重复
 *   - T4d. 默认置信度与 §7.4 表格一致
 *   - T4e. 被 Object.freeze 冻结
 * - T5. SECTION_COUNT 常量等于 7
 * - T6. isValidConfidenceLevel 校验函数
 *   - T6a. documented / inferred / verified 返回 true
 *   - T6b. 其他字符串返回 false
 *   - T6c. 非字符串返回 false
 * - T7. compareConfidence 比较函数
 *   - T7a. inferred < documented < verified
 *   - T7b. 相等级别返回 0
 * - T8. minConfidence 函数
 *   - T8a. 空数组返回 inferred
 *   - T8b. 全 verified 数组返回 verified
 *   - T8c. 含 inferred 数组返回 inferred
 *   - T8d. 含 documented 但无 inferred 返回 documented
 * - T9. HandoverDocumentBuilderError 异常类
 *   - T9a. kind 字段保留
 *   - T9b. detail 字段保留
 *   - T9c. name 字段为 "HandoverDocumentBuilderError"
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接调用真实函数与常量
 * - 中文详细注释
 *
 * @module core/tests/eag-pkc-l4-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENCE_LEVELS,
  CONFIDENCE_PRIORITY,
  INFERRED_SECTION_NOTICE,
  SECTION_DEFINITIONS,
  SECTION_COUNT,
  HandoverDocumentBuilderError,
  isValidConfidenceLevel,
  compareConfidence,
  minConfidence,
  createHandoverSection,
} from "../eag/pkc/l4/types";
import type { ConfidenceLevel, HandoverSection } from "../eag/pkc/l4/types";

// ============================================================================
// T1. ConfidenceLevel 与 CONFIDENCE_LEVELS
// ============================================================================

test("T1a: CONFIDENCE_LEVELS 顺序为 inferred < documented < verified", () => {
  assert.deepEqual([...CONFIDENCE_LEVELS], ["inferred", "documented", "verified"]);
});

test("T1b: CONFIDENCE_LEVELS 被 Object.freeze 冻结", () => {
  assert.equal(Object.isFrozen(CONFIDENCE_LEVELS), true);
});

test("T1c: CONFIDENCE_PRIORITY 数值表 inferred=0 / documented=1 / verified=2", () => {
  assert.equal(CONFIDENCE_PRIORITY.inferred, 0);
  assert.equal(CONFIDENCE_PRIORITY.documented, 1);
  assert.equal(CONFIDENCE_PRIORITY.verified, 2);
});

test("T1d: CONFIDENCE_PRIORITY 被 Object.freeze 冻结", () => {
  assert.equal(Object.isFrozen(CONFIDENCE_PRIORITY), true);
});

// ============================================================================
// T2. INFERRED_SECTION_NOTICE
// ============================================================================

test("T2a: INFERRED_SECTION_NOTICE 含人工审核提示文案", () => {
  assert.match(INFERRED_SECTION_NOTICE, /置信度提示/);
  assert.match(INFERRED_SECTION_NOTICE, /基于代码静态分析推断/);
  assert.match(INFERRED_SECTION_NOTICE, /需人工审核后提升置信度/);
});

test("T2b: INFERRED_SECTION_NOTICE 以两个换行结尾（Markdown 段落分隔）", () => {
  assert.ok(INFERRED_SECTION_NOTICE.endsWith("\n\n"));
});

// ============================================================================
// T3. createHandoverSection 工厂函数
// ============================================================================

/**
 * 构造合法的测试用 HandoverSection 输入
 *
 * @returns 合法的 HandoverSection 输入对象
 */
function buildValidSectionInput(): Readonly<HandoverSection> {
  return {
    sectionId: "test-section",
    title: "测试章节",
    order: 1,
    confidence: "documented",
    content: "## 测试章节\n\n这是测试内容。",
    sources: ["docs/test.md", "src/test.ts"],
  };
}

test("T3a: 合法字段创建成功", () => {
  const input = buildValidSectionInput();
  const section = createHandoverSection(input);
  assert.equal(section.sectionId, "test-section");
  assert.equal(section.title, "测试章节");
  assert.equal(section.order, 1);
  assert.equal(section.confidence, "documented");
  assert.equal(section.content, "## 测试章节\n\n这是测试内容。");
  assert.deepEqual([...section.sources], ["docs/test.md", "src/test.ts"]);
});

test("T3b: sectionId 非法（空字符串）时抛错", () => {
  const input = { ...buildValidSectionInput(), sectionId: "" };
  assert.throws(
    () => createHandoverSection(input),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      return true;
    }
  );
});

test("T3c: order 超出 1~7 时抛错（order=8）", () => {
  const input = { ...buildValidSectionInput(), order: 8 };
  assert.throws(
    () => createHandoverSection(input),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      const e = err as HandoverDocumentBuilderError;
      assert.equal(e.kind, "invalid-section-order");
      return true;
    }
  );
});

test("T3c2: order 超出 1~7 时抛错（order=0）", () => {
  const input = { ...buildValidSectionInput(), order: 0 };
  assert.throws(
    () => createHandoverSection(input),
    (err: unknown) => err instanceof HandoverDocumentBuilderError
  );
});

test("T3d: confidence 非法时抛错", () => {
  const input = { ...buildValidSectionInput(), confidence: "unknown" as ConfidenceLevel };
  assert.throws(
    () => createHandoverSection(input),
    (err: unknown) => err instanceof HandoverDocumentBuilderError
  );
});

test("T3e: inferred 章节 content 必须以 INFERRED_SECTION_NOTICE 开头", () => {
  // 缺少提示头部的 inferred 章节应抛错
  const invalidInput: HandoverSection = {
    sectionId: "risks-debt",
    title: "风险与技术债",
    order: 6,
    confidence: "inferred",
    content: "## 风险与技术债\n\n（缺少 inferred 提示头部）",
    sources: [],
  };
  assert.throws(
    () => createHandoverSection(invalidInput),
    (err: unknown) => err instanceof HandoverDocumentBuilderError
  );
});

test("T3e2: inferred 章节 content 以 INFERRED_SECTION_NOTICE 开头时创建成功", () => {
  const validInput: HandoverSection = {
    sectionId: "risks-debt",
    title: "风险与技术债",
    order: 6,
    confidence: "inferred",
    content: INFERRED_SECTION_NOTICE + "## 风险与技术债\n\n这是推断的风险内容。",
    sources: [],
  };
  const section = createHandoverSection(validInput);
  assert.equal(section.confidence, "inferred");
  assert.ok(section.content.startsWith(INFERRED_SECTION_NOTICE));
});

test("T3f: 返回对象被 Object.freeze 冻结", () => {
  const section = createHandoverSection(buildValidSectionInput());
  assert.equal(Object.isFrozen(section), true);
});

test("T3g: sources 数组被 Object.freeze 冻结", () => {
  const section = createHandoverSection(buildValidSectionInput());
  assert.equal(Object.isFrozen(section.sources), true);
});

// ============================================================================
// T4. SECTION_DEFINITIONS 七章结构定义表
// ============================================================================

test("T4a: SECTION_DEFINITIONS 长度 === 7", () => {
  assert.equal(SECTION_DEFINITIONS.length, 7);
});

test("T4b: SECTION_DEFINITIONS order 1~7 互不重复", () => {
  const orders = SECTION_DEFINITIONS.map((d) => d.order);
  assert.deepEqual(
    [...new Set(orders)].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7]
  );
});

test("T4c: SECTION_DEFINITIONS sectionId 互不重复", () => {
  const ids = SECTION_DEFINITIONS.map((d) => d.sectionId);
  assert.equal(new Set(ids).size, 7);
});

test("T4d: SECTION_DEFINITIONS 默认置信度与 §7.4 表格一致", () => {
  const expected: Record<string, ConfidenceLevel> = {
    "architecture-overview": "documented",
    "module-map": "verified",
    "api-contract": "verified",
    "data-model": "verified",
    "test-strategy": "documented",
    "risks-debt": "inferred",
    runbook: "inferred",
  };
  for (const def of SECTION_DEFINITIONS) {
    assert.equal(def.defaultConfidence, expected[def.sectionId], `sectionId=${def.sectionId} 默认置信度与 §7.4 不一致`);
  }
});

test("T4e: SECTION_DEFINITIONS 被 Object.freeze 冻结", () => {
  assert.equal(Object.isFrozen(SECTION_DEFINITIONS), true);
  for (const def of SECTION_DEFINITIONS) {
    assert.equal(Object.isFrozen(def), true);
  }
});

test("T4f: SECTION_DEFINITIONS order 与 sectionId 一一对应（顺序固定）", () => {
  const expectedOrder: Array<{ order: number; sectionId: string; title: string }> = [
    { order: 1, sectionId: "architecture-overview", title: "架构概览" },
    { order: 2, sectionId: "module-map", title: "模块地图" },
    { order: 3, sectionId: "api-contract", title: "API 契约" },
    { order: 4, sectionId: "data-model", title: "数据模型" },
    { order: 5, sectionId: "test-strategy", title: "测试策略" },
    { order: 6, sectionId: "risks-debt", title: "风险与技术债" },
    { order: 7, sectionId: "runbook", title: "运维手册" },
  ];
  for (let i = 0; i < expectedOrder.length; i++) {
    assert.equal(SECTION_DEFINITIONS[i].order, expectedOrder[i].order);
    assert.equal(SECTION_DEFINITIONS[i].sectionId, expectedOrder[i].sectionId);
    assert.equal(SECTION_DEFINITIONS[i].title, expectedOrder[i].title);
  }
});

// ============================================================================
// T5. SECTION_COUNT
// ============================================================================

test("T5: SECTION_COUNT 等于 7", () => {
  assert.equal(SECTION_COUNT, 7);
});

// ============================================================================
// T6. isValidConfidenceLevel
// ============================================================================

test("T6a: isValidConfidenceLevel 对 documented / inferred / verified 返回 true", () => {
  assert.equal(isValidConfidenceLevel("documented"), true);
  assert.equal(isValidConfidenceLevel("inferred"), true);
  assert.equal(isValidConfidenceLevel("verified"), true);
});

test("T6b: isValidConfidenceLevel 对其他字符串返回 false", () => {
  assert.equal(isValidConfidenceLevel("unknown"), false);
  assert.equal(isValidConfidenceLevel("DOCUMENTED"), false); // 大小写敏感
  assert.equal(isValidConfidenceLevel(""), false);
});

test("T6c: isValidConfidenceLevel 对非字符串返回 false", () => {
  assert.equal(isValidConfidenceLevel(null), false);
  assert.equal(isValidConfidenceLevel(undefined), false);
  assert.equal(isValidConfidenceLevel(123), false);
  assert.equal(isValidConfidenceLevel({}), false);
  assert.equal(isValidConfidenceLevel([]), false);
});

// ============================================================================
// T7. compareConfidence
// ============================================================================

test("T7a: compareConfidence 满足 inferred < documented < verified", () => {
  assert.ok(compareConfidence("inferred", "documented") < 0);
  assert.ok(compareConfidence("inferred", "verified") < 0);
  assert.ok(compareConfidence("documented", "verified") < 0);
  assert.ok(compareConfidence("verified", "documented") > 0);
  assert.ok(compareConfidence("verified", "inferred") > 0);
  assert.ok(compareConfidence("documented", "inferred") > 0);
});

test("T7b: compareConfidence 相等级别返回 0", () => {
  assert.equal(compareConfidence("inferred", "inferred"), 0);
  assert.equal(compareConfidence("documented", "documented"), 0);
  assert.equal(compareConfidence("verified", "verified"), 0);
});

// ============================================================================
// T8. minConfidence
// ============================================================================

/**
 * 构造测试用 HandoverSection（仅 confidence 字段有效，其他字段为最小合法值）
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

test("T8a: minConfidence 空数组返回 inferred", () => {
  assert.equal(minConfidence([]), "inferred");
});

test("T8b: minConfidence 全 verified 数组返回 verified", () => {
  const sections = [
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("verified"),
  ];
  assert.equal(minConfidence(sections), "verified");
});

test("T8c: minConfidence 含 inferred 数组返回 inferred", () => {
  const sections = [
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("inferred"),
    buildSectionWithConfidence("documented"),
  ];
  assert.equal(minConfidence(sections), "inferred");
});

test("T8d: minConfidence 含 documented 但无 inferred 返回 documented", () => {
  const sections = [
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("documented"),
    buildSectionWithConfidence("verified"),
  ];
  assert.equal(minConfidence(sections), "documented");
});

test("T8e: minConfidence 首章为 inferred 时（架构师审查 B2-M7 修复）保留 inferred", () => {
  // 架构师审查 B2-M7 修复要点：初始值使用 sections[0].confidence（首个章节的置信度），
  // 而非误导性的 "verified"
  const sections = [
    buildSectionWithConfidence("inferred"),
    buildSectionWithConfidence("verified"),
    buildSectionWithConfidence("documented"),
  ];
  assert.equal(minConfidence(sections), "inferred");
});

// ============================================================================
// T9. HandoverDocumentBuilderError 异常类
// ============================================================================

test("T9a: HandoverDocumentBuilderError kind 字段保留", () => {
  const err = new HandoverDocumentBuilderError("invalid-builder-count", "测试详情");
  assert.equal(err.kind, "invalid-builder-count");
});

test("T9b: HandoverDocumentBuilderError detail 字段保留", () => {
  const err = new HandoverDocumentBuilderError("duplicate-section-id", "ID 重复：foo");
  assert.equal(err.detail, "ID 重复：foo");
});

test("T9c: HandoverDocumentBuilderError name 字段为 HandoverDocumentBuilderError", () => {
  const err = new HandoverDocumentBuilderError("duplicate-section-order", "order 重复");
  assert.equal(err.name, "HandoverDocumentBuilderError");
});

test("T9d: HandoverDocumentBuilderError message 含 kind 与 detail", () => {
  const err = new HandoverDocumentBuilderError("invalid-section-order", "order=8 非法");
  assert.match(err.message, /invalid-section-order/);
  assert.match(err.message, /order=8 非法/);
});

test("T9e: HandoverDocumentBuilderError 是 Error 子类", () => {
  const err = new HandoverDocumentBuilderError("invalid-builder-count", "测试");
  assert.ok(err instanceof Error);
});
