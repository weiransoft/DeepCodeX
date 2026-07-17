/**
 * V2 工具执行前审批钩子
 *
 * 在工具执行前调用 ApprovalGate 进行审批决策，将 ApprovalGate 的三态决策
 * （auto_approve / ask_user / deny）映射为 executor 钩子的三态返回值
 * （approve / ask_user / deny）。
 *
 * 设计依据：
 * - V2-P0a 钩子集成模块
 * - 与 executor.ts 的 onBeforeToolExecution 钩子契约配合
 * - F-07 安全修复：黑名单优先于所有审批模式判断（由 ApprovalGate 内部保证）
 *
 * 钩子契约：
 * - 输入：工具名称 + 工具参数（包含 command / file_path 等）
 * - 输出：审批决策
 *   - "approve"：放行，executor 继续调用 handler
 *   - "deny"：拒绝，executor 直接返回失败结果
 *   - "ask_user"：需用户确认，executor 返回 awaitUserResponse=true 的结果
 */

import type { ApprovalGate } from "../approval/approval-gate";
import { ApprovalDeniedError } from "../approval/approval-denied-error";
import type { ToolRouter } from "../approval/tool-router";
import type { ApprovalContext, ToolCategory } from "../approval/types";

/**
 * 创建工具执行前审批钩子
 *
 * 返回一个符合 ToolExecutionHooks.onBeforeToolExecution 签名的钩子函数，
 * 调用 ApprovalGate.decide 进行审批决策。
 *
 * 用法：
 * ```typescript
 * const gate = new ApprovalGate();
 * const executor = new ToolExecutor(projectRoot);
 * await executor.executeToolCalls(sessionId, toolCalls, {
 *   onBeforeToolExecution: createApprovalBeforeExecutionHook(gate, "agent", "suggest"),
 * });
 * ```
 *
 * @param gate ApprovalGate 实例（封装审批决策逻辑）
 * @param appMode 应用模式：plan / agent / yolo
 * @param approvalMode 审批模式：suggest / auto / never
 * @returns onBeforeToolExecution 钩子函数
 */
