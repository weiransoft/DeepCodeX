/**
 * 能力发现端点（web-capability T1）：
 *
 * GET /api/capabilities：返回当前引擎可用的「技能 / 自定义 Agent / MCP 服务器」
 * 脱敏清单，供前端两处消费：
 * - 设置抽屉「技能」页签（已安装技能只读列表）；
 * - Composer「@ 提及」补全面板（输入 @ 弹出技能/Agent/MCP 候选）。
 *
 * 数据来源：
 * - 技能/Agent：core SkillManager 扫描（项目级 .deepcode/skills、.agents/skills、
 *   用户级 ~/.deepcode/skills、~/.agents/skills、~/.trae-cn/builtin_skills、bundled:），
 *   与 SessionManager 技能注入同一实现（保证「看到的」=「能加载的」）；
 * - MCP 服务器：resolveCurrentSettings().mcpServers —— 仅回 name/command/args，
 *   env（可能含密钥）一律不下发（PRD NFR-3 脱敏纪律，与 /api/config 同口径）。
 *
 * 只读端点：不修改任何文件；扫描失败降级为空列表（不 500，前端可正常渲染其余能力）。
 */

import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SkillManager, resolveCurrentSettings, type McpServerConfig } from "@vegamo/deepcode-core";
import { sendJson } from "../http-utils";
import type { AuthContext } from "../user-identity";

/** 技能条目（前端展示 / @ 提及候选；path 仅展示来源，不含内容） */
export type CapabilitySkill = {
  name: string;
  description: string;
  path: string;
  /** "skill" 普通技能 / "agent" 自定义 Agent 定义 */
  kind: "skill" | "agent";
  /** 是否预置智能体（frontmatter `preset: true`，界面据此显示「预置」徽标） */
  preset?: boolean;
  /** 分组名（预置智能体按业务类别分组展示；用户自建条目无此字段） */
  group?: string;
};

/** MCP 服务器条目（脱敏：不下发 env） */
export type CapabilityMcpServer = {
  name: string;
  command: string;
  args?: string[];
};

/** GET /api/capabilities 响应体 */
export type CapabilitiesResponse = {
  skills: CapabilitySkill[];
  mcpServers: CapabilityMcpServer[];
  /** 默认智能体（settings.agents.default；未配置为 null） */
  defaultAgent: string | null;
};

/**
 * 技能扫描降级包装：SkillManager 扫描依赖文件系统，任何异常（权限/缺失）
 * 都不应拖垮整个端点——返回空数组并保持其余能力可用。
 *
 * 导出复用：chat-api 发送链路的 @agent 激活按同名扫描解析提及名单。
 */
export async function listSkillsSafe(projectRoot: string): Promise<CapabilitySkill[]> {
  try {
    const manager = new SkillManager({
      projectRoot,
      // 仅列表场景：无 enabledSkills 过滤、无会话消息追踪需求
      getResolvedSettings: () => ({}),
      listSessionMessages: () => [],
    });
    // kind 缺省 = 全量（skill + agent）；此处分别取全量后归一
    const all = await manager.listSkills();
    return all.map((s) => ({
      name: s.name,
      description: s.description ?? "",
      path: s.path,
      kind: s.kind === "agent" ? "agent" : "skill",
      ...(s.preset === true ? { preset: true } : {}),
      ...(typeof s.group === "string" && s.group !== "" ? { group: s.group } : {}),
    }));
  } catch {
    return [];
  }
}

/** MCP 清单脱敏映射：env 键名可提示存在哪些配置，但值绝不下发 */
function listMcpServersSafe(projectRoot: string): CapabilityMcpServer[] {
  try {
    const settings = resolveCurrentSettings(projectRoot);
    const servers = settings.mcpServers ?? {};
    return Object.entries(servers).map(([name, cfg]: [string, McpServerConfig]) => ({
      name,
      command: cfg.command ?? "",
      args: cfg.args,
    }));
  } catch {
    return [];
  }
}

/**
 * 处理 GET /api/capabilities（已认证）。
 *
 * projectRoot 取用户主目录：技能扫描的用户级根（~/.deepcode/skills 等）
 * 与 projectRoot 无关；bundled: 内置技能随包发布；项目级根在个人模式下
 * 各用户隔离目录内，此处以全局可见性为准（@ 提及与设置页展示全局可安装能力）。
 *
 * @param res 响应对象
 * @param _req 请求对象（当前无查询参数）
 * @param _ctx 认证上下文（保留：未来按用户过滤项目级技能）
 */
export async function handleListCapabilities(
  res: ServerResponse,
  _req: IncomingMessage,
  _ctx: AuthContext
): Promise<void> {
  const projectRoot = os.homedir();
  const [skills] = await Promise.all([listSkillsSafe(projectRoot)]);
  // 默认智能体与技能清单同一次请求下发：设置页据此渲染「当前默认」，
  // 免去再加一个只读端点（数据源同为 resolveCurrentSettings，无需重复解析两次以上）
  let defaultAgent: string | null = null;
  try {
    defaultAgent = resolveCurrentSettings(projectRoot).defaultAgent ?? null;
  } catch {
    defaultAgent = null;
  }
  const payload: CapabilitiesResponse = {
    skills,
    mcpServers: listMcpServersSafe(projectRoot),
    defaultAgent,
  };
  sendJson(res, 200, payload);
}
