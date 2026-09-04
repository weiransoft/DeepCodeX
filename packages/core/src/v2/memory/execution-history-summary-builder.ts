/**
 * execution-history-summary-builder.ts — 执行历史摘要构建器（二期 US-EH-006）
 *
 * 核心职责：将 ExecutionHistoryStore 中大量原始执行记录，按任务类型过滤、
 * 失败+修复对识别、黑名单过滤、token 估算+硬上限截断后，产出可注入 V2 上下文的
 * execution_history ContextSnippet。
 *
 * 两条构建路径：
 * 1. buildForContext(taskType) —— 注入 V2 上下文用（US-EH-006）
 *    产出：ExecutionHistorySummary → ContextSnippet
 *    过滤：taskType 匹配 + ok=true 的成功命令 + ok=false 且后续有修复的失败+修复对
 *    硬上限：totalTokens ≤ 2000，超限截断最旧记录
 * 2. buildForMemory(records) —— 沉淀 MemoryStore experience 用（US-EH-007）
 *    产出：success_entries[] + failure_fix_pairs[]
 *    过滤：黑名单命令（LOW_VALUE_BASH_COMMANDS）不沉淀
 *
 * 设计依据：
 * - PRD §US-EH-006 验收标准 A1~A7
 * - PRD §US-EH-007 验收标准 B1~B6
 * - 经验教训 1190232 failure：绝对不新增 system 消息——本模块只返回数据，
 *   注入由 dual-layer-manager 的 4.6 块统一走 ContextSnippet 管线
 *
 * Anchor 文件零改动：本模块不依赖 executor.ts / prompt.ts / tool-types.ts
 */

import { LOW_VALUE_BASH_COMMANDS } from "./execution-history-types";
import type { ExecutionHistoryStore } from "./execution-history-store";
import type { ExecutionHistoryQuery, ExecutionRecord } from "./execution-history-types";

/** 任务类型（对齐 PRD §6.1 A3） */
export type ExecutionTaskType = "build" | "test" | "fix" | "deploy" | "general";

/**
 * SummaryBuilder 内部 entry 类型——从 ExecutionRecord 提取的简短摘要
 * —— 定义在此而非 types.ts：二期内部用，不对外暴露
 */
type SummaryEntry = {
  /** 触发的命令（简短） */
  trigger: string;
  /** 结果（"ok: exit 0" / "fail→fix: ... → exit 0"） */
  result: string;
  /** 关联的 sessionId（可选） */
  sessionLabel?: string;
  /** 发生日期（YYYY-MM-DD） */
  date: string;
  /** 估算 token 数 */
  estTokens: number;
};

/** 二期 V2 上下文硬上限：execution_history snippet 总 tokens ≤ 2000 */
const MAX_SNIPPET_TOKENS = 2000;
/** 每条 summary entry 最大字符数（token ≈ 4 chars） */
const MAX_ENTRY_CHARS = 800;
/** token 估算系数：1 token ≈ 4 字符（近似，对齐 prompt.ts 粗估风格） */
const CHARS_PER_TOKEN = 4;

// ========== taskType → ExecutionHistoryQuery 映射 ==========
/**
 * 根据 taskType 推断相关的 toolName 关键词——用于 SummaryBuilder 过滤
 * general = 不限 toolName
 */
function buildQueryForTaskType(taskType: ExecutionTaskType): ExecutionHistoryQuery {
  // 默认查最近 30 天（PRD §6.1 A3）
  const query: ExecutionHistoryQuery = { lastDays: 30, limit: 200, order: "desc" };

  switch (taskType) {
    case "build":
    case "test":
    case "deploy":
      // 构建/测试/部署 → 只看 bash 工具（最常见的执行入口）
      query.toolName = "bash";
      break;
    case "fix":
      // 修复 → 不限工具（bash + edit 都有价值）
      break;
    case "general":
    default:
      // general → 不限
      break;
  }
  return query;
}

// ========== 黑名单过滤 ==========
/**
 * 判断一条记录是否属于"低价值"（如 echo/ls/cat/pwd 等，不沉淀到 MemoryStore）
 * —— 一期/二期共用（PRD 黑名单策略）
 * —— toolName != "bash" 的默认不是低价值（write/edit/skill 都有业务价值）
 */
export function isLowValueRecord(record: ExecutionRecord): boolean {
  if (record.toolName !== "bash") return false;
  if (!record.argsSnippet) return false;
  // 从 argsSnippet 里提取第一个命令词（JSON.parse 解析失败时 fallback 到 substring）
  let cmd = "";
  try {
    const args = JSON.parse(record.argsSnippet);
    cmd = args.command ?? "";
  } catch {
    // fallback：直接看 argsSnippet 开头有没有黑名单词
    cmd = record.argsSnippet.slice(0, 50);
  }
  if (!cmd) return false;
  // 取命令第一个词（shell 命令格式：<cmd> [args...]）
  const firstWord = cmd.trim().split(/\s+/)[0].toLowerCase();
  return LOW_VALUE_BASH_COMMANDS.has(firstWord);
}

