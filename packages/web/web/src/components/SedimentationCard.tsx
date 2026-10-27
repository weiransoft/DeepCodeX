/**
 * 沉淀建议卡片（ARCH-20261027 T05，PRD §5.3）：
 * 展示引擎沉淀分析产出的待处置建议——标题（Skill/Agent「名称」）+ 建议理由 +
 * 可折叠内容预览 + 确认落盘（可选用户级/项目级）/ 忽略。
 *
 * 确认成功后卡片转为「已沉淀 → 路径」只读态（resolvedPaths 由 App 持有，
 * 进程内存态；刷新后由后续轮次分析重新产出）。落盘安全（路径牢笼/同名拒写/
 * 白名单字段）全部由服务端 SedimentationWriter 五条门槛执行，前端仅展示结果。
 */
import { useState } from "react";
import type { SedimentationSuggestion } from "../chat-model";

/** SedimentationCard 组件属性 */
export interface SedimentationCardProps {
  /** 当前会话待处置建议列表（空数组不渲染） */
  suggestions: SedimentationSuggestion[];
  /** 已确认落盘的建议 id → 落盘路径（「已沉淀」只读态数据源） */
  resolvedPaths: Record<string, string>;
  /** 提交中的建议 id 集合（确认/忽略按钮禁用防连点） */
  submittingIds: Set<string>;
  /** 确认落盘（scope：user = 用户级 ~/.deepcode/skills；project = 会话项目级） */
  onConfirm: (suggestionId: string, scope: "user" | "project") => void;
  /** 忽略（本会话同指纹不再建议） */
  onDismiss: (suggestionId: string) => void;
}

/** 单条建议的落盘范围选项文案 */
const SCOPE_OPTIONS: Array<{ value: "user" | "project"; label: string }> = [
  { value: "user", label: "用户级（~/.deepcode/skills）" },
  { value: "project", label: "项目级（.deepcode/skills）" },
];

/** 单条建议卡片（确认/忽略交互 + 已沉淀只读态） */
function SuggestionItem({
  suggestion,
  resolvedPath,
  submitting,
  onConfirm,
  onDismiss,
}: {
  suggestion: SedimentationSuggestion;
  /** 已确认时的落盘路径（undefined = 待处置态） */
  resolvedPath: string | undefined;
  submitting: boolean;
  onConfirm: (suggestionId: string, scope: "user" | "project") => void;
  onDismiss: (suggestionId: string) => void;
}) {
  // 落盘范围选择（默认用户级，与 CLI /sediment-confirm 缺省一致）
  const [scope, setScope] = useState<"user" | "project">("user");
  const isAgent = suggestion.draft.kind === "agent";

  // 已沉淀只读态：绿色徽标 + 落盘路径（不再提供二次操作）
  if (resolvedPath !== undefined) {
    return (
      <section className="sediment-card sediment-card-resolved" aria-label="沉淀建议">
        <header className="sediment-card-head">
          <span className={`sediment-badge ${isAgent ? "sediment-badge-agent" : "sediment-badge-skill"}`}>
            {isAgent ? "Agent" : "Skill"}
          </span>
          <span className="sediment-card-title">{suggestion.draft.name}</span>
          <span className="sediment-resolved-badge">已沉淀</span>
        </header>
        <div className="sediment-resolved-path" title={resolvedPath}>
          已沉淀 → {resolvedPath}
        </div>
      </section>
    );
  }

  // 待处置态：标题 + 理由 + 可折叠预览 + 范围选择 + 确认/忽略
  return (
    <section className="sediment-card" aria-label="沉淀建议">
      <header className="sediment-card-head">
        <span className={`sediment-badge ${isAgent ? "sediment-badge-agent" : "sediment-badge-skill"}`}>
          {isAgent ? "Agent" : "Skill"}
        </span>
        <span className="sediment-card-title" title={suggestion.draft.name}>
          {suggestion.draft.name}
        </span>
        <span className="sediment-card-desc" title={suggestion.draft.description}>
          {suggestion.draft.description}
        </span>
      </header>
      <div className="sediment-card-rationale">{suggestion.rationale}</div>
      <details className="sediment-card-preview">
        <summary className="sediment-card-preview-summary">预览内容</summary>
        <pre className="sediment-card-preview-pre">{suggestion.draft.content}</pre>
      </details>
      <footer className="sediment-card-actions">
        <select
          className="sediment-scope-select"
          value={scope}
          onChange={(e) => setScope(e.target.value === "project" ? "project" : "user")}
          title="选择落盘范围"
        >
          {SCOPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="sediment-confirm-btn"
          disabled={submitting}
          onClick={() => onConfirm(suggestion.id, scope)}
        >
          确认沉淀
        </button>
        <button
          type="button"
          className="sediment-dismiss-btn"
          disabled={submitting}
          onClick={() => onDismiss(suggestion.id)}
        >
          忽略
        </button>
      </footer>
    </section>
  );
}

/** SedimentationCard：当前会话沉淀建议卡片区（无建议时不渲染） */
export function SedimentationCard(props: SedimentationCardProps) {
  const { suggestions, resolvedPaths, submittingIds, onConfirm, onDismiss } = props;
  if (suggestions.length === 0) return null;
  return (
    <div className="sediment-region" aria-label="沉淀建议">
      {suggestions.map((s) => (
        <SuggestionItem
          key={s.id}
          suggestion={s}
          resolvedPath={resolvedPaths[s.id]}
          submitting={submittingIds.has(s.id)}
          onConfirm={onConfirm}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
