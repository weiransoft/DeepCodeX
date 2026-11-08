/**
 * memory-search-api.ts — GET /api/memory/search（按需记忆检索）
 *
 * 认证：路由挂在 server.ts 全局 JWT 门禁之后，自动继承认证。
 * 隔离：默认用 --source-prefix 限定到当前用户引擎数据根（skillsHomeForUser），
 *       不接受 URL 覆盖，避免跨用户越权读取。
 * 降级：CLI 不可用 503、调用失败 502，均带具体 reason/hint，绝不返回假成功。
 */

import type { ServerResponse } from "node:http";
import { MEMSEARCH_INSTALL_HINT, expandMemories, probeMemsearch, searchMemories } from "@vegamo/deepcode-core";
import { sendJson } from "../http-utils";
import { skillsHomeForUser } from "../engine-home";
import type { ResolvedWebSettings } from "../types";
import type { AuthContext } from "../user-identity";

const MAX_RESULTS = 50;
const PREVIEW_CHARS = 300;

function parseTopK(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, MAX_RESULTS);
}

function preview(content: string): string {
  return content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content;
}

export async function handleMemorySearch(
  res: ServerResponse,
  ctx: AuthContext,
  settings: ResolvedWebSettings,
  url: URL
): Promise<void> {
  const query = (url.searchParams.get("q") ?? "").trim();
  const expandHash = (url.searchParams.get("expand") ?? "").trim();
  if (!query && !expandHash) {
    sendJson(res, 400, {
      ok: false,
      error: "缺少查询参数：请提供 q=<检索文本> 或 expand=<chunk_hash>",
    });
    return;
  }

  const probe = await probeMemsearch();
  if (!probe.ok) {
    sendJson(res, 503, {
      ok: false,
      status: "unavailable",
      reason: probe.reason,
      hint: `安装：${MEMSEARCH_INSTALL_HINT}`,
      userId: ctx.userId,
    });
    return;
  }

  // per-user 隔离：只检索 source 落在当前用户引擎数据根下的 chunk
  const sourcePrefix = skillsHomeForUser(settings, ctx.userId);
  const collection = (url.searchParams.get("collection") ?? "").trim() || undefined;

  if (expandHash) {
    const outcome = await expandMemories({ chunkHash: expandHash, collection });
    if (!outcome.ok) {
      sendJson(res, 502, {
        ok: false,
        status: outcome.status,
        reason: outcome.reason,
        hint: outcome.hint,
        cliVersion: outcome.cliVersion,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      status: "ok",
      action: "expand",
      reason: outcome.reason,
      cliVersion: outcome.cliVersion,
      expansion: outcome.expansion,
    });
    return;
  }

  const outcome = await searchMemories({
    query,
    topK: parseTopK(url.searchParams.get("top_k")),
    collection,
    sourcePrefix,
  });
  if (!outcome.ok) {
    sendJson(res, 502, {
      ok: false,
      status: outcome.status,
      reason: outcome.reason,
      hint: outcome.hint,
      cliVersion: outcome.cliVersion,
      sourcePrefix,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    status: "ok",
    action: "search",
    reason: outcome.reason,
    cliVersion: outcome.cliVersion,
    sourcePrefix,
    droppedCount: outcome.droppedCount,
    results: outcome.results.map((r) => ({
      chunk_hash: r.chunk_hash,
      heading: r.heading,
      source: r.source,
      score: r.score,
      start_line: r.start_line,
      end_line: r.end_line,
      preview: preview(r.content),
    })),
  });
}
