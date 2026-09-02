/**
 * SkillManager 技能管理模块 —— 从 session.ts 抽取的技能扫描、解析、去重、归一化逻辑
 *
 * 职责：
 * - 技能根目录扫描（项目级 ~/.deepcode/skills、~/.agents/skills、bundled: 等 5 个根）
 * - SKILL.md 文件解析（frontmatter + metadata）
 * - 技能去重（path 维度去重，保留首次出现的同名技能）
 * - 技能归一化（将用户配置与可用技能列表对齐）
 * - 技能路径解析（支持 bundled:/~//./.\ 等前缀）
 * - 技能 Prompt 构建（读取 SKILL.md 内容并格式化）
 * - 已加载技能追踪（基于 sessionId 查询历史 system 消息）
 *
 * 设计原则：
 * - 最小依赖注入：仅依赖 projectRoot / getResolvedSettings / listSessionMessages
 * - 不依赖 LLM 调用（identifyMatchingSkillNames 保留在 SessionManager）
 * - 不依赖消息追加（appendSkillMessages 保留在 SessionManager）
 * - 纯文件系统操作 + 数据处理，可独立单元测试
 *
 * 修订记录：
 * - 2026-07-26：从 session.ts 抽取（11 个方法，约 240 行）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import matter from "gray-matter";
import { buildSkillDocumentsPrompt, getExtensionRoot } from "./prompt";
// type-only import 不会产生运行时循环依赖（TypeScript 编译时擦除）
import type { SessionMessage, SkillInfo } from "./session";

/**
 * SkillManager 依赖上下文
 *
 * 设计说明：
 * - projectRoot: 项目根目录，用于解析 ./ 和 .\ 前缀的技能路径
 * - getResolvedSettings: 设置获取函数，返回包含 enabledSkills 的配置对象
 * - listSessionMessages: 会话消息列表获取函数，用于追踪已加载的技能
 *
 * 这三个依赖是 SkillManager 运行所需的最小集合，
 * 避免直接依赖 SessionManager 实例（降低耦合度）。
 */
export interface SkillManagerContext {
  /** 项目根目录（用于解析相对路径技能） */
  projectRoot: string;
  /** 设置获取函数（用于读取 enabledSkills 配置） */
  getResolvedSettings: () => { enabledSkills?: Record<string, boolean> };
  /** 会话消息列表获取函数（用于追踪已加载技能） */
  listSessionMessages: (sessionId: string) => SessionMessage[];
}

/**
 * SkillManager —— 技能管理器
 *
 * 负责技能的扫描、解析、去重、归一化等文件系统层面的操作。
 * 不涉及 LLM 调用（技能匹配）和消息追加（技能注入会话），
 * 这两部分逻辑保留在 SessionManager 中。
 *
 * 使用方式：
 * ```typescript
 * const skillManager = new SkillManager({
 *   projectRoot: "/path/to/project",
 *   getResolvedSettings: () => settings,
 *   listSessionMessages: (id) => sessionManager.listSessionMessages(id),
 * });
 * const skills = await skillManager.listSkills(sessionId);
 * ```
 */
export class SkillManager {
  constructor(private readonly context: SkillManagerContext) {}

  /**
   * 获取技能扫描根目录列表
   *
   * 扫描顺序（优先级从高到低）：
   * 1. 项目级 .deepcode/skills（项目特定技能）
   * 2. 项目级 .agents/skills（兼容 .agents 目录结构）
   * 3. 用户级 ~/.deepcode/skills（用户全局技能）
   * 4. 用户级 ~/.agents/skills（兼容 .agents 目录结构）
   * 5. Trae IDE builtin_skills（~/.trae-cn/builtin_skills，复用平台成熟 skill）
   * 6. bundled:（内置技能，随扩展发布）
   *
   * A3.1 改进（2026-07-27）：新增第 5 个根 ~/.trae-cn/builtin_skills
   *   - 关联事件：docs/archive/code-review-process-incident.md（原始 review 报告失实事件）
   *   - 动机：DeepCodeX-cli 作为独立 CLI 工具，需复用 Trae IDE 平台已有的
   *     TRAE-code-review / TRAE-security-review 等成熟 skill，避免重复造轮子
   *   - 优先级：低于用户自定义 skill（~/.deepcode/skills、~/.agents/skills），
   *     但高于 DeepCodeX-cli bundled skills，允许用户覆盖
   *
   * @returns 技能根目录数组，每项包含 root（绝对路径）和 displayRoot（展示路径）
   */
  getSkillScanRoots(): Array<{ root: string; displayRoot: string }> {
    const homeDir = os.homedir();
    return [
      // 项目级（最高优先级）
      { root: path.join(this.context.projectRoot, ".deepcode", "skills"), displayRoot: "./.deepcode/skills" },
      { root: path.join(this.context.projectRoot, ".agents", "skills"), displayRoot: "./.agents/skills" },
      // 用户级
      { root: path.join(homeDir, ".deepcode", "skills"), displayRoot: "~/.deepcode/skills" },
      { root: path.join(homeDir, ".agents", "skills"), displayRoot: "~/.agents/skills" },
      // Trae IDE builtin_skills（用户级，平台提供，复用成熟 skill）
      // 优先级低于用户自定义 skill，但高于 DeepCodeX-cli bundled skills
      { root: path.join(homeDir, ".trae-cn", "builtin_skills"), displayRoot: "~/.trae-cn/builtin_skills" },
      // DeepCodeX-cli 内置 bundled skills（最低优先级，可被用户覆盖）
      { root: this.getBundledSkillsRoot(), displayRoot: "bundled:" },
    ];
  }

