/**
 * 「司南」页签 —— 常驻主理智能体的人格与分类记忆
 *
 * ## 为什么把这个面板放进系统管理
 *
 * 人格不是设置项，但**记忆必须是可见、可改、可删的设置项**。用户需要能回答：
 * 「它到底记住了什么？」「这条过期了怎么删？」「凭证会不会被发到模型里？」
 * 一个只有「记住」没有「查看/删除」的记忆系统，本质是个黑盒。
 *
 * ## 三个刻意的展示选择
 *
 * 1. **凭证显示遮蔽串**：后端只下发 `******`，前端也没有明文可显示——
 *    这不是遮丑，是让「值没离开本机」这件事在界面上可见；
 * 2. **未记录类别单独列出**：空分类不是「没数据」，而是「它还不知道」，
 *    明确标出来才能驱动用户补一句；
 * 3. **提示词预览可展开**：界面显示的记忆顺序与模型实际看到的一致
 *    （同一套召回逻辑），核对时不必凭记忆猜。
 *
 * ## 为什么拆成 SoulPane + SoulView
 *
 * `SoulPane` 管取数与提交，`SoulView` 是纯展示（全部通过 props 传入）。
 * 拆开的唯一理由是可测：SSR 渲染不跑 effect，整块组件只能测到「正在读取」，
 * 等于没测。拆开后 `SoulView` 可以用固定快照直接断言。
 *
 * @module web/components/SoulPane
 */

import { useCallback, useEffect, useState } from "react";
import { fetchSoul, forgetSoul, rememberSoul, type SoulResponse, type SoulSnapshot } from "../api";
import { SoulAppearancePane } from "./SoulAppearancePane";

/** 加载状态 */
type LoadState = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: SoulResponse };

/** 提交状态 */
export type SubmitState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "ok"; message: string }
  | { phase: "failed"; message: string };

/** 分类条目（后端下发，前端只展示） */
export interface SoulCategory {
  id: string;
  label: string;
  hint: string;
}

/** 记忆文件位置 */
export interface SoulLocations {
  global: string;
  project?: string;
}

/**
 * 百分比条
 *
 * @param props 标签与 0~1 数值
 */
function Meter({ label, value }: { label: string; value: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="soul-meter">
      <span className="soul-meter-label">{label}</span>
      <span className="soul-meter-track">
        <span className="soul-meter-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="soul-meter-value">{percent}</span>
    </div>
  );
}

/** 决策风格中文名（与后端 `decisionLabel` 同口径，仅用于展示） */
function decisionStyleLabel(style: string): string {
  const map: Record<string, string> = {
    QUICK: "要快：先能跑起来再优化",
    DEEP_ANALYSIS: "要深：愿为准确性多花时间",
    COLLABORATIVE: "要共识：倾向讨论后再定",
    DATA_DRIVEN: "要数据：结论必须有依据",
    INTUITIVE: "看感觉：重视方案的味道",
  };
  return map[style] ?? style;
}

/** SoulView 属性（纯展示，无副作用） */
export interface SoulViewProps {
  /** 人格与记忆快照 */
  snapshot: SoulSnapshot;
  /** 分类清单 */
  categories: SoulCategory[];
  /** 记忆文件位置 */
  locations: SoulLocations | null;
  /** 待提交的正文 */
  text: string;
  /** 选中的分类（空串 = 自动判断） */
  category: string;
  /** 提交状态 */
  submit: SubmitState;
  /** 正文变化 */
  onTextChange: (value: string) => void;
  /** 分类变化 */
  onCategoryChange: (value: string) => void;
  /** 记住 */
  onRemember: () => void;
  /** 忘掉 */
  onForget: (id: string) => void;
}

/**
 * 司南面板（纯展示）
 *
 * @param props 见 {@link SoulViewProps}
 */
