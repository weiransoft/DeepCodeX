/**
 * 工作空间端点（ARCH-20261027 T04）。
 *
 * GET /api/workspaces：返回当前用户可用的工作空间列表——
 * personalOnly 模式下首项恒为本人个人区（id="personal"），其后为
 * web.workspaces 配置的共享空间；personalOnly=false 时仅返回配置列表。
 * 前端 WorkspaceSwitcher（PRD §5.1）据本端点渲染切换器。
 */

import type { ServerResponse } from "node:http";
import { realpathAllowMissing } from "../jail";
import { personalUploadRoot } from "../user-files";
import { sendJson } from "../http-utils";
import type { AuthContext } from "../user-identity";
import type { ResolvedWebSettings } from "../types";

/** GET /api/workspaces 响应条目 */
export type WorkspaceDto = {
  /** 空间标识：个人区固定为 "personal"，配置空间为 web.workspaces[].id */
  id: string;
  /** 展示名 */
  name: string;
  /** 空间根目录（个人区为服务端拼接的 <uploadDir>/<userId>） */
  root: string;
  /** 种类：personal = 本人个人区；workspace = web.workspaces 配置的共享空间 */
  kind: "personal" | "workspace";
};

/**
 * 处理 GET /api/workspaces：返回当前用户可用工作空间列表。
 *
 * 个人区根经 realpathAllowMissing 归一——与 GET /api/config 的 personalRoot、
 * GET /api/files personal 归一 path 逐字一致（macOS /var → /private/var 等
 * 符号链接形态由 realpath 统一消解，前端面包屑/落点展示不出现双形态漂移）。
 *
 * @param res 响应对象
 * @param settings 归一后的 Web 配置（personalOnly / uploadDir / workspaces）
 * @param ctx 认证上下文（个人区根按当前用户拼接）
 */
export async function handleListWorkspaces(
  res: ServerResponse,
  settings: ResolvedWebSettings,
  ctx: AuthContext
): Promise<void> {
  const workspaces: WorkspaceDto[] = [];
  if (settings.personalOnly) {
    // 个人区：id 固定 "personal"，root 与 createChat 缺省落点（realpath 归一后）一致
    workspaces.push({
      id: "personal",
      name: "个人工作区",
      root: await realpathAllowMissing(personalUploadRoot(settings.uploadDir, ctx.userId)),
      kind: "personal",
    });
  }
  for (const workspace of settings.workspaces) {
    workspaces.push({ id: workspace.id, name: workspace.name, root: workspace.root, kind: "workspace" });
  }
  sendJson(res, 200, { workspaces });
}
