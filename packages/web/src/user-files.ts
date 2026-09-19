/**
 * 用户个人文件区管理（docs/dev/web-isolation.md §3.5）。
 *
 * 职责：
 * 1. 计算并就绪个人上传根目录：<uploadDir>/<userId>/；
 * 2. 构建个人牢笼（realpath 归一白名单，语义与 buildJailRoots 一致），
 *    供 files 端点 personal scope 与聊天附件落盘使用；
 * 3. 按 userId 惰性缓存个人牢笼，避免每次请求重复 realpath。
 *
 * 安全取向：个人牢笼只含本人目录一个根——任何指向他人目录 /
 * 共享目录的路径在 resolveInJail 下自然越界（403），无需额外黑名单。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { buildJailRoots } from "./jail";

/**
 * 计算指定用户的个人文件区根目录（不创建）。
 *
 * @param uploadDir 已归一的全局上传根（ResolvedWebSettings.uploadDir）
 * @param userId 用户隔离标识（hex，路径安全）
 * @returns 个人区根目录绝对路径
 */
export function personalUploadRoot(uploadDir: string, userId: string): string {
  return path.join(uploadDir, userId);
}

/**
 * 取得指定用户的个人牢笼（惰性创建目录 + realpath 归一 + 缓存）。
 *
 * 每次调用都确保目录存在（用户可能首次使用个人区），
 * 目录就绪后构建单根牢笼并缓存；目录创建失败时返回空数组，
 * 后续 resolveInJail 对空牢笼一律 403（白名单失效即拒绝）。
 *
 * @param uploadDir 全局上传根
 * @param userId 用户隔离标识
 * @param cache 跨请求缓存（server 装配处持有的 Map，键为 userId）
 * @returns realpath 后的个人牢笼根列表（正常情况恰一个元素）
 */
export async function getPersonalJailRoots(
  uploadDir: string,
  userId: string,
  cache: Map<string, string[]>
): Promise<string[]> {
  const cached = cache.get(userId);
  if (cached) {
    return cached;
  }
  const root = personalUploadRoot(uploadDir, userId);
  try {
    // 个人区首次访问即创建（幂等）；multipart 落盘侧也有兜底 mkdir
    mkdirSync(root, { recursive: true });
  } catch {
    // 创建失败不视为致命：本次以空牢笼拒绝（白名单失效即拒绝），
    // 但不写入缓存——下次请求重试 mkdir，瞬时故障可自愈
  }
  const roots = await buildJailRoots([root]);
  // 仅在牢笼构建成功（非空）时缓存：空牢笼可能是 mkdir 瞬时失败，
  // 缓存会让该用户个人区永久 403 无法恢复
  if (roots.length > 0) {
    cache.set(userId, roots);
  }
  return roots;
}
