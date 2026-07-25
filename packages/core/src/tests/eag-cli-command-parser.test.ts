/**
 * EAG-P3 批次 11 S3：EagCommandParser 单元测试
 *
 * 测试范围（对齐 EAG-P3 批次 11 §5 S3 改进方案 D-S3-1 ~ D-S3-8）：
 * - A. EagCommandParser 实例化与无状态特性
 * - B. EAG_COMMAND_STRINGS 常量与冻结语义
 * - C. parse() 统一入口（非字符串 / 图片附件 / 技能匹配 / 7 命令分发 / unknown 兜底）
 * - D. /eag-build 命令（parseEagBuildCommand + extractCodingLoopRequest）
 * - E. /eag-design 命令（parseEagDesignCommand + extractDesignLoopInput）
 * - F. /eag-test 命令（parseEagTestCommand + extractTestingLoopRequest）
 * - G. /eag-run 命令（parseEagRunCommand + extractEagRunRequest）
 * - H. /eag-resume 命令（parseEagResumeCommand + extractEagResumeRequest）
 * - I. /eag-status 命令（parseEagStatusCommand + extractEagStatusRequest）
 * - J. 不可变优先原则（readonly payload / frozen 常量 / 无实例字段）
 * - K. /eag-deploy 命令（parseEagDeployCommand + extractDeployRequest + extractDeployRequestFromPrompt）（EAG-P4 批次 13 Phase 7）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new EagCommandParser()，不通过 SessionManager 注入
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计文档 §5 S3 改进方案（决策清单 D-S3-1 ~ D-S3-8）
 * - EAG-P4 批次 13 Phase 7 §5.1（/eag-deploy 命令扩展）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - eag/cli/eag-command-parser.ts（EagCommandParser 类与 EAG_COMMAND_STRINGS 常量）
 *
 * @module tests/eag-cli-command-parser
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagCommandParser, EAG_COMMAND_STRINGS, extractDeployRequestFromPrompt } from "../eag/cli/eag-command-parser";
import type { EagCommand, DeployRequest } from "../eag/cli/eag-command-parser";
import type { UserPromptContent } from "../session";
import type { CodingLoopRequest } from "../eag/coding/types";
import type { DesignLoopInput } from "../eag/design/design-models";
import type { TestingLoopRequest } from "../eag/testing/types";
import type { EagRunRequest, EagResumeRequest, EagStatusRequest } from "../eag/long-horizon";

// ============================================================================
// 测试辅助：构造最小请求 fixture（真实结构，非 mock）
// ============================================================================

/**
 * 构造测试用最小 CodingLoopRequest 占位对象
 *
 * 用于 extractCodingLoopRequest 字段校验通过路径测试。
 * 注：此对象仅用于校验通过，不可真正传给 CodingOrchestrator.run()。
 */
function createMinimalCodingLoopRequest(): CodingLoopRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    specContent: "# spec\n订单管理模块需求规格",
    planContent: "# plan\n订单管理模块实施计划",
    tasksContent: "# tasks\nT-001: OrderAggregate 实现",
    taskDag: Object.freeze({
      nodes: Object.freeze([]),
      topologicalOrder: Object.freeze([]),
    }) as any,
    taskCards: Object.freeze([]) as any,
    techStack: Object.freeze(["TypeScript", "Node.js"]) as any,
    constitutionContent: "# CONSTITUTION\n项目红线声明",
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
    maxIterations: 10,
    maxFixRounds: 3,
  }) as CodingLoopRequest;
}

/**
 * 构造测试用最小 DesignLoopInput 占位对象
 *
 * 用于 extractDesignLoopInput 字段校验通过路径测试。
 */
function createMinimalDesignLoopInput(): DesignLoopInput {
  return Object.freeze({
    rawRequirement: "作为一个用户，我希望创建订单，以便管理订单生命周期",
  });
}

