/**
 * RLIS 三层规则存储（Rule Store）
 *
 * EAG 方案 §5.5.2 三层规则存储的核心实现。负责加载、合并、持久化三层规则：
 * 1. 内置种子层（seed-rules.ts，最低优先级，随版本发布）
 * 2. 全局用户层（~/.deepcode/rules/user-rules.json，跨项目生效的个人规范）
 * 3. 项目层（.deepcode/rules/project-rules.json，最高优先级，覆盖全局同名规则）
 *
 * 合并规则（§5.5.2）：
 * - 同 ID 规则按优先级覆盖：项目 > 用户 > 种子
 * - 不同 ID 规则全部生效
 * - 可移除的种子规则（removable=true）可通过 /rules remove 移除，
 *   移除后 ID 写入 removedSeedIds 数组，下次加载时跳过
 * - BLOCKER 级种子规则（removable=false）不可移除，确保系统硬约束永远生效
 *
 * 注入格式（§5.5.3）：
 * - system_prompt 注入：按 severity 分组（BLOCKER 置顶）+ category 标签
 * - evaluator 注入：转换为 RedlineDefinition[] 接入 IndependentEvaluator 判定清单
 * - 超 token 预算时按 severity 截断（WARNING 最先裁）
 *
 * 设计依据：
 * - EAG 方案 §5.5.2 三层规则存储表
 * - EAG 方案 §5.5.3 规则注入（directRetainSnippets 通道复用）
 * - EAG 方案 §5.5.6 与 EAG 的集成（规则即红线）
 * - 项目约定：settings.ts 使用 ~/.deepcode/ 目录（本模块沿用相同约定）
 *
 * @module eag/rlis/rule-store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RedlineDefinition } from "../evaluator/types.js";
import { SEED_RULES } from "./seed-rules.js";
import type { InjectionTarget, MergedRuleSet, RuleDefinition, RuleSource, RuleStorageLayer } from "./types.js";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 规则文件版本号
 *
 * 用于后续 schema 演进时的兼容性检测。当前版本 1。
 */
const RULES_FILE_VERSION = 1;

/**
 * 默认用户规则文件路径
 *
 * 与 settings.ts 的 ~/.deepcode/settings.json 保持目录一致。
 * 路径：~/.deepcode/rules/user-rules.json
 */
const DEFAULT_USER_RULES_PATH = path.join(os.homedir(), ".deepcode", "rules", "user-rules.json");

/**
 * 默认项目规则文件路径
 *
 * 与 settings.ts 的 .deepcode/settings.json 保持目录一致。
 * 路径：<projectRoot>/.deepcode/rules/project-rules.json
 *
 * @param projectRoot 项目根目录
 */
function getDefaultProjectRulesPath(projectRoot: string): string {
  return path.join(projectRoot, ".deepcode", "rules", "project-rules.json");
}

// ============================================================================
// 规则文件结构
// ============================================================================

/**
 * 规则文件结构（user-rules.json / project-rules.json 的 JSON schema）
 *
 * 持久化到磁盘的规则文件格式。包含：
 * - version：schema 版本号，用于后续兼容性检测
 * - rules：规则列表（不含种子规则，种子规则在代码中）
 * - removedSeedIds：用户移除的可移除种子规则 ID 列表
 *
 * 注意：BLOCKER 级种子规则（removable=false）即使被加入 removedSeedIds 也会被忽略，
 * 确保系统硬约束永远生效。
 */
interface RuleFile {
  /** 文件 schema 版本号 */
  version: number;
  /** 用户/项目自定义规则列表 */
  rules: RuleDefinition[];
  /** 已移除的可移除种子规则 ID 列表 */
  removedSeedIds: string[];
}

// ============================================================================
// 操作结果类型
// ============================================================================

/**
 * 规则操作结果
 *
 * addRule / removeRule / disableRule 等变更操作的统一返回类型。
 * success=false 时 error 字段提供失败原因（用于 CLI 层面向用户展示）。
 */
export interface RuleOperationResult {
  /** 操作是否成功 */
  success: boolean;
  /** 失败原因（success=false 时填写） */
  error?: string;
  /** 操作影响的规则 ID（成功时填写） */
  ruleId?: string;
}

// ============================================================================
// 注入格式化配置
// ============================================================================

/**
 * System Prompt 注入格式化配置
 *
 * 控制规则格式化为 LLM system message 文本时的行为。
 */
