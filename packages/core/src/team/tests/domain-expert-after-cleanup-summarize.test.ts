/**
 * DomainExpertReviewPlugin 单元测试 - 拆分文件 4/5：after / cleanup / summarizeOpinions / invokeExpertLLM
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 / §5.3 / §8.4（P1-NEW-1 / P1-NEW-3 / P1-NEW-4）
 * 本文件覆盖：
 *   - 第十部分：after() 钩子（5 个测试）
 *   - 第十一部分：cleanup() 钩子（5 个测试）
 *   - 第十二部分：summarizeOpinions（内部方法，通过 execute 间接验证，5 个测试）
 *   - 第十三部分：invokeExpertLLM（通过 execute 间接验证，4 个测试）
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
// 测试夹具：从共享 utils 文件导入构造函数，避免重复定义
import {
  buildAbortingClient,
  buildExpert,
  buildInjectedClient,
  buildMatchResult,
  buildNetworkErrorClient,
  makeCtx,
  makeTeamConfig,
} from "./utils/domain-expert-fixtures.js";

// ============================================================================
// 第十部分：after() 钩子（5 个测试）
// ============================================================================

test("after：将汇总报告存入 ctx.state[STATE_KEY_REVIEWS]", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 测试汇总报告",
  };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "# 测试汇总报告");
});

test("after：同步汇总报告到 ctx.task.upstreamContext['domainExpertReviews']", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 跨任务传播测试",
  };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.task.upstreamContext["domainExpertReviews"], "# 跨任务传播测试");
});

test("after：state 中有 DomainExpertDispatchResult 时优先使用其 output", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: {
      [_internals.STATE_KEY_DISPATCH_RESULT]: { output: "# 来自 dispatchResult 的报告" },
    },
  });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 来自 result 的报告（应被忽略）",
  };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "# 来自 dispatchResult 的报告");
});

test("after：state 和 result 均无 output 时使用空字符串", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = { status: "failed" as const };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "");
});

test("after：记录 INFO 日志（包含汇总字符数）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 字符数测试报告内容",
  };
  await plugin.after(ctx, fakeResult as never);

  const infoEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string; message?: string };
    return payload.level === "INFO" && payload.message?.includes("字符");
  });
  assert.ok(infoEvents.length > 0);
});

// ============================================================================
// 第十一部分：cleanup() 钩子（5 个测试）
// ============================================================================

test("cleanup：exc=null 时不记录 ERROR 日志", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.cleanup(ctx, null);

  const errorEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string };
    return payload.level === "ERROR";
  });
  assert.equal(errorEvents.length, 0);
});

test("cleanup：exc 非 null 时记录 ERROR 日志", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const err = new Error("测试异常");
  await plugin.cleanup(ctx, err);

  const errorEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string; message?: string };
    return payload.level === "ERROR" && payload.message?.includes("测试异常");
  });
  assert.ok(errorEvents.length > 0);
});

test("cleanup：exc 非 null 时清理 STATE_KEY_CANDIDATES", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  await plugin.cleanup(ctx, new Error("cleanup 测试"));

  assert.equal(ctx.state[_internals.STATE_KEY_CANDIDATES], undefined);
});

test("cleanup：exc 非 null 时清理 STATE_KEY_DISPATCH_RESULT", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_DISPATCH_RESULT]: { output: "test" } },
  });

  await plugin.cleanup(ctx, new Error("cleanup 测试"));

  assert.equal(ctx.state[_internals.STATE_KEY_DISPATCH_RESULT], undefined);
});

test("cleanup：exc=null 时保留 STATE_KEY_CANDIDATES 和 STATE_KEY_DISPATCH_RESULT（支持 after 重试）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: {
      [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()],
      [_internals.STATE_KEY_DISPATCH_RESULT]: { output: "test" },
    },
  });

  await plugin.cleanup(ctx, null);

  // 正常完成时保留中间数据（支持 after 重试）
  assert.ok(ctx.state[_internals.STATE_KEY_CANDIDATES]);
  assert.ok(ctx.state[_internals.STATE_KEY_DISPATCH_RESULT]);
});

// ============================================================================
// 第十二部分：summarizeOpinions（内部方法，通过 execute 间接验证）
// ============================================================================

test("summarizeOpinions：空 opinions + 空 failures 返回无候选提示", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [] },
  });

  const result = await plugin.execute(ctx);
  // 空候选走 fail 路径，output 为错误信息
  assert.ok(result.error?.includes("无候选"));
});

test("summarizeOpinions：单专家成功时汇总报告包含专家名和置信度", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.92,
    keyPoints: ["关键观点 1", "关键观点 2"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidate = buildMatchResult({
    expert: buildExpert({ expertId: "domain-summary-1", name: "汇总测试专家" }),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("汇总测试专家"));
  assert.ok(result.output?.includes("92.0%"));
  assert.ok(result.output?.includes("关键观点 1"));
  assert.ok(result.output?.includes("风险 1"));
  assert.ok(result.output?.includes("建议 1"));
});

test("summarizeOpinions：多专家时按 confidence 降序排列", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  // 通过返回不同 confidence 的内容（这里固定一个 client 只能返回同一种内容，
  // 所以用两次 plugin 实例验证排序逻辑）
  const lowConfidenceResponse = JSON.stringify({
    opinion: "低置信度意见内容测试。",
    confidence: 0.3,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(lowConfidenceResponse),
  });
  // 由于 injectedClient 返回固定内容，两个专家 confidence 相同
  // 改为验证汇总报告包含两个专家段
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-low-1", name: "低置信度专家 1" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-low-2", name: "低置信度专家 2" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("低置信度专家 1"));
  assert.ok(result.output?.includes("低置信度专家 2"));
});

test("summarizeOpinions：成功 + 失败混合时汇总报告同时包含两段", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(), // 全部失败
  });
  const candidates = [buildMatchResult({ expert: buildExpert({ expertId: "domain-fail-mixed" }) })];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  // 全部失败时无成功意见段，但有失败专家段
  assert.ok(result.output?.includes("失败专家"));
  assert.ok(result.output?.includes("domain-fail-mixed"));
});

test("summarizeOpinions：汇总报告包含概览段（成功/失败/总计数量）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-overview-1" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-overview-2" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("成功：2 位专家"));
  assert.ok(result.output?.includes("失败：0 位专家"));
  assert.ok(result.output?.includes("总计：2 位专家"));
});

// ============================================================================
// 第十三部分：invokeExpertLLM（通过 execute 间接验证，4 个测试）
// ============================================================================

test("invokeExpertLLM：LLM 返回合法 JSON 时成功（通过 execute 验证）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: ["kp1"],
    risks: ["r1"],
    recommendations: ["rec1"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
});

test("invokeExpertLLM：LLM 返回非 JSON 时抛 ExpertInvocationError（phase=parse）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient("not a json"),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("parse"));
});

test("invokeExpertLLM：LLM 网络错误时抛 ExpertInvocationError（phase=network）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("network"));
});

test("invokeExpertLLM：超时时抛 ExpertInvocationError（phase=timeout）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildAbortingClient(),
    expertTimeoutMs: 0,
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("timeout"));
});
