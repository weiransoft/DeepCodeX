/**
 * 审计面板（设置抽屉「审计」页签，P6）：
 *
 * 只读展示 EAG 工作流审计聚合（GET /api/eag/audit）：
 * - 规则使用证据表（规则 ID / 证据状态 / 使用次数 / 违规次数，P1 record-only）；
 * - 干预台账列表（P6，含 Outcome-supported 追溯）；
 * - 确定性 Markdown 审计报告原文（渲染器产物，可复制存档）。
 */
import { useEffect, useState } from "react";
import { fetchAudit, type AuditInfo } from "../api";

/** 加载状态 */
type AuditState = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: AuditInfo };

/** 证据状态中文标签 */
const EVIDENCE_LABELS: Record<string, string> = {
  present: "已配置",
  wired: "已接入",
  exercised: "已使用",
  "outcome-supported": "已佐证",
};

export function AuditPane() {
  const [state, setState] = useState<AuditState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchAudit()
      .then((data) => {
        if (!cancelled) setState({ phase: "ready", data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="skills-list">
        <div className="skills-empty">正在聚合审计证据…</div>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="skills-list">
        <div className="skills-empty">审计聚合失败：{state.message}</div>
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="skills-list">
      <p className="skills-hint">
        审计数据全部来自证据（record-only）：规则证据在注入/违规时自动记录；干预台账在建议实施后登记。
        报告由渲染器确定性生成，可复制存档。
      </p>

      <h3 className="audit-section-title">规则使用证据（{data.rules.length}）</h3>
      {data.rules.length === 0 ? (
        <div className="skills-empty">暂无规则证据（在「全局规则」页签添加规则并新建会话后出现）</div>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>规则 ID</th>
              <th>证据状态</th>
              <th>使用次数</th>
              <th>违规次数</th>
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.ruleId}>
                <td>{r.ruleId}</td>
                <td>{EVIDENCE_LABELS[r.evidenceState] ?? r.evidenceState}</td>
                <td>{r.usageCount}</td>
                <td>{r.violationCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="audit-section-title">干预台账（{data.ledger.length}）</h3>
      {data.ledger.length === 0 ? (
        <div className="skills-empty">暂无干预记录</div>
      ) : (
        <div className="audit-ledger">
          {data.ledger.map((e, i) => (
            <div key={`${e.findingId}-${e.appliedAt}-${i}`} className="audit-ledger-item">
              <div className="audit-ledger-head">
                <span className="audit-ledger-id">{e.findingId}</span>
                <span className="audit-ledger-time">{e.appliedAt}</span>
                <span className="audit-ledger-owner">owner: {e.owner}</span>
              </div>
              <div className="audit-ledger-effect">预期效果：{e.expectedEffect}</div>
              {e.verification && (
                <div className="audit-ledger-verify">
                  回访：{e.verification.state}（{e.verification.verifiedAt}）
                  {e.verification.note ? ` — ${e.verification.note}` : ""}
                  {e.verification.state === "outcome-supported" && " ⟵ 可追溯至前因 finding"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h3 className="audit-section-title">审计报告</h3>
      <pre className="audit-report">{data.report}</pre>
    </div>
  );
}
