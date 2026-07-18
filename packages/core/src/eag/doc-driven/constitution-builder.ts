/**
 * CONSTITUTION.md 构建器（EAG-P1 批次 5）
 *
 * 本模块实现 `buildConstitution` 函数，提供 EAG 方案 §5.10.1 项目宪法（CONSTITUTION.md）
 * 的真实生成逻辑。
 *
 * 核心职责：
 * - 接收项目愿景 + 技术/业务/质量原则 + 不可协商项
 * - 输出符合 Markdown 格式的 CONSTITUTION.md 字符串
 * - 包含 5 个章节：1.项目愿景 2.技术原则 3.业务原则 4.质量原则 5.不可协商项
 *
 * §5.10.1 CONSTITUTION.md 设计要求：
 * - 产出 Loop：DESIGN Loop 首轮
 * - 内容：项目愿景 + 技术/业务/质量原则 + 不可协商项
 *   （技术栈锁定清单、合规要求、红线声明）
 * - 不可协商项一旦写入宪法即锁定，未经用户显式批准不得变更
 *   （对齐 SEED-06 技术栈锁定 + SEED-10 删除纪律）
 *
 * 设计依据：
 * - EAG 方案 §5.10.1 三文档契约（CONSTITUTION.md 是 DESIGN Loop 首轮产出）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结（不可协商项锁定）
 *
 * 不可变优先：
 * - 函数为纯函数，无副作用
 * - 输入与输出均为不可变数据
 *
 * @module eag/doc-driven/constitution-builder
 */

import type { ConstitutionInput, NonNegotiableItems } from "./types";

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 宪法构建错误（输入非法时抛出）
 *
 * 包含错误字段与详细信息，便于调用方定位问题。
 */
export class ConstitutionBuilderError extends Error {
  /**
   * @param field 非法字段名
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly reason: string
  ) {
    super(`宪法构建错误：字段 ${field} 非法——${reason}`);
    this.name = "ConstitutionBuilderError";
  }
}

// ============================================================================
// 构建器实现
// ============================================================================

/**
 * 构建 CONSTITUTION.md 字符串
 *
 * 接收 ConstitutionInput（项目愿景 + 三类原则 + 不可协商项），
 * 输出符合 Markdown 格式的 CONSTITUTION.md 完整字符串。
 *
 * 输出文档结构（5 章节）：
 * 1. 项目愿景（vision 字段）
 * 2. 技术原则（techPrinciples 列表）
 * 3. 业务原则（businessPrinciples 列表）
 * 4. 质量原则（qualityPrinciples 列表）
 * 5. 不可协商项（nonNegotiableItems，含三子节：技术栈锁定/合规要求/红线声明）
 *
 * 文档头部附加 EAG 元信息（生成时间、版本号、文档路径），便于版本审计。
 *
 * @param input 宪法构建器输入
 * @returns CONSTITUTION.md 字符串（Markdown 格式）
 * @throws {ConstitutionBuilderError} 任一字段非法时抛出
 */
export function buildConstitution(input: ConstitutionInput): string {
  // 校验入参
  validateInput(input);

  // 构建 Markdown 文档
  const parts: string[] = [];

  // 文档头部（标题 + 元信息）
  parts.push(buildHeader());

  // 章节 1：项目愿景
  parts.push(buildVisionSection(input.vision));

  // 章节 2：技术原则
  parts.push(buildPrinciplesSection("技术原则", "Tech Principles", input.techPrinciples));

  // 章节 3：业务原则
  parts.push(buildPrinciplesSection("业务原则", "Business Principles", input.businessPrinciples));

  // 章节 4：质量原则
  parts.push(buildPrinciplesSection("质量原则", "Quality Principles", input.qualityPrinciples));

  // 章节 5：不可协商项
  parts.push(buildNonNegotiableSection(input.nonNegotiableItems));

  // 文档尾部（合规声明）
  parts.push(buildFooter());

  return parts.join("\n");
}

// ============================================================================
// 私有辅助函数
// ============================================================================

/**
 * 校验 ConstitutionInput 入参
 *
 * 校验规则：
 * - vision：非空字符串
 * - techPrinciples：数组（可为空，但建议至少 1 条）
 * - businessPrinciples：数组（可为空，但建议至少 1 条）
 * - qualityPrinciples：数组（可为空，但建议至少 1 条）
 * - nonNegotiableItems：对象，含 techStackLocks / complianceRequirements / redlines 三字段
 *
 * @param input 宪法构建器输入
 * @throws {ConstitutionBuilderError} 任一字段非法时抛出
 */
function validateInput(input: ConstitutionInput): void {
  // 校验 vision
  if (typeof input.vision !== "string" || input.vision.trim().length === 0) {
    throw new ConstitutionBuilderError("vision", "项目愿景必须为非空字符串");
  }

  // 校验 techPrinciples：必须为数组，每条必须为非空字符串
  if (!Array.isArray(input.techPrinciples)) {
    throw new ConstitutionBuilderError("techPrinciples", "技术原则必须为数组");
  }
  for (const p of input.techPrinciples) {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new ConstitutionBuilderError("techPrinciples", "技术原则每条必须为非空字符串");
    }
  }

