/**
 * 「形象与声音」面板 —— 头像、TTS 引擎、御姐音、语音链路状态
 *
 * ## 为什么独立成一个组件，而不是塞进 SoulView
 *
 * `SoulView` 是**纯展示**：人格四层与记忆全部由 props 传入，因此可以被
 * SSR 渲染测试直接断言。头像上传、试听、状态探测全是副作用，混进去会让
 * 那块测试从"断言渲染"退化成"断言加载中"。分开后两边各自可测。
 *
 * ## 三个设计约束
 *
 * 1. **未就绪要给命令，不是灰按钮**：sidecar 没装时按钮不灰，而是显示
 *    「运行 bash scripts/voice/setup.sh」——用户看到的是下一步，不是死路。
 * 2. **试听走同一条链路**：试听调 `/api/voice/tts`，与真实播报同一个端点，
 *    避免"试听好听、对话里不一样"。
 * 3. **保存是补丁**：头像与声音各自保存，改头像不会清空语音配置
 *    （后端 `PUT /api/soul/config` 按子集合并）。
 *
 * @module web/components/SoulAppearancePane
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSoulConfig,
  fetchVoiceStatus,
  saveSoulConfig,
  synthesizeSpeech,
  type SoulAvatarConfig,
  type SoulConfigView,
  type VoiceEngine,
  type VoiceStatus,
} from "../api";
import { SoulAvatar } from "./SoulAvatar";
import { AVATAR_MAX_BYTES, readAvatarFile } from "../voice/avatar-file";
import { readHandsFree, subscribeHandsFree, writeHandsFree } from "../voice/preference";

/** 面板状态 */
type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; config: SoulConfigView };

/** 提交提示 */
type Notice = { kind: "ok" | "error"; text: string } | null;

/**
 * 形象与声音面板
 */
