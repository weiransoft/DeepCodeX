/**
 * 智能体页签（SettingsDrawer「智能体」）：已创建 Agent 列表 + 新建表单。
 *
 * 列表数据与引擎扫描同源（GET /api/capabilities 中 kind==="agent" 条目，
 * 与 @ 提及补全、system prompt agent 索引一致——「看到的」=「能加载的」）。
 * 新建走 POST /api/agents（服务端 SedimentationWriter 五条安全门槛落盘
 * ~/.deepcode/skills/<name>/SKILL.md），成功后回调 onCreated 刷新列表；
 * 同名拒写（409）等失败以结构化中文原因行内提示。
 *
 * 命名约束与引擎一致：kebab-case（小写字母/数字/连字符），role 必填
 * （agent 定义的角色身份，注入 prompt 的 role 属性）。
 */
import { useState } from "react";
import { createAgent, draftAgent, type CapabilitySkill } from "../api";

/** kebab-case 校验（与 AgentRegistry / SedimentationWriter 同口径） */
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 反馈条类型 */
type Feedback = { tone: "ok" | "err"; message: string } | null;

export interface AgentsPaneProps {
  /** 已创建的 Agent 列表（capabilities kind==="agent"，父级负责加载与刷新） */
  agents: CapabilitySkill[];
  /** 创建成功后回调（父级重新拉取 capabilities） */
  onCreated: () => void;
}

/** 智能体页签组件 */
export function AgentsPane({ agents, onCreated }: AgentsPaneProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // AI 一句话生成：意图输入与生成状态
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);

  /** name 实时校验：非空且 kebab-case 才允许提交 */
  const nameInvalid = name.trim() !== "" && !KEBAB_CASE_PATTERN.test(name.trim());
  const canSubmit =
    !submitting && name.trim() !== "" && !nameInvalid && description.trim() !== "" && role.trim() !== "";

  /**
   * AI 一句话生成草稿：调用 POST /api/agents/draft，成功后把四件套填入表单，
   * 用户仍可逐项修改再创建（human-in-the-loop，生成绝不直接落盘）。
   */
  const generate = (): void => {
    setGenerating(true);
    setFeedback(null);
    draftAgent(aiPrompt.trim())
      .then((result) => {
        const d = result.draft;
        setName(d.name);
        setDescription(d.description);
        setRole(d.role);
        setContent(d.content);
        setFeedback({
          tone: "ok",
          message: `AI 已生成草稿「${d.name}」，请检查并按需修改后点「创建智能体」落盘。`,
        });
      })
      .catch((e: unknown) => {
        setFeedback({
          tone: "err",
          message: e instanceof Error ? e.message : "AI 生成失败，请重试",
        });
      })
      .finally(() => setGenerating(false));
  };

  const submit = (): void => {
    setSubmitting(true);
    setFeedback(null);
    createAgent({
      name: name.trim(),
      description: description.trim(),
      role: role.trim(),
      content,
    })
      .then((result) => {
        setFeedback({
          tone: "ok",
          message: `已创建「${name.trim()}」。在输入框输入 @${name.trim()} 即可让该智能体执行任务。`,
        });
        setName("");
        setDescription("");
        setRole("");
        setContent("");
        onCreated();
        void result;
      })
      .catch((e: unknown) => {
        setFeedback({
          tone: "err",
          message: e instanceof Error ? e.message : "创建失败，请重试",
        });
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="agents-pane">
      <div className="agents-section-title">
        已创建（{agents.length}）<span className="agents-hint">在输入框输入 @名称 即可调用</span>
      </div>
      {agents.length === 0 && (
        <div className="agents-empty">尚未创建自定义智能体。使用下方表单创建后，对话中 @名称 即可激活。</div>
      )}
      {agents.map((a) => (
        <div key={a.path} className="agents-item">
          <div className="agents-item-head">
            <span className="mention-badge mention-badge-agent">Agent</span>
            <span className="agents-item-name">{a.name}</span>
          </div>
          {a.description !== "" && <div className="agents-item-desc">{a.description}</div>}
          <div className="agents-item-path" title={a.path}>
            {a.path}
          </div>
        </div>
      ))}

      <div className="agents-section-title">新建智能体</div>
      <div className="agents-form">
        <label className="ssh-field">
          AI 一句话生成
          <div className="agents-ai-row">
            <input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="如：帮我创建一个代码评审智能体，专注发现安全漏洞"
              onKeyDown={(e) => {
                if (e.key === "Enter" && aiPrompt.trim() !== "" && !generating) generate();
              }}
            />
            <button
              type="button"
              className="ssh-btn-secondary"
              disabled={generating || aiPrompt.trim() === ""}
              onClick={generate}
            >
              {generating ? "生成中…" : "AI 生成"}
            </button>
          </div>
        </label>
        <div className="agents-hint agents-ai-hint">
          一句话描述需求，AI 自动生成完整定义并填入下方表单；确认或修改后再创建。
        </div>
        <label className="ssh-field">
          名称（kebab-case，如 code-reviewer）
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" spellCheck={false} />
        </label>
        {nameInvalid && <div className="agents-form-error">名称必须为 kebab-case（小写字母/数字/连字符）</div>}
        <label className="ssh-field">
          一句话描述（进入 agent 索引与 @ 候选列表）
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="负责审查代码变更并给出结构化评审意见"
          />
        </label>
        <label className="ssh-field">
          角色身份（role，激活时注入的角色约束声明）
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="资深代码评审工程师" />
        </label>
        <label className="ssh-field">
          行为约束（正文，激活后注入对话的行为规范）
          <textarea
            className="agents-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder={"- 逐条指出问题并给出修复建议\n- 输出前先复述任务目标\n- 不确定时明确说明假设"}
          />
        </label>
        {feedback !== null && (
          <div className={feedback.tone === "ok" ? "agents-feedback-ok" : "agents-form-error"}>{feedback.message}</div>
        )}
        <div className="agents-form-actions">
          <button type="button" className="ssh-btn-primary" disabled={!canSubmit} onClick={submit}>
            {submitting ? "创建中…" : "创建智能体"}
          </button>
        </div>
      </div>
    </div>
  );
}
