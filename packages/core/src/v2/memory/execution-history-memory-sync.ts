/**
 * execution-history-memory-sync.ts — 执行历史 → V2 MemoryStore 回写 + 双向 metadata 打通（二期 US-EH-007/008）
 *
 * 核心职责：
 * 1. session 结束时（activateSession finally 块），将本 session 的成功命令 + 失败+修复对
 *    沉淀为 MemoryEntry{ type: "experience", source: "auto_extracted" }
 * 2. 双写 metadata：
 *    - MemoryEntry.metadata.executionRecordIds = [executionRecord.id]（一期可选字段）
 *
 * 调用时机：session.ts activateSession finally 块（PRD §6.2 B1）
 * 调用方式：try/catch 隔离，任何异常只 console.error 不 rethrow（不影响 session 正常结束）
 *
 * 依赖注入：store（ExecutionHistoryStore）+ memoryStore（MemoryStore）
 * —— MemoryEntry 必需字段：type / key / value / confidence / source（MemoryEntry interface 对齐）
 * —— MemoryStore.add 同步返回 MemoryEntry（不是 async，PRD §B3 经验教训：不要 mock/包装同步方法）
 *
 * Anchor 文件零改动：不依赖 executor/prompt/tool-types
 */

import type { ExecutionHistoryStore } from "./execution-history-store";
import type { ExecutionRecord } from "./execution-history-types";
import { ExecutionHistorySummaryBuilder } from "./execution-history-summary-builder";
import type { MemoryStore } from "./memory-store";
import type { MemoryEntry, MemorySource } from "./types";

/**
 * 默认 confidence（二期自动沉淀的经验，中等可信度 0.7）
 */
const DEFAULT_AUTO_CONFIDENCE = 0.7;

/** 二期自动沉淀的 MemoryEntry source 固定为 "auto_extracted" */
const AUTO_EXTRACTED_SOURCE: MemorySource = "auto_extracted";

/**
 * ExecutionHistoryMemorySync —— 执行历史 ↔ MemoryStore 双向同步器
 *
 * 二期 US-EH-007/008 的核心类：
 * - syncSession(sessionId) 是 session 结束 finally 块的唯一入口
 * - 内部走 SummaryBuilder.buildForMemory → MemoryStore.add
 * - MemoryEntry.metadata.executionRecordIds 存关联的 ExecutionRecord.id
 *
 * 注意：MemoryStore.add 是同步方法（MemoryEntry interface 对齐），不需要 await
 */
export class ExecutionHistoryMemorySync {
  private readonly store: ExecutionHistoryStore;
  private readonly memoryStore: MemoryStore;
  private readonly summaryBuilder: ExecutionHistorySummaryBuilder;

  constructor(historyStore: ExecutionHistoryStore, memoryStore: MemoryStore) {
    this.store = historyStore;
    this.memoryStore = memoryStore;
    this.summaryBuilder = ExecutionHistorySummaryBuilder.get();
  }

  /**
   * session 结束时调用——将本 session 执行历史沉淀为 MemoryStore experience
   * —— activateSession finally 块唯一入口
   * —— 内部全 try/catch 隔离，异常不 rethrow（PRD §6.2 B5）
   *
   * @param sessionId 刚结束的 session id
   * @returns 沉淀统计：成功命令数 + 失败+修复对数
   */
  syncSession(sessionId: string): { successCount: number; failureFixCount: number } {
    try {
      // 1. 从 ExecutionHistoryStore 取本 session 全部记录
      const records = this.store.query({ sessionId, order: "asc", limit: 500 });
      if (records.length === 0) {
        return { successCount: 0, failureFixCount: 0 };
      }

      // 2. SummaryBuilder.buildForMemory 分离成功 / 失败+修复对
      const { successEntries, failureFixPairs } = this.summaryBuilder.buildForMemory(records);

      let successCount = 0;
      let failureFixCount = 0;

      // 3. 成功命令沉淀
      for (const entry of successEntries) {
        try {
          const memoryEntry = this.upsertSuccessExperience(entry.record, entry.key);
          if (memoryEntry) successCount++;
        } catch (err) {
          console.error("[exec-history-sync] 成功命令沉淀失败:", err);
        }
      }

      // 4. 失败+修复对沉淀
      for (const pair of failureFixPairs) {
        try {
          const memoryEntry = this.upsertFailureFixExperience(pair.failure, pair.fix, pair.key);
          if (memoryEntry) failureFixCount++;
        } catch (err) {
          console.error("[exec-history-sync] 失败+修复对沉淀失败:", err);
        }
      }

      // 注意：不在这里调 store.closeSync()——session.dispose() 统一处理最终 flush
      // 双写 metadata.executionRecordIds 后直接返回沉淀统计
      return { successCount, failureFixCount };
    } catch (err) {
      console.error("[exec-history-sync] syncSession 整体失败:", err);
      return { successCount: 0, failureFixCount: 0 };
    }
  }

  // ========== 内部：MemoryEntry 写入 ==========