export function SoulView(props: SoulViewProps) {
  const { snapshot, categories, locations, text, category, submit } = props;

  const missingLabels = snapshot.memoryStats.missing
    .map((id) => categories.find((item) => item.id === id)?.label ?? id)
    .join("、");

  return (
    <div className="soul-pane">
      {/* 身份 */}
      <header className="soul-header">
        <div className="soul-name">
          {snapshot.name.primary}
          {snapshot.name.latin !== undefined && <span className="soul-name-latin">{snapshot.name.latin}</span>}
        </div>
        <div className="soul-signature">{snapshot.signature}</div>
        <div className="soul-tagline">{snapshot.tagline}</div>
        <div className="soul-badges">
          <span className="soul-badge">{snapshot.mbti}</span>
          <span className="soul-badge">语气：{snapshot.emotion.label}</span>
          <span className="soul-badge">记忆 {snapshot.memoryStats.total} 条</span>
        </div>
      </header>

      {/* 核心本质 */}
      <section className="soul-section">
        <h4>核心本质（不变的那一层）</h4>
        <p className="soul-text">{snapshot.nature}。</p>
        <p className="soul-text soul-text-muted">使命：{snapshot.purpose}。</p>
        <ul className="soul-list">
          {snapshot.coreBeliefs.map((belief) => (
            <li key={belief}>{belief}</li>
          ))}
        </ul>
        <details className="soul-details">
          <summary>绝不做的事（{snapshot.boundaries.length}）</summary>
          <ul className="soul-list">
            {snapshot.boundaries.map((boundary) => (
              <li key={boundary}>{boundary}</li>
            ))}
          </ul>
        </details>
      </section>

      {/* 人格倾向 */}
      <section className="soul-section">
        <h4>人格倾向</h4>
        <div className="soul-meters">
          <Meter label="开放性" value={snapshot.ocean.openness} />
          <Meter label="尽责性" value={snapshot.ocean.conscientiousness} />
          <Meter label="外向性" value={snapshot.ocean.extraversion} />
          <Meter label="宜人性" value={snapshot.ocean.agreeableness} />
          <Meter label="神经质" value={snapshot.ocean.neuroticism} />
        </div>
        {snapshot.values.length > 0 && (
          <p className="soul-text soul-text-muted">
            价值观优先级：{snapshot.values.map((item) => `${item.name}(${item.priority})`).join(" > ")}
          </p>
        )}
        {snapshot.expression.catchphrases.length > 0 && (
          <p className="soul-text soul-text-muted">
            口头禅（一轮最多一次）：{snapshot.expression.catchphrases.map((phrase) => `「${phrase}」`).join("、")}
          </p>
        )}
      </section>

      {/* 用户画像 */}
      <section className="soul-section">
        <h4>它怎么服务你</h4>
        <p className="soul-text soul-text-muted">决策风格：{decisionStyleLabel(snapshot.user.decisionStyle)}</p>
        <p className="soul-text soul-text-muted">汇报偏好：{snapshot.user.reportingPreference}</p>
        {snapshot.user.communicationPreferences.length > 0 && (
          <ul className="soul-list">
            {snapshot.user.communicationPreferences.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </section>

      {/* 记忆 */}
      <section className="soul-section">
        <h4>记忆（按类归组，模型看到的顺序与此一致）</h4>

        <div className="soul-remember">
          <input
            className="soul-remember-input"
            placeholder="记一条：项目地址 / 部署位置与形式 / 常用凭证 / 代码规范…"
            value={text}
            onChange={(event) => props.onTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") props.onRemember();
            }}
          />
          <select
            className="soul-remember-select"
            value={category}
            onChange={(event) => props.onCategoryChange(event.target.value)}
            title="分类（留空则按关键词自动判断）"
          >
            <option value="">自动判断</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ssh-btn-secondary"
            onClick={props.onRemember}
            disabled={text.trim().length === 0 || submit.phase === "saving"}
          >
            {submit.phase === "saving" ? "记录中…" : "记住"}
          </button>
        </div>

        {submit.phase === "ok" && <div className="soul-hint soul-hint-ok">{submit.message}</div>}
        {submit.phase === "failed" && <div className="soul-hint soul-hint-error">{submit.message}</div>}

        {snapshot.memoryGroups.length === 0 ? (
          <div className="soul-empty">
            还没有任何记忆。上面记一条试试——项目地址、部署方式、代码规范这类事实， 记一次之后就不用再重复解释。
          </div>
        ) : (
          snapshot.memoryGroups.map((group) => (
            <div className="soul-group" key={group.category}>
              <div className="soul-group-title">
                {group.label}
                <span className="soul-group-count">{group.items.length}</span>
              </div>
              {group.items.map((item) => (
                <div className="soul-item" key={item.id}>
                  <div className="soul-item-main">
                    <span className="soul-item-title">{item.title}</span>
                    <span className="soul-item-value">{item.value}</span>
                  </div>
                  <span className="soul-item-meta">
                    {item.redacted ? "已遮蔽" : `${Math.round(item.strength * 100)}%`}
                  </span>
                  <button
                    type="button"
                    className="soul-item-delete"
                    title="忘掉这条"
                    onClick={() => props.onForget(item.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ))
        )}

        {missingLabels.length > 0 && (
          <div className="soul-hint">尚未记录：{missingLabels}。它不会猜这些——用到时会问你一次。</div>
        )}
      </section>

      {/* 存储与提示词 */}
      <section className="soul-section">
        <h4>存储位置</h4>
        <div className="soul-path">{locations?.global ?? "（未加载）"}</div>
        {locations?.project !== undefined && <div className="soul-path">{locations.project}</div>}
        <details className="soul-details">
          <summary>查看注入模型的提示词</summary>
          <pre className="soul-prompt">{snapshot.promptPreview}</pre>
        </details>
      </section>
    </div>
  );
}

/**
 * 司南页签（取数 + 提交）
 */
export function SoulPane() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [snapshot, setSnapshot] = useState<SoulSnapshot | null>(null);
  const [categories, setCategories] = useState<SoulCategory[]>([]);
  const [locations, setLocations] = useState<SoulLocations | null>(null);
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ phase: "idle" });

  const load = useCallback(() => {
    setState({ phase: "loading" });
    fetchSoul()
      .then((data) => {
        setState({ phase: "ready", data });
        setSnapshot(data.snapshot);
        setCategories(data.categories);
        setLocations(data.locations);
      })
      .catch((error: unknown) => {
        setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemember = useCallback(() => {
    const value = text.trim();
    if (value.length === 0) return;
    setSubmit({ phase: "saving" });
    rememberSoul(value, category === "" ? undefined : category)
      .then((result) => {
        setSnapshot(result.snapshot);
        setText("");
        setSubmit({
          phase: "ok",
          message: `${result.action === "created" ? "已记住" : "已更新"}：${result.categoryLabel}（${
            result.fallback ? "按偏好归类" : `命中 ${result.matched.join("、")}`
          }）${result.secret ? " · 凭证值不会进入提示词" : ""}`,
        });
      })
      .catch((error: unknown) => {
        setSubmit({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
      });
  }, [text, category]);

  const handleForget = useCallback((id: string) => {
    forgetSoul(id)
      .then((result) => {
        setSnapshot(result.snapshot);
        setSubmit({ phase: "ok", message: "已遗忘该条记忆" });
      })
      .catch((error: unknown) => {
        setSubmit({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
      });
  }, []);

  if (state.phase === "loading") {
    return <div className="skills-empty">正在读取「司南」的人格与记忆…</div>;
  }
  if (state.phase === "error") {
    return <div className="skills-empty">读取失败：{state.message}</div>;
  }
  if (snapshot === null) {
    return <div className="skills-empty">暂无数据</div>;
  }

  return (
    <>
      {/* 形象与声音放在人格之前：这是用户先看到、也最先想改的两项 */}
      <SoulAppearancePane />
      <SoulView
        snapshot={snapshot}
        categories={categories}
        locations={locations}
        text={text}
        category={category}
        submit={submit}
        onTextChange={(value) => {
          setText(value);
          setSubmit({ phase: "idle" });
        }}
        onCategoryChange={setCategory}
        onRemember={handleRemember}
        onForget={handleForget}
      />
    </>
  );
}