  /**
   * 获取内置技能根目录
   *
   * 解析逻辑：
   * 1. 开发模式：扩展根目录下存在 src/session.ts → 使用 templates/skills/bundled
   * 2. 发布模式：扩展根目录解析到 dist/ → 使用 dist/bundled
   * 3. 兜底：使用 sourceRoot（templates/skills/bundled）
   *
   * @returns 内置技能根目录的绝对路径
   */
  getBundledSkillsRoot(): string {
    const extensionRoot = getExtensionRoot();
    const sourceRoot = path.join(extensionRoot, "templates", "skills", "bundled");

    // 开发模式检查：扩展根目录下存在 src/session.ts 且 sourceRoot 存在时使用 sourceRoot
    if (fs.existsSync(path.join(extensionRoot, "src", "session.ts")) && fs.existsSync(sourceRoot)) {
      return sourceRoot;
    }

    // 发布模式：getExtensionRoot() 解析到 dist/，bundled 技能复制到 dist/bundled/
    const distRoot = path.join(extensionRoot, "bundled");
    return fs.existsSync(distRoot) ? distRoot : sourceRoot;
  }

  /**
   * 列出所有可用技能
   *
   * 扫描所有技能根目录，收集 SKILL.md 文件，解析技能信息。
   * 同名技能以首次出现的为准（高优先级根目录覆盖低优先级）。
   * 如果传入 sessionId，会标记已加载的技能（isLoaded=true）。
   *
   * @param sessionId 可选的会话 ID，用于标记已加载技能
   * @returns 按名称排序的技能信息数组
   */
  async listSkills(sessionId?: string): Promise<SkillInfo[]> {
    const skillRoots = this.getSkillScanRoots();
    const enabledSkills = this.context.getResolvedSettings().enabledSkills ?? {};
    const skillsByName = new Map<string, SkillInfo>();

    /**
     * 收集单个根目录下的所有技能
     *
     * @param root 技能根目录绝对路径
     * @param displayRoot 展示用根路径前缀（如 "bundled:" 或 "./.deepcode/skills"）
     * @returns 技能信息数组
     */
    const collectSkills = (root: string, displayRoot: string): SkillInfo[] => {
      if (!fs.existsSync(root)) {
        return [];
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }

      const results: SkillInfo[] = [];
      for (const entry of entries) {
        // 仅处理目录和符号链接（技能以目录形式组织）
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        const skillName = entry.name;
        const skillPath = path.join(root, skillName, "SKILL.md");
        try {
          if (!fs.existsSync(skillPath)) {
            continue;
          }
          const stat = fs.statSync(skillPath);
          if (!stat.isFile()) {
            continue;
          }
        } catch {
          continue;
        }
        const displayPath =
          displayRoot === "bundled:" ? `bundled:${skillName}/SKILL.md` : `${displayRoot}/${skillName}/SKILL.md`;
        const skill = this.readSkillInfo(skillPath, displayPath, skillName);
        // 检查 enabledSkills 配置：值为 false 时禁用该技能
        if (enabledSkills[skill.name] === false) {
          continue;
        }
        results.push(skill);
      }
      return results;
    };

    // 按优先级顺序扫描所有根目录，同名技能以首次出现为准
    for (const { root, displayRoot } of skillRoots) {
      for (const skill of collectSkills(root, displayRoot)) {
        if (!skillsByName.has(skill.name)) {
          skillsByName.set(skill.name, skill);
        }
      }
    }

    // 如果传入 sessionId，标记已加载的技能
    if (sessionId) {
      const loadedSkillKeys = this.getLoadedSkillKeys(sessionId);
      for (const skill of skillsByName.values()) {
        if (loadedSkillKeys.has(this.getSkillKey(skill)) || loadedSkillKeys.has(this.getSkillKeyByName(skill.name))) {
          skill.isLoaded = true;
        }
      }
    }

    return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 解析技能路径为绝对路径
   *
   * 支持的路径前缀：
   * - bundled: → 内置技能根目录下的相对路径（含路径遍历防御）
   * - ~/ → 用户主目录下的路径
   * - ~\ → Windows 风格的用户主目录路径
   * - ./ → 项目根目录下的相对路径
   * - .\ → Windows 风格的项目根目录相对路径
   * - 绝对路径 → 直接返回
   * - 其他 → 归一化为用户主目录下的路径
   *
   * 安全性：
   * - bundled: 前缀的路径会检查 path traversal，防止访问内置技能根目录之外的文件
   *
   * @param skillPath 技能路径（可能含前缀）
   * @returns 解析后的绝对路径
   */
  resolveSkillPath(skillPath: string): string {
    if (skillPath.startsWith("bundled:")) {
      const relativePath = skillPath.slice("bundled:".length);
      const root = this.getBundledSkillsRoot();
      const resolvedPath = path.resolve(root, relativePath);
      const resolvedRoot = path.resolve(root);
      // 路径遍历防御：解析后的路径必须在 bundled 根目录内
      if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        return path.join(root, "__invalid_bundled_skill__");
      }
      return resolvedPath;
    }
    if (skillPath.startsWith("~/")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("~\\")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("./")) {
      return path.join(this.context.projectRoot, skillPath.slice(2));
    }
    if (skillPath.startsWith(".\\")) {
      return path.join(this.context.projectRoot, skillPath.slice(2));
    }
    if (path.isAbsolute(skillPath)) {
      return skillPath;
    }
    return path.join(os.homedir(), skillPath);
  }

