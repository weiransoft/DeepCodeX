/**
 * 系统管理抽屉（DeepCode Desktop 内，从状态条「设置」进入）。
 *
 * Tab 切换：模型管理 / MCP 服务 / LDAP 认证 / 技能；模型与 MCP 复用 ConfigForm 增删改，
 * LDAP 为单例表单（LdapForm），技能为只读发现列表（GET /api/capabilities，与引擎技能注入同源）。
 * 保存经父级（App）统一落盘（saveDesktopConfig）；保存后保持抽屉打开，
 * 便于继续新增或微调，并提示保存成功。
 */
import { useCallback, useEffect, useState } from "react";
import { ConfigForm } from "./ConfigForm";
import { LdapForm } from "./LdapForm";
import { AgentsPane } from "./AgentsPane";
import { RulesPane } from "./RulesPane";
import { AuditPane } from "./AuditPane";
import { type DesktopConfig, type DesktopLdapConfig, type DesktopMcpServer, type DesktopModel } from "../desktopConfig";
import { getDesktopBridge } from "../desktop-bridge";
import { fetchCapabilities, type CapabilitySkill } from "../api";

/** LDAP 草稿默认值（未配置过时） */
function blankLdap(): DesktopLdapConfig {
  return { enabled: false, server: "", baseDn: "", useSsl: false };
}

export interface SettingsDrawerProps {
  /** 当前配置（用于初始化草稿） */
  initialConfig: DesktopConfig;
  /**
   * 保存：提交模型 / MCP / LDAP 草稿（父级落盘）。
   *
   * 返回 Promise —— 2026-11-01 修复"点击保存却提示失败/假成功"：
   * 此前签名是 void，调用方在 `onSave()` 之后立刻 `setSaved(true)`，
   * 真正的落盘是异步的，失败时页面先闪"已保存 ✓"再弹错误 toast，
   * 用户看到的就是"保存失败"。现在改为等 Promise 结果再定状态。
   */
  onSave: (models: DesktopModel[], mcpServers: DesktopMcpServer[], ldap: DesktopLdapConfig) => Promise<void>;
  /** 关闭抽屉 */
  onClose: () => void;
}

type Tab = "models" | "mcp" | "ldap" | "skills" | "agents" | "rules" | "audit";

/** 保存状态：idle / saving / saved / failed（failed 携带后端原文） */
type SaveState = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "failed"; message: string };

/** 技能列表加载状态 */
type SkillsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; skills: CapabilitySkill[]; defaultAgent: string | null };

