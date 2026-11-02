/**
 * 全局规则管理端点（设置抽屉「全局规则」页签）：
 *
 * - GET    /api/rules      → { rules: UserRule[] }（按创建顺序，前端自行分组展示）
 * - POST   /api/rules      → 添加一条规则（content 必填；severity/category 可选）
 * - DELETE /api/rules/:id  → 删除一条规则（ID 形如 USER-001）
 *
 * 存储位置与会话注入同源（保证「配置的」=「生效的」）：
 * - personalOnly=true（桌面默认）：<engineHomeRoot>/<userId>/.deepcodeX/rules/global-rules.json
 *   —— 与 SessionManager 的 homeDir 注入值逐字一致，新建会话即读到；
 * - personalOnly=false（旧行为）：<homedir>/.deepcodeX/rules/global-rules.json
 *   —— 与 CLI /rules 命令同一文件。
 *
 * 增删查复用 core global-rules 助手（容错读 / USER-xxx ID 生成 / 上限保护），
 * 与 CLI `deepcode rules add` 落盘语义完全一致（source=user-explicit, confirmedBy=auto）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { addGlobalRule, deleteGlobalRule, readGlobalRulesFile, type UserRule } from "@vegamo/deepcode-core";
import { engineHomeForUser } from "../engine-home";
import { readJsonBody, sendJson } from "../http-utils";
import type { AuthContext } from "../user-identity";
import type { ResolvedWebSettings } from "../types";

/** GET /api/rules 响应体 */
export type RulesListResponse = {
  rules: UserRule[];
};

/** POST /api/rules 请求体 */
type CreateRuleInput = {
  content?: unknown;
  severity?: unknown;
  category?: unknown;
};

/**
 * 计算当前用户的规则文件所属引擎数据家目录
 *
 * 与 session-pool.ts 创建 SessionManager 的 homeDir 注入逻辑对齐：
 * personalOnly=true → <engineHomeRoot>/<userId>；否则回退进程家目录（与 CLI 同源）。
 *
 * @param resolved 归一后的 Web 配置（提供 personalOnly / engineHomeRoot）
 * @param ctx 认证上下文（提供 userId）
 * @returns 引擎数据家目录绝对路径
 */
function engineHomeFor(resolved: ResolvedWebSettings, ctx: AuthContext): string {
  // 与 capability-api / chat-api / audit-api 共用同一实现（D4 收敛点）
  return engineHomeForUser(resolved, ctx.userId);
}

/**
 * 处理 GET /api/rules（已认证）：列出当前用户的全局规则
 *
 * @param res 响应对象
 * @param resolved 归一后的 Web 配置
 * @param ctx 认证上下文
 */
export async function handleListRules(
  res: ServerResponse,
  resolved: ResolvedWebSettings,
  ctx: AuthContext
): Promise<void> {
  const rules = readGlobalRulesFile(engineHomeFor(resolved, ctx));
  sendJson(res, 200, { rules } satisfies RulesListResponse);
}

/**
 * 处理 POST /api/rules（已认证）：添加一条全局规则
 *
 * 校验：content 必须为非空字符串（服务端再 trim，防纯空白）；severity/category
 * 非法值由 core 助手按缺省归一（不报错，宽容输入）。
 * 错误映射：空/超长/超上限 → 400（core 抛 Error，消息透传给前端展示）。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param resolved 归一后的 Web 配置
 * @param ctx 认证上下文
 */
export async function handleCreateRule(
  req: IncomingMessage,
  res: ServerResponse,
  resolved: ResolvedWebSettings,
  ctx: AuthContext
): Promise<void> {
  const body = await readJsonBody(req);
  const input = body as CreateRuleInput;
  if (typeof input.content !== "string" || input.content.trim() === "") {
    sendJson(res, 400, { error: "规则内容不能为空" });
    return;
  }
  try {
    const rule = addGlobalRule(engineHomeFor(resolved, ctx), {
      content: input.content,
      severity: typeof input.severity === "string" ? input.severity : undefined,
      category: typeof input.category === "string" ? input.category : undefined,
    });
    sendJson(res, 201, { rule });
  } catch (error) {
    const message = error instanceof Error ? error.message : "规则添加失败";
    sendJson(res, 400, { error: message });
  }
}

/**
 * 处理 DELETE /api/rules/:id（已认证）：删除一条全局规则
 *
 * @param res 响应对象
 * @param ruleId 规则 ID（路由层从 pathname 提取）
 * @param resolved 归一后的 Web 配置
 * @param ctx 认证上下文
 */
export async function handleDeleteRule(
  res: ServerResponse,
  ruleId: string,
  resolved: ResolvedWebSettings,
  ctx: AuthContext
): Promise<void> {
  const deleted = deleteGlobalRule(engineHomeFor(resolved, ctx), ruleId);
  if (!deleted) {
    sendJson(res, 404, { error: `规则 ${ruleId} 不存在` });
    return;
  }
  sendJson(res, 200, { ok: true });
}
