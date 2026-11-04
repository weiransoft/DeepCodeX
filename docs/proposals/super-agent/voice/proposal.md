# 司南的语音与形象：Web 头像 · 桌面配置 · 本机 MLX 语音对话

> 状态：**待评审**（评审记录见 `reviews-4-roles.md` / 结论见文末 §9）
> 日期：2026-11-04
> 调研依据：`industry-research.md`（含 10 条来源）
> 规模判定：**L**（跨 Web / 引擎 / sidecar / Tauri 四层，新增能力 ≥ 4 个模块）

---

## 1. 需求拆解与验收标准

| #   | 需求                                                | 验收标准（可测）                                                                                                           |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| R1  | Web 头像默认用放大的兔狲                            | 助手气泡/欢迎页/设置页显示兔狲；未配置任何东西时也显示；`<img>` 有 alt「司南」                                             |
| R2  | 桌面系统配置加 Super Agent 配置（头像 + soul 定义） | 设置抽屉「司南」页签可改头像（默认/自定义）、可看到人格四层与记忆；保存后重载仍生效                                        |
| R3  | 发音模型配置                                        | 可配引擎（Qwen3-TTS VoiceDesign / CustomVoice / Kokoro）、音色描述、语速、服务地址、是否自动朗读；有「试听」与真实状态显示 |
| R4  | 调研本机可跑语音对话模型，御姐音                    | 调研报告给出选型与理由；默认音色描述即御姐音，可编辑                                                                       |
| R5  | 桌面支持语音对话                                    | 按住麦克风说话 → 松开 → 文字进输入框并发送；回复按句朗读；可打断                                                           |
| R6  | 本机 Mac MLX 真跑                                   | `setup.sh` 一条命令装好；`status` 端点返回真实 `ready`；模型未装时**明确报未就绪**而不是假装                               |
| R7  | 评审实现                                            | 四角色评审 + 共识收敛 + 修订版；实现逐条对照验收标准                                                                       |

### 1.1 明确不做（Ponytail：先砍掉推测性需求）

- 全双工免提（需 AEC）、唤醒词（"司南司南"）——首版按住说话。
- 端到端语音大模型（S2S）——隐藏 ASR/TTS 可控环节。
- 声纹识别、多人对话、方言切换。
- 语音控制桌面（"打开设置"）——那是意图路由，不是语音链路，先不混进来。

---

## 2. 架构

