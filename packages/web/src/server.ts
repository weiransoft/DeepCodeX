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

import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { syncPresetAgents } from "@vegamo/deepcode-core";
import { SseHub } from "./events";
import { ApiError, sendJson } from "./http-utils";
import { buildJailRoots, realpathAllowMissing } from "./jail";
import { expandHomePath } from "./config";
import { authenticateRequest } from "./auth/middleware";
import { buildAuthContext, type AuthContext } from "./user-identity";
import { getPersonalJailRoots } from "./user-files";
import { handleLogin, handleLogout, handleMe } from "./api/auth-api";
import { readLdapRuntimeConfig } from "./auth/ldap-runtime";
import {
  handleCreateChat,
  handleDeleteChat,
  handleGetMessages,
  handleInterrupt,
  handleListChats,
  handleRenameChat,
  handleSendMessage,
  handleStream,
} from "./api/chat-api";
import { handleDownloadFile, handleListFiles, handleMkdir, handlePreviewFile, handleUploadFile } from "./api/files-api";
import { handleListWorkspaces } from "./api/workspace-api";
import { handleListCapabilities } from "./api/capability-api";
import {
  handleCreateAgent,
  handleCreateAgentDraft,
  handleImportPresetAgents,
  handleSetDefaultAgent,
} from "./api/agents-api";
import { handleCreateRule, handleDeleteRule, handleListRules } from "./api/rules-api";
import { handleGetAudit } from "./api/audit-api";
import {
  handleConfirmSedimentation,
  handleDismissSedimentation,
  handleGetSedimentationSuggestions,
} from "./api/sedimentation-api";
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
 * 计算默认静态资源目录。
 *
 * 按候选布局依次探测（第一个真实存在的目录即命中），全部不存在时返回首选
 * 候选路径，由 serveStatic 的统一 existsSync 判定回退"UI 尚未构建"提示页：
 * 1. 源码/tsc 布局：packages/web/{src|dist}/server.js 向上一级 + web/dist，
 *    即 packages/web/web/dist（tsx 直跑与 tsc 编译产物两种形态相对路径一致）；
 * 2. CLI bundle 布局：esbuild 单文件产物（packages/cli/dist/cli.js）的
 *    import.meta.url 指向自身，按 repo 相对锚定 packages/cli/dist/web/dist，
 *    该路径由 packages/web/web/build.mjs 以软链装配指向真实前端产物。
 *
 * @returns dist 目录绝对路径
 */
function defaultStaticDir(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  // 候选 1：源码/tsc 布局（packages/web 包内相对定位）
  const srcLayout = path.join(selfDir, "..", "web", "dist");
  if (existsSync(srcLayout)) {
    return srcLayout;
  }
  // 候选 2：CLI bundle 布局（selfDir 即 packages/cli/dist，软链装配位
  // dist/web/dist 由 packages/web/web/build.mjs 创建）
  return path.join(selfDir, "web", "dist");
}

/**
 * Web 服务运行版本号（启动时一次性读取 package.json 缓存）。
 *
 * 读取 `dist/../package.json`（即 packages/web/package.json），与编译产物目录
 * 相对定位，源码 tsx 直跑与 tsc 编译后运行两种形态路径一致。
 * 读取/解析失败时回退 "unknown"，绝不让版本号展示问题影响服务启动。
 */
const WEB_SERVER_VERSION: string = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version !== "" ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
})();

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