export interface SystemPromptFormatOptions {
  /** Token 预算上限（超限时按 severity 截断，WARNING 最先裁） */
  tokenBudget?: number;
  /** 是否包含 WARNING 级规则（默认 true） */
  includeWarnings?: boolean;
  /** 是否包含 category 分组标题（默认 true） */
  includeCategoryHeaders?: boolean;
}

/**
 * 默认 Token 预算
 *
 * 规则注入的默认 Token 上限。约 4000 Token，足够 10-30 条规则的完整注入。
 * 实际生产中由调用方按当前 LLM 上下文剩余空间动态传入。
 */
const DEFAULT_TOKEN_BUDGET = 4000;

/**
 * Token 估算系数
 *
 * 简单的 Token 估算：1 个中文字符 ≈ 2 Token，1 个英文单词 ≈ 1.3 Token。
 * 此估算不依赖 tokenizer 库，仅用于预算控制，精度足够。
 * 实际 Token 数由 LLM API 返回的 usage 字段精确统计。
 */
const TOKEN_ESTIMATE_RATIO_CN = 2;
const TOKEN_ESTIMATE_RATIO_EN = 1.3;

// ============================================================================
// RuleStore 类
// ============================================================================

/**
 * 三层规则存储器
 *
 * 负责加载、合并、持久化三层规则。每次操作都重新从磁盘加载，
 * 保证多进程/多会话并发修改时的一致性（rule 文件变更频率极低，性能可接受）。
 *
 * 用法：
 * ```typescript
 * const store = new RuleStore({
 *   userRulesPath: "~/.deepcode/rules/user-rules.json",
 *   projectRulesPath: "./.deepcode/rules/project-rules.json",
 * });
 *
 * // 加载合并后的规则集
 * const ruleset = store.loadMergedRuleset();
 * console.log(`生效规则：${ruleset.rules.length} 条`);
 *
 * // 添加用户规则
 * const result = store.addRule({
 *   id: "USER-01",
 *   name: "禁止 console.log",
 *   description: "生产代码中不得残留 console.log 调试语句",
 *   severity: "major",
 *   source: "user",
 *   injectionTargets: ["system_prompt", "evaluator"],
 *   pattern: "console\\.(log|debug|info)\\(",
 *   tags: ["code-quality", "no-debug"],
 *   removable: true,
 * }, "user");
 *
 * // 格式化为 system prompt 注入文本
 * const promptText = store.formatForSystemPrompt(ruleset);
 *
 * // 格式化为评估器红线清单
 * const redlines = store.formatForEvaluator(ruleset);
 * ```
 *
 * 线程安全：本类不做内存缓存，每次操作都从磁盘加载，无并发问题。
 * 文件写入使用临时文件 + rename 原子操作，防止并发写入导致文件损坏。
 */
export class RuleStore {
  /** 用户规则文件路径（~/.deepcode/rules/user-rules.json） */
  private readonly userRulesPath: string;
  /** 项目规则文件路径（<projectRoot>/.deepcode/rules/project-rules.json） */
  private readonly projectRulesPath: string;

  /**
   * 构造 RuleStore
   *
   * @param options 配置选项（主要用于测试注入临时路径）
   */
  constructor(options?: {
    /** 用户规则文件路径（默认 ~/.deepcode/rules/user-rules.json） */
    userRulesPath?: string;
    /** 项目规则文件路径（默认 <cwd>/.deepcode/rules/project-rules.json） */
    projectRulesPath?: string;
    /** 项目根目录（用于推导默认项目规则路径） */
    projectRoot?: string;
  }) {
    this.userRulesPath = options?.userRulesPath ?? DEFAULT_USER_RULES_PATH;
    this.projectRulesPath =
      options?.projectRulesPath ?? getDefaultProjectRulesPath(options?.projectRoot ?? process.cwd());
  }

  // ========================================================================
  // 公共 API：加载与合并
  // ========================================================================

