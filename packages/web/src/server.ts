/**
 * Web 服务器装配（docs/dev/web-ui.md §3.1，node:http 零框架路由）。
 *
 * 职责：
 * 1. 路由分发：/api/auth/login 与静态资源免认证，其余 /api/* 经 JWT 中间件；
 * 2. GET /api/config：脱敏配置（绝不返回 jwtSecret/bindPassword 等密钥）；
 * 3. 静态资源：服务 packages/web/web/dist（存在时），SPA fallback index.html；
 *    dist 不存在时返回中文提示页（后端先行可用，前端构建后自动生效）；
 * 4. startWebServer(resolved, opts) 返回 {server, port, close()}；
 *    listen(0) 支持测试随机端口；close() 优雅收敛 SSE/会话池/连接。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SseHub } from "./events";
import { ApiError, sendJson } from "./http-utils";
import { buildJailRoots, realpathAllowMissing } from "./jail";
import { expandHomePath } from "./config";
import { authenticateRequest } from "./auth/middleware";
import { buildAuthContext, type AuthContext } from "./user-identity";
import { getPersonalJailRoots } from "./user-files";
import { handleLogin, handleLogout, handleMe } from "./api/auth-api";
import {
  handleCreateChat,
  handleGetMessages,
  handleInterrupt,
  handleListChats,
  handleSendMessage,
  handleStream,
} from "./api/chat-api";
import { handleDownloadFile, handleListFiles, handlePreviewFile, handleUploadFile } from "./api/files-api";
import { SessionPool, type SessionPoolOptions } from "./session-pool";
import type { PublicWebConfig, ResolvedWebSettings } from "./types";

/** startWebServer 选项（依赖注入缝合点透传） */
export type WebServerOptions = SessionPoolOptions & {
  /**
   * 静态资源目录覆写（测试注入临时 dist 目录）。
   * 未指定时使用 packages/web/web/dist。
   */
  staticDir?: string;
};

/** 运行中的 Web 服务器句柄 */
export type RunningWebServer = {
  /** Node HTTP 服务器实例 */
  server: Server;
  /** 实际监听端口（listen(0) 时为随机分配端口） */
  port: number;
  /**
   * 优雅关闭：先关 SSE 订阅与会话池，再关闭 HTTP 服务并断开空闲连接。
   */
  close: () => Promise<void>;
  /** 会话池（测试/运维观测用） */
  pool: SessionPool;
  /** SSE 总线（测试用） */
  hub: SseHub;
};

/** 静态资源 MIME 映射（覆盖前端构建产物类型） */
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 计算默认静态资源目录：packages/web/web/dist（src 与 dist 布局下均成立）。
 *
 * @returns dist 目录绝对路径
 */
function defaultStaticDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
}

/**
 * 写出静态资源提示页（dist 不存在时）。
 *
 * @param res 响应对象
 * @param port 当前监听端口
 */
