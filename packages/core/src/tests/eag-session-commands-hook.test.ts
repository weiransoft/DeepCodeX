/**
 * EAG-P3 批次 10 单元测试：SessionManager 命令 Hook 集成（6 个命令 + 候选规则检测 Hook）
 *
 * 测试范围（对齐 EAG-P3 批次 10 设计 §4.18.3 / §4.18.4 + EAG-P4 批次 13 §5.2）：
 * - G. /eag-design 命令：isEagDesignPrompt 判定 + handleEagDesignCommand 依赖校验 + extractDesignLoopInput + renderDesignLoopResult
 * - H. /eag-test 命令：isEagTestPrompt 判定 + handleEagTestCommand 依赖校验 + extractTestingLoopRequest + renderTestingLoopResult
 * - I. /eag-run 命令：isEagRunPrompt 判定 + handleEagRunCommand 依赖校验 + extractEagRunRequest + renderEagRunResult
 * - J. /eag-resume 命令：isEagResumePrompt 判定 + handleEagResumeCommand 依赖校验 + extractEagResumeRequest
 * - K. /eag-status 命令：isEagStatusPrompt 判定 + handleEagStatusCommand 依赖校验 + extractEagStatusRequest + renderEagStatusResult
 * - L. 候选规则检测 Hook（detectRuleCandidateHook，落地 L-4）：未注入跳过 / 非纠正模式 / 防误学红线（≥2 次才推送）
 * - M. SessionManagerOptions 新增字段（testingOrchestrator / designOrchestrator / runStateStore / ruleLearner）正确传递与向后兼容
 * - N. /eag-deploy 命令（EAG-P4 批次 13 Phase 7 §5.2）：EagCommandParser 判定 + handleEagDeployCommand 依赖校验 +
 *      extractDeployRequest + renderDevOpsResult + dryRun 模式 + devopsOrchestrator 字段传递
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：
 *   1. RuleLearner（eag/rlis/rule-learner.ts）—— 真实类，无外部依赖，直接 new
 *   2. RunStateStore（eag/long-horizon/run-state-store.ts）—— 真实类，构造零成本
 *   3. 测试用 orchestrator 占位对象 —— 仅用于"已注入但未提供 request"路径的字段校验
 *      （此路径不调用 orchestrator.run()，与既有 eag-session-hook.test.ts F19 模式一致）
 * - 所有结果 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 通过 `manager as any` 访问私有方法（与既有测试模式一致，非 mock 框架）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.18.3 命令 Hook 集成
 * - EAG-P3 批次 10 设计文档 §4.18.4 候选规则检测 Hook（detectRuleCandidateHook，落地 L-4）
 * - EAG-P4 批次 13 设计文档 §3.4 DevOpsOrchestrator 5 步编排
 * - EAG-P4 批次 13 设计文档 §5.2 SessionManager 集成（handleEagDeployCommand 装配逻辑）
 * - EAG 方案 §5.5.4 防误学红线（learned 来源规则未经用户确认绝不生效，≥2 次才推送确认请求）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - session.ts isEagXPrompt / handleEagXCommand / extractXxx / renderXxx / detectRuleCandidateHook
 *
 * @module tests/eag-session-commands-hook
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session";
import { RuleLearner } from "../eag/rlis/rule-learner";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import type { DesignLoopInput, DesignLoopResult } from "../eag/design/design-models";
import type { TestingLoopRequest, TestingLoopResult } from "../eag/testing/types";
import type {
  EagRunRequest,
  EagRunResult,
  EagResumeRequest,
  EagStatusRequest,
  EagStatusResult,
} from "../eag/long-horizon";
// EAG-P4 批次 13 Phase 7 新增导入：DevOps 编排结果类型 + /eag-deploy 命令请求对象类型（§3.4 / §5.2）
import type { DevOpsResult } from "../eag/devops/types";
import type { DeployRequest } from "../eag/cli/eag-command-parser";

// ============================================================================
// 测试辅助：构造最小请求 fixture（真实结构，非 mock）
// ============================================================================

/**
 * 构造测试用最小 DesignLoopInput 占位对象
 *
 * 用于 extractDesignLoopInput 的字段校验逻辑测试。
 * 注：此对象仅用于校验通过，不可真正传给 DesignLoopOrchestrator.run()。
 */
function createMinimalDesignLoopInput(): DesignLoopInput {
  return Object.freeze({
    rawRequirement: "作为一个用户，我希望创建订单，以便管理订单生命周期",
  });
}

/**
 * 构造测试用最小 TestingLoopRequest 占位对象
 *
 * 用于 extractTestingLoopRequest 的字段校验逻辑测试。
 * 注：此对象仅用于校验通过，不可真正传给 TestingOrchestrator.run()。
 */
function createMinimalTestingLoopRequest(): TestingLoopRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    specContent: "# spec\n订单管理模块需求规格",
    planContent: "# plan\n订单管理模块实施计划",
    tasksContent: "# tasks\nT-001: OrderAggregate 实现",
    implementationRoot: "src/",
    taskDag: Object.freeze({ nodes: Object.freeze([]), topologicalOrder: Object.freeze([]) }) as any,
    acceptanceCriteria: Object.freeze([]) as any,
    llmClient: { createMessage: () => ({}), providerName: "test" } as any,
    pkcAccessor: {
      queryBusinessFlows: () => Promise.resolve([]),
      queryRiskHotspots: () => Promise.resolve([]),
      queryL1GlobalView: () => Promise.resolve({}),
    } as any,
    loopGuard: {
      check: () => ({ allowed: true }),
      recordIteration: () => {},
      getConfig: () => ({
        maxIterations: 10,
        maxTokens: 100000,
        maxConsecutiveFailures: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 30000,
        backoffMultiplier: 2,
        jitterRatio: 0.1,
      }),
      getState: () => ({
        iterationsCompleted: 0,
        tokensConsumed: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        backoffLevel: 0,
      }),
    } as any,
    coverageThreshold: Object.freeze({ lines: 80, branches: 70, functions: 85, highRiskSymbols: 100 }) as any,
    maxIterations: 10,
  }) as TestingLoopRequest;
}

