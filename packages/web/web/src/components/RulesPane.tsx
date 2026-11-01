/**
 * 全局规则管理面板（设置抽屉「全局规则」页签）。
 *
 * 参考 Trae「Rules」与 WorkBuddy 的规则配置体验：
 * - 规则列表：严重级别徽标 + 正文 + 删除按钮（最高优先级在前）；
 * - 添加表单：正文输入 + 严重级别选择（BLOCKER / MAJOR / WARNING）；
 * - 数据经 /api/rules 增删查，存储与会话注入同源（global-rules.json），
 *   新建会话即生效（进行中会话保持创建时快照，与 Trae 行为一致）。
 *
 * 与 AgentsPane 相同的自包含 CRUD 模式：不走 SettingsDrawer 的 onSave
 * 统一落盘（desktop.json 与规则文件无关），操作即时生效。
 */
import { useCallback, useEffect, useState } from "react";
import { createRule, deleteRule, fetchRules, type GlobalRuleInfo } from "../api";

/** 严重级别展示配置：徽标文案 + CSS 修饰类 */
const SEVERITY_META: Record<string, { label: string; cls: string }> = {
  BLOCKER: { label: "BLOCKER", cls: "rules-badge-blocker" },
  MAJOR: { label: "MAJOR", cls: "rules-badge-major" },
  WARNING: { label: "WARNING", cls: "rules-badge-warning" },
};

/** 列表加载状态 */
type RulesState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; rules: GlobalRuleInfo[] };

/** 操作反馈（添加/删除结果提示，3 秒自动清除） */
type Feedback = { kind: "ok" | "error"; text: string } | null;

// 自包含 CRUD，无需外部 props（此前留了个空 interface，被 eslint 判为
// no-empty-object-type：空对象类型会放行 0、"" 等任意非空值，起不到约束作用）
export function RulesPane() {
  const [rules, setRules] = useState<RulesState>({ phase: "loading" });
  const [content, setContent] = useState("");
  const [severity, setSeverity] = useState("MAJOR");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const reload = useCallback(() => {
    setRules({ phase: "loading" });
    let cancelled = false;
    fetchRules()
      .then((data) => {
        if (!cancelled) setRules({ phase: "ready", rules: data.rules });
      })
      .catch((e: unknown) => {
        if (!cancelled) setRules({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  const showFeedback = (next: Feedback) => {
    setFeedback(next);
    if (next !== null) {
      window.setTimeout(() => setFeedback(null), 3000);
    }
  };

  const canSubmit = !submitting && content.trim() !== "";

  const handleAdd = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await createRule({ content, severity });
      setContent("");
      showFeedback({ kind: "ok", text: "规则已添加，新建会话即生效" });
      reload();
    } catch (e) {
      showFeedback({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteRule(id);
      showFeedback({ kind: "ok", text: `已删除 ${id}` });
      reload();
    } catch (e) {
      showFeedback({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDeletingId(null);
    }
  };

  // BLOCKER 在前（展示顺序与注入排序一致）
  const sorted =
    rules.phase === "ready"
      ? [...rules.rules].sort((a, b) => {
          const order = { BLOCKER: 0, MAJOR: 1, WARNING: 2 } as Record<string, number>;
          return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
        })
      : [];

  return (
    <div className="rules-pane">
      <div className="agents-section-title">全局规则</div>
      <p className="rules-hint">
        全局规则注入到每次<b>新建会话</b>的系统提示（进行中的会话保持原样），用于约束 AI
        的行为偏好，例如「始终使用中文回复」「禁止使用 var 声明变量」。与 CLI <code>/rules</code> 命令同一存储。
      </p>

      <div className="rules-form">
        <textarea
          className="rules-input"
          placeholder="输入规则内容，如：始终使用中文回复"
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              void handleAdd();
            }
          }}
        />
        <div className="rules-form-row">
          <select
            className="rules-severity-select"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            aria-label="严重级别"
          >
            <option value="BLOCKER">BLOCKER（必须遵守）</option>
            <option value="MAJOR">MAJOR（默认）</option>
            <option value="WARNING">WARNING（仅提示）</option>
          </select>
          <button type="button" className="cfg-btn" onClick={() => void handleAdd()} disabled={!canSubmit}>
            {submitting ? "添加中…" : "添加规则"}
          </button>
        </div>
        {feedback !== null && (
          <div className={feedback.kind === "ok" ? "rules-feedback-ok" : "rules-feedback-err"}>{feedback.text}</div>
        )}
      </div>

      {rules.phase === "loading" && <div className="rules-empty">正在加载规则…</div>}
      {rules.phase === "error" && <div className="rules-empty">加载失败：{rules.message}</div>}
      {rules.phase === "ready" && sorted.length === 0 && (
        <div className="rules-empty">暂无全局规则，添加第一条后对新建会话生效</div>
      )}
      {rules.phase === "ready" && sorted.length > 0 && (
        <div className="rules-list">
          {sorted.map((rule) => {
            const meta = SEVERITY_META[rule.severity] ?? { label: rule.severity, cls: "rules-badge-major" };
            return (
              <div key={rule.id} className="rules-item">
                <span className={"rules-badge " + meta.cls}>{meta.label}</span>
                <span className="rules-item-content">{rule.content}</span>
                <span className="rules-item-id">{rule.id}</span>
                <button
                  type="button"
                  className="rules-item-delete"
                  onClick={() => void handleDelete(rule.id)}
                  disabled={deletingId === rule.id}
                  aria-label={`删除规则 ${rule.id}`}
                  title="删除"
                >
                  {deletingId === rule.id ? "…" : "×"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