function sendPlaceholderPage(res: ServerResponse, port: number): void {
  const html = [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>DeepCodeX Web</title></head>',
    '<body style="font-family: sans-serif; max-width: 640px; margin: 80px auto; color: #333;">',
    "<h1>DeepCodeX Web UI 尚未构建</h1>",
    `<p>Web 后端已在端口 ${port} 正常运行，但前端静态资源目录（packages/web/web/dist）尚不存在。</p>`,
    "<p>请在仓库根目录执行前端构建后刷新本页；或使用 REST/SSE 接口接入你自己的客户端。</p>",
    "</body></html>",
  ].join("\n");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

/** 内置 favicon（对话气泡 SVG，消除 dist 无图标文件时的 404 噪音） */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<rect x="1" y="2" width="14" height="10" rx="3" fill="#4f8ef7"/>' +
  '<path d="M5 12 L5 15 L9 12 Z" fill="#4f8ef7"/>' +
  '<circle cx="5.5" cy="7" r="1.2" fill="#fff"/>' +
  '<circle cx="8" cy="7" r="1.2" fill="#fff"/>' +
  '<circle cx="10.5" cy="7" r="1.2" fill="#fff"/></svg>';

/**
 * 静态资源处理（非 /api 路径的 GET/HEAD）。
 *
 * 规则：
 * - /favicon.ico 与 /favicon.svg 返回内置 SVG 图标（不依赖构建产物）；
 * - dist 存在时：请求路径映射到 dist 内文件（路径归一 + 前缀校验防穿越）；
 *   文件存在则按 MIME 返回；不存在则 SPA fallback 返回 index.html；
 * - dist 不存在时：一律返回提示页。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param pathname URL 路径（已解码）
 * @param staticDir 静态资源根目录
 * @param port 当前监听端口
 */
function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  staticDir: string,
  port: number
): void {
  // 内置 favicon：任何形态的部署（含 dist 未构建）都不再 404
  if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
    res.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : FAVICON_SVG);
    return;
  }
  if (!existsSync(staticDir)) {
    sendPlaceholderPage(res, port);
    return;
  }
  const indexHtml = path.join(staticDir, "index.html");
  if (!existsSync(indexHtml)) {
    sendPlaceholderPage(res, port);
    return;
  }

  // "/" 或 SPA 路由直接回 index.html；带扩展名的资源缺失返回 404（避免把 JS 请求误回 HTML）
  let filePath: string | null = null;
  if (pathname === "/" || pathname === "") {
    filePath = indexHtml;
  } else {
    const candidate = path.resolve(path.join(staticDir, pathname));
    // 前缀校验：归一后必须仍在 staticDir 内（防 %2e%2e 等编码穿越）
    if (candidate.startsWith(staticDir + path.sep) || candidate === staticDir) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        filePath = candidate;
      } else if (!path.extname(candidate)) {
        // 无扩展名路径 → SPA 路由 fallback
        filePath = indexHtml;
      }
    }
  }

  if (!filePath) {
    sendJson(res, 404, { error: "资源不存在" });
    return;
  }

  const mime = STATIC_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    // 读取竞态（文件被删）时兜底结束响应
    res.end();
  });
  stream.pipe(res);
}

/**
 * 构造并启动 Web 服务器。
 *
 * @param resolved 归一后的 Web 配置（resolveWebSettings 产物）
 * @param opts 可选：依赖注入缝合点（createLLMClient / createOpenAIClient / staticDir）
 * @returns 运行句柄（server / port / close / pool / hub）
 */