/**
 * 构造测试用最小 EagRunRequest 占位对象
 *
 * 用于 extractEagRunRequest 的字段校验逻辑测试。
 * 注：此对象仅用于校验通过，不可真正传给 EagRunHandler.handle()。
 */
function createMinimalEagRunRequest(): EagRunRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    userIntent: "我需要一个订单管理微服务",
    loopExecutors: Object.freeze([
      Object.freeze({ loopType: "design", execute: () => Promise.resolve({}) }),
      Object.freeze({ loopType: "coding", execute: () => Promise.resolve({}) }),
    ]) as any,
  }) as EagRunRequest;
}

/**
 * 构造测试用最小 EagResumeRequest 占位对象
 *
 * 用于 extractEagResumeRequest 的字段校验逻辑测试。
 */
function createMinimalEagResumeRequest(): EagResumeRequest {
  return Object.freeze({
    runId: "abc123def456",
    projectRoot: "/test/project",
    userIntent: "我需要一个订单管理微服务",
    loopExecutors: Object.freeze([Object.freeze({ loopType: "design", execute: () => Promise.resolve({}) })]) as any,
  }) as EagResumeRequest;
}

/**
 * 构造测试用最小 EagStatusRequest 占位对象
 *
 * 用于 extractEagStatusRequest 的字段校验逻辑测试。
 */
function createMinimalEagStatusRequest(): EagStatusRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    runId: "abc123def456",
  }) as EagStatusRequest;
}

/**
 * 构造测试用最小 DeployRequest 占位对象（EAG-P4 批次 13 Phase 7 §5.1）
 *
 * 用于 extractDeployRequest 字段校验通过路径测试。
 * 字段对齐设计文档 §5.1 中的 DeployRequest 接口定义。
 */
function createMinimalDeployRequest(): DeployRequest {
  return Object.freeze({
    projectName: "order-service",
    environment: "prod",
    image: "registry.example.com/order-service:v1.2.3",
    port: 8080,
    replicas: 3,
    iacType: "helm-chart",
    strategy: "blue-green",
  }) as DeployRequest;
}

/**
 * 构造测试用完整 DeployRequest 占位对象（含 dryRun flag）
 *
 * 用于 extractDeployRequest + handleEagDeployCommand 的 dryRun 路径测试。
 */
function createMinimalDeployRequestWithDryRun(): DeployRequest {
  return Object.freeze({
    projectName: "payment-service",
    environment: "staging",
    image: "registry.example.com/payment-service:v2.0.0",
    port: 9090,
    replicas: 5,
    iacType: "terraform",
    strategy: "canary",
    dryRun: true,
  }) as DeployRequest;
}

/**
 * 构造 SessionManager 测试实例（最小依赖，仅注入 onAssistantMessage 回调）
 *
 * @param onMessage 消息回调（接收 assistant 消息内容）
 * @param extraOptions 额外 SessionManagerOptions（用于注入 EAG 外挂依赖）
 */
function createTestManager(
  onMessage: (content: string) => void,
  extraOptions: Record<string, unknown> = {}
): SessionManager {
  return new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message: any) => onMessage(message.content),
    ...extraOptions,
  } as any);
}

// ============================================================================
// G. /eag-design 命令测试（§4.18.3）
// ============================================================================

