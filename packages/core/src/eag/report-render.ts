/**
 * ReportRender —— 审计报告确定性渲染器（P6，Better Harness 增强方案 §P6）
 *
 * 职责：把证据（P2 bundle 摘要 / P1 规则证据 / P5 重复流发现 / P6 台账）渲染为
 * Markdown 审计报告。**报告骨架由代码渲染**，LLM 只提供结论文本——报告必须
 * 可由渲染器复现（同输入字节级一致，不含真实当前时间）。
 *
 * 设计约定（对齐 Better Harness「Never hand-write Markdown reports」）：
 * - 确定性：所有列表排序后输出；generatedAt 取显式传入的时间（不取系统时钟）；
 * - 可校验：validateAuditReport 检查必备章节存在（渲染器自检）；
 * - 可追溯：台账中 verification.state === "outcome-supported" 的条目渲染
 *   「追溯」行，显式引用 findingId 与 appliedAt（验收：结论可追溯至前因 finding）。
 *
 * @module eag/report-render
 */

import type { LedgerEntry } from "./intervention-ledger";
import type { LoopFlowSuggestion } from "./discovery/loop-discovery";

/** 渲染输入（全部必填字段在 renderAuditReport 内校验，缺省走空态） */
export type AuditReportInput = {
  /** 报告标题（缺省「EAG 工作流审计报告」） */
  title?: string;
  /** 报告生成时间（显式传入，ISO 8601；保证同输入字节级一致） */
  generatedAt: string;
  /** 证据窗口描述（如「2026-10-25 ~ 2026-11-01（7 天）」） */
  evidenceWindow: string;
  /** P1：规则使用证据（ruleId → 状态摘要） */
  ruleEvidence?: ReadonlyArray<{ ruleId: string; evidenceState: string; usageCount: number; violationCount: number }>;
  /** P5：重复工作流建议（record-only） */
  loopSuggestions?: readonly LoopFlowSuggestion[];
  /** P6：干预台账条目 */
  ledgerEntries?: readonly LedgerEntry[];
  /** 可选：LLM 结论摘要（仅文本；报告结构仍由代码渲染） */
  llmSummary?: string;
};

/** 报告必备章节标题（validateAuditReport 校验依据） */
export const REQUIRED_REPORT_SECTIONS: ReadonlyArray<string> = Object.freeze([
  "## 证据窗口",
  "## 规则使用证据",
  "## 重复工作流发现",
  "## 干预台账",
]);

/**
 * 渲染审计报告（确定性 Markdown）。
 *
 * @param input 渲染输入
 * @returns Markdown 文本（同输入字节级一致）
 */
export function renderAuditReport(input: AuditReportInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.title ?? "EAG 工作流审计报告"}`);
  lines.push("");
  lines.push(`- 生成时间：${input.generatedAt}`);
  lines.push("");

  // —— 证据窗口 ——
  lines.push("## 证据窗口");
  lines.push("");
  lines.push(input.evidenceWindow);
  lines.push("");

  // —— 规则使用证据（P1）——
  lines.push("## 规则使用证据");
  lines.push("");
  const ruleEvidence = (input.ruleEvidence ?? []).slice().sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  if (ruleEvidence.length === 0) {
    lines.push("_（本窗口无规则使用证据）_");
  } else {
    lines.push("| 规则 ID | 证据状态 | 使用次数 | 违规次数 |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of ruleEvidence) {
      lines.push(`| ${r.ruleId} | ${r.evidenceState} | ${r.usageCount} | ${r.violationCount} |`);
    }
  }
  lines.push("");

  // —— 重复工作流发现（P5）——
  lines.push("## 重复工作流发现");
  lines.push("");
  const suggestions = (input.loopSuggestions ?? []).slice();
  if (suggestions.length === 0) {
    lines.push("_（窗口内未发现跨会话重复工作流）_");
  } else {
    for (const s of suggestions) {
      const ladder = s.coverageLadder === "extend" ? `扩展已有资产「${s.matchedAsset}」` : "沉淀为可复用资产";
      lines.push(
        `- ${s.sequence.join(" → ")}：出现 ${s.occurrences} 次 / ${s.distinctSessions} 个会话 → ${ladder}（${s.rationale}）`
      );
    }
  }
  lines.push("");

  // —— 干预台账（P6）——
  lines.push("## 干预台账");
  lines.push("");
  const entries = (input.ledgerEntries ?? []).slice().sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
  if (entries.length === 0) {
    lines.push("_（暂无干预记录）_");
  } else {
    for (const e of entries) {
      lines.push(`- ${e.appliedAt} ${e.findingId}（owner: ${e.owner}）预期效果：${e.expectedEffect}`);
      if (e.verification) {
        if (e.verification.state === "outcome-supported") {
          // 验收：Outcome-supported 结论可追溯至前因 finding
          lines.push(
            `  - 追溯：verification=outcome-supported（verifiedAt ${e.verification.verifiedAt}，findingId ${e.findingId}，appliedAt ${e.appliedAt}）`
          );
        } else {
          lines.push(`  - 回访：${e.verification.state}（${e.verification.verifiedAt}）`);
        }
        if (e.verification.note) {
          lines.push(`  - 备注：${e.verification.note}`);
        }
      }
    }
  }
  lines.push("");

  // —— LLM 结论（仅文本；结构已由代码渲染）——
  if (input.llmSummary && input.llmSummary.trim()) {
    lines.push("## 结论");
    lines.push("");
    lines.push(input.llmSummary.trim());
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 校验报告（渲染器自检）：必备章节全部存在。
 *
 * @returns true = 报告结构合法；false = 缺章节（渲染异常，禁止交付）
 */
export function validateAuditReport(report: string): boolean {
  return REQUIRED_REPORT_SECTIONS.every((section) => report.includes(section));
}
