/**
 * 首次登录配置向导（DeepCode Desktop 内，首次启动登录后自动弹出）。
 *
 * 分步：欢迎 → 配置 AI 模型 → 配置 MCP 服务（可选）→ 完成。
 * 用户也可选择「跳过，稍后配置」——关闭后在系统管理（设置）中随时补配。
 *
 * 保存由父级（App）统一经 saveDesktopConfig 落盘；本组件只负责收集草稿
 * 与步骤流转，并在最终步提供「保存并重启引擎」以让引擎加载新的 MCP / 模型配置。
 */
import { useState } from "react";
import { ConfigForm } from "./ConfigForm";
import { type DesktopConfig, type DesktopMcpServer, type DesktopModel } from "../desktopConfig";
import { getDesktopBridge } from "../desktop-bridge";

export interface SetupWizardProps {
  /** 初始配置（首次登录通常为空） */
  initialConfig: DesktopConfig;
  /** 完成：提交模型与 MCP 草稿（父级落盘并关闭向导） */
  onComplete: (models: DesktopModel[], mcpServers: DesktopMcpServer[]) => void;
  /** 跳过：父级标记完成并关闭（不强制配置） */
  onSkip: () => void;
}

const STEPS = ["欢迎", "AI 模型", "MCP 服务", "完成"] as const;

export function SetupWizard({ initialConfig, onComplete, onSkip }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [models, setModels] = useState<DesktopModel[]>(initialConfig.models ?? []);
  const [mcp, setMcp] = useState<DesktopMcpServer[]>(initialConfig.mcpServers ?? []);
  const [busy, setBusy] = useState(false);

  /** 重启本地引擎以加载新配置（最终步可选） */
  const restartEngine = async () => {
    const b = getDesktopBridge();
    if (!b) return;
    try {
      await b.invoke("engine_restart");
    } catch {
      // 重启失败静默（状态条会反映真实状态）
    }
  };

  const finish = async (restart: boolean) => {
    setBusy(true);
    try {
      onComplete(models, mcp);
      if (restart) {
        await restartEngine();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-overlay">
      <div className="setup-modal">
        <ol className="setup-steps">
          {STEPS.map((label, i) => (
            <li key={label} className={"setup-step" + (i === step ? " active" : "") + (i < step ? " done" : "")}>
              <span className="setup-step-dot">{i < step ? "✓" : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <div className="setup-body">
          {step === 0 && (
            <div className="setup-welcome">
              <h2>欢迎使用 DeepCode Desktop</h2>
              <p>
                首次启动需要配置至少一个 AI 模型（及其 API Key）才能开始使用。 你也可以稍后在「系统管理 →
                设置」中随时新增或调整模型与 MCP 服务。
              </p>
              <p className="setup-welcome-hint">
                所有 API Key 将安全保存在系统钥匙串（Keychain / 凭据管理器）中， 不会以明文写入配置文件。
              </p>
            </div>
          )}

          {step === 1 && (
            <ConfigForm
              models={models}
              mcpServers={mcp}
              section="models"
              onModelsChange={setModels}
              onMcpChange={setMcp}
            />
          )}

          {step === 2 && (
            <ConfigForm
              models={models}
              mcpServers={mcp}
              section="mcp"
              onModelsChange={setModels}
              onMcpChange={setMcp}
            />
          )}

          {step === 3 && (
            <div className="setup-welcome">
              <h2>配置完成</h2>
              <p>
                已保存 {models.length} 个模型与 {mcp.length} 个 MCP 服务。
                点击「完成」进入工作区；若希望立即让引擎加载新的 MCP 服务， 可选择「完成并重启引擎」。
              </p>
              <p className="setup-welcome-hint">之后可随时从顶部状态条的「设置」进入系统管理，查看、编辑或继续新增。</p>
            </div>
          )}
        </div>

        <div className="setup-footer">
          {step > 0 && (
            <button
              type="button"
              className="cfg-btn cfg-btn-ghost"
              onClick={() => setStep((s) => s - 1)}
              disabled={busy}
            >
              上一步
            </button>
          )}
          <span className="setup-footer-spacer" />
          {step < STEPS.length - 1 ? (
            <button type="button" className="cfg-btn" onClick={() => setStep((s) => s + 1)}>
              {step === 0 ? "开始配置" : "下一步"}
            </button>
          ) : (
            <>
              <button type="button" className="cfg-btn" onClick={() => void finish(false)} disabled={busy}>
                {busy ? "保存中…" : "完成"}
              </button>
              <button
                type="button"
                className="cfg-btn cfg-btn-ghost"
                onClick={() => void finish(true)}
                disabled={busy}
                title="让引擎重新加载新的 MCP / 模型配置"
              >
                完成并重启引擎
              </button>
            </>
          )}
          {step === 0 && (
            <button type="button" className="setup-skip" onClick={onSkip}>
              跳过，稍后配置
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
