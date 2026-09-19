/**
 * 聊天端点（docs/dev/web-ui.md §3.5）。
 *
 * - GET  /api/chats：会话列表（池内活跃 + 磁盘历史合并）
 * - POST /api/chats：新建会话 {projectRoot, sessionId?}（projectRoot 必须在 allowRoots 内）
 * - GET  /api/chats/:id/messages：历史消息（刷新恢复）
 * - POST /api/chats/:id/messages：发送消息；Content-Type 为 multipart/form-data 时
 *   附件随消息上传（图片转 imageUrls 的 file:// URL，其他文件落盘并在文本中附说明）
 * - GET  /api/chats/:id/stream：SSE 事件流（llm_delta / assistant_message /
 *   permission_request / status / done）
 * - POST /api/chats/:id/interrupt：停止生成（interruptActiveSession）
 */

import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PermissionScope, UserToolPermission } from "@vegamo/deepcode-core";
import { parseMultipartRequest, MultipartError } from "../multipart";
import { ApiError, readJsonBody, sendJson } from "../http-utils";
import type { SessionPool, SendMessageInput } from "../session-pool";
import type { SseHub } from "../events";
import type { ResolvedWebSettings, SendMessageResponse } from "../types";
const IMAGE_MIME_PREFIX = "image/";

/**
 * 处理 GET /api/chats：返回合并后的会话列表。
 *
 * @param res 响应对象
 * @param pool 会话池
 */
export function handleListChats(res: ServerResponse, pool: SessionPool): void {
  sendJson(res, 200, { chats: pool.listChats() });
}

/**
 * 处理 POST /api/chats：创建新会话。
 *
 * @param req 请求对象（JSON：{projectRoot, sessionId?}）
 * @param res 响应对象
 * @param pool 会话池
 */
export async function handleCreateChat(req: IncomingMessage, res: ServerResponse, pool: SessionPool): Promise<void> {
  const body = await readJsonBody<{ projectRoot?: unknown; sessionId?: unknown }>(req);
  if (typeof body.projectRoot !== "string" || body.projectRoot.trim() === "") {
    throw new ApiError(400, "请求体必须包含非空 projectRoot 字符串");
  }
  const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;
  const created = await pool.createChat(body.projectRoot, sessionId);
  sendJson(res, 200, created);
}

/**
 * 处理 GET /api/chats/:id/messages：返回会话历史消息。
 *
 * @param res 响应对象
 * @param pool 会话池
 * @param chatId Web 会话 id
 */
export function handleGetMessages(res: ServerResponse, pool: SessionPool, chatId: string): void {
  sendJson(res, 200, { messages: pool.getMessages(chatId) });
}

/**
 * 处理 GET /api/chats/:id/stream：建立 SSE 事件流。
 *
 * 订阅建立后立即推送一次当前状态快照（status 事件），
 * 让前端刷新/重连后能同步会话状态与待审批卡片。
 *
 * @param res 响应对象
 * @param pool 会话池
 * @param hub SSE 总线
 * @param chatId Web 会话 id
 */
export function handleStream(res: ServerResponse, pool: SessionPool, hub: SseHub, chatId: string): void {
  // 会话不存在时直接 404（不进入 SSE）
  pool.getChatInfo(chatId);
  hub.subscribe(chatId, res);
  // 初始状态快照：让新订阅者立即获得当前 status 与待审批明细
  const summary = pool.listChats().find((chat) => chat.chatId === chatId);
  hub.publish(chatId, "status", {
    chatId,
    status: summary?.status ?? "pending",
    askPermissions: null,
  });
}

/**
 * 处理 POST /api/chats/:id/interrupt：中断当前生成。
 *
 * @param res 响应对象
 * @param pool 会话池
 * @param chatId Web 会话 id
 */
export function handleInterrupt(res: ServerResponse, pool: SessionPool, chatId: string): void {
  pool.interrupt(chatId);
  sendJson(res, 200, { ok: true });
}

/**
 * 校验并归一 JSON 请求中的 permissions 字段（审批回注决策）。
 *
 * @param raw 请求体中的原始 permissions 值
 * @returns 合法的 UserToolPermission 列表（字段缺失/非法时抛 400）
 */
function parsePermissions(raw: unknown): UserToolPermission[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'permissions 必须是数组，元素形如 {toolCallId, permission: "allow"|"deny"}');
  }
  return raw.map((item) => {
    if (item === null || typeof item !== "object") {
      throw new ApiError(400, "permissions 元素必须是对象");
    }
    const record = item as Record<string, unknown>;
    const toolCallId = record["toolCallId"];
    const permission = record["permission"];
    if (typeof toolCallId !== "string" || toolCallId === "") {
      throw new ApiError(400, "permissions 元素缺少非空 toolCallId");
    }
    if (permission !== "allow" && permission !== "deny") {
      throw new ApiError(400, `permissions 元素的 permission 必须为 "allow" 或 "deny"（得到：${String(permission)}）`);
    }
    return { toolCallId, permission };
  });
}

/**
 * 校验并归一 JSON 请求中的 alwaysAllows 字段（本轮起永久放行的 scope 列表）。
 *
 * @param raw 请求体中的原始 alwaysAllows 值
 * @returns 字符串数组（元素必须非空字符串）
 */
function parseAlwaysAllows(raw: unknown): PermissionScope[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item === "")) {
    throw new ApiError(400, "alwaysAllows 必须是非空字符串数组");
  }
  return raw as PermissionScope[];
}

