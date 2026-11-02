/**
 * 智能体 → team 角色桥接（L0-2，2026-11-02）
 *
 * ## 解决的问题
 *
 * 此前存在两套互不相连的智能体体系（见 `docs/team-wiring-audit-20261101.md` §5）：
 * - 体系 A：`team/role-registry.ts` 里 5 个硬编码 `const`，`/team` 只认它们
 * - 体系 B：`~/.deepcode/skills/**` 下的 `type: agent` 文件（35 个预置 + 用户自建）
 *
 * 结果：用户有 35 个智能体，但 `/team match --keywords 增长` 永远看不到营销专家。
 * 本模块把 B 映射为 A 可消费的 `RoleDefinition`，让「能力更强的一轨」进入 `/team` 候选集。
 *
 * ## 依赖方向（硬约束）
 *
 * `agents → team` **单向**。反过来会让 `team/` 依赖 `agents/`，而 `agents/preset-agents.ts`
 * 已经从 `team/` 取专家数据，形成环（共识问题 C-01）。因此本文件放在 `agents/` 下，
 * 且不 import `team/` 的任何运行时符号以外的模块——只有类型与 schema。
 *
 * ## 安全门禁（共识 C-02 / D-02）
 *
 * | 规则 | 实现 |
 * | --- | --- |
 * | 仅 `preset: true` 进入默认候选 | `options.allowUserAgents !== true` 时直接过滤（代码级 if） |
 * | 自建智能体需显式开关 | 调用方经 `resolveRuntimeRoleOptions()` 从 settings 读取，默认 false |
 * | 开启后 description 只作匹配元数据 | `systemPromptPrefix` 构建时**不拼接** description |
 * | group 必须 ∈ 8 类别 | 不在白名单直接跳过，不猜测 |
 *
 * ## 关键词生成（共识 C-02）
 *
 * **只用 group 枚举映射**，不解析 description。原因：项目无中文分词依赖，
 * 伪分词（按标点/长度切）质量差会拉低匹配；且 description 是不可信文本。
 *
 * @module agents/role-bridge
 */

import type { RoleDefinition } from "../team/types.js";

/**
 * 桥接输入：只声明需要的字段，`SkillInfo` 结构上直接兼容
 *
 * 刻意不 import `session.ts` 的 `SkillInfo`：那会让 `agents → session` 产生依赖，
 * 而 `session` 已经依赖 `agents`（`preset-agents`），会成环。
 */
export interface AgentSkillLike {
  name: string;
  description: string;
  /** 条目种类：`agent` 才参与桥接 */
  kind?: "skill" | "agent";
  /** 角色身份（frontmatter `role`） */
  role?: string;
  /** 是否预置智能体（frontmatter `preset: true`） */
  preset?: boolean;
  /** 业务类别（frontmatter `group`） */
  group?: string;
}

/** 桥接选项 */
export interface BuildRolesOptions {
  /** 是否允许用户自建智能体进入候选（默认 false；需 settings 显式开启） */
  allowUserAgents?: boolean;
  /**
   * 总开关（默认 true）
   *
   * 设为 false 时直接返回空数组——调用方（`team.runtimeRoles.enabled=false`）由此实现
   * 「一键回滚到只剩 5 个内置角色」。
   */
  enabled?: boolean;
  /**
   * 需要排除的 roleId（通常是 5 个内置角色 ID）
   *
   * 为什么需要：`preset-agents.ts` 把 5 个核心角色也物化成了 SKILL.md
   * （name 直接取 roleId，group="core"），它们的作用是被 `@` 提及，
   * 不应再作为 `/team` 的运行时角色——否则候选集里会出现两份 architect。
   */
  excludeRoleIds?: ReadonlyArray<string>;
}

/**
 * 8 个业务类别 → 固定关键词集（纯枚举映射，零依赖）
 *
 * 关键词同时用作 `capabilities`：这样能力匹配分（权重 50%）与类别相关性一致，
 * 而不是所有运行时角色拿到同一份通用能力清单（那会让关键词分（20%）独自承担区分度）。
 */
const GROUP_KEYWORDS: Record<string, string[]> = {
  product: ["需求", "PRD", "用户故事", "验收标准"],
  "project-management": ["流程", "排期", "里程碑", "交付"],
  strategy: ["战略", "定位", "路线图", "竞争"],
  support: ["支持", "工单", "服务", "培训"],
  specialized: ["专项", "深度", "领域"],
  academic: ["论文", "研究", "文献", "学术"],
  marketing: ["增长", "投放", "内容", "品牌", "获客"],
  sales: ["销售", "商机", "客户", "成单"],
};

/** 类别中文标签（仅用于 description / 能力展示，不参与匹配） */
const GROUP_LABELS: Record<string, string> = {
  product: "业务需求",
  "project-management": "业务流程",
  strategy: "业务战略",
  support: "业务支持",
  specialized: "专业领域",
  academic: "学术研究",
  marketing: "营销增长",
  sales: "销售",
};