// ========== 成功/失败过滤 ==========
/**
 * 判断一条记录是否是"有价值的成功"——ok=true 且非黑名单
 */
function isValuableSuccess(record: ExecutionRecord): boolean {
  return record.ok && !isLowValueRecord(record);
}

/**
 * 判断一条记录是否是"失败+修复对"的前半段——ok=false 且同 session 内后续有修复记录
 * 保守判定（PRD §6.2 B3）：
 * - 同 sessionId
 * - 时间差 < 10 分钟
 * - 修复操作是 edit/write（改文件）或 ok=true 的 bash（执行 fix）
 */
function findFailureFixPairs(records: ExecutionRecord[]): Array<{
  failure: ExecutionRecord;
  fix: ExecutionRecord;
}> {
  const pairs: Array<{ failure: ExecutionRecord; fix: ExecutionRecord }> = [];
  const sessionMap = new Map<string, ExecutionRecord[]>();

  for (const r of records) {
    if (!sessionMap.has(r.sessionId)) sessionMap.set(r.sessionId, []);
    sessionMap.get(r.sessionId)!.push(r);
  }

  for (const [, sessionRecords] of sessionMap) {
    // 按 timestamp 排序
    const sorted = [...sessionRecords].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sorted.length; i++) {
      const rec = sorted[i];
      if (rec.ok) continue; // 只关心失败记录
      if (isLowValueRecord(rec)) continue; // 黑名单跳过

      // 向后找修复（最多看 5 条、时间差 < 10 分钟）
      const tenMinMs = 10 * 60 * 1000;
      for (let j = i + 1; j < Math.min(i + 6, sorted.length); j++) {
        const next = sorted[j];
        if (next.timestamp - rec.timestamp > tenMinMs) break; // 超时间窗

        // 修复操作：edit/write（改文件）或 ok=true 的 bash（跑 fix）
        if (next.toolName === "edit" || next.toolName === "write" || (next.toolName === "bash" && next.ok)) {
          pairs.push({ failure: rec, fix: next });
          break; // 只认最近一个修复
        }
      }
    }
  }

  return pairs;
}

// ========== 主构建函数 ==========

/**
 * 二期 SummaryBuilder —— 执行历史摘要构建器
 *
 * 纯函数风格（无状态）：所有方法接收 ExecutionHistoryStore + 过滤参数，
 * 返回纯数据，不修改 store / MemoryStore。memory-sync.ts 负责写回。
 */
export class ExecutionHistorySummaryBuilder {
  // 单例模式——与 store 解耦，纯逻辑构建器
  private static instance: ExecutionHistorySummaryBuilder | null = null;
  static get(): ExecutionHistorySummaryBuilder {
    if (!this.instance) this.instance = new ExecutionHistorySummaryBuilder();
    return this.instance;
  }

  /**
   * US-EH-006：构建 V2 上下文注入用的 summary entries
   *
   * 过滤策略（对齐 PRD §6.1 A3/A4/A5）：
   * 1. 按 taskType 推断 query（如 build → 只查 bash）
   * 2. 保留：ok=true 的有价值成功命令 + ok=false 且后续有修复的失败+修复对
   * 3. 按 timestamp desc 排序（最新在前）
   * 4. 估算 token → 总 token ≤ 2000，超限截断最旧记录
   *
   * @param store 执行历史存储
   * @param taskType 当前任务类型（影响过滤策略）
   * @returns 带总 token 数的 entries 数组
   */
  buildForContext(
    store: ExecutionHistoryStore,
    taskType: ExecutionTaskType = "general"
  ): {
    entries: SummaryEntry[];
    totalTokens: number;
  } {
    const query = buildQueryForTaskType(taskType);
    const rawRecords = store.query(query);
    if (rawRecords.length === 0) {
      return { entries: [], totalTokens: 0 };
    }

    // 分离：成功 vs 失败
    const successes = rawRecords.filter(isValuableSuccess);

    // 失败+修复对
    const pairs = findFailureFixPairs(rawRecords);
    const failedWithFix = pairs.map((p) => p.failure.id); // 拿到"已被修复"的失败记录 id

    // 失败记录（有修复才纳入）
    const failures = rawRecords.filter((r) => !r.ok && !isLowValueRecord(r) && failedWithFix.includes(r.id));

    // 构建 entries（成功 + 失败+修复对 都进 entries）
    // 失败+修复对需要特殊标记
    const pairMap = new Map(pairs.map((p) => [p.failure.id, p.fix]));

    const rawEntries: SummaryEntry[] = [...successes, ...failures]
      .sort((a, b) => b.timestamp - a.timestamp) // 最新在前
      .map((r) => this.recordToEntry(r, pairMap.get(r.id)));

    // 硬上限 2000 tokens——从前往后累加，超了就截断后面（后面是最旧）
    const { entries, totalTokens } = this.enforceTokenBudget(rawEntries, MAX_SNIPPET_TOKENS);

    return { entries, totalTokens };
  }

