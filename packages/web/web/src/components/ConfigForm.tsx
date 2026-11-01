/**
 * 共享配置编辑器：模型管理与 MCP 服务的增删改（向导与系统管理共用）。
 *
 * 受控组件：models / mcpServers 由父级持有草稿状态并传入，编辑经
 * onModelsChange / onMcpChange 回写；密钥字段（apiKey）仅在"新增 / 修改"时
 * 由用户输入并随保存上送，留空表示保持已保存密钥不变。
 */
import { useState } from "react";
import { type DesktopModel, type DesktopMcpServer, type ModelType, MODEL_TYPE_OPTIONS } from "../desktopConfig";

/** uuid（优先 crypto.randomUUID；127.0.0.1 安全上下文可用，降级到 Math.random） */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function blankModel(): DesktopModel {
  return {
    id: uuid(),
    name: "",
    type: "openai",
    baseUrl: "",
    apiKey: "",
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    hasKey: false,
  };
}

function blankMcp(): DesktopMcpServer {
  return { id: uuid(), name: "", command: "", args: [], env: {}, enabled: true };
}

/** 解析环境变量文本（KEY=VALUE，每行一条，跳过空行） */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const idx = t.indexOf("=");
    if (idx <= 0) continue; // 跳过无等号的非法行
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (k !== "") out[k] = v;
  }
  return out;
}