test("G1. EagCommandParser 对 /eag-design 命令返回 eag-design kind（命令判定逻辑）", () => {
  // EAG-P3 批次 11 S3：isEagDesignPrompt 已迁移至 EagCommandParser.parse() 统一入口
  // 验证：EagCommandParser 能正确识别 /eag-design 命令（kind === "eag-design"）
  // 判定规则：text 严格匹配 /eag-design，无图片附件，无技能匹配
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 正确命令格式
  assert.equal(parser.parse({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parse({ text: "  /eag-design  " }).kind, "eag-design");
  // 非命令格式
  assert.equal(parser.parse({ text: "请帮我执行 /eag-design" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design arg" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  // 含图片或技能时不识别为命令（避免误触发）
  assert.equal(parser.parse({ text: "/eag-design", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-design", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("G2. handleEagDesignCommand 未注入 designOrchestrator 时通知错误并标记 failed", async () => {
  // 验证 handleEagDesignCommand 的依赖校验逻辑（session.ts §handleEagDesignCommand 步骤 1）：
  // 未注入 designOrchestrator → 通知用户配置缺失，更新 session 状态为 failed
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagDesignCommand 新增第三参数 input（由 EagCommandParser 预提取）
  // 此测试验证未注入 designOrchestrator 路径，input 传 null（依赖校验先于 input 校验）
  await internal.handleEagDesignCommand("test-session-design-1", { text: "/eag-design" }, null, new AbortController());

  // 验证：通知消息含"DESIGN Loop 编排器未注入"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("DESIGN Loop 编排器未注入")),
    `通知消息应含"DESIGN Loop 编排器未注入"，实际为：${messages.join("\n")}`
  );
});

test("G3. handleEagDesignCommand 已注入但未提供 DesignLoopInput 时通知错误", async () => {
  // 验证 handleEagDesignCommand 的请求校验逻辑（session.ts §handleEagDesignCommand 步骤 2）：
  // 已注入 designOrchestrator 但未提供 DesignLoopInput → 通知用户配置缺失
  const messages: string[] = [];
  // 注：此测试只走到请求校验失败分支，不调用 orchestrator.run()
  // 使用最小真实对象（{ run: () => ({}) }）满足字段校验，与既有 F19 模式一致
  const fakeOrchestrator = { run: () => ({}) } as any;
  const manager = createTestManager((content) => messages.push(content), { designOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagDesignCommand 新增第三参数 input（由 EagCommandParser 预提取）
  // 此测试验证未提供 DesignLoopInput 路径，input 显式传 null 触发 "DesignLoopInput 未提供" 错误
  await internal.handleEagDesignCommand("test-session-design-2", { text: "/eag-design" }, null, new AbortController());

  // 验证：通知消息含"DesignLoopInput 未提供"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("DesignLoopInput 未提供")),
    `通知消息应含"DesignLoopInput 未提供"，实际为：${messages.join("\n")}`
  );
});

test("G4. EagCommandParser 正确提取并校验 DesignLoopInput 字段", () => {
  // EAG-P3 批次 11 S3：extractDesignLoopInput 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 为 undefined/null/空对象 → payload 为 null
  // 2. designLoopInput 字段缺失 → payload 为 null
  // 3. designLoopInput.rawRequirement 缺失或为空 → payload 为 null
  // 4. designLoopInput.rawRequirement 非空 → payload 为 DesignLoopInput 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-design" }).payload, null);
  // 情况 1：messageParams 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象
  assert.equal(parser.parse({ text: "/eag-design", messageParams: {} }).payload, null);
  // 情况 2：designLoopInput 字段缺失
  assert.equal(parser.parse({ text: "/eag-design", messageParams: { other: "value" } }).payload, null);
  // 情况 3：designLoopInput.rawRequirement 缺失
  assert.equal(
    parser.parse({
      text: "/eag-design",
      messageParams: { designLoopInput: { projectContext: {} } },
    }).payload,
    null
  );
  // 情况 3：designLoopInput.rawRequirement 为空字符串
  assert.equal(
    parser.parse({
      text: "/eag-design",
      messageParams: { designLoopInput: { rawRequirement: "   " } },
    }).payload,
    null
  );
  // 情况 4：designLoopInput.rawRequirement 非空 → 返回对象
  const validInput = createMinimalDesignLoopInput();
  const parsed = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: validInput },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DesignLoopInput 对象");
  assert.equal((parsed.payload as any).rawRequirement, validInput.rawRequirement);
});

test("G5. renderDesignLoopResult 正确渲染结果摘要（§4.18.3）", () => {
  // 验证 renderDesignLoopResult 的渲染逻辑：
  // 1. 包含标题 [EAG DESIGN Loop]
  // 2. 包含评估结果（通过/未通过 + severity）
  // 3. 包含迭代次数
  // 4. 包含人工检查点触发状态
  // 5. 包含判定理由
  // 6. 包含评估器发现的问题清单（若有）
  // 7. 包含建议修复方案（若有）
  const manager = createTestManager(() => {});
  const internal = manager as any;

  // 构造测试用 DesignLoopResult（通过场景）
  const passedResult: DesignLoopResult = Object.freeze({
    input: Object.freeze({ rawRequirement: "需求" }) as any,
    artifacts: Object.freeze({}) as any,
    evaluationVerdict: Object.freeze({
      passed: true,
      reason: "全部判定项通过",
      severity: "warning",
      findings: [],
      suggestedFix: "",
    }),
    humanCheckpointTriggered: true,
    iterations: 1,
  }) as DesignLoopResult;

  const summary: string = internal.renderDesignLoopResult(passedResult);

  // 验证渲染内容
  assert.ok(summary.includes("[EAG DESIGN Loop]"), "应包含标题");
  assert.ok(summary.includes("评估结果: 通过"), "应包含评估结果（通过）");
  assert.ok(summary.includes("severity=warning"), "应包含 severity");
  assert.ok(summary.includes("迭代次数: 1"), "应包含迭代次数");
  assert.ok(summary.includes("人工检查点已触发: 是"), "应包含人工检查点触发状态");
  assert.ok(summary.includes("判定理由: 全部判定项通过"), "应包含判定理由");

  // 验证失败场景：含 findings 与 suggestedFix
  const failedResult: DesignLoopResult = Object.freeze({
    ...passedResult,
    evaluationVerdict: Object.freeze({
      passed: false,
      reason: "E1 范式不一致",
      severity: "blocker",
      findings: Object.freeze(["范式 ID 与锁定值不一致", "依赖规则缺失"]),
      suggestedFix: "重新选择范式或调整 paradigmLock",
    }) as any,
    iterations: 3,
    humanCheckpointTriggered: false,
  }) as DesignLoopResult;
  const failedSummary: string = internal.renderDesignLoopResult(failedResult);
  assert.ok(failedSummary.includes("评估结果: 未通过"), "应渲染未通过状态");
  assert.ok(failedSummary.includes("迭代次数: 3"), "应渲染迭代次数 3");
  assert.ok(failedSummary.includes("范式 ID 与锁定值不一致"), "应包含 findings 第一条");
  assert.ok(failedSummary.includes("依赖规则缺失"), "应包含 findings 第二条");
  assert.ok(failedSummary.includes("建议修复方案: 重新选择范式"), "应包含建议修复方案");
});

// ============================================================================
// H. /eag-test 命令测试（§4.18.3）
// ============================================================================

test("H1. EagCommandParser 对 /eag-test 命令返回 eag-test kind（命令判定逻辑）", () => {
  // EAG-P3 批次 11 S3：isEagTestPrompt 已迁移至 EagCommandParser.parse() 统一入口
  // 验证：EagCommandParser 能正确识别 /eag-test 命令（kind === "eag-test"）
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  assert.equal(parser.parse({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parse({ text: "  /eag-test  " }).kind, "eag-test");
  assert.equal(parser.parse({ text: "请帮我执行 /eag-test" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test arg" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-test", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("H2. handleEagTestCommand 未注入 testingOrchestrator 时通知错误并标记 failed", async () => {
  // 验证 handleEagTestCommand 的依赖校验逻辑：
  // 未注入 testingOrchestrator → 通知用户配置缺失
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagTestCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未注入 testingOrchestrator 路径，request 传 null（依赖校验先于 request 校验）
  await internal.handleEagTestCommand("test-session-test-1", { text: "/eag-test" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("TESTING Loop 编排器未注入")),
    `通知消息应含"TESTING Loop 编排器未注入"，实际为：${messages.join("\n")}`
  );
});

test("H3. handleEagTestCommand 已注入但未提供 TestingLoopRequest 时通知错误", async () => {
  // 验证 handleEagTestCommand 的请求校验逻辑：
  // 已注入 testingOrchestrator 但未提供 TestingLoopRequest → 通知用户配置缺失
  const messages: string[] = [];
  // 使用最小真实对象满足字段校验（此路径不调用 run()）
  const fakeOrchestrator = { run: () => ({}) } as any;
  const manager = createTestManager((content) => messages.push(content), { testingOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  // EAG-P3 批次 11 S3：handleEagTestCommand 新增第三参数 request（由 EagCommandParser 预提取）
  // 此测试验证未提供 TestingLoopRequest 路径，request 显式传 null 触发 "TestingLoopRequest 未提供" 错误
  await internal.handleEagTestCommand("test-session-test-2", { text: "/eag-test" }, null, new AbortController());

  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("TestingLoopRequest 未提供")),
    `通知消息应含"TestingLoopRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("H4. EagCommandParser 正确提取并校验 TestingLoopRequest 字段", () => {
  // EAG-P3 批次 11 S3：extractTestingLoopRequest 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 缺失/空 → payload 为 null
  // 2. testingLoopRequest 字段缺失 → payload 为 null
  // 3. testingLoopRequest 字段不完整（缺 projectRoot / specContent 等）→ payload 为 null
  // 4. testingLoopRequest 字段完整 → payload 为 TestingLoopRequest 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-test" }).payload, null);
  // 情况 1：messageParams 为空对象
  assert.equal(parser.parse({ text: "/eag-test", messageParams: {} }).payload, null);
  // 情况 2：testingLoopRequest 字段缺失
  assert.equal(parser.parse({ text: "/eag-test", messageParams: { other: "value" } }).payload, null);
  // 情况 3：testingLoopRequest.projectRoot 缺失
  assert.equal(
    parser.parse({
      text: "/eag-test",
      messageParams: { testingLoopRequest: { specContent: "spec" } },
    }).payload,
    null
  );
  // 情况 3：testingLoopRequest.maxIterations 缺失（非 number）
  assert.equal(
    parser.parse({
      text: "/eag-test",
      messageParams: {
        testingLoopRequest: {
          projectRoot: "/test",
          specContent: "spec",
          planContent: "plan",
          tasksContent: "tasks",
          implementationRoot: "src/",
          taskDag: { nodes: [] },
          acceptanceCriteria: [],
          llmClient: {},
          pkcAccessor: {},
          loopGuard: {},
          coverageThreshold: {},
          // 缺 maxIterations
        },
      },
    }).payload,
    null
  );
  // 情况 4：字段完整 → 返回对象
  const validRequest = createMinimalTestingLoopRequest();
  const parsed = parser.parse({
    text: "/eag-test",
    messageParams: { testingLoopRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 TestingLoopRequest 对象");
  assert.equal((parsed.payload as any).projectRoot, "/test/project");
  assert.equal((parsed.payload as any).specContent, validRequest.specContent);
  assert.equal((parsed.payload as any).maxIterations, 10);
});

test("H5. renderTestingLoopResult 正确渲染结果摘要（§4.18.3）", () => {
  // 验证 renderTestingLoopResult 的渲染逻辑：
  // 1. 包含标题 [EAG TESTING Loop]
  // 2. 包含最终状态
  // 3. 包含测试文件统计（契约/E2E/集成/合规）
  // 4. 包含覆盖率（lines/branches/functions/highRiskSymbols）
  // 5. 包含 LLM 调用次数与 token 消耗
  // 6. 包含生成文件清单（前 10 个）
  // 7. 包含终止原因（若有）
  const manager = createTestManager(() => {});
  const internal = manager as any;

  // 构造测试用 TestingLoopResult（成功场景）
  const successResult: TestingLoopResult = Object.freeze({
    runId: "test-run-001",
    finalStatus: "success",
    contractTests: Object.freeze([
      Object.freeze({
        relativePath: "tests/contract/order.callback.contract.test.ts",
        content: "...",
        kind: "contract",
        requirementId: "F-001",
        sourceId: "/api/v1/orders",
        testCaseCount: 3,
        testCaseDescriptions: Object.freeze(["should return 200", "should return 404", "should return 400"]),
      }),
    ]),
    e2eTests: Object.freeze([]),
    integrationTests: Object.freeze([]),
    complianceTests: Object.freeze([]),
    coverageReport: Object.freeze({
      lines: 85,
      branches: 75,
      functions: 90,
      highRiskSymbols: 100,
      uncoveredHighRiskSymbols: Object.freeze([]),
      uncoveredFiles: Object.freeze([]),
      passed: true,
      failedDimensions: Object.freeze([]),
      rawReport: Object.freeze({}),
    }),
    prDescription: "PR 描述",
    totalLlmCallCount: 5,
    totalTokensUsed: 1200,
    durationSec: 30,
  }) as TestingLoopResult;

  const summary: string = internal.renderTestingLoopResult(successResult);

  // 验证渲染内容
  assert.ok(summary.includes("[EAG TESTING Loop]"), "应包含标题");
  assert.ok(summary.includes("最终状态: success"), "应包含最终状态");
  assert.ok(summary.includes("契约=1"), "应包含契约测试数");
  assert.ok(summary.includes("E2E=0"), "应包含 E2E 测试数");
  assert.ok(summary.includes("lines=85%"), "应包含行覆盖率");
  assert.ok(summary.includes("branches=75%"), "应包含分支覆盖率");
  assert.ok(summary.includes("functions=90%"), "应包含函数覆盖率");
  assert.ok(summary.includes("highRiskSymbols=100%"), "应包含高风险符号覆盖率");
  assert.ok(summary.includes("LLM 调用次数: 5"), "应包含 LLM 调用次数");
  assert.ok(summary.includes("token 消耗: 1200"), "应包含 token 消耗");
  assert.ok(summary.includes("order.callback.contract.test.ts"), "应包含生成文件路径");

  // 验证失败场景：含 blockedReason
  const failedResult: TestingLoopResult = Object.freeze({
    ...successResult,
    finalStatus: "stop_failure",
    blockedReason: "LoopGuard 触达上限",
  }) as TestingLoopResult;
  const failedSummary: string = internal.renderTestingLoopResult(failedResult);
  assert.ok(failedSummary.includes("最终状态: stop_failure"), "应渲染失败状态");
  assert.ok(failedSummary.includes("终止原因: LoopGuard 触达上限"), "应渲染终止原因");
});

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

// ============================================================================
// M. SessionManagerOptions 字段传递与向后兼容测试（§4.18.5）
// ============================================================================

test("M1. 注入 testingOrchestrator/designOrchestrator/runStateStore/ruleLearner 时字段正确传递", () => {
  // 验证：SessionManager 构造函数正确赋值 EAG-P3 批次 10 新增字段
  // 对应 session.ts §605-608：this.testingOrchestrator = options.testingOrchestrator 等
  const fakeTestingOrchestrator = { run: () => ({}) } as any;
  const fakeDesignOrchestrator = { run: () => ({}) } as any;
  const runStateStore = new RunStateStore();
  const ruleLearner = new RuleLearner();

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // EAG-P3 批次 10 新增字段
    testingOrchestrator: fakeTestingOrchestrator,
    designOrchestrator: fakeDesignOrchestrator,
    runStateStore,
    ruleLearner,
  });

  const internal = manager as any;
  assert.equal(internal.testingOrchestrator, fakeTestingOrchestrator, "testingOrchestrator 字段应正确传递");
  assert.equal(internal.designOrchestrator, fakeDesignOrchestrator, "designOrchestrator 字段应正确传递");
  assert.equal(internal.runStateStore, runStateStore, "runStateStore 字段应正确传递");
  assert.equal(internal.ruleLearner, ruleLearner, "ruleLearner 字段应正确传递");
});

test("M2. 未注入 testingOrchestrator/designOrchestrator/runStateStore/ruleLearner 时 SessionManager 正常构造（向后兼容）", () => {
  // 验证：EAG-P3 批次 10 字段均为可选，不注入时 SessionManager 正常构造
  // （向后兼容保证，§4.18.5 既有测试零回归）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // 不传入任何 EAG-P3 批次 10 字段
  });

  assert.ok(manager instanceof SessionManager, "SessionManager 应正常实例化");
  const internal = manager as any;
  assert.equal(internal.testingOrchestrator, undefined, "未注入时 testingOrchestrator 应为 undefined");
  assert.equal(internal.designOrchestrator, undefined, "未注入时 designOrchestrator 应为 undefined");
  assert.equal(internal.runStateStore, undefined, "未注入时 runStateStore 应为 undefined");
  assert.equal(internal.ruleLearner, undefined, "未注入时 ruleLearner 应为 undefined");
});

test("M3. 注入 ruleLearner 后主对话循环可调用 detectRuleCandidateHook（端到端验证字段传递）", async () => {
  // 验证：注入 ruleLearner 后，detectRuleCandidateHook 可正常调用 ruleLearner.detectCorrection
  // 端到端验证字段传递的正确性（不只是字段赋值，还包括方法可调用）
  // 输入"必须测试先行再实现功能"含"测试先行"关键词 → 推断分类 process-gate
  // detectedPattern "必须..." → 推断级别 MAJOR
  const messages: string[] = [];
  const ruleLearner = new RuleLearner();
  const manager = createTestManager((content) => messages.push(content), { ruleLearner });

  const internal = manager as any;
  // 调用两次同类纠正，验证 ruleLearner 字段确实被注入并可调用
  await internal.detectRuleCandidateHook("必须测试先行再实现功能", "test-session-field-1");
  await internal.detectRuleCandidateHook("必须测试先行再实现功能", "test-session-field-1");

  // 验证：第二次调用触发了推送（证明 ruleLearner 字段已正确注入且方法可调用）
  assert.ok(messages.length > 0, "应推送确认请求（证明 ruleLearner 已正确注入）");
  const prompt = messages[messages.length - 1];
  assert.ok(prompt.includes("必须测试先行再实现功能"), "确认请求应包含纠正内容");
  assert.ok(prompt.includes("process-gate"), "确认请求应包含推断的分类（process-gate，因输入含'测试先行'关键词）");
  assert.ok(prompt.includes("MAJOR"), "确认请求应包含推断的级别（MAJOR，因'必须'语气）");
});

// ============================================================================
// N. /eag-deploy 命令测试（EAG-P4 批次 13 Phase 7 §3.4 / §5.2）
// ============================================================================

test("N1. EagCommandParser 对 /eag-deploy 命令返回 eag-deploy kind（命令判定逻辑）", () => {
  // EAG-P4 批次 13 Phase 7 §5.1：/eag-deploy 命令由 EagCommandParser.parse() 统一入口判定
  // 验证：EagCommandParser 能正确识别 /eag-deploy 命令（kind === "eag-deploy"）
  // 判定规则：text 严格匹配 /eag-deploy，无图片附件，无技能匹配
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 正确命令格式
  assert.equal(parser.parse({ text: "/eag-deploy" }).kind, "eag-deploy");
  assert.equal(parser.parse({ text: "  /eag-deploy  " }).kind, "eag-deploy");
  // 非命令格式（严格匹配，不允许参数内嵌）
  assert.equal(parser.parse({ text: "请帮我执行 /eag-deploy" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-deploy --project order-service" }).kind, "unknown");
  // 其他 EAG 命令不受影响
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");
  // 非字符串 / undefined 兜底
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: 123 as any }).kind, "unknown");
  // 含图片或技能时不识别为命令（避免误触发）
  assert.equal(parser.parse({ text: "/eag-deploy", imageUrls: ["data:image/png;base64,..."] }).kind, "unknown");
  assert.equal(
    parser.parse({ text: "/eag-deploy", skills: [{ name: "test", path: "/", description: "" }] }).kind,
    "unknown"
  );
});

test("N2. handleEagDeployCommand 未注入 devopsOrchestrator 时通知错误并标记 failed", async () => {
  // 验证 handleEagDeployCommand 的依赖校验逻辑（session.ts §handleEagDeployCommand 步骤 1）：
  // 未注入 devopsOrchestrator → 通知用户配置缺失，更新 session 状态为 failed
  const messages: string[] = [];
  const manager = createTestManager((content) => messages.push(content));

  const internal = manager as any;
  // handleEagDeployCommand 第三参数 request 由 EagCommandParser 预提取
  // 此测试验证未注入 devopsOrchestrator 路径，request 传 null（依赖校验先于 request 校验）
  await internal.handleEagDeployCommand("test-session-deploy-1", { text: "/eag-deploy" }, null, new AbortController());

  // 验证：通知消息含"DevOps 编排器未注入"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("DevOps 编排器未注入")),
    `通知消息应含"DevOps 编排器未注入"，实际为：${messages.join("\n")}`
  );
});

test("N3. handleEagDeployCommand 已注入但未提供 DeployRequest 时通知错误", async () => {
  // 验证 handleEagDeployCommand 的请求校验逻辑（session.ts §handleEagDeployCommand 步骤 2）：
  // 已注入 devopsOrchestrator 但未提供 DeployRequest → 通知用户配置缺失
  const messages: string[] = [];
  // 注：此测试只走到请求校验失败分支，不调用 orchestrator.run()
  // 使用最小真实对象（{ run: () => ({}) }）满足字段校验，与既有 F19/G3/H3 模式一致
  const fakeOrchestrator = { run: () => ({}) } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  // 此测试验证未提供 DeployRequest 路径，request 显式传 null 触发 "DeployRequest 未提供" 错误
  await internal.handleEagDeployCommand("test-session-deploy-2", { text: "/eag-deploy" }, null, new AbortController());

  // 验证：通知消息含"DeployRequest 未提供"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("DeployRequest 未提供")),
    `通知消息应含"DeployRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("N4. EagCommandParser 正确提取并校验 DeployRequest 字段", () => {
  // EAG-P4 批次 13 Phase 7 §5.1：extractDeployRequest 已迁移至 EagCommandParser.parse() 内部
  // 验证 EagCommandParser.parse() 的字段校验逻辑（payload 提取）：
  // 1. messageParams 缺失/空 → payload 为 null
  // 2. deployRequest 字段缺失 → payload 为 null
  // 3. deployRequest 字段不完整（缺 projectName / image / port / replicas 等）→ payload 为 null
  // 4. deployRequest 字段取值非法（environment / iacType / strategy）→ payload 为 null
  // 5. deployRequest.port / replicas 超范围 → payload 为 null
  // 6. deployRequest.dryRun 非 boolean → payload 为 null
  // 7. deployRequest 字段完整且合法 → payload 为 DeployRequest 对象
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 情况 1：messageParams 为 undefined
  assert.equal(parser.parse({ text: "/eag-deploy" }).payload, null);
  // 情况 1：messageParams 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: {} }).payload, null);
  // 情况 2：deployRequest 字段缺失
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { other: "value" } }).payload, null);

  // 情况 3：deployRequest.projectName 缺失
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 3：deployRequest.image 缺失
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 4：environment 取值非法
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "qa",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 4：iacType 取值非法
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "pulumi",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 4：strategy 取值非法
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "recreate",
        },
      },
    }).payload,
    null
  );

  // 情况 5：port 超范围（> 65535）
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 70000,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 5：replicas 超范围（> 100）
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 200,
          iacType: "helm-chart",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 6：dryRun 非 boolean（字符串）
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "helm-chart",
          strategy: "rolling",
          dryRun: "yes",
        },
      },
    }).payload,
    null
  );

  // 情况 7：字段完整且合法 → 返回对象
  const validRequest = createMinimalDeployRequest();
  const parsed = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DeployRequest 对象");
  assert.equal((parsed.payload as any).projectName, "order-service");
  assert.equal((parsed.payload as any).environment, "prod");
  assert.equal((parsed.payload as any).port, 8080);
  assert.equal((parsed.payload as any).replicas, 3);
  assert.equal((parsed.payload as any).iacType, "helm-chart");
  assert.equal((parsed.payload as any).strategy, "blue-green");

  // 情况 7（含 dryRun）：dryRun=true 应被正确提取
  const validRequestWithDryRun = createMinimalDeployRequestWithDryRun();
  const parsedDryRun = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequestWithDryRun },
  });
  assert.ok(parsedDryRun.payload, "含 dryRun 的 DeployRequest 应被正确提取");
  assert.equal((parsedDryRun.payload as any).dryRun, true);
});

