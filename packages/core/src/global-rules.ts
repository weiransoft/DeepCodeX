/**
 * 全局规则文件读写与注入格式化（RLIS global 层持久化助手）
 *
 * 仓库的 RLIS RuleStore（eag/rlis）为纯内存实现，CLI 侧（cli/rules/rules-cmd.ts）
 * 自行负责文件 I/O；本模块把同样的文件约定下沉为可复用实现，供两处消费：
 *
 * 1. core SessionManager —— 会话创建时读取全局规则并注入系统提示
 *    （对齐 Trae / WorkBuddy 的「Rules for AI」体验：规则列表对每次新对话生效）；
 * 2. Web API（POST/GET/DELETE /api/rules）—— 设置抽屉「全局规则」页签的增删查。
 *
 * 存储约定（与 CLI /rules 完全一致，单一事实来源）：
 * - 路径：<homeRoot>/.deepcodeX/rules/global-rules.json
 *   - CLI / personalOnly=false：homeRoot = 用户主目录（os.homedir()）
 *   - Web personalOnly=true：homeRoot = <engineHomeRoot>/<userId>（会话牢笼注入值）
 * - 格式：UserRule JSON 数组（缩进 2 空格），ID 前缀 USER-xxx
 * - 合并语义：与种子层/项目层按 ID 覆盖合并（project > global > seed），由 RuleStore 完成
 *
 * 容错纪律：文件缺失/损坏/字段非法一律降级（缺失→空数组；损坏→跳过坏条目；
 * 全坏→空数组），绝不因规则文件问题阻断会话创建或 API 响应。
 *
 * @module global-rules
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  RULE_EVIDENCE_MAX_ENTRIES,
  RULE_SEVERITIES,
  type RuleCategory,
  type RuleEvidence,
  type RuleSeverity,
  type UserRule,
} from "./eag/rlis/types.js";

// ============================================================================
// 常量
// ============================================================================

/** 规则目录相对 homeRoot 的路径（与 CLI rules-cmd.ts 同一约定） */
const RULES_DIR_REL = path.join(".deepcodeX", "rules");

/** 规则文件名（与 CLI rules-cmd.ts 同一约定） */
const RULES_FILE_NAME = "global-rules.json";

/** 合法严重级别集合（运行时校验用，冻结防篡改） */
const VALID_SEVERITIES: ReadonlySet<string> = new Set<string>(RULE_SEVERITIES);

/** 合法分类集合（与 RuleCategory 联合保持一致，运行时校验用） */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<string>([
  "code-truth",
  "comment-style",
  "process-gate",
  "change-control",
  "project-structure",
  "quality-gate",
]);

/** 单条规则内容长度上限（字符）——防止超长文本撑爆系统提示 */
const MAX_RULE_CONTENT_LENGTH = 2000;

/** 全局规则条数上限——超出后拒绝继续添加（系统提示预算保护） */
export const MAX_GLOBAL_RULES = 100;

// ============================================================================
// 文件 I/O
// ============================================================================

/**
 * 计算全局规则文件绝对路径
 *
 * @param homeRoot 引擎数据家目录（CLI=用户主目录；Web=per-user 引擎数据根）
 * @returns <homeRoot>/.deepcodeX/rules/global-rules.json 绝对路径
 */
export function globalRulesFilePath(homeRoot: string): string {
  return path.join(homeRoot, RULES_DIR_REL, RULES_FILE_NAME);
}

/**
 * 条目校验：是否为可接受的 UserRule 形态（必需字段类型齐全）
 *
 * @param item 待校验值
 * @returns true 表示可入库
 */
function isValidRuleShape(item: unknown): item is UserRule {
  if (typeof item !== "object" || item === null) return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.category === "string" &&
    typeof r.severity === "string" &&
    typeof r.content === "string" &&
    typeof r.source === "string" &&
    typeof r.confirmedBy === "string" &&
    typeof r.usageCount === "number" &&
    typeof r.violationCount === "number" &&
    typeof r.createdAt === "string"
  );
}

/**
 * 读取全局规则文件（容错）
 *
 * 文件不存在返回空数组；JSON 损坏或条目字段非法时逐条跳过坏条目，
 * 全部坏则返回空数组——绝不抛异常（调用方为会话创建热路径）。
 *
 * @param homeRoot 引擎数据家目录
 * @returns 规则列表（可能为空）
 */
export function readGlobalRulesFile(homeRoot: string): UserRule[] {
  const filePath = globalRulesFilePath(homeRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    // 不存在 / 无权限等一律视为空规则集
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidRuleShape);
}

/**
 * 写入全局规则文件（父目录自动创建）
 *
 * @param homeRoot 引擎数据家目录
 * @param rules 待写入规则列表
 * @throws fs 写入失败时向上抛出（调用方映射 500/错误提示）
 */
export function writeGlobalRulesFile(homeRoot: string, rules: ReadonlyArray<UserRule>): void {
  const filePath = globalRulesFilePath(homeRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(rules, null, 2), "utf8");
}

// ============================================================================
// 增删（ID 生成与 CLI generateRuleId 同一算法：USER 前缀最大编号 +1）
// ============================================================================

/** 添加规则的可选参数 */
export type GlobalRuleInput = {
  /** 规则正文（必填，去空白后非空，长度 ≤ MAX_RULE_CONTENT_LENGTH） */
  content: string;
  /** 严重级别（缺省 MAJOR；非法值按缺省处理） */
  severity?: string;
  /** 分类（缺省 code-truth；非法值按缺省处理） */
  category?: string;
};

