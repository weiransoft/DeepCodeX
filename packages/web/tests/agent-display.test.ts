/**
 * 智能体显示名单测（web/agent-display）
 *
 * 守的是「技术标识不动、展示名中文化」这条边界：
 * - `name` 是 kebab-case 技术标识（目录名 / @ 提及 token / --role 参数），任何
 *   情况下都不能被改写，所以中文名只能来自 frontmatter `role`；
 * - `role` 的两种形态要区别对待：纯英文括注（`产品经理（Product Manager）`）
 *   是冗余，剥掉；中文括注（`产品经理（业务需求分析）`）是业务限定，保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDisplayName, agentMentionHint } from "../web/src/agent-display";

test("D1：中文 role 原样展示（中文括注是有效限定，不剥）", () => {
  assert.equal(
    agentDisplayName({ name: "domain-product-manager", role: "产品经理（业务需求分析）" }),
    "产品经理（业务需求分析）"
  );
});

test("D2：纯英文括注被剥离", () => {
  assert.equal(agentDisplayName({ name: "product-manager", role: "产品经理（Product Manager）" }), "产品经理");
  assert.equal(agentDisplayName({ name: "solo-coder", role: "独立开发者（Solo Coder）" }), "独立开发者");
  // 半角括号同样处理
  assert.equal(agentDisplayName({ name: "test-expert", role: "测试专家(Test Expert)" }), "测试专家");
});

test("D3：无 role 时回退技术标识（不显示空白）", () => {
  assert.equal(agentDisplayName({ name: "code-reviewer" }), "code-reviewer");
  assert.equal(agentDisplayName({ name: "code-reviewer", role: "" }), "code-reviewer");
  assert.equal(agentDisplayName({ name: "code-reviewer", role: "   " }), "code-reviewer");
});

test("D4：混排名字不被误剥（SEO 专家 / Agent 编排架构工程师）", () => {
  // 括注为中文 → 保留
  assert.equal(
    agentDisplayName({ name: "domain-seo-specialist", role: "SEO 专家（搜索引擎优化）" }),
    "SEO 专家（搜索引擎优化）"
  );
  // 名字本身含英文但无括注 → 整体保留
  assert.equal(
    agentDisplayName({ name: "domain-agent-orchestrator", role: "Agent 编排架构工程师（多 Agent 系统编排）" }),
    "Agent 编排架构工程师（多 Agent 系统编排）"
  );
});

test("D5：role 只有括注时保留原样（剥离会得到空名）", () => {
  assert.equal(agentDisplayName({ name: "x-agent", role: "（仅括注）" }), "（仅括注）");
});

test("D6：技术标识展示为 @name，与 roleId / 目录名一致", () => {
  assert.equal(agentMentionHint({ name: "domain-growth-hacker" }), "@domain-growth-hacker");
});