  /**
   * 加载并合并三层规则
   *
   * 合并逻辑（§5.5.2）：
   * 1. 加载种子规则（SEED_RULES，代码内常量）
   * 2. 加载用户规则（user-rules.json，可选）
   * 3. 加载项目规则（project-rules.json，可选）
   * 4. 合并：同 ID 规则按优先级覆盖（项目 > 用户 > 种子）
   * 5. 应用 removedSeedIds：从合并结果中移除被用户移除的可移除种子规则
   *
   * @returns 合并后的规则集
   */
  loadMergedRuleset(): MergedRuleSet {
    // 1. 加载三层规则文件
    const userFile = this.loadRuleFile(this.userRulesPath);
    const projectFile = this.loadRuleFile(this.projectRulesPath);

    const userRules = userFile?.rules ?? [];
    const projectRules = projectFile?.rules ?? [];

    // 2. 合并 removedSeedIds（用户层和项目层都可能有移除记录，取并集）
    const removedSeedIds = new Set<string>([
      ...(userFile?.removedSeedIds ?? []),
      ...(projectFile?.removedSeedIds ?? []),
    ]);

    // 3. 按 ID 合并三层规则（项目 > 用户 > 种子）
    const mergedById = new Map<string, RuleDefinition>();

    // 3.1 先放种子规则（最低优先级）
    for (const rule of SEED_RULES) {
      mergedById.set(rule.id, rule);
    }
    // 3.2 再放用户规则（覆盖同 ID 的种子规则）
    for (const rule of userRules) {
      mergedById.set(rule.id, rule);
    }
    // 3.3 最后放项目规则（最高优先级，覆盖同 ID 的用户/种子规则）
    for (const rule of projectRules) {
      mergedById.set(rule.id, rule);
    }

    // 4. 应用 removedSeedIds：移除被标记移除的可移除种子规则
    // BLOCKER 级种子规则（removable=false）即使在 removedSeedIds 中也保留
    const finalRules: RuleDefinition[] = [];
    let seedCount = 0;
    let userCount = 0;
    let projectCount = 0;

    for (const rule of mergedById.values()) {
      // 仅对种子规则检查移除标记（用户/项目规则不受 removedSeedIds 影响）
      if (rule.source === "seed") {
        // 检查是否被标记移除
        if (removedSeedIds.has(rule.id)) {
          // BLOCKER 级种子规则不可移除——即使被加入 removedSeedIds 也保留
          if (!rule.removable) {
            finalRules.push(rule);
            seedCount++;
            continue;
          }
          // 可移除的种子规则被标记移除——跳过
          continue;
        }
        finalRules.push(rule);
        seedCount++;
      } else if (rule.source === "user" || rule.source === "learned") {
        finalRules.push(rule);
        userCount++;
      } else if (rule.source === "project") {
        finalRules.push(rule);
        projectCount++;
      } else {
        // 未知 source（兼容性处理）：保留但不计入任何层
        finalRules.push(rule);
      }
    }

    return {
      rules: finalRules,
      seedCount,
      userCount,
      projectCount,
      removedSeedIds: Array.from(removedSeedIds),
    };
  }

  // ========================================================================
  // 公共 API：添加规则
  // ========================================================================

  /**
   * 添加规则到指定存储层
   *
   * 限制：
   * - 不允许添加 source="seed" 的规则（种子规则在代码中维护）
   * - 同层内 ID 必须唯一（跨层允许覆盖，符合合并优先级）
   * - learned 来源规则需经用户确认后才能添加（调用方负责确认流程）
   *
   * @param rule 规则定义（source 字段会被强制覆盖为 layer 对应值）
   * @param layer 目标存储层（user / project）
   * @returns 操作结果
   */
  addRule(rule: RuleDefinition, layer: RuleStorageLayer): RuleOperationResult {
    // 参数校验
    if (layer === "seed") {
      return {
        success: false,
        error: "种子规则在代码中维护，不支持通过 addRule 添加",
      };
    }

    // 强制覆盖 source 字段，确保与存储层一致
    const normalizedRule: RuleDefinition = {
      ...rule,
      source: layer as RuleSource,
    };

    // 基础校验
    const validationError = validateRule(normalizedRule);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // 加载目标层文件
    const filePath = this.getLayerFilePath(layer);
    const file = this.loadRuleFile(filePath) ?? createEmptyRuleFile();

    // 检查同层内 ID 唯一性
    const existingIndex = file.rules.findIndex((r) => r.id === normalizedRule.id);
    if (existingIndex >= 0) {
      return {
        success: false,
        error: `规则 ID "${normalizedRule.id}" 在 ${layer} 层已存在，请使用不同 ID 或先移除原规则`,
      };
    }

    // 添加规则并保存
    file.rules.push(normalizedRule);
    const saveError = this.saveRuleFile(filePath, file);
    if (saveError) {
      return { success: false, error: saveError };
    }

    return { success: true, ruleId: normalizedRule.id };
  }

