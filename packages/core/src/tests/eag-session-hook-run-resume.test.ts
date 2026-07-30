/**
 * EAG-P3 批次 10 单元测试：SessionManager 命令 Hook 集成 —— /eag-run 与 /eag-resume 命令
 * （拆分自 eag-session-commands-hook.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 10 设计 §4.18.3）：
 * - I. /eag-run 命令：isEagRunPrompt 判定 + handleEagRunCommand 依赖校验 +
 *      extractEagRunRequest + renderEagRunResult
 * - J. /eag-resume 命令：isEagResumePrompt 判定 + handleEagResumeCommand 依赖校验 +
 *      extractEagResumeRequest
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：
 *   1. SessionManager（session.ts）—— 真实类，通过 createTestManager 装配
 *   2. RunStateStore（eag/long-horizon/run-state-store.ts）—— 真实类，构造零成本
 * - 所有结果 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 通过 `manager as any` 访问私有方法（与既有测试模式一致，非 mock 框架）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.18.3 命令 Hook 集成
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - session.ts isEagXPrompt / handleEagXCommand / extractXxx / renderXxx
 *
 * @module tests/eag-session-hook-run-resume
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import type { EagRunResult } from "../eag/long-horizon/index";
import {
  createMinimalEagRunRequest,
  createMinimalEagResumeRequest,
  createTestManager,
} from "./fixtures/eag-command-fixtures";

// ============================================================================
// I. /eag-run 命令测试（§4.18.3）
// ============================================================================

test("I1. EagCommandParser 对 /eag-run 命令返回 eag-run kind（命令判定逻辑）", () => {
  // EAG-P3 批次 11 S3：isEagRunPrompt 已迁移至 EagCommandParser.parse() 统一入口
  // 验证：EagCommandParser 能正确识别 /eag-run 命令（kind === "eag-run"）
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  assert.equal(parser.parse({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parse({ text: "  /eag-run  " }).kind, "eag-run");
  assert.equal(parser.parse({ text: "请帮我执行 /eag-run" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run arg" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-run", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("I2. handleEagRunCommand 未注入 runStateStore 时通知错误并标记 failed", async () => {
  // 验证 handleEagRunCommand 的依赖校验逻辑：
  // 未注入 runStateStore → 通知用户配置缺失
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagRunCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未注入 runStateStore 路径，request 传 null（依赖校验先于 request 校验）
  await internal.handleEagRunCommand("test-session-run-1", { text: "/eag-run" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("RunStateStore 未注入")),
    `通知消息应含"RunStateStore 未注入"，实际为：${messages.join("\n")}`
  );
});

test("I3. handleEagRunCommand 已注入但未提供 EagRunRequest 时通知错误", async () => {
  // 验证 handleEagRunCommand 的请求校验逻辑：
  // 已注入 runStateStore 但未提供 EagRunRequest → 通知用户配置缺失
  const messages: string[] = [];
  // 使用真实 RunStateStore（构造零成本，无外部依赖）
  const runStateStore = new RunStateStore();
  const manager = createTestManager((content) => messages.push(content), { runStateStore });

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagRunCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未提供 EagRunRequest 路径，request 显式传 null 触发 "EagRunRequest 未提供" 错误
  await internal.handleEagRunCommand("test-session-run-2", { text: "/eag-run" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("EagRunRequest 未提供")),
    `通知消息应含"EagRunRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("I4. EagCommandParser 正确提取并校验 EagRunRequest 字段", () => {
  // EAG-P3 批次 11 S3：extractEagRunRequest 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 缺失/空 → payload 为 null
  // 2. eagRunRequest 字段缺失 → payload 为 null
  // 3. eagRunRequest 字段不完整（缺 projectRoot / userIntent / loopExecutors）→ payload 为 null
  // 4. eagRunRequest.loopExecutors 为空数组 → payload 为 null
  // 5. 字段完整 → payload 为 EagRunRequest 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-run" }).payload, null);
  // 情况 1：messageParams 为空对象
  assert.equal(parser.parse({ text: "/eag-run", messageParams: {} }).payload, null);
  // 情况 2：eagRunRequest 字段缺失
  assert.equal(parser.parse({ text: "/eag-run", messageParams: { other: "value" } }).payload, null);
  // 情况 3：projectRoot 缺失
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { userIntent: "意图", loopExecutors: [{}] } },
    }).payload,
    null
  );
  // 情况 3：userIntent 缺失
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { projectRoot: "/test", loopExecutors: [{}] } },
    }).payload,
    null
  );
  // 情况 4：loopExecutors 为空数组
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { projectRoot: "/test", userIntent: "意图", loopExecutors: [] } },
    }).payload,
    null
  );
  // 情况 5：字段完整 → 返回对象
  const validRequest = createMinimalEagRunRequest();
  const parsed = parser.parse({
    text: "/eag-run",
    messageParams: { eagRunRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 EagRunRequest 对象");
  assert.equal((parsed.payload as any).projectRoot, "/test/project");
  assert.equal((parsed.payload as any).userIntent, "我需要一个订单管理微服务");
  assert.equal((parsed.payload as any).loopExecutors.length, 2);
});

test("I5. renderEagRunResult 正确渲染结果摘要（§4.18.3）", () => {
  // 验证 renderEagRunResult 的渲染逻辑：
  // 1. 包含标题 [EAG RUN]
  // 2. 包含 runId
  // 3. 包含最终状态
  // 4. 包含完成的 Loop 列表
  // 5. 包含里程碑数
  // 6. 包含 LLM 调用次数与 token 消耗
  // 7. 包含里程碑列表（前 5 个）
  // 8. 包含阻塞分析摘要（若有）
  const manager = createTestManager(() => {});
  const internal = manager as any;

  // 构造测试用 EagRunResult（完成场景）
  const completedResult: EagRunResult = Object.freeze({
    runId: "abc123def456",
    finalStatus: "completed",
    completedLoops: Object.freeze(["design", "coding"]) as any,
    milestones: Object.freeze([
      Object.freeze({
        index: 1,
        name: "DESIGN Loop 完成",
        loopType: "design",
        completedAt: "2026-07-19T10:00:00.000Z",
        tagName: "eag/abc123def456/m1",
        commitSha: "abc123",
        healthScore: 0.95,
      }),
    ]) as any,
    finalRunState: Object.freeze({}) as any,
    finalReport: "# EAG Run 最终报告\n全部 Loop 已完成",
    totalLlmCallCount: 28,
    totalTokensUsed: 64200,
    durationSec: 3600,
  }) as EagRunResult;

  const summary: string = internal.renderEagRunResult(completedResult);

  // 验证渲染内容
  assert.ok(summary.includes("[EAG RUN]"), "应包含标题");
  assert.ok(summary.includes("runId: abc123def456"), "应包含 runId");
  assert.ok(summary.includes("最终状态: completed"), "应包含最终状态");
  assert.ok(summary.includes("design, coding"), "应包含完成的 Loop 列表");
  assert.ok(summary.includes("里程碑数: 1"), "应包含里程碑数");
  assert.ok(summary.includes("LLM 调用次数: 28"), "应包含 LLM 调用次数");
  assert.ok(summary.includes("token 消耗: 64200"), "应包含 token 消耗");
  assert.ok(summary.includes("eag/abc123def456/m1"), "应包含里程碑 tag 名");

  // 验证失败场景：含 blockageReport
  const failedResult: EagRunResult = Object.freeze({
    ...completedResult,
    finalStatus: "failed",
    blockageReport: Object.freeze({
      runId: "abc123def456",
      generatedAt: "2026-07-19T11:00:00.000Z",
      blockedLoop: "coding",
      blockedIteration: 5,
      rootCauseHypotheses: Object.freeze([
        Object.freeze({
          hypothesisId: "rc-001",
          description: "评估器规则过严",
          confidence: 0.8,
          evidence: Object.freeze(["E7 红线连续 3 次 violated"]),
          source: "rule-based",
        }),
      ]) as any,
      suggestedSolutions: Object.freeze([]) as any,
      requiredDecisions: Object.freeze([
        Object.freeze({
          decisionId: "dec-001",
          description: "是否放宽 E7 评估器规则",
          options: Object.freeze(["放宽", "保持"]) as any,
        }),
      ]) as any,
      relatedInterventions: Object.freeze([]) as any,
    }) as any,
  }) as EagRunResult;
  const failedSummary: string = internal.renderEagRunResult(failedResult);
  assert.ok(failedSummary.includes("最终状态: failed"), "应渲染失败状态");
  assert.ok(failedSummary.includes("阻塞分析:"), "应包含阻塞分析标题");
  assert.ok(failedSummary.includes("根因假设数: 1"), "应包含根因假设数");
  assert.ok(failedSummary.includes("待决策数: 1"), "应包含待决策数");
});

// ============================================================================
// J. /eag-resume 命令测试（§4.18.3）
// ============================================================================

test("J1. EagCommandParser 对 /eag-resume 命令返回 eag-resume kind（命令判定逻辑）", () => {
  // EAG-P3 批次 11 S3：isEagResumePrompt 已迁移至 EagCommandParser.parse() 统一入口
  // 验证：EagCommandParser 能正确识别 /eag-resume 命令（kind === "eag-resume"）
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  assert.equal(parser.parse({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "  /eag-resume  " }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "请帮我执行 /eag-resume" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume arg" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-resume", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("J2. handleEagResumeCommand 未注入 runStateStore 时通知错误并标记 failed", async () => {
  // 验证 handleEagResumeCommand 的依赖校验逻辑：
  // 未注入 runStateStore → 通知用户配置缺失
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagResumeCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未注入 runStateStore 路径，request 传 null（依赖校验先于 request 校验）
  await internal.handleEagResumeCommand("test-session-resume-1", { text: "/eag-resume" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("RunStateStore 未注入")),
    `通知消息应含"RunStateStore 未注入"，实际为：${messages.join("\n")}`
  );
});

test("J3. handleEagResumeCommand 已注入但未提供 EagResumeRequest 时通知错误", async () => {
  // 验证 handleEagResumeCommand 的请求校验逻辑：
  // 已注入 runStateStore 但未提供 EagResumeRequest → 通知用户配置缺失
  const messages: string[] = [];
  const runStateStore = new RunStateStore();
  const manager = createTestManager((content) => messages.push(content), { runStateStore });

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagResumeCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未提供 EagResumeRequest 路径，request 显式传 null 触发 "EagResumeRequest 未提供" 错误
  await internal.handleEagResumeCommand("test-session-resume-2", { text: "/eag-resume" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("EagResumeRequest 未提供")),
    `通知消息应含"EagResumeRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("J4. EagCommandParser 正确提取并校验 EagResumeRequest 字段", () => {
  // EAG-P3 批次 11 S3：extractEagResumeRequest 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 缺失/空 → payload 为 null
  // 2. eagResumeRequest 字段缺失 → payload 为 null
  // 3. eagResumeRequest.runId 缺失或为空 → payload 为 null
  // 4. eagResumeRequest.projectRoot 缺失 → payload 为 null
  // 5. eagResumeRequest.userIntent 缺失 → payload 为 null
  // 6. eagResumeRequest.loopExecutors 为空数组 → payload 为 null
  // 7. 字段完整 → payload 为 EagResumeRequest 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-resume" }).payload, null);
  // 情况 2：eagResumeRequest 字段缺失
  assert.equal(parser.parse({ text: "/eag-resume", messageParams: { other: "value" } }).payload, null);
  // 情况 3：runId 缺失
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { projectRoot: "/test", userIntent: "意图", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 3：runId 为空字符串
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "   ", projectRoot: "/test", userIntent: "意图", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 4：projectRoot 缺失
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "abc123", userIntent: "意图", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 5：userIntent 缺失
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "abc123", projectRoot: "/test", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 6：loopExecutors 为空数组
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "abc123", projectRoot: "/test", userIntent: "意图", loopExecutors: [] },
      },
    }).payload,
    null
  );
  // 情况 7：字段完整 → 返回对象
  const validRequest = createMinimalEagResumeRequest();
  const parsed = parser.parse({
    text: "/eag-resume",
    messageParams: { eagResumeRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 EagResumeRequest 对象");
  assert.equal((parsed.payload as any).runId, "abc123def456");
  assert.equal((parsed.payload as any).projectRoot, "/test/project");
  assert.equal((parsed.payload as any).userIntent, "我需要一个订单管理微服务");
});