export function SoulAppearancePane() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  /** 免按住偏好（本地设置，不走服务端配置：它跟设备走，不跟账号走） */
  const [handsFree, setHandsFree] = useState(() => readHandsFree());
  useEffect(() => subscribeHandsFree(setHandsFree), []);
  const [testing, setTesting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /** 拉取配置 + 语音状态（状态探测失败不影响配置展示） */
  const load = useCallback(() => {
    setState({ phase: "loading" });
    fetchSoulConfig()
      .then((config) => setState({ phase: "ready", config }))
      .catch((e: unknown) => setState({ phase: "error", message: e instanceof Error ? e.message : String(e) }));
    fetchVoiceStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 提交补丁
   *
   * @param patch 待更新字段
   * @param okText 成功提示
   */
  const submit = useCallback(async (patch: Parameters<typeof saveSoulConfig>[0], okText: string) => {
    setSaving(true);
    setNotice(null);
    try {
      const next = await saveSoulConfig(patch);
      setState({ phase: "ready", config: next });
      setNotice({ kind: "ok", text: okText });
    } catch (e: unknown) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, []);

  /**
   * 选择本地图片作为头像
   *
   * @param file 用户选择的文件
   */
  const onPickAvatar = useCallback(
    async (file: File) => {
      try {
        const dataUrl = await readAvatarFile(file);
        const avatar: SoulAvatarConfig = { kind: "custom", dataUrl };
        await submit({ avatar }, "头像已更新");
      } catch (e: unknown) {
        setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    },
    [submit]
  );

  /** 试听当前音色 */
  const onTest = useCallback(async () => {
    if (state.phase !== "ready") return;
    setTesting(true);
    setNotice(null);
    try {
      const sample = "方位已经定好了。这一步我盯着，跑完再跟你说结果。";
      const url = await synthesizeSpeech(sample);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e: unknown) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }, [state]);

  if (state.phase === "loading") {
    return <div className="soul-appearance soul-appearance-muted">正在读取形象与声音配置…</div>;
  }
  if (state.phase === "error") {
    return <div className="soul-appearance soul-appearance-error">读取配置失败：{state.message}</div>;
  }

  const { config } = state;
  const voice = config.voice;
  const ready = status?.reachable === true && status.tts.ready;

  return (
    <div className="soul-appearance">
      {/* ---------- 头像 ---------- */}
      <section className="soul-section">
        <h4>形象</h4>
        <div className="soul-avatar-row">
          <SoulAvatar avatar={config.avatar} size={64} className="soul-avatar-preview" />
          <div className="soul-avatar-actions">
            <div className="soul-avatar-hint">
              默认是应用图标里的兔狲（与桌面图标同一张图）。
              {config.avatar.kind === "custom" ? "当前使用自定义头像。" : ""}
            </div>
            <div className="soul-avatar-buttons">
              <button
                type="button"
                className="ssh-btn-secondary"
                disabled={saving}
                onClick={() => fileRef.current?.click()}
              >
                上传自定义
              </button>
              <button
                type="button"
                className="ssh-btn-secondary"
                disabled={saving || config.avatar.kind === "default"}
                onClick={() => void submit({ avatar: { kind: "default" } }, "已恢复默认兔狲头像")}
              >
                恢复默认
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file !== undefined) void onPickAvatar(file);
                }}
              />
            </div>
            <div className="soul-avatar-limit">
              支持 PNG / JPEG / WebP，不超过 {Math.round(AVATAR_MAX_BYTES / 1024)}KB
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 对话模式 ---------- */}
      <section className="soul-section">
        <h4>对话模式</h4>
        <div className="soul-modes">
          {config.modes.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`soul-mode${config.mode === item.id ? " soul-mode-active" : ""}`}
              disabled={saving}
              onClick={() => void submit({ mode: item.id }, `已切换到${item.label}`)}
            >
              <span className="soul-mode-label">{item.label}</span>
              <span className="soul-mode-tagline">{item.tagline}</span>
            </button>
          ))}
        </div>
        <div className="soul-hint">
          工作模式先给结论与动作；陪伴模式先接情绪再谈事。模式在<strong>新建会话</strong>时生效，已开的会话保持原样。
        </div>

        {config.mode === "companion" && (
          <div className="soul-companion">
            {config.companionPresets.length > 0 && (
              <div className="soul-field">
                <span className="soul-field-label">陪伴风格</span>
                <div className="soul-presets">
                  {config.companionPresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`soul-preset${
                        preset.config.warmth === config.companion.warmth &&
                        preset.config.proactivity === config.companion.proactivity
                          ? " soul-preset-active"
                          : ""
                      }`}
                      disabled={saving}
                      title={preset.description}
                      onClick={() => void submit({ companion: preset.config }, `已套用「${preset.label}」风格`)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="soul-field">
              <span className="soul-field-label">怎么称呼你</span>
              <input
                className="soul-input"
                type="text"
                maxLength={24}
                defaultValue={config.companion.addressAs}
                placeholder="留空就沿用「你」"
                disabled={saving}
                onBlur={(event) => void submit({ companion: { addressAs: event.target.value } }, "称呼已保存")}
              />
            </div>

            <div className="soul-field">
              <span className="soul-field-label">热情度</span>
              <input
                className="soul-range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.companion.warmth}
                disabled={saving}
                onChange={(event) =>
                  setState({
                    phase: "ready",
                    config: { ...config, companion: { ...config.companion, warmth: Number(event.target.value) } },
                  })
                }
                onMouseUp={(event) =>
                  void submit(
                    { companion: { warmth: Number((event.target as HTMLInputElement).value) } },
                    "热情度已保存"
                  )
                }
              />
              <span className="soul-range-value">{Math.round(config.companion.warmth * 100)}%</span>
            </div>

            <div className="soul-field">
              <span className="soul-field-label">主动性</span>
              <input
                className="soul-range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.companion.proactivity}
                disabled={saving}
                onChange={(event) =>
                  setState({
                    phase: "ready",
                    config: { ...config, companion: { ...config.companion, proactivity: Number(event.target.value) } },
                  })
                }
                onMouseUp={(event) =>
                  void submit(
                    { companion: { proactivity: Number((event.target as HTMLInputElement).value) } },
                    "主动性已保存"
                  )
                }
              />
              <span className="soul-range-value">{Math.round(config.companion.proactivity * 100)}%</span>
            </div>

            <label className="soul-check">
              <input
                type="checkbox"
                checked={config.companion.encourageHumanContact}
                disabled={saving}
                onChange={(event) =>
                  void submit({ companion: { encourageHumanContact: event.target.checked } }, "已更新现实连接建议")
                }
              />
              <span>在合适的时候鼓励我去找现实里的人（防依赖）</span>
            </label>

            <div className="soul-hint">
              陪伴模式只改语气与顺序，不改「不编造、不越权、不泄露凭证」的边界；出现自伤/自杀表达时会转入危机应对，
              建议拨打全国统一心理援助热线 <strong>12356</strong>，紧急情况 110 / 120。
            </div>
          </div>
        )}
      </section>

      {/* ---------- 声音 ---------- */}
      <section className="soul-section">
        <h4>声音（本机 MLX 语音）</h4>

        <label className="soul-check">
          <input
            type="checkbox"
            checked={voice.enabled}
            disabled={saving}
            onChange={(event) =>
              void submit(
                { voice: { enabled: event.target.checked } },
                event.target.checked ? "已启用语音" : "已关闭语音"
              )
            }
          />
          <span>启用语音对话（关闭后输入框不显示麦克风）</span>
        </label>

        <label className="soul-check">
          <input
            type="checkbox"
            checked={voice.speakReplies}
            disabled={saving}
            onChange={(event) => void submit({ voice: { speakReplies: event.target.checked } }, "已更新朗读设置")}
          />
          <span>自动朗读回复</span>
        </label>

        <label className="soul-check">
          <input type="checkbox" checked={handsFree} onChange={(event) => writeHandsFree(event.target.checked)} />
          <span>点一下说话，说完自动发送（免按住；关闭后改为点一下开始、再点一下结束）</span>
        </label>

        <div className="soul-field">
          <span className="soul-field-label">合成引擎</span>
          <select
            className="soul-select"
            value={voice.engine}
            disabled={saving}
            onChange={(event) =>
              void submit({ voice: { engine: event.target.value as VoiceEngine } }, "引擎已切换（下次合成生效）")
            }
          >
            <option value="qwen3-voicedesign">Qwen3-TTS VoiceDesign（中文首选，按描述造音色）</option>
            <option value="qwen3-customvoice">Qwen3-TTS CustomVoice（预置音色，更轻）</option>
            <option value="kokoro">Kokoro（轻量兜底）</option>
          </select>
        </div>

        {config.presets.length > 0 && (
          <div className="soul-field">
            <span className="soul-field-label">音色预设</span>
            <div className="soul-presets">
              {config.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`soul-preset${preset.description === voice.voice ? " soul-preset-active" : ""}`}
                  disabled={saving}
                  title={preset.description}
                  onClick={() => void submit({ voice: { voice: preset.description } }, `已套用「${preset.label}」音色`)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="soul-field soul-field-block">
          <span className="soul-field-label">音色描述（御姐音）</span>
          <textarea
            className="soul-textarea"
            rows={2}
            value={voice.voice}
            disabled={saving}
            onChange={(event) =>
              // 输入过程中不落盘：每次按键都 PUT 会把磁盘写成筛子。
              // 失焦/点保存时才提交。
              setState({ phase: "ready", config: { ...config, voice: { ...voice, voice: event.target.value } } })
            }
            onBlur={(event) => void submit({ voice: { voice: event.target.value } }, "音色描述已保存")}
          />
          <div className="soul-hint">写清楚「性别年龄 / 音区语速 / 气质」比单个形容词更有效。改完点一下「试听」。</div>
        </div>

        <div className="soul-field">
          <span className="soul-field-label">语速</span>
          <input
            className="soul-range"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={voice.speed}
            disabled={saving}
            onChange={(event) =>
              setState({
                phase: "ready",
                config: { ...config, voice: { ...voice, speed: Number(event.target.value) } },
              })
            }
            onMouseUp={(event) =>
              void submit({ voice: { speed: Number((event.target as HTMLInputElement).value) } }, "语速已保存")
            }
          />
          <span className="soul-range-value">{voice.speed.toFixed(2)}×</span>
        </div>

        <div className="soul-field">
          <span className="soul-field-label">服务地址</span>
          <input
            className="soul-input"
            type="text"
            defaultValue={voice.endpoint}
            disabled={saving}
            onBlur={(event) => void submit({ voice: { endpoint: event.target.value } }, "服务地址已保存")}
          />
        </div>

        <div className="soul-voice-actions">
          <button
            type="button"
            className="ssh-btn-secondary"
            disabled={testing || !ready}
            onClick={() => void onTest()}
          >
            {testing ? "合成中…" : "试听"}
          </button>
          <button type="button" className="ssh-btn-secondary" onClick={load}>
            重新探测
          </button>
        </div>

        {/* ---------- 链路状态（真实探测结果，不猜） ---------- */}
        <div className="soul-voice-status">
          <div className={`soul-voice-dot${status?.reachable === true ? " soul-voice-dot-on" : ""}`} />
          <div className="soul-voice-status-text">
            {status === null && "未获取到语音服务状态"}
            {status !== null && !status.reachable && (
              <>
                语音服务未启动（{status.endpoint}）
                <div className="soul-voice-hint">
                  先装依赖：<code>bash scripts/voice/setup.sh</code>，再启动：
                  <code>python3 scripts/voice/mlx_voice_server.py</code>
                </div>
              </>
            )}
            {status !== null && status.reachable && (
              <>
                已连接 · 识别 {status.asr.ready ? status.asr.model : `未就绪（${status.asr.reason ?? "未知"}）`} · 合成{" "}
                {status.tts.ready ? status.tts.model : `未就绪（${status.tts.reason ?? "未知"}）`}
                {!status.tts.ready && status.hint !== undefined && <div className="soul-voice-hint">{status.hint}</div>}
              </>
            )}
          </div>
        </div>

        <div className="soul-hint">配置位置：{config.filePath}</div>
      </section>

      {notice !== null && (
        <div className={`soul-notice soul-notice-${notice.kind}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  );
}