/**
 * 添加一条用户全局规则（USER-xxx）并持久化
 *
 * source 强制 user-explicit、confirmedBy 强制 auto（用户显式添加无需确认），
 * 与 CLI /rules add 落盘语义完全一致。
 *
 * @param homeRoot 引擎数据家目录
 * @param input 规则输入（content 必填）
 * @returns 新增的规则对象
 * @throws Error content 为空白 / 超长 / 规则数达上限 / 文件写入失败
 */
export function addGlobalRule(homeRoot: string, input: GlobalRuleInput): UserRule {
  const content = input.content.trim();
  if (content === "") {
    throw new Error("规则内容不能为空");
  }
  if (content.length > MAX_RULE_CONTENT_LENGTH) {
    throw new Error(`规则内容超长（最多 ${MAX_RULE_CONTENT_LENGTH} 字符）`);
  }
  const existing = readGlobalRulesFile(homeRoot);
  if (existing.length >= MAX_GLOBAL_RULES) {
    throw new Error(`全局规则已达上限（${MAX_GLOBAL_RULES} 条），请先删除部分规则`);
  }
  const severity: RuleSeverity = VALID_SEVERITIES.has(input.severity ?? "")
    ? (input.severity as RuleSeverity)
    : "MAJOR";
  const category = VALID_CATEGORIES.has(input.category ?? "") ? (input.category as RuleCategory) : "code-truth";
  // ID 生成：扫描文件内 USER- 前缀最大编号 +1（3 位补零；≥1000 自然扩位）
  let maxNum = 0;
  for (const rule of existing) {
    if (rule.id.startsWith("USER-")) {
      const num = Number.parseInt(rule.id.slice(5), 10);
      if (!Number.isNaN(num) && num > maxNum) maxNum = num;
    }
  }
  const rule: UserRule = Object.freeze({
    id: `USER-${String(maxNum + 1).padStart(3, "0")}`,
    category,
    severity,
    content,
    source: "user-explicit",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: new Date().toISOString(),
  });
  writeGlobalRulesFile(homeRoot, [...existing, rule]);
  return rule;
}

/**
 * 删除一条全局规则（按 ID）并持久化
 *
 * @param homeRoot 引擎数据家目录
 * @param id 规则 ID（USER-xxx）
 * @returns true=已删除；false=不存在
 * @throws fs 写入失败时向上抛出
 */
export function deleteGlobalRule(homeRoot: string, id: string): boolean {
  const existing = readGlobalRulesFile(homeRoot);
  const next = existing.filter((r) => r.id !== id);
  if (next.length === existing.length) return false;
  writeGlobalRulesFile(homeRoot, next);
  return true;
}

// ============================================================================
// 注入证据回写（P1 资产使用证据链：注入即 Wired）
// ============================================================================

/**
 * 标记一批全局规则已被注入（会话创建成功注入后调用）
 *
 * 对每条规则：usageCount +1（对齐 §5.5.4「每次注入 +1」语义）并追加
 * evidence.wiredAt 时间戳（P1 record-only 证据链）。全容错：文件缺失/
 * 读取失败/写入失败一律静默跳过——证据记录绝不阻断会话创建热路径。
 *
 * @param homeRoot 引擎数据家目录
 * @param injectedAt 注入时刻（缺省取当前时间；测试可传固定值）
 */
export function markGlobalRulesInjected(homeRoot: string, injectedAt?: string): void {
  try {
    const rules = readGlobalRulesFile(homeRoot);
    if (rules.length === 0) return;
    const now = injectedAt ?? new Date().toISOString();
    const cap = (arr: ReadonlyArray<string>): string[] =>
      arr.length >= RULE_EVIDENCE_MAX_ENTRIES ? [...arr.slice(1), now] : [...arr, now];
    const next: UserRule[] = rules.map((r) => {
      const prevEvidence: RuleEvidence = {
        wiredAt: r.evidence?.wiredAt ?? [],
        exercisedAt: r.evidence?.exercisedAt ?? [],
        verdictRefs: r.evidence?.verdictRefs ?? [],
      };
      return {
        ...r,
        usageCount: r.usageCount + 1,
        evidence: { ...prevEvidence, wiredAt: cap(prevEvidence.wiredAt) },
      };
    });
    writeGlobalRulesFile(homeRoot, next);
  } catch {
    // 容错纪律：证据回写失败不抛错（调用方为会话创建热路径）
  }
}

// ============================================================================
// 注入格式化
// ============================================================================

/**
 * 将全局规则格式化为系统提示注入段
 *
 * 输出形如：
 * ```
 * # 全局规则（用户定义，最高优先级遵循）
 *
 * 以下规则由用户在系统管理中配置，适用于当前所有任务，与内置规范冲突时以本清单为准：
 *
 * - [BLOCKER] 禁止使用 var 声明变量
 * - [MAJOR] 始终使用中文回复
 * ```
 *
 * @param rules 规则列表
 * @returns 注入文本；空列表返回 null（调用方跳过注入，不产生空消息）
 */
export function formatGlobalRulesPrompt(rules: ReadonlyArray<UserRule>): string | null {
  if (rules.length === 0) return null;
  const lines = rules.map((r) => `- [${r.severity}] ${r.content}`);
  return [
    "# 全局规则（用户定义，最高优先级遵循）",
    "",
    "以下规则由用户在系统管理中配置，适用于当前所有任务，与内置规范冲突时以本清单为准：",
    "",
    ...lines,
  ].join("\n");
}
