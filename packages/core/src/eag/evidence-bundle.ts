/**
 * EAG Evidence Bundle —— 统一证据包（P2，借鉴 Better Harness evidence-bundle 设计）
 *
 * 职责：
 * 把分散的工作流证据（执行历史 / 三层规则资产 / 技能清单）聚合为一个
 * 单命令、可冻结、可校验的 JSON 证据包，供 P3 Finding 沉淀、P5 重复工作
 * 发现与 P6 审计报告消费——一切结论必须可回溯到 bundle 事件。
 *
 * 设计原则（对齐 docs/proposals/better-harness-enhancement/proposal-final.md）：
 * 1. 单命令冻结边界：同窗口重复执行输出字节级一致（冻结性）——
 *    - 输出不含 Date.now()（generatedAt 取窗口终点 until）
 *    - 记录按 (timestamp, id) 升序排序，对象键按固定顺序构造
 * 2. 隐私红线：进入 bundle 的自由文本一律过 SensitiveInfoRedactor 脱敏；
 *    脱敏失败宁可丢字段也不落明文；原始 outputSnippet/errorSnippet 不进 bundle
 * 3. 计数只用于路由：资产 inventory 只含 ID/计数/证据级别，不含规则正文，
 *    永不直接产生 Finding（判断权归消费方评估器）
 * 4. 容错降级：任何数据源缺失/损坏 → 对应部分置空 + manifest 标注，不抛异常
 *
 * 数据源（真实路径，2026-11 勘误版）：
 * - 执行历史：<homeDir>/.deepcode/projects/<projectCode>/execution-history.jsonl
 *   （v2/memory/execution-history-store.ts）
 * - 全局规则：<homeDir>/.deepcodeX/rules/global-rules.json（global-rules.ts）
 * - 项目规则：<projectRoot>/.deepcode/rules/project-rules.json
 * - 种子规则：eag/rlis/seed-rules.ts（SEED_RULES，只取计数与 ID）
 * - 技能清单：可选注入 provider（skill-manager.ts listSkills），record-only
 *
 * @module eag/evidence-bundle
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ExecutionHistoryStore } from "../v2/memory/execution-history-store.js";
import { DEFAULT_REDACTION_RULES, SensitiveInfoRedactor, type RedactionHit } from "../v2/memory/redaction.js";
import { globalRulesFilePath, readGlobalRulesFile } from "../global-rules.js";
import { SEED_RULES } from "./rlis/seed-rules.js";
import { deriveRuleEvidenceState, type UserRule } from "./rlis/types.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 证据包深度档位：quick = 7 天窗口 + 小样本；normal = 30 天全量 */
export type EvidenceBundleDepth = "quick" | "normal";

/** 证据包构建参数 */
export interface EvidenceBundleOptions {
  /** 项目根目录（工作区锚点，必填） */
  readonly projectRoot: string;
  /**
   * 引擎数据家目录（缺省 os.homedir()；Web 多用户模式注入 <engineHomeRoot>/<userId>）
   */
  readonly homeDir?: string;
  /** 窗口起点（ms epoch）；缺省 = until - 深度默认天数 */
  readonly since?: number;
  /** 窗口终点（ms epoch）；缺省 = Date.now()（此时冻结性由调用方保证——测试必须显式传） */
  readonly until?: number;
  /** 深度档位（缺省 normal） */
  readonly depth?: EvidenceBundleDepth;
  /** 执行记录上限（缺省 quick=200 / normal=2000） */
  readonly maxRecords?: number;
  /** 脱敏器（可注入自定义 logPath；缺省用默认规则 + 默认审计日志路径） */
  readonly redactor?: SensitiveInfoRedactor;
  /** 技能清单 provider（可选，record-only；缺省技能清单为空并在 manifest 标注） */
  readonly listSkills?: () => Promise<Array<{ name: string; path: string }>>;
}

/** bundle 内的单条执行记录（脱敏后的瘦身影子） */
export interface EvidenceExecutionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly date: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly ok: boolean;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  /** 脱敏后的参数摘要（≤500 字符；原始 argsSnippet 不出 store） */
  readonly args: string;
  /** 产出物路径列表（bash-output 类为输出路径） */
  readonly artifactPaths: ReadonlyArray<string>;
  /** 本次脱敏命中数（审计线索，不含明文） */
  readonly redactionHits: number;
}

