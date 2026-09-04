/**
 * query-execution-history-tool.ts — query_execution_history LLM 工具
 *
 * 一期 US-EH-004：让 LLM 在任务中动态查询本项目执行历史。
 * 用途：当 LLM 想知道"这个项目最近跑过什么命令"、"之前的构建为什么失败"、
 *       "有没有人试过某个方案"时，主动调用这个工具查询。
 *
 * 工具注册：
 * - ToolDefinition 通过 getQueryExecutionHistoryToolDefinition() 返回
 * - 在 SessionManager 构造时初始化，通过 getTools(options, externalTools) 追加
 * - 见 session.ts historyToolDefinition 字段
 *
 * 工具执行：
 * - handler 通过 executor.registerToolHandler("query_execution_history", handler) 注册
 * - handler 内部调用 ExecutionHistoryStore.buildToolQueryResult()
 * - store 实例从 SessionManager 传入（构造时注入）
 *
 * 文档：templates/tools/query-execution-history.md（getSystemPrompt 自动扫描）
 *
 * Anchor 文件零改动：本文件不依赖 executor.ts / prompt.ts / tool-types.ts
 */

import type { ExecutionHistoryStore } from "./execution-history-store";
import type { ExecutionHistoryQuery, QueryExecutionHistoryToolArgs } from "./execution-history-types";
// P1-05 单一入口约束：V1 ToolDefinition 类型统一从 v1-adapters 导入（§16）
import type { ToolDefinition } from "../integration/v1-adapters";

/**
 * query_execution_history 工具的 ToolDefinition
 * —— 格式严格对齐 prompt.ts getTools 里的既有工具（type/function.name/function.description/function.parameters）
 * —— 直接传给 getTools 的 externalTools 参数
 */
export function getQueryExecutionHistoryToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "query_execution_history",
      description:
        "Query the execution history of tool runs (bash, write, edit, skill) in this project. " +
        "Returns a structured list of past tool executions including command, result, exit code, cwd, " +
        "and duration. Use this to find what commands were run recently, what worked or failed, " +
        "or to locate a specific past execution by keyword. Results are ordered by time descending " +
        "(newest first) by default.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Filter by specific session ID. Optional — omit for project-wide search.",
          },
          toolName: {
            type: "string",
            description:
              'Filter by tool name. Use "bash", "read", "write", "edit", "skill", "AskUserQuestion", etc. Optional.',
          },
          lastDays: {
            type: "number",
            description: "Only return records from the last N days. Default: all history.",
          },
          ok: {
            type: "boolean",
            description: "Filter by success/failure. true = only successes, false = only failures.",
          },
          keyword: {
            type: "string",
            description: "Case-insensitive substring search across command args, output, and working directory.",
          },
          limit: {
            type: "number",
            description: "Maximum number of records to return. Default: 200.",
          },
        },
        additionalProperties: false,
      },
    },
  };
}

/**
 * 构建 query_execution_history handler 的参数
 * —— handler 需要 ExecutionHistoryStore 实例来查询数据
 */
export interface QueryExecutionHistoryHandlerDeps {
  store: ExecutionHistoryStore;
}

/**
 * query_execution_history 工具的实际执行 handler
 * —— 将 LLM 传来的 args 转换为 ExecutionHistoryQuery
 * —— 调用 store.buildToolQueryResult() 获取结构化结果
 * —— 返回标准 ToolExecutionResult（ok + output 为 JSON 字符串）
 *
 * @param deps 依赖注入（store 实例）
 */
export function createQueryExecutionHistoryHandler(deps: QueryExecutionHistoryHandlerDeps) {
  return async function queryExecutionHistoryHandler(
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    try {
      // 从 LLM 传来的 args 里提取查询参数，构建 ExecutionHistoryQuery
      const query: ExecutionHistoryQuery = {};

      if (typeof args.sessionId === "string" && args.sessionId.length > 0) {
        query.sessionId = args.sessionId;
      }
      if (typeof args.toolName === "string" && args.toolName.length > 0) {
        query.toolName = args.toolName;
      }
      if (typeof args.lastDays === "number" && args.lastDays > 0) {
        query.lastDays = args.lastDays;
      }
      if (typeof args.ok === "boolean") {
        query.ok = args.ok;
      }
      if (typeof args.keyword === "string" && args.keyword.length > 0) {
        query.keyword = args.keyword;
      }
      if (typeof args.limit === "number" && args.limit > 0 && args.limit <= 1000) {
        query.limit = args.limit;
      } else {
        query.limit = 50; // LLM 默认返回少一些，避免刷屏
      }

      // 调用 store 的 tool 查询接口（结构化输出给 LLM）
      const result = deps.store.buildToolQueryResult(query);

      return {
        ok: result.ok,
        name: "query_execution_history",
        output: JSON.stringify(result, null, 2),
        error: result.ok ? undefined : result.error,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        name: "query_execution_history",
        error: `Query execution history failed: ${message}`,
      };
    }
  };
}

/**
 * 类型别名——供外部引用 handler 参数
 */
export type QueryExecutionHistoryHandlerArgs = QueryExecutionHistoryToolArgs;