/**
 * 内置 favicon（iOS 26 液态玻璃风格，与桌面壳图标/desktop icons 与前端 AppLogo
 * 组件三方同源：渐变 squircle 底（蓝→紫→青）+ 白描边对话气泡 + </> 代码符号）。
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">' +
  "<defs>" +
  '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#2b4df0"/><stop offset="0.52" stop-color="#7b3ff2"/><stop offset="1" stop-color="#22d3ee"/>' +
  "</linearGradient></defs>" +
  '<rect width="1024" height="1024" rx="230" fill="url(#g)"/>' +
  '<g fill="none" stroke="#fff" stroke-width="46" stroke-linecap="round" stroke-linejoin="round" opacity="0.94">' +
  '<rect x="176" y="236" width="672" height="486" rx="118"/>' +
  '<path d="M330 722l-26 118 128-108"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M392 420l-96 100 96 100"/>' +
  '<path d="M632 420l96 100-96 100"/>' +
  '<path d="M562 372l-96 300" opacity="0.96"/></g></svg>';

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

  // 静态资源（index.html / bundle.js 等）：一律 no-cache——
  // 否则无 Cache-Control 的响应会被浏览器启发式缓存（旧 bundle 配新前端
  // 混用会导致渲染崩溃等难排查问题）；协商缓存 304 开销可忽略。
  const mime = STATIC_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
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
  /**
   * uploadDir 归一根（启动时一次，realpath 消解符号链接；目录可能尚未创建，
   * realpathAllowMissing 对最近存在祖先归一）。
   * 复用场景：
   * 1. shared scope 的个人区保护边界——任何位于该根内的请求路径一律 403，
   *    与 allowRoots 配置无关（架构师审查 P1-1 强制修复）；
   * 2. /api/config 的 personalRoot 拼接——与 GET /api/files personal 归一
   *    path 逐字一致（前端「我的文件」面包屑数据源）。
   */
  const uploadRootNormalized = await realpathAllowMissing(path.resolve(resolved.uploadDir));
  // 安全配置告警（docs/dev/web-isolation.md §3.5）：uploadDir 落于任一 allowRoot 内时
  // 属配置重叠形态。shared scope 对个人区的访问已由 resolveFileJailRoots 强制阻断
  // （403，见下方保护线），告警仅提醒管理员将 uploadDir 移出 allowRoots 以理顺语义。
  if (jailRoots.length > 0) {
    if (jailRoots.some((root) => uploadRootNormalized === root || uploadRootNormalized.startsWith(root + path.sep))) {
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
    // EAG 装配注入开关透传（测试基线缝合点，docs/dev/eag-web-sedimentation-fixes.md
    // §2.1 EA-03a）：此前透传缺失导致 failclosed 测试服务器实际仍注入编排器，
    // fail-closed 基线不可达。生产不传 = 缺省 true，行为零变化。
    ...(opts.eagEnabled !== undefined ? { eagEnabled: opts.eagEnabled } : {}),
    // 沉淀建议装配透传（ARCH-20261027 T04 测试缝合点：开关 + 受控建议器注入）
    ...(opts.sedimentationEnabled !== undefined ? { sedimentationEnabled: opts.sedimentationEnabled } : {}),
    ...(opts.sedimentationSuggester ? { sedimentationSuggester: opts.sedimentationSuggester } : {}),
  });
  const staticDir = opts.staticDir ?? defaultStaticDir();
  /** 实际监听端口（listen(0) 时为随机分配端口；handleRequest 内静态页展示用） */
  let actualPort = resolved.port;
  /** 个人文件牢笼缓存（userId → realpath 根；docs/dev/web-isolation.md §3.5） */
  const personalJailCache = new Map<string, string[]>();
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

      // —— 免认证轻探活端点（DeepCode Desktop 壳 EngineManager 健康检查用，
      // PRD FR-1.2）：仅回 200 {ok:true}，不返回任何服务器信息
      if (pathname === "/api/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true });
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
          // LDAP 启用提示（登录页 hint）与登录同源走热读：系统管理切换开关约一个 TTL 后一致
          ldapEnabled: readLdapRuntimeConfig(resolved).enabled,
          // 个人工作目录模式（W7）：前端据此隐藏共享区 tab、放宽空 projectRoot 新建
          personalOnly: resolved.personalOnly,
          // 补充指令开关（web-steering W7）：false 时前端回退「运行中禁用输入」旧行为
          steeringEnabled: resolved.steeringEnabled,
          // 本人个人工作区绝对路径：前端「我的文件」面包屑在列表加载前即可显示完整路径。
          // 经 uploadRootNormalized（启动时 realpath 归一的上传根）拼接——与 GET /api/files
          // personal 归一 path 逐字一致（macOS /var→/private/var 等符号链接形态由
          // realpath 统一消解，绝不再用未归一的 resolved.uploadDir 直接拼接）
          personalRoot: path.join(uploadRootNormalized, ctx.userId),
          // Web 服务运行版本号（启动时缓存）：前端侧栏底部/登录页品牌区展示
          version: WEB_SERVER_VERSION,
        };
        sendJson(res, 200, config);
        return;
      }
      if (pathname === "/api/chats" && req.method === "GET") {
        // 工作空间过滤（ARCH-20261027 T04）：?workspaceId= 按空间根过滤会话列表
        await handleListChats(res, pool, ctx, resolved, url.searchParams.get("workspaceId"));
        return;
      }
      if (pathname === "/api/chats" && req.method === "POST") {
        await handleCreateChat(req, res, pool, ctx, resolved);
        return;
      }

      // 工作空间列表（ARCH-20261027 T04）：前端空间切换器数据源
      if (pathname === "/api/workspaces" && req.method === "GET") {
        await handleListWorkspaces(res, resolved, ctx);
        return;
      }

      // 能力发现（web-capability T1）：技能 / Agent / MCP 脱敏清单，
      // 供设置抽屉「技能」页签与 Composer「@ 提及」补全面板消费
      if (pathname === "/api/capabilities" && req.method === "GET") {
        await handleListCapabilities(res, req, ctx, resolved);
        return;
      }

      // 自定义 Agent 创建（设置抽屉「智能体」页签）：
      // 复用 SedimentationWriter 五条安全门槛，scope=user 落技能资产根
      // （与 /api/capabilities 扫描根同源）
      if (pathname === "/api/agents" && req.method === "POST") {
        await handleCreateAgent(req, res, ctx, resolved);
        return;
      }

      // AI 一句话生成智能体草稿（不落盘，用户确认后走 POST /api/agents）
      if (pathname === "/api/agents/draft" && req.method === "POST") {
        await handleCreateAgentDraft(req, res, ctx);
        return;
      }

      // 预置智能体导入 / 修复（5 核心角色 + 30 领域专家 → 技能资产根）
      if (pathname === "/api/agents/presets" && req.method === "POST") {
        await handleImportPresetAgents(req, res, ctx, resolved);
        return;
      }

      // 默认智能体设置（settings.agents.default；下一轮生效，无需重启引擎）
      if (pathname === "/api/agents/default" && req.method === "POST") {
        await handleSetDefaultAgent(req, res, ctx);
        return;
      }

      // 全局规则管理（设置抽屉「全局规则」页签）：增删查，存储与会话注入同源
      // （personalOnly → <engineHomeRoot>/<userId>/.deepcodeX/rules/，否则 ~ 同 CLI /rules）
      if (pathname === "/api/rules" && req.method === "GET") {
        await handleListRules(res, resolved, ctx);
        return;
      }
      if (pathname === "/api/rules" && req.method === "POST") {
        await handleCreateRule(req, res, resolved, ctx);
        return;
      }
      const ruleDeleteMatch = /^\/api\/rules\/([^/]+)$/.exec(pathname);
      if (ruleDeleteMatch && req.method === "DELETE") {
        await handleDeleteRule(res, decodeURIComponent(ruleDeleteMatch[1]), resolved, ctx);
        return;
      }

      // EAG 工作流审计（设置抽屉「审计」页签，P6）：规则证据 + 干预台账 + 确定性报告
      if (pathname === "/api/eag/audit" && req.method === "GET") {
        await handleGetAudit(res, resolved, ctx);
        return;
      }

      // 沉淀建议端点（ARCH-20261027 T04）：拉取 / 确认落盘 / 忽略
      if (pathname === "/api/sedimentation/suggestions" && req.method === "GET") {
        handleGetSedimentationSuggestions(res, pool, url.searchParams.get("chatId"), ctx);
        return;
      }
      if (pathname === "/api/sedimentation/confirm" && req.method === "POST") {
        await handleConfirmSedimentation(req, res, pool, ctx);
        return;
      }
      if (pathname === "/api/sedimentation/dismiss" && req.method === "POST") {
        await handleDismissSedimentation(req, res, pool, ctx);
        return;
      }

      // /api/chats/:id/... 动态段路由（rename/delete：web-chat-manage.md R1/R3）
      const chatMatch = /^\/api\/chats\/([^/]+)(?:\/(messages|stream|interrupt|rename))?$/.exec(pathname);
      if (chatMatch) {
        const chatId = chatMatch[1];
        const sub = chatMatch[2];
        // DELETE /api/chats/:id（无子段）：删除会话（引擎索引+磁盘消息+注册表条目）
        if (sub === undefined && req.method === "DELETE") {
          handleDeleteChat(res, pool, chatId, ctx);
          return;
        }
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
        if (sub === "rename" && req.method === "POST") {
          await handleRenameChat(req, res, pool, chatId, ctx);
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
      // 目录创建（web-personal-subworkspace T1）：「新建对话 → 选择文件夹 → 新建文件夹」，
      // 牢笼/scope 与 upload 一致；目录已存在幂等成功
      if (pathname === "/api/files/mkdir" && req.method === "POST") {
        await handleMkdir(
          res,
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

  // 预置智能体种子同步（2026-11-02）：core 的 5 核心角色 + 30 领域专家原本只存在
  // 于内存，而 Agent 的唯一真相来源是文件扫描——不物化就永远「界面里看不到」。
  // 默认 onlyMissing：绝不覆盖用户改过的同名 SKILL.md；任何异常只告警，不阻断启动。
  try {
    const presetRoot = path.join(os.homedir(), ".deepcode", "skills");
    const synced = syncPresetAgents(presetRoot);
    if (synced.written.length > 0) {
      console.log(`[presets] 已导入预置智能体 ${synced.written.length} 个 → ${presetRoot}`);
    }
    if (synced.failed.length > 0) {
      console.warn(
        `[presets] 预置智能体写入失败 ${synced.failed.length} 个：${synced.failed
          .map(([name, reason]) => `${name}(${reason})`)
          .join("、")}`
      );
    }
  } catch (error) {
    console.warn(`[presets] 预置智能体同步跳过：${error instanceof Error ? error.message : String(error)}`);
  }

  // 首次启动默认用户提示（docs/dev/web-ui.md §3.3）。
  // 安全需求（2026-10-29）：明文密码不得写入任何日志/文件——
  // 2026-10-30 起弃用 macOS 钥匙串（security CLI 触发系统授权框、体验差），
  // 改存本地 SQLite 密钥库 `~/.deepcode/desktop-secrets.db`（0600，与桌面壳
  // 共用同一数据库；node:sqlite 为 Node 22.13+ 内置模块，零新增依赖）：
  // 1) SQLite 可写：密码写入表 secrets(service='com.vegamo.deepcode.desktop',
  //    account='web:bootstrap')，日志仅提示取回命令；
  // 2) SQLite 不可用：仅当 stdout 为交互式 TTY 时一次性展示
  //    （TTY 输出不持久化；重定向到日志文件时绝不输出明文）。
  if (resolved.auth.bootstrapPassword) {
    const pw = resolved.auth.bootstrapPassword;
    let storedInSqlite = false;
    try {
      // 动态 import：node:sqlite 为 Node 22.13+ 实验性内置模块，
      // 缺失/未启用时 catch 回落 TTY 展示；esbuild 对 node: 前缀保持 external
      const sqlite = (await import("node:sqlite")) as unknown as {
        DatabaseSync: new (path: string) => {
          exec: (sql: string) => void;
          prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
          close: () => void;
        };
      };
      const dbPath = path.join(expandHomePath("~/.deepcode"), "desktop-secrets.db");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new sqlite.DatabaseSync(dbPath);
      // SQLite 驱动按进程 umask 建文件（默认 0644）：打开后立即收紧为 0600
      chmodSync(dbPath, 0o600);
      db.exec(
        "CREATE TABLE IF NOT EXISTS secrets (" +
          "service TEXT NOT NULL, account TEXT NOT NULL, value TEXT NOT NULL, " +
          "PRIMARY KEY (service, account));"
      );
      db.prepare(
        "INSERT INTO secrets (service, account, value) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT (service, account) DO UPDATE SET value = excluded.value"
      ).run("com.vegamo.deepcode.desktop", "web:bootstrap", pw);
      db.close();
      storedInSqlite = true;
    } catch {
      // node:sqlite 不可用 / 打开失败：回落 TTY-only 展示
    }
    if (storedInSqlite) {
      console.log(
        `[web] 首次启动：已创建默认本地登录用户 admin，初始密码已存入本地密钥库 ` +
          `~/.deepcode/desktop-secrets.db（secrets 表，account=web:bootstrap；` +
          `取回：sqlite3 ~/.deepcode/desktop-secrets.db "select value from secrets where account='web:bootstrap'"；` +
          `凭据文件 ~/.deepcode/web/bootstrap-admin.json 仅存哈希；配置 web.auth.localUsers 后可删除该文件）`
      );
    } else if (process.stdout.isTTY) {
      console.log(
        `[web] 首次启动：已创建默认本地登录用户 admin，密码 ${pw}` +
          `（仅本次交互展示、不写入日志文件；凭据文件 ~/.deepcode/web/bootstrap-admin.json 仅存哈希；` +
          `配置 web.auth.localUsers 后可删除该文件）`
      );
    } else {
      console.log(
        `[web] 首次启动：已创建默认本地登录用户 admin（初始密码未写入日志；` +
          `删除 ~/.deepcode/web/bootstrap-admin.json 后重启可重新生成）`
      );
    }
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