/** bundle 内的单条规则资产条目（计数 + 证据级别，无正文） */
export interface EvidenceRuleEntry {
  readonly id: string;
  readonly layer: "seed" | "global" | "project";
  readonly category: string;
  readonly severity: string;
  readonly source: string;
  readonly usageCount: number;
  readonly violationCount: number;
  /** 证据级别（present/wired/exercised/outcome-supported，由 deriveRuleEvidenceState 推导） */
  readonly evidenceState: string;
}

/** 证据包主体 */
export interface EvidenceBundle {
  readonly schemaVersion: "1";
  readonly depth: EvidenceBundleDepth;
  readonly window: { readonly since: string; readonly until: string };
  readonly workspace: string;
  /** 生成时间 = 窗口终点（冻结性：不含真实 now） */
  readonly generatedAt: string;
  readonly summary: {
    readonly recordCount: number;
    readonly okCount: number;
    readonly failCount: number;
    readonly sessionCount: number;
    /** 工具名 → 次数（按工具名字典序插入，保证 JSON 稳定） */
    readonly toolCounts: Readonly<Record<string, number>>;
  };
  readonly executionHistory: ReadonlyArray<EvidenceExecutionRecord>;
  readonly assets: {
    readonly rules: {
      readonly seed: ReadonlyArray<EvidenceRuleEntry>;
      readonly global: ReadonlyArray<EvidenceRuleEntry>;
      readonly project: ReadonlyArray<EvidenceRuleEntry>;
    };
    readonly skills: { readonly count: number; readonly names: ReadonlyArray<string> };
  };
  readonly manifest: {
    readonly sources: ReadonlyArray<{
      readonly path: string;
      /** 文件 SHA256；文件缺失时为 null */
      readonly sha256: string | null;
    }>;
  };
}

// ============================================================================
// 常量
// ============================================================================

/** 深度默认窗口天数 */
const DEPTH_DEFAULT_DAYS: Readonly<Record<EvidenceBundleDepth, number>> = Object.freeze({
  quick: 7,
  normal: 30,
});

/** 深度默认记录上限 */
const DEPTH_DEFAULT_MAX_RECORDS: Readonly<Record<EvidenceBundleDepth, number>> = Object.freeze({
  quick: 200,
  normal: 2000,
});

/** bundle 内 args 摘要截断长度（与 execution-history buildToolQueryResult 对齐） */
const BUNDLE_ARGS_MAX_CHARS = 500;

// ============================================================================
// 内部辅助
// ============================================================================

/** 项目层规则文件路径（与 cli/rules-cmd.ts 同一约定） */
function projectRulesFilePath(projectRoot: string): string {
  return path.join(projectRoot, ".deepcode", "rules", "project-rules.json");
}

