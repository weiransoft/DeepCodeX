/**
 * AgentRegistry —— 自定义 Agent 注册表（T01，架构 §3）
 *
 * 职责：
 * - 包装既有 SkillManager 扫描链（6 根 / 同名覆盖优先级 / enabledSkills 开关零改动），
 *   仅返回 frontmatter `type: agent` 的条目；
 * - Agent 定义解析（role 缺省回退 description 首句、正文读取、kebab-case 校验）；
 * - 构建单个 agent 的注入 prompt 与 system prompt 索引段（索引只含 name + role +
 *   description，无正文、无绝对路径，对齐 dsh「目录摘要不暴露正文/绝对路径」防线）。
 *
 * 设计原则（架构 §1.1）：
 * - 复用优先：不发明第二套文件体系，Agent 是「带角色约束的指令资产」；
 * - 失败安全：扫描/解析/正文读取任何异常 → 结构化日志 + 降级（空列表 / 空 body），
 *   非法定义（缺 name/description、name 非 kebab-case）跳过并中文告警，不中断其余扫描；
 * - core 单一装配源：SessionManager 内部装配本注册表，cli/web 不直接读 SKILL.md。
 *
 * @module agents/agent-registry
 */

import * as fs from "node:fs";
import matter from "gray-matter";
import type { SkillInfo } from "../session";
import { SkillManager } from "../skill-manager";
import type { SedimentLogFn } from "../common/sediment-logger";

/** agent/skill 名称统一 kebab-case 校验（架构 §7 共享知识 #1） */
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Agent 定义（架构 §3 签名级约定）
 *
 * 在 SkillInfo 基础上收紧 kind 并补充 role/body：
 * - kind 恒为 "agent"（type: skill 的条目不会进入本注册表）；
 * - role 必填（frontmatter `role` 缺省回退 description 首句）；
 * - body 为 SKILL.md 正文（去 frontmatter 后的行为约束）。
 */
export interface AgentDefinition extends SkillInfo {
  kind: "agent";
  role: string;
  body: string;
}

/** AgentRegistry 依赖上下文（架构 §3 构造签名） */
export interface AgentRegistryDeps {
  /** 项目根目录（SkillManager 扫描根解析用） */
  projectRoot: string;
  /** 设置获取函数（用于读取 enabledSkills 配置，agent 与 skill 共用同一开关） */
  getResolvedSettings: () => { enabledSkills?: Record<string, boolean> };
  /** 可选：复用宿主既有 SkillManager（SessionManager 装配时注入，共享 isLoaded 追踪）；
   *  缺省时内部新建（独立单元测试场景） */
  skillManager?: SkillManager;
  /** 可选：结构化日志函数（缺省 console.warn 兜底；禁止打印对话原文与 PII） */
  log?: SedimentLogFn;
}

/**
 * AgentRegistry —— 自定义 Agent 注册表
 */
export class AgentRegistry {
  private readonly skillManager: SkillManager;
  private readonly log: SedimentLogFn;

  constructor(deps: AgentRegistryDeps) {
    // 复用宿主 SkillManager 时共享扫描根与 enabledSkills；独立构造时用最小依赖
    this.skillManager =
      deps.skillManager ??
      new SkillManager({
        projectRoot: deps.projectRoot,
        getResolvedSettings: deps.getResolvedSettings,
        listSessionMessages: () => [],
      });
    this.log =
      deps.log ??
      ((event) => {
        const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
        console.warn(`[agent-registry] ${message}`);
      });
  }

  /**
   * 扫描全部根，仅返回 kind==="agent" 条目（同名覆盖规则与 skill 一致）。
   *
   * 非法定义（缺 description、name 非 kebab-case）→ 跳过 + 中文告警，不中断其余扫描。
   * fail-safe：扫描链任何异常 → 空数组 + 结构化日志。
   *
   * @param sessionId 可选会话 ID（isLoaded 标记与 skill 同通道）
   */
  async listAgents(sessionId?: string): Promise<AgentDefinition[]> {
    try {
      const entries = await this.skillManager.listSkills(sessionId);
      const agents: AgentDefinition[] = [];
      for (const entry of entries) {
        if (entry.kind !== "agent") {
          continue;
        }
        const agent = this.toAgentDefinition(entry);
        if (agent) {
          agents.push(agent);
        }
      }
      return agents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log({ event: "agent-scan-degrade", message });
      return [];
    }
  }

