/**
 * SEED-06 技术栈锁定/解锁/校验逻辑（Tech Stack Lock）
 *
 * 本模块实现 EAG 方案 §5.6 的 SEED-06 规则：
 * - 技术选型决策表经用户确认后锁定，写入 .deepcode/eag.yml 的 tech_stack 段
 * - 锁定后任何变更必须用户显式批准（SEED-06 规则）
 * - 评估器在 CODING Loop 监测 package.json/pom.xml 等依赖文件变更，
 *   发现与锁定栈不符的依赖即打回
 *
 * 设计依据：
 * - EAG 方案 §5.6 选型决策流程（HUMAN_CHECKPOINT 用户确认 → 写入并锁定）
 * - EAG 方案 SEED-06 规则（技术栈锁定后变更必须用户显式批准）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则
 *
 * 三大核心函数：
 * 1. **lockTechStack**：锁定决策表，生成 TechStackLock（locked=true + 时间戳 + 操作人）
 * 2. **validateDependencyChange**：校验依赖变更是否符合锁定栈
 *    - 输入：锁定的 TechStackLock + 新依赖列表 + 可选的用户批准变更列表
 *    - 输出：{ valid: boolean; violations: string[] }
 *    - 算法：从锁定决策表提取技术关键词，新依赖与关键词匹配则合法，
 *      否则需在 approvedChanges 中显式批准
 * 3. **unlockTechStack**：解锁（仅限用户显式批准），生成新的 TechStackLock（locked=false）
 *
 * 关键词提取算法（validateDependencyChange 核心）：
 * - 从锁定决策表的 selectedOption.name 中提取技术关键词
 * - 处理格式："React 18 + TypeScript + Ant Design" → ["react", "typescript", "ant design", "18"]
 * - 处理括号备注："NestJS（DDD 亲和）" → ["nestjs"]
 * - 处理版本号："Spring Boot 3" → ["spring boot", "3"]
 * - 新依赖与关键词进行大小写不敏感匹配（子串包含或精确匹配）
 *
 * 不可变保证：
 * - 所有返回的 TechStackLock 对象使用 Object.freeze 冻结
 * - 防止运行期被篡改，对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/etsb/tech-stack-lock
 */

import type { TechStackDecisionTable, TechStackLock, TechStackOption } from "./types";

// ============================================================================
// SEED-06 错误类型
// ============================================================================

/**
 * SEED-06 锁定错误
 *
 * 当 lockTechStack / unlockTechStack / validateDependencyChange 的输入非法时抛出。
 */