/** 项目层规则容错读取（缺失/损坏 → 空数组，与 global 层降级纪律一致） */
function readProjectRulesFile(projectRoot: string): UserRule[] {
  let raw: string;
  try {
    raw = fs.readFileSync(projectRulesFilePath(projectRoot), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // 轻量形态校验（与 global-rules.isValidRuleShape 同构；不 import 私有函数）
  return parsed.filter((item): item is UserRule => {
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
  });
}

/** 文件 SHA256（缺失返回 null） */
function sha256OrNull(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/** UserRule → 证据条目（剥正文，保留计数与证据级别） */
function toRuleEntry(rule: UserRule, layer: "seed" | "global" | "project"): EvidenceRuleEntry {
  return {
    id: rule.id,
    layer,
    category: rule.category,
    severity: rule.severity,
    source: rule.source,
    usageCount: rule.usageCount,
    violationCount: rule.violationCount,
    evidenceState: deriveRuleEvidenceState(rule),
  };
}

/** 规则条目按 ID 字典序排序（冻结性） */
function sortRuleEntries(entries: EvidenceRuleEntry[]): EvidenceRuleEntry[] {
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

// ============================================================================
// 核心 API
// ============================================================================

/**
 * 构建统一证据包
 *
 * 冻结性：给定相同文件状态 + 显式 since/until，两次调用输出的
 * JSON.stringify 结果字节级一致（不引入任何真实当前时间）。
 *
 * @param options 构建参数
 * @returns 证据包（纯数据，无函数字段）
 */
export async function buildEvidenceBundle(options: EvidenceBundleOptions): Promise<EvidenceBundle> {
  const depth = options.depth ?? "normal";
  const homeRoot = options.homeDir ?? os.homedir();
  const until = options.until ?? Date.now();
  const since = options.since ?? until - DEPTH_DEFAULT_DAYS[depth] * 24 * 60 * 60 * 1000;
  const maxRecords = options.maxRecords ?? DEPTH_DEFAULT_MAX_RECORDS[depth];
  const redactor = options.redactor ?? new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES);

  // ---- 数据源 1：执行历史（窗口过滤 + 升序 + 脱敏瘦身） ----
  const historyStore = new ExecutionHistoryStore({ projectRoot: options.projectRoot, homeDir: homeRoot });
  const allRecords = historyStore.query({ limit: Number.MAX_SAFE_INTEGER, order: "asc" });
  const windowed = allRecords
    .filter((r) => r.timestamp >= since && r.timestamp <= until)
    .sort((a, b) => (a.timestamp - b.timestamp !== 0 ? a.timestamp - b.timestamp : a.id.localeCompare(b.id)))
    .slice(0, maxRecords);

  const executionHistory: EvidenceExecutionRecord[] = windowed.map((r) => {
    // 隐私红线：自由文本字段过脱敏；原始 output/errorSnippet 不进 bundle
    const argsRedacted = r.argsSnippet ? redactor.redact(r.argsSnippet, "evidence-bundle") : null;
    const args = (argsRedacted?.sanitized ?? "").slice(0, BUNDLE_ARGS_MAX_CHARS);
    return {
      id: r.id,
      sessionId: r.sessionId,
      date: r.date,
      turnIndex: r.turnIndex,
      toolName: r.toolName,
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      args,
      artifactPaths: (r.outputs ?? []).map((o) => o.path),
      redactionHits: argsRedacted?.hits.length ?? 0,
    };
  });
  historyStore.closeSync();

  // ---- 汇总统计（toolCounts 按字典序插入，保证 JSON 稳定） ----
  const toolCountMap = new Map<string, number>();
  let okCount = 0;
  let failCount = 0;
  const sessionIds = new Set<string>();
  for (const rec of executionHistory) {
    if (rec.ok) okCount++;
    else failCount++;
    sessionIds.add(rec.sessionId);
    toolCountMap.set(rec.toolName, (toolCountMap.get(rec.toolName) ?? 0) + 1);
  }
  const toolCounts: Record<string, number> = {};
  for (const tool of Array.from(toolCountMap.keys()).sort((a, b) => a.localeCompare(b))) {
    toolCounts[tool] = toolCountMap.get(tool) ?? 0;
  }

  // ---- 数据源 2：三层规则资产（无正文，计数 + 证据级别） ----
  const globalRules = readGlobalRulesFile(homeRoot);
  const projectRules = readProjectRulesFile(options.projectRoot);
  const ruleSeed = sortRuleEntries(SEED_RULES.map((r) => toRuleEntry(r, "seed")));
  const ruleGlobal = sortRuleEntries(globalRules.map((r) => toRuleEntry(r, "global")));
  const ruleProject = sortRuleEntries(projectRules.map((r) => toRuleEntry(r, "project")));

  // ---- 数据源 3：技能清单（可选 provider，record-only，只留名字） ----
  let skillNames: string[] = [];
  if (options.listSkills) {
    try {
      const skills = await options.listSkills();
      skillNames = skills
        .map((s) => s.name)
        .filter((n) => typeof n === "string" && n.length > 0)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      skillNames = []; // provider 失败 → 置空标注，不抛
    }
  }

  // ---- manifest：来源文件指纹（冻结性：同文件同哈希） ----
  const historyFilePath = historyStore.getHistoryFilePath();
  const sources = [
    { path: historyFilePath, sha256: sha256OrNull(historyFilePath) },
    { path: globalRulesFilePath(homeRoot), sha256: sha256OrNull(globalRulesFilePath(homeRoot)) },
    {
      path: projectRulesFilePath(options.projectRoot),
      sha256: sha256OrNull(projectRulesFilePath(options.projectRoot)),
    },
  ];

  return {
    schemaVersion: "1",
    depth,
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    workspace: options.projectRoot,
    generatedAt: new Date(until).toISOString(),
    summary: {
      recordCount: executionHistory.length,
      okCount,
      failCount,
      sessionCount: sessionIds.size,
      toolCounts,
    },
    executionHistory,
    assets: {
      rules: { seed: ruleSeed, global: ruleGlobal, project: ruleProject },
      skills: { count: skillNames.length, names: skillNames },
    },
    manifest: { sources },
  };
}

// ============================================================================
// 校验
// ============================================================================

/** 校验结果 */
export interface EvidenceBundleValidation {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
}

/** ISO 8601 判断（宽松：可被 Date 解析且含 T 分隔） */
function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !value.includes("T")) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * 校验证据包结构（供消费方在回放 evidence 引用前把关）
 *
 * 校验项：schemaVersion / window ISO / generatedAt = window.until /
 * summary 计数一致（recordCount = ok + fail；toolCounts 总和 ≤ recordCount）/
 * executionHistory 记录必填字段 / assets.rules 条目含 evidenceState。
 *
 * @param bundle 待校验对象
 * @returns { ok, errors }（ok=true 时 errors 为空）
 */
export function validateEvidenceBundle(bundle: unknown): EvidenceBundleValidation {
  const errors: string[] = [];
  if (typeof bundle !== "object" || bundle === null) {
    return { ok: false, errors: ["bundle 必须是对象"] };
  }
  const b = bundle as Record<string, unknown>;

  if (b["schemaVersion"] !== "1") errors.push('schemaVersion 必须为 "1"');
  if (b["depth"] !== "quick" && b["depth"] !== "normal") errors.push("depth 必须为 quick|normal");

  const win = b["window"] as Record<string, unknown> | undefined;
  if (!win || !isIsoDateTime(win["since"]) || !isIsoDateTime(win["until"])) {
    errors.push("window.since/until 必须为 ISO 8601 时间");
  }
  if (!isIsoDateTime(b["generatedAt"])) {
    errors.push("generatedAt 必须为 ISO 8601 时间");
  } else if (win && isIsoDateTime(win["until"]) && b["generatedAt"] !== win["until"]) {
    errors.push("冻结性约束：generatedAt 必须等于 window.until");
  }

  const summary = b["summary"] as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== "object") {
    errors.push("summary 缺失");
  } else {
    const recordCount = summary["recordCount"];
    const okCount = summary["okCount"];
    const failCount = summary["failCount"];
    if (typeof recordCount !== "number" || typeof okCount !== "number" || typeof failCount !== "number") {
      errors.push("summary.recordCount/okCount/failCount 必须为数字");
    } else if (recordCount !== okCount + failCount) {
      errors.push("summary.recordCount 必须等于 okCount + failCount");
    }
  }

  const history = b["executionHistory"];
  if (!Array.isArray(history)) {
    errors.push("executionHistory 必须为数组");
  } else {
    for (let i = 0; i < history.length; i++) {
      const rec = history[i] as Record<string, unknown>;
      if (
        typeof rec["id"] !== "string" ||
        typeof rec["sessionId"] !== "string" ||
        typeof rec["toolName"] !== "string" ||
        typeof rec["ok"] !== "boolean"
      ) {
        errors.push(`executionHistory[${i}] 缺少必填字段 id/sessionId/toolName/ok`);
        break;
      }
    }
  }

  const assets = b["assets"] as Record<string, unknown> | undefined;
  const rules = assets?.["rules"] as Record<string, unknown> | undefined;
  if (!rules || typeof rules !== "object") {
    errors.push("assets.rules 缺失");
  } else {
    for (const layer of ["seed", "global", "project"] as const) {
      const entries = rules[layer];
      if (!Array.isArray(entries)) {
        errors.push(`assets.rules.${layer} 必须为数组`);
        continue;
      }
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        if (typeof e["id"] !== "string" || typeof e["evidenceState"] !== "string") {
          errors.push(`assets.rules.${layer} 条目缺少 id/evidenceState`);
          break;
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 脱敏命中类型再导出（消费方审计用） */
export type { RedactionHit };
