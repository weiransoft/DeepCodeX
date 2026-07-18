/**
 * RLIS 种子规则（Seed Rules）
 *
 * EAG 方案 §5.5 规则学习与注入系统：10 条内置种子规则默认生效，
 * 用户对话中的纠正模式被识别为规则候选，确认后自动进入注入与评估清单。
 *
 * 种子规则来源：
 * - 用户个人偏好（user_profile.md）
 * - 项目硬约束（project_memory.md）
 * - Karpathy 四大核心原则（CONSTITUTION.md）
 * - Ponytail 16 条不可简化红线（multi-agent-team skill）
 *
 * 三层规则存储优先级（高 → 低）：
 * 1. 项目规则（.deepcode/rules/project.json）—— 项目级约束
 * 2. 全局用户规则（~/.deepcode/rules/user.json）—— 个人偏好
 * 3. 内置种子规则（本文件）—— 系统默认
 *
 * @module eag/rlis/seed-rules
 */

import type { RuleDefinition, RuleSeverity } from "./types.js";

// ============================================================================
// 10 条内置种子规则
// ============================================================================

/**
 * 内置种子规则列表
 *
 * 这些规则在 RLIS 初始化时默认加载，无需用户手动配置。
 * 用户可通过 /rules remove <id> 移除（但部分 BLOCKER 级规则不可移除）。
 */
export const SEED_RULES: ReadonlyArray<RuleDefinition> = Object.freeze([
  {
    id: "SEED-01",
    name: "禁止模拟/占位/mock 开发",
    description:
      "严禁使用模拟、占位、mock、简化的方式开发代码，严格真实实现所需逻辑和需求。" +
      "所有函数必须有真实的业务逻辑实现，不得返回假数据或占位符。",
    severity: "blocker",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: "禁止.*(mock|模拟|占位|placeholder|简化).*开发",
    tags: ["code-quality", "real-implementation"],
    removable: false, // 不可移除（BLOCKER 级种子规则）
  },
  {
    id: "SEED-02",
    name: "代码注释中文且详细",
    description:
      "代码函数和关键逻辑都需要注释，注释要中文，要详细，要符合 Rust 或 Java 代码规范。" +
      "每个导出函数必须有 JSDoc 注释，包含功能说明、参数说明、返回值说明。",
    severity: "major",
    source: "seed",
    injectionTargets: ["system_prompt"],
    pattern: null,
    tags: ["documentation", "chinese-comments"],
    removable: true,
  },
  {
    id: "SEED-03",
    name: "严禁未批准的简化实现",
    description:
      "严禁未得到批准的简化实现、逃避式删除等方式解决问题，严格根据需求实现。" +
      "遇到实现困难时必须提出而非逃避，不得通过删除功能来绕过问题。",
    severity: "blocker",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["code-quality", "no-shortcut"],
    removable: false,
  },
  {
    id: "SEED-04",
    name: "TODO/FIXME 必须有对应实现",
    description:
      "代码中所有的 TODO 注释都必须有对应的实现，不能只是注释。" +
      "所有的 FIXME 注释都必须有对应的修改实现，不能只是注释。" +
      "评估器在 CODING Loop 中扫描 TODO/FIXME 标记，无对应实现即 BLOCKER。",
    severity: "blocker",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: "(TODO|FIXME)\\s*:",
    tags: ["code-quality", "no-dangling-todo"],
    removable: false,
  },
  {
    id: "SEED-05",
    name: "较大代码改动需架构师审查",
    description:
      "较大代码改动需要调用架构师 skill 进行方案审查和修复改进，确保不引入新的问题。" +
      "变更涉及 3 个以上文件或新增 200 行以上代码时自动触发架构师审查。",
    severity: "major",
    source: "seed",
    injectionTargets: ["system_prompt"],
    pattern: null,
    tags: ["architecture", "review"],
    removable: true,
  },
  {
    id: "SEED-06",
    name: "禁止更改架构设计文档技术栈",
    description:
      "没有用户明确允许严禁更改架构设计文档中的技术栈。" +
      "技术栈选型一旦在已批准的 ARCHITECTURE.md 中确定，CODING Loop 不得擅自替换。",
    severity: "blocker",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["architecture", "tech-stack-lock"],
    removable: false,
  },
  {
    id: "SEED-07",
    name: "测试文件放置规范",
    description:
      "测试全部放到 tests 目录下，测试 shell 脚本放到 tests/scripts 目录下。" +
      "单元测试文件命名 *.test.ts，集成测试文件命名 *.integration.test.ts。",
    severity: "major",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["testing", "file-structure"],
    removable: true,
  },
  {
    id: "SEED-08",
    name: "任务完成前单元测试",
    description:
      "每一次任务完成前必须进行所涉及的代码改动的单元测试，确保代码质量。" +
      "CODING Loop 每个任务卡完成后必须运行相关测试，全绿才可进入下一任务卡。",
    severity: "blocker",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["testing", "quality-gate"],
    removable: false,
  },
  {
    id: "SEED-09",
    name: "Surgical Changes 精准修改",
    description:
      "只改直接相关的行，不要'改善'周围的代码。保持风格一致，遵循项目的风格指南。" +
      "模仿现有模式，与项目现有代码保持一致。不要溢出修改——改 A 功能时不碰 B 功能。",
    severity: "major",
    source: "seed",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["karpathy", "surgical-changes"],
    removable: true,
  },
  {
    id: "SEED-10",
    name: "新增功能文档驱动",
    description:
      "新增功能必须先梳理好需求文档，理解当前全部代码，根据需求设计好测试用例，" +
      "完成代码后实现完整的单元测试和场景集成测试，确保流程正确。",
    severity: "major",
    source: "seed",
    injectionTargets: ["system_prompt"],
    pattern: null,
    tags: ["process", "documentation-driven"],
    removable: true,
  },
]);

// ============================================================================
// 查询辅助函数
// ============================================================================

/**
 * 获取种子规则数量
 */
export function getSeedRuleCount(): number {
  return SEED_RULES.length;
}

/**
 * 按严重级别过滤种子规则
 *
 * @param severity 红线级别
 * @returns 符合级别的种子规则列表
 */
export function getSeedRulesBySeverity(severity: RuleSeverity): ReadonlyArray<RuleDefinition> {
  return SEED_RULES.filter((r) => r.severity === severity);
}

/**
 * 按注入目标过滤种子规则
 *
 * @param target 注入目标（system_prompt / evaluator）
 * @returns 需要注入到该目标的种子规则列表
 */
export function getSeedRulesForInjection(target: "system_prompt" | "evaluator"): ReadonlyArray<RuleDefinition> {
  return SEED_RULES.filter((r) => r.injectionTargets.includes(target));
}
