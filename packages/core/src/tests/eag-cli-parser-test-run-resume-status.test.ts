/**
 * EAG-P3 批次 11 S3：EagCommandParser 单元测试 —— /eag-test /eag-run /eag-resume /eag-status 命令
 * （拆分自 eag-cli-command-parser.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 11 §5 S3 改进方案 D-S3-7）：
 * - F. /eag-test 命令（parseEagTestCommand + extractTestingLoopRequest）
 * - G. /eag-run 命令（parseEagRunCommand + extractEagRunRequest）
 * - H. /eag-resume 命令（parseEagResumeCommand + extractEagResumeRequest）
 * - I. /eag-status 命令（parseEagStatusCommand + extractEagStatusRequest）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new EagCommandParser()，不通过 SessionManager 注入
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计文档 §5 S3 改进方案（决策清单 D-S3-7）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - eag/cli/eag-command-parser.ts（EagCommandParser 类与 EAG_COMMAND_STRINGS 常量）
 *
 * @module tests/eag-cli-parser-test-run-resume-status
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagCommandParser } from "../eag/cli/eag-command-parser";
import type { TestingLoopRequest } from "../eag/testing/types";
import type { EagRunRequest, EagResumeRequest, EagStatusRequest } from "../eag/long-horizon";
import {
  createMinimalTestingLoopRequest,
  createMinimalEagRunRequest,
  createMinimalEagResumeRequest,
  createMinimalEagStatusRequest,
} from "./fixtures/eag-command-fixtures";

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
