/**
 * 沉淀建议端点（ARCH-20261027 T04）。
 *
 * - GET  /api/sedimentation/suggestions?chatId=：拉取该会话待处置建议
 * - POST /api/sedimentation/confirm {chatId, suggestionId, scope}：确认落盘
 *   （SedimentationWriter 五条安全门槛，scope=user 落 ~/.deepcode/skills，
 *   scope=project 落 <会话 projectRoot>/.deepcode/skills）
 * - POST /api/sedimentation/dismiss {chatId, suggestionId}：忽略（204，
 *   同指纹本会话不再建议）
 *
 * 全部端点校验会话归属（仅本人会话可操作，与 chats 端点同隔离纪律）。
 * 建议正文不落服务端持久层：进程内存 + SSE 推送 + 拉取兜底（与 EAG 建议
 * 同生命周期——进程重启后由后续轮次分析重新产出）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SedimentationScope } from "@vegamo/deepcode-core";
import { ApiError, readJsonBody, sendJson } from "../http-utils";
import type { SessionPool } from "../session-pool";
import type { AuthContext } from "../user-identity";

/**
 * 处理 GET /api/sedimentation/suggestions。
 *
 * @param res 响应对象
 * @param pool 会话池
 * @param chatId 查询参数 chatId（缺失/非法 → 400）
 * @param ctx 认证上下文（归属校验）
 */
export function handleGetSedimentationSuggestions(
  res: ServerResponse,
  pool: SessionPool,
  chatId: string | null,
  ctx: AuthContext
): void {
  if (chatId === null || chatId.trim() === "") {
    throw new ApiError(400, "查询参数 chatId 不能为空");
  }
  sendJson(res, 200, { suggestions: pool.getSedimentationSuggestions(chatId, ctx) });
}

/**
 * 解析 confirm/dismiss 请求体的公共字段（chatId + suggestionId，均必填非空）。
 *
 * @param body JSON 请求体
 * @returns 归一后的 chatId / suggestionId
 */
function parseSuggestionRef(body: Record<string, unknown>): { chatId: string; suggestionId: string } {
  const chatId = typeof body["chatId"] === "string" ? body["chatId"].trim() : "";
  const suggestionId = typeof body["suggestionId"] === "string" ? body["suggestionId"].trim() : "";
  if (chatId === "" || suggestionId === "") {
    throw new ApiError(400, "请求体必须包含非空 chatId 与 suggestionId 字符串");
  }
  return { chatId, suggestionId };
}

/**
 * 处理 POST /api/sedimentation/confirm：确认沉淀建议并落盘。
 *
 * 落盘语义与 CLI /sediment-confirm 一致（SedimentationWriter 五条安全门槛）；
 * 返回 WriteResult（ok:false 时附 reason/message，前端展示失败原因，
 * 建议保留待重试；ok:true 时建议移出待处置集合）。
 *
 * @param req 请求对象（JSON：{chatId, suggestionId, scope?}，scope 缺省 "user"）
 * @param res 响应对象
 * @param pool 会话池
 * @param ctx 认证上下文（归属校验）
 */
export async function handleConfirmSedimentation(
  req: IncomingMessage,
  res: ServerResponse,
  pool: SessionPool,
  ctx: AuthContext
): Promise<void> {
  const body = await readJsonBody<Record<string, unknown>>(req);
  const { chatId, suggestionId } = parseSuggestionRef(body);
  const scopeRaw = body["scope"];
  let scope: SedimentationScope = "user";
  if (scopeRaw !== undefined && scopeRaw !== null) {
    if (scopeRaw !== "user" && scopeRaw !== "project") {
      throw new ApiError(400, 'scope 必须是 "user" 或 "project"');
    }
    scope = scopeRaw;
  }
  const result = await pool.confirmSedimentation(chatId, ctx, suggestionId, scope);
  sendJson(res, 200, result);
}

/**
 * 处理 POST /api/sedimentation/dismiss：忽略沉淀建议（204）。
 *
 * 建议移出待处置集合，并向建议器回执指纹（同指纹本会话不再建议，
 * 与 CLI /sediment-dismiss 语义一致）。
 *
 * @param req 请求对象（JSON：{chatId, suggestionId}）
 * @param res 响应对象
 * @param pool 会话池
 * @param ctx 认证上下文（归属校验）
 */
export async function handleDismissSedimentation(
  req: IncomingMessage,
  res: ServerResponse,
  pool: SessionPool,
  ctx: AuthContext
): Promise<void> {
  const body = await readJsonBody<Record<string, unknown>>(req);
  const { chatId, suggestionId } = parseSuggestionRef(body);
  pool.dismissSedimentation(chatId, ctx, suggestionId);
  res.writeHead(204);
  res.end();
}
