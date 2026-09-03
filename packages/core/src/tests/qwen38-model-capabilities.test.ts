import { test } from "node:test";
import assert from "node:assert/strict";
import { isQwen3Model, isQwen38Model } from "../common/model-capabilities";

// ============================================================================
// Qwen3.8+ 模型识别单元测试（v1.2 Qwen3.8 适配）
//
// 对应设计文档 docs/qwen38-adaptation.md §5.1（验收标准第 1 条）：
//   T1  官方模型卡名称 Qwen/Qwen3.8-27B-FP8 → true
//   T2  大小写 / 前缀 / 后续版本（3.9）→ true
//   T3  无小数点 / 3.5 / 3.7 → false
//   T4  "qwen38" 无小数点 → false
//   T5  空串 / 空白 / 非 Qwen3 系列（qwen2.5）→ false
//   T6  子集性质：3.8+ 样例必须同时被 isQwen3Model 识别（锚定正则构造保证）
//   T7  两位数 minor（qwen3.10）→ true（\d+ 捕获完整数字）
//   T8  patch 后缀（qwen3.7.9）→ false（首段 7 < 8）
//   T9  多位小数（qwen3.8.1）→ true（首段 8）
//   T10 双函数分叉边界（qwen30-8b）：isQwen38Model=false 且 isQwen3Model=true
//   T11 首尾空格（trim 行为固化）→ true
//   T12 纯前缀名（无 - 后缀的 qwen3.8）→ true
// ============================================================================

test("isQwen38Model 识别官方模型卡名称 Qwen/Qwen3.8-27B-FP8（T1）", () => {
  assert.ok(isQwen38Model("Qwen/Qwen3.8-27B-FP8"), "Qwen/Qwen3.8-27B-FP8 应识别为 Qwen3.8+");
});

test("isQwen38Model 识别大小写 / 前缀 / 后续版本变体（T2）", () => {
  assert.ok(isQwen38Model("qwen3.8-27b"), "qwen3.8-27b 应识别为 Qwen3.8+");
  assert.ok(isQwen38Model("qwen3.8-plus"), "qwen3.8-plus 应识别为 Qwen3.8+");
  assert.ok(isQwen38Model("qwen3.8-max-preview"), "qwen3.8-max-preview 应识别为 Qwen3.8+");
  assert.ok(isQwen38Model("qwen3.9-70b"), "qwen3.9-70b（后续子版本）应识别为 Qwen3.8+");
  assert.ok(isQwen38Model("QWEN/QWEN3.8-27B"), "QWEN/QWEN3.8-27B 应识别（大小写不敏感）");
});

test("isQwen38Model 拒绝无小数点与 3.8 以下子版本（T3）", () => {
  assert.ok(!isQwen38Model("qwen3-8b"), "qwen3-8b（无小数点）不应识别为 Qwen3.8+");
  assert.ok(!isQwen38Model("Qwen3-32B"), "Qwen3-32B（无小数点）不应识别为 Qwen3.8+");
  assert.ok(!isQwen38Model("qwen3.5-72b"), "qwen3.5-72b（3.5 < 3.8）不应识别为 Qwen3.8+");
  assert.ok(!isQwen38Model("qwen3.7-max"), "qwen3.7-max（3.7 < 3.8）不应识别为 Qwen3.8+");
});

test("isQwen38Model 拒绝无小数点的 qwen38 字符串（T4）", () => {
  assert.ok(!isQwen38Model("qwen38-10b"), "qwen38-10b（无小数点）不应识别为 Qwen3.8+");
});

test("isQwen38Model 拒绝空串 / 空白 / 非 Qwen3 系列（T5）", () => {
  assert.ok(!isQwen38Model(""), "空字符串不应识别为 Qwen3.8+");
  assert.ok(!isQwen38Model("  "), "纯空白不应识别为 Qwen3.8+");
  assert.ok(!isQwen38Model("qwen2.5-72b"), "qwen2.5-72b（Qwen2 系列）不应识别为 Qwen3.8+");
});

test("isQwen38Model 识别集是 isQwen3Model 识别集的子集（T6）", () => {
  // 锚定正则 ^(qwen/)?qwen3\. 与 isQwen3Model 的 startsWith 口径对齐，
  // 所有 3.8+ 样例必须同时被 isQwen3Model 识别（构造保证的子集性质）
  const qwen38Samples = [
    "Qwen/Qwen3.8-27B-FP8",
    "qwen3.8-27b",
    "qwen3.8-plus",
    "qwen3.8-max-preview",
    "qwen3.9-70b",
    "QWEN/QWEN3.8-27B",
  ];
  for (const model of qwen38Samples) {
    assert.ok(isQwen38Model(model), `${model} 应识别为 Qwen3.8+`);
    assert.ok(isQwen3Model(model), `${model} 应同时被 isQwen3Model 识别（子集性质）`);
  }
});

test("isQwen38Model 正确处理两位数 minor 版本（T7）", () => {
  // \d+ 捕获完整数字：qwen3.10 的 minor=10 >= 8（若只取 1 位数字则误判为 1 < 8）
  assert.ok(isQwen38Model("qwen3.10-plus"), "qwen3.10-plus（minor=10）应识别为 Qwen3.8+");
});

test("isQwen38Model 正确处理 patch 后缀（T8）", () => {
  // 首个小数段 7 < 8，不因后续 ".9" 被贪婪匹配误判
  assert.ok(!isQwen38Model("qwen3.7.9-xxx"), "qwen3.7.9-xxx（首段 7 < 8）不应识别为 Qwen3.8+");
});

test("isQwen38Model 正确处理多位小数（T9）", () => {
  // 多位小数取首个小数段判定：qwen3.8.1 首段 8 >= 8
  assert.ok(isQwen38Model("qwen3.8.1-xxx"), "qwen3.8.1-xxx（首段 8）应识别为 Qwen3.8+");
});

test("isQwen38Model 与 isQwen3Model 的分叉边界 qwen30-8b（T10）", () => {
  // isQwen3Model 为 startsWith("qwen3") 前缀匹配，"qwen30-8b" 命中；
  // isQwen38Model 为严格小数点版本正则，不命中——必须落入旧 Qwen3 分支
  assert.ok(isQwen3Model("qwen30-8b"), "qwen30-8b 应被 isQwen3Model 识别（前缀匹配）");
  assert.ok(!isQwen38Model("qwen30-8b"), "qwen30-8b 不应被 isQwen38Model 识别（非小数点版本）");
});

test("isQwen38Model 对首尾空格做 trim 处理（T11）", () => {
  assert.ok(isQwen38Model("  qwen3.8-plus  "), "带首尾空格的 qwen3.8-plus 应识别（trim 处理）");
});

test("isQwen38Model 识别纯前缀名 qwen3.8（T12）", () => {
  // 正则不要求 - 后缀，纯前缀名也应命中
  assert.ok(isQwen38Model("qwen3.8"), "qwen3.8（无 - 后缀）应识别为 Qwen3.8+");
});
