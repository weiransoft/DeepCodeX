/**
 * EAG-P3 批次 10 单元测试：SessionManager 命令 Hook 集成 —— /eag-status 命令与候选规则检测 Hook
 * （拆分自 eag-session-commands-hook.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 10 设计 §4.18.3 / §4.18.4）：
 * - K. /eag-status 命令：isEagStatusPrompt 判定 + handleEagStatusCommand 依赖校验 +
 *      extractEagStatusRequest + renderEagStatusResult
 * - L. 候选规则检测 Hook（detectRuleCandidateHook，落地 L-4）：未注入跳过 / 非纠正模式 /
 *      防误学红线（≥2 次才推送）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：
 *   1. SessionManager（session.ts）—— 真实类，通过 createTestManager 装配
 *   2. RunStateStore（eag/long-horizon/run-state-store.ts）—— 真实类，构造零成本
 *   3. RuleLearner（eag/rlis/rule-learner.ts）—— 真实类，无外部依赖，直接 new
 * - 所有结果 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 通过 `manager as any` 访问私有方法（与既有测试模式一致，非 mock 框架）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.18.3 命令 Hook 集成
 * - EAG-P3 批次 10 设计文档 §4.18.4 候选规则检测 Hook（detectRuleCandidateHook，落地 L-4）
 * - EAG 方案 §5.5.4 防误学红线（learned 来源规则未经用户确认绝不生效，≥2 次才推送确认请求）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - session.ts isEagXPrompt / handleEagXCommand / extractXxx / renderXxx / detectRuleCandidateHook
 *
 * @module tests/eag-session-hook-status-rule
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleLearner } from "../eag/rlis/rule-learner";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import type { EagStatusResult } from "../eag/long-horizon";
import { createMinimalEagStatusRequest, createTestManager } from "./fixtures/eag-command-fixtures";

// ============================================================================
// K. /eag-status 命令测试（§4.18.3）
// ============================================================================

test("K1. EagCommandParser 对 /eag-status 命令返回 eag-status kind（命令判定逻辑）", () => {
  // EAG-P3 批次 11 S3：isEagStatusPrompt 已迁移至 EagCommandParser.parse() 统一入口
  // 验证：EagCommandParser 能正确识别 /eag-status 命令（kind === "eag-status"）
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");
  assert.equal(parser.parse({ text: "  /eag-status  " }).kind, "eag-status");
  assert.equal(parser.parse({ text: "请帮我执行 /eag-status" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status arg" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-status", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("K2. handleEagStatusCommand 未注入 runStateStore 时通知错误并标记 failed", async () => {
  // 验证 handleEagStatusCommand 的依赖校验逻辑：
  // 未注入 runStateStore → 通知用户配置缺失
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagStatusCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未注入 runStateStore 路径，request 传 null（依赖校验先于 request 校验）
  await internal.handleEagStatusCommand("test-session-status-1", { text: "/eag-status" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("RunStateStore 未注入")),
    `通知消息应含"RunStateStore 未注入"，实际为：${messages.join("\n")}`
  );
});

test("K3. handleEagStatusCommand 已注入但未提供 EagStatusRequest 时通知错误", async () => {
  // 验证 handleEagStatusCommand 的请求校验逻辑：
  // 已注入 runStateStore 但未提供 EagStatusRequest → 通知用户配置缺失
  const messages: string[] = [];
  const runStateStore = new RunStateStore();
  const manager = createTestManager((content) => messages.push(content), { runStateStore });

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagStatusCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未提供 EagStatusRequest 路径，request 显式传 null 触发 "EagStatusRequest 未提供" 错误
  await internal.handleEagStatusCommand("test-session-status-2", { text: "/eag-status" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("EagStatusRequest 未提供")),
    `通知消息应含"EagStatusRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("K4. EagCommandParser 正确提取并校验 EagStatusRequest 字段", () => {
  // EAG-P3 批次 11 S3：extractEagStatusRequest 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 缺失/空 → payload 为 null
  // 2. eagStatusRequest 字段缺失 → payload 为 null
  // 3. eagStatusRequest.projectRoot 缺失或为空 → payload 为 null
  // 4. 字段完整（含 runId）→ payload 为 EagStatusRequest 对象
  // 5. 字段完整（含 recentCount 而非 runId）→ payload 为 EagStatusRequest 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-status" }).payload, null);
  // 情况 2：eagStatusRequest 字段缺失
  assert.equal(parser.parse({ text: "/eag-status", messageParams: { other: "value" } }).payload, null);
  // 情况 3：projectRoot 缺失
  assert.equal(
    parser.parse({
      text: "/eag-status",
      messageParams: { eagStatusRequest: { runId: "abc123" } },
    }).payload,
    null
  );
  // 情况 3：projectRoot 为空字符串
  assert.equal(
    parser.parse({
      text: "/eag-status",
      messageParams: { eagStatusRequest: { projectRoot: "   ", runId: "abc123" } },
    }).payload,
    null
  );
  // 情况 4：字段完整（含 runId）
  const validRequest1 = createMinimalEagStatusRequest();
  const parsed1 = parser.parse({
    text: "/eag-status",
    messageParams: { eagStatusRequest: validRequest1 },
  });
  assert.ok(parsed1.payload, "字段完整时应返回 EagStatusRequest 对象");
  assert.equal((parsed1.payload as any).projectRoot, "/test/project");
  assert.equal((parsed1.payload as any).runId, "abc123def456");
  // 情况 5：字段完整（含 recentCount 而非 runId）
  const parsed2 = parser.parse({
    text: "/eag-status",
    messageParams: {
      eagStatusRequest: { projectRoot: "/test/project", recentCount: 5 },
    },
  });
  assert.ok(parsed2.payload, "仅含 recentCount 时也应返回对象");
  assert.equal((parsed2.payload as any).projectRoot, "/test/project");
  assert.equal((parsed2.payload as any).recentCount, 5);
});

test("K5. renderEagStatusResult 正确渲染结果摘要（§4.18.3）", () => {
  // 验证 renderEagStatusResult 的渲染逻辑：
  // 1. 包含标题 [EAG STATUS]
  // 2. 单 run 详情：包含 runId / 状态 / 当前 Loop / 里程碑数 / 人工介入记录数
  // 3. 最近 run 列表：包含 runId 与 status
  // 4. 完整 Markdown 报告（截断到 2000 字符）
  const manager = createTestManager(() => {});
  const internal = manager as any;

  // 构造测试用 EagStatusResult（含单 run 详情）
  const resultWithRunState: EagStatusResult = Object.freeze({
    report: "# EAG Status 报告\n## runId: abc123def456\n状态: running",
    runState: Object.freeze({
      runId: "abc123def456",
      projectRoot: "/test/project",
      startedAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T11:00:00.000Z",
      currentLoop: "coding",
      currentIteration: 3,
      completedLoops: Object.freeze(["design"]) as any,
      completedTaskIds: Object.freeze(["T-001", "T-002"]) as any,
      pendingDeleteFiles: Object.freeze([]) as any,
      milestones: Object.freeze([
        Object.freeze({
          index: 1,
          name: "DESIGN Loop 完成",
          loopType: "design",
          completedAt: "2026-07-19T10:30:00.000Z",
          tagName: "eag/abc123def456/m1",
          commitSha: "abc123",
          healthScore: 0.95,
        }),
      ]) as any,
      humanInterventions: Object.freeze([
        Object.freeze({
          intervenedAt: "2026-07-19T10:45:00.000Z",
          loopType: "coding",
          reason: "G-3 偏离检测",
          decision: "调整任务卡声明",
          resolved: true,
        }),
      ]) as any,
      humanInterventionCount: 1,
      totalLlmCallCount: 15,
      totalTokensUsed: 32000,
      status: "running",
      checksum: "sha256:abcdef",
    }) as any,
  }) as EagStatusResult;

  const summary: string = internal.renderEagStatusResult(resultWithRunState);

  // 验证渲染内容
  assert.ok(summary.includes("[EAG STATUS]"), "应包含标题");
  assert.ok(summary.includes("runId: abc123def456"), "应包含 runId");
  assert.ok(summary.includes("状态: running"), "应包含运行状态");
  assert.ok(summary.includes("当前 Loop: coding"), "应包含当前 Loop");
  assert.ok(summary.includes("里程碑数: 1"), "应包含里程碑数");
  assert.ok(summary.includes("人工介入记录数: 1"), "应包含人工介入记录数");
  assert.ok(summary.includes("完整报告:"), "应包含完整报告标题");
  assert.ok(summary.includes("EAG Status 报告"), "应包含报告内容");

  // 验证最近 run 列表场景
  const resultWithRecentRuns: EagStatusResult = Object.freeze({
    report: "# 最近 5 次 run",
    recentRuns: Object.freeze([
      Object.freeze({ runId: "run-001", status: "completed", progress: 100 }) as any,
      Object.freeze({ runId: "run-002", status: "running", progress: 60 }) as any,
    ]) as any,
  }) as EagStatusResult;
  const recentSummary: string = internal.renderEagStatusResult(resultWithRecentRuns);
  assert.ok(recentSummary.includes("最近 2 次 run:"), "应包含最近 run 列表标题");
  assert.ok(recentSummary.includes("run-001: completed"), "应包含 run-001 摘要");
  assert.ok(recentSummary.includes("run-002: running"), "应包含 run-002 摘要");

  // 验证长报告截断场景（>2000 字符）
  const longReport = "x".repeat(2500);
  const resultWithLongReport: EagStatusResult = Object.freeze({
    report: longReport,
  }) as EagStatusResult;
  const longSummary: string = internal.renderEagStatusResult(resultWithLongReport);
  assert.ok(longSummary.includes("..."), "长报告应包含省略标记");
  assert.ok(longSummary.includes("字符已省略"), "长报告应包含截断提示");
});

// ============================================================================
// L. 候选规则检测 Hook 测试（§4.18.4 detectRuleCandidateHook，落地 L-4）
// ============================================================================

test("L1. detectRuleCandidateHook 未注入 ruleLearner 时跳过（向后兼容，零开销）", async () => {
  // 验证：未注入 ruleLearner 时 detectRuleCandidateHook 直接返回，不发送任何消息
  // 对应 session.ts §detectRuleCandidateHook 步骤 1：if (!this.ruleLearner) return;
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));
  // 不注入 ruleLearner

  const internal = manager as any;
  // 输入含纠正模式关键词，但未注入 ruleLearner，应跳过
  await internal.detectRuleCandidateHook("不要使用 mock 开发", "test-session-hook-1");

  // 验证：未发送任何消息
  assert.equal(messages.length, 0, "未注入 ruleLearner 时不应发送任何消息");
});

test("L2. detectRuleCandidateHook 非纠正模式不触发候选检测", async () => {
  // 验证：用户输入非纠正模式时，detectCorrection 返回 null，Hook 直接返回
  // 纠正模式仅匹配 5 种前缀：不要/严禁/必须/以后都/禁止
  const messages: string[] = [];
  // 使用真实 RuleLearner（无外部依赖，直接 new）
  const ruleLearner = new RuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 非纠正模式（普通对话内容）
  await internal.detectRuleCandidateHook("请帮我创建一个订单聚合根", "test-session-hook-2");

  // 验证：未发送任何消息（非纠正模式不触发候选检测）
  assert.equal(messages.length, 0, "非纠正模式不应触发候选检测");
});

test("L3. detectRuleCandidateHook 单次纠正不推送确认（防误学红线，≥2 次才推送）", async () => {
  // 验证 EAG 方案 §5.5.4 防误学红线：
  // 「单次纠正默认只生成候选，同类纠正出现 ≥2 次才主动推送确认请求」
  // 对应 session.ts §detectRuleCandidateHook 步骤 4：if (!shouldPushConfirmation) return;
  const messages: string[] = [];
  const ruleLearner = new RuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 首次纠正（occurrenceCount=1，未达阈值 2）
  await internal.detectRuleCandidateHook("不要使用 mock 开发", "test-session-hook-3");

  // 验证：首次纠正不推送确认请求
  assert.equal(messages.length, 0, "首次纠正不应推送确认请求（防误学红线，≥2 次才推送）");

  // 验证 RuleLearner 内部状态：已累积 1 个候选
  const candidates = ruleLearner.getCandidates();
  assert.equal(candidates.length, 1, "RuleLearner 应累积 1 个候选");
  assert.equal(candidates[0].occurrenceCount, 1, "候选 occurrenceCount 应为 1");
  assert.equal(candidates[0].content, "不要使用 mock 开发", "候选 content 应正确");
});

test("L4. detectRuleCandidateHook 同类纠正 ≥2 次时推送确认请求", async () => {
  // 验证 EAG 方案 §5.5.4 推送确认请求逻辑：
  // 同类纠正出现 ≥2 次时，shouldPushConfirmation 返回 true，Hook 推送确认请求
  // 对应 session.ts §detectRuleCandidateHook 步骤 5：推送确认请求
  const messages: string[] = [];
  const ruleLearner = new RuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 首次纠正（不推送）
  await internal.detectRuleCandidateHook("不要使用 mock 开发", "test-session-hook-4");
  // 第二次同类纠正（应推送确认请求）
  await internal.detectRuleCandidateHook("不要使用 mock 开发", "test-session-hook-4");

  // 验证：第二次纠正后推送确认请求
  assert.ok(messages.length > 0, "第二次同类纠正应推送确认请求");
  const prompt = messages[messages.length - 1];
  assert.ok(prompt.includes("检测到可能的候选规则"), "确认请求应包含标题");
  assert.ok(prompt.includes("LEARN-01"), "确认请求应包含候选 ID");
  assert.ok(prompt.includes("不要使用 mock 开发"), "确认请求应包含候选内容");
  assert.ok(prompt.includes("/rule-confirm"), "确认请求应包含确认命令指引");
  assert.ok(prompt.includes("code-truth"), "确认请求应包含推断的分类");
  assert.ok(prompt.includes("WARNING"), "确认请求应包含推断的级别");

  // 验证 RuleLearner 内部状态：累积 1 个候选，occurrenceCount=2
  const candidates = ruleLearner.getCandidates();
  assert.equal(candidates.length, 1, "RuleLearner 应累积 1 个候选");
  assert.equal(candidates[0].occurrenceCount, 2, "候选 occurrenceCount 应为 2");
});

test("L5. detectRuleCandidateHook 不同类纠正分别累积（不互相影响）", async () => {
  // 验证：不同内容的纠正分别累积，各自独立计数
  // 对应 RuleLearner.accumulateCandidate 的"按 content 文本匹配"逻辑
  const messages: string[] = [];
  const ruleLearner = new RuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 纠正 1（首次）
  await internal.detectRuleCandidateHook("不要使用 mock 开发", "test-session-hook-5");
  // 纠正 2（不同内容，首次）
  await internal.detectRuleCandidateHook("严禁简化实现", "test-session-hook-5");
  // 纠正 3（与纠正 2 同类，第二次）
  await internal.detectRuleCandidateHook("严禁简化实现", "test-session-hook-5");

  // 验证：仅纠正 3 触发推送（纠正 2 的第二次出现）
  // 纠正 1 occurrenceCount=1（未达阈值），纠正 2 occurrenceCount=2（达阈值，推送）
  const confirmMessages = messages.filter((m) => m.includes("检测到可能的候选规则"));
  assert.equal(confirmMessages.length, 1, "应仅推送 1 次确认请求（仅纠正 2 达到阈值）");
  assert.ok(confirmMessages[0].includes("严禁简化实现"), "确认请求应为纠正 2 的内容");

  // 验证 RuleLearner 内部状态：累积 2 个候选
  const candidates = ruleLearner.getCandidates();
  assert.equal(candidates.length, 2, "应累积 2 个不同内容的候选");
  // 找到 "不要使用 mock" 候选，occurrenceCount 应为 1
  const c1 = candidates.find((c) => c.content === "不要使用 mock 开发");
  assert.ok(c1, "应存在'不要使用 mock 开发'候选");
  assert.equal(c1!.occurrenceCount, 1, "候选 1 occurrenceCount 应为 1");
  // 找到 "严禁简化实现" 候选，occurrenceCount 应为 2
  const c2 = candidates.find((c) => c.content === "严禁简化实现");
  assert.ok(c2, "应存在'严禁简化实现'候选");
  assert.equal(c2!.occurrenceCount, 2, "候选 2 occurrenceCount 应为 2");
});

test("L6. detectRuleCandidateHook 异常时不影响主对话循环（仅通知异常）", async () => {
  // 验证 detectRuleCandidateHook 的异常降级行为（session.ts §detectRuleCandidateHook catch 块）：
  // 候选规则检测失败不阻塞主对话循环，仅通过 onAssistantMessage 通知异常
  // 使用一个会抛异常的 RuleLearner 子类替代（真实实现，非 mock 框架）
  class ThrowingRuleLearner extends RuleLearner {
    detectCorrection(_userInput: string): { pattern: string; content: string } | null {
      throw new Error("RuleLearner 内部异常（测试用）");
    }
  }
  const messages: string[] = [];
  const ruleLearner = new ThrowingRuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 调用 detectRuleCandidateHook，内部 detectCorrection 抛异常
  // 验证：异常被 catch，不向上抛出，仅通知异常
  await internal.detectRuleCandidateHook("不要使用 mock 开发", "test-session-hook-6");

  // 验证：发送了异常通知消息
  assert.ok(messages.length > 0, "异常时应发送通知消息");
  assert.ok(
    messages.some((m) => m.includes("[RLIS] 候选规则检测异常")),
    `通知消息应含"[RLIS] 候选规则检测异常"，实际为：${messages.join("\n")}`
  );
  assert.ok(
    messages.some((m) => m.includes("RuleLearner 内部异常")),
    `通知消息应含异常详情，实际为：${messages.join("\n")}`
  );
});
