/**
 * memory-search-api.ts — GET /api/memory/search（按需记忆检索）
 *
 * 认证：路由挂在 server.ts 全局 JWT 门禁之后，自动继承认证。
 * 隔离：默认用 --source-prefix 限定到当前用户引擎数据根（skillsHomeForUser），
 *       不接受 URL 覆盖，避免跨用户越权读取。
 * 降级：CLI 不可用 503、调用失败 502，均带具体 reason/hint，绝不返回假成功。
 */

import type { ServerResponse } from "node:http";
import path from "node:path";
import { MEMSEARCH_INSTALL_HINT, expandMemories, probeMemsearch, searchMemories } from "@vegamo/deepcode-core";
import { sendJson } from "../http-utils";
import { skillsHomeForUser } from "../engine-home";
import { MEMSEARCH_CORPUS_DIRS_ENV, parseAbsoluteDirs } from "../memsearch-autoindex";
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

/**
 * 路径边界安全的前缀判定：避免 `/home/user2` 被 `/home/user` 误匹配。
 * 索引侧 source 为绝对路径（官方 chunker 写 resolve 后的路径）。
 */
function isUnder(source: string, prefix: string): boolean {
  const s = path.resolve(source);
  const p = path.resolve(prefix);
  if (s === p) return true;
  const withSep = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return s.startsWith(withSep);
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

  // per-user 隔离：只检索 source 落在当前用户引擎数据根下的 chunk。
  // 共享语料根由服务端环境变量声明（与自动索引同源），URL 不可覆盖：
  // 索引了什么、就只允许检索什么，避免跨用户越权或「灌了却查不到」。
  const sourcePrefix = skillsHomeForUser(settings, ctx.userId);
  const sharedRoots = parseAbsoluteDirs(process.env[MEMSEARCH_CORPUS_DIRS_ENV]);
  const allowedPrefixes: readonly string[] = Object.freeze([sourcePrefix, ...sharedRoots]);
  const isAllowedSource = (source: string): boolean =>
    typeof source === "string" && source.length > 0 && allowedPrefixes.some((p) => isUnder(source, p));
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
    // 2026-11-08 安全修复：expand 走 chunk_hash 直取，官方 CLI 不带 --source-prefix。
    // 生产 collection 灌入共享文档后，若不校验归属，任何认证用户都能按 hash
    // 展开他人记忆。这里显式复核 source 必须落在 per-user 根或服务端声明的共享根。
    if (!isAllowedSource(outcome.expansion?.source ?? "")) {
      sendJson(res, 403, {
        ok: false,
        status: "forbidden",
        reason: "该 chunk 不属于当前用户数据根，也不属于服务端声明的共享语料根",
        sourcePrefix,
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

  const topK = parseTopK(url.searchParams.get("top_k"));
  // 声明了共享语料根时改用「本地多前缀过滤」：官方 CLI 的 --source-prefix 只接受
  // 单根，因此不传该 flag、放大召回量后在服务端按允许前缀筛，再截回用户请求的 topK。
  // 未声明共享根时完全走原路径（单行 CLI 前缀过滤），逐字零回归。
  const localFilter = sharedRoots.length > 0;
  const outcome = await searchMemories({
    query,
    topK: localFilter ? Math.min(topK * 3, MAX_RESULTS) : topK,
    collection,
    ...(localFilter ? {} : { sourcePrefix }),
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
  const allowed = localFilter ? outcome.results.filter((r) => isAllowedSource(r.source)) : outcome.results;
  const visible = allowed.slice(0, topK);
  sendJson(res, 200, {
    ok: true,
    status: "ok",
    action: "search",
    reason: outcome.reason,
    cliVersion: outcome.cliVersion,
    sourcePrefix,
    ...(localFilter ? { allowedPrefixes, excludedCount: outcome.results.length - visible.length } : {}),
    droppedCount: outcome.droppedCount,
    results: visible.map((r) => ({
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
