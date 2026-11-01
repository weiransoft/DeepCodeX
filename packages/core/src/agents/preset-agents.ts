/**
 * 预置智能体种子（2026-11-02）
 *
 * 问题背景（为什么需要这个模块）：
 * core 里原本躺着两套完整的角色资产——`team/role-registry.ts` 的 5 个核心角色
 * 与 `team/domain-experts/*` 的 30 个领域专家——但它们**只存在于内存**，从未
 * 落成文件。而 Agent 的唯一真相来源是文件扫描（`~/.deepcode/skills/<name>/SKILL.md`
 * 的 `type: agent` 条目）：能力发现、@ 提及、`agent` 工具、设置页智能体列表
 * 全部走 SkillManager 扫描链。结果就是「代码里有 35 个智能体，界面里一个也看不到」。
 *
 * 本模块把这两套资产物化为预置文件，物化之后**无需任何额外注册**即自动可见：
 *   SkillManager 扫描 → AgentRegistry 索引 → capabilities / @ 提及 / agent 工具。
 *
 * 三条安全边界：
 * 1. **绝不覆盖用户内容**：默认 `onlyMissing`，目标文件已存在即跳过（用户改过的
 *    预置智能体不会被升级动作抹掉）；显式恢复需要调用方传 `overwrite: true`。
 * 2. **只写用户级目录**：调用方传入根目录（生产为 `~/.deepcode/skills`），本模块
 *    不做路径推导，避免在项目目录里意外生成文件。
 * 3. **失败隔离**：单个条目写失败只记录，不中断其余条目（返回 written/skipped/failed
 *    供调用方如实汇报，不假装成功）。
 *
 * @module agents/preset-agents
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ROLE_REGISTRY } from "../team/role-registry";
import { ALL_DOMAIN_CATEGORIES } from "../team/domain-experts/index";
import { academicExperts } from "../team/domain-experts/academic-experts";
import { marketingExperts } from "../team/domain-experts/marketing-experts";
import { productExperts } from "../team/domain-experts/product-experts";
import { projectManagementExperts } from "../team/domain-experts/project-management-experts";
import { salesExperts } from "../team/domain-experts/sales-experts";
import { specializedExperts } from "../team/domain-experts/specialized-experts";
import { strategyExperts } from "../team/domain-experts/strategy-experts";
import { supportExperts } from "../team/domain-experts/support-experts";
import type { DomainCategory, DomainExpert } from "../team/types";

/** 一个预置智能体定义（落盘前的内存形态） */
export interface PresetAgent {
  /** kebab-case 名称（也是落盘目录名与 @ 提及 token） */
  name: string;
  /** 一句话描述（进入 agent 索引与 @ 候选） */
  description: string;
  /** 角色身份（激活时注入的角色约束声明） */
  role: string;
  /** 行为约束正文（Markdown） */
  body: string;
  /** 分组：core = 5 个核心角色；其余为领域专家的业务类别 */
  group: string;
}

/** 同步结果（如实汇报三类计数，调用方据此提示，不假装全成功） */
export interface PresetSyncResult {
  /** 本次新写入的名称 */
  written: string[];
  /** 已存在且未覆盖的名称 */
  skipped: string[];
  /** 写入失败：[名称, 原因] */
  failed: Array<[string, string]>;
}

/** 领域专家类别 → 中文分组名（用于 frontmatter `group` 与界面分组展示） */
const CATEGORY_LABELS: Record<DomainCategory, string> = {
  product: "业务需求",
  "project-management": "业务流程",
  strategy: "业务战略",
  support: "业务支持",
  specialized: "专业领域",
  academic: "学术研究",
  marketing: "营销增长",
  sales: "销售",
};

/** 全部领域专家（静态聚合：种子生成是一次性低频动作，不值得为它做懒加载） */
const ALL_EXPERTS: DomainExpert[] = [
  ...productExperts,
  ...projectManagementExperts,
  ...strategyExperts,
  ...supportExperts,
  ...specializedExperts,
  ...academicExperts,
  ...marketingExperts,
  ...salesExperts,
];

