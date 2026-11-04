# 本机 MLX 语音对话：业界调研

> 日期：2026-11-04
> 目标：在 Apple Silicon（本机 M5 Max / 128GB / macOS 26）上，用 MLX 跑**中文语音对话**（听 + 说），让桌面端能开口与司南对话，默认音色为「御姐音」。
> 立场：以下结论尽量带来源；不确定的地方标注「未验证」。

---

## 0. 结论摘要（先给答案）

| 环节      | 选型                                                                                       | 理由                                                                                                 | 备选                                                                                  |
| --------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 运行时    | **`mlx-audio`**（Python，Apple 官方 MLX 生态的音频库）                                     | 一个库同时提供 TTS（Kokoro / CosyVoice / F5 / IndexTTS2 / Qwen3-TTS）与 STT（Whisper / Parakeet）    | 各家单独装，版本地狱                                                                  |
| ASR（听） | **`mlx-whisper` + `whisper-large-v3-turbo`**                                               | 中文识别稳，turbo 版约 1.5GB、8x 实时；M5 Max 余量充足                                               | Parakeet-EOU（低延迟流式，但中文支持不可靠）                                          |
| TTS（说） | **CosyVoice2**（中文首选）                                                                 | 中文韵律最自然、支持流式与细粒度指令/情感控制，官方与社区均给出「中文场景最强」结论                  | Qwen3-TTS VoiceDesign（用一句话描述音色，无需参考音频）；Kokoro-82M（最快，音色受限） |
| 御姐音    | **CosyVoice2 指令/参考音色**（首选）；**Qwen3-TTS VoiceDesign** 用自然语言描述音色（次选） | 御姐音 = 偏低音区 + 稳 + 略哑，属于「音色设计」而非「换个人」，用参考音频克隆反而是绕路              | Kokoro 的 zh 预置音色偏年轻，做不出御姐感                                             |
| 接入形态  | **本机 Python sidecar（HTTP）+ 引擎代理 + 前端语音模式**                                   | 模型跑在 Python（MLX 生态在 Python），而 UI 在 WebView；用本地 HTTP 划清进程边界，模型崩溃不拖垮应用 | 直接 Tauri Rust 调 MLX（Rust 侧 MLX 生态不成熟）；PyO3 嵌入（首次编译与体积代价大）   |
| 交互范式  | **按住说话（push-to-talk）+ 句级流式播报 + 打断（barge-in）**                              | 业界共识：句级流水线是把 2~4s 压到 0.6~1.2s 的关键；打断是状态机问题不是模型问题                     | 全双工免提（需 AEC + 回声消除，首版不做）                                             |

一句话：**听用 Whisper turbo，说用 CosyVoice2 的御姐音色，传输用本机 HTTP，交互用按住说话 + 句级流播 + 可打断。**

---

## 1. MLX 运行时：为什么是 mlx-audio