  /**
   * 构建技能 Prompt（读取 SKILL.md 内容并格式化）
   *
   * @param skill 技能信息
   * @returns 格式化后的技能 Prompt 字符串
   */
  buildSkillPrompt(skill: SkillInfo): string {
    const skillPath = this.resolveSkillPath(skill.path);
    return buildSkillDocumentsPrompt([
      {
        name: skill.name,
        content: fs.readFileSync(skillPath, "utf8"),
        path: skillPath,
        skillFilePath: skillPath,
      },
    ]);
  }

  /**
   * 读取技能信息（解析 SKILL.md 的 frontmatter）
   *
   * SKILL.md 格式：
   * ```
   * ---
   * name: skill-name
   * description: 技能描述
   * metadata:
   *   allow-implicit-invocation: false
   * ---
   * 技能正文...
   * ```
   *
   * 错误处理：
   * - 文件读取失败 → 返回 fallback 技能信息（name 用 fallbackName）
   * - frontmatter 解析失败 → 返回 fallback 技能信息
   * - name 字段缺失或空 → 使用 fallbackName（下划线转连字符）
   * - description 缺失 → 空字符串
   *
   * @param skillPath SKILL.md 文件绝对路径
   * @param displayPath 展示用路径（如 "bundled:skill-name/SKILL.md"）
   * @param fallbackName 解析失败时的兜底技能名
   * @returns 技能信息对象
   */
  readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
    const fallbackSkill: SkillInfo = {
      name: fallbackName.replace(/_/g, "-"),
      path: displayPath,
      description: "",
    };

