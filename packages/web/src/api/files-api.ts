/**
 * 文件端点（docs/dev/web-ui.md §3.5；scope 隔离 docs/dev/web-isolation.md §3.5，
 * 路径牢笼统一防护见 jail.ts）。
 *
 * - GET  /api/files?path=<目录>&scope=shared|personal：目录列表 {name, type, size, mtime}
 * - POST /api/files/upload?path=<目录>&scope=...：multipart 上传到指定目录（jail + 大小限制 + 随机名）
 * - GET  /api/files/download?path=<文件>&scope=...：流式下载（Content-Disposition attachment）
 *
 * 安全约定：
 * - allowRoots 为空时 shared 一律 403；personal 牢笼为用户个人上传区（每用户独立）；
 * - 牢笼根由 server.ts 按认证上下文与 scope 分流后传入本层（shared = allowRoots，
 *   personal = <uploadDir>/<userId>/），本层不感知用户身份；
 * - 所有路径经 resolveInJail（realpath + 前缀校验）防 `..` 与 symlink 逃逸（CWE-22）。
 */

import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveInJail } from "../jail";
import { MultipartError, parseMultipartRequest } from "../multipart";
import { ApiError, sendJson } from "../http-utils";
import type { FileEntry, ResolvedWebSettings } from "../types";

/**
 * 个人区引擎目录保护（docs/dev/web-workspace.md W5）。
 *
 * 个人工作区根下的 `.deepcode` 目录是引擎在该用户 HOME（即个人区根）下
 * 落盘的运行时数据（settings、projects 缓存、记忆、日志等）。用户经
 * files 端点向其中写入/覆盖文件（如 settings.json）可能劫持引擎凭据、
 * 权限模式或 MCP 配置，因此 upload / download 一律 403；list 仅屏蔽
 * 该目录名（纵深防御，不向用户暴露引擎区结构）。
 *
 * 判定基于 resolveInJail 之后的真实路径做前缀包含，symlink 已消解，
 * 无法用链接绕过；非个人区牢笼（shared allowRoots）不命中此路径，天然放行。
 *
 * @param jailRoots 牢笼白名单根（personal scope 为单根 = 个人区根）
 * @param resolvedPath 已经 resolveInJail 校验的真实绝对路径
 * @throws ApiError 403 路径等于个人区根下 `.deepcode` 目录或位于其内
 */
function guardPersonalEngineDir(jailRoots: string[], resolvedPath: string): void {
  for (const root of jailRoots) {
    // 引擎目录 = 牢笼根（个人区根）下的 `.deepcode`
    const engineDir = path.join(root, ".deepcode");
    // 等于引擎目录本身，或位于其内（path.sep 防 `.deepcodex` 之类前缀误伤）
    if (resolvedPath === engineDir || resolvedPath.startsWith(engineDir + path.sep)) {
      throw new ApiError(403, "该目录为引擎运行时数据区，禁止读写");
    }
  }
}

/**
 * 解析目录浏览/上传的目标路径（空路径缺省语义）。
 *
 * 单根牢笼（personal scope 的用户个人区）空 path 默认落在牢笼根——
 * 前端无法预知服务端派生的个人区路径（uploadDir/<userId>），切到
 * 「我的文件」tab 时不带 path，由服务端缺省到个人区根；
 * 多根牢笼（shared allowRoots）仍要求显式 path（根选择由前端负责）。
 *
 * @param jailRoots 牢笼白名单根
 * @param dirPath 请求的目录路径（可为 null/空）
 * @returns 有效的目标路径（可能仍为空串，由 guardPath 报 400）
 */
function resolveTargetPath(jailRoots: string[], dirPath: string | null): string {
  if (dirPath !== null && dirPath.trim() !== "") {
    return dirPath;
  }
  return jailRoots.length === 1 ? jailRoots[0] : "";
}

/**
 * 校验 allowRoots 非空并解析目标路径（牢笼校验统一入口）。
 *
 * @param jailRoots realpath 后的白名单根集合
 * @param target 用户请求路径
 * @param kind 端点用途描述（错误信息用）
 * @returns 牢笼内真实绝对路径
 * @throws ApiError 403 allowRoots 为空或路径越界
 */
async function guardPath(jailRoots: string[], target: string, kind: string): Promise<string> {
  if (jailRoots.length === 0) {
    throw new ApiError(403, "web.allowRoots 未配置，文件功能已禁用");
  }
  if (target.trim() === "") {
    throw new ApiError(400, `缺少 path 参数（${kind} 需要指定目录或文件路径）`);
  }
  try {
    return await resolveInJail(jailRoots, target);
  } catch (error) {
    // 牢笼越界统一 403，不区分具体越界形态（不泄露服务器目录结构）
    if (error instanceof Error && error.name === "JailViolationError") {
      throw new ApiError(403, "路径不在允许访问的目录白名单内");
    }
    throw error;
  }
}