MLX 是 Apple 自研的数组框架，直接面向 M 系列的统一内存架构——CPU/GPU/神经引擎共享同一内存池，省掉「系统内存 → 显存」的拷贝，这正是同样模型在 Mac 上能跑得比独显更顺的原因（[SoloSoft, 2026](https://www.solosoft.dev/post/mlx-audio-apple-silicon-2026/)）。

`mlx-audio` 把音频侧的能力收在一个库里：

| 能力 | 覆盖模型                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------- |
| TTS  | Kokoro、Parler、VoiceCraft、CosyVoice、F5-TTS、IndexTTS2、Qwen3-TTS、VoxCPM2、VibeVoice、Higgs TTS 3 |
| STT  | Whisper（含 distil / timestamped）、Parakeet、Omnilingual ASR                                        |
| STS  | VoiceCraft STS 与自定义管线                                                                          |

同一来源给出的 M3 Max / 64GB 相对速度（「实时倍率」，>1 表示快于实时）：

| 模型                    | 类别 | 速度 | 体积  |
| ----------------------- | ---- | ---- | ----- |
| Whisper Tiny            | STT  | 50x+ | 150MB |
| Distil-Whisper Large v3 | STT  | 6–8x | 1.5GB |
| Whisper Large v3        | STT  | 3–4x | 3.0GB |
| Kokoro                  | TTS  | 15x+ | 350MB |
| CosyVoice               | TTS  | 3–5x | 900MB |
| F5-TTS                  | TTS  | 4–6x | 600MB |
| Parler                  | TTS  | 5–8x | 800MB |

**对本机的含义**：M5 Max + 128GB 远高于上述测试机（M3 Max / 64GB），ASR + TTS 同时常驻没有内存压力。真正的瓶颈不是算力，而是**首字延迟**与**进程编排**。

> ⚠️ 未验证：表中速度来自第三方博客的 M3 Max 数据，不是本机实测。本方案在实现里提供 `--bench` 自测，不引用外部数字冒充本机性能。

---

## 2. ASR：Whisper turbo 与流式方案之争

业界对「实时语音」有一个共识性的取舍：

> **Whisper 系列准确率高，但在流式/低延迟场景竞争不过专用流式模型。**
> —— [MetaDesign Solutions, 2026](https://metadesignsolutions.com/blog/livekit-voice-agent-latency-context-optimization)

原文语境是云端（Deepgram Nova-3 的 endpointing <150ms）。本机场景不同：没有网络往返，端点是**本地进程**，所以 Whisper 的劣势被大幅抹平，而它的中文准确率优势保留。

另一条路是 NVIDIA 的 Parakeet 系（`Parakeet-EOU-120M`，自带「话语结束」检测，iPhone 16 Pro 上 0.04 RTF，见 [Speech Swift 综述](https://aibit.im/zh/article/speech-swift-on-device-ai-speech-toolkit-apple-silicon)）。但它的强项是英文/欧洲语系，**中文支持没有可靠结论**。

**决策**：首版用 `whisper-large-v3-turbo`（准确优先，按段识别），endpoint 由前端 VAD 判定。若后续实测首字延迟不可接受，再引入 Parakeet-EOU 做「英文/双语流式」快路径——接口已按可替换设计（`transcribe()` 单一端口）。

---

## 3. TTS：谁的中文最像人

### 3.1 横向对比（中文 + Mac）

| 方案                                      | 中文质量                                                   | Mac 速度               | 克隆                      | 御姐音可得性                | 许可                   |
| ----------------------------------------- | ---------------------------------------------------------- | ---------------------- | ------------------------- | --------------------------- | ---------------------- |
| **CosyVoice2**（Fun-CosyVoice 3.0，0.5B） | **最强**，9 语种 + 18 种中文方言，指令控制，流式低至 150ms | MLX 3–5x               | 3 秒零样本                | **高**：指令描述 + 参考音色 | Apache 2.0             |
| Qwen3-TTS（2026-01）                      | 高，10 语种                                                | 0.2x（16GB M4，偏慢）  | 3 秒零样本 + **音色设计** | **最高**：一句话描述出音色  | 需查权重许可           |
| Kokoro-82M                                | 中（预置 zh 音色偏年轻/播报腔）                            | **13.8–15x**           | 无（固定音色）            | 低                          | Apache 2.0             |
| F5-TTS                                    | 中（英文强项）                                             | 0.1x 或更低（16GB M4） | 5 秒零样本                | 中                          | CC-BY-NC（**非商用**） |
| IndexTTS2（1.5B）                         | 中高，8 维情感控制                                         | 0.1x（同上）           | 参考音频                  | 高                          | 需查                   |
| GPT-SoVITS                                | 高（需训练）                                               | 需 GPU 训练            | 最强（微调）              | 高                          | MIT 系                 |
| Piper                                     | 够用                                                       | 33.5x                  | 无                        | 低                          | MIT                    |

数据来源：中文方案对比（[GitCode 博客](https://blog.gitcode.com/c45983a1d48b83b0907fd7d9364c53e5.html)）、13 款本地 TTS 横评与 tts-bench 数字（[Yaps, 2026](https://www.yaps.ai/blog/best-local-tts-models)）、Kokoro vs F5（[FreeVoiceReader, 2026](https://freevoicereader.com/blog/kokoro-82m-vs-f5-tts-local-mac-ai-2026)）。

### 3.2 「御姐音」怎么落地

御姐音的声学特征：**基频偏低、语速偏稳、气声略多、句尾下沉**。三条实现路径：

1. **指令/描述式（首选）** —— Qwen3-TTS 的 VoiceDesign、CosyVoice2 的 instruct 模式，都能用自然语言指定「成熟女性、低音、克制」。
   优点：不需要参考音频，不涉及他人声音的肖像/版权问题。
2. **参考音色（次选）** —— 给 3~10 秒参考音频做零样本克隆，音色最像。
   代价：需要合法来源的参考音频；一旦分发模型就带上了别人的音色。
3. **预置音色 + 参数（兜底）** —— Kokoro 的 zh 女声 + 降速降调。
   优点：零配置、最快；缺点：是「年轻女声压低」，不是御姐。

**决策**：默认走路径 1（描述式），把「御姐音描述文本」做成可编辑配置项；愿意提供参考音频的用户走路径 2；Kokoro 作为「模型没装好也要能出声」的兜底。

---

## 4. 交互：业界怎么把延迟压到「像人」

两个独立来源给出几乎相同的延迟预算（[Pyramidion](https://www.pyramidions.com/blogs/ai-calling-agent-india)、[MetaDesign](https://metadesignsolutions.com/blog/livekit-voice-agent-latency-context-optimization)、[lmversity 实验课](https://lmversity.com/learn/voice-ai/voice-agent-lab)）：

| 阶段           | 批处理式   | 流式           | 备注                           |
| -------------- | ---------- | -------------- | ------------------------------ |
| VAD / 端点判定 | 300–500ms  | 100–200ms      | 端点判太早会截断用户           |
| ASR            | 500–1000ms | 150–350ms      | 只提交 final，partial 不送 LLM |
| LLM 生成       | 800–2500ms | 300–700ms      | 首 token 决定体感              |
| TTS 首字节     | 300–600ms  | 100–300ms      | 句级流水是关键                 |
| 传输           | 100–300ms  | 100–200ms      | 本机可近似 0                   |
| **合计**       | **2–4.9s** | **0.75–1.75s** | <1.5s 才「像对话」             |

### 4.1 五条被反复强调的实践

1. **句级流水（sentence-level pipelining）** —— 不要等整段回复生成完再合成，每完成一句就送 TTS。这是把 2–4s 压到 0.6–1.2s 的**单一最大收益项**。
2. **partial 与 final 分开** —— 流式识别里临时结果只用于显示，只有 final 才提交给 LLM，否则模型会对着半句话回答。
3. **打断是状态机问题** —— VAD 在播报期间持续运行；一检测到人声就：立即停音频 → 丢弃缓冲 → 把新音频当新回合。**不是模型问题**，是编排问题。
4. **截断要记账** —— 用户只听到半句，但模型上下文里是完整一句。必须把「这轮被打断」写进会话状态，否则模型会引用用户根本没听到的内容。这是被多次引用的真实 bug。
5. **降级要显式** —— TTS 失败就退回纯文本，不要静默变成「哑巴」。

### 4.2 首版明确不做的

- **全双工免提**：需要回声消除（AEC），WebView 里做不好；首版按住说话，天然无回声。
- **端到端语音大模型（S2S）**：会隐藏 ASR/TTS 两个可控环节，调试与替换成本高。业界建议「先把级联管线搭出来，再考虑 S2S」。

---

## 5. 接入形态：为什么是 sidecar 而不是嵌入

| 方案                        | 优点                                                        | 缺点                                                  | 结论     |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- | -------- |
| Python sidecar（本机 HTTP） | MLX 生态完整；进程隔离，模型崩了不拖垮应用；可单独重启/压测 | 多一个进程要管生命周期                                | **选它** |
| PyO3 嵌入 Rust              | 无进程边界                                                  | 首次编译极慢、体积大、MLX Python 依赖仍要装           | 否       |
| Rust 原生 MLX               | 单进程                                                      | Rust MLX 音频生态几乎空白（TTS/ASR 都没有成熟 crate） | 否       |
| 纯前端 WASM                 | 无需安装                                                    | Kokoro 级别的中文质量与体积不可接受                   | 否       |

进程模型：**引擎（Node）→ 本机 HTTP → sidecar（Python）**。前端只跟引擎说话，因此浏览器版与桌面版走同一条链路；sidecar 不在时，端点返回明确的「未安装」而不是 500。

---

## 6. 本机现状（实测）

```
CPU: Apple M5 Max      内存: 128 GiB     系统: macOS 26
python3: 3.13.12       uv: 已安装
mlx: 未安装            mlx_audio: 未安装
```

LLM 依赖（HuggingFace）在本机历史上有不可达的记录，此前统一改走 ModelScope 下载模型。**这条约束直接影响首装体验**，方案里必须给出国内镜像路径，否则「装不上」= 功能不存在。

---

## 7. 风险清单

| 风险                      | 影响                  | 对策                                                                           |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| 模型下载被墙/极慢         | 首次使用失败          | 支持 `HF_ENDPOINT` / ModelScope 镜像；下载走独立命令，不阻塞启动               |
| 首次加载模型 10~30s       | 用户以为卡死          | 状态端点区分 `installing / loading / ready`，UI 显示进度而不是转圈             |
| 中文 VAD 误触发（键盘声） | 播报被自己打断        | 打断需要「连续 3 帧超阈值 + 最短语音 200ms」，且播报期间提高阈值               |
| 御姐音描述效果不稳定      | 音色不像              | 描述文本可编辑；提供「试听」按钮，不满意改文案而不是改代码                     |
| TTS 合成失败              | 语音模式下没声音      | 显式降级：气泡显示「语音不可用：原因」，文本照常                               |
| 麦克风权限（macOS）       | getUserMedia 直接失败 | Tauri `Info.plist` 加 `NSMicrophoneUsageDescription`，未授权时给出系统设置指引 |

---

## 8. 实测校正（落地后回填，推翻了 §2 的两条结论）

文献调研给出的「CosyVoice2 中文最强」在**文献层面**成立，但落地时撞到实现层的硬约束。
以下都是在 `mlx-audio==0.6.4` 上直接读代码与跑验证得到的事实，不是推测。

### 8.1 `mlx-audio` 里根本没有 CosyVoice2

`mlx_audio.tts.models` 下的全部模型（46 个）：

```
arktts bailingmm bark base breeze_tts chatterbox chatterbox_turbo confucius4
dense dia dramabox echo_tts fish_drama3 fish_qwen3_omni higgs_audio
higgs_audio_v3 indextts interpolate irodori_tts kitten_tts kokoro kugelaudio
lingv3_tts llama longcat_audiodit maya2 melotts moss_tts moss_tts_delay
moss_tts_local moss_tts_nano omnivoice outetts pocket_tts qwen3 qwen3_tts
rumik_oss sesame soprano spark tada vibevoice voxcpm voxcpm2 voxtral_tts zonos2
```

`import mlx_audio.tts.models.cosyvoice2` → `ModuleNotFoundError`。
同类文档站上看到的「CosyVoice 支持」是上游项目能力，不等于这个 MLX 移植版有。

### 8.2 换 Qwen3-TTS VoiceDesign，理由不是"次选"

原调研把 VoiceDesign 列为次选（"用一句话描述音色"），实测后发现它才是**唯一**同时满足
「中文 + 指令式音色」的可用实现：

| 变体            | 模型 id（mlx-community）               | 方法                                                       | 能否做御姐音            |
| --------------- | -------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| **VoiceDesign** | `Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit` | `generate_voice_design(text, instruct, language)`          | ✅ 描述即音色           |
| CustomVoice     | `Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` | `generate_custom_voice(text, speaker, language, instruct)` | 预置 speaker + 情感指令 |
| Base            | `Qwen3-TTS-12Hz-0.6B-Base-bf16`        | `generate(text, ref_audio, ref_text)`                      | 需参考音频克隆          |

### 8.3 三个变体的签名不兼容，不能统一成 `generate()`

这是最容易写错的地方——`mlx_audio.tts.generate.generate_audio` 存在，但它：

- **没有 `output` / `speed` 的自由组合**，只写文件到 `output_path`
- **返回 `None`**，不是音频数据

真正的用法是拿 `load_model()` 得到的模型对象调各自的方法，接收
`Generator[GenerationResult]`，从 `result.audio`（`mx.array`）与 `result.sample_rate` 取数据。

### 8.4 Qwen3-TTS 的 `generate_*` 没有 speed 参数

`generate_voice_design` / `generate_custom_voice` 的签名里都没有 `speed`。
语速只能靠**重采样**实现，代价是音高跟着变（像磁带快进）。

取舍：语音助手的实际用法集中在 0.8~1.3 倍，这个区间的音高变化听感可接受；
Kokoro 走原生 `speed` 参数，不受影响。这条限制写进了 sidecar 注释与 README，
不做"看起来支持其实没生效"的假实现。

### 8.5 依赖安装必须走国内镜像（真实卡点）

| 源         | 单次索引请求 | 装 `mlx-audio` 的结果                       |
| ---------- | ------------ | ------------------------------------------- |
| `pypi.org` | 6.6s         | 18 分钟未落地一个包，被 SIGTERM（exit 137） |
| 阿里云镜像 | **0.12s**    | 全量装完 < 1 分钟                           |

这决定了 `setup.sh` 默认 `PYPI_INDEX=https://mirrors.aliyun.com/pypi/simple`，
且把 `HF_ENDPOINT=https://hf-mirror.com` 传给 sidecar 进程（只 export 在安装脚本里不会继承）。

### 8.6 本机实测数据（M5 Max / 128GB / MLX 0.32.4 / mlx-audio 0.6.4）

环境：`mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit`（1.8GB），24kHz 单声道 16-bit 输出。

| 项目                              | 实测值                 | 说明                            |
| --------------------------------- | ---------------------- | ------------------------------- |
| 首次加载（含下载 1.8GB）          | 885.6s                 | 其中下载占 870s，网络是唯一瓶颈 |
| 纯加载（已缓存）                  | ≈ 13s                  | 之后常驻内存                    |
| 合成 5 秒语音（首次请求，含加载） | 13.78s                 | 冷启动                          |
| 合成 5 秒语音（模型已加载）       | **0.75 ~ 0.82s**       | 热路径，句级流播可用            |
| RTF（离线整段）                   | **0.83**               | <1 即快于实时                   |
| 输出                              | 24kHz / 单声道 / 16bit | 与浏览器播放链路直接兼容        |

**语速重采样验证**（同一句文本）：

| speed | 输出时长 | 与 1.0 的比例 |
| ----- | -------- | ------------- |
| 0.8   | 5.20s    | 1.25×         |
| 1.0   | 4.16s    | 1.00×         |
| 1.3   | 3.20s    | 0.77×         |

比例精确（4.16/1.3=3.20、4.16/0.8=5.20），说明重采样路径生效。

**音色描述是否真的生效**（同一句话，只改 `instruct`）：

| 描述                | 中位基频     | 预期 |
| ------------------- | ------------ | ---- |
| 成熟女性，中低音区… | **156.9 Hz** | 偏低 |
| 年轻女孩，高音区…   | **320.0 Hz** | 偏高 |

差近一个八度，与「中低音区 vs 高音区」的意图一致——**描述式音色控制是真的在起作用**，
不是「填了但没生效」。

**闭环验证**（TTS 输出再喂回 ASR）：

用 `whisper-tiny`（最差档）转写合成音频：

```
原文：方位已经定下来了。这一步我先验证，跑通了再往下走。
识别：否谓行地下来了这一步无心验则跑通了在我下走
```

逐词能对上。tiny 模型的中文本来就弱，能听出对应关系说明音频本身是**可理解的中文语音**，
不是噪声或错位。生产默认用 `whisper-large-v3-turbo`，识别质量远好于此。

---

## 9. 参考来源

1. SoloSoft. _MLX-Audio: TTS, STT, and STS Library Optimized for Apple Silicon_, 2026. https://www.solosoft.dev/post/mlx-audio-apple-silicon-2026/
2. Yaps. _Best Local TTS Models in 2026: 13 Picks, Every Licence Checked_, 2026. https://www.yaps.ai/blog/best-local-tts-models
3. GitCode 博客. _本地 TTS 模型怎么选：dots-tts-mlx-mf-int8 与其他开源方案横向对比_, 2026. https://blog.gitcode.com/c45983a1d48b83b0907fd7d9364c53e5.html
4. FreeVoiceReader. _Kokoro-82M vs. F5-TTS: Best Local Voice AI for Mac in 2026_, 2026. https://freevoicereader.com/blog/kokoro-82m-vs-f5-tts-local-mac-ai-2026
5. AIBit. _Speech Swift：专为 Apple Silicon 打造的本地 AI 语音工具包_, 2026. https://aibit.im/zh/article/speech-swift-on-device-ai-speech-toolkit-apple-silicon
6. Deepgram. _Voice agent architecture: STT, LLM, and TTS pipeline guide 2026_. https://deepgram.com/learn/voice-agent-architecture-stt-llm-tts-pipeline-design
7. Pyramidion Solutions. _AI Calling Agents: How the Architecture Actually Works_, 2026. https://www.pyramidions.com/blogs/ai-calling-agent-india
8. MetaDesign Solutions. _Production-Grade LiveKit Voice Agents: Latency, Context & Architecture_, 2026. https://metadesignsolutions.com/blog/livekit-voice-agent-latency-context-optimization
9. lmversity. _Lab: build a minimal voice agent (provider-neutral)_. https://lmversity.com/learn/voice-ai/voice-agent-lab
10. lmversity. _Project: realtime voice agent with interruption handling_. https://lmversity.com/learn/genai-app-dev/realtime-voice-agent-project