  // ========================================================================
  // 公共 API：移除规则
  // ========================================================================

  /**
   * 移除规则
   *
   * 移除逻辑：
   * - 用户/项目规则：从对应文件中删除
   * - 种子规则：removable=true 的写入 removedSeedIds（下次加载时跳过）；
   *            removable=false 的拒绝移除（BLOCKER 级种子规则不可移除）
   *
   * @param ruleId 规则 ID
   * @returns 操作结果
   */
  removeRule(ruleId: string): RuleOperationResult {
    // 1. 先查种子规则
    const seedRule = SEED_RULES.find((r) => r.id === ruleId);
    if (seedRule) {
      // 检查是否可移除
      if (!seedRule.removable) {
        return {
          success: false,
          error: `种子规则 ${ruleId} 为 BLOCKER 级硬约束，不可移除（removable=false）`,
        };
      }
      // 可移除：写入用户层的 removedSeedIds
      const userFile = this.loadRuleFile(this.userRulesPath) ?? createEmptyRuleFile();
      if (!userFile.removedSeedIds.includes(ruleId)) {
        userFile.removedSeedIds.push(ruleId);
        const saveError = this.saveRuleFile(this.userRulesPath, userFile);
        if (saveError) {
          return { success: false, error: saveError };
        }
      }
      return { success: true, ruleId };
    }
    // 2. 查用户/项目规则并删除
    for (const layer of ["user", "project"] as const) {
      const filePath = this.getLayerFilePath(layer);
      const file = this.loadRuleFile(filePath);
      if (!file) continue;
      const index = file.rules.findIndex((r) => r.id === ruleId);
      if (index >= 0) {
        file.rules.splice(index, 1);
        const saveError = this.saveRuleFile(filePath, file);
        if (saveError) {
          return { success: false, error: saveError };
        }
        return { success: true, ruleId };
      }
    }
    return {
      success: false,
      error: `规则 ID "${ruleId}" 不存在于任何层`,
    };
  }

  // ========================================================================
  // 公共 API：按 ID 查询规则
  // ========================================================================

  /**
   * 按 ID 查询单条规则
   *
   * @param ruleId 规则 ID
   * @returns 规则定义；不存在时返回 null
   */
  getRuleById(ruleId: string): RuleDefinition | null {
    const ruleset = this.loadMergedRuleset();
    return ruleset.rules.find((r) => r.id === ruleId) ?? null;
  }

  // ========================================================================
  // 公共 API：格式化为 System Prompt 注入文本
  // ========================================================================