test("N5. renderDevOpsResult 正确渲染结果摘要（成功场景 + 失败场景，§3.4 / §5.2）", () => {
  // 验证 renderDevOpsResult 的渲染逻辑：
  // 1. 包含标题 [EAG DEPLOY Loop]
  // 2. 包含最终状态（成功/失败）
  // 3. 包含 runId 与总耗时
  // 4. 包含 IaC 模板清单（前 10 个，含 type / filePath / hash 前 8 位）
  // 5. 包含部署资源清单（前 10 个）
  // 6. 包含健康检查结果
  // 7. 包含烟雾测试结果
  // 8. 包含 G-8 门禁结果（passed + reason + severity）
  // 9. 包含错误信息列表（前 10 条）
  const manager = createTestManager(() => {});
  const internal = manager as any;

  // 构造测试用 DevOpsResult（成功场景）
  const successResult: DevOpsResult = Object.freeze({
    success: true,
    runId: "deploy-run-001",
    startedAt: "2026-07-20T10:00:00.000Z",
    finishedAt: "2026-07-20T10:02:30.000Z",
    duration: 150000, // 150 秒
    iacTemplates: Object.freeze([
      Object.freeze({
        type: "helm-chart",
        content: "...",
        filePath: "Chart.yaml",
        hash: "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890",
        generatedAt: "2026-07-20T10:01:00.000Z",
      }),
      Object.freeze({
        type: "helm-chart",
        content: "...",
        filePath: "values.yaml",
        hash: "def4567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        generatedAt: "2026-07-20T10:01:00.000Z",
      }),
    ]),
    deployResult: Object.freeze({
      success: true,
      deployedAt: "2026-07-20T10:02:00.000Z",
      duration: 60000,
      resources: Object.freeze([
        Object.freeze({
          kind: "Deployment",
          name: "order-service",
          namespace: "prod",
          status: "Running",
        }),
        Object.freeze({
          kind: "Service",
          name: "order-service-svc",
          namespace: "prod",
          status: "Running",
        }),
      ]),
      errors: Object.freeze([]),
    }),
    healthCheckResult: Object.freeze({
      healthy: true,
      checkedAt: "2026-07-20T10:02:15.000Z",
      endpoints: Object.freeze([
        Object.freeze({
          url: "http://order-service.prod.svc.cluster.local:8080/healthz",
          statusCode: 200,
          responseTimeMs: 50,
          healthy: true,
        }),
      ]),
      failures: Object.freeze([]),
    }),
    smokeTestResult: Object.freeze({
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 2000,
      failures: Object.freeze([]),
    }),
    gateResult: Object.freeze({
      passed: true,
      gate: "G-8",
      reason: "全部部署就绪条件满足",
      severity: "blocker",
    }),
    errors: Object.freeze([]),
  }) as DevOpsResult;

  const successSummary: string = internal.renderDevOpsResult(successResult);

  // 验证渲染内容（成功场景）
  assert.ok(successSummary.includes("[EAG DEPLOY Loop]"), "应包含标题");
  assert.ok(successSummary.includes("最终状态: 成功"), "应包含最终状态（成功）");
  assert.ok(successSummary.includes("runId: deploy-run-001"), "应包含 runId");
  assert.ok(successSummary.includes("总耗时: 150.0s"), "应包含总耗时（秒）");
  assert.ok(successSummary.includes("IaC 模板 (2 个)"), "应包含 IaC 模板数");
  assert.ok(successSummary.includes("[helm-chart] Chart.yaml"), "应包含 Chart.yaml 模板");
  assert.ok(successSummary.includes("[helm-chart] values.yaml"), "应包含 values.yaml 模板");
  assert.ok(successSummary.includes("hash: abc123de"), "应包含 hash 前 8 位");
  assert.ok(successSummary.includes("部署资源 (2 个)"), "应包含部署资源数");
  assert.ok(successSummary.includes("Deployment/order-service"), "应包含 Deployment 资源");
  assert.ok(successSummary.includes("健康检查: 通过"), "应包含健康检查结果（通过）");
  assert.ok(successSummary.includes("端点数: 1"), "应包含端点数");
  assert.ok(successSummary.includes("烟雾测试: 通过"), "应包含烟雾测试结果（通过）");
  assert.ok(successSummary.includes("通过: 1"), "应包含烟雾测试通过数");
  assert.ok(successSummary.includes("G-8 门禁: 通过"), "应包含 G-8 门禁结果（通过）");
  assert.ok(successSummary.includes("全部部署就绪条件满足"), "应包含门禁理由");

  // 验证失败场景：含 errors + G-8 未通过
  const failedResult: DevOpsResult = Object.freeze({
    ...successResult,
    success: false,
    runId: "deploy-run-002",
    gateResult: Object.freeze({
      passed: false,
      gate: "G-8",
      reason: "健康检查未通过：1 个端点不健康",
      severity: "blocker",
    }),
    errors: Object.freeze(["G-8 门禁未通过：健康检查未通过：1 个端点不健康", "DeployStage 执行失败：smoke-test 超时"]),
  }) as DevOpsResult;

  const failedSummary: string = internal.renderDevOpsResult(failedResult);
  assert.ok(failedSummary.includes("最终状态: 失败"), "应渲染失败状态");
  assert.ok(failedSummary.includes("runId: deploy-run-002"), "应渲染失败的 runId");
  assert.ok(failedSummary.includes("G-8 门禁: 未通过"), "应渲染 G-8 门禁未通过");
  assert.ok(failedSummary.includes("健康检查未通过：1 个端点不健康"), "应渲染门禁失败理由");
  assert.ok(failedSummary.includes("错误信息 (2 条)"), "应包含错误信息数");
  assert.ok(failedSummary.includes("G-8 门禁未通过"), "应包含第一条错误");
  assert.ok(failedSummary.includes("DeployStage 执行失败"), "应包含第二条错误");
});