/**
 * 处理 GET /api/files?path=<目录>：返回目录条目列表。
 *
 * 目录在前、文件在后，各自按名称升序；条目 stat 并发执行取 size/mtime。
 *
 * @param res 响应对象
 * @param jailRoots 牢笼白名单根
 * @param dirPath 请求的目录路径
 */
export async function handleListFiles(res: ServerResponse, jailRoots: string[], dirPath: string | null): Promise<void> {
  // 单根牢笼空路径缺省到根（personal「我的文件」入口），多根仍要求显式 path
  const dir = await guardPath(jailRoots, resolveTargetPath(jailRoots, dirPath), "目录列表");
  // 个人区引擎目录保护：拒绝把 `.deepcode`（或其子目录）当作浏览目标
  guardPersonalEngineDir(jailRoots, dir);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") {
      throw new ApiError(400, "path 不是目录");
    }
    if (code === "ENOENT") {
      throw new ApiError(404, "目录不存在");
    }
    throw error;
  }

  // 个人区引擎目录保护：目录列表屏蔽 `.deepcode`（纵深防御，不暴露引擎区结构）
  const engineDirNames = new Set(jailRoots.map((root) => path.basename(path.join(root, ".deepcode"))));
  const entries: FileEntry[] = await Promise.all(
    dirents
      .filter((dirent) => !engineDirNames.has(dirent.name))
      .map(async (dirent) => {
        const entryPath = path.join(dir, dirent.name);
        try {
          const info = await stat(entryPath);
          return {
            name: dirent.name,
            type: dirent.isDirectory() ? ("dir" as const) : ("file" as const),
            size: info.isFile() ? info.size : 0,
            mtime: info.mtime.toISOString(),
          };
        } catch {
          // 条目在列举间隙被删除等竞态：以类型信息兜底
          return {
            name: dirent.name,
            type: dirent.isDirectory() ? ("dir" as const) : ("file" as const),
            size: 0,
            mtime: new Date(0).toISOString(),
          };
        }
      })
  );

  // 目录在前、文件在后，各自按名称升序（稳定且对用户友好）
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  sendJson(res, 200, { path: dir, entries });
}

/**
 * 处理 POST /api/files/upload?path=<目录>：multipart 上传文件到指定目录。
 *
 * 文件名经 multipart.ts 统一随机化（Date.now()-随机hex-安全化原名），防穿越与冲突。
 *
 * @param req 请求对象（multipart/form-data，file 字段）
 * @param res 响应对象
 * @param settings Web 配置（maxUploadBytes）
 * @param jailRoots 牢笼白名单根
 * @param dirPath 目标目录
 */
export async function handleUploadFile(
  req: IncomingMessage,
  res: ServerResponse,
  settings: ResolvedWebSettings,
  jailRoots: string[],
  dirPath: string | null
): Promise<void> {
  // 单根牢笼空路径缺省到根（personal 首次上传免指定路径），多根仍要求显式 path
  const dir = await guardPath(jailRoots, resolveTargetPath(jailRoots, dirPath), "文件上传");
  // 个人区引擎目录保护：禁止向 `.deepcode`（或其子目录）上传任何文件，
  // 阻断经 files 端点注入 settings.json 等引擎配置的凭据劫持路径
  guardPersonalEngineDir(jailRoots, dir);
  // 目标目录必须存在（上传不隐式建目录，防止拼错路径散落文件）
  const dirInfo = await stat(dir).catch(() => null);
  if (!dirInfo || !dirInfo.isDirectory()) {
    throw new ApiError(400, "path 不是已存在的目录");
  }

  try {
    const parsed = await parseMultipartRequest(req, {
      uploadDir: dir,
      maxUploadBytes: settings.maxUploadBytes,
    });
    sendJson(res, 200, {
      path: dir,
      files: parsed.files.map((file) => ({
        originalName: file.originalName,
        savedName: path.basename(file.savedPath),
        savedPath: file.savedPath,
        size: file.size,
      })),
    });
  } catch (error) {
    if (error instanceof MultipartError) {
      throw new ApiError(
        error.code === "PAYLOAD_TOO_LARGE" || error.code === "FIELD_TOO_LARGE" ? 413 : 400,
        error.message
      );
    }
    throw error;
  }
}

/**
 * 处理 GET /api/files/download?path=<文件>：流式回传文件内容。
 *
 * Content-Disposition attachment（文件名同时提供 filename 与 filename* UTF-8 形式，
 * 覆盖非 ASCII 名称）；内容经 createReadStream 流式管道，不整读内存。
 *
 * @param res 响应对象
 * @param jailRoots 牢笼白名单根
 * @param filePath 请求的文件路径
 */