/**
 * 处理 POST /api/chats/:id/messages。
 *
 * 两种请求形态：
 * 1. application/json：{text?, imageUrls?, permissions?, alwaysAllows?}（1MB 上限）；
 * 2. multipart/form-data：文本字段 text（+可选 payload JSON 字段携带 permissions/alwaysAllows）
 *    + 一个或多个 file 字段。图片（image/*）转为 file:// URL 进入 imageUrls，
 *    其他文件落盘 uploadDir 并在文本中追加「附件：文件名（路径）」说明（供 LLM Read 工具读取）。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param pool 会话池
 * @param settings Web 配置（uploadDir / maxUploadBytes）
 * @param chatId Web 会话 id
 */
export async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  pool: SessionPool,
  settings: ResolvedWebSettings,
  chatId: string
): Promise<void> {
  // 先校验会话存在（404 优先于 body 解析错误）
  pool.getChatInfo(chatId);

  const contentType = req.headers["content-type"] ?? "";
  let input: SendMessageInput;

  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    // —— multipart 形态：消息 + 附件 ——
    let parsed;
    try {
      parsed = await parseMultipartRequest(req, {
        uploadDir: settings.uploadDir,
        maxUploadBytes: settings.maxUploadBytes,
      });
    } catch (error) {
      if (error instanceof MultipartError) {
        // PAYLOAD_TOO_LARGE / FIELD_TOO_LARGE → 413，其余 → 400
        throw new ApiError(
          error.code === "PAYLOAD_TOO_LARGE" || error.code === "FIELD_TOO_LARGE" ? 413 : 400,
          error.message
        );
      }
      throw error;
    }

    const text = (parsed.fields["text"] ?? "").trim();
    let permissions: UserToolPermission[] = [];
    let alwaysAllows: PermissionScope[] = [];
    // 可选 payload 字段：JSON 携带 permissions/alwaysAllows（与 JSON 形态字段语义一致）
    const payloadRaw = parsed.fields["payload"];
    if (payloadRaw !== undefined && payloadRaw.trim() !== "") {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        throw new ApiError(400, "payload 字段不是合法 JSON");
      }
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        permissions = parsePermissions(record["permissions"]);
        alwaysAllows = parseAlwaysAllows(record["alwaysAllows"]);
      }
    }

    // 附件分流：图片进 imageUrls（file:// URL，core 多模态链路可读盘）；
    // 其他文件仅落盘并在文本中附说明（LLM 可用 Read 工具按绝对路径读取）
    const imageUrls: string[] = [];
    const attachmentNotes: string[] = [];
    for (const file of parsed.files) {
      const mime = file.mimeType ?? "";
      if (mime.startsWith(IMAGE_MIME_PREFIX)) {
        imageUrls.push(pathToFileURL(file.savedPath).href);
        continue;
      }
      attachmentNotes.push(`附件：${file.originalName}（${file.savedPath}）`);
    }
    const composedText = [text, ...attachmentNotes].filter((part) => part !== "").join("\n\n");

    // 空消息防御（对齐 JSON 形态）：multipart 形态下无文本且无任何附件的请求无意义
    // （composedText 已包含附件说明，二者同时为空即「无 text 且无附件」）
    if (composedText === "" && imageUrls.length === 0) {
      throw new ApiError(400, "消息内容为空：需要 text 或至少一个附件");
    }

    input = {
      text: composedText === "" ? undefined : composedText,
      imageUrls,
      permissions,
      alwaysAllows,
    };
  } else {
    // —— JSON 形态 ——
    const body = await readJsonBody<{
      text?: unknown;
      imageUrls?: unknown;
      permissions?: unknown;
      alwaysAllows?: unknown;
    }>(req);
    // text 校验：可选字符串
    let text: string | undefined;
    if (body.text !== undefined && body.text !== null) {
      if (typeof body.text !== "string") {
        throw new ApiError(400, "text 必须是字符串");
      }
      text = body.text;
    }
    // imageUrls 校验：可选字符串数组（data:/file:/http(s) 均交由 core 处理）
    let imageUrls: string[] | undefined;
    if (body.imageUrls !== undefined && body.imageUrls !== null) {
      if (!Array.isArray(body.imageUrls) || body.imageUrls.some((item) => typeof item !== "string")) {
        throw new ApiError(400, "imageUrls 必须是字符串数组");
      }
      imageUrls = body.imageUrls as string[];
    }
    input = {
      text,
      imageUrls,
      permissions: parsePermissions(body.permissions),
      alwaysAllows: parseAlwaysAllows(body.alwaysAllows),
    };
    // 空消息防御：无文本、无图片、无审批决策的请求无意义
    if (
      (input.text === undefined || input.text === "") &&
      (input.imageUrls === undefined || input.imageUrls.length === 0) &&
      (input.permissions ?? []).length === 0
    ) {
      throw new ApiError(400, "消息内容为空：需要 text / imageUrls / permissions 之一");
    }
  }

  // 202 异步受理：入队串行链后立即返回（不等待轮次完成），
  // 本轮 llm_delta/assistant_message/tool_progress/permission_request/status/done
  // 全部经 SSE 推送，最终状态以 done 载荷为准
  const accepted = pool.sendMessage(chatId, input);
  const response: SendMessageResponse = { ok: true, chatId: accepted.chatId, sessionId: accepted.sessionId };
  sendJson(res, 202, response);
}
