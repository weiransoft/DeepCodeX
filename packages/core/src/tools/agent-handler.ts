/**
 * agent 工具 handler（T01，架构 §3）
 *
 * 镜像 skill-handler：zod strictObject 校验 + 走 context.onLoadAgent 装配点注入角色约束。
 * 缺 hook / 加载失败均返回 ok:false（fail-safe，不抛出中断会话）。
 *
 * @module tools/agent-handler
 */

import { z } from "zod";
import type { ToolExecutionContext, ToolExecutionResult } from "../common/tool-types";
import { executeValidatedTool } from "../common/validate";

const agentSchema = z.strictObject({
  name: z.string().trim().min(1, "name must not be empty."),
});

export async function handleAgentTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return executeValidatedTool("agent", agentSchema, args, context, async (input, toolContext) => {
    if (!toolContext.onLoadAgent) {
      return {
        ok: false,
        name: "agent",
        error: "Agent loading is not available in this context.",
      };
    }
    const loaded = await toolContext.onLoadAgent(input.name);
    if (!loaded) {
      return {
        ok: false,
        name: "agent",
        error: `Unknown agent: ${input.name}. Check the available agents index for exact agent names.`,
      };
    }
    return {
      ok: true,
      name: "agent",
      output: `Agent loaded: ${input.name}. Follow the injected role constraints for the current task.`,
    };
  });
}