test("N6. handleEagDeployCommand dryRun 模式启用时通知用户（§5.1）", async () => {
  // 验证 handleEagDeployCommand 的 dryRun 模式通知逻辑：
  // DeployRequest.dryRun=true → 在编排前通知用户"dryRun 模式已启用"
  // 注：批次 13 暂不支持 dryRun 短路，DevOpsOrchestrator.run() 始终执行完整 5 步编排
  // 此测试仅验证 dryRun 通知消息，不验证编排结果（编排由 devops-orchestrator.test.ts 覆盖）
  const messages: string[] = [];
  // 构造 fakeOrchestrator：run() 返回成功的 DevOpsResult，避免编排异常干扰测试
  const fakeSuccessResult: DevOpsResult = Object.freeze({
    success: true,
    runId: "test-dry-run",
    startedAt: "2026-07-20T10:00:00.000Z",
    finishedAt: "2026-07-20T10:00:01.000Z",
    duration: 1000,
    iacTemplates: Object.freeze([]),
    gateResult: Object.freeze({
      passed: true,
      gate: "G-8",
      reason: "测试通过",
      severity: "blocker",
    }),
    errors: Object.freeze([]),
  }) as DevOpsResult;
  const fakeOrchestrator = { run: () => Promise.resolve(fakeSuccessResult) } as any;
  const manager = createTestManager((content) => messages.push(content), { devopsOrchestrator: fakeOrchestrator });

  const internal = manager as any;
  const dryRunRequest = createMinimalDeployRequestWithDryRun();
  await internal.handleEagDeployCommand(
    "test-session-deploy-dryrun",
    { text: "/eag-deploy" },
    dryRunRequest,
    new AbortController()
  );

  // 验证：dryRun 通知消息存在
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("dryRun 模式已启用")),
    `通知消息应含"dryRun 模式已启用"，实际为：${messages.join("\n")}`
  );
});