export async function startWebServer(
  resolved: ResolvedWebSettings,
  opts: WebServerOptions = {}
): Promise<RunningWebServer> {
  const hub = new SseHub();
  // 牢笼白名单：启动时一次 realpath 归一（不可用根跳过，空牢笼一律 403）
  const jailRoots = await buildJailRoots(resolved.allowRoots);
  // 安全配置告警（docs/dev/web-isolation.md §3.5）：uploadDir 落于任一 allowRoot 内时
  // 属配置重叠形态。shared scope 对个人区的访问已由 resolveFileJailRoots 强制阻断
  // （403，见下方保护线），告警仅提醒管理员将 uploadDir 移出 allowRoots 以理顺语义。
  if (jailRoots.length > 0) {
    // uploadDir 可能尚未创建（首次使用前）：realpathAllowMissing 对最近存在祖先归一
    const uploadRoot = await realpathAllowMissing(path.resolve(resolved.uploadDir));
    if (jailRoots.some((root) => uploadRoot === root || uploadRoot.startsWith(root + path.sep))) {
      console.warn(
        `[web] 安全警告：uploadDir（${resolved.uploadDir}）位于 allowRoots 白名单内，` +
          `shared 模式对该目录的访问将被强制拒绝（个人区隔离保护），建议将 uploadDir 移出 allowRoots`
      );
    }
  }
  const pool = new SessionPool(resolved, hub, jailRoots, {
    createLLMClient: opts.createLLMClient,
    createOpenAIClient: opts.createOpenAIClient,
    // steering 分类客户端工厂透传（docs/dev/web-steering.md W2 测试缝合点）：
    // 缺失时 SessionPool 无法向 SessionManager 注入 → core 回退 createLLMClient()
    // 路径，生产行为不变（未注入=undefined），但测试分类链路完全断开
    classifyLlmClientFactory: opts.classifyLlmClientFactory,
    registryBaseDir: opts.registryBaseDir,
  });
  const staticDir = opts.staticDir ?? defaultStaticDir();
  /** 实际监听端口（listen(0) 时为随机分配端口；handleRequest 内静态页展示用） */
  let actualPort = resolved.port;
  /** 个人文件牢笼缓存（userId → realpath 根；docs/dev/web-isolation.md §3.5） */
  const personalJailCache = new Map<string, string[]>();
  /**
   * uploadDir 归一根（启动时一次，realpath 消解符号链接）。
   * shared scope 的个人区保护边界：任何位于该根内的请求路径一律 403，
   * 与 allowRoots 配置无关（架构师审查 P1-1 强制修复）。
   */
  const uploadRootNormalized = await realpathAllowMissing(path.resolve(resolved.uploadDir));
  /**
   * 解析 files 端点的牢笼根（scope 分流，docs/dev/web-isolation.md §3.5）。
   *
   * @param ctx 认证上下文（personal 场景决定目录归属）
   * @param scope 查询参数 scope（非法值按 400 拒绝）
   * @param requestedPath 查询参数 path 原值（shared 分支的个人区保护线判定用）
   * @returns shared = 全局 allowRoots 牢笼；personal = 本人个人区牢笼
   * @throws ApiError 400 scope 非法；403 shared 请求触达 uploadDir（个人区）
   */
  async function resolveFileJailRoots(
    ctx: AuthContext,
    scope: string | null,
    requestedPath: string | null
  ): Promise<string[]> {
    if (scope === null || scope === "shared") {
      // 个人工作目录模式（docs/dev/web-workspace.md W4）：shared 一律 403，
      // 共享文件区被整体禁用（与 allowRoots 配置无关），前端已隐藏入口（W7）
      if (resolved.personalOnly) {
        throw new ApiError(403, "个人工作目录模式：共享文件区已禁用，请使用 scope=personal 访问你的个人工作目录");
      }
      // 个人区保护线（P1-1 强制修复）：即使部署方误将 uploadDir 配入 allowRoots，
      // shared 浏览/上传/下载也不得触达任何用户的个人区与聊天附件（R3 不依赖配置）。
      // 请求路径经 ~ 展开 + realpath 消解后与 uploadDir 归一根做前缀包含判定。
      if (requestedPath !== null) {
        const normalized = await realpathAllowMissing(path.resolve(expandHomePath(requestedPath)));
        if (uploadRootNormalized === normalized || normalized.startsWith(uploadRootNormalized + path.sep)) {
          throw new ApiError(
            403,
            "uploadDir 为服务私有目录（用户个人区），shared 模式不可访问；个人文件请使用 scope=personal"
          );
        }
      }
      return jailRoots;
    }
    if (scope === "personal") {
      return getPersonalJailRoots(resolved.uploadDir, ctx.userId, personalJailCache);
    }
    throw new ApiError(400, `scope 参数非法（值：${JSON.stringify(scope)}）：仅支持 shared / personal`);
  }

  /**
   * 顶层请求处理：解析 URL → 认证门禁 → 路由分发 → 统一错误映射。
   */
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      // 统一错误映射：ApiError 按状态码；其余一律 500（不泄露堆栈）
      if (res.headersSent) {
        // 响应已开始（如流式管道中途失败）：只能截断连接
        res.destroy();
        return;
      }
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: `服务器内部错误：${message}` });
    });
  });

  /**
   * 路由分发实现（独立函数，便于顶层 catch 复用）。
   */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    // —— API 路由 ——
    if (pathname.startsWith("/api/")) {
      // 免认证端点：登录（凭证交换入口本身）
      if (pathname === "/api/auth/login" && req.method === "POST") {
        await handleLogin(req, res, resolved);
        return;
      }
      // 登出：清除 Cookie（幂等，无需认证）
      if (pathname === "/api/auth/logout" && req.method === "POST") {
        handleLogout(req, res);
        return;
      }

      // —— 认证门禁：其余 /api/* 一律要求有效 JWT ——
      const payload = authenticateRequest(req, resolved.auth.jwtSecret);
      if (!payload) {
        sendJson(res, 401, { error: "未认证或会话已过期，请重新登录" });
        return;
      }
      // 认证上下文：JWT 载荷 + 派生 userId（多用户隔离主键，docs/dev/web-isolation.md §3.2）
      const ctx = buildAuthContext(payload);

      // 认证后端点
      if (pathname === "/api/auth/me" && req.method === "GET") {
        handleMe(res, payload);
        return;
      }
      if (pathname === "/api/config" && req.method === "GET") {
        // 脱敏配置：仅返回非密钥初始化信息
        const config: PublicWebConfig = {
          enabled: resolved.enabled,
          allowRoots: resolved.allowRoots,
          maxUploadBytes: resolved.maxUploadBytes,
          // 文本预览上限（web-file-preview P1）：前端按 size ≤ 上限显示预览入口
          maxPreviewBytes: resolved.maxPreviewBytes,
          ldapEnabled: resolved.ldap.enabled,
          // 个人工作目录模式（W7）：前端据此隐藏共享区 tab、放宽空 projectRoot 新建
          personalOnly: resolved.personalOnly,
          // 补充指令开关（web-steering W7）：false 时前端回退「运行中禁用输入」旧行为
          steeringEnabled: resolved.steeringEnabled,
        };
        sendJson(res, 200, config);
        return;
      }
      if (pathname === "/api/chats" && req.method === "GET") {
        handleListChats(res, pool, ctx);
        return;
      }
      if (pathname === "/api/chats" && req.method === "POST") {
        await handleCreateChat(req, res, pool, ctx, resolved);
        return;
      }

      // /api/chats/:id/... 动态段路由
      const chatMatch = /^\/api\/chats\/([^/]+)(?:\/(messages|stream|interrupt))?$/.exec(pathname);
      if (chatMatch) {
        const chatId = chatMatch[1];
        const sub = chatMatch[2];
        if (sub === "messages" && req.method === "GET") {
          handleGetMessages(res, pool, chatId, ctx);
          return;
        }
        if (sub === "messages" && req.method === "POST") {
          await handleSendMessage(req, res, pool, resolved, chatId, ctx);
          return;
        }
        if (sub === "stream" && req.method === "GET") {
          handleStream(res, pool, hub, chatId, ctx);
          return;
        }
        if (sub === "interrupt" && req.method === "POST") {
          handleInterrupt(res, pool, chatId, ctx);
          return;
        }
      }

      // /api/files 端点（scope 分流：shared=共享 allowRoots / personal=本人个人区）
      if (pathname === "/api/files" && req.method === "GET") {
        await handleListFiles(
          res,
          await resolveFileJailRoots(ctx, url.searchParams.get("scope"), url.searchParams.get("path")),
          url.searchParams.get("path")
        );
        return;
      }
      if (pathname === "/api/files/upload" && req.method === "POST") {
        await handleUploadFile(
          req,
          res,
          resolved,
          await resolveFileJailRoots(ctx, url.searchParams.get("scope"), url.searchParams.get("path")),
          url.searchParams.get("path")
        );
        return;
      }
      if (pathname === "/api/files/download" && req.method === "GET") {
        await handleDownloadFile(
          res,
          await resolveFileJailRoots(ctx, url.searchParams.get("scope"), url.searchParams.get("path")),
          url.searchParams.get("path")
        );
        return;
      }
      // 文本预览（docs/dev/web-file-preview.md P1）：牢笼/scope 与 download 完全一致
      if (pathname === "/api/files/preview" && req.method === "GET") {
        await handlePreviewFile(
          res,
          resolved,
          await resolveFileJailRoots(ctx, url.searchParams.get("scope"), url.searchParams.get("path")),
          url.searchParams.get("path")
        );
        return;
      }

      sendJson(res, 404, { error: `未知 API 端点：${req.method} ${pathname}` });
      return;
    }

    // —— 静态资源（GET/HEAD；其余方法 405）——
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname, staticDir, actualPort);
      return;
    }
    sendJson(res, 405, { error: "静态资源仅支持 GET/HEAD" });
  }

  // 监听（端口 0 = 系统分配，测试随机端口；生产由配置决定）
  actualPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(resolved.port, resolved.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : resolved.port;
      resolve(port);
    });
  });

  // 首次启动默认用户提示（docs/dev/web-ui.md §3.3）：明文密码仅此一次展示；
  // 凭据哈希已落盘 ~/.deepcode/web/bootstrap-admin.json（0600），忘记密码可删除后重启重新生成
  if (resolved.auth.bootstrapPassword) {
    console.log(
      `[web] 首次启动：已创建默认本地登录用户 admin，密码 ${resolved.auth.bootstrapPassword}` +
        `（凭据文件 ~/.deepcode/web/bootstrap-admin.json 仅存哈希；配置 web.auth.localUsers 后可删除该文件）`
    );
  }

  return {
    server,
    port: actualPort,
    pool,
    hub,
    close: async () => {
      // 收敛顺序：SSE 订阅 → 会话池引擎 → HTTP 服务 → 残留空闲连接
      hub.closeAll();
      pool.disposeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // Node 18.2+：强制断开 keep-alive 残留连接，保证测试进程可退出
      server.closeAllConnections?.();
    },
  };
}