  /**
   * 将 ExecutionRecord 转为 summary entry
   * —— 失败+修复对里 fix 参数非空时，result 描述里体现"fail→fix"
   */
  private recordToEntry(record: ExecutionRecord, fix?: ExecutionRecord): SummaryEntry {
    const cmd = this.extractCommand(record);

    let result: string;
    if (fix) {
      result = `fail: exit ${record.exitCode ?? "?"} → fix via ${fix.toolName} → ${
        fix.ok ? "exit 0" : `exit ${fix.exitCode ?? "?"}`
      }`;
    } else if (record.ok) {
      result = `ok: exit ${record.exitCode ?? 0}`;
    } else {
      result = `fail: exit ${record.exitCode ?? "?"}`;
    }

    const estTokens = Math.ceil((cmd.length + result.length) / CHARS_PER_TOKEN);

    return {
      trigger: cmd.slice(0, 200),
      result: result.slice(0, 200),
      sessionLabel: record.sessionId,
      date: record.date,
      estTokens: Math.min(estTokens, 100), // 单条上限 100 tokens
    };
  }

  /**
   * 从 ExecutionRecord.argsSnippet 提取命令文本
   * —— bash：从 JSON args 里拿 command 字段
   * —— edit/write：从 args 里拿 filePath 或 search 描述
   */
  private extractCommand(record: ExecutionRecord): string {
    if (!record.argsSnippet) return record.toolName;

    try {
      const args = JSON.parse(record.argsSnippet);
      if (record.toolName === "bash" && typeof args.command === "string") {
        return args.command;
      }
      if ((record.toolName === "edit" || record.toolName === "write") && typeof args.filePath === "string") {
        return `${record.toolName} ${args.filePath}`;
      }
    } catch {
      // JSON.parse 失败 → fallback 到 argsSnippet 前 200 字符
    }
    return `${record.toolName}: ${record.argsSnippet.slice(0, 100)}`;
  }

  /**
   * 硬上限 token 预算——从最新开始累加，超了就截断最旧
   * —— entries 按 timestamp desc 排序（最新在前），所以截断发生在末尾（最旧）
   */
  private enforceTokenBudget(
    entries: SummaryEntry[],
    maxTokens: number
  ): { entries: SummaryEntry[]; totalTokens: number } {
    const result: SummaryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
      if (used + entry.estTokens > maxTokens) break;
      result.push(entry);
      used += entry.estTokens;
    }
    return { entries: result, totalTokens: used };
  }

  // ========== US-EH-007：MemoryStore 沉淀路径 ==========

  /**
   * US-EH-007：为 MemoryStore 沉淀准备数据
   * —— 输入是某 session 的所有执行记录，输出 successEntries + failureFixPairs
   * —— 黑名单命令（LOW_VALUE_BASH_COMMANDS）不纳入任何一类
   */
  buildForMemory(records: ExecutionRecord[]): {
    successEntries: Array<{ record: ExecutionRecord; key: string }>;
    failureFixPairs: Array<{ failure: ExecutionRecord; fix: ExecutionRecord; key: string }>;
  } {
    const successes = records.filter(isValuableSuccess);
    const pairs = findFailureFixPairs(records);

    // 为每条生成稳定的 key（用于 MemoryStore 去重——60 天内相同 key 合并）
    const successEntries = successes.map((r) => ({
      record: r,
      key: this.buildSuccessKey(r),
    }));

    const failureFixPairs = pairs.map((p) => ({
      failure: p.failure,
      fix: p.fix,
      key: this.buildFailureFixKey(p.failure, p.fix),
    }));

    return { successEntries, failureFixPairs };
  }

  /**
   * 生成成功命令的去重 key
   * 格式："success:{toolName}:{firstWordOfCommand}"
   */
  private buildSuccessKey(record: ExecutionRecord): string {
    const cmd = this.extractCommand(record);
    const firstWord = cmd.split(/\s+/)[0];
    return `success:${record.toolName}:${firstWord}`;
  }

  /**
   * 生成失败+修复对的去重 key
   * 格式："fix:{failedCmdFirstWord}→{fixToolName}"
   */
  private buildFailureFixKey(failure: ExecutionRecord, fix: ExecutionRecord): string {
    const failCmd = this.extractCommand(failure).split(/\s+/)[0];
    return `fix:${failCmd}→${fix.toolName}`;
  }
}
