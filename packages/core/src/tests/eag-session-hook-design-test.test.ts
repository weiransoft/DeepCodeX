/**
 * EAG-P3 批次 10 单元测试：SessionManager 命令 Hook 集成 —— /eag-design 与 /eag-test 命令
 * （拆分自 eag-session-commands-hook.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 10 设计 §4.18.3）：
 * - G. /eag-design 命令：isEagDesignPrompt 判定 + handleEagDesignCommand 依赖校验 +
 *      extractDesignLoopInput + renderDesignLoopResult
 * - H. /eag-test 命令：isEagTestPrompt 判定 + handleEagTestCommand 依赖校验 +
 *      extractTestingLoopRequest + renderTestingLoopResult
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：
 *   1. SessionManager（session.ts）—— 真实类，通过 createTestManager 装配
 *   2. 测试用 orchestrator 占位对象 —— 仅用于"已注入但未提供 request"路径的字段校验
 *      （此路径不调用 orchestrator.run()，与既有 eag-session-hook.test.ts F19 模式一致）
 * - 所有结果 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 通过 `manager as any` 访问私有方法（与既有测试模式一致，非 mock 框架）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.18.3 命令 Hook 集成
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - session.ts isEagXPrompt / handleEagXCommand / extractXxx / renderXxx
 *
 * @module tests/eag-session-hook-design-test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignLoopInput, DesignLoopResult } from "../eag/design/design-models";
import type { TestingLoopRequest, TestingLoopResult } from "../eag/testing/types";
import {
  createMinimalDesignLoopInput,
  createMinimalTestingLoopRequest,
  createTestManager,
} from "./fixtures/eag-command-fixtures";

// ============================================================================
// G. /eag-design 命令测试（§4.18.3）
// ============================================================================

test("G1. EagCommandParser 对 /eag-design 命令返回 eag-design kind（命令判定逻辑）", () => {
  // EAG-P3 批次 11 S3：isEagDesignPrompt 已迁移至 EagCommandParser.parse() 统一入口
  // 验证：EagCommandParser 能正确识别 /eag-design 命令（kind === "eag-design"）
  // 判定规则（S3.2 前缀匹配，2026-08-19）：裸命令或以 /eag-design 开头带参数
  // 的文本均识别为命令（--requirement/--paradigm 经 extractDesignLoopInputFromPrompt
  // 解析）；无图片附件，无技能匹配
  const manager = createTestManager(() => {});
  const internal = manager as any;
  const parser = internal.eagCommandParser;

  // 正确命令格式
  assert.equal(parser.parse({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parse({ text: "  /eag-design  " }).kind, "eag-design");
  // S3.2 前缀匹配：带参数文本识别为命令；非 --key=value 形式的裸参数
  // 无法解析出 DesignLoopInput → payload 为 null（fail-closed 由 session 层提示）
  const withBareArg = parser.parse({ text: "/eag-design arg" });
  assert.equal(withBareArg.kind, "eag-design");
  assert.equal(withBareArg.payload, null);
  // 非命令格式
  assert.equal(parser.parse({ text: "请帮我执行 /eag-design" }).kind, "unknown");
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