  /**
   * 格式化规则为 LLM System Prompt 注入文本
   *
   * 格式（§5.5.3）：
   * ```
   * ## 项目规则清单（生效中）
   *
   * ### BLOCKER 级（不可豁免）
   * - [SEED-01] 禁止模拟/占位/mock 开发
   *   严禁使用模拟、占位、mock、简化的方式开发代码...
   * - [SEED-03] 严禁未批准的简化实现
   *   ...
   *
   * ### MAJOR 级（可人工豁免）
   * - [SEED-02] 代码注释中文且详细
   *   ...
   *
   * ### WARNING 级（仅提示）
   * - [USER-01] ...
   *   ...
   * ```
   *
   * Token 预算控制：
   * - 超 budget 时按 severity 截断（WARNING 最先裁，然后 MAJOR，BLOCKER 永不裁）
   * - 单条规则的超长描述截断到 200 字符并加 "..."
   *
   * @param ruleset 合并后的规则集（不传则重新加载）
   * @param options 格式化选项
   * @returns 格式化的注入文本（空规则集返回空字符串）
   */
  formatForSystemPrompt(ruleset?: MergedRuleSet, options?: SystemPromptFormatOptions): string {
    const rs = ruleset ?? this.loadMergedRuleset();
    const budget = options?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const includeWarnings = options?.includeWarnings ?? true;
    const includeCategoryHeaders = options?.includeCategoryHeaders ?? true;

    if (rs.rules.length === 0) {
      return "";
    }

    // 按 severity 分组（BLOCKER 优先）
    const blockerRules: RuleDefinition[] = [];
    const majorRules: RuleDefinition[] = [];
    const warningRules: RuleDefinition[] = [];
    for (const rule of rs.rules) {
      // 仅注入目标包含 system_prompt 的规则
      if (!rule.injectionTargets.includes("system_prompt")) {
        continue;
      }
      if (rule.severity === "blocker") {
        blockerRules.push(rule);
      } else if (rule.severity === "major") {
        majorRules.push(rule);
      } else if (includeWarnings) {
        warningRules.push(rule);
      }
    }

    // 构建文本并控制 Token 预算
    const lines: string[] = ["## 项目规则清单（生效中）", ""];

    // 按层级追加，每次检查 Token 预算
    let usedTokens = 0;
    const headerTokens = estimateTokens(lines.join("\n"));
    usedTokens += headerTokens;

    // BLOCKER 永不裁剪
    if (blockerRules.length > 0) {
      const section = this.formatSeveritySection("BLOCKER 级（不可豁免）", blockerRules, includeCategoryHeaders);
      usedTokens += estimateTokens(section);
      lines.push(section);
    }

    // MAJOR 在预算内追加
    if (majorRules.length > 0) {
      const section = this.formatSeveritySection("MAJOR 级（可人工豁免）", majorRules, includeCategoryHeaders);
      const sectionTokens = estimateTokens(section);
      if (usedTokens + sectionTokens <= budget) {
        usedTokens += sectionTokens;
        lines.push(section);
      } else {
        // 预算不足——按单条裁剪
        const partial = this.formatSeveritySectionWithBudget(
          "MAJOR 级（可人工豁免）",
          majorRules,
          includeCategoryHeaders,
          budget - usedTokens
        );
        if (partial) {
          lines.push(partial);
          usedTokens += estimateTokens(partial);
        }
      }
    }

    // WARNING 最先裁
    if (includeWarnings && warningRules.length > 0) {
      const section = this.formatSeveritySection("WARNING 级（仅提示）", warningRules, includeCategoryHeaders);
      const sectionTokens = estimateTokens(section);
      if (usedTokens + sectionTokens <= budget) {
        lines.push(section);
      } else {
        const partial = this.formatSeveritySectionWithBudget(
          "WARNING 级（仅提示）",
          warningRules,
          includeCategoryHeaders,
          budget - usedTokens
        );
        if (partial) {
          lines.push(partial);
        }
      }
    }

    return lines.join("\n").trim();
  }

  // ========================================================================
  // 公共 API：格式化为评估器红线清单
  // ========================================================================

  /**
   * 格式化规则为评估器红线清单
   *
   * 将规则转换为 RedlineDefinition[]，接入 IndependentEvaluator 判定清单。
   * 仅包含 injectionTargets 包含 "evaluator" 的规则。
   *
   * 转换映射：
   * - rule.id → redline.id
   * - rule.name → redline.name
   * - rule.description → redline.description
   * - rule.severity → redline.severity
   * - rule.pattern != null → checkType="static"，checkMethod="正则模式扫描"
   * - rule.pattern == null → checkType="reasoning"，checkMethod="LLM 推理判定"
   * - fixGuidance 由 rule.description 派生（"请按规则要求修复：<description>"）
   *
   * @param ruleset 合并后的规则集（不传则重新加载）
   * @returns 红线定义列表
   */
  formatForEvaluator(ruleset?: MergedRuleSet): RedlineDefinition[] {
    const rs = ruleset ?? this.loadMergedRuleset();
    const redlines: RedlineDefinition[] = [];
    for (const rule of rs.rules) {
      // 仅注入目标包含 evaluator 的规则
      if (!rule.injectionTargets.includes("evaluator")) {
        continue;
      }
      redlines.push(ruleToRedline(rule));
    }
    return redlines;
  }

  // ========================================================================
  // 公共 API：获取文件路径（供 CLI 显示）
  // ========================================================================

  /**
   * 获取用户规则文件路径
   */
  getUserRulesPath(): string {
    return this.userRulesPath;
  }