/**
 * 构造全部预置智能体定义（纯函数，无 IO）。
 *
 * - 5 个核心角色：名称取 `roleId`（architect / product-manager / …），
 *   正文取 `systemPromptPrefix + systemPromptSuffix`（已含 Karpathy 4 原则与
 *   Ponytail 16 红线，与 team 模块运行时注入的内容逐字一致）；
 * - 30 个领域专家：名称取 `expertId`（自带 `domain-` 前缀，与核心角色的
 *   `product-manager` 不冲突），正文同样取专家自己的完整 prompt。
 *
 * @returns 35 个预置定义（5 核心角色 + 30 领域专家）
 */
export function listPresetAgents(): PresetAgent[] {
  const core: PresetAgent[] = ROLE_REGISTRY.map((role) => ({
    name: role.roleId,
    description: role.description,
    role: `${role.name}（${role.nameEn}）`,
    body: `${role.systemPromptPrefix}${role.systemPromptSuffix ?? ""}`.trim(),
    group: "core",
  }));

  const experts: PresetAgent[] = ALL_EXPERTS.map((expert) => ({
    // expertId 已带 domain- 前缀且为 kebab-case，直接用作名称
    name: expert.expertId,
    description: expert.description,
    role: `${expert.name}（${expert.specialty}）`,
    body: `${expert.systemPromptPrefix}${expert.systemPromptSuffix ?? ""}`.trim(),
    group: CATEGORY_LABELS[expert.category],
  }));

  return [...core, ...experts];
}

/**
 * 生成 SKILL.md 全文（frontmatter + 正文）。
 *
 * frontmatter 字段与 SkillManager / AgentRegistry 的白名单逐字对齐：
 * `name` / `description` / `type: agent` / `role`，并附加两个**只读标记**：
 * `preset: true`（界面据此显示「预置」徽标）与 `group`（分组展示）。
 *
 * @param agent 预置定义
 * @returns 可直接落盘的 Markdown 文本
 */
export function renderPresetSkillMd(agent: PresetAgent): string {
  // frontmatter 用 JSON 引号形式写入，规避中文标点/冒号在 YAML 中的歧义
  const quote = (value: string): string => JSON.stringify(value);
  return [
    "---",
    `name: ${quote(agent.name)}`,
    `description: ${quote(agent.description)}`,
    `type: agent`,
    `role: ${quote(agent.role)}`,
    `preset: true`,
    `group: ${quote(agent.group)}`,
    "---",
    "",
    agent.body,
    "",
  ].join("\n");
}

/**
 * 把预置智能体同步到指定 skills 根目录（幂等）。
 *
 * 写入布局：`<root>/<name>/SKILL.md`——与用户自建智能体（POST /api/agents 经
 * SedimentationWriter 落盘）完全同构，因此走同一条扫描链，无需任何额外注册。
 *
 * @param root         skills 根目录（生产为 `~/.deepcode/skills`）
 * @param options.overwrite 是否覆盖已存在的同名文件（默认 false = 保留用户修改）
 * @param options.agents    注入替换用的定义集（测试用；缺省取 listPresetAgents()）
 * @returns 写入 / 跳过 / 失败三类结果
 */
export function syncPresetAgents(
  root: string,
  options: { overwrite?: boolean; agents?: PresetAgent[] } = {}
): PresetSyncResult {
  const overwrite = options.overwrite === true;
  const agents = options.agents ?? listPresetAgents();
  const result: PresetSyncResult = { written: [], skipped: [], failed: [] };

  for (const agent of agents) {
    const dir = path.join(root, agent.name);
    const file = path.join(dir, "SKILL.md");
    try {
      if (!overwrite && fs.existsSync(file)) {
        result.skipped.push(agent.name);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, renderPresetSkillMd(agent), "utf8");
      result.written.push(agent.name);
    } catch (error) {
      // 单条失败不中断其余条目：如实记入 failed，由调用方展示
      result.failed.push([agent.name, error instanceof Error ? error.message : String(error)]);
    }
  }
  return result;
}

/** 预置智能体总数（5 核心角色 + 30 领域专家），供界面展示与断言 */
export const PRESET_AGENT_COUNT = ROLE_REGISTRY.length + ALL_EXPERTS.length;

/** 领域专家类别数（与 team 模块 ALL_DOMAIN_CATEGORIES 一致） */
export const PRESET_AGENT_CATEGORY_COUNT = ALL_DOMAIN_CATEGORIES.length;
