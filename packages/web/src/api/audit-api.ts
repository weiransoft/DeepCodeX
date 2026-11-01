/**
 * EAG 工作流审计端点（设置抽屉「审计」页签，P6）：
 *
 * - GET /api/eag/audit → 聚合当前用户的规则使用证据（P1）、干预台账（P6）
 *   与确定性 Markdown 审计报告（report-render，同输入字节级一致）。
 *
 * 数据源与会话注入同源（复用 rules-api 的 engineHomeFor 逻辑）：
 * - 规则证据：readGlobalRulesFile(homeRoot) + deriveRuleEvidenceState（P1 record-only）；
 * - 干预台账：readLedger(homeRoot)（双读：.deepcodeX 新根优先，兼容 .deepcode 旧根）；
 * - 重复工作流发现（P5）为项目域数据（execution-history 按项目落盘），此处聚合
 *   用户域证据；项目域发现经 CLI `deepcode eag evidence-bundle` / core API 使用。
 *
 * 只读端点（record-only）：本端点不产生任何写副作用。
 */

import os from "node:os";
import type { ServerResponse } from "node:http";
import {
  deriveRuleEvidenceState,
  readGlobalRulesFile,
  readLedger,
  renderAuditReport,
  validateAuditReport,
  type LedgerEntry,
} from "@vegamo/deepcode-core";
import { sendJson } from "../http-utils";
import type { AuthContext } from "../user-identity";
import type { ResolvedWebSettings } from "../types";

/** GET /api/eag/audit 响应体 */
export type AuditResponse = {
  /** 规则使用证据（按 ruleId 排序） */
  rules: Array<{
    ruleId: string;
    evidenceState: string;
    usageCount: number;
    violationCount: number;
  }>;
  /** 干预台账条目（按 appliedAt 排序） */
  ledger: LedgerEntry[];
  /** 确定性 Markdown 审计报告（渲染器产物，结构经 validateAuditReport 自检） */
  report: string;
  /** 报告生成时间（服务端渲染时刻，ISO 8601） */
  generatedAt: string;
};

/**
 * 处理 GET /api/eag/audit（已认证）：聚合当前用户的规则证据与干预台账并渲染报告
 *
 * @param res 响应对象
 * @param resolved 归一后的 Web 配置
 * @param ctx 认证上下文
 */
export async function handleGetAudit(
  res: ServerResponse,
  resolved: ResolvedWebSettings,
  ctx: AuthContext
): Promise<void> {
  // 引擎数据家目录：与 rules-api / session-pool homeDir 注入逐字一致
  const effectiveHome = resolved.personalOnly ? `${resolved.engineHomeRoot}/${ctx.userId}` : os.homedir();

  // P1：规则使用证据（容错读：缺失/损坏 → 空规则列表）
  const rules = readGlobalRulesFile(effectiveHome).map((rule) => ({
    ruleId: rule.id,
    evidenceState: deriveRuleEvidenceState(rule),
    usageCount: rule.usageCount,
    violationCount: rule.violationCount,
  }));

  // P6：干预台账（双读单写兼容；本端点只读）
  const ledger = readLedger(effectiveHome);

  // 确定性渲染（LLM 不手写报告骨架；此处为纯服务端聚合，无 LLM 参与）
  const generatedAt = new Date().toISOString();
  const report = renderAuditReport({
    generatedAt,
    evidenceWindow: "用户域资产证据（规则注入与干预台账，全部历史窗口）",
    ruleEvidence: rules,
    ledgerEntries: ledger,
  });

  sendJson(res, 200, {
    rules,
    ledger,
    report,
    generatedAt,
    valid: validateAuditReport(report),
  } satisfies AuditResponse & { valid: boolean });
}
