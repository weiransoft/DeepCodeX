/**
 * 技能显示名单测（web/skill-display）
 *
 * 守的是「技术标识不动、展示名中文化」这条边界（与 agent-display 同源约束）：
 * - `name` 是 kebab-case 技术标识（目录名 / @ 提及 token），任何情况下都不能被改写；
 * - 中文名只能来自内置目录，未收录技能回退技术标识（不显示空白、不猜译）；
 * - 功能简介优先用技能自己的 frontmatter description（作者写的最权威），
 *   缺失时才用目录里的中文简介兜底。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { skillDisplayName, skillDisplaySummary } from "../web/src/skill-display";

test("S1：内置技能给中文名（技术标识本身不动）", () => {
  assert.equal(skillDisplayName({ name: "frontend-dev" }), "前端开发");
  assert.equal(skillDisplayName({ name: "browser-automation" }), "浏览器自动化");
  assert.equal(skillDisplayName({ name: "TRAE-code-review" }), "通用代码审查");
});

test("S2：未收录技能回退技术标识（不显示空白、不猜译）", () => {
  assert.equal(skillDisplayName({ name: "my-own-skill" }), "my-own-skill");
  assert.equal(skillDisplayName({ name: "some-unknown-thing" }), "some-unknown-thing");
});

test("S3：功能简介优先用中文的 frontmatter description", () => {
  // 作者写了中文 description → 用它（最贴切的原文）
  assert.equal(skillDisplaySummary({ name: "frontend-dev", description: "中文功能说明" }), "中文功能说明");
  // 目录未收录 + 英文描述 → 保留英文（不丢信息），但目录有中文译文时优先中文
  assert.equal(
    skillDisplaySummary({ name: "my-own-skill", description: "Custom English description" }),
    "Custom English description"
  );
  // 目录有中文译文 + 原始描述是英文 → 用中文译文（界面简介一律中文）
  assert.equal(
    skillDisplaySummary({ name: "frontend-dev", description: "Full-stack frontend development guide" }),
    "高品质前端开发，含动效设计与媒体素材生成。"
  );
  // description 前后空白视为空
  assert.equal(
    skillDisplaySummary({ name: "frontend-dev", description: "   " }),
    "高品质前端开发，含动效设计与媒体素材生成。"
  );
});

test("S4：description 缺失时用目录里的中文简介兜底", () => {
  assert.equal(skillDisplaySummary({ name: "frontend-dev" }), "高品质前端开发，含动效设计与媒体素材生成。");
  assert.notEqual(skillDisplaySummary({ name: "frontend-dev" }), "");
});

test("S5：既无 description 又未收录 → 空字符串（界面据此不渲染简介行）", () => {
  assert.equal(skillDisplaySummary({ name: "my-own-skill" }), "");
  assert.equal(skillDisplaySummary({ name: "my-own-skill", description: "" }), "");
});

test("S6：中文名不以「技能」结尾（避免与界面徽标重复表述）", () => {
  const names = ["frontend-dev", "browser-automation", "pdf", "xlsx", "TRAE-debugger", "skill-writer"];
  for (const name of names) {
    const zh = skillDisplayName({ name });
    assert.ok(!zh.endsWith("技能"), `${name} 的中文名不应以「技能」结尾，实际：${zh}`);
  }
});

test("S7：frontmatter name 与目录名不一致的技能也能查到中文名", () => {
  // 引擎按 frontmatter `name` 取技能名（可能是 "PDF OCR Extraction" 这类带空格大写的
  // 非常规名），目录键必须同时覆盖 frontmatter 名与目录名，否则回落成英文标识。
  assert.equal(skillDisplayName({ name: "PDF OCR Extraction" }), "PDF 文字识别");
  assert.equal(skillDisplayName({ name: "pdf-ocr-extraction" }), "PDF 文字识别");
});