export async function handleDownloadFile(
  res: ServerResponse,
  jailRoots: string[],
  filePath: string | null
): Promise<void> {
  const file = await guardPath(jailRoots, filePath ?? "", "文件下载");
  // 个人区引擎目录保护：禁止下载引擎区内部文件（如 settings.json 凭据、日志）
  guardPersonalEngineDir(jailRoots, file);
  const info = await stat(file).catch(() => null);
  if (!info) {
    throw new ApiError(404, "文件不存在");
  }
  if (!info.isFile()) {
    throw new ApiError(400, "path 不是普通文件（目录请使用目录浏览端点）");
  }

  // 附件名取 basename（防止 Content-Disposition 头注入路径）
  const name = path.basename(file);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Content-Type-Options": "nosniff",
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("error", reject);
    res.on("error", reject);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

/** GET /api/files/preview 响应载荷（docs/dev/web-file-preview.md P1） */
export type FilePreviewResult = {
  /** 服务端归一后的真实绝对路径 */
  path: string;
  /** 文件名（basename） */
  name: string;
  /** 文件字节大小 */
  size: number;
  /** 最后修改时间（ISO） */
  mtime: string;
  /** 预览文本（UTF-8；truncated 为 true 时按上限截断） */
  text: string;
  /** 是否因超过 maxPreviewBytes 被截断 */
  truncated: boolean;
};

/**
 * UTF-8 解码并在多字节字符中间截断时安全去除残缺尾字节。
 *
 * Node 的 Buffer.toString("utf8") 对残缺尾序列以 U+FFFD 收尾；预览截断
 * 允许恰好多字节边界切断，此时去掉残缺尾字节重解，保证返回文本无乱码尾。
 *
 * @param buf 原始字节（可能截断于多字节字符中间）
 * @returns 无残缺尾的 UTF-8 文本
 */
function decodeUtf8Safe(buf: Buffer): string {
  let text = buf.toString("utf8");
  // 截断点把多字节字符切成残尾：toString 产生 1 个 U+FFFD；逐字节回退重解
  while (text.endsWith("\uFFFD")) {
    const shorter = buf.subarray(0, buf.length - 1);
    if (shorter.length === buf.length) break;
    buf = shorter;
    text = buf.toString("utf8");
  }
  return text;
}

/**
 * 处理 GET /api/files/preview?path=<文件>：文本文件预览。
 *
 * 安全链路与 download 完全一致（牢笼 + 个人区 `.deepcode` 保护）；
 * 文本性判定：前 8 KiB 采样无 NUL 字节且可严格 UTF-8 解码（BOM 放行），
 * 不满足 → 415 引导下载；文件 > maxPreviewBytes → 413（预览上限独立于上传上限）。
 *
 * @param res 响应对象（200 JSON 响应体）
 * @param settings Web 配置（maxPreviewBytes）
 * @param jailRoots 牢笼白名单根
 * @param filePath 请求的文件路径
 */
export async function handlePreviewFile(
  res: ServerResponse,
  settings: ResolvedWebSettings,
  jailRoots: string[],
  filePath: string | null
): Promise<void> {
  const file = await guardPath(jailRoots, filePath ?? "", "文件预览");
  // 个人区引擎目录保护：禁止预览引擎区内部文件（如 settings.json 凭据、日志）
  guardPersonalEngineDir(jailRoots, file);
  const info = await stat(file).catch(() => null);
  if (!info) {
    throw new ApiError(404, "文件不存在");
  }
  if (!info.isFile()) {
    throw new ApiError(400, "path 不是普通文件（目录请使用目录浏览端点）");
  }
  if (info.size > settings.maxPreviewBytes) {
    throw new ApiError(413, `文件超过预览上限（${settings.maxPreviewBytes} 字节），请下载后查看`);
  }

  // 读取上限内的字节（大小已 ≤ maxPreviewBytes，整读安全）
  const buf = await readFile(file);
  // 文本性判定：含 NUL 视为二进制（UTF-16/图片等）；严格 UTF-8 解码失败同样拒绝。
  // BOM（EF BB BF）放行——采样段跳过起始 BOM 后再严格解码。
  if (buf.includes(0)) {
    throw new ApiError(415, "二进制文件不支持文本预览，请下载后查看");
  }
  const sampleLen = Math.min(buf.length, 8192);
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // 跳过 UTF-8 BOM 后严格解码采样段（fatal：非法字节抛错而非替换）
    const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    decoder.decode(buf.subarray(start, sampleLen));
  } catch {
    throw new ApiError(415, "非 UTF-8 文本文件，暂不支持预览，请下载后查看");
  }

  const truncated = buf.length > settings.maxPreviewBytes; // 上限 413 后理论恒 false，保留供未来分级预览
  const text = decodeUtf8Safe(truncated ? buf.subarray(0, settings.maxPreviewBytes) : buf);
  sendJson(res, 200, {
    path: file,
    name: path.basename(file),
    size: info.size,
    mtime: info.mtime.toISOString(),
    text,
    truncated,
  } satisfies FilePreviewResult);
}
