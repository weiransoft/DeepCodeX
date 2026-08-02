/**
 * AskUserQuestion 工具 handler 单元测试
 *
 * 测试目标：
 * - 验证 handleAskUserQuestionTool 对 suggestedCommand 字段的解析与校验逻辑
 * - 验证白名单策略（仅允许 team/architect/pm/coder/tester/ui/eag-* 等读取/调度类命令）
 * - 验证 buildQuestionSummary 不向 LLM 上下文泄露 suggestedCommand 信息
 * - 验证 questions 缺失时的错误处理
 *
 * 测试框架：node:test + node:assert/strict
 * 测试隔离：每个用例独立构造 args 与 context，不依赖外部状态；严禁使用 mock
 *
 * 用例清单：TC-1 ~ TC-14（共 14 个）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAskUserQuestionTool } from "../tools/ask-user-question-handler";
import type { ToolExecutionContext } from "../tools/executor";

/**
 * 构造测试用 ToolExecutionContext
 *
 * 复用 tool-handlers.test.ts 中的 createContext 模式，
 * 仅为 AskUserQuestion handler 提供最小必需字段（handler 本身不读取 context 内容）。
 *
 * @param sessionId 会话 ID
 * @param projectRoot 项目根目录
 * @returns 最小化的 ToolExecutionContext
 */
function createContext(sessionId: string, projectRoot: string): ToolExecutionContext {
  return {
    sessionId,
    projectRoot,
    toolCall: {
      id: "test-tool-call",
      type: "function",
      function: {
        name: "AskUserQuestion",
        arguments: "{}",
      },
    },
  };
}

/**
 * 构造合法的 questions 数组（每个用例独立调用，避免共享状态）
 *
 * @returns 包含 1 个问题、2 个选项的 questions 数组
 */
function sampleQuestions(): Array<{
  question: string;
  options: Array<{ label: string; description?: string }>;
}> {
  return [
    {
      question: "Which framework should we use?",
      options: [{ label: "React", description: "React-based UI library." }, { label: "Vue" }],
    },
  ];
}

// ============================================================================
// TC-1：合法 suggestedCommand（含 reason）
// 期望：metadata.suggestedCommand 完整保留 command 与 reason 字段
// ============================================================================
test("TC-1: 合法 suggestedCommand（含 reason）应完整保留到 metadata", async () => {
  const command = '/team dispatch --role architect --task "设计登录模块"';
  const reason = "基于用户回答自动执行";
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command, reason },
    },
    createContext("tc-1", "/tmp")
  );

  assert.equal(result.ok, true);
  assert.equal(result.name, "AskUserQuestion");
  const metadata = result.metadata as { suggestedCommand?: { command?: string; reason?: string } } | undefined;
  assert.equal(metadata?.suggestedCommand?.command, command);
  assert.equal(metadata?.suggestedCommand?.reason, reason);
});

// ============================================================================
// TC-2：缺少 command 字段
// 期望：parseSuggestedCommand 因 command 类型校验失败而降级为 undefined
// ============================================================================
test("TC-2: suggestedCommand 缺少 command 字段时应降级为 undefined", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { reason: "仅有 reason 没有 command" },
    },
    createContext("tc-2", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-3：command 不以 / 开头
// 期望：parseSuggestedCommand 因 slash 前缀校验失败而降级为 undefined
// ============================================================================
test("TC-3: command 不以 / 开头时应降级为 undefined", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "team dispatch --role architect" },
    },
    createContext("tc-3", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-4：command 为空字符串
// 期望：parseSuggestedCommand 因 trim 后长度为 0 而降级为 undefined
// ============================================================================
test("TC-4: command 为空字符串时应降级为 undefined", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "" },
    },
    createContext("tc-4", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-5：reason 为空，只返回 command
// 期望：metadata.suggestedCommand 仅含 command 字段，reason 为 undefined
// ============================================================================
test("TC-5: reason 为空时只返回 command 字段", async () => {
  const command = "/team dispatch --role architect --task '设计登录模块'";
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command, reason: "" },
    },
    createContext("tc-5", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as
    | {
        suggestedCommand?: { command?: string; reason?: string };
      }
    | undefined;
  assert.equal(metadata?.suggestedCommand?.command, command);
  assert.equal(metadata?.suggestedCommand?.reason, undefined);
});