export function createApprovalBeforeExecutionHook(
  gate: ApprovalGate,
  appMode: ApprovalContext["appMode"],
  approvalMode: ApprovalContext["approvalMode"]
) {
  // v2.4 修订（P0-05 修复）：返回函数改为 async，签名升级为 Promise<"approve"|"deny"|"ask_user">。
  // 原因：ToolRouter.route() 内部需 await SideGitRecovery 检查与 SideGitManager.createSnapshot
  // 异步调用，因此钩子必须 async 化以支持此调用链。
  // 当前 V2-P0a 阶段 ApprovalGate.decide 为同步调用，但函数声明 async 后，
  // V2-P0b 添加 side-git 异步操作时无需再改签名（向前兼容）。
  return async function approvalBeforeExecutionHook(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<"approve" | "deny" | "ask_user"> {
    // 根据工具名推断工具类型
    // 用于 ApprovalGate 的决策分支选择（readonly / bash / file_edit / file_write / network / mcp）
    const toolCategory = inferToolCategory(toolName);

    // 构建审批上下文
    // - command：仅 bash 工具提供（从 args.command 提取）
    // - filePath：仅 file_write/file_edit 工具提供（从 args.file_path 提取）
    const context: ApprovalContext = {
      toolName,
      toolCategory,
      command: typeof args["command"] === "string" ? (args["command"] as string) : undefined,
      filePath: typeof args["file_path"] === "string" ? (args["file_path"] as string) : undefined,
      appMode,
      approvalMode,
    };

    // 调用 ApprovalGate 决策
    // 严格按 F-07 决策流程执行：黑名单检查 → Plan 模式 → never → auto → suggest 细分
    const result = gate.decide(context);

    // 映射决策结果到钩子返回值
    // - auto_approve → approve：放行执行
    // - deny → deny：拒绝执行
    // - ask_user → ask_user：需用户确认
    if (result.decision === "auto_approve") {
      return "approve";
    }
    if (result.decision === "deny") {
      return "deny";
    }
    return "ask_user";
  };
}

/**
 * 创建 ToolRouter 版工具执行前钩子（V2-P0b：审批 + side-git 快照一体化路由）
 *
 * 与 createApprovalBeforeExecutionHook 的差异：
 * - 本钩子内部走 ToolRouter.route()：审批决策 + snapshotRequired 时自动创建
 *   pre-turn 快照（含损坏检测/自动重建/降级放行，§4.4.3）；
 * - createApprovalBeforeExecutionHook 仅做审批决策，不涉及快照。
 *
 * 决策映射（ToolRouter → executor 钩子三态）：
 * - route() 返回 true → "approve"（快照已按需创建）；
 * - ApprovalDeniedError 且 result.decision === "deny" → "deny"（executor 返回失败）；
 * - ApprovalDeniedError 且 result.decision === "ask_user" → "ask_user"
 *   （executor 设置 awaitUserResponse，由 CLI 的询问流程接管提示）。
 *
 * 集成约定：
 * - 使用本适配器时，ToolRouter 不应注入 askUserCallback（询问 UX 由 executor/CLI
 *   的 awaitUserResponse 流程统一接管，避免重复提示）；
 * - 非 ApprovalDeniedError 异常（如 git 子进程故障）向上传播，不静默吞掉。
 *
 * 用法：
 * ```typescript
 * const router = new ToolRouter(gate, sideGit, recovery);
 * await executor.executeToolCalls(sessionId, toolCalls, {
 *   onBeforeToolExecution: createToolRouterBeforeExecutionHook(router, "agent", "auto", taskId),
 * });
 * ```
 *
 * @param router ToolRouter 实例（审批 + 快照路由）
 * @param appMode 应用模式：plan / agent / yolo
 * @param approvalMode 审批模式：suggest / auto / never
 * @param taskId 关联任务 ID（可选，供 side-git 快照关联与审计串联）
 * @returns onBeforeToolExecution 钩子函数
 */
export function createToolRouterBeforeExecutionHook(
  router: ToolRouter,
  appMode: ApprovalContext["appMode"],
  approvalMode: ApprovalContext["approvalMode"],
  taskId?: string
) {
  return async function toolRouterBeforeExecutionHook(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<"approve" | "deny" | "ask_user"> {
    // 构建审批上下文（与 createApprovalBeforeExecutionHook 保持一致的推断规则）
    const context: ApprovalContext = {
      toolName,
      toolCategory: inferToolCategory(toolName),
      command: typeof args["command"] === "string" ? (args["command"] as string) : undefined,
      filePath: typeof args["file_path"] === "string" ? (args["file_path"] as string) : undefined,
      appMode,
      approvalMode,
      taskId,
    };

    try {
      // 路由：审批决策 + snapshotRequired 时的 pre-turn 快照创建
      await router.route(context);
      return "approve";
    } catch (error) {
      if (error instanceof ApprovalDeniedError) {
        // deny 决策（黑名单/plan 模式限制）→ executor 直接返回失败；
        // ask_user 决策（未注入回调或用户拒绝）→ executor 的询问流程接管
        return error.result.decision === "deny" ? "deny" : "ask_user";
      }
      // 非审批类异常（git 故障等）向上传播，不静默吞掉
      throw error;
    }
  };
}

/**
 * 根据工具名推断工具类型
 *
 * 将工具名映射到 ApprovalGate 决策所需的 ToolCategory 枚举。
 * 决策逻辑因工具类型而异：
 * - readonly：只读，无副作用（plan/never 模式下自动批准）
 * - bash：需进行命令安全检查（黑名单/白名单/风险评分）
 * - file_edit：文件编辑（敏感路径检查）
 * - file_write：文件写入（敏感路径检查）
 * - network/mcp：网络访问或外部工具，默认 ask_user
 *
 * @param toolName 工具名称（区分大小写转换为小写匹配）
 * @returns 工具类型分类
 */
function inferToolCategory(toolName: string): ToolCategory {
  switch (toolName.toLowerCase()) {
    case "read":
      return "readonly";
    case "bash":
      return "bash";
    case "edit":
      return "file_edit";
    case "write":
      return "file_write";
    case "web_search":
      return "network";
    default:
      // MCP 工具命名约定为 "serverName_toolName"（含下划线），视为 mcp 类型
      // 其他未知工具默认视为 readonly（保守策略，由 ApprovalGate 内部决策）
      if (toolName.includes("_")) {
        return "mcp";
      }
      return "readonly";
  }
}
