import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ============================================================================
// Qwen3.8 适配文档一致性测试（v1.2，对应设计文档 docs/qwen38-adaptation.md §5.8）
//
// 对应验收标准第 8 条的自动化支撑：防止「代码改了文档没改」的回归。
//   T1  docs/configuration.md 与 configuration_en.md 必须包含五档字面量
//       （low / medium / high / xhigh / max）及 preserve_thinking 参数说明
//   T2  内置 skill 参考文档（随包分发）同样必须同步五档表述
// ============================================================================

/** 仓库根目录：本文件位于 packages/core/src/tests/，向上四级（tests → src → core → packages）为仓库根 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** 断言文档包含五档字面量与 preserve_thinking（公共校验逻辑） */
function assertDocsContainFiveLevels(path: string, label: string): void {
  const text = readFileSync(path, "utf-8");
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.ok(text.includes(`"${level}"`), `${label} 应包含五档字面量 "${level}"`);
  }
  assert.ok(text.includes("preserve_thinking"), `${label} 应包含 preserve_thinking 参数说明`);
}

test("docs/configuration*.md 与实现一致（五档 + preserve_thinking）", () => {
  assertDocsContainFiveLevels(resolve(REPO_ROOT, "docs", "configuration.md"), "docs/configuration.md");
  assertDocsContainFiveLevels(resolve(REPO_ROOT, "docs", "configuration_en.md"), "docs/configuration_en.md");
});

test("内置 skill 参考文档与实现一致（五档 + preserve_thinking）", () => {
  // 内置 skill 参考文档随包分发，必须与 docs 保持一致
  assertDocsContainFiveLevels(
    resolve(
      REPO_ROOT,
      "packages",
      "core",
      "templates",
      "skills",
      "bundled",
      "deepcode-self-refer",
      "references",
      "configuration.md"
    ),
    "bundled references/configuration.md"
  );
  assertDocsContainFiveLevels(
    resolve(
      REPO_ROOT,
      "packages",
      "core",
      "templates",
      "skills",
      "bundled",
      "deepcode-self-refer",
      "references",
      "configuration_en.md"
    ),
    "bundled references/configuration_en.md"
  );
});
