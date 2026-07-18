/**
 * RLIS 内置种子规则（Seed Rules）—— EAG 方案 §5.5.5
 *
 * 本模块定义 EAG 方案 §5.5.5 表格中的 10 条内置种子规则（SEED-01 ~ SEED-10）。
 * 种子规则是 CLI 打包发布的「默认用户偏好」，作为三层规则存储的最低优先级层
 * （可被全局用户层 / 项目层同 ID 规则覆盖）。
 *
 * 种子规则来源：
 * - 用户个人偏好（user_profile.md）
 * - 项目硬约束（project_memory.md）
 * - Karpathy 四大核心原则（CONSTITUTION.md）
 * - Ponytail 16 条不可简化红线（multi-agent-team skill）
 *
 * 三层规则存储优先级（高 → 低）：
 * 1. 项目层（.deepcode/rules/project-rules.json）—— 项目级约束（最高，覆盖同名规则）
 * 2. 全局用户层（~/.deepcodeX/rules/global-rules.json）—— 个人偏好
 * 3. 内置种子层（本文件）—— 系统默认（最低，可被覆盖）
 *
 * 字段固定约定（§5.5.5 表格）：
 * - id：SEED-01 ~ SEED-10
 * - source：固定为 "builtin-seed"
 * - confirmedBy：固定为 "auto"（内置种子规则无需用户确认）
 * - usageCount：初始化为 0
 * - violationCount：初始化为 0
 * - createdAt：固定时间戳 "2026-07-18T00:00:00.000Z"（保证测试可重现）
 *
 * 不可变保证：
 * - 顶层常量 SEED_RULES 使用 Object.freeze 冻结
 * - 每条规则的字段使用 readonly 修饰
 *
 * @module eag/rlis/seed-rules
 */

import type { UserRule, RuleCategory, RuleSeverity } from "./types.js";

// ============================================================================
// 内置种子规则固定字段常量
// ============================================================================

/**
 * 内置种子规则的固定创建时间戳
 *
 * 用于保证测试可重现（避免使用 new Date().toISOString() 导致每次运行结果不同）。
 * 取值为 EAG-P1 批次 6 实施日期 2026-07-18 的零点 UTC 时间。
 */
const SEED_RULE_CREATED_AT = "2026-07-18T00:00:00.000Z";

// ============================================================================
// 10 条内置种子规则（§5.5.5 表格）
// ============================================================================

/**
 * 内置种子规则列表（10 条，SEED-01 ~ SEED-10）
 *
 * 严格对齐 EAG 方案 §5.5.5 表格定义：
 *
 * | ID      | 分类                | 级别    | 规则内容 |
 * |---------|---------------------|---------|---------|
 * | SEED-01 | code-truth          | BLOCKER | 禁止使用模拟、占位、mock、简化的方式开发代码，严格真实实现所需逻辑和需求 |
 * | SEED-02 | comment-style       | MAJOR   | 代码函数和关键逻辑都需要注释，注释要中文、要详细、要符合 python、Rust 或 Java 代码规范 |
 * | SEED-03 | code-truth          | BLOCKER | 严禁未得到批准的简化实现、逃避式删除等方式解决问题，严格根据需求实现 |
 * | SEED-04 | code-truth          | MAJOR   | 代码中所有 TODO 注释都必须有对应实现，不能只是注释 |
 * | SEED-05 | process-gate        | MAJOR   | 较大代码改动需要调用架构师 skill 进行方案审查和修复改进，确保不引入新的问题 |
 * | SEED-06 | change-control      | BLOCKER | 没有用户允许严禁更改架构设计文档中的技术栈 |
 * | SEED-07 | code-truth          | MAJOR   | FIXME 注释都必须有对应的修改实现，不能只是注释 |
 * | SEED-08 | project-structure   | MAJOR   | 测试全部放到 tests 目录下，测试 shell 脚本放到 tests/scripts 目录下 |
 * | SEED-09 | process-gate        | MAJOR   | 每一次任务完成前进行所涉及的代码改动的单元测试，确保代码质量 |
 * | SEED-10 | process-gate        | BLOCKER | 新增功能都必须先梳理好需求文档，理解当前全部代码，根据需求设计好测试用例 |
 *
 * 字段固定约定：
 * - source: "builtin-seed"
 * - confirmedBy: "auto"
 * - usageCount: 0
 * - violationCount: 0
 * - createdAt: SEED_RULE_CREATED_AT
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 * 修改本常量需走架构变更评审流程。
 */
export const SEED_RULES: ReadonlyArray<UserRule> = Object.freeze([
  {
    id: "SEED-01",
    category: "code-truth",
    severity: "BLOCKER",
    content: "禁止使用模拟、占位、mock、简化的方式开发代码，严格真实实现所需逻辑和需求",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-02",
    category: "comment-style",
    severity: "MAJOR",
    content: "代码函数和关键逻辑都需要注释，注释要中文、要详细、要符合 python、Rust 或 Java 代码规范",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-03",
    category: "code-truth",
    severity: "BLOCKER",
    content: "严禁未得到批准的简化实现、逃避式删除等方式解决问题，严格根据需求实现",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-04",
    category: "code-truth",
    severity: "MAJOR",
    content: "代码中所有 TODO 注释都必须有对应实现，不能只是注释",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-05",
    category: "process-gate",
    severity: "MAJOR",
    content: "较大代码改动需要调用架构师 skill 进行方案审查和修复改进，确保不引入新的问题",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-06",
    category: "change-control",
    severity: "BLOCKER",
    content: "没有用户允许严禁更改架构设计文档中的技术栈",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-07",
    category: "code-truth",
    severity: "MAJOR",
    content: "FIXME 注释都必须有对应的修改实现，不能只是注释",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-08",
    category: "project-structure",
    severity: "MAJOR",
    content: "测试全部放到 tests 目录下，测试 shell 脚本放到 tests/scripts 目录下",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-09",
    category: "process-gate",
    severity: "MAJOR",
    content: "每一次任务完成前进行所涉及的代码改动的单元测试，确保代码质量",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
  {
    id: "SEED-10",
    category: "process-gate",
    severity: "BLOCKER",
    content: "新增功能都必须先梳理好需求文档，理解当前全部代码，根据需求设计好测试用例",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: SEED_RULE_CREATED_AT,
  },
]);

// ============================================================================
// 查询辅助函数
// ============================================================================

/**
 * 获取内置种子规则数量
 *
 * @returns 种子规则数量（10）
 */
export function getSeedRuleCount(): number {
  return SEED_RULES.length;
}

/**
 * 按严重级别过滤内置种子规则
 *
 * @param severity 严重级别（BLOCKER/MAJOR/WARNING）
 * @returns 符合级别的种子规则列表
 */
export function getSeedRulesBySeverity(severity: RuleSeverity): ReadonlyArray<UserRule> {
  return SEED_RULES.filter((r) => r.severity === severity);
}

/**
 * 按分类过滤内置种子规则
 *
 * @param category 规则分类（code-truth/comment-style/process-gate/change-control/project-structure/quality-gate）
 * @returns 符合分类的种子规则列表
 */
export function getSeedRulesByCategory(category: RuleCategory): ReadonlyArray<UserRule> {
  return SEED_RULES.filter((r) => r.category === category);
}

/**
 * 按 ID 查询内置种子规则
 *
 * @param id 规则 ID（如 "SEED-01"）
 * @returns 规则对象；不存在时返回 null
 */
export function getSeedRuleById(id: string): UserRule | null {
  return SEED_RULES.find((r) => r.id === id) ?? null;
}
