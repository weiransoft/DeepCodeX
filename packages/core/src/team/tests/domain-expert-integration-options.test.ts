/**
 * DomainExpertReviewPlugin 单元测试 - 拆分文件 5/5：集成流程 / Options / 综合场景
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 / §5.3 / §8.4（P1-NEW-1 / P1-NEW-3 / P1-NEW-4）
 * 本文件覆盖：
 *   - 第十四部分：集成流程（before → execute → after 完整链路，5 个测试）
 *   - 第十五部分：DomainExpertReviewPluginOptions 选项（3 个测试）
 *   - 第十六部分：综合场景（5 个测试）
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
import {
  buildAbortingClient,
  buildExpert,
  buildInjectedClient,
  buildMatchResult,
  makeCtx,
  makeTask,
  makeTeamConfig,
} from "./utils/domain-expert-fixtures.js";
// v1.6 P0-2：环境隔离工具，确保测试运行时无 OPENAI_API_KEY 等环境变量干扰
import { isolateOpenAIEnv } from "./utils/env-isolation.js";

// ============================================================================
// 第十四部分：集成流程（before → execute → after 完整链路，5 个测试）
// ============================================================================

test("集成流程：before → execute → after 完整链路（单专家成功）", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-integration-1", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "集成测试 review 意见，验证完整链路。",
    confidence: 0.88,
    keyPoints: ["集成关键观点"],
    risks: ["集成风险"],
    recommendations: ["集成建议"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({ currentPhase: 2 });

  // 1. matches
  assert.equal(plugin.matches(ctx), true);

  // 2. before
  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length > 0);

  // 3. execute
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");

  // 4. after
  await plugin.after(ctx, result);
  assert.ok(ctx.state[_internals.STATE_KEY_REVIEWS]);
  assert.equal(ctx.task.upstreamContext["domainExpertReviews"], ctx.state[_internals.STATE_KEY_REVIEWS]);

  // 5. cleanup（正常完成）
  await plugin.cleanup(ctx, null);
});

test("集成流程：before → execute → after 完整链路（无候选专家）", async () => {
  const registry = new DomainExpertRegistry(); // 不注册任何专家
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.equal(candidates.length, 0);

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");

  await plugin.after(ctx, result);
  // 即使失败也应写入空字符串到 state（避免下游读取 undefined）
  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "");

  await plugin.cleanup(ctx, null);
});

test("集成流程：phase=8 时完整链路正常工作", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-phase-8", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "phase 8 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({ currentPhase: 8 });

  assert.equal(plugin.matches(ctx), true);
  await plugin.before(ctx);
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  await plugin.after(ctx, result);
  assert.ok(ctx.state[_internals.STATE_KEY_REVIEWS]);
});

test("集成流程：异常路径触发 cleanup 清理 state", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-cleanup-test", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);
  // 模拟异常：state 中已有候选，但执行时抛错
  assert.ok(ctx.state[_internals.STATE_KEY_CANDIDATES]);

  // 模拟 dispatcher 在异常后调用 cleanup
  await plugin.cleanup(ctx, new Error("模拟异常"));

  // 异常时清理中间数据
  assert.equal(ctx.state[_internals.STATE_KEY_CANDIDATES], undefined);
});

test("集成流程：多专家并行调用全部成功", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-multi-1", keywords: ["测试", "业务", "验证"], name: "专家甲" }));
  registry.register(buildExpert({ expertId: "domain-multi-2", keywords: ["测试", "业务", "验证"], name: "专家乙" }));
  registry.register(buildExpert({ expertId: "domain-multi-3", keywords: ["测试", "业务", "验证"], name: "专家丙" }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "多专家并行 review 意见。",
    confidence: 0.75,
    keyPoints: ["并行关键观点"],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length >= 2, "至少匹配到 2 个专家");

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // 汇总报告应包含所有匹配到的专家
  for (const c of candidates) {
    assert.ok(result.output?.includes(c.expert.name));
  }
});

// ============================================================================
// 第十五部分：DomainExpertReviewPluginOptions 选项（3 个测试）
// ============================================================================

test("DomainExpertReviewPluginOptions：未提供 options 时使用默认值", async () => {
  // v1.6 P0-2：隔离 OPENAI_API_KEY 等环境变量，确保测试可重复
  // 原因：开发机可能已设置 OPENAI_API_KEY，导致 createOpenAIClient 返回非 null client，
  //       测试期望 "no-client" 错误将无法触发
  const restore = isolateOpenAIEnv();
  try {
    const registry = new DomainExpertRegistry();
    const matcher = new DomainExpertMatcher(registry);
    const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
    const ctx = makeCtx({
      currentPhase: 2,
      state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
    });

    // 无 options 时 invokeExpertLLM 会调用 createOpenAIClient（无 API Key）→ 抛 ExpertInvocationError
    const result = await plugin.execute(ctx);
    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("no-client"));
  } finally {
    restore();
  }
});

test("DomainExpertReviewPluginOptions：expertTimeoutMs 覆盖默认超时", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildAbortingClient(),
    expertTimeoutMs: 0, // 立即 abort
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("timeout"));
});

test("DomainExpertReviewPluginOptions：projectRoot 用于读取 .env", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    projectRoot: "/nonexistent-path",
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  // projectRoot 不存在时 createOpenAIClient 会读取默认 settings，最终可能无 API Key
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
});

// ============================================================================
// 第十六部分：综合场景（5 个测试）
// ============================================================================

test("综合场景：金融任务匹配金融专家并完成 review", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-finance-strategist",
      name: "金融战略专家",
      category: "strategy",
      keywords: ["金融", "风控", "合规"],
      domainTags: ["金融", "风控"],
    })
  );
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "金融任务 review 意见：建议加强风控措施。",
    confidence: 0.9,
    keyPoints: ["风控缺失"],
    risks: ["合规风险"],
    recommendations: ["增加风控审批环节"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "金融风控系统设计",
      description: "设计一套金融风控系统，包含实时反欺诈和贷后管理。",
      domainTags: ["金融", "风控"],
    }),
  });

  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates[0].expert.expertId === "domain-finance-strategist");

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("金融战略专家"));
  assert.ok(result.output?.includes("风控缺失"));
});

test("综合场景：医疗任务匹配医疗专家并完成 review", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-medical-expert",
      name: "医疗合规专家",
      category: "specialized",
      keywords: ["医疗", "合规", "数据"],
      domainTags: ["医疗", "合规"],
    })
  );
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "医疗任务 review 意见：需符合 HIPAA 合规要求。",
    confidence: 0.85,
    keyPoints: ["HIPAA 合规"],
    risks: ["数据泄露风险"],
    recommendations: ["加密患者数据"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 8,
    task: makeTask({
      title: "医疗数据平台建设",
      description: "构建医疗数据平台，需满足合规要求。",
      domainTags: ["医疗"],
    }),
  });

  await plugin.before(ctx);
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("医疗合规专家"));
});

test("综合场景：空 domainTags 任务不触发 review（P2-2 修复后行为）", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-text-match",
      name: "文本匹配专家",
      keywords: ["测试", "业务", "验证"],
      domainTags: ["测试"],
    })
  );
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "基于文本匹配的 review 意见。",
    confidence: 0.6,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "测试业务验证流程",
      description: "验证测试业务的完整性和正确性。",
      domainTags: [], // 空 domainTags
    }),
  });

  // P2-2 修复后：空 domainTags 任务不再触发 review（matches 返回 false）
  assert.equal(plugin.matches(ctx), false, "空 domainTags 任务不应触发 review（P2-2 修复后行为）");
  // before 不应被调用（matches=false 时 dispatcher 不触发 before）
  // 因此 candidates 应为 undefined（state 未设置）
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult> | undefined;
  assert.equal(candidates, undefined, "matches=false 时 before 不应被调用，state 中无候选");
});

test("综合场景：phase=8 触发时汇总报告写入 upstreamContext 供下游消费", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-upstream-test", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "upstream 传播测试意见。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 8,
    task: makeTask({ domainTags: ["测试"] }),
  });

  await plugin.before(ctx);
  const result = await plugin.execute(ctx);
  await plugin.after(ctx, result);

  // upstreamContext 中的 domainExpertReviews 可被下游阶段读取
  const upstreamReviews = ctx.task.upstreamContext["domainExpertReviews"];
  assert.equal(typeof upstreamReviews, "string");
  assert.ok((upstreamReviews as string).includes("领域专家 review 汇总"));
});

test("综合场景：插件 meta 完整性校验", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  // 验证 V3 契约 meta 字段完整性
  assert.equal(plugin.meta.name, "domain-expert-review");
  assert.equal(plugin.meta.priority, 50);
  assert.ok(plugin.meta.description.length > 0);
  assert.ok(plugin.meta.mutexWith.length === 2);
  assert.equal(plugin.meta.requiresTask, true);
  assert.deepEqual([...plugin.meta.mutexWith].sort(), ["architect-review", "test-expert-review"].sort());
});