export function SettingsDrawer({ initialConfig, onSave, onClose }: SettingsDrawerProps) {
  const [tab, setTab] = useState<Tab>("models");
  const [models, setModels] = useState<DesktopModel[]>(initialConfig.models ?? []);
  const [mcp, setMcp] = useState<DesktopMcpServer[]>(initialConfig.mcpServers ?? []);
  const [ldap, setLdap] = useState<DesktopLdapConfig>(initialConfig.ldap ?? blankLdap());
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });

  /** 能力发现（进入「技能」/「智能体」页签时懒加载；重新进入刷新，与 @ 提及同源） */
  const [skills, setSkills] = useState<SkillsState>({ phase: "loading" });

  const loadCapabilities = useCallback(() => {
    setSkills({ phase: "loading" });
    let cancelled = false;
    fetchCapabilities()
      .then((data) => {
        if (!cancelled) setSkills({ phase: "ready", skills: data.skills, defaultAgent: data.defaultAgent ?? null });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSkills({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tab !== "skills" && tab !== "agents") return;
    return loadCapabilities();
  }, [tab, loadCapabilities]);

  const restartEngine = async () => {
    const b = getDesktopBridge();
    if (!b) return;
    try {
      await b.invoke("engine_restart");
    } catch {
      /* 静默 */
    }
  };

  const handleSave = async () => {
    setSaveState({ phase: "saving" });
    try {
      await onSave(models, mcp, ldap);
      setSaveState({ phase: "saved" });
      window.setTimeout(() => setSaveState((cur) => (cur.phase === "saved" ? { phase: "idle" } : cur)), 3000);
    } catch (e: unknown) {
      setSaveState({ phase: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * 增删改即落盘（2026-11-01 用户需求：添加模型就直接保存，不需要另外点保存配置）。
   *
   * 触发点只在"应用草稿 / 删除"（ConfigForm 的 onApply / onDelete），
   * 输入过程中的逐字编辑仍在本地草稿里，不会每敲一个字写一次盘。
   */
  const persistNow = useCallback(
    async (nextModels: DesktopModel[], nextMcp: DesktopMcpServer[], nextLdap: DesktopLdapConfig) => {
      setSaveState({ phase: "saving" });
      try {
        await onSave(nextModels, nextMcp, nextLdap);
        setSaveState({ phase: "saved" });
        window.setTimeout(() => setSaveState((cur) => (cur.phase === "saved" ? { phase: "idle" } : cur)), 3000);
      } catch (e: unknown) {
        setSaveState({ phase: "failed", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [onSave]
  );

  const handleModelsChange = useCallback(
    (next: DesktopModel[]) => {
      setModels(next);
      void persistNow(next, mcp, ldap);
    },
    [mcp, ldap, persistNow]
  );

  const handleMcpChange = useCallback(
    (next: DesktopMcpServer[]) => {
      setMcp(next);
      void persistNow(models, next, ldap);
    },
    [models, ldap, persistNow]
  );

  /** LDAP 前端轻校验：启用时 server / baseDn 必填（引擎侧还有一道 fail-fast） */
  const ldapInvalid = ldap.enabled && (ldap.server.trim() === "" || ldap.baseDn.trim() === "");

  const skillCount = skills.phase === "ready" ? skills.skills.filter((s) => s.kind === "skill").length : 0;
  const agentCount = skills.phase === "ready" ? skills.skills.filter((s) => s.kind === "agent").length : 0;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h2>系统管理</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <nav className="settings-tabs">
          <button
            type="button"
            className={"settings-tab" + (tab === "models" ? " active" : "")}
            onClick={() => setTab("models")}
          >
            模型管理（{models.length}）
          </button>
          <button
            type="button"
            className={"settings-tab" + (tab === "mcp" ? " active" : "")}
            onClick={() => setTab("mcp")}
          >
            MCP 服务（{mcp.length}）
          </button>
          <button
            type="button"
            className={"settings-tab" + (tab === "ldap" ? " active" : "")}
            onClick={() => setTab("ldap")}
          >
            LDAP 认证{ldap.enabled ? "（开）" : ""}
          </button>
          <button
            type="button"
            className={"settings-tab" + (tab === "agents" ? " active" : "")}
            onClick={() => setTab("agents")}
          >
            智能体（{agentCount}）
          </button>
          <button
            type="button"
            className={"settings-tab" + (tab === "rules" ? " active" : "")}
            onClick={() => setTab("rules")}
          >
            全局规则
          </button>
          <button
            type="button"
            className={"settings-tab" + (tab === "skills" ? " active" : "")}
            onClick={() => setTab("skills")}
          >
            技能（{skillCount}）
          </button>
          <button
            type="button"
            className={"settings-tab" + (tab === "audit" ? " active" : "")}
            onClick={() => setTab("audit")}
          >
            审计
          </button>
        </nav>

        <div className="settings-content">
          {tab === "rules" ? (
            <RulesPane />
          ) : tab === "audit" ? (
            <AuditPane />
          ) : tab === "agents" ? (
            <AgentsPane
              agents={skills.phase === "ready" ? skills.skills.filter((s) => s.kind === "agent") : []}
              defaultAgent={skills.phase === "ready" ? skills.defaultAgent : null}
              onCreated={loadCapabilities}
            />
          ) : tab === "skills" ? (
            <div className="skills-list">
              <p className="skills-hint">
                技能由引擎自动扫描：项目级 .deepcode/skills、用户级 ~/.deepcode/skills 与内置技能； 对话输入{" "}
                <code>@</code> 可直接引用。MCP 插件在「MCP 服务」页签配置。
              </p>
              {skills.phase === "loading" && <div className="skills-empty">正在扫描已安装技能…</div>}
              {skills.phase === "error" && <div className="skills-empty">扫描失败：{skills.message}</div>}
              {skills.phase === "ready" && skills.skills.length === 0 && (
                <div className="skills-empty">未发现已安装技能（可将 SKILL.md 放入 ~/.deepcode/skills）</div>
              )}
              {skills.phase === "ready" &&
                skills.skills.map((s) => (
                  <div key={`${s.kind}-${s.name}`} className="skills-item">
                    <div className="skills-item-head">
                      <span
                        className={
                          "mention-badge " + (s.kind === "agent" ? "mention-badge-agent" : "mention-badge-skill")
                        }
                      >
                        {s.kind === "agent" ? "Agent" : "技能"}
                      </span>
                      <span className="skills-item-name">{s.name}</span>
                    </div>
                    {s.description !== "" && <div className="skills-item-desc">{s.description}</div>}
                    <div className="skills-item-path" title={s.path}>
                      {s.path}
                    </div>
                  </div>
                ))}
            </div>
          ) : tab === "ldap" ? (
            <LdapForm
              ldap={ldap}
              onChange={(next) => {
                setLdap(next);
                setSaveState({ phase: "idle" });
              }}
            />
          ) : (
            <ConfigForm
              models={models}
              mcpServers={mcp}
              section={tab}
              onModelsChange={handleModelsChange}
              onMcpChange={handleMcpChange}
            />
          )}
        </div>

        <footer className="settings-footer">
          <span className={"settings-status" + (saveState.phase === "failed" ? " settings-status-error" : "")}>
            {ldapInvalid
              ? "LDAP 已启用：请填写服务器地址与 Base DN"
              : saveState.phase === "saving"
                ? "保存中…"
                : saveState.phase === "saved"
                  ? "已保存 ✓"
                  : saveState.phase === "failed"
                    ? `保存失败：${saveState.message}`
                    : "模型与 MCP 的增删改会自动保存"}
          </span>
          <span className="settings-footer-spacer" />
          <button type="button" className="cfg-btn cfg-btn-ghost" onClick={() => void restartEngine()}>
            重启引擎应用
          </button>
          <button
            type="button"
            className="cfg-btn"
            onClick={() => void handleSave()}
            disabled={ldapInvalid || saveState.phase === "saving"}
          >
            {saveState.phase === "saving" ? "保存中…" : "保存"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