  // 校验 businessPrinciples
  if (!Array.isArray(input.businessPrinciples)) {
    throw new ConstitutionBuilderError("businessPrinciples", "业务原则必须为数组");
  }
  for (const p of input.businessPrinciples) {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new ConstitutionBuilderError("businessPrinciples", "业务原则每条必须为非空字符串");
    }
  }

  // 校验 qualityPrinciples
  if (!Array.isArray(input.qualityPrinciples)) {
    throw new ConstitutionBuilderError("qualityPrinciples", "质量原则必须为数组");
  }
  for (const p of input.qualityPrinciples) {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new ConstitutionBuilderError("qualityPrinciples", "质量原则每条必须为非空字符串");
    }
  }

  // 校验 nonNegotiableItems
  if (!input.nonNegotiableItems || typeof input.nonNegotiableItems !== "object") {
    throw new ConstitutionBuilderError("nonNegotiableItems", "不可协商项必须为对象");
  }
  const nni = input.nonNegotiableItems;
  if (!Array.isArray(nni.techStackLocks)) {
    throw new ConstitutionBuilderError("nonNegotiableItems.techStackLocks", "技术栈锁定清单必须为数组");
  }
  if (!Array.isArray(nni.complianceRequirements)) {
    throw new ConstitutionBuilderError("nonNegotiableItems.complianceRequirements", "合规要求清单必须为数组");
  }
  if (!Array.isArray(nni.redlines)) {
    throw new ConstitutionBuilderError("nonNegotiableItems.redlines", "红线声明清单必须为数组");
  }
}

/**
 * 构建文档头部（标题 + EAG 元信息）
 *
 * @returns Markdown 头部字符串
 */
