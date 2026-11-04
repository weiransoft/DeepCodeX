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

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SkillManager,
  buildTeamCommandDescriptors,
  resolveCurrentSettings,
  type McpServerConfig,
} from "@vegamo/deepcode-core";
import { sendJson } from "../http-utils";
import { skillsHomeForUser, type EngineHomeSettings } from "../engine-home";
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
  /**
   * agent 专属：中文角色身份（frontmatter `role`）
   *
   * `name` 是技术标识（kebab-case，@ 提及 token 与目录名同源），不能拿来展示；
   * 中文名只存在这个字段里。界面统一经 `agent-display.ts` 的
   * `agentDisplayName()` 取值，缺省时回退 name。
   */
  role?: string;
};

/** MCP 服务器条目（脱敏：不下发 env） */
export type CapabilityMcpServer = {
  name: string;
  command: string;
  args?: string[];
};

/**
 * 斜杠命令条目（2026-11-02 接线审查 D3）
 *
 * 来源是 core 的 `buildTeamCommandDescriptors()`——与 CLI、与注入 EAG 建议层的
 * 描述符**同一个数据源**。前端补全面板只消费这份清单，不再各自手写命令表：
 * 过去 Web 手写 5 条与 CLI 重复的描述符，改一个子命令就要改三处，漏改即"看起来
 * 有入口、敲了静默降级"。
 */
export type CapabilityCommand = {
  /** 命令名（含斜杠，如 "/team dispatch"） */
  name: string;
  description: string;
  /** 参数提示（如 "--task <任务描述>"） */
  args?: string[];
};

/** GET /api/capabilities 响应体 */
export type CapabilitiesResponse = {
  skills: CapabilitySkill[];
  mcpServers: CapabilityMcpServer[];
  /** 默认智能体（settings.agents.default；未配置为 null） */
  defaultAgent: string | null;
  /** 可在对话里直接执行的斜杠命令（当前为 /team 体系） */
  commands: CapabilityCommand[];
};

/**
 * 技能扫描降级包装：SkillManager 扫描依赖文件系统，任何异常（权限/缺失）
 * 都不应拖垮整个端点——返回空数组并保持其余能力可用。
 *
 * 导出复用：chat-api 发送链路的 @agent 激活按同名扫描解析提及名单。
 *
 * @param projectRoot 项目根（项目级技能扫描起点）
 * @param homeRoot 引擎数据家目录（用户级扫描根锚点，2026-11-02 D4）；缺省进程家目录
 */
export async function listSkillsSafe(projectRoot: string, homeRoot?: string): Promise<CapabilitySkill[]> {
  try {
    const manager = new SkillManager({
      projectRoot,
      // 仅列表场景：无 enabledSkills 过滤、无会话消息追踪需求
      getResolvedSettings: () => ({}),
      listSessionMessages: () => [],
      ...(homeRoot !== undefined ? { homeRoot } : {}),
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
      // 中文角色身份：仅 agent 条目有值，供前端展示（name 是技术标识，不适合展示）
      ...(typeof s.role === "string" && s.role.trim() !== "" ? { role: s.role.trim() } : {}),
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
 * 斜杠命令清单：直接复用 core 的描述符（单一数据源），映射为前端需要的三段字段。
 *
 * 不抛错：描述符来自编译期常量，异常只可能是打包问题；降级为空数组时前端
 * 仅失去补全提示，手动敲命令仍可执行（execution 不依赖本清单）。
 *
 * 导出供测试直接断言（无需构造 ServerResponse）。
 */
export function listCommandsSafe(): CapabilityCommand[] {
  try {
    return buildTeamCommandDescriptors().map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      ...(descriptor.args && descriptor.args.length > 0 ? { args: [...descriptor.args] } : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * 处理 GET /api/capabilities（已认证）。
 *
 * 扫描根（2026-11-02 接线审查 D4）：用户级根锚定**本用户的引擎数据家目录**
 * （personalOnly=true 时 `<engineHomeRoot>/<userId>`），不再一律用 `os.homedir()`。
 * 否则 Web 用户在自己 homeRoot 下建的技能/智能体扫不到，而所有人共享进程家目录
 * 下那一份——多用户串号。
 *
 * 技能资产根（2026-11-04）：改用 `skillsHomeForUser()`——显式配置了
 * `web.skillsHomeDir` / `DEEPCODE_WEB_SKILLS_HOME_DIR` 时直读直写该路径
 * （本机单用户部署：桌面与 CLI 同源），否则回退 per-user 隔离。
 * 关键不变量：**写入根与扫描根必须同源**（agents-api 的落盘根同口径），
 * 否则「刚建的智能体」永远扫不到。
 *
 * projectRoot 同样取引擎数据家目录：项目级扫描根（`.deepcode/skills`）原本指向家目录，
 * 也只是"能扫到点东西"的近似，改锚后与用户实际数据根一致。
 *
 * @param res 响应对象
 * @param _req 请求对象（当前无查询参数）
 * @param ctx 认证上下文（提供 userId 用于解析 per-user 引擎数据根）
 * @param settings 归一后的 Web 配置（提供 personalOnly / engineHomeRoot / skillsHomeRoot）
 */
export async function handleListCapabilities(
  res: ServerResponse,
  _req: IncomingMessage,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): Promise<void> {
  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  const [skills] = await Promise.all([listSkillsSafe(homeRoot, homeRoot)]);
  // 默认智能体与技能清单同一次请求下发：设置页据此渲染「当前默认」，
  // 免去再加一个只读端点（数据源同为 resolveCurrentSettings，无需重复解析两次以上）
  let defaultAgent: string | null = null;
  try {
    defaultAgent = resolveCurrentSettings(homeRoot).defaultAgent ?? null;
  } catch {
    defaultAgent = null;
  }
  const payload: CapabilitiesResponse = {
    skills,
    mcpServers: listMcpServersSafe(homeRoot),
    defaultAgent,
    commands: listCommandsSafe(),
  };
  sendJson(res, 200, payload);
}