/** 类别配色（同一类别同一颜色，便于 `/team list` 与设置页辨识） */ const GROUP_COLORS: Record<string, string> = {
  product: "#2563EB",
  "project-management": "#7C3AED",
  strategy: "#0F766E",
  support: "#B45309",
  specialized: "#475569",
  academic: "#1D4ED8",
  marketing: "#DB2777",
  sales: "#059669",
};

/**
 * 运行时角色统一的 system prompt 前缀（不含任何用户可控文本）
 *
 * 只有这一段 + `role`（frontmatter 显式声明的一行身份）+ 预置智能体的 description
 * 会进入 prompt；用户自建智能体的 description **不进入**（SEC/B7 硬约束）。
 */
const RUNTIME_ROLE_PREAMBLE = `# 行为准则（Karpathy 四大核心原则，强制执行）

1. **Think Before Coding（三思而后行）**：动手前先明确假设、列出权衡，信息不足先提问
2. **Simplicity First（简单优先）**：最小可行方案，不做投机性设计
3. **Surgical Changes（精准修改）**：只改必要的，不顺手重构无关代码
4. **Goal-Driven（目标驱动）**：先定义成功标准，再验证，迭代到达成

## 通用约束

- 所有外部输入视为不可信，先校验再使用
- 不臆造事实与文件内容；不确定时明确说明并给出获取途径
- 输出结构化、可执行，避免空泛结论`;

/** 中文分组名 → 类别键（反向映射，兼容两种 frontmatter 写法） */
const LABEL_TO_GROUP: Record<string, string> = Object.fromEntries(
  Object.entries(GROUP_LABELS).map(([key, label]) => [label, key])
);

/**
 * 归一化 group 写法
 *
 * 为什么需要：`agents/preset-agents.ts` 写 frontmatter 时用的是**中文分组名**
 * （`group: 业务需求`，因为界面直接展示该值），而 team 的类别枚举是英文键
 * （`product`）。桥接层必须两种都认，否则预置专家一个都进不了候选集——
 * 这是"数据写了、桥接没认"的静默失效，比报错更难发现。
 *
 * 另外 `group: core`（5 个核心角色物化成的 SKILL.md）返回 undefined：
 * 它们已经以内置角色身份存在，不该重复进入候选集。
 *
 * @returns 8 个类别键之一；非业务类别或未知标签返回 undefined
 */
export function normalizeGroup(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || value === "core") return undefined;
  if (Object.prototype.hasOwnProperty.call(GROUP_KEYWORDS, value)) return value;
  return LABEL_TO_GROUP[value];
}

/** 判定某 group 是否为已知的 8 类业务类别（接受英文键与中文标签） */
export function isKnownGroup(group: string | undefined): boolean {
  return normalizeGroup(group) !== undefined;
}

/**
 * 取类别的固定关键词集（未知名返回空数组）
 *
 * 导出供 CLI / Web 展示与测试断言「关键词只来自枚举映射」。
 */
export function getGroupKeywords(group: string | undefined): string[] {
  const key = normalizeGroup(group);
  if (!key) return [];
  return [...GROUP_KEYWORDS[key]];
}

/** 取类别中文标签（未知名回落"其他"） */
export function getGroupLabel(group: string | undefined): string {
  const key = normalizeGroup(group);
  return key ? (GROUP_LABELS[key] ?? "其他") : "其他";
}

/** 从 description 提取首句作为兜底身份（仅预置智能体使用） */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const match = trimmed.match(/^[^。.!?\n]{1,80}/);
  return (match?.[0] ?? trimmed.slice(0, 80)).trim();
}

/**
 * 构建 system prompt 前缀
 *
 * @param skill 智能体条目
 * @param allowDescription 是否允许把 description 拼进指令区
 *   - 预置智能体：允许（内容由本仓库生成，可信）
 *   - 用户自建：**禁止**（description 是用户可控文本，只能用于匹配元数据）
 */