  /**
   * 按名解析 Agent 定义；未找到返回 undefined（fail-safe，不抛出）。
   *
   * @param name agent 名称（kebab-case）
   */
  async resolveAgent(name: string): Promise<AgentDefinition | undefined> {
    if (typeof name !== "string" || name.trim().length === 0) {
      return undefined;
    }
    try {
      const agents = await this.listAgents();
      return agents.find((agent) => agent.name === name.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log({ event: "agent-resolve-degrade", name, message });
      return undefined;
    }
  }

  /**
   * 单个 agent 注入 prompt（正文 + 角色前后缀包装）。
   *
   * @param agent Agent 定义
   * @returns 角色约束 prompt（<agent_content> 包裹，与 <skill_content> 形态对齐）
   */
  buildAgentPrompt(agent: AgentDefinition): string {
    const roleAttribute = agent.role ? ` role="${escapeXmlAttribute(agent.role)}"` : "";
    const body = typeof agent.body === "string" && agent.body.trim() ? agent.body : "";
    return `The following custom agent definition has been loaded. Adopt its role identity and follow its behavioral constraints when handling the current task.

<agent_content name="${escapeXmlAttribute(agent.name)}"${roleAttribute}>
${body}
</agent_content>`;
  }

  /**
   * system prompt 索引段：名称 + role + description（无正文、无绝对路径）。
   *
   * @param agents Agent 定义列表
   * @returns 索引段 prompt（列表为空时返回空字符串，由调用方决定是否注入）
   */
  buildAgentIndexPrompt(agents: AgentDefinition[]): string {
    if (!Array.isArray(agents) || agents.length === 0) {
      return "";
    }
    const entries = agents.map((agent) => `- \`${agent.name}\`（${agent.role}）：${agent.description}`).join("\n");
    return `Custom agents extend this session with role-specific behavior. The following agents are available:

<available_agents>
${entries}
</available_agents>

To activate an agent, call the \`agent\` tool with the exact agent name; its role constraints will then be injected into this conversation. This index contains summaries only; do not assume an agent's instructions until it has been loaded.`;
  }

  /**
   * kebab-case 校验（^[a-z0-9]+(?:-[a-z0-9]+)*$，架构 §7 共享知识 #1）。
   */
  isValidAgentName(name: string): boolean {
    return typeof name === "string" && KEBAB_CASE_PATTERN.test(name);
  }

  /**
   * 将 skill 条目转换为 AgentDefinition（校验 + 回退 + 正文读取）。
   *
   * 校验失败（缺 description / name 非 kebab-case）返回 undefined 并中文告警。
   *
   * @param entry skill 条目（kind 必须为 "agent"）
   */
  private toAgentDefinition(entry: SkillInfo): AgentDefinition | undefined {
    // 非法 frontmatter：description 缺失（中文报错，不中断其余扫描——T01 验收③）
    if (!entry.description) {
      this.log({
        event: "agent-definition-invalid",
        name: entry.name,
        path: entry.path,
        message: `自定义 Agent 定义非法：${entry.path} 缺少 description 字段，已跳过该条目`,
      });
      return undefined;
    }
    // 非法 frontmatter：name 非 kebab-case（含缺 name 回退目录名后仍不合法的情形）
    if (!this.isValidAgentName(entry.name)) {
      this.log({
        event: "agent-definition-invalid",
        name: entry.name,
        path: entry.path,
        message: `自定义 Agent 定义非法：${entry.path} 的 name「${entry.name}」必须为 kebab-case（小写字母/数字/连字符），已跳过该条目`,
      });
      return undefined;
    }
    const role = this.resolveRole(entry);
    return {
      ...entry,
      kind: "agent",
      role,
      body: this.readAgentBody(entry),
    };
  }

  /**
   * 解析角色身份：frontmatter `role` 缺省回退 description 首句（架构 §3）。
   */
  private resolveRole(entry: SkillInfo): string {
    const explicitRole = typeof entry.role === "string" ? entry.role.trim() : "";
    if (explicitRole) {
      return explicitRole;
    }
    const firstSentence = entry.description.split(/[。.!！?？\n]/)[0]?.trim() ?? "";
    return firstSentence || entry.description.trim();
  }

  /**
   * 读取 SKILL.md 正文（去 frontmatter）。
   *
   * fail-safe：读取/解析失败返回空字符串 + 结构化日志（不影响列表展示）。
   */
  private readAgentBody(entry: SkillInfo): string {
    try {
      const skillPath = this.skillManager.resolveSkillPath(entry.path);
      const raw = fs.readFileSync(skillPath, "utf8");
      const parsed = matter(raw);
      return parsed.content.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log({
        event: "agent-body-read-degrade",
        name: entry.name,
        path: entry.path,
        message: `自定义 Agent 正文读取失败（降级为空正文）：${message}`,
      });
      return "";
    }
  }
}

/** XML 属性转义（agent_content 标签属性防注入） */
function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
