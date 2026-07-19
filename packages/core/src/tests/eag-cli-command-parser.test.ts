/**
 * EAG-P3 批次 11 S3：EagCommandParser 单元测试
 *
 * 测试范围（对齐 EAG-P3 批次 11 §5 S3 改进方案 D-S3-1 ~ D-S3-8）：
 * - A. EagCommandParser 实例化与无状态特性
 * - B. EAG_COMMAND_STRINGS 常量与冻结语义
 * - C. parse() 统一入口（非字符串 / 图片附件 / 技能匹配 / 6 命令分发 / unknown 兜底）
 * - D. /eag-build 命令（parseEagBuildCommand + extractCodingLoopRequest）
 * - E. /eag-design 命令（parseEagDesignCommand + extractDesignLoopInput）
 * - F. /eag-test 命令（parseEagTestCommand + extractTestingLoopRequest）
 * - G. /eag-run 命令（parseEagRunCommand + extractEagRunRequest）
 * - H. /eag-resume 命令（parseEagResumeCommand + extractEagResumeRequest）
 * - I. /eag-status 命令（parseEagStatusCommand + extractEagStatusRequest）
 * - J. 不可变优先原则（readonly payload / frozen 常量 / 无实例字段）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new EagCommandParser()，不通过 SessionManager 注入
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计文档 §5 S3 改进方案（决策清单 D-S3-1 ~ D-S3-8）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - eag/cli/eag-command-parser.ts（EagCommandParser 类与 EAG_COMMAND_STRINGS 常量）
 *
 * @module tests/eag-cli-command-parser
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagCommandParser, EAG_COMMAND_STRINGS } from "../eag/cli/eag-command-parser";
import type { EagCommand } from "../eag/cli/eag-command-parser";
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

// ============================================================================
// A. EagCommandParser 实例化与无状态特性测试
// ============================================================================

test("A1. EagCommandParser 实例化成功", () => {
  // 验证：EagCommandParser 可正常实例化（无构造参数，无外部依赖）
  const parser = new EagCommandParser();
  assert.ok(parser instanceof EagCommandParser, "应为 EagCommandParser 实例");
  // 验证 parse 与 parseEagXxxCommand 方法存在
  assert.equal(typeof parser.parse, "function", "parse 方法应存在");
  assert.equal(typeof parser.parseEagBuildCommand, "function", "parseEagBuildCommand 方法应存在");
  assert.equal(typeof parser.parseEagDesignCommand, "function", "parseEagDesignCommand 方法应存在");
  assert.equal(typeof parser.parseEagTestCommand, "function", "parseEagTestCommand 方法应存在");
  assert.equal(typeof parser.parseEagRunCommand, "function", "parseEagRunCommand 方法应存在");
  assert.equal(typeof parser.parseEagResumeCommand, "function", "parseEagResumeCommand 方法应存在");
  assert.equal(typeof parser.parseEagStatusCommand, "function", "parseEagStatusCommand 方法应存在");
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

test("B3. EAG_COMMAND_STRINGS 包含 6 个 EAG 命令字符串", () => {
  // 验证：EAG_COMMAND_STRINGS 常量包含 6 个 EAG 命令字符串（D-S3-6）
  assert.equal(EAG_COMMAND_STRINGS.EAG_BUILD, "/eag-build");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DESIGN, "/eag-design");
  assert.equal(EAG_COMMAND_STRINGS.EAG_TEST, "/eag-test");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RUN, "/eag-run");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RESUME, "/eag-resume");
  assert.equal(EAG_COMMAND_STRINGS.EAG_STATUS, "/eag-status");
  // 验证总字段数（防止未来误新增）
  assert.equal(Object.keys(EAG_COMMAND_STRINGS).length, 6, "应有 6 个 EAG 命令字符串");
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
