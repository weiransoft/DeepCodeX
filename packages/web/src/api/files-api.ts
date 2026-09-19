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
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveInJail } from "../jail";
import { MultipartError, parseMultipartRequest } from "../multipart";
import { ApiError, sendJson } from "../http-utils";
import type { FileEntry, ResolvedWebSettings } from "../types";

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

  // 逐条 stat 取 size/mtime（并发执行）
  const entries: FileEntry[] = await Promise.all(
    dirents.map(async (dirent) => {
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