function buildHeader(): string {
  const generatedAt = new Date().toISOString();
  return [
    "# 项目宪法（CONSTITUTION.md）",
    "",
    `> 文档类型：CONSTITUTION.md`,
    `> 产出 Loop：DESIGN Loop 首轮`,
    `> 生成时间：${generatedAt}`,
    `> 文档路径：docs/eag/CONSTITUTION.md`,
    `> 锁定规则：不可协商项未经用户显式批准不得变更（对齐 SEED-06 / SEED-10）`,
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * 构建项目愿景章节
 *
 * @param vision 项目愿景
 * @returns Markdown 章节字符串
 */
function buildVisionSection(vision: string): string {
  return [`## 1. 项目愿景`, "", vision, "", ""].join("\n");
}

/**
 * 构建原则章节（技术/业务/质量三类共用此函数）
 *
 * @param chineseName 中文章节名（如 "技术原则"）
 * @param englishName 英文章节名（如 "Tech Principles"）
 * @param principles 原则列表
 * @returns Markdown 章节字符串
 */
function buildPrinciplesSection(chineseName: string, englishName: string, principles: ReadonlyArray<string>): string {
  const parts: string[] = [];
  // 章节标题（编号由调用顺序决定：技术=2，业务=3，质量=4）
  // 由于编号在函数外决定，此处接受 chineseName 已含编号
  // 为简化实现，此处使用 chineseName 作为完整章节标题
  const sectionNumber = chineseName === "技术原则" ? "2" : chineseName === "业务原则" ? "3" : "4";
  parts.push(`## ${sectionNumber}. ${chineseName}（${englishName}）`);
  parts.push("");

  if (principles.length === 0) {
    parts.push("> （本章节暂无原则声明）");
  } else {
    for (let i = 0; i < principles.length; i++) {
      parts.push(`${i + 1}. ${principles[i]}`);
    }
  }
  parts.push("");
  parts.push("");
  return parts.join("\n");
}

/**
 * 构建不可协商项章节（章节 5，含三子节）
 *
 * 子节 5.1：技术栈锁定清单（techStackLocks，对齐 SEED-06）
 * 子节 5.2：合规要求（complianceRequirements）
 * 子节 5.3：红线声明（redlines）
 *
 * @param items 不可协商项
 * @returns Markdown 章节字符串
 */
function buildNonNegotiableSection(items: NonNegotiableItems): string {
  const parts: string[] = [];
  parts.push("## 5. 不可协商项（Non-Negotiable Items）");
  parts.push("");
  parts.push("> 不可协商项一旦写入宪法即锁定，未经用户显式批准不得变更。");
  parts.push("> 对齐 SEED-06（技术栈锁定规则）与 SEED-10（删除纪律）。");
  parts.push("");

  // 子节 5.1：技术栈锁定清单
  parts.push("### 5.1 技术栈锁定清单（Tech Stack Locks）");
  parts.push("");
  parts.push("> 以下技术栈一经锁定，未经用户显式批准不得变更（对齐 SEED-06 规则）。");
  parts.push("");
  if (items.techStackLocks.length === 0) {
    parts.push("> （暂无技术栈锁定声明）");
  } else {
    for (const tech of items.techStackLocks) {
      parts.push(`- ${tech}`);
    }
  }
  parts.push("");

  // 子节 5.2：合规要求
  parts.push("### 5.2 合规要求（Compliance Requirements）");
  parts.push("");
  parts.push("> 项目必须满足以下合规标准，违反即阻断交付。");
  parts.push("");
  if (items.complianceRequirements.length === 0) {
    parts.push("> （暂无合规要求声明）");
  } else {
    for (const compliance of items.complianceRequirements) {
      parts.push(`- ${compliance}`);
    }
  }
  parts.push("");

  // 子节 5.3：红线声明
  parts.push("### 5.3 红线声明（Redlines）");
  parts.push("");
  parts.push("> 以下红线声明为强制规则，任何角色不得违反，违反即触发 Loop 阻断。");
  parts.push("");
  if (items.redlines.length === 0) {
    parts.push("> （暂无红线声明）");
  } else {
    for (const redline of items.redlines) {
      parts.push(`- ${redline}`);
    }
  }
  parts.push("");
  parts.push("");
  return parts.join("\n");
}

/**
 * 构建文档尾部（合规声明）
 *
 * @returns Markdown 尾部字符串
 */
function buildFooter(): string {
  return [
    "---",
    "",
    "## 合规声明",
    "",
    "- 本文档由 EAG DESIGN Loop 首轮自动生成，作为 spec.md 的前置条件。",
    "- 不可协商项的变更必须经过用户显式批准（HUMAN_CHECKPOINT）。",
    "- 文档版本号随状态机转换递增（draft → reviewing → approved）。",
    "- 文档状态机由 DocumentStateMachine 管理，spec 未批准时 CODING Loop 不得启动（SEED-10）。",
    "",
  ].join("\n");
}