  /**
   * 获取项目规则文件路径
   */
  getProjectRulesPath(): string {
    return this.projectRulesPath;
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 获取指定层的规则文件路径
   *
   * @param layer 存储层
   * @returns 文件路径
   */
  private getLayerFilePath(layer: RuleStorageLayer): string {
    if (layer === "user") return this.userRulesPath;
    if (layer === "project") return this.projectRulesPath;
    throw new Error(`不支持的存储层: ${layer}`);
  }

  /**
   * 加载规则文件
   *
   * 文件不存在或解析失败时返回 null（不抛错，降级为空规则集）。
   *
   * @param filePath 文件路径
   * @returns 规则文件对象；不存在或无效时返回 null
   */
  private loadRuleFile(filePath: string): RuleFile | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuleFile>;

      // 基础 schema 校验
      if (typeof parsed !== "object" || parsed === null) {
        return null;
      }
      if (!Array.isArray(parsed.rules)) {
        return null;
      }
      if (!Array.isArray(parsed.removedSeedIds)) {
        parsed.removedSeedIds = [];
      }
      // 版本号校验（未来版本演进时做兼容处理）
      if (typeof parsed.version !== "number") {
        parsed.version = RULES_FILE_VERSION;
      }
      return parsed as RuleFile;
    } catch {
      // 读取或解析失败——降级为空
      return null;
    }
  }

  /**
   * 保存规则文件（原子写入）
   *
   * 使用临时文件 + rename 实现原子写入，防止并发写入导致文件损坏。
   * 自动创建父目录。
   *
   * @param filePath 文件路径
   * @param file 规则文件对象
   * @returns 错误信息（成功时为 null）
   */
  private saveRuleFile(filePath: string, file: RuleFile): string | null {
    try {
      // 确保父目录存在
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      // 写入临时文件，再 rename 为目标文件（原子操作）
      const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
      const content = JSON.stringify(file, null, 2) + "\n";
      fs.writeFileSync(tmpPath, content, "utf8");
      fs.renameSync(tmpPath, filePath);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `写入规则文件失败: ${filePath} — ${message}`;
    }
  }

  /**
   * 格式化单个 severity 分组为文本
   *
   * @param header 分组标题
   * @param rules 规则列表
   * @param includeCategoryHeaders 是否在分组内按 category 子分组
   * @returns 格式化的文本块
   */
  private formatSeveritySection(header: string, rules: RuleDefinition[], includeCategoryHeaders: boolean): string {
    const lines: string[] = [`### ${header}`, ""];
    if (includeCategoryHeaders) {
      // 按 category（首个 tag）分组
      const groups = new Map<string, RuleDefinition[]>();
      for (const rule of rules) {
        const category = rule.tags[0] ?? "general";
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category)!.push(rule);
      }
      for (const [category, groupRules] of groups) {
        lines.push(`**[${category}]**`);
        for (const rule of groupRules) {
          lines.push(...formatRuleLines(rule));
        }
        lines.push("");
      }
    } else {
      for (const rule of rules) {
        lines.push(...formatRuleLines(rule));
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * 格式化单个 severity 分组为文本（带 Token 预算裁剪）
   *
   * 超 budget 时按规则顺序截断，末尾追加 "...（已截断，剩余 N 条规则未显示）"
   *
   * @param header 分组标题
   * @param rules 规则列表
   * @param includeCategoryHeaders 是否在分组内按 category 子分组
   * @param budgetTokens 剩余 Token 预算
   * @returns 格式化的文本块；预算不足时返回空字符串
   */
  private formatSeveritySectionWithBudget(
    header: string,
    rules: RuleDefinition[],
    includeCategoryHeaders: boolean,
    budgetTokens: number
  ): string {
    if (budgetTokens <= 0) return "";
    const lines: string[] = [`### ${header}`, ""];
    let usedTokens = estimateTokens(lines.join("\n"));
    let shown = 0;
    for (const rule of rules) {
      const ruleLines = formatRuleLines(rule);
      const ruleTokens = estimateTokens(ruleLines.join("\n"));
      if (usedTokens + ruleTokens > budgetTokens) {
        break;
      }
      lines.push(...ruleLines);
      usedTokens += ruleTokens;
      shown++;
    }
    if (shown === 0) {
      return "";
    }
    if (shown < rules.length) {
      lines.push(`...（已截断，剩余 ${rules.length - shown} 条规则未显示）`);
    }
    lines.push("");
    return lines.join("\n");
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建空规则文件对象
 *
 * @returns 空的 RuleFile
 */
function createEmptyRuleFile(): RuleFile {
  return {
    version: RULES_FILE_VERSION,
    rules: [],
    removedSeedIds: [],
  };
}

/**
 * 校验规则定义
 *
 * @param rule 规则定义
 * @returns 错误信息（通过校验时返回 null）
 */
export function validateRule(rule: RuleDefinition): string | null {
  if (!rule.id || rule.id.trim() === "") {
    return "规则 ID 不能为空";
  }
  if (!rule.name || rule.name.trim() === "") {
    return `规则 ${rule.id} 的 name 不能为空`;
  }
  if (!rule.description || rule.description.trim() === "") {
    return `规则 ${rule.id} 的 description 不能为空`;
  }
  if (!["blocker", "major", "warning"].includes(rule.severity)) {
    return `规则 ${rule.id} 的 severity 无效: ${rule.severity}`;
  }
  if (!["seed", "user", "project", "learned"].includes(rule.source)) {
    return `规则 ${rule.id} 的 source 无效: ${rule.source}`;
  }
  if (!Array.isArray(rule.injectionTargets) || rule.injectionTargets.length === 0) {
    return `规则 ${rule.id} 的 injectionTargets 不能为空`;
  }
  for (const target of rule.injectionTargets) {
    if (!["system_prompt", "evaluator"].includes(target)) {
      return `规则 ${rule.id} 的 injectionTarget 无效: ${target}`;
    }
  }
  if (!Array.isArray(rule.tags)) {
    return `规则 ${rule.id} 的 tags 必须是数组`;
  }
  // pattern 可以为 null（推理判定）或字符串（静态判定）
  if (rule.pattern !== null && typeof rule.pattern !== "string") {
    return `规则 ${rule.id} 的 pattern 必须是 string 或 null`;
  }
  // removable 必须是 boolean
  if (typeof rule.removable !== "boolean") {
    return `规则 ${rule.id} 的 removable 必须是 boolean`;
  }
  return null;
}

/**
 * 格式化单条规则为文本行
 *
 * @param rule 规则定义
 * @returns 文本行数组
 */
function formatRuleLines(rule: RuleDefinition): string[] {
  const lines: string[] = [];
  // 标题行：- [ID] name
  lines.push(`- [${rule.id}] ${rule.name}`);
  // 描述行：缩进 2 空格，超 200 字符截断
  const desc = rule.description.length > 200 ? rule.description.slice(0, 200) + "..." : rule.description;
  lines.push(`  ${desc}`);
  // pattern 提示行（仅当 pattern 存在时）
  if (rule.pattern) {
    lines.push(`  静态检测模式: \`${rule.pattern}\``);
  }
  return lines;
}

/**
 * 规则转换为评估器红线定义
 *
 * @param rule 规则定义
 * @returns 红线定义
 */
export function ruleToRedline(rule: RuleDefinition): RedlineDefinition {
  const isStatic = rule.pattern !== null && rule.pattern !== "";
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    severity: rule.severity,
    checkMethod: isStatic ? `正则模式扫描: ${rule.pattern}` : "LLM 推理判定（需读取代码理解语义）",
    checkType: isStatic ? "static" : "reasoning",
    fixGuidance: `请按规则 "${rule.name}" 要求修复：${rule.description}`,
  };
}

/**
 * 估算文本 Token 数
 *
 * 简单估算：中文字符按 2 Token/字，英文单词按 1.3 Token/词。
 * 此估算仅用于预算控制，精度足够；实际 Token 数由 LLM API usage 字段统计。
 *
 * @param text 文本
 * @returns 估算的 Token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 中文字符数（CJK 统一表意文字 + 全角标点）
  const cnChars = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  // 英文单词数（去除中文后的非空白字符序列）
  const stripped = text.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, " ");
  const enWords = (stripped.match(/[a-zA-Z0-9_]+/g) ?? []).length;
  return Math.ceil(cnChars * TOKEN_ESTIMATE_RATIO_CN + enWords * TOKEN_ESTIMATE_RATIO_EN);
}

// ============================================================================
// 模块导出
// ============================================================================
// 注：RuleStore class、validateRule、ruleToRedline、estimateTokens 均在定义处
// 通过 `export` 关键字导出，此处不再重复导出，避免 TS2323/TS2484 重复导出错误。
// 仅常量和 getDefaultProjectRulesPath 辅助函数在此统一导出，保持模块 API 完整性。
export { DEFAULT_USER_RULES_PATH, DEFAULT_TOKEN_BUDGET, RULES_FILE_VERSION, getDefaultProjectRulesPath };