/**
 * 构造测试用最小 TestingLoopRequest 占位对象
 *
 * 用于 extractTestingLoopRequest 字段校验通过路径测试。
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
 * 用于 extractEagRunRequest 字段校验通过路径测试。
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
 * 用于 extractEagResumeRequest 字段校验通过路径测试。
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
 * 用于 extractEagStatusRequest 字段校验通过路径测试。
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
 * 用于 extractDeployRequest 与 extractDeployRequestFromPrompt 的 dryRun 路径测试。
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

// ============================================================================
// A. EagCommandParser 实例化与无状态特性测试
// ============================================================================

test("A1. EagCommandParser 实例化成功", () => {
  // 验证：EagCommandParser 可正常实例化（无构造参数，无外部依赖）
  const parser = new EagCommandParser();
  assert.ok(parser instanceof EagCommandParser, "应为 EagCommandParser 实例");
  // 验证 parse 与 parseEagXxxCommand 方法存在（7 个 EAG 命令 + parse）
  assert.equal(typeof parser.parse, "function", "parse 方法应存在");
  assert.equal(typeof parser.parseEagBuildCommand, "function", "parseEagBuildCommand 方法应存在");
  assert.equal(typeof parser.parseEagDesignCommand, "function", "parseEagDesignCommand 方法应存在");
  assert.equal(typeof parser.parseEagTestCommand, "function", "parseEagTestCommand 方法应存在");
  assert.equal(typeof parser.parseEagRunCommand, "function", "parseEagRunCommand 方法应存在");
  assert.equal(typeof parser.parseEagResumeCommand, "function", "parseEagResumeCommand 方法应存在");
  assert.equal(typeof parser.parseEagStatusCommand, "function", "parseEagStatusCommand 方法应存在");
  assert.equal(typeof parser.parseEagDeployCommand, "function", "parseEagDeployCommand 方法应存在");
});

test("A2. EagCommandParser 无状态（多次 parse 互不影响）", () => {
  // 验证：EagCommandParser 类无状态，连续多次 parse 不同输入互不影响
  // 此设计保证 parser 可作为单例被 SessionManager 复用（D-S3-4）
  const parser = new EagCommandParser();

  // 第一次解析 /eag-build
  const r1 = parser.parse({ text: "/eag-build" });
  assert.equal(r1.kind, "eag-build");

  // 第二次解析 /eag-design（不应受第一次影响）
  const r2 = parser.parse({ text: "/eag-design" });
  assert.equal(r2.kind, "eag-design");

  // 第三次解析非命令文本
  const r3 = parser.parse({ text: "请帮我实现一个订单系统" });
  assert.equal(r3.kind, "unknown");

  // 第四次解析 /eag-build（不应受中间解析影响）
  const r4 = parser.parse({ text: "/eag-build" });
  assert.equal(r4.kind, "eag-build");
});

// ============================================================================
// B. EAG_COMMAND_STRINGS 常量与冻结语义测试
// ============================================================================

test("B3. EAG_COMMAND_STRINGS 包含 18 个 EAG 命令字符串", () => {
  // 验证：EAG_COMMAND_STRINGS 常量包含 18 个 EAG 命令字符串（D-S3-6）
  // 注：EAG-P4 批次 13 Phase 7 新增 /eag-deploy 命令，命令总数从 6 扩展至 7
  // 注：EAG-P5 Phase 5.4 新增 /eag-autonomous 命令（无人值守 4 阶段循环），命令总数从 7 扩展至 8
  // 注：EAG-P5 Phase 5.5 新增 /eag-autonomous-status 与 /eag-autonomous-stop 命令
  //     （无人值守状态查询 + 中止/回滚），命令总数从 8 扩展至 10
  // 注：Loop-Graph 融合方案 Phase 5 新增 /eag-graph 命令（图编排入口），命令总数从 10 扩展至 11
  // 注：ADR-DI-001 §7.4.1 新增 7 个动态指令注入与后台子 Agent 命令
  //     （/inject /bg /tasks /fg /cancel /pause /resume），命令总数从 11 扩展至 18
  assert.equal(EAG_COMMAND_STRINGS.EAG_BUILD, "/eag-build");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DESIGN, "/eag-design");
  assert.equal(EAG_COMMAND_STRINGS.EAG_TEST, "/eag-test");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RUN, "/eag-run");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RESUME, "/eag-resume");
  assert.equal(EAG_COMMAND_STRINGS.EAG_STATUS, "/eag-status");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DEPLOY, "/eag-deploy");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS, "/eag-autonomous");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STATUS, "/eag-autonomous-status");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STOP, "/eag-autonomous-stop");
  assert.equal(EAG_COMMAND_STRINGS.EAG_GRAPH, "/eag-graph");
  // ADR-DI-001 §7.4.1 新增 7 个动态指令注入与后台子 Agent 命令字符串
  assert.equal(EAG_COMMAND_STRINGS.INJECT, "/inject");
  assert.equal(EAG_COMMAND_STRINGS.BG, "/bg");
  assert.equal(EAG_COMMAND_STRINGS.TASKS, "/tasks");
  assert.equal(EAG_COMMAND_STRINGS.FG, "/fg");
  assert.equal(EAG_COMMAND_STRINGS.CANCEL, "/cancel");
  assert.equal(EAG_COMMAND_STRINGS.PAUSE, "/pause");
  assert.equal(EAG_COMMAND_STRINGS.RESUME, "/resume");
  // 验证总字段数（防止未来误新增）
  assert.equal(Object.keys(EAG_COMMAND_STRINGS).length, 18, "应有 18 个 EAG 命令字符串");
});

test("B4. EAG_COMMAND_STRINGS 被 Object.freeze 冻结（不可变优先 §5.12.4 G-A6d）", () => {
  // 验证：EAG_COMMAND_STRINGS 顶层对象被 Object.freeze 冻结
  // 在 strict 模式下，对冻结对象的属性赋值会抛 TypeError
  assert.ok(Object.isFrozen(EAG_COMMAND_STRINGS), "EAG_COMMAND_STRINGS 应被冻结");

  // 验证：尝试修改属性应抛 TypeError（strict 模式下）
  assert.throws(
    () => {
      (EAG_COMMAND_STRINGS as any).EAG_BUILD = "/eag-changed";
    },
    TypeError,
    "修改冻结对象属性应抛 TypeError"
  );

  // 验证：尝试新增属性应抛 TypeError
  assert.throws(
    () => {
      (EAG_COMMAND_STRINGS as any).EAG_NEW = "/eag-new";
    },
    TypeError,
    "新增冻结对象属性应抛 TypeError"
  );

  // 验证：原值未变
  assert.equal(EAG_COMMAND_STRINGS.EAG_BUILD, "/eag-build", "冻结后原值应保持不变");
});

// ============================================================================
// C. parse() 统一入口测试（D-S3-1 / D-S3-3）
// ============================================================================

test("C5. parse() 对 text 为非字符串时返回 unknown", () => {
  // 验证 parse() 步骤 1：text 必须为字符串
  // 非字符串时返回 { kind: "unknown", payload: null }，不抛异常
  const parser = new EagCommandParser();
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: null as any }).kind, "unknown");
  assert.equal(parser.parse({ text: 123 as any }).kind, "unknown");
  assert.equal(parser.parse({ text: {} as any }).kind, "unknown");
  assert.equal(parser.parse({ text: [] as any }).kind, "unknown");
  // 无 text 字段
  assert.equal(parser.parse({}).kind, "unknown");
});

test("C6. parse() 对含图片附件的输入返回 unknown（避免误触发）", () => {
  // 验证 parse() 步骤 2：含图片附件时不识别为命令（避免误判）
  // 即使 text 严格匹配命令字符串，也返回 unknown
  const parser = new EagCommandParser();
  const imageUrls = [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ];
  assert.equal(parser.parse({ text: "/eag-build", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", imageUrls }).kind, "unknown");
});

test("C7. parse() 对含技能匹配的输入返回 unknown（避免误触发）", () => {
  // 验证 parse() 步骤 2：含技能匹配时不识别为命令（避免误判）
  // 即使 text 严格匹配命令字符串，也返回 unknown
  const parser = new EagCommandParser();
  const skills = [{ name: "test-skill", path: "/", description: "测试技能" }];
  assert.equal(parser.parse({ text: "/eag-build", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", skills }).kind, "unknown");
});

test("C8. parse() 对严格匹配 6 个命令字符串时返回对应 kind", () => {
  // 验证 parse() 步骤 3：text trim 后严格匹配 6 个命令字符串，返回对应 kind
  const parser = new EagCommandParser();
  // 不带 trim 的精确匹配
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parse({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parse({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parse({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");
  // 带 trim 的精确匹配（前后空格被 trim 后匹配）
  assert.equal(parser.parse({ text: "  /eag-build  " }).kind, "eag-build");
  assert.equal(parser.parse({ text: "  /eag-design  " }).kind, "eag-design");
  assert.equal(parser.parse({ text: "  /eag-test  " }).kind, "eag-test");
  assert.equal(parser.parse({ text: "  /eag-run  " }).kind, "eag-run");
  assert.equal(parser.parse({ text: "  /eag-resume  " }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "  /eag-status  " }).kind, "eag-status");
});

test("C9. parse() 对不匹配任何命令的文本返回 unknown", () => {
  // 验证 parse() 步骤 3 default 分支：未匹配任何 EAG 命令 → unknown
  const parser = new EagCommandParser();
  // 普通对话文本
  assert.equal(parser.parse({ text: "请帮我实现一个订单系统" }).kind, "unknown");
  assert.equal(parser.parse({ text: "今天天气不错" }).kind, "unknown");
  // 带参数的命令（设计规定命令无参数，参数通过 messageParams 注入 D-S3-7）
  assert.equal(parser.parse({ text: "/eag-build --force" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design order" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test all" }).kind, "unknown");
  // 包含命令字符串但非严格匹配
  assert.equal(parser.parse({ text: "请帮我执行 /eag-build" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build/" }).kind, "unknown");
  // 相似但非命令的字符串
  assert.equal(parser.parse({ text: "/eag-buil" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag" }).kind, "unknown");
  assert.equal(parser.parse({ text: "eag-build" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/EAG-BUILD" }).kind, "unknown");
  // 其他系统命令
  assert.equal(parser.parse({ text: "/continue" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/plan" }).kind, "unknown");
});

// ============================================================================
// D. /eag-build 命令测试（parseEagBuildCommand + extractCodingLoopRequest）
// ============================================================================

test("D10. parseEagBuildCommand 对 /eag-build 命令返回 eag-build kind", () => {
  // 验证 parseEagBuildCommand()：对 /eag-build 命令返回 kind=eag-build
  const parser = new EagCommandParser();
  const cmd = parser.parseEagBuildCommand({ text: "/eag-build" });
  assert.equal(cmd.kind, "eag-build");
  // payload 默认为 null（未提供 messageParams）
  assert.equal(cmd.payload, null);
});

test("D11. parseEagBuildCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagBuildCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-status" }).kind, "unknown");
});

test("D12. parseEagBuildCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagBuildCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagBuildCommand({ text: "请帮我执行 /eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-build arg" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: undefined }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/continue" }).kind, "unknown");
});

test("D13. parseEagBuildCommand 对 /eag-build 含图片附件返回 unknown", () => {
  // 验证 parseEagBuildCommand()：含图片附件时返回 unknown（避免误判）
  const parser = new EagCommandParser();
  const result = parser.parseEagBuildCommand({
    text: "/eag-build",
    imageUrls: ["data:image/png;base64,iVBORw0KGgo="],
  });
  assert.equal(result.kind, "unknown");
  assert.equal(result.payload, null);
});

test("D14. extractCodingLoopRequest 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractCodingLoopRequest 字段校验逻辑（D-S3-7）
  // 通过 parse() 间接测试（extractCodingLoopRequest 为 private 方法）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 为 undefined → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build" }).payload, null);
  // 情况 1：messageParams 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: {} }).payload, null);
  // 情况 2：codingLoopRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { other: "value" } }).payload, null);
  // 情况 2：codingLoopRequest 字段非对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: "not-object" } }).payload, null);
  // 情况 3：codingLoopRequest 缺 projectRoot → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-build",
      messageParams: { codingLoopRequest: { specContent: "spec" } },
    }).payload,
    null
  );
  // 情况 3：codingLoopRequest 缺 maxIterations（非 number）→ payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-build",
      messageParams: {
        codingLoopRequest: {
          projectRoot: "/test",
          specContent: "spec",
          planContent: "plan",
          tasksContent: "tasks",
          taskDag: { nodes: [], topologicalOrder: [] },
          taskCards: [],
          techStack: ["TS"],
          constitutionContent: "constitution",
          llmClient: {},
          pkcAccessor: {},
          loopGuard: {},
          // 缺 maxIterations / maxFixRounds
        },
      },
    }).payload,
    null
  );
  // 情况 4：字段完整 → payload 为 CodingLoopRequest 对象
  const validRequest = createMinimalCodingLoopRequest();
  const parsed = parser.parse({
    text: "/eag-build",
    messageParams: { codingLoopRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 CodingLoopRequest 对象");
  assert.equal((parsed.payload as CodingLoopRequest).projectRoot, "/test/project");
  assert.equal((parsed.payload as CodingLoopRequest).specContent, validRequest.specContent);
  assert.equal((parsed.payload as CodingLoopRequest).maxIterations, 10);
  assert.equal((parsed.payload as CodingLoopRequest).maxFixRounds, 3);
});

// ============================================================================
// E. /eag-design 命令测试（parseEagDesignCommand + extractDesignLoopInput）
// ============================================================================

test("E15. parseEagDesignCommand 对 /eag-design 命令返回 eag-design kind", () => {
  // 验证 parseEagDesignCommand()：对 /eag-design 命令返回 kind=eag-design
  const parser = new EagCommandParser();
  const cmd = parser.parseEagDesignCommand({ text: "/eag-design" });
  assert.equal(cmd.kind, "eag-design");
  assert.equal(cmd.payload, null);
});

test("E16. parseEagDesignCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagDesignCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-status" }).kind, "unknown");
});

test("E17. parseEagDesignCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagDesignCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagDesignCommand({ text: "请帮我执行 /eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-design arg" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: undefined }).kind, "unknown");
});

test("E18. parseEagDesignCommand 对 /eag-design 含技能匹配返回 unknown", () => {
  // 验证 parseEagDesignCommand()：含技能匹配时返回 unknown（避免误判）
  const parser = new EagCommandParser();
  const result = parser.parseEagDesignCommand({
    text: "/eag-design",
    skills: [{ name: "test-skill", path: "/", description: "测试技能" }],
  });
  assert.equal(result.kind, "unknown");
  assert.equal(result.payload, null);
});

test("E19. extractDesignLoopInput 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractDesignLoopInput 字段校验逻辑（D-S3-7）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 为 undefined → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design" }).payload, null);
  // 情况 1：messageParams 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: {} }).payload, null);
  // 情况 2：designLoopInput 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: { other: "value" } }).payload, null);
  // 情况 2：designLoopInput 字段非对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: { designLoopInput: "not-object" } }).payload, null);
  // 情况 3：designLoopInput.rawRequirement 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-design",
      messageParams: { designLoopInput: { projectContext: {} } },
    }).payload,
    null
  );
  // 情况 3：designLoopInput.rawRequirement 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-design",
      messageParams: { designLoopInput: { rawRequirement: "   " } },
    }).payload,
    null
  );
  // 情况 4：字段完整 → payload 为 DesignLoopInput 对象
  const validInput = createMinimalDesignLoopInput();
  const parsed = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: validInput },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DesignLoopInput 对象");
  assert.equal((parsed.payload as DesignLoopInput).rawRequirement, validInput.rawRequirement);
});

// ============================================================================
// F. /eag-test 命令测试（parseEagTestCommand + extractTestingLoopRequest）
// ============================================================================

test("F20. parseEagTestCommand 对 /eag-test 命令返回 eag-test kind", () => {
  // 验证 parseEagTestCommand()：对 /eag-test 命令返回 kind=eag-test
  const parser = new EagCommandParser();
  const cmd = parser.parseEagTestCommand({ text: "/eag-test" });
  assert.equal(cmd.kind, "eag-test");
  assert.equal(cmd.payload, null);
});

test("F21. parseEagTestCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagTestCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagTestCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-status" }).kind, "unknown");
});

test("F22. parseEagTestCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagTestCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagTestCommand({ text: "请帮我执行 /eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-test arg" }).kind, "unknown");
  assert.equal(parser.parseEagTestCommand({ text: undefined }).kind, "unknown");
});

test("F23. extractTestingLoopRequest 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractTestingLoopRequest 字段校验逻辑（D-S3-7）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-test" }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-test", messageParams: {} }).payload, null);
  // 情况 2：testingLoopRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-test", messageParams: { other: "value" } }).payload, null);
  // 情况 3：testingLoopRequest.projectRoot 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-test",
      messageParams: { testingLoopRequest: { specContent: "spec" } },
    }).payload,
    null
  );
  // 情况 3：testingLoopRequest.maxIterations 缺失（非 number）→ payload 为 null
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
  // 情况 4：字段完整 → payload 为 TestingLoopRequest 对象
  const validRequest = createMinimalTestingLoopRequest();
  const parsed = parser.parse({
    text: "/eag-test",
    messageParams: { testingLoopRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 TestingLoopRequest 对象");
  assert.equal((parsed.payload as TestingLoopRequest).projectRoot, "/test/project");
  assert.equal((parsed.payload as TestingLoopRequest).specContent, validRequest.specContent);
  assert.equal((parsed.payload as TestingLoopRequest).maxIterations, 10);
});

// ============================================================================
// G. /eag-run 命令测试（parseEagRunCommand + extractEagRunRequest）
// ============================================================================

test("G24. parseEagRunCommand 对 /eag-run 命令返回 eag-run kind", () => {
  // 验证 parseEagRunCommand()：对 /eag-run 命令返回 kind=eag-run
  const parser = new EagCommandParser();
  const cmd = parser.parseEagRunCommand({ text: "/eag-run" });
  assert.equal(cmd.kind, "eag-run");
  assert.equal(cmd.payload, null);
});

test("G25. parseEagRunCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagRunCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagRunCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-status" }).kind, "unknown");
});

test("G26. parseEagRunCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagRunCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagRunCommand({ text: "请帮我执行 /eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-run arg" }).kind, "unknown");
  assert.equal(parser.parseEagRunCommand({ text: undefined }).kind, "unknown");
});

test("G27. extractEagRunRequest 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractEagRunRequest 字段校验逻辑（D-S3-7）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-run" }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-run", messageParams: {} }).payload, null);
  // 情况 2：eagRunRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-run", messageParams: { other: "value" } }).payload, null);
  // 情况 3：projectRoot 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { userIntent: "意图", loopExecutors: [{}] } },
    }).payload,
    null
  );
  // 情况 3：userIntent 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { projectRoot: "/test", loopExecutors: [{}] } },
    }).payload,
    null
  );
  // 情况 4：loopExecutors 为空数组 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { projectRoot: "/test", userIntent: "意图", loopExecutors: [] } },
    }).payload,
    null
  );
  // 情况 4：loopExecutors 非数组 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-run",
      messageParams: { eagRunRequest: { projectRoot: "/test", userIntent: "意图", loopExecutors: "not-array" } },
    }).payload,
    null
  );
  // 情况 5：字段完整 → payload 为 EagRunRequest 对象
  const validRequest = createMinimalEagRunRequest();
  const parsed = parser.parse({
    text: "/eag-run",
    messageParams: { eagRunRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 EagRunRequest 对象");
  assert.equal((parsed.payload as EagRunRequest).projectRoot, "/test/project");
  assert.equal((parsed.payload as EagRunRequest).userIntent, "我需要一个订单管理微服务");
  assert.equal((parsed.payload as EagRunRequest).loopExecutors.length, 2);
});

// ============================================================================
// H. /eag-resume 命令测试（parseEagResumeCommand + extractEagResumeRequest）
// ============================================================================

test("H28. parseEagResumeCommand 对 /eag-resume 命令返回 eag-resume kind", () => {
  // 验证 parseEagResumeCommand()：对 /eag-resume 命令返回 kind=eag-resume
  const parser = new EagCommandParser();
  const cmd = parser.parseEagResumeCommand({ text: "/eag-resume" });
  assert.equal(cmd.kind, "eag-resume");
  assert.equal(cmd.payload, null);
});

test("H29. parseEagResumeCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagResumeCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-status" }).kind, "unknown");
});

test("H30. parseEagResumeCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagResumeCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagResumeCommand({ text: "请帮我执行 /eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-resume arg" }).kind, "unknown");
  assert.equal(parser.parseEagResumeCommand({ text: undefined }).kind, "unknown");
});

test("H31. extractEagResumeRequest 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractEagResumeRequest 字段校验逻辑（D-S3-7）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-resume" }).payload, null);
  // 情况 2：eagResumeRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-resume", messageParams: { other: "value" } }).payload, null);
  // 情况 3：runId 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { projectRoot: "/test", userIntent: "意图", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 3：runId 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "   ", projectRoot: "/test", userIntent: "意图", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 4：projectRoot 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "abc123", userIntent: "意图", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 5：userIntent 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "abc123", projectRoot: "/test", loopExecutors: [{}] },
      },
    }).payload,
    null
  );
  // 情况 6：loopExecutors 为空数组 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-resume",
      messageParams: {
        eagResumeRequest: { runId: "abc123", projectRoot: "/test", userIntent: "意图", loopExecutors: [] },
      },
    }).payload,
    null
  );
  // 情况 7：字段完整 → payload 为 EagResumeRequest 对象
  const validRequest = createMinimalEagResumeRequest();
  const parsed = parser.parse({
    text: "/eag-resume",
    messageParams: { eagResumeRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 EagResumeRequest 对象");
  assert.equal((parsed.payload as EagResumeRequest).runId, "abc123def456");
  assert.equal((parsed.payload as EagResumeRequest).projectRoot, "/test/project");
  assert.equal((parsed.payload as EagResumeRequest).userIntent, "我需要一个订单管理微服务");
});

// ============================================================================
// I. /eag-status 命令测试（parseEagStatusCommand + extractEagStatusRequest）
// ============================================================================

test("I32. parseEagStatusCommand 对 /eag-status 命令返回 eag-status kind", () => {
  // 验证 parseEagStatusCommand()：对 /eag-status 命令返回 kind=eag-status
  const parser = new EagCommandParser();
  const cmd = parser.parseEagStatusCommand({ text: "/eag-status" });
  assert.equal(cmd.kind, "eag-status");
  assert.equal(cmd.payload, null);
});

test("I33. parseEagStatusCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagStatusCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-resume" }).kind, "unknown");
});

test("I34. parseEagStatusCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagStatusCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagStatusCommand({ text: "请帮我执行 /eag-status" }).kind, "unknown");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-status arg" }).kind, "unknown");
  assert.equal(parser.parseEagStatusCommand({ text: undefined }).kind, "unknown");
});

test("I35. extractEagStatusRequest 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractEagStatusRequest 字段校验逻辑（D-S3-7）
  // 注：projectRoot 必填（非空字符串），runId 与 recentCount 二选一（类型由 TS 保证）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-status" }).payload, null);
  // 情况 2：eagStatusRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-status", messageParams: { other: "value" } }).payload, null);
  // 情况 3：projectRoot 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-status",
      messageParams: { eagStatusRequest: { runId: "abc123" } },
    }).payload,
    null
  );
  // 情况 3：projectRoot 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-status",
      messageParams: { eagStatusRequest: { projectRoot: "   ", runId: "abc123" } },
    }).payload,
    null
  );
  // 情况 3：projectRoot 为非字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-status",
      messageParams: { eagStatusRequest: { projectRoot: 123, runId: "abc123" } },
    }).payload,
    null
  );
  // 情况 4：字段完整（含 runId）→ payload 为 EagStatusRequest 对象
  const validRequest1 = createMinimalEagStatusRequest();
  const parsed1 = parser.parse({
    text: "/eag-status",
    messageParams: { eagStatusRequest: validRequest1 },
  });
  assert.ok(parsed1.payload, "字段完整时应返回 EagStatusRequest 对象");
  assert.equal((parsed1.payload as EagStatusRequest).projectRoot, "/test/project");
  assert.equal((parsed1.payload as EagStatusRequest).runId, "abc123def456");
  // 情况 5：字段完整（含 recentCount 而非 runId）→ payload 为 EagStatusRequest 对象
  const parsed2 = parser.parse({
    text: "/eag-status",
    messageParams: {
      eagStatusRequest: { projectRoot: "/test/project", recentCount: 5 },
    },
  });
  assert.ok(parsed2.payload, "仅含 recentCount 时也应返回对象");
  assert.equal((parsed2.payload as EagStatusRequest).projectRoot, "/test/project");
  assert.equal((parsed2.payload as EagStatusRequest).recentCount, 5);
});

// ============================================================================
// J. 不可变优先原则测试（§5.12.4 G-A6d）
// ============================================================================

test("J36. EagCommand 返回对象的 kind 与 payload 字段不可重新赋值（readonly）", () => {
  // 验证：EagCommand 类型联合的 kind 与 payload 字段为 readonly
  // 通过 Object.freeze 冻结返回对象，保证不可变性
  const parser = new EagCommandParser();

  // /eag-build 命令返回的对象（payload 为 null 时也应被冻结）
  const cmd1 = parser.parse({ text: "/eag-build" });
  assert.ok(Object.isFrozen(cmd1), "parse 返回的对象应被冻结");
  // 尝试修改 kind 应抛 TypeError
  assert.throws(
    () => {
      (cmd1 as any).kind = "eag-design";
    },
    TypeError,
    "修改冻结对象的 kind 字段应抛 TypeError"
  );
  // 尝试修改 payload 应抛 TypeError
  assert.throws(
    () => {
      (cmd1 as any).payload = { projectRoot: "/changed" };
    },
    TypeError,
    "修改冻结对象的 payload 字段应抛 TypeError"
  );

  // unknown 命令返回的对象
  const cmd2 = parser.parse({ text: "非命令文本" });
  assert.ok(Object.isFrozen(cmd2), "unknown 返回的对象应被冻结");

  // payload 非空的对象（payload 由调用方提供，不应被 parser 冻结）
  // 注：payload 对象本身的冻结责任在调用方（fixture 已 Object.freeze）
  const validInput = createMinimalDesignLoopInput();
  const cmd3 = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: validInput },
  });
  // 顶层 EagCommand 应被冻结
  assert.ok(Object.isFrozen(cmd3), "顶层 EagCommand 应被冻结");
});

test("J37. EAG_COMMAND_STRINGS 不可变（frozen 属性验证）", () => {
  // 验证：EAG_COMMAND_STRINGS 常量被 Object.freeze 冻结
  // 注：与 B4 互补，B4 验证运行期抛 TypeError，J37 验证 isFrozen 标记
  assert.ok(Object.isFrozen(EAG_COMMAND_STRINGS), "EAG_COMMAND_STRINGS 应被 Object.isFrozen 标记");
  // 二级属性（字符串字面量）天然不可变，无需进一步冻结
  assert.equal(typeof EAG_COMMAND_STRINGS.EAG_BUILD, "string", "EAG_BUILD 应为字符串");
});

test("J38. EagCommandParser 类无实例字段（无状态验证）", () => {
  // 验证：EagCommandParser 类无实例字段（D-S3-4 无状态原则）
  // 通过 Object.keys 检查实例上无可枚举字段
  const parser = new EagCommandParser();
  const instanceKeys = Object.keys(parser);
  // 方法不在 Object.keys 中（方法是原型属性，非实例属性）
  assert.equal(instanceKeys.length, 0, `EagCommandParser 实例应无字段（无状态），实际为：${instanceKeys.join(", ")}`);

  // 验证：方法通过原型链访问，非实例属性
  assert.equal(Object.prototype.hasOwnProperty.call(parser, "parse"), false, "parse 应为原型方法，非实例属性");
  assert.equal(
    Object.prototype.hasOwnProperty.call(parser, "parseEagBuildCommand"),
    false,
    "parseEagBuildCommand 应为原型方法，非实例属性"
  );
});

// ============================================================================
// K. 边界情况测试
// ============================================================================

test("K39. parse() 对 messageParams 为各种类型时正常处理（不抛异常）", () => {
  // 验证 parse() 对 messageParams 字段不同类型的健壮性
  // messageParams 为 UserPromptContent 的可选字段，类型为 Record<string, unknown> | null
  const parser = new EagCommandParser();

  // messageParams 为 undefined（默认）
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build" }));
  // messageParams 为 null
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: null }));
  // messageParams 为空对象
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: {} }));
  // messageParams 为非对象（数字）—— UserPromptContent 类型应阻止此调用，但 parser 应健壮
  // 注意：此处通过 as any 绕过类型检查，验证运行期健壮性
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: 123 as any }));
  // messageParams 为非对象（字符串）
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: "invalid" as any }));
  // messageParams 为数组
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: [] as any }));

  // 验证：messageParams 为非对象时 payload 为 null（不抛异常）
  assert.equal(parser.parse({ text: "/eag-build", messageParams: 123 as any }).payload, null);
  assert.equal(parser.parse({ text: "/eag-build", messageParams: "invalid" as any }).payload, null);
});

test("K40. parse() 多种无效 messageParams.codingLoopRequest 时返回 null payload", () => {
  // 验证：extractCodingLoopRequest 对 messageParams.codingLoopRequest 各种无效值的健壮处理
  const parser = new EagCommandParser();

  // codingLoopRequest 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: null } }).payload, null);
  // codingLoopRequest 为 undefined
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: undefined } }).payload, null);
  // codingLoopRequest 为字符串
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: "string" } }).payload, null);
  // codingLoopRequest 为数字
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: 123 } }).payload, null);
  // codingLoopRequest 为数组
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: [] } }).payload, null);
  // codingLoopRequest 为空对象
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: {} } }).payload, null);
});

test("K41. parse() 在不同 UserPromptContent 可选字段组合下正常工作", () => {
  // 验证 parse() 对 UserPromptContent 其他可选字段的存在不影响命令识别
  // UserPromptContent 含 permissions / alwaysAllows / planMode 等字段，这些字段不应影响 EAG 命令识别
  const parser = new EagCommandParser();

  // 含 permissions 字段
  const cmd1 = parser.parse({
    text: "/eag-build",
    permissions: [{ tool: "Bash", permission: "allow" }] as any,
  });
  assert.equal(cmd1.kind, "eag-build");

  // 含 alwaysAllows 字段
  const cmd2 = parser.parse({
    text: "/eag-design",
    alwaysAllows: [{ tool: "Read", path: "/tmp" }] as any,
  });
  assert.equal(cmd2.kind, "eag-design");

  // 含 planMode 字段
  const cmd3 = parser.parse({
    text: "/eag-test",
    planMode: true,
  });
  assert.equal(cmd3.kind, "eag-test");

  // 含所有可选字段（除 imageUrls / skills 外，这些字段不影响命令识别）
  const cmd4 = parser.parse({
    text: "/eag-run",
    permissions: [{ tool: "Bash", permission: "allow" }] as any,
    alwaysAllows: [{ tool: "Read", path: "/tmp" }] as any,
    planMode: false,
    messageParams: {},
  });
  assert.equal(cmd4.kind, "eag-run");
});

// ============================================================================
// L. /eag-deploy 命令测试（parseEagDeployCommand + extractDeployRequest + extractDeployRequestFromPrompt）
// EAG-P4 批次 13 Phase 7 §5.1
// 注：原 K 段（边界情况）已存在 K39-K41，本段使用 L 作为字母前缀避免命名冲突
// ============================================================================

test("L42. /eag-deploy 命令分发（parse + parseEagDeployCommand）", () => {
  // 验证 parse() 与 parseEagDeployCommand() 对 /eag-deploy 命令的分发逻辑
  // 对齐设计文档 §5.1：命令字符串严格匹配，参数通过 messageParams 注入
  const parser = new EagCommandParser();

  // 情况 1：parse() 对 /eag-deploy 命令返回 kind=eag-deploy（payload 默认 null）
  const cmd1 = parser.parse({ text: "/eag-deploy" });
  assert.equal(cmd1.kind, "eag-deploy");
  assert.equal(cmd1.payload, null);

  // 情况 2：parse() 对 trim 后的 /eag-deploy 命令仍识别
  const cmd2 = parser.parse({ text: "  /eag-deploy  " });
  assert.equal(cmd2.kind, "eag-deploy");
  assert.equal(cmd2.payload, null);

  // 情况 3：parseEagDeployCommand() 对 /eag-deploy 命令返回 eag-deploy kind
  const cmd3 = parser.parseEagDeployCommand({ text: "/eag-deploy" });
  assert.equal(cmd3.kind, "eag-deploy");
  assert.equal(cmd3.payload, null);

  // 情况 4：parseEagDeployCommand() 对其他 EAG 命令返回 unknown
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-status" }).kind, "unknown");

  // 情况 5：parseEagDeployCommand() 对非命令文本返回 unknown
  assert.equal(parser.parseEagDeployCommand({ text: "请帮我执行 /eag-deploy" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/eag-deploy arg" }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: undefined }).kind, "unknown");
  assert.equal(parser.parseEagDeployCommand({ text: "/EAG-DEPLOY" }).kind, "unknown");

  // 情况 6：parseEagDeployCommand() 对含图片附件返回 unknown（避免误判）
  const cmdImg = parser.parseEagDeployCommand({
    text: "/eag-deploy",
    imageUrls: ["data:image/png;base64,iVBORw0KGgo="],
  });
  assert.equal(cmdImg.kind, "unknown");
  assert.equal(cmdImg.payload, null);

  // 情况 7：parseEagDeployCommand() 对含技能匹配返回 unknown（避免误判）
  const cmdSkill = parser.parseEagDeployCommand({
    text: "/eag-deploy",
    skills: [{ name: "test-skill", path: "/", description: "测试技能" }],
  });
  assert.equal(cmdSkill.kind, "unknown");
  assert.equal(cmdSkill.payload, null);

  // 情况 8：parse() 返回的对象被冻结（§5.12.4 G-A6d）
  assert.ok(Object.isFrozen(cmd1), "parse 返回的 /eag-deploy 对象应被冻结");
});

test("L43. extractDeployRequest 字段校验逻辑（合法/缺失/类型错误）", () => {
  // 验证 extractDeployRequest 字段校验逻辑（通过 parse 间接测试）
  // extractDeployRequest 为 private 方法，通过 parse() 间接验证
  const parser = new EagCommandParser();

  // 情况 1：messageParams 缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy" }).payload, null);
  // 情况 1：messageParams 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: {} }).payload, null);
  // 情况 2：deployRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { other: "value" } }).payload, null);
  // 情况 2：deployRequest 字段非对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: "not-object" } }).payload, null);
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: 123 } }).payload, null);
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: [] } }).payload, null);
  // 情况 2：deployRequest 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-deploy", messageParams: { deployRequest: null } }).payload, null);

  // 情况 3：projectName 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 3：projectName 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "   ",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 3：projectName 为非字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: 123,
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 4：environment 取值非法 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "production",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 4：environment 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          image: "img",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 5：image 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 5：image 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "  ",
          port: 8080,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 6：port 非数字 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: "8080",
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 6：port 非整数 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 80.5,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 6：port 小于 1 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 0,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 6：port 大于 65535 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 65536,
          replicas: 3,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 7：replicas 非数字 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: "3",
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 7：replicas 非整数 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 3.5,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 7：replicas 小于 1 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 0,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );
  // 情况 7：replicas 大于 100 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-deploy",
      messageParams: {
        deployRequest: {
          projectName: "svc",
          environment: "prod",
          image: "img",
          port: 8080,
          replicas: 101,
          iacType: "terraform",
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 8：iacType 取值非法 → payload 为 null
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
  // 情况 8：iacType 缺失 → payload 为 null
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
          strategy: "rolling",
        },
      },
    }).payload,
    null
  );

  // 情况 9：strategy 取值非法 → payload 为 null
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
          iacType: "terraform",
          strategy: "recreate",
        },
      },
    }).payload,
    null
  );
  // 情况 9：strategy 缺失 → payload 为 null
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
          iacType: "terraform",
        },
      },
    }).payload,
    null
  );

  // 情况 10：dryRun 为非 boolean → payload 为 null
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
          iacType: "terraform",
          strategy: "rolling",
          dryRun: "yes",
        },
      },
    }).payload,
    null
  );

  // 情况 11：字段完整（无 dryRun）→ payload 为 DeployRequest 对象
  const validRequest = createMinimalDeployRequest();
  const parsed = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DeployRequest 对象");
  assert.equal((parsed.payload as DeployRequest).projectName, "order-service");
  assert.equal((parsed.payload as DeployRequest).environment, "prod");
  assert.equal((parsed.payload as DeployRequest).image, "registry.example.com/order-service:v1.2.3");
  assert.equal((parsed.payload as DeployRequest).port, 8080);
  assert.equal((parsed.payload as DeployRequest).replicas, 3);
  assert.equal((parsed.payload as DeployRequest).iacType, "helm-chart");
  assert.equal((parsed.payload as DeployRequest).strategy, "blue-green");
  assert.equal((parsed.payload as DeployRequest).dryRun, undefined);

  // 情况 12：字段完整（含 dryRun=true）→ payload 为 DeployRequest 对象
  const validRequestWithDryRun = createMinimalDeployRequestWithDryRun();
  const parsedWithDryRun = parser.parse({
    text: "/eag-deploy",
    messageParams: { deployRequest: validRequestWithDryRun },
  });
  assert.ok(parsedWithDryRun.payload, "字段完整（含 dryRun）时应返回 DeployRequest 对象");
  assert.equal((parsedWithDryRun.payload as DeployRequest).dryRun, true);
});

test("L44. extractDeployRequestFromPrompt 合法命令字符串解析（K3a）", () => {
  // 验证 extractDeployRequestFromPrompt 对合法命令字符串的解析
  // 包含全部 7 个必填参数，无 dryRun
  const prompt =
    "/eag-deploy --project order-service --env prod --image registry.example.com/order-service:v1.2.3 --port 8080 --replicas 3 --iac helm-chart --strategy blue-green";
  const request = extractDeployRequestFromPrompt(prompt);

  // 验证所有字段被正确解析
  assert.equal(request.projectName, "order-service");
  assert.equal(request.environment, "prod");
  assert.equal(request.image, "registry.example.com/order-service:v1.2.3");
  assert.equal(request.port, 8080);
  assert.equal(request.replicas, 3);
  assert.equal(request.iacType, "helm-chart");
  assert.equal(request.strategy, "blue-green");
  // dryRun 未提供时应为 undefined
  assert.equal(request.dryRun, undefined);
});

test("L45. extractDeployRequestFromPrompt 缺少必填参数抛错（K3b）", () => {
  // 验证 extractDeployRequestFromPrompt 在缺少任一必填参数时抛 Error
  // 错误信息应含参数名

  // 缺少 --project
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--project/,
    "缺少 --project 应抛包含参数名的错误"
  );

  // 缺少 --env
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env/,
    "缺少 --env 应抛包含参数名的错误"
  );

  // 缺少 --image
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--image/,
    "缺少 --image 应抛包含参数名的错误"
  );

  // 缺少 --port
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port/,
    "缺少 --port 应抛包含参数名的错误"
  );

  // 缺少 --replicas
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --iac terraform --strategy rolling"
      ),
    /--replicas/,
    "缺少 --replicas 应抛包含参数名的错误"
  );

  // 缺少 --iac
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --strategy rolling"
      ),
    /--iac/,
    "缺少 --iac 应抛包含参数名的错误"
  );

  // 缺少 --strategy
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform"
      ),
    /--strategy/,
    "缺少 --strategy 应抛包含参数名的错误"
  );

  // 完全无参数（仅命令前缀）
  assert.throws(
    () => extractDeployRequestFromPrompt("/eag-deploy"),
    /--project/,
    "仅命令前缀时应抛缺少 --project 的错误"
  );

  // prompt 为空字符串
  assert.throws(() => extractDeployRequestFromPrompt(""), /不能为空字符串/, "空字符串应抛特定错误");

  // 命令前缀不匹配
  assert.throws(
    () => extractDeployRequestFromPrompt("/eag-build --project svc"),
    /命令前缀不匹配/,
    "命令前缀不匹配应抛特定错误"
  );
});

test("L46. extractDeployRequestFromPrompt --env 取值非法抛错（K3c）", () => {
  // 验证 --env 取值不在 dev | staging | prod 时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env production --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env 取值非法/,
    "--env production 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env develop --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env 取值非法/,
    "--env develop 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env PROD --image img --port 8080 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--env 取值非法/,
    "--env PROD（大写）应抛取值非法错误（大小写敏感）"
  );

  // 验证合法取值不抛错
  for (const env of ["dev", "staging", "prod"] as const) {
    const request = extractDeployRequestFromPrompt(
      `/eag-deploy --project svc --env ${env} --image img --port 8080 --replicas 3 --iac terraform --strategy rolling`
    );
    assert.equal(request.environment, env);
  }
});

test("L47. extractDeployRequestFromPrompt --port 非正整数抛错（K3d）", () => {
  // 验证 --port 非正整数（小数、字符串、负数）时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 80.5 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 80.5（小数）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port abc --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port abc（非数字）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port -1 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port -1（负数）应抛取值非法错误"
  );
});

test("L48. extractDeployRequestFromPrompt --port 超范围抛错（K3e）", () => {
  // 验证 --port 超出 1-65535 范围时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 0 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 0（小于 1）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 65536 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 65536（大于 65535）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 100000 --replicas 3 --iac terraform --strategy rolling"
      ),
    /--port 取值非法/,
    "--port 100000（远大于 65535）应抛取值非法错误"
  );

  // 验证边界值合法
  const r1 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 1 --replicas 3 --iac terraform --strategy rolling"
  );
  assert.equal(r1.port, 1, "边界值 port=1 应合法");

  const r2 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 65535 --replicas 3 --iac terraform --strategy rolling"
  );
  assert.equal(r2.port, 65535, "边界值 port=65535 应合法");
});

test("L49. extractDeployRequestFromPrompt --replicas 非正整数抛错（K3f）", () => {
  // 验证 --replicas 非正整数时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3.5 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 3.5（小数）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas abc --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas abc（非数字）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas -5 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas -5（负数）应抛取值非法错误"
  );
});

test("L50. extractDeployRequestFromPrompt --replicas 超范围抛错（K3g）", () => {
  // 验证 --replicas 超出 1-100 范围时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 0 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 0（小于 1）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 101 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 101（大于 100）应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 1000 --iac terraform --strategy rolling"
      ),
    /--replicas 取值非法/,
    "--replicas 1000（远大于 100）应抛取值非法错误"
  );

  // 验证边界值合法
  const r1 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 1 --iac terraform --strategy rolling"
  );
  assert.equal(r1.replicas, 1, "边界值 replicas=1 应合法");

  const r2 = extractDeployRequestFromPrompt(
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 100 --iac terraform --strategy rolling"
  );
  assert.equal(r2.replicas, 100, "边界值 replicas=100 应合法");
});

test("L51. extractDeployRequestFromPrompt --iac 取值非法抛错（K3h）", () => {
  // 验证 --iac 取值不在 terraform | k8s-manifest | helm-chart 时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac pulumi --strategy rolling"
      ),
    /--iac 取值非法/,
    "--iac pulumi 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac k8s_yaml --strategy rolling"
      ),
    /--iac 取值非法/,
    "--iac k8s_yaml 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac Terraform --strategy rolling"
      ),
    /--iac 取值非法/,
    "--iac Terraform（大写）应抛取值非法错误（大小写敏感）"
  );

  // 验证合法取值不抛错
  for (const iac of ["terraform", "k8s-manifest", "helm-chart"] as const) {
    const request = extractDeployRequestFromPrompt(
      `/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac ${iac} --strategy rolling`
    );
    assert.equal(request.iacType, iac);
  }
});

test("L52. extractDeployRequestFromPrompt --strategy 取值非法抛错（K3i）", () => {
  // 验证 --strategy 取值不在 rolling | blue-green | canary 时抛 Error
  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy recreate"
      ),
    /--strategy 取值非法/,
    "--strategy recreate 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling-update"
      ),
    /--strategy 取值非法/,
    "--strategy rolling-update 应抛取值非法错误"
  );

  assert.throws(
    () =>
      extractDeployRequestFromPrompt(
        "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy Canary"
      ),
    /--strategy 取值非法/,
    "--strategy Canary（大写）应抛取值非法错误（大小写敏感）"
  );

  // 验证合法取值不抛错
  for (const strategy of ["rolling", "blue-green", "canary"] as const) {
    const request = extractDeployRequestFromPrompt(
      `/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy ${strategy}`
    );
    assert.equal(request.strategy, strategy);
  }
});

test("L53. extractDeployRequestFromPrompt --dry-run flag 解析（K3j）", () => {
  // 验证 --dry-run flag（无值）解析为 dryRun=true
  const promptWithDryRun =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --dry-run";
  const request1 = extractDeployRequestFromPrompt(promptWithDryRun);
  assert.equal(request1.dryRun, true, "--dry-run flag 存在时 dryRun 应为 true");

  // 验证未提供 --dry-run 时 dryRun 为 undefined
  const promptWithoutDryRun =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request2 = extractDeployRequestFromPrompt(promptWithoutDryRun);
  assert.equal(request2.dryRun, undefined, "未提供 --dry-run 时 dryRun 应为 undefined");

  // 验证 --dry-run 出现在参数中间位置也能正确解析
  const promptDryRunMiddle =
    "/eag-deploy --project svc --dry-run --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request3 = extractDeployRequestFromPrompt(promptDryRunMiddle);
  assert.equal(request3.dryRun, true, "--dry-run 在中间位置时也应被正确解析");
  // 其他字段仍应正确解析
  assert.equal(request3.projectName, "svc");
  assert.equal(request3.environment, "prod");
});

test("L54. extractDeployRequestFromPrompt 引号包裹的值解析（K3k）", () => {
  // 验证双引号包裹的值被正确解析（去除引号）
  const promptDouble =
    '/eag-deploy --project "order-service" --env prod --image "registry.example.com/order-service:v1.2.3" --port 8080 --replicas 3 --iac terraform --strategy rolling';
  const request1 = extractDeployRequestFromPrompt(promptDouble);
  assert.equal(request1.projectName, "order-service", "双引号包裹的 projectName 应去除引号");
  assert.equal(request1.image, "registry.example.com/order-service:v1.2.3", "双引号包裹的 image 应去除引号");

  // 验证单引号包裹的值被正确解析（去除引号）
  const promptSingle =
    "/eag-deploy --project 'order-service' --env prod --image 'registry.example.com/order-service:v1.2.3' --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request2 = extractDeployRequestFromPrompt(promptSingle);
  assert.equal(request2.projectName, "order-service", "单引号包裹的 projectName 应去除引号");
  assert.equal(request2.image, "registry.example.com/order-service:v1.2.3", "单引号包裹的 image 应去除引号");

  // 验证带空格的引号值被正确解析（保留空格）
  const promptWithSpace =
    '/eag-deploy --project "my order service" --env prod --image "registry.example.com/order service:v1" --port 8080 --replicas 3 --iac terraform --strategy rolling';
  const request3 = extractDeployRequestFromPrompt(promptWithSpace);
  assert.equal(request3.projectName, "my order service", "双引号内含空格的 projectName 应保留空格");
  assert.equal(request3.image, "registry.example.com/order service:v1", "双引号内含空格的 image 应保留空格");
});

test("L55. extractDeployRequestFromPrompt 重复参数首次匹配生效（K3l）", () => {
  // 验证重复参数首次匹配生效（后续重复参数被忽略）
  // 第一次 --project=svc1，第二次 --project=svc2，应使用 svc1
  const prompt =
    "/eag-deploy --project svc1 --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --project svc2";
  const request = extractDeployRequestFromPrompt(prompt);
  assert.equal(request.projectName, "svc1", "重复参数首次匹配生效，应使用 svc1");

  // 验证 --env 重复时首次匹配生效
  const promptEnv =
    "/eag-deploy --project svc --env dev --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --env prod";
  const requestEnv = extractDeployRequestFromPrompt(promptEnv);
  assert.equal(requestEnv.environment, "dev", "重复 --env 首次匹配生效，应使用 dev");

  // 验证 --port 重复时首次匹配生效
  const promptPort =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --port 9090";
  const requestPort = extractDeployRequestFromPrompt(promptPort);
  assert.equal(requestPort.port, 8080, "重复 --port 首次匹配生效，应使用 8080");
});

test("L56. extractDeployRequestFromPrompt 大小写不敏感命令前缀（K3m）", () => {
  // 验证命令前缀 /eag-deploy 大小写不敏感
  // 注：仅命令前缀大小写不敏感，参数值（如 --env prod）仍大小写敏感

  // 全小写（标准形式）
  const prompt1 =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request1 = extractDeployRequestFromPrompt(prompt1);
  assert.equal(request1.projectName, "svc", "全小写命令前缀应正常解析");

  // 全大写
  const prompt2 =
    "/EAG-DEPLOY --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request2 = extractDeployRequestFromPrompt(prompt2);
  assert.equal(request2.projectName, "svc", "全大写命令前缀应正常解析");

  // 混合大小写 1
  const prompt3 =
    "/Eag-Deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request3 = extractDeployRequestFromPrompt(prompt3);
  assert.equal(request3.projectName, "svc", "混合大小写命令前缀（Eag-Deploy）应正常解析");

  // 混合大小写 2
  const prompt4 =
    "/eAg-DePlOy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling";
  const request4 = extractDeployRequestFromPrompt(prompt4);
  assert.equal(request4.projectName, "svc", "混合大小写命令前缀（eAg-DePlOy）应正常解析");

  // 命令前缀带前后空格
  const prompt5 =
    "  /eag-deploy  --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling  ";
  const request5 = extractDeployRequestFromPrompt(prompt5);
  assert.equal(request5.projectName, "svc", "带前后空格的命令前缀应正常解析");
});

test("L57. extractDeployRequestFromPrompt 返回对象已冻结（K3n）", () => {
  // 验证返回的 DeployRequest 对象被 Object.freeze 冻结（§5.12.4 G-A6d）
  const prompt =
    "/eag-deploy --project svc --env prod --image img --port 8080 --replicas 3 --iac terraform --strategy rolling --dry-run";
  const request = extractDeployRequestFromPrompt(prompt);

  // 验证对象已被冻结
  assert.ok(Object.isFrozen(request), "extractDeployRequestFromPrompt 返回的对象应被 Object.freeze 冻结");

  // 验证修改冻结对象的字段应抛 TypeError（strict 模式下）
  assert.throws(
    () => {
      (request as any).projectName = "changed";
    },
    TypeError,
    "修改冻结对象的 projectName 字段应抛 TypeError"
  );

  assert.throws(
    () => {
      (request as any).port = 9090;
    },
    TypeError,
    "修改冻结对象的 port 字段应抛 TypeError"
  );

  assert.throws(
    () => {
      (request as any).dryRun = false;
    },
    TypeError,
    "修改冻结对象的 dryRun 字段应抛 TypeError"
  );

  // 验证新增字段应抛 TypeError
  assert.throws(
    () => {
      (request as any).newField = "value";
    },
    TypeError,
    "新增冻结对象属性应抛 TypeError"
  );

  // 验证原值未变
  assert.equal(request.projectName, "svc", "冻结后原 projectName 应保持不变");
  assert.equal(request.port, 8080, "冻结后原 port 应保持不变");
  assert.equal(request.dryRun, true, "冻结后原 dryRun 应保持不变");
});

test("L58. 向后兼容验证：既有 6 个命令零回归（P-10 规则）", () => {
  // 验证：新增 /eag-deploy 命令后，既有 6 个命令（/eag-build /eag-design /eag-test /eag-run /eag-resume /eag-status）
  // 的解析行为完全不变（P-10 100% 向后兼容规则）
  const parser = new EagCommandParser();

  // 1. 既有 6 个命令的 parse() 分发仍正确
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parse({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parse({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parse({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");

  // 2. 既有 6 个命令的 parseEagXxxCommand() 判定方法仍正确
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parseEagTestCommand({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parseEagRunCommand({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parseEagResumeCommand({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parseEagStatusCommand({ text: "/eag-status" }).kind, "eag-status");

  // 3. 既有 6 个命令的 payload 提取仍正确（字段完整时返回对象）
  const parsedBuild = parser.parse({
    text: "/eag-build",
    messageParams: { codingLoopRequest: createMinimalCodingLoopRequest() },
  });
  assert.ok(parsedBuild.payload, "/eag-build payload 提取仍正确");
  assert.equal((parsedBuild.payload as CodingLoopRequest).projectRoot, "/test/project");

  const parsedDesign = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: createMinimalDesignLoopInput() },
  });
  assert.ok(parsedDesign.payload, "/eag-design payload 提取仍正确");
  assert.equal((parsedDesign.payload as DesignLoopInput).rawRequirement, createMinimalDesignLoopInput().rawRequirement);

  const parsedTest = parser.parse({
    text: "/eag-test",
    messageParams: { testingLoopRequest: createMinimalTestingLoopRequest() },
  });
  assert.ok(parsedTest.payload, "/eag-test payload 提取仍正确");
  assert.equal((parsedTest.payload as TestingLoopRequest).projectRoot, "/test/project");

  const parsedRun = parser.parse({
    text: "/eag-run",
    messageParams: { eagRunRequest: createMinimalEagRunRequest() },
  });
  assert.ok(parsedRun.payload, "/eag-run payload 提取仍正确");
  assert.equal((parsedRun.payload as EagRunRequest).projectRoot, "/test/project");

  const parsedResume = parser.parse({
    text: "/eag-resume",
    messageParams: { eagResumeRequest: createMinimalEagResumeRequest() },
  });
  assert.ok(parsedResume.payload, "/eag-resume payload 提取仍正确");
  assert.equal((parsedResume.payload as EagResumeRequest).runId, "abc123def456");

  const parsedStatus = parser.parse({
    text: "/eag-status",
    messageParams: { eagStatusRequest: createMinimalEagStatusRequest() },
  });
  assert.ok(parsedStatus.payload, "/eag-status payload 提取仍正确");
  assert.equal((parsedStatus.payload as EagStatusRequest).projectRoot, "/test/project");

  // 4. 既有 6 个命令的 payload 缺失时仍返回 null
  assert.equal(parser.parse({ text: "/eag-build" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-design" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-test" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-run" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-resume" }).payload, null);
  assert.equal(parser.parse({ text: "/eag-status" }).payload, null);

  // 5. 既有 6 个命令返回的对象仍被 Object.freeze 冻结
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-build" })), "/eag-build 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-design" })), "/eag-design 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-test" })), "/eag-test 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-run" })), "/eag-run 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-resume" })), "/eag-resume 返回对象仍被冻结");
  assert.ok(Object.isFrozen(parser.parse({ text: "/eag-status" })), "/eag-status 返回对象仍被冻结");

  // 6. unknown 兜底分支仍正确
  assert.equal(parser.parse({ text: "普通对话文本" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/continue" }).kind, "unknown");
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");

  // 7. 图片附件 / 技能匹配仍使既有 6 个命令返回 unknown
  const imageUrls = ["data:image/png;base64,iVBORw0KGgo="];
  assert.equal(parser.parse({ text: "/eag-build", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", imageUrls }).kind, "unknown");

  const skills = [{ name: "test-skill", path: "/", description: "测试技能" }];
  assert.equal(parser.parse({ text: "/eag-build", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", skills }).kind, "unknown");

  // 8. EagCommandParser 类仍无状态（无实例字段）
  const instanceKeys = Object.keys(parser);
  assert.equal(instanceKeys.length, 0, "EagCommandParser 实例仍应无字段（无状态）");
});