export class TechStackLockError extends Error {
  /**
   * @param field 非法字段名
   * @param value 非法字段值
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`TechStackLock 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "TechStackLockError";
  }
}

// ============================================================================
// 锁定/解锁核心函数
// ============================================================================

/**
 * 锁定技术选型决策表（写入 .deepcode/eag.yml tech_stack 段）
 *
 * 执行流程：
 * 1. 校验 decisionTable 非空且包含 10 层决策
 * 2. 校验 lockedBy 非空字符串
 * 3. 生成 TechStackLock（locked=true + 当前 ISO 时间戳 + 操作人）
 * 4. Object.freeze 冻结返回
 *
 * 对齐 §5.6："HUMAN_CHECKPOINT 用户确认 → 写入 .deepcode/eag.yml 的 tech_stack 段并锁定"。
 *
 * @param decisionTable 待锁定的决策表（须包含 10 层决策）
 * @param lockedBy 锁定操作人（用户名或角色名，用于审计日志）
 * @returns 锁定状态对象（locked=true）
 * @throws {TechStackLockError} decisionTable 为空或决策数不足 10 层 / lockedBy 为空
 */
export function lockTechStack(decisionTable: TechStackDecisionTable, lockedBy: string): TechStackLock {
  // 校验 decisionTable
  if (!decisionTable || !decisionTable.decisions || decisionTable.decisions.length !== 10) {
    throw new TechStackLockError(
      "decisionTable.decisions",
      decisionTable?.decisions?.length,
      "决策表必须包含 10 层决策（4 语言 × 10 层矩阵的 10 层）"
    );
  }

  // 校验 lockedBy
  if (!lockedBy || typeof lockedBy !== "string" || lockedBy.trim().length === 0) {
    throw new TechStackLockError("lockedBy", lockedBy, "锁定操作人不能为空字符串（用于审计日志追溯）");
  }

  // 生成锁定状态（locked=true + 当前 ISO 时间戳）
  const lock: TechStackLock = Object.freeze({
    locked: true,
    decisionTable,
    lockedAt: new Date().toISOString(),
    lockedBy: lockedBy.trim(),
  });

  return lock;
}

/**
 * 解锁技术栈锁定（仅限用户显式批准）
 *
 * 执行流程：
 * 1. 校验 lock 已锁定（locked=true）
 * 2. 校验 approvedBy 非空字符串
 * 3. 生成新的 TechStackLock（locked=false + 保留原锁定时间戳与操作人供审计）
 *
 * 对齐 SEED-06 规则："解锁仅限用户显式批准"——approvedBy 字段记录批准人，
 * 解锁后保留原 lockedAt 与 lockedBy 用于审计追溯。
 *
 * @param lock 当前锁定状态
 * @param approvedBy 解锁批准人（用户名或角色名，用于审计日志）
 * @returns 新的锁定状态（locked=false，保留原审计信息）
 * @throws {TechStackLockError} lock 未锁定 / approvedBy 为空
 */
export function unlockTechStack(lock: TechStackLock, approvedBy: string): TechStackLock {
  // 校验 lock 已锁定
  if (!lock.locked) {
    throw new TechStackLockError(
      "lock.locked",
      lock.locked,
      "解锁操作要求当前锁定状态为 locked=true，当前已解锁无需重复操作"
    );
  }

  // 校验 approvedBy
  if (!approvedBy || typeof approvedBy !== "string" || approvedBy.trim().length === 0) {
    throw new TechStackLockError("approvedBy", approvedBy, "解锁批准人不能为空字符串（SEED-06 规则要求显式批准）");
  }

  // 生成解锁状态（locked=false + 保留原审计信息）
  const unlocked: TechStackLock = Object.freeze({
    locked: false,
    decisionTable: lock.decisionTable,
    lockedAt: lock.lockedAt, // 保留原锁定时间供审计
    lockedBy: lock.lockedBy, // 保留原锁定操作人供审计
  });

  return unlocked;
}

// ============================================================================
// 依赖变更校验（SEED-06 核心）
// ============================================================================

/**
 * 依赖变更校验结果
 *
 * - valid=true：所有新依赖符合锁定栈或在 approvedChanges 中
 * - valid=false：存在违规依赖（violations 列出每个违规依赖的详细原因）
 */
export interface DependencyValidationResult {
  /** 是否全部合法（true=全部合法，false=存在违规） */
  readonly valid: boolean;
  /** 违规依赖详细原因列表（valid=true 时为空数组） */
  readonly violations: ReadonlyArray<string>;
}

/**
 * 校验依赖变更是否符合锁定栈（package.json/pom.xml 依赖列表）
 *
 * 算法流程：
 * 1. 若 lock.locked=false（未锁定），所有变更合法（无锁定可执行）
 * 2. 从 lock.decisionTable 提取全部技术关键词（selectedOption.name 分词）
 * 3. 对每个新依赖：
 *    - 规范化依赖名（小写 + 去 @scope/ 前缀）
 *    - 检查是否匹配任何技术关键词（大小写不敏感的子串或精确匹配）
 *    - 若不匹配，检查是否在 approvedChanges 中（用户显式批准）
 *    - 若均不匹配，记录违规
 * 4. 汇总违规列表，返回 { valid, violations }
 *
 * 匹配规则说明：
 * - 关键词从 selectedOption.name 提取，处理 +、/、（）、空格等分隔符
 * - 例如 "React 18 + TypeScript + Ant Design" 提取 ["react", "18", "typescript", "ant design"]
 * - 依赖 "react" 匹配关键词 "react" → 合法
 * - 依赖 "@nestjs/core" 规范化为 "core" 后... 实际上应保留 "nestjs" 部分
 *   规范化策略：去 @scope/ 前缀后保留完整名，如 "@nestjs/core" → "nestjs/core"
 *   匹配时检查 "nestjs" 是否为关键词子串
 * - 依赖 "vue" 不匹配任何关键词（锁定栈为 React）→ 违规（除非 approvedChanges 包含 "vue"）
 *
 * @param lock 锁定状态
 * @param newDependencies 新依赖列表（如 ["react", "antd", "@nestjs/core", "vue"]）
 * @param approvedChanges 用户显式批准的变更列表（可选，如 ["vue"]）
 * @returns 校验结果（valid + violations）
 */
export function validateDependencyChange(
  lock: TechStackLock,
  newDependencies: ReadonlyArray<string>,
  approvedChanges?: ReadonlyArray<string>
): DependencyValidationResult {
  // 步骤 1：未锁定状态，所有变更合法
  if (!lock.locked) {
    return { valid: true, violations: [] };
  }

  // 步骤 2：从锁定决策表提取全部技术关键词
  const keywords = extractTechKeywords(lock.decisionTable);

  // 步骤 3：构建 approvedChanges 集合（大小写不敏感）
  const approvedSet = new Set<string>();
  if (approvedChanges) {
    for (const change of approvedChanges) {
      approvedSet.add(normalizeDependencyName(change));
    }
  }

  // 步骤 4：逐个检查新依赖
  const violations: string[] = [];
  for (const dep of newDependencies) {
    const normalizedDep = normalizeDependencyName(dep);

    // 检查是否匹配任何技术关键词
    const matched = matchesAnyKeyword(normalizedDep, keywords);

    if (matched) {
      continue; // 合法：匹配锁定栈
    }

    // 检查是否在 approvedChanges 中
    if (approvedSet.has(normalizedDep)) {
      continue; // 合法：用户显式批准
    }

    // 违规：既不匹配锁定栈，也未获用户批准
    violations.push(
      `依赖「${dep}」与锁定技术栈不符，且未在用户批准的变更列表中。` +
        `锁定栈关键词：[${keywords.join(", ")}]。` +
        `如需引入该依赖，须用户显式批准后加入 approvedChanges 列表（SEED-06 规则）。`
    );
  }

  return {
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  };
}

// ============================================================================
// 私有辅助函数
// ============================================================================

/**
 * 从决策表提取全部技术关键词
 *
 * 遍历决策表的每层 selectedOption.name，按分隔符分词提取关键词。
 *
 * 分隔符处理：
 * - "+"：分隔多个技术（如 "React 18 + TypeScript + Ant Design"）
 * - "/"：分隔备选方案（如 "S3/OSS/MinIO"）
 * - "（" "）"："（）" 内为备注，单独提取但保留主名
 * - 空格：分隔词组（如 "Spring Boot 3" → ["spring", "boot", "3"]）
 * - 数字版本号：保留作为关键词（如 "18" "3"）
 *
 * 关键词规范化：
 * - 全部转小写
 * - 去除首尾空格
 * - 过滤空字符串
 * - 过滤通用词（如 "sdk" "go" 等可能误匹配的过短词，但保留 "go" 因 Go 语言本身是关键词）
 *
 * @param decisionTable 决策表
 * @returns 技术关键词集合（去重后）
 */
function extractTechKeywords(decisionTable: TechStackDecisionTable): string[] {
  const keywordSet = new Set<string>();

  for (const decision of decisionTable.decisions) {
    const option: TechStackOption = decision.selectedOption;
    const name = option.name;

    // 提取括号前的主名（去备注）
    const mainName = name.split("（")[0].split("(")[0];

    // 按 + / / 分隔
    const parts = mainName.split(/[+/]/);

    for (const part of parts) {
      // 按空格分词
      const words = part.trim().split(/\s+/);
      for (const word of words) {
        const normalized = word.trim().toLowerCase();
        // 过滤空字符串与过短的通用词（避免误匹配）
        if (normalized.length === 0) continue;
        // 保留所有 >= 2 字符的词，以及 "go"（Go 语言本身）
        if (normalized.length >= 2 || normalized === "go") {
          keywordSet.add(normalized);
        }
      }
    }
  }

  return Array.from(keywordSet);
}

/**
 * 规范化依赖名（大小写不敏感匹配准备）
 *
 * 规范化策略：
 * - 转小写
 * - 去除首尾空格
 * - 保留 @scope/name 的完整形式（如 "@nestjs/core" 保留为 "@nestjs/core"）
 *   因为匹配时会检查 "nestjs" 是否为依赖名子串
 *
 * @param dep 原始依赖名（如 "React" / "@nestjs/core" / "antd"）
 * @returns 规范化后的依赖名（如 "react" / "@nestjs/core" / "antd"）
 */
function normalizeDependencyName(dep: string): string {
  return dep.trim().toLowerCase();
}

/**
 * 检查依赖名是否匹配任何技术关键词
 *
 * 匹配规则（大小写不敏感，因调用前已规范化为小写）：
 * 1. **精确匹配**：依赖名等于关键词（如 "react" === "react"）
 * 2. **子串包含**：依赖名包含关键词，或关键词包含依赖名
 *    - "react" 匹配 "react"（精确）
 *    - "@nestjs/core" 匹配 "nestjs"（依赖名包含关键词）
 *    - "antd" 匹配 "ant"（关键词包含依赖名）—— 注意：此处需谨慎
 * 3. **特殊处理**：对于 "@scope/name" 格式的依赖，提取 scope 部分单独匹配
 *    - "@nestjs/core" 提取 "nestjs" 后与关键词匹配
 *
 * 为避免误匹配（如 "ant" 匹配 "antd" 但 "ant" 不是技术关键词），
 * 采用双向子串匹配 + scope 提取的组合策略：
 * - 依赖名包含关键词（关键词是依赖名子串）
 * - 或关键词包含依赖名（依赖名是关键词子串）
 * - 或 @scope/name 的 scope 部分匹配关键词
 *
 * @param normalizedDep 规范化后的依赖名
 * @param keywords 技术关键词列表
 * @returns true=匹配任一关键词，false=不匹配
 */
function matchesAnyKeyword(normalizedDep: string, keywords: string[]): boolean {
  // 提取 @scope/name 的 scope 部分（如 "@nestjs/core" → "nestjs"）
  const scopeMatch = normalizedDep.match(/^@([^/]+)/);
  const scope = scopeMatch ? scopeMatch[1] : null;

  for (const keyword of keywords) {
    // 精确匹配
    if (normalizedDep === keyword) {
      return true;
    }
    // 依赖名包含关键词（关键词是依赖名子串）
    if (normalizedDep.includes(keyword)) {
      return true;
    }
    // 关键词包含依赖名（依赖名是关键词子串，但依赖名需 >= 3 字符避免误匹配）
    if (normalizedDep.length >= 3 && keyword.includes(normalizedDep)) {
      return true;
    }
    // scope 部分匹配关键词
    if (scope && scope === keyword) {
      return true;
    }
    if (scope && scope.length >= 3 && keyword.includes(scope)) {
      return true;
    }
  }
  return false;
}