/** 环境变量 → 文本 */
function serializeEnv(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** 解析参数文本（每行一个，去掉首尾空白，过滤空行） */
function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export interface ConfigFormProps {
  models: DesktopModel[];
  mcpServers: DesktopMcpServer[];
  /** 展示范围：all=模型+MCP；models=仅模型；mcp=仅 MCP */
  section?: "all" | "models" | "mcp";
  onModelsChange: (next: DesktopModel[]) => void;
  onMcpChange: (next: DesktopMcpServer[]) => void;
}

type EditState =
  | { kind: "model"; index: number | null; draft: DesktopModel }
  | { kind: "mcp"; index: number | null; draft: DesktopMcpServer }
  | null;

/** 共享配置编辑器 */
export function ConfigForm({ models, mcpServers, section = "all", onModelsChange, onMcpChange }: ConfigFormProps) {
  const [editing, setEditing] = useState<EditState>(null);

  const startAddModel = () => setEditing({ kind: "model", index: null, draft: blankModel() });
  const startEditModel = (i: number) => setEditing({ kind: "model", index: i, draft: { ...models[i], apiKey: "" } });
  const startAddMcp = () => setEditing({ kind: "mcp", index: null, draft: blankMcp() });
  const startEditMcp = (i: number) => setEditing({ kind: "mcp", index: i, draft: { ...mcpServers[i] } });

  const cancelEdit = () => setEditing(null);

  /** 应用模型草稿（新增或更新），并保持至多一个默认模型 */
  const applyModel = (draft: DesktopModel) => {
    const isEdit = editing?.kind === "model" && editing.index !== null;
    let next: DesktopModel[];
    if (isEdit) {
      const idx = editing.index as number;
      next = models.map((m, i) => (i === idx ? draft : m));
    } else {
      next = [...models, draft];
    }
    if (draft.isDefault) {
      next = next.map((m) => (m.id === draft.id ? m : { ...m, isDefault: false }));
    }
    onModelsChange(next);
    setEditing(null);
  };

  /** 应用 MCP 草稿 */
  const applyMcp = (draft: DesktopMcpServer) => {
    const isEdit = editing?.kind === "mcp" && editing.index !== null;
    let next: DesktopMcpServer[];
    if (isEdit) {
      const idx = editing.index as number;
      next = mcpServers.map((m, i) => (i === idx ? draft : m));
    } else {
      next = [...mcpServers, draft];
    }
    onMcpChange(next);
    setEditing(null);
  };

  const deleteModel = (i: number) => onModelsChange(models.filter((_, idx) => idx !== i));
  const deleteMcp = (i: number) => onMcpChange(mcpServers.filter((_, idx) => idx !== i));

  return (
    <div className="cfg-form">
      {section !== "mcp" && (
        <ModelsSection
          models={models}
          editing={editing}
          onAdd={startAddModel}
          onEdit={startEditModel}
          onDelete={deleteModel}
          onApply={applyModel}
          onCancel={cancelEdit}
        />
      )}
      {section !== "models" && (
        <McpSection
          mcpServers={mcpServers}
          editing={editing}
          onAdd={startAddMcp}
          onEdit={startEditMcp}
          onDelete={deleteMcp}
          onApply={applyMcp}
          onCancel={cancelEdit}
        />
      )}
    </div>
  );
}

// ---------- 模型 ----------

interface ModelsSectionProps {
  models: DesktopModel[];
  editing: EditState;
  onAdd: () => void;
  onEdit: (i: number) => void;
  onDelete: (i: number) => void;
  onApply: (draft: DesktopModel) => void;
  onCancel: () => void;
}

function ModelsSection({ models, editing, onAdd, onEdit, onDelete, onApply, onCancel }: ModelsSectionProps) {
  return (
    <section className="cfg-section">
      <div className="cfg-section-head">
        <h3>AI 模型</h3>
        <button type="button" className="cfg-btn" onClick={onAdd}>
          + 添加模型
        </button>
      </div>

      {models.length === 0 && !editing && <p className="cfg-empty">尚未配置任何模型。点击「添加模型」开始。</p>}

      {models.map((m, i) =>
        editing?.kind === "model" && editing.index === i ? (
          <ModelEditor key={m.id} draft={editing.draft} onApply={onApply} onCancel={onCancel} />
        ) : (
          <div className="cfg-card" key={m.id}>
            <div className="cfg-card-main">
              <span className="cfg-card-title">{m.name || "（未命名）"}</span>
              <span className="cfg-tag">{m.type}</span>
              {m.isDefault && <span className="cfg-tag cfg-tag-default">默认</span>}
              {!m.enabled && <span className="cfg-tag cfg-tag-off">已禁用</span>}
              {m.hasKey && <span className="cfg-tag cfg-tag-key">密钥已保存</span>}
              {m.contextInputTokens != null && (
                <span className="cfg-tag">上下文 {formatTokens(m.contextInputTokens)}</span>
              )}
              {m.maxToolRounds != null && <span className="cfg-tag">工具轮 {m.maxToolRounds}</span>}
              {m.temperature != null && <span className="cfg-tag">温度 {m.temperature}</span>}
              {m.thinkingMode === "on" && <span className="cfg-tag">思考开</span>}
              {m.thinkingMode === "off" && <span className="cfg-tag">思考关</span>}
            </div>
            {m.baseUrl && <div className="cfg-card-sub">{m.baseUrl}</div>}
            <div className="cfg-card-actions">
              <button type="button" className="cfg-btn cfg-btn-sm" onClick={() => onEdit(i)}>
                编辑
              </button>
              <button type="button" className="cfg-btn cfg-btn-sm cfg-btn-danger" onClick={() => onDelete(i)}>
                删除
              </button>
            </div>
          </div>
        )
      )}

      {editing?.kind === "model" && editing.index === null && (
        <ModelEditor draft={editing.draft} onApply={onApply} onCancel={onCancel} />
      )}
    </section>
  );
}

function ModelEditor({
  draft,
  onApply,
  onCancel,
}: {
  draft: DesktopModel;
  onApply: (d: DesktopModel) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<DesktopModel>(draft);
  const set = (patch: Partial<DesktopModel>) => setD((cur) => ({ ...cur, ...patch }));
  const valid = d.name.trim() !== "";
  // 高级配置折叠态：草稿带任何高级字段时默认展开（编辑已配置模型时直观可见）
  const hasAdvanced =
    (d.series !== undefined && d.series !== "" && d.series !== "default") ||
    d.contextInputTokens != null ||
    d.contextOutputTokens != null ||
    d.maxToolRounds != null ||
    (d.imageInput !== undefined && d.imageInput !== "default") ||
    (d.thinkingMode !== undefined && d.thinkingMode !== "default") ||
    d.temperature != null ||
    d.topP != null ||
    d.topK != null;
  const [advOpen, setAdvOpen] = useState(hasAdvanced);

  // 上下文窗口输入框保留文本态（支持 128k / 1M / 纯数字），保存时解析
  const [inputText, setInputText] = useState(formatTokens(d.contextInputTokens));
  const [outputText, setOutputText] = useState(formatTokens(d.contextOutputTokens));

  const apply = () => {
    onApply({
      ...d,
      contextInputTokens: parseTokenText(inputText),
      contextOutputTokens: parseTokenText(outputText),
    });
  };

  return (
    <div className="cfg-editor">
      <div className="cfg-field">
        <label>模型名称</label>
        <input
          type="text"
          value={d.name}
          placeholder="例如：GPT-4o / Claude 3.5"
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="cfg-field">
        <label>模型标识（API Model ID）</label>
        <input
          type="text"
          value={d.model ?? ""}
          placeholder="如 gpt-4o / claude-3-5-sonnet-20241022；留空用模型名称"
          onChange={(e) => set({ model: e.target.value })}
        />
      </div>
      <div className="cfg-field">
        <label>类型</label>
        <select value={d.type} onChange={(e) => set({ type: e.target.value as ModelType })}>
          {MODEL_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!MODEL_TYPE_OPTIONS.some((o) => o.value === d.type) && <option value={d.type}>{d.type}</option>}
        </select>
      </div>
      <div className="cfg-field">
        <label>Base URL（可选）</label>
        <input
          type="text"
          value={d.baseUrl}
          placeholder="留空走供应商默认"
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </div>
      <div className="cfg-field">
        <label>API Key</label>
        <input
          type="password"
          value={d.apiKey ?? ""}
          placeholder={d.hasKey ? "已保存；留空保持不变" : "粘贴你的 API Key"}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
      </div>
      <div className="cfg-checks">
        <label className="cfg-check">
          <input type="checkbox" checked={d.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />
          启用
        </label>
        <label className="cfg-check">
          <input
            type="checkbox"
            checked={d.isDefault === true}
            onChange={(e) => set({ isDefault: e.target.checked })}
          />
          设为默认模型
        </label>
      </div>

      {/* ---------- 高级配置（折叠区） ---------- */}
      <button type="button" className="cfg-adv-toggle" onClick={() => setAdvOpen((v) => !v)} aria-expanded={advOpen}>
        <span className={"cfg-adv-caret" + (advOpen ? " open" : "")}>▸</span>
        高级配置
      </button>
      {advOpen && (
        <div className="cfg-adv">
          <div className="cfg-field">
            <label>模型系列</label>
            <select value={d.series ?? "default"} onChange={(e) => set({ series: e.target.value })}>
              <option value="default">默认</option>
              <option value="claude">CLAUDE</option>
              <option value="gpt">GPT</option>
              <option value="gemini">Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="qwen">Qwen</option>
              <option value="glm">GLM</option>
            </select>
            <p className="cfg-field-hint">针对特定模型系列优化 Prompt，未选择时使用默认配置。</p>
          </div>

          <div className="cfg-field">
            <label>上下文窗口（Token）</label>
            <div className="cfg-token-row">
              <span className="cfg-token-label">输入</span>
              <input
                type="text"
                value={inputText}
                placeholder="留空使用最佳默认值"
                onChange={(e) => setInputText(e.target.value)}
              />
              <span className="cfg-token-chips">
                {[131072, 262144, 524288, 1048576].map((v) => (
                  <button key={v} type="button" className="cfg-chip" onClick={() => setInputText(String(v))}>
                    {tokensChipLabel(v)}
                  </button>
                ))}
              </span>
            </div>
            <div className="cfg-token-row">
              <span className="cfg-token-label">输出</span>
              <input
                type="text"
                value={outputText}
                placeholder="留空使用最佳默认值"
                onChange={(e) => setOutputText(e.target.value)}
              />
              <span className="cfg-token-chips">
                {[4096, 16384, 32768, 131072].map((v) => (
                  <button key={v} type="button" className="cfg-chip" onClick={() => setOutputText(String(v))}>
                    {tokensChipLabel(v)}
                  </button>
                ))}
              </span>
            </div>
            <p className="cfg-field-hint">支持纯数字或 128k / 1M 形式；输入决定上下文窗口，输出决定单次回复上限。</p>
          </div>

          <div className="cfg-field">
            <label>工具调用轮数</label>
            <input
              type="number"
              min={1}
              max={10000}
              value={d.maxToolRounds ?? ""}
              placeholder="留空使用引擎默认（40）"
              onChange={(e) =>
                set({
                  maxToolRounds: e.target.value === "" ? null : Math.max(1, Math.floor(Number(e.target.value) || 1)),
                })
              }
            />
          </div>

          <div className="cfg-field">
            <label>支持图片输入</label>
            <div className="cfg-radio-row">
              {[
                { v: "default", t: "跟随模型默认" },
                { v: "yes", t: "支持" },
                { v: "no", t: "不支持" },
              ].map((o) => (
                <label key={o.v} className="cfg-check">
                  <input
                    type="radio"
                    name={`img-${d.id}`}
                    checked={(d.imageInput ?? "default") === o.v}
                    onChange={() => set({ imageInput: o.v })}
                  />
                  {o.t}
                </label>
              ))}
            </div>
          </div>

          <div className="cfg-field">
            <label>思考模式</label>
            <div className="cfg-radio-row">
              {[
                { v: "default", t: "跟随模型默认配置" },
                { v: "on", t: "开启" },
                { v: "off", t: "关闭" },
              ].map((o) => (
                <label key={o.v} className="cfg-check">
                  <input
                    type="radio"
                    name={`think-${d.id}`}
                    checked={(d.thinkingMode ?? "default") === o.v}
                    onChange={() => set({ thinkingMode: o.v })}
                  />
                  {o.t}
                </label>
              ))}
            </div>
          </div>

          <div className="cfg-field">
            <label>采样参数</label>
            <div className="cfg-sample-row">
              <span className="cfg-token-label">Temperature</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={d.temperature ?? ""}
                placeholder="留空使用最佳配置，0 ~ 2"
                onChange={(e) => set({ temperature: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
            <div className="cfg-sample-row">
              <span className="cfg-token-label">Top P</span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={d.topP ?? ""}
                placeholder="留空使用最佳配置，0 ~ 1"
                onChange={(e) => set({ topP: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
            <div className="cfg-sample-row">
              <span className="cfg-token-label">Top K</span>
              <input
                type="number"
                min={1}
                max={100}
                value={d.topK ?? ""}
                placeholder="留空使用最佳配置，1 ~ 100"
                onChange={(e) => set({ topK: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
          </div>
        </div>
      )}

      <div className="cfg-editor-actions">
        <button type="button" className="cfg-btn" disabled={!valid} onClick={apply}>
          保存
        </button>
        <button type="button" className="cfg-btn cfg-btn-ghost" onClick={onCancel}>
          取消
        </button>
        {!valid && <span className="cfg-hint">请填写模型名称</span>}
      </div>
    </div>
  );
}

// ---------- 高级配置工具函数 ----------

/** 解析 Token 文本：支持 128k / 1M / 131072（k/M 大小写均可）；非法返回 null（= 留空清空） */
function parseTokenText(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = m[2] === "k" ? 1024 : m[2] === "m" ? 1024 * 1024 : 1;
  return Math.round(base * mult);
}

/** Token 数 → 编辑框文本（优先 k / M 紧凑形式，非整除回落原始数字） */
function formatTokens(n: number | null | undefined): string {
  if (n == null) return "";
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}M`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  return String(n);
}

/** 快捷档位按钮标签 */
function tokensChipLabel(n: number): string {
  if (n >= 1024 * 1024) return `${n / (1024 * 1024)}M`;
  return `${n / 1024}k`;
}

// ---------- MCP ----------

interface McpSectionProps {
  mcpServers: DesktopMcpServer[];
  editing: EditState;
  onAdd: () => void;
  onEdit: (i: number) => void;
  onDelete: (i: number) => void;
  onApply: (draft: DesktopMcpServer) => void;
  onCancel: () => void;
}

function McpSection({ mcpServers, editing, onAdd, onEdit, onDelete, onApply, onCancel }: McpSectionProps) {
  return (
    <section className="cfg-section">
      <div className="cfg-section-head">
        <h3>MCP 服务</h3>
        <button type="button" className="cfg-btn" onClick={onAdd}>
          + 添加服务
        </button>
      </div>

      {mcpServers.length === 0 && !editing && (
        <p className="cfg-empty">尚未配置任何 MCP 服务（可选，可稍后在系统管理中添加）。</p>
      )}

      {mcpServers.map((s, i) =>
        editing?.kind === "mcp" && editing.index === i ? (
          <McpEditor key={s.id} draft={editing.draft} onApply={onApply} onCancel={onCancel} />
        ) : (
          <div className="cfg-card" key={s.id}>
            <div className="cfg-card-main">
              <span className="cfg-card-title">{s.name || "（未命名）"}</span>
              <span className="cfg-tag">{s.command}</span>
              {!s.enabled && <span className="cfg-tag cfg-tag-off">已禁用</span>}
            </div>
            {s.args && s.args.length > 0 && <div className="cfg-card-sub">{s.args.join(" ")}</div>}
            <div className="cfg-card-actions">
              <button type="button" className="cfg-btn cfg-btn-sm" onClick={() => onEdit(i)}>
                编辑
              </button>
              <button type="button" className="cfg-btn cfg-btn-sm cfg-btn-danger" onClick={() => onDelete(i)}>
                删除
              </button>
            </div>
          </div>
        )
      )}

      {editing?.kind === "mcp" && editing.index === null && (
        <McpEditor draft={editing.draft} onApply={onApply} onCancel={onCancel} />
      )}
    </section>
  );
}

function McpEditor({
  draft,
  onApply,
  onCancel,
}: {
  draft: DesktopMcpServer;
  onApply: (d: DesktopMcpServer) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<DesktopMcpServer>(draft);
  const [argsText, setArgsText] = useState<string>((draft.args ?? []).join("\n"));
  const [envText, setEnvText] = useState<string>(serializeEnv(draft.env));
  const set = (patch: Partial<DesktopMcpServer>) => setD((cur) => ({ ...cur, ...patch }));
  const valid = d.name.trim() !== "" && d.command.trim() !== "";
  const apply = () => onApply({ ...d, args: parseArgs(argsText), env: parseEnv(envText) });
  return (
    <div className="cfg-editor">
      <div className="cfg-field">
        <label>服务名称</label>
        <input
          type="text"
          value={d.name}
          placeholder="例如：sqlite / filesystem"
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="cfg-field">
        <label>启动命令</label>
        <input
          type="text"
          value={d.command}
          placeholder="uvx / npx / node …"
          onChange={(e) => set({ command: e.target.value })}
        />
      </div>
      <div className="cfg-field">
        <label>参数（每行一条）</label>
        <textarea
          rows={3}
          value={argsText}
          placeholder={"mcp-server-sqlite\n--db-path\n./app.db"}
          onChange={(e) => setArgsText(e.target.value)}
        />
      </div>
      <div className="cfg-field">
        <label>环境变量（KEY=VALUE，每行一条）</label>
        <textarea rows={3} value={envText} placeholder={"API_TOKEN=xxx"} onChange={(e) => setEnvText(e.target.value)} />
      </div>
      <div className="cfg-checks">
        <label className="cfg-check">
          <input type="checkbox" checked={d.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />
          启用
        </label>
      </div>
      <div className="cfg-editor-actions">
        <button type="button" className="cfg-btn" disabled={!valid} onClick={apply}>
          保存
        </button>
        <button type="button" className="cfg-btn cfg-btn-ghost" onClick={onCancel}>
          取消
        </button>
        {!valid && <span className="cfg-hint">请填写名称与命令</span>}
      </div>
    </div>
  );
}