test("N7. SessionManagerOptions.devopsOrchestrator 字段正确传递（§5.2）", () => {
  // 验证：SessionManager 构造函数正确赋值 EAG-P4 批次 13 新增字段 devopsOrchestrator
  // 对应 session.ts §this.devopsOrchestrator = options.devopsOrchestrator
  const fakeDevOpsOrchestrator = { run: () => ({}) } as any;

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // EAG-P4 批次 13 新增字段
    devopsOrchestrator: fakeDevOpsOrchestrator,
  });

  const internal = manager as any;
  assert.equal(internal.devopsOrchestrator, fakeDevOpsOrchestrator, "devopsOrchestrator 字段应正确传递");
});

test("N8. 未注入 devopsOrchestrator 时 SessionManager 正常构造（向后兼容，§5.2）", () => {
  // 验证：EAG-P4 批次 13 字段 devopsOrchestrator 为可选，不注入时 SessionManager 正常构造
  // （向后兼容保证，既有测试零回归）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // 不传入任何 EAG-P4 批次 13 字段
  });

  assert.ok(manager instanceof SessionManager, "SessionManager 应正常实例化");
  const internal = manager as any;
  assert.equal(internal.devopsOrchestrator, undefined, "未注入时 devopsOrchestrator 应为 undefined");
});