function buildSystemPromptPrefix(skill: AgentSkillLike, allowDescription: boolean): string {
  const identity =
    typeof skill.role === "string" && skill.role.trim() !== ""
      ? skill.role.trim()
      : allowDescription
        ? firstSentence(skill.description)
        : `智能体 ${skill.name}`;

  const parts = [RUNTIME_ROLE_PREAMBLE, `## 角色身份\n${identity}`];
  if (allowDescription) {
    const detail = skill.description.trim();
    if (detail.length >= 10) {
      parts.push(`## 职责说明\n${detail}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * 把智能体条目转换为 team 角色定义
 *
 * 过滤条件（全部满足才转换）：
 * 1. `kind === "agent"`（缺省视为 skill，不参与）
 * 2. `group` ∈ 8 个已知类别
 * 3. `preset === true` 或 `options.allowUserAgents === true`
 *
 * @param skills 智能体条目（来自 `SkillManager` 扫描链）
 * @param options 桥接选项
 * @returns 角色定义数组；不满足条件的条目被跳过（不抛错——扫描链里混着普通 skill）
 */
export function buildRolesFromAgents(
  skills: ReadonlyArray<AgentSkillLike>,
  options: BuildRolesOptions = {}
): RoleDefinition[] {
  if (options.enabled === false) return [];
  const allowUserAgents = options.allowUserAgents === true;
  const excluded = new Set(options.excludeRoleIds ?? []);

  const roles: RoleDefinition[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    if (skill.kind !== "agent") continue;
    const group = normalizeGroup(skill.group);
    if (!group) continue;
    const isPreset = skill.preset === true;
    if (!isPreset && !allowUserAgents) continue;

    // roleId 必须满足 kebab-case（RuntimeRoleId 约束）；不合规的智能体名直接跳过，
    // 而不是改写它——改写会导致 `/team dispatch --role` 与 SKILL.md 名不一致。
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(skill.name)) continue;
    if (excluded.has(skill.name)) continue;
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);

    const label = getGroupLabel(group);
    const keywords = getGroupKeywords(group);
    const description = skill.description.trim();
    const identity = typeof skill.role === "string" && skill.role.trim() !== "" ? skill.role.trim() : skill.name;

    roles.push({
      roleId: skill.name,
      name: identity,
      nameEn: skill.name,
      description: description.length >= 10 ? description : `${identity}（${label}业务角色）`,
      systemPromptPrefix: buildSystemPromptPrefix(skill, isPreset),
      systemPromptSuffix: "",
      // 能力 = 类别关键词：让能力分（50% 权重）与类别相关性一致
      capabilities: keywords.length >= 3 ? keywords : [label, "领域分析", "方案产出"],
      // 技能不是匹配主信号（30%），用于展示与兜底区分
      skills: [label, identity, "领域任务执行"],
      keywords: keywords.length >= 3 ? keywords : [label, identity, "领域任务"],
      // 优先级约束（方案 §4.5）：内置角色 high/medium（6~10）> 预置专家 5 > 自建 3
      priority: isPreset ? 5 : 3,
      metadata: {
        color: GROUP_COLORS[group] ?? "#475569",
        icon: "agent",
        outputFormat: "markdown",
        enabledByDefault: true,
        source: isPreset ? "preset" : "custom",
        group,
      },
    });
  }

  return roles;
}

/**
 * 从 settings 解析桥接开关（唯一读取点）
 *
 * settings.json：
 * ```jsonc
 * { "team": { "runtimeRoles": { "enabled": true, "allowUserAgents": false } } }
 * ```
 *
 * ## 默认值取舍（相对方案 §4.4 / P3 的一处偏差，已记录）
 *
 * 方案建议 `enabled` 默认 false（"先关后开"）。落地时改为**默认 true**，理由：
 * - `enabled` 只控制"预置智能体是否进入候选"。预置 35 个是本仓库生成的**一方数据**
 *   （`agents/preset-agents.ts` 物化），不含用户可控文本，默认开启不引入不可信输入。
 * - 真正的风险面是**用户自建**智能体（description 由用户写），由独立开关
 *   `allowUserAgents` 控制，仍默认 false —— 危险面保持关闭。
 * - `enabled: false` 仍是完整的一键回滚（`buildRolesFromAgents` 直接返回空数组，
 *   `/team` 回到"只有 5 个内置角色"的旧行为）。
 *
 * 若后续匹配质量不达标（方案 R2），把 `enabled` 改回默认 false 即可，无需改代码。
 */
export function resolveRuntimeRoleOptions(settings: unknown): Required<Omit<BuildRolesOptions, "excludeRoleIds">> {
  const team = isRecord(settings) ? settings["team"] : undefined;
  const runtimeRoles = isRecord(team) ? team["runtimeRoles"] : undefined;
  return {
    enabled: !(isRecord(runtimeRoles) && runtimeRoles["enabled"] === false),
    allowUserAgents: isRecord(runtimeRoles) && runtimeRoles["allowUserAgents"] === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 合并内置角色与运行时角色（调用方一行拿到完整候选集）
 *
 * 顺序约定：内置角色在前（`/team list` 与调试输出更直观），但**排序不依赖数组顺序**。
 *
 * 「关键词同时命中核心角色与预置专家时核心角色排前」（验收 B3）由两层保证：
 * 1. `role-matcher` 的 `RUNTIME_ROLE_SOURCE_FACTOR`：候选集注入路径上对运行时角色
 *    的置信度做显式折算（预置 ×0.8、自建 ×0.7）。**这一层才是主要机制**——预置专家
 *    的关键词表只有 3~5 项，命中率分母比内置角色的 9~10 项小，不折算的话专家几乎必胜。
 * 2. `priority`：内置 6~10 > 预置 5 > 自建 3，负责同分裁决。
 *
 * 两层都只读取 `metadata.source` / `priority`，不改匹配算法本身（方案 §4.5）。
 */
export function mergeRoleCandidates(
  builtins: ReadonlyArray<RoleDefinition>,
  runtimeRoles: ReadonlyArray<RoleDefinition>
): RoleDefinition[] {
  return [...builtins, ...runtimeRoles];
}
