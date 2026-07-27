/**
 * DomainExpertReviewPlugin 单元测试 - 拆分文件 1/5：常量 / Schema / Prompt 构建 / 响应解析
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 / §5.3 / §8.4（P1-NEW-1 / P1-NEW-3 / P1-NEW-4）
 * 本文件覆盖：
 *   - 第一部分：常量与配置（4 个测试）
 *   - 第二部分：ExpertReviewResponseSchema 校验（6 个测试）
 *   - 第三部分：buildExpertSystemPrompt（5 个测试）
 *   - 第四部分：buildExpertUserPrompt（6 个测试）
 *   - 第五部分：parseExpertResponse（8 个测试）
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实 DomainExpert.parse 构造测试数据
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖所有错误分支和边界条件
 *   - injectedClient 仅替换 LLM 调用入口，不是 mock（真实接口契约）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "../domain-expert-review-plugin.js";
import { ExpertInvocationError } from "../errors.js";
import type { DomainExpertMatchResult, TaskRequirement } from "../types.js";
// 测试夹具：从共享 utils 文件导入构造函数，避免重复定义
import { buildMatchResult, makeTask } from "./utils/domain-expert-fixtures.js";

// ============================================================================
// 第一部分：常量与配置（4 个测试）
// ============================================================================

test("DEFAULT_EXPERT_TIMEOUT_MS 常量值为 30000ms", () => {
  assert.equal(_internals.DEFAULT_EXPERT_TIMEOUT_MS, 30_000);
});

test("STATE_KEY_CANDIDATES 常量为 'domainExpertCandidates'", () => {
  assert.equal(_internals.STATE_KEY_CANDIDATES, "domainExpertCandidates");
});

test("STATE_KEY_DISPATCH_RESULT 常量为 'domainExpertDispatchResult'", () => {
  assert.equal(_internals.STATE_KEY_DISPATCH_RESULT, "domainExpertDispatchResult");
});

test("STATE_KEY_REVIEWS 常量为 'domainExpertReviews'", () => {
  assert.equal(_internals.STATE_KEY_REVIEWS, "domainExpertReviews");
});

// ============================================================================
// 第二部分：ExpertReviewResponseSchema 校验（6 个测试）
// ============================================================================

test("ExpertReviewResponseSchema：合法 JSON 通过校验", () => {
  const valid = {
    opinion: "这是一个合法的 review 意见，长度满足要求。",
    confidence: 0.8,
    keyPoints: ["观点 1"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(valid);
  assert.ok(result.success);
});

test("ExpertReviewResponseSchema：opinion < 10 字符校验失败", () => {
  const invalid = {
    opinion: "短",
    confidence: 0.8,
    keyPoints: [],
    risks: [],
    recommendations: [],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

test("ExpertReviewResponseSchema：confidence > 1 校验失败", () => {
  const invalid = {
    opinion: "合法长度意见内容。",
    confidence: 1.5,
    keyPoints: [],
    risks: [],
    recommendations: [],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

test("ExpertReviewResponseSchema：confidence < 0 校验失败", () => {
  const invalid = {
    opinion: "合法长度意见内容。",
    confidence: -0.1,
    keyPoints: [],
    risks: [],
    recommendations: [],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

test("ExpertReviewResponseSchema：keyPoints/risks/recommendations 缺失时使用默认空数组", () => {
  const minimal = {
    opinion: "合法长度意见内容测试。",
    confidence: 0.5,
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(minimal);
  assert.ok(result.success);
  assert.deepEqual(result.data?.keyPoints, []);
  assert.deepEqual(result.data?.risks, []);
  assert.deepEqual(result.data?.recommendations, []);
});

test("ExpertReviewResponseSchema：opinion 缺失校验失败", () => {
  const invalid = {
    confidence: 0.5,
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

// ============================================================================
// 第三部分：buildExpertSystemPrompt（5 个测试）
// ============================================================================

test("buildExpertSystemPrompt：包含 expert.systemPromptPrefix 内容", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "你是测试专家，遵循 Karpathy 原则。",
    systemPromptSuffix: "",
  });
  assert.ok(prompt.includes("你是测试专家，遵循 Karpathy 原则。"));
});

test("buildExpertSystemPrompt：包含 expert.systemPromptSuffix 内容", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "后置约束内容",
  });
  assert.ok(prompt.includes("后置约束内容"));
});

test("buildExpertSystemPrompt：systemPromptSuffix 为空时不包含 SUFFIX CONSTRAINTS 段", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "",
  });
  assert.ok(!prompt.includes("SUFFIX CONSTRAINTS"));
});

test("buildExpertSystemPrompt：包含 JSON 输出格式说明", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "",
  });
  assert.ok(prompt.includes("OUTPUT FORMAT"));
  assert.ok(prompt.includes("opinion"));
  assert.ok(prompt.includes("confidence"));
  assert.ok(prompt.includes("keyPoints"));
  assert.ok(prompt.includes("risks"));
  assert.ok(prompt.includes("recommendations"));
});

test("buildExpertSystemPrompt：包含严格规则说明", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "",
  });
  assert.ok(prompt.includes("严格规则"));
  assert.ok(prompt.includes("只输出 JSON"));
});

// ============================================================================
// 第四部分：buildExpertUserPrompt（6 个测试）
// ============================================================================

test("buildExpertUserPrompt：包含任务标题", () => {
  const task = makeTask({ title: "测试任务标题 ABC" });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("测试任务标题 ABC"));
});

test("buildExpertUserPrompt：包含任务描述", () => {
  const task = makeTask({ description: "测试任务描述 XYZ" });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("测试任务描述 XYZ"));
});

test("buildExpertUserPrompt：domainTags 非空时包含业务标签段", () => {
  const task = makeTask({ domainTags: ["金融", "风控"] });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("业务标签"));
  assert.ok(prompt.includes("金融、风控"));
});

test("buildExpertUserPrompt：domainTags 为空时不包含业务标签段", () => {
  const task = makeTask({ domainTags: [] });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(!prompt.includes("业务标签"));
});

test("buildExpertUserPrompt：constraints 非空时包含约束条件段", () => {
  const task = makeTask({ constraints: ["约束 1", "约束 2"] });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("约束条件"));
  assert.ok(prompt.includes("- 约束 1"));
  assert.ok(prompt.includes("- 约束 2"));
});

test("buildExpertUserPrompt：包含 review 请求段", () => {
  const task = makeTask();
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("review 请求"));
  assert.ok(prompt.includes("业务合理性"));
  assert.ok(prompt.includes("潜在风险"));
  assert.ok(prompt.includes("改进建议"));
});

// ============================================================================
// 第五部分：parseExpertResponse（8 个测试）
// ============================================================================

test("parseExpertResponse：合法 JSON 返回 ExpertOpinion", () => {
  const content = JSON.stringify({
    opinion: "这是一个合法的 review 意见，长度满足要求。",
    confidence: 0.85,
    keyPoints: ["关键观点 1"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
  });
  const opinion = _internals.parseExpertResponse(content, buildMatchResult());
  assert.equal(opinion.expertId, "domain-test-expert");
  assert.equal(opinion.expertName, "测试专家");
  assert.equal(opinion.confidence, 0.85);
  assert.deepEqual(opinion.keyPoints, ["关键观点 1"]);
});

test("parseExpertResponse：content 为 null 抛 ExpertInvocationError（phase=empty）", () => {
  assert.throws(
    () => _internals.parseExpertResponse(null, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).expertId, "domain-test-expert");
      assert.equal((err as ExpertInvocationError).phase, "empty");
      return true;
    }
  );
});

test("parseExpertResponse：content 为空字符串抛 ExpertInvocationError（phase=empty）", () => {
  assert.throws(
    () => _internals.parseExpertResponse("   ", buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "empty");
      return true;
    }
  );
});

test("parseExpertResponse：非法 JSON 抛 ExpertInvocationError（phase=parse）", () => {
  assert.throws(
    () => _internals.parseExpertResponse("not a json", buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      assert.ok((err as Error).message.includes("JSON 解析失败"));
      return true;
    }
  );
});

test("parseExpertResponse：JSON 缺少 opinion 字段抛 ExpertInvocationError（phase=parse）", () => {
  const content = JSON.stringify({ confidence: 0.5 });
  assert.throws(
    () => _internals.parseExpertResponse(content, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      assert.ok((err as Error).message.includes("schema 校验失败"));
      return true;
    }
  );
});

test("parseExpertResponse：opinion < 10 字符抛 ExpertInvocationError（phase=parse）", () => {
  const content = JSON.stringify({
    opinion: "短",
    confidence: 0.5,
  });
  assert.throws(
    () => _internals.parseExpertResponse(content, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      return true;
    }
  );
});

test("parseExpertResponse：confidence > 1 抛 ExpertInvocationError（phase=parse）", () => {
  const content = JSON.stringify({
    opinion: "合法长度意见。",
    confidence: 1.5,
  });
  assert.throws(
    () => _internals.parseExpertResponse(content, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      return true;
    }
  );
});

test("parseExpertResponse：缺失 keyPoints 时使用默认空数组", () => {
  const content = JSON.stringify({
    opinion: "合法长度意见内容测试。",
    confidence: 0.5,
  });
  const opinion = _internals.parseExpertResponse(content, buildMatchResult());
  assert.deepEqual(opinion.keyPoints, []);
  assert.deepEqual(opinion.risks, []);
  assert.deepEqual(opinion.recommendations, []);
});