  /**
   * 成功命令 → upsert MemoryStore experience
   * —— 去重：MemoryStore.list({ type: "experience" }).entries 里找同 tags 的 entry
   * —— 已存在则 update（MemoryStore 没有 update，走 delete + add）
   */
  private upsertSuccessExperience(record: ExecutionRecord, dedupKey: string): MemoryEntry | null {
    // 去重：先查 MemoryStore.list 返回的 entries 数组
    const existing = this.findExperienceByDedupKey(dedupKey);
    const cmd = this.extractCommandShort(record);
    const key = `exec-history:bash-success:${dedupKey}`;
    const value = `bash ${cmd} 成功，exit ${record.exitCode ?? 0}`;

    if (existing) {
      // 已存在——删除 + 新建（加 usage 后缀表示积累次数）
      const prevUsage = (existing.metadata?.usageCount as number) ?? 1;
      const updatedValue = `${existing.value} | usage++ (total=${prevUsage + 1})`;
      this.memoryStore.delete(existing.id);
      return this.memoryStore.add({
        type: "experience",
        key,
        value: updatedValue,
        confidence: DEFAULT_AUTO_CONFIDENCE,
        source: AUTO_EXTRACTED_SOURCE,
        tags: existing.tags,
        metadata: {
          ...(existing.metadata ?? {}),
          executionRecordIds: [...((existing.metadata?.executionRecordIds as string[] | undefined) ?? []), record.id],
          // 运算符优先级修复：先 ?? 1 取默认值，再 + 1
          usageCount: prevUsage + 1,
        },
      });
    }

    return this.memoryStore.add({
      type: "experience",
      key,
      value,
      confidence: DEFAULT_AUTO_CONFIDENCE,
      source: AUTO_EXTRACTED_SOURCE,
      tags: ["auto-extracted", "exec-history", dedupKey],
      metadata: {
        executionRecordIds: [record.id],
        sessionId: record.sessionId,
        executionDate: record.date,
        usageCount: 1,
      },
    });
  }

  /**
   * 失败+修复对 → upsert MemoryStore experience
   */
  private upsertFailureFixExperience(
    failure: ExecutionRecord,
    fix: ExecutionRecord,
    dedupKey: string
  ): MemoryEntry | null {
    const existing = this.findExperienceByDedupKey(dedupKey);
    const key = `exec-history:failure-fix:${dedupKey}`;

    if (existing) {
      const prevIds = ((existing.metadata?.executionRecordIds as string[] | undefined) ?? []).filter(
        (id) => id !== failure.id
      );
      if (!prevIds.includes(failure.id)) prevIds.push(failure.id);
      if (!prevIds.includes(fix.id)) prevIds.push(fix.id);

      this.memoryStore.delete(existing.id);
      return this.memoryStore.add({
        type: "experience",
        key,
        value: existing.value,
        confidence: DEFAULT_AUTO_CONFIDENCE,
        source: AUTO_EXTRACTED_SOURCE,
        tags: existing.tags,
        metadata: {
          ...(existing.metadata ?? {}),
          executionRecordIds: prevIds,
          usageCount: ((existing.metadata?.usageCount as number) ?? 1) + 1,
        },
      });
    }

    const failCmd = this.extractCommandShort(failure);
    const fixCmd = this.extractCommandShort(fix);
    const value =
      `失败+修复对（exec-history 自动沉淀）:\n` +
      `- 失败: bash ${failCmd}，exit ${failure.exitCode ?? "?"} (${failure.errorSnippet ?? ""})\n` +
      `- 修复: ${fix.toolName} ${fixCmd} → exit ${fix.exitCode ?? 0}`;

    return this.memoryStore.add({
      type: "experience",
      key,
      value,
      confidence: DEFAULT_AUTO_CONFIDENCE,
      source: AUTO_EXTRACTED_SOURCE,
      tags: ["auto-extracted", "exec-history", dedupKey, "failure-fix"],
      metadata: {
        executionRecordIds: [failure.id, fix.id],
        fixedByExecutionId: fix.id,
        failureExitCode: failure.exitCode ?? null,
        sessionId: failure.sessionId,
        usageCount: 1,
      },
    });
  }

  /**
   * 去重查找：按 tags 里的 dedupKey 找到同一条 experience
   * —— MemoryStore.list 返回 MemoryListResult，.entries 是 MemoryEntry[]
   */
  private findExperienceByDedupKey(dedupKey: string): MemoryEntry | null {
    try {
      const listResult = this.memoryStore.list("experience");
      return listResult.entries.find((e) => e.tags?.includes(dedupKey)) ?? null;
    } catch {
      return null;
    }
  }

  /** 从 ExecutionRecord.argsSnippet 提取简短命令（最多 80 字符） */
  private extractCommandShort(record: ExecutionRecord): string {
    if (!record.argsSnippet) return record.toolName;
    try {
      const args = JSON.parse(record.argsSnippet);
      if (record.toolName === "bash" && typeof args.command === "string") {
        return args.command.slice(0, 80);
      }
      if ((record.toolName === "edit" || record.toolName === "write") && typeof args.filePath === "string") {
        return args.filePath.slice(0, 80);
      }
    } catch {
      // JSON.parse 失败 → fallback
    }
    return record.argsSnippet.slice(0, 80);
  }
}
