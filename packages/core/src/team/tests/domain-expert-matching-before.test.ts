/**
 * DomainExpertReviewPlugin 单元测试 - 拆分文件 2/5：构造 / meta / matches / before 钩子
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 / §5.3 / §8.4（P1-NEW-1 / P1-NEW-3 / P1-NEW-4）
 * 本文件覆盖：
 *   - 第六部分：DomainExpertReviewPlugin 构造与 meta（5 个测试）
 *   - 第七部分：matches() 条件分支（8 个测试）
 *   - 第八部分：before() 钩子（5 个测试）
 *   - 第八部分补充：P2-2 修复验证测试（2 个测试）
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实 DomainExpert.parse 构造测试数据
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖所有错误分支和边界条件
 *   - injectedClient 仅替换 LLM 调用入口，不是 mock（真实接口契约）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainExpertReviewPlugin, _internals } from "../domain-expert-review-plugin.js";
import { DomainExpertRegistry } from "../domain-expert-registry.js";
import { DomainExpertMatcher } from "../domain-expert-matcher.js";
import type { DomainExpertMatchResult } from "../types.js";
// 测试夹具：从共享 utils 文件导入构造函数，避免重复定义
import { buildExpert, makeCtx, makeTask, makeTeamConfig } from "./utils/domain-expert-fixtures.js";

// ============================================================================
// 第六部分：DomainExpertReviewPlugin 构造与 meta（5 个测试）
// ============================================================================

test("DomainExpertReviewPlugin 构造成功", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const teamConfig = makeTeamConfig();
  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig);
  assert.ok(plugin);
});

test("meta.name 为 'domain-expert-review'", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  assert.equal(plugin.name, "domain-expert-review");
});

test("meta.priority 为 50", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  assert.equal(plugin.priority, 50);
});

test("meta.mutexWith 包含 'architect-review' 和 'test-expert-review'（P1-NEW-3）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  assert.ok(plugin.mutexWith.includes("architect-review"));
  assert.ok(plugin.mutexWith.includes("test-expert-review"));
});

test("meta.requiresTask 为 true", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  assert.equal(plugin.requiresTask, true);
});

// ============================================================================
// 第七部分：matches() 条件分支（8 个测试）
// ============================================================================

test("matches：enableDomainExperts=false 时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig({ enableDomainExperts: false })
  );
  const ctx = makeCtx({ currentPhase: 2 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：enabledCategories 为空时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig({ enabledCategories: [] })
  );
  const ctx = makeCtx({ currentPhase: 2 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase !== 2 && !== 8 时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 3 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase=1 时返回 false（非阶段 2/8）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 1 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase 未设置（undefined）时返回 false（向后兼容）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: undefined });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase=2 时返回 true（架构设计阶段）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 2 });
  assert.equal(plugin.matches(ctx), true);
});

test("matches：currentPhase=8 时返回 true（发布评审阶段）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 8 });
  assert.equal(plugin.matches(ctx), true);
});

test("matches：任务无业务信号（title/description/domainTags 全空）时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({ title: "", description: "", domainTags: [] }),
  });
  assert.equal(plugin.matches(ctx), false);
});

// ============================================================================
// 第八部分：before() 钩子（5 个测试）
// ============================================================================

test("before：调用 matcher.matchExperts 并将结果存入 ctx.state", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-1", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates);
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].expert.expertId, "domain-test-1");
});

test("before：无候选专家时 state 存空数组并记录 WARNING 日志", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.deepEqual([...candidates], []);
  // 验证 WARNING 日志已记录
  const warningEvents = ctx.events.filter(
    (e) => e.type.includes("WARNING") || (e.payload as { level?: string }).level === "WARNING"
  );
  assert.ok(warningEvents.length > 0);
});

test("before：候选专家时记录 INFO 日志（包含 top1 置信度）", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-2", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const infoEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string; message?: string };
    return payload.level === "INFO" && payload.message?.includes("top1");
  });
  assert.ok(infoEvents.length > 0);
});

test("before：从 teamConfig 读取匹配策略 / topK / 阈值", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-3", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const teamConfig = makeTeamConfig({
    domainExpertMatchStrategy: "keyword",
    domainExpertTopK: 1,
    domainExpertThreshold: 0.5,
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig);
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length <= 1, "topK=1 时最多返回 1 个候选");
});

test("before：phase=8 时也正常工作", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-4", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 8 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length > 0);
});

// ============================================================================
// 第八部分补充：P2-2 修复验证测试（matches 条件 4 简化）
// ============================================================================

test("matches：P2-2 修复验证 - domainTags 非空时返回 true（title/description 长度不检查）", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  // TaskRequirement schema 保证 title ≥3 字符 / description ≥10 字符，因此总是非空
  // P2-2 修复后：只检查 domainTags.length > 0，不检查 title/description
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "合法标题", // ≥3 字符
      description: "合法描述内容（≥10 字符）", // ≥10 字符
      domainTags: ["金融"], // 非空 domainTags
    }),
  });
  assert.equal(plugin.matches(ctx), true, "domainTags 非空时应返回 true（P2-2 修复后行为）");
});

test("matches：P2-2 修复验证 - domainTags 为空时返回 false（即使 title/description 非空）", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "合法标题",
      description: "合法描述内容（≥10 字符）",
      domainTags: [], // 空 domainTags
    }),
  });
  assert.equal(plugin.matches(ctx), false, "domainTags 为空时应返回 false（P2-2 修复后行为）");
});