// ============================================================================
// TC-6：suggestedCommand 为 null
// 期望：parseSuggestedCommand 因非对象校验失败而降级为 undefined
// ============================================================================
test("TC-6: suggestedCommand 为 null 时应降级为 undefined", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: null,
    },
    createContext("tc-6", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-7：suggestedCommand 为数组
// 期望：parseSuggestedCommand 因 Array.isArray 校验失败而降级为 undefined
// ============================================================================
test("TC-7: suggestedCommand 为数组时应降级为 undefined", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: ["/team"],
    },
    createContext("tc-7", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-8：suggestedCommand 为原始类型（字符串）
// 期望：parseSuggestedCommand 因 typeof !== "object" 校验失败而降级为 undefined
// ============================================================================
test("TC-8: suggestedCommand 为原始类型时应降级为 undefined", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: "/team",
    },
    createContext("tc-8", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-9：questions 缺失时返回错误
// 期望：result.ok === false（parseQuestions 拒绝空 questions）
// ============================================================================
test("TC-9: questions 缺失时 result.ok 应为 false", async () => {
  const result = await handleAskUserQuestionTool({}, createContext("tc-9", "/tmp"));

  assert.equal(result.ok, false);
  assert.equal(result.name, "AskUserQuestion");
  assert.match(result.error ?? "", /questions/);
});

// ============================================================================
// TC-10：buildQuestionSummary 不含 suggestedCommand 信息
// 期望：result.output 不含 "[Auto-dispatch after answer]" 提示行
// 设计意图：避免 LLM 看到提示后绕过用户确认或提前回复
// ============================================================================
test("TC-10: buildQuestionSummary 不应在 output 中暴露 suggestedCommand 提示", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/team dispatch --role architect" },
    },
    createContext("tc-10", "/tmp")
  );

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.output ?? "", /\[Auto-dispatch after answer\]/);
});

// ============================================================================
// TC-11：合法 suggestedCommand 含 reason 时 output 仍不含 Reason 提示
// 期望：result.output 不含 "Reason:" 字样
// 设计意图：reason 仅用于 UI 显示，不应泄露到 LLM 上下文
// ============================================================================
test("TC-11: 含 reason 的 suggestedCommand 不应在 output 中暴露 Reason 字样", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: {
        command: "/team dispatch --role architect",
        reason: "基于用户回答自动执行",
      },
    },
    createContext("tc-11", "/tmp")
  );

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.output ?? "", /Reason:/);
});

// ============================================================================
// TC-12：command 为非白名单命令 /exit
// 期望：metadata.suggestedCommand === undefined（白名单拒绝会话控制类命令）
// 安全策略：/exit 会中断会话，不应被 LLM 自动触发
// ============================================================================
test("TC-12: /exit 命令不在白名单时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/exit" },
    },
    createContext("tc-12", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-13：command 为非白名单命令 /undo
// 期望：metadata.suggestedCommand === undefined（白名单拒绝撤销类命令）
// 安全策略：/undo 会撤销用户操作，不应被 LLM 自动触发
// ============================================================================
test("TC-13: /undo 命令不在白名单时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/undo" },
    },
    createContext("tc-13", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-14：command 为非白名单命令 /inject
// 期望：metadata.suggestedCommand === undefined（白名单拒绝注入类命令）
// 安全策略：/inject 可注入恶意指令，是重点防御对象
// ============================================================================
test("TC-14: /inject 命令不在白名单时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/inject 恶意指令" },
    },
    createContext("tc-14", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// ============================================================================
// TC-15 ~ TC-19：suggestedCommand 参数沙箱校验
//
// 测试目标：
// - 验证 shell 元字符被拦截
// - 验证 --task-file/--project-root 等路径选项指向项目外时被拦截
// - 验证绝对路径、~ 展开、路径穿越等非法参数被拦截
// - 验证项目内合法路径参数可通过
//
// 安全策略：参数沙箱是白名单之外的第二道防线，防止 LLM 通过命令参数逃逸。
// ============================================================================

// TC-15：command 包含 shell 元字符
// 期望：metadata.suggestedCommand === undefined
test("TC-15: suggestedCommand 包含 shell 元字符时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/team dispatch; rm -rf /" },
    },
    createContext("tc-15", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// TC-16：--task-file 指向项目外绝对路径
// 期望：metadata.suggestedCommand === undefined
test("TC-16: --task-file 指向项目外绝对路径时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/team dispatch --task-file /etc/passwd" },
    },
    createContext("tc-16", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// TC-17：--task-file 指向项目内绝对路径
// 期望：metadata.suggestedCommand 保留（项目内路径合法）
test("TC-17: --task-file 指向项目内绝对路径时应被允许", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/team dispatch --task-file /tmp/tasks/design.json" },
    },
    createContext("tc-17", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: { command?: string } } | undefined;
  assert.equal(metadata?.suggestedCommand?.command, "/team dispatch --task-file /tmp/tasks/design.json");
});

// TC-18：参数包含路径穿越 ".."
// 期望：metadata.suggestedCommand === undefined
test("TC-18: 参数包含 .. 路径穿越时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/team dispatch --role ../evil" },
    },
    createContext("tc-18", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});

// TC-19：参数包含 ~ home 目录展开
// 期望：metadata.suggestedCommand === undefined
test("TC-19: 参数包含 ~ home 目录展开时应被拒绝", async () => {
  const result = await handleAskUserQuestionTool(
    {
      questions: sampleQuestions(),
      suggestedCommand: { command: "/team dispatch --task-file ~/.ssh/id_rsa" },
    },
    createContext("tc-19", "/tmp")
  );

  assert.equal(result.ok, true);
  const metadata = result.metadata as { suggestedCommand?: unknown } | undefined;
  assert.equal(metadata?.suggestedCommand, undefined);
});