```
┌────────────────────────── DeepCode Desktop（Tauri 壳） ──────────────────────────┐
│  WebView  ← 加载 http://127.0.0.1:<port>/（引擎页）                              │
│    │                                                                             │
│    ├─ 头像：<img src="/manul-avatar.png"> 或自定义 dataUrl                        │
│    ├─ 按住说话：getUserMedia → AudioWorklet/MediaRecorder → PCM16 WAV             │
│    └─ 朗读：句级队列 → new Audio(wav) → 可打断                                    │
│    │  fetch（同源，无跨域）                                                       │
└────┼────────────────────────────────────────────────────────────────────────────┘
     ↓
┌────┴──────────────────── 引擎（Node，packages/web） ────────────────────────────┐
│  /api/soul           人格 + 记忆（已有）                                          │
│  /api/soul/config    头像 + 语音配置（新增，落 ~/.deepcode/soul/config.json）      │
│  /api/voice/status   探测 sidecar（1.2s 超时），返回真实 ready/缺什么              │
│  /api/voice/tts      文本 → audio/wav（转发 sidecar，超时 60s）                    │
│  /api/voice/asr      音频 → {text}（转发 sidecar）                                │
└────┬────────────────────────────────────────────────────────────────────────────┘
     │  本机 HTTP（127.0.0.1:8791，仅回环）
     ↓
┌────┴──────────────── MLX sidecar（Python，scripts/voice） ─────────────────────┐
│  /health  → 各模型是否就绪 + 缺什么依赖                                            │
│  /tts     → mlx-audio：Qwen3-TTS VoiceDesign（默认）/ Kokoro（兜底）               │
│  /asr     → mlx-whisper large-v3-turbo                                            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**为什么配置不放 Tauri 的 `desktop.json`**：soul 数据必须被 CLI（`super soul`）、Web、引擎提示词三方共读。塞进桌面壳的私有配置，浏览器版和 CLI 就都看不到——同一个"司南"会分裂成两份。因此配置落在引擎数据目录，桌面壳只是它的一个显示入口。

---

## 3. 头像

### 3.1 资产

从桌面应用图标（1024×1024，蓝底白描边兔狲脸）中**裁出猫脸本体**：

- 泛洪去掉图标白色底板 → 透明背景；猫眼/鼻/嘴的白色被蓝色包围，不会被泛洪吃掉。
- 按蓝色区域 bbox 紧裁 + 5% 内边距 → 方形画布 → 256×256 LANCZOS。
- 64 色量化 → **9.7KB**（原 47KB）。

产物：`packages/web/web/public/manul-avatar.png`；构建脚本把 `public/*` 原样拷进 `dist/`。

> 诚实说明：这是**从应用图标裁出的同一张图**，不是重绘。好处是零失真；代价是它固定为品牌蓝，不随主题变色（头像本就不该变色）。

### 3.2 默认与自定义

- 默认：`kind: "default"` → `<img src="/manul-avatar.png">`。
- 自定义：`kind: "custom"` + `dataUrl`（上限 400k 字符，约 300KB 图）。前端读文件 → FileReader → 校验 MIME 与体积 → PUT。
- 「恢复默认」= 写回 `default` 并清空 dataUrl。

---

## 4. 语音配置（R3）

`SoulConfig`（引擎侧，`~/.deepcode/soul/config.json`，0600）：

```jsonc
{
  "avatar": { "kind": "default" }, // 或 { kind: "custom", dataUrl: "data:image/png;base64,..." }
  "voice": {
    "enabled": false, // 总开关（关掉时麦克风按钮不出现）
    "engine": "qwen3-voicedesign", // qwen3-voicedesign | qwen3-customvoice | kokoro
    "voice": "成熟女性，中低音区，语速稳，略带气声，克制不撒娇", // 御姐音描述（指令式）
    "speed": 1.0, // 0.5~2.0
    "endpoint": "http://127.0.0.1:8791", // sidecar 地址
    "speakReplies": true, // 是否自动朗读回复
  },
}
```

**校验策略**：`normalizeSoulConfig()` 逐字段白名单兜底——未知 engine（含已下线的 `cosyvoice2`）回落 `qwen3-voicedesign`，speed 夹到 `[0.5, 2]`，endpoint 非 `http://` 开头则回落默认。**读坏文件不允许让整页 500**（与记忆文件的降级策略一致）。

音色为什么是「描述文本」而不是「音色 id」：御姐音不是某个固定音色，而是一组声学倾向。Qwen3-TTS VoiceDesign 接受自然语言音色描述，一次到位，且**不需要参考音频**，避开他人音色的版权问题（见调研 §3.2）。

> 落地时修正：原方案写「CosyVoice2 默认」，但 `mlx-audio 0.6.4` 里没有 CosyVoice2 实现（`ModuleNotFoundError`）。改用 VoiceDesign 后实测音色控制生效——御姐描述 156.9Hz vs 年轻女声 320.0Hz（见调研 §8.6）。

---

## 5. 语音链路（R5/R6）

### 5.1 录音与识别

| 步骤 | 实现                                                                                         | 参数理由                                                                  |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 采集 | `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}})` | 系统级 AEC 免费，按住说话已无回声，但噪声抑制能显著减少 VAD 误判          |
| 编码 | `AudioContext.decodeAudioData` → Float32 → **PCM16 WAV**                                     | Whisper 最终要 16k 单声道；在前端转一次，sidecar 就只吃一种格式           |
| 端点 | 松开按钮即结束（push-to-talk）                                                               | 首版不做自动端点，避免"说到一半被判停"的经典失败                          |
| 识别 | `POST /api/voice/asr`                                                                        | 返回 `{text, durationMs, model}`；空文本（<2 字）不发消息，提示「没听清」 |

**采样率**：不做 48k→16k 的自研重采样，交给 sidecar 侧的 `librosa`/`mlx_whisper` 处理——少写一段易错的 DSP。

### 5.2 朗读与句级流水

关键点（调研 §4.1 第 1 条）：**不等整段回复**。挂在现有 `llm_delta`（累积文本）上：

```
每条 llm_delta 到达 → 把累积文本喂给 SentenceSplitter
  → 切出"新完成的句子"（遇 。！？；\n 或长度 ≥ 60 且遇 ，）
  → 每句入队 → 串行合成 → 顺序播放
```

- 串行而非并行：TTS 是 CPU/GPU 密集，并发会互相拖慢，反而增大首字延迟。
- 首句优先：第一句合成完立刻播，后续句在播放期间合成下一句（预取 1 句）。
- **截断记账**：被打断时把「已听到的句子」与「本轮被截断」写进消息元数据，下一轮提示词可见——否则模型会引用用户根本没听到的内容（调研 §4.1 第 4 条，被反复引用的真实 bug）。

### 5.3 打断（barge-in）

```
播报中 → 麦克风持续采样 → RMS 连续 3 帧超阈值 且 累计 ≥300ms
  → audio.pause() + 清空队列 + 标记 truncated
  → 自动进入"按住说话"提示态（不自动开始录音，避免误录）
```

播报期间阈值上浮 6dB：扬声器外放会被麦克风拾到，阈值不变会「自己打断自己」。

---

## 6. sidecar 设计

| 端点           | 请求                           | 响应                                                                          |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `GET /health`  | —                              | `{ok, python, mlx, asr:{model,ready,reason}, tts:{model,ready,reason}, hint}` |
| `POST /tts`    | `{text, engine, voice, speed}` | `audio/wav`；未就绪 → 503 `{code, reason, installHint}`                       |
| `POST /asr`    | `audio/wav` 原始字节           | `{text, durationMs, model}`                                                   |
| `POST /warmup` | `{}`                           | 触发模型加载（首次 10~30s），供 UI 显示「正在加载」                           |

- **纯标准库 HTTP 服务**（`http.server.ThreadingHTTPServer`）：不引入 FastAPI/uvicorn，减少一层依赖；TTS 本来就是按句请求，长连接收益有限。
- **模型懒加载**：`/health` 不做加载，只检查依赖是否可 import；首次 `/tts` 才加载并缓存。否则「看一眼状态」要等 30 秒。
- **依赖缺失不崩**：`import mlx_audio` 失败时 `/health` 返回 `ready:false` + 安装命令，服务照常活着——用户能看到"缺什么"，而不是连接被拒。

---

## 7. 改动清单

| 文件                                             | 类型    | 说明                                                                                       |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `packages/web/web/public/manul-avatar.png`       | 新增    | 兔狲头像（9.7KB）                                                                          |
| `packages/web/web/build.mjs`                     | 改      | 拷贝 `public/*` → `dist/`                                                                  |
| `packages/core/src/super-agent/soul/types.ts`    | 改      | `SoulAvatarConfig` / `SoulVoiceConfig` / `SoulConfig`                                      |
| `packages/core/src/super-agent/soul/config.ts`   | 新增    | `DEFAULT_SOUL_CONFIG` / `normalizeSoulConfig()` / `resolveVoiceConfig()`（纯函数，零 I/O） |
| `packages/core/src/super-agent/soul-io.ts`       | 改      | `soulConfigPath` / `loadSoulConfig` / `saveSoulConfig`（原子写 0600）                      |
| `packages/web/src/api/soul-api.ts`               | 改      | `GET/PUT /api/soul/config`                                                                 |
| `packages/web/src/api/voice-api.ts`              | 新增    | 三个语音端点 + sidecar 探测                                                                |
| `packages/web/src/server.ts`                     | 改      | 路由接线                                                                                   |
| `packages/web/web/src/api.ts`                    | 改      | `fetchSoulConfig` / `saveSoulConfig` / `voiceStatus` / `tts` / `asr`                       |
| `packages/web/web/src/components/SoulAvatar.tsx` | 新增    | 头像组件（默认/自定义/尺寸）                                                               |
| `packages/web/web/src/components/SoulPane.tsx`   | 改      | 头像区 + 声音配置区                                                                        |
| `packages/web/web/src/components/ChatPane.tsx`   | 改      | 助手气泡头像换成 `SoulAvatar`                                                              |
| `packages/web/web/src/voice/*`                   | 新增    | `wav.ts`（PCM16 编码）/ `sentence.ts`（切句）/ `player.ts`（队列+打断）/ `recorder.ts`     |
| `packages/web/web/src/components/Composer.tsx`   | 改      | 麦克风按钮（按住说话）                                                                     |
| `packages/web/web/src/App.tsx`                   | 改      | 在 `onLlmDelta` 喂句、在卸载时释放                                                         |
| `packages/web/web/src/styles.css`                | 改      | 头像、语音按钮、录音态样式                                                                 |
| `desktop/Info.plist` + `tauri.conf.json`         | 新增/改 | `NSMicrophoneUsageDescription`（**没有它 macOS 直接拒绝 getUserMedia**）                   |
| `scripts/voice/mlx_voice_server.py`              | 新增    | sidecar                                                                                    |
| `scripts/voice/setup.sh`                         | 新增    | uv venv + 装依赖 + 模型预取（含国内镜像提示）                                              |
| `scripts/voice/README.md`                        | 新增    | 三条命令上手                                                                               |

---

## 8. 测试策略（R7）

| 层             | 用例                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内核（纯函数） | 配置 normalize 七种坏输入（未知引擎/超界速度/非 http 地址/超大 dataUrl/null/数组/字符串）；切句（无标点/超长/中英混排/省略号）；WAV 头字段（采样率/声道/位深/长度） |
| 引擎端点       | 未登录 401；配置读写往返；语音未装 sidecar → 503 带 hint（不是 500）；TTS 转发透传 wav Content-Type                                                                 |
| 渲染           | `SoulAvatar` 默认渲染 `/manul-avatar.png`；custom 渲染 dataUrl；`SoulPane` 在无 sidecar 时显示「未安装」而不是空白                                                  |
| 真机           | macOS 上 `setup.sh` → `mlx_voice_server.py` → 引擎 → 按住说话 → 听到御姐音回复 → 打断                                                                               |

---

## 9. 评审结论（详见 `reviews-4-roles.md`）

待四角色评审后回填。**已知会在评审中被挑的三处**（我先自己指出，免得当成没看见）：

1. **前端 WAV 重采样**：`decodeAudioData` 得到设备采样率（多为 48k），我选择"原样打包 48k PCM16 WAV，由 sidecar 重采样"。代价是上传体积 ×3（60 秒 ≈ 5.5MB）。局域网回环下可接受，但远程引擎场景会疼。
2. **打断检测用 RMS**：RMS 对突发噪声（敲键盘）敏感，阈值调不好会频繁误打断。缓解：连续 3 帧 + 300ms 下限 + 播报期阈值上浮。
3. **`llm_delta` 喂句**：若模型输出代码块，把 ` ``` ` 内容朗读出来会很蠢。需在切句前剥离代码块与 Markdown 标记（首版做保守剥离，不追求完美）。