    try {
      const skillMd = fs.readFileSync(skillPath, "utf8");
      const parsed = matter(skillMd);
      const metadata = parsed.data.metadata;
      // 解析 metadata.allow-implicit-invocation 字段
      const allowImplicitInvocation =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>)["allow-implicit-invocation"] === false
          ? false
          : undefined;
      return {
        name:
          typeof parsed.data.name === "string" && parsed.data.name.trim()
            ? parsed.data.name.trim()
            : fallbackSkill.name,
        path: displayPath,
        description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
        allowImplicitInvocation,
      };
    } catch {
      return fallbackSkill;
    }
  }

  /**
   * 获取技能的唯一标识键（基于 path）
   *
   * @param skill 技能信息（仅需 path 字段）
   * @returns 技能标识键，格式为 "path:<path>"
   */
  getSkillKey(skill: Pick<SkillInfo, "path">): string {
    return `path:${skill.path}`;
  }

  /**
   * 获取技能的唯一标识键（基于 name）
   *
   * @param name 技能名称
   * @returns 技能标识键，格式为 "name:<name>"
   */
  getSkillKeyByName(name: string): string {
    return `name:${name}`;
  }

  /**
   * 获取会话中已加载的技能键集合
   *
   * 扫描会话的所有 system 消息，收集 meta.skill 中的技能信息。
   * 同时以 path 和 name 两种维度建立键集合，用于后续的 isLoaded 判断。
   *
   * @param sessionId 会话 ID
   * @returns 已加载技能的键集合（包含 path: 和 name: 两种前缀）
   */
  getLoadedSkillKeys(sessionId: string): Set<string> {
    const loadedSkillKeys = new Set<string>();
    for (const message of this.context.listSessionMessages(sessionId)) {
      // 合并上游 0.3.1 后，skill 工具把已加载文档记录在 tool 消息的 meta.skill 中
      // （不再写入独立的 system 消息），因此扫描需同时覆盖 system 与 tool 两类消息
      if (!message.meta?.skill) {
        continue;
      }
      loadedSkillKeys.add(this.getSkillKey(message.meta.skill));
      loadedSkillKeys.add(this.getSkillKeyByName(message.meta.skill.name));
    }
    return loadedSkillKeys;
  }

  /**
   * 技能去重（基于 path 维度）
   *
   * 去重规则：
   * - 以 path 为唯一键，相同 path 的技能合并
   * - 合并时保留后出现的技能字段（覆盖语义）
   * - description 优先使用后出现的，否则使用前存在的，否则空字符串
   * - isLoaded 取两者的并集（任一为 true 则为 true）
   *
   * @param skills 待去重的技能数组
   * @returns 去重后的技能数组，输入为空时返回 undefined
   */
  dedupeSkills(skills?: SkillInfo[]): SkillInfo[] | undefined {
    if (!skills || skills.length === 0) {
      return undefined;
    }

    const dedupedSkills = new Map<string, SkillInfo>();
    for (const skill of skills) {
      if (!skill?.name || !skill?.path) {
        continue;
      }
      const key = this.getSkillKey(skill);
      const existingSkill = dedupedSkills.get(key);
      dedupedSkills.set(key, {
        ...existingSkill,
        ...skill,
        description: skill.description ?? existingSkill?.description ?? "",
        isLoaded: Boolean(existingSkill?.isLoaded || skill.isLoaded),
      });
    }

    return Array.from(dedupedSkills.values());
  }

  /**
   * 技能归一化（将用户配置与可用技能列表对齐）
   *
   * 归一化流程：
   * 1. 先对输入技能去重
   * 2. 获取当前可用的技能列表（listSkills）
   * 3. 以 path 和 name 两种维度建立可用技能索引
   * 4. 对每个待归一化技能，查找匹配的可用技能：
   *    - 优先 path 匹配，其次 name 匹配
   *    - 找到匹配时合并字段（保留用户配置的 isLoaded，使用可用技能的 description）
   *    - 未找到匹配时保持原样
   *
   * @param skills 待归一化的技能数组
   * @param sessionId 可选的会话 ID，用于 listSkills 标记 isLoaded
   * @returns 归一化后的技能数组，输入为空时返回 undefined
   */
  async normalizeSkills(skills?: SkillInfo[], sessionId?: string): Promise<SkillInfo[] | undefined> {
    const dedupedSkills = this.dedupeSkills(skills);
    if (!dedupedSkills || dedupedSkills.length === 0) {
      return undefined;
    }

    const availableSkills = await this.listSkills(sessionId);
    const availableSkillsByKey = new Map<string, SkillInfo>();
    for (const skill of availableSkills) {
      availableSkillsByKey.set(this.getSkillKey(skill), skill);
      availableSkillsByKey.set(this.getSkillKeyByName(skill.name), skill);
    }

    return dedupedSkills.map((skill) => {
      const matchedSkill =
        availableSkillsByKey.get(this.getSkillKey(skill)) ??
        availableSkillsByKey.get(this.getSkillKeyByName(skill.name));
      if (!matchedSkill) {
        return skill;
      }
      return {
        ...matchedSkill,
        ...skill,
        description: matchedSkill.description || skill.description,
        isLoaded: Boolean(matchedSkill.isLoaded || skill.isLoaded),
      };
    });
  }
}
