/**
 * agent 工具注入与追踪单测（T01）
 *
 * 测试覆盖（对应 T01 验收②）：
 *   - handleAgentTool：zod strictObject 校验（空 name / 未知字段拒绝）；
 *   - 缺 onLoadAgent hook → 失败；hook 返回 false → 失败；hook 返回 true → 成功；
 *   - ToolExecutor 注册与 onLoadAgent 钩子透传（agent 工具调用走装配点）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAgentTool } from "../tools/agent-handler";
import { ToolExecutor } from "../tools/executor";
import type { ToolExecutionContext } from "../common/tool-types";

// ============================================================================
// handleAgentTool 直测
// ============================================================================

/** 构造最小 ToolExecutionContext（仅 agent handler 所需字段） */
function createContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: "test-session",
    projectRoot: "/tmp/agent-tool-test",
    toolCall: { id: "call-1", type: "function", function: { name: "agent", arguments: "{}" } },
    ...overrides,
  };
}

test("handleAgentTool 缺 onLoadAgent hook 时失败（中文错误信息）", async () => {
  const result = await handleAgentTool({ name: "code-reviewer" }, createContext());
  assert.equal(result.ok, false);
  assert.equal(result.name, "agent");
  assert.match(result.error ?? "", /Agent loading is not available/);
});

test("handleAgentTool hook 返回 true 时成功", async () => {
  const loadedNames: string[] = [];
  const result = await handleAgentTool(
    { name: "code-reviewer" },
    createContext({
      onLoadAgent: async (agentName) => {
        loadedNames.push(agentName);
        return true;
      },
    })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(loadedNames, ["code-reviewer"]);
  assert.match(result.output ?? "", /Agent loaded: code-reviewer/);
});

test("handleAgentTool hook 返回 false 时失败（Unknown agent）", async () => {
  const result = await handleAgentTool(
    { name: "ghost-agent" },
    createContext({
      onLoadAgent: async () => false,
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unknown agent: ghost-agent/);
});

test("handleAgentTool 拒绝空 name（zod 校验）", async () => {
  const result = await handleAgentTool({ name: "  " }, createContext({ onLoadAgent: async () => true }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /InputValidationError/);
});

test("handleAgentTool 拒绝未知字段（strictObject 白名单）", async () => {
  const result = await handleAgentTool(
    { name: "code-reviewer", payload: "evil" },
    createContext({ onLoadAgent: async () => true })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /InputValidationError/);
});

// ============================================================================
// ToolExecutor 注册与钩子透传
// ============================================================================

test("ToolExecutor 注册 agent 工具并透传 onLoadAgent 钩子", async () => {
  const executor = new ToolExecutor("/tmp/agent-tool-test");
  const loadedNames: string[] = [];
  const executions = await executor.executeToolCalls(
    "test-session",
    [
      {
        id: "call-agent-1",
        type: "function",
        function: { name: "agent", arguments: JSON.stringify({ name: "doc-writer" }) },
      },
    ],
    {
      onLoadAgent: async (agentName) => {
        loadedNames.push(agentName);
        return true;
      },
    }
  );

  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.result.ok, true);
  assert.deepEqual(loadedNames, ["doc-writer"]);
});

test("ToolExecutor 未注入 onLoadAgent 钩子时 agent 工具失败", async () => {
  const executor = new ToolExecutor("/tmp/agent-tool-test");
  const executions = await executor.executeToolCalls("test-session", [
    {
      id: "call-agent-2",
      type: "function",
      function: { name: "agent", arguments: JSON.stringify({ name: "doc-writer" }) },
    },
  ]);

  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.result.ok, false);
});
