# TNS 验收遗留问题：修复方案调研 + 真机 A/B 验证

- 日期：2026-11-07
- 环境：本机 sidecar `127.0.0.1:8791`，pid `63076`，`tns-1.0`，`qwen3-customvoice` / `sinan` / `speed=1.2`
- 输入报告：`tns-acceptance-2026-11-07.md`（7 项残留违规）、`mixed-matrix-acceptance-2026-11-07.md`、`tns-scenes-report-2026-11-07.md`
- 本轮产物：`scripts/voice/chunking_ab_probe.py`、`scripts/voice/short_block_probe.py`（均为**只读实验探针**）、本报告
- 产物目录：`/tmp/dcx-chunking-ab/run/`（真机 A/B 逐块 JSON）、`/tmp/dcx-chunking-ab/numxs/`（短块 WAV + 根因报告）

> **结论先行**：有可落地的修复方案，而且最关键的那一处已经用真机 A/B 证明。
> 唯一与 TNS 相关的残留违规 `code:xl` 块间语速极差 **43.71% → 6.84%**（阈值 ≤8%，达标），
> 做法是「前端别把 JSON / URL / 拉丁词 / 数字串切碎」，**不需要在 TS 里再实现一份 TNS 规则，
> 不需要改服务端 TNS、不需要改网关、不需要换模型**。其余 6 项属于 TNS 打开前就有的历史边界：
> 短数字块与无标点首块有部分修复方案（各有明确代价），跨段音色属模型层限制。
> **本轮没有改任何生产链路代码**，只新增可复现探针与调研结论，落地与否待你拍板。

---

## 1. 遗留问题清单与逐条结论

`031f1cc2` 的 25 格矩阵 on 组共 7 项违规，验收报告已归因：6 项是打开前就有的历史边界，仅 `code:xl` 与本轮能力相关。

| # | 遗留问题 | on 实测 | 阈值 | TNS 相关 | 本轮调研结论 |
|---|---|---:|---:|---|---|
| 1 | `code:xl` 块间语速极差 | 43.71% | ≤8% | ⏳ 是 | ✅ **有解且真机验证达标**：结构感知分块 → 6.84%，见 §5 |
| 2 | `num:xs` 单块语速偏差 | 20.57%（3.91 u/s） | ≤20% | ❌ 历史 | ⏳ **有解**：根因是短句句内静音 0.9s，服务端短块静音上限可修，见 §6（离线模拟） |
| 3 | `plain:m/l/xl` 首块 TTFA | 2203 / 2266 / 2070ms | ≤2000ms | ❌ 历史 | ⏳ **部分有解**：首块快路径 1851→838ms，但 F0 极差翻倍，见 §5 |
| 4 | 全局 TTFA P95 | 2176ms | ≤1500ms | ❌ 历史 | ❌ **架构性边界**：非首块仍 1.8~2.4s，严格伺服数学下无零代价解，见 §7 |
| 5 | 全局跨语料语速极差 | 21.46% | ≤12% | ❌ 历史 | ⏳ 由 #2 单块离群造成；修 #2 可改善但不必然达标，见 §6 |
| 6 | 大写下划线标识符连读 | `DCXViewWithRadiusEverAll` | — | ⏳ 边界 | ⏳ **运营型方案**：术语表/发音词典版本化，规则集无法一次穷尽，见 §2/§7 |
| 7 | 中英混排时间窗 F0 起伏 | 21.11%~53.84% | ≤40%（块间） | ❌ 历史 | ❌ **模型层限制**：本地 Qwen3-TTS 无跨请求韵律状态，见 §2/§7 |

另有三项诚实边界（非门禁违规）：看到的字 ≠ 听到的字、网关不透传 `tns`、桌面 WebView 真机听感未验证。

---

## 2. 业界方案（2026 跨源调研）

### 2.1 文本前端 TN：分层是共识，不是「再写一份规则」

| 路线 | 代表 | 强/弱证据 | 对本项目的意义 |
|---|---|---|---|
| 确定性规则 / FST | Google Kestrel、NVIDIA NeMo TN、wetext、PaddleSpeech、Ming-3.0（pynini，Artificial Analysis 缩写扩展 96.5%） | 强（工程事实）/ 厂商榜单为弱 | 现有 `text_normalize.py` 的路线是对的：可审计、可回滚、零幻觉 |
| 神经 seq2seq / 两阶段 tagger+verbalizer | Ro et al.、NeMo duplex | 强（论文） | 处理上下文歧义，但有「不可恢复的改义错误」风险 |
| LLM / 小模型流式 TN | **StreamTN**（Qwen3-0.6B 双轨，IEEE SLT 2026，arXiv:2609.24267）、FireRedTTS3 `wetext + llm_tn` 双轨 | 强（论文/开源实现） | 直调通用 LLM 做 TN 有首 token 延迟、幻觉、污染主模型三大问题；专用小模型才可行 |
| LLM-TN 效果对照 | EmergentTTS-Eval：复杂发音胜率 无 TN 51.69% / WeText 基础 TN 50.06% / **GPT-4.1-mini TN 76.74%** | 强（基准，model-as-judge） | 基础规则 TN 在复杂发音上可能反而不如不做；**别把「多写规则」当万能解** |

生产共识：规则打底高频无歧义项，神经/小模型兜底长尾；保留原文与规范化文本双份 + 字符 offset 映射；术语表当**带版本的数据资产**而不是硬编码。

### 2.2 结构感知分块：本报告 `code:xl` 的直接答案

- Smallest.ai 长文本指南：**「Never split inside a number, abbreviation, quoted phrase, or pronunciation token」**；按语义边界（段落 > 章节 > 句末 > 分句）切，而不是按字符数；块大小留 20~30% headroom。
- 结构化文本朗读的正确做法是 **parse 结构 → 线性口语重写**，不是往 TTS 里塞 SSML；流式下 SSML 常被剥离或拆分标签跨块失效。
- vocal-stack / ttspipe 的 `chunkText` 会「hold the stream long enough to find a useful speech boundary」，边界判定要保护 `Dr.`、小数点、省略号；Kokoros 用三遍切分（标点 → 长块中心回扫 → 词边界）。
- AIRI 的设计文档明确指出「文本切片同时承担低 TTFA 与 UI 字幕时钟」是双用途陷阱，切碎会丢疑问尾调、自回归状态与跨块语速。

### 2.3 首块延迟与跨块韵律

| 手段 | 代表 | 代价 |
|---|---|---|
| 首块快路径（3~6 词先播，其余整块后补） | AIRI hybrid、Pipecat 句级聚合、ElevenLabs `chunk_length_schedule [120,160,250,290]` + `flush` | 丢字幕时间对齐；块边界变多，语调更碎 |
| 动态 frame accumulation（首片低帧数、后续提高） | Baseten Qwen3-TTS 部署 | 需改推理服务，本项目 `iter_stream` 收齐整段才 yield，不适用 |
| 请求级上下文 | ElevenLabs `previous_request_ids`（≤3）、Cartesia `context_id`+`continue`、Deepgram Flux 跨轮 state 不重置 | 需要模型/服务支持；本地 Qwen3-TTS 无此接口 |
| 推理期状态传递（不重训） | MagpieTTS-LF（NVIDIA NeMo，Interspeech 2026）：soft attention prior + 有状态推理 + 历史文本编码 | 论文自评，缺第三方生产复现；需改推理栈 |
| 训练期分块感知 | CosyVoice 2 chunk-aware causal flow matching | 需换模型权重/重训，丢本地司南音色 |
| 固定 voice profile | 同一 speaker embedding + seed + 模型版本/参数哈希、无损中间格式 | 本项目**已做**（`sinan→serena`、固定 instruct/seed、温度 0.35、同文本 PCM 逐位一致） |
| 后处理 crossfade | 50~200ms 静音 / 线性淡化 | 只修爆音，**修不了已经生成的错误句末语调** |

延迟口径提醒：Coval 2026-10 独立实测 ElevenLabs Flash v2.5 中位 188ms、Cartesia Sonic 3.6 中位 289ms，与厂商 75/40~90ms 口径方向相反；要买 p95/p99，不要买中位数。

### 2.4 评测

用真实文档而非单句；把「TN 错误」与「模型发音错误」分开统计；测 p95；专门听块与块、章与章的边界。本项目已有的 15 场景 ASR 回听 + 25 格矩阵 + 五时间戳就属于这一层，方向正确。

---

## 3. 本仓库根因再定位（亲自核验，纠正一处关键理解）

**服务端顺序其实是对的**，这决定了修复可以很小：

```
_handle_tts_stream()  →  apply_tns(整个请求 text)      # mlx_voice_server.py:1911/1967
                      →  iter_stream()                 # :877
                      →  split_long_text(规范化后文本)  # :915, 定义 :581-622
                      →  逐段生成 + 逐段语速伺服
```

也就是说，只要**一个请求里能看到完整的 `{...}`**，TNS 就能还原结构，随后按 48 字切的是**已经变成中文的文本**，不会再切坏 JSON。报告里「服务端逐块执行 TNS 只看到半截 JSON」是结果，不是服务端设计缺陷。

真正把结构切碎的是前端两处（比验收报告记录的 48 字硬切多一处）：

| 位置 | 问题 |
|---|---|
| `packages/web/web/src/voice/sentence.ts:90-120` `takeSentences()` | `STRONG/WEAK_BREAKS` 含 `,` 与 `:`，且 `WEAK_BREAK_MIN_LENGTH=28`；JSON 内部的 `true,`、`: ` 会被当成断句点。**这一处验收报告没有单独列出** |
| `packages/web/web/src/voice/player.ts:367-396` `splitLongText()` | 从 48 字回扫句读标点，找不到就 `cut = limit` 硬切，不看词/结构边界；`:165` 的 `SPLIT_PUNCT` 也没有 `{} [] () " '` |
| `player.ts:201-228` `rebalanceShortBlock()` | `splitBoundaryClass()` 只是**软排序**，`valid` 为空时仍会选一个落在词中间的切点 |

基线逐块证据（`code:xl`，26 块，5 处切断原子）：

```text
#02  POST https://127.0.0.1:          ← URL 被切
#03  8791/tts/stream 的 body 是 {text, ← JSON 被切
#04  engine, voice, speed}，别漏 …
#13  入口是 GET /api/voice/health，返回 {ok:  ← JSON 被切（报告里的 #14/#15 离群块）
#14  true, model: {asr, tts}}，超时设成 3000ms 就够。
```

另有：`packages/web/src/api/voice-api.ts:308 / :383` 重建请求体时不带 `tns`，桌面端沿用 sidecar 默认值（已打开，功能不受影响），但请求级开关无法经网关做 A/B 灰度。

**结论**：不需要「前端也做 TNS」（报告里的对照实验只降到 27.39%，还把 `voice` 切成 `v`/`oice`），正确修法是让前端**别把原子结构切碎**。

---

## 4. 方案矩阵

| 问题 | 方案 | 改动点 | 代价 | 验证状态 | 建议 |
|---|---|---|---|---|---|
| `code:xl` 43.71% | 结构感知分块（原子 span 保护） | 前端 `sentence.ts` / `player.ts`；服务端 `split_long_text`；探针 `longtext_probe.py` 同步 | 块长可到 59 字（依赖服务端二次切分）；块数 26→23 | ✅ 真机 A/B 43.71→6.84% | **P0，建议实施** |
| `num:xs` 20.57% | 短块句内静音上限（≤20 单元启用 0.3s cap） | `mlx_voice_server.py` `compress_internal_gaps()` | 短句停顿变短，需听感确认 | ⏳ 离线模拟达标，未改服务端 | P1 A/B |
| `plain` 首块 TTFA | 首块快路径（无标点长串首块 ≤20 字） | `player.ts` `splitLongText` 首块特例 | F0 极差 15.60→34.00%，多 1 块 | ⏳ 真机 1851→838ms | P1，默认关 |
| 全局 TTFA P95 | 首片预吐 `DCX_VOICE_FIRST_CHUNK_PREEMIT` | `iter_stream()` | 双 WSOLA 时间轴、锁粒度、字数分配三笔代价，README:644 已评估暂不落地 | ⏳ 未实施 | P2，需先补判据 |
| 大写下划线标识符 | 术语表/发音词典数据化 + 版本 + 每条 fixture | `text_normalize.py` + 新数据文件 | 运营维护，规则集无法穷尽 | ⏳ 未实施 | P2 运营 |
| 跨段 F0 起伏 | 跨请求韵律状态 | 换模型/改推理栈 | 丢本地司南音色、丢确定性 PCM 一致 | ❌ 本地模型不支持 | 不建议本轮动 |
| 网关 `tns` 不透传 | 白名单透传 `tns` + `/api/voice/normalize` 只读路由 | `voice-api.ts` / `server.ts` | 需鉴权与字段白名单 | ⏳ 未实施 | P1 小改 |
| WebView 真机听感 | 用 `/tmp/dcx-tns-final/audio/ab-*.wav` 人工 A/B | — | 桌面引擎独立 JWT，脚本不能代跑 | ❌ 无法由代码修 | 需你本人确认 |

---

## 5. 真机 A/B：结构感知分块（本轮实证）

**方法**：复用 `mixed_matrix_probe.run_cell()` 的全部指标与阈值（同一份 `mixed-matrix-thresholds.json`、同一语料、同一 sidecar、同一时段），只在内存里替换 `lp.frontend_blocks()`；`baseline` = 现有 48 字硬切，`atomic` = 加原子保护，`atomic_firstshort` = 再加无标点首块快路径。没有删语料、改口径或放宽阈值。

### 5.1 离线切分质量（先证明切得对，再谈听感）

| 格子 | 方案 | 块数 | 切断原子 | 最长块 | 最短非首块 | 逐字可逆 |
|---|---|---:|---:|---:|---:|---|
| `code:xl` | baseline | 26 | **5** | 48 字 | 10.0 单元 | ✅ |
| `code:xl` | atomic | 23 | **0** | 59 字 | 10.0 单元 | ✅ |
| `plain:xl` | baseline / atomic | 12 | 0 | 48 字 | 10.0 单元 | ✅ |
| `plain:xl` | atomic_firstshort | 13 | 0 | 48 字 | 10.0 单元 | ✅ |

原子定义：成对 `{} [] ()`（含嵌套与未闭合）、ASCII URL、文件路径、拉丁词（含连字符/点号复合词）、数字串。切点落在原子边界可以，落在内部禁止；找不到合法切点且原子横跨 48 字时，把切点后移到原子尾部（最长 59 字），交给服务端规范化后二次切分；单个原子 >96 字才诚实降级硬切。

### 5.2 真机指标

| 格子 / 方案 | 块数 | 语速极差 | 中位 u/s | F0 极差 | 首块 TTFA | TTFA P95 | 最长静音 | 块间静音 | 最短非首块 | RTF | 采集 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `code:xl` baseline | 26 | **43.71%** ❌ | 4.91 | 32.41% | 674ms | 1829ms | 460ms | 107ms | 11.6 | 0.254 | ✅ |
| `code:xl` **atomic** | 23 | **6.84%** ✅ | 4.89 | 23.94% | 660ms | 1849ms | 500ms | 85ms | 10.6 | 0.265 | ✅ |
| `code:xl` atomic_firstshort | 23 | 6.84% ✅ | 4.89 | 23.94% | 678ms | 1985ms | 500ms | 85ms | 10.6 | 0.278 | ✅ |
| `plain:xl` baseline | 12 | 1.24% | 4.93 | 15.60% | 1851ms ✅ | **2527ms** ❌ | 700ms | 91ms | 10.0 | 0.221 | ✅ |
| `plain:xl` atomic | 12 | 1.24% | 4.93 | 15.60% | 1834ms | 2397ms | 700ms | 91ms | 10.0 | 0.215 | ✅ |
| `plain:xl` atomic_firstshort | 13 | 1.24% | 4.93 | **34.00%** ⚠️ | **838ms** ✅ | 2414ms | 780ms | 91ms | 10.0 | 0.220 | ✅ |

判定依据（阈值来自 `mixed-matrix-thresholds.json`）：语速极差 ≤8%、块间 F0 ≤40%、单块偏差 ≤20%、最长静音 ≤900ms、异常长静音 0、块间机械静音 ≤200ms、最短非首块 ≥10 单元、首块 TTFA ≤2000ms、单格 TTFA P95 ≤1500ms、RTF ≤1。

口径与时段说明：离线表按**原文** `speech_units()` 算最短非首块，真机表按**规范化后**文本算，故 10.0 与 10.6 不是矛盾。验收报告全量矩阵里 `plain:xl` 首块是 2070ms（超 2000ms），本轮单格同机复测是 **1851ms（未超）**——同一格子在不同时段/热态下本来就在阈值附近摆动，所以首块快路径在这格**不是稳定刚需**，不能拿一次超阈值当常态证据；但 `plain:xl` 的 TTFA P95 2527ms 稳定远超 1500ms。

**结论**：

- ✅ `code:xl` 从 43.71% 降到 **6.84%**，达标；F0 极差 32.41%→23.94%、块间静音 107→85ms、块数 26→23（少 3 次独立自回归生成）；首块 TTFA 674→660ms、RTF 0.254→0.265、逐字可逆，最长块内静音 460→500ms 略增但远低于 900ms 阈值，无一项越界。
- ✅ **基线精确复现验收报告的 43.71%**，说明本轮 A/B 的对照有效；`atomic` 与 `atomic_firstshort` 两次独立采集数值完全一致，来自固定 seed 的确定性，不是时段抖动。
- ⚠️ 首块快路径把 `plain:xl` 首块 TTFA 压了 55%（1851→838ms），但块间 F0 极差从 15.60% 涨到 **34.00%**（仍在 40% 阈值内，代价明显），且单格 TTFA P95 仍 2414ms（阈值 1500ms）——**只修首块，不修全局**，属于部分方案。结合上一段的时段摆动，建议默认关。
- ⏳ 本轮只跑了 `code:xl` 与 `plain:xl` 两格，**没有重跑全量 25 格矩阵**。按验收报告的归因推断，修掉 `code:xl` 后 on 组 7 项违规应降到 6 项，但这是**推断不是实测**；落地后必须全量复验，违规项持续可见。

---

## 6. 短数字块：根因与可行方案（真机 + 离线模拟）

`num:xs` = `首块 192 毫秒，整块 1821 毫秒。`，规范化后 14.30 等效单元。

| 指标 | 实测 |
|---|---:|
| 整段时长 / 有声时长 | 3.659s / 2.740s |
| 整段语速 / 有声语速 | **3.908** / **5.219** u/s |
| 句内静音段 | 360 / 380 / 80 / 80ms，合计 **0.900s** |
| 与 4.92 基准偏差 | 20.57%（阈值 ≤20%） |

**根因不是「读得慢」**：有声段 5.219 u/s 甚至偏快，是模型在短数字句里插了 4 段静音，把整段分母拖长。服务端 `compress_internal_gaps()` 只压 **>0.9s** 的静音到 0.45s（`mlx_voice_server.py:1486-1487`），这 4 段最长 380ms，完全没命中。对照组 `cn:xs` 4.699 u/s、`code:xs` 4.908 u/s，说明这确实是数字密集短句的特有现象。

离线把超过 cap 的句内静音裁到 cap 后的**预估**（未改服务端，不是实测）：

| cap | `num:xs` 语速 / 偏差 | `cn:xs` 偏差 | `code:xs` 偏差 |
|---|---:|---:|---:|
| 现状 0.9→0.45s | 3.908 / 20.57% ❌ | 4.49% | 0.24% |
| 0.30s | **4.064 / 17.40% ✅** | 4.22% | 0.24% |
| 0.20s | 4.309 / 12.43% ✅ | 10.52% | 2.09% |
| 0.12s | 4.527 / 7.99% ✅ | 16.13% | 5.36% |

**方案**：只对 **≤20 等效单元的短块**启用 0.3s 静音上限（长块保持 0.9/0.45s，避免把正常句读压掉），开关默认关、真机 A/B 后决定。0.3s 这一档能让 `num:xs` 单块判据达标且两个对照组不劣化。

**但要诚实**：全局跨语料语速极差 ≤12% 还要更激进（cap 0.2s 时最小块 4.309 u/s，估算极差仍约 12.75%），压到 0.12s 虽能达标，却会把 `cn:xs` 推到 5.714 u/s、短句听感变赶。这一档必须由你真机试听后决定，不能只看数字放行。**以上全是离线裁剪模拟，改完服务端必须重新真机采集。**

---

## 7. 推荐路线与具体落地改动

### P0（建议实施）：结构感知分块

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/web/web/src/voice/sentence.ts` | `takeSentences():90-120` | 把现有 `inFence` 一位状态扩展为「结构深度 + URL/引号/拉丁词/数字串」状态机；结构内部跳过**所有**断句符（含 `,` `:`） |
| `packages/web/web/src/voice/player.ts` | `splitLongText():367-396` | 切点回扫排除原子内部；原子横跨 48 字时整体挪到下一块，允许该请求块 >48 字（上限 2×48） |
| `packages/web/web/src/voice/player.ts` | `rebalanceShortBlock():201-228` | 枚举切点先过滤原子内部；无「两段都 ≥10 单元」的合法切点时合并成一块，不硬切 |
| `scripts/voice/mlx_voice_server.py` | `split_long_text():581-622` | 服务端对规范化后文本二次切分时同样加词/结构保护，兜住残留拉丁词 |
| `scripts/voice/longtext_probe.py` | `frontend_blocks():252-281` | 同步复刻，保证门禁测的是真实前端行为（本轮 `chunking_ab_probe.py` 已给出可移植实现） |

**开关契约**：`DCX_VOICE_ATOMIC_CHUNK=1` / 前端偏好 `dcx.voice.atomicChunk.v1`，**默认关**，灰度通过后再默认开；关闭时音频与切分必须与 `031f1cc2` 逐字节一致。

**验收门禁**：① 25 格矩阵 `--tns on` 全量（`code:xl` ≤8%、原子切断 0、逐字可逆、最短非首块 ≥10、块间静音 ≤200ms、F0 ≤40%）；② `--tns off` 不回归；③ `longtext_probe --check` 4/4、`check_continuity` 11/11；④ web 全量单测 + typecheck + 重建 `bundle.js`；⑤ 桌面 WebView 真机试听由你确认。

### P1（需 A/B，默认关）

1. 短块静音上限（`§6`），0.3s 起步；
2. 无标点首块快路径（`§5`），代价 F0 极差 15.6→34.0%；
3. 网关白名单透传 `tns` + 新增只读 `/api/voice/normalize`，便于桌面端 A/B 与调试。

### P2 / 运营

1. 术语表数据化：把 `DCX_VOICE_RATE_SERVO` 这类项目内已知标识符映射到确定读法，带版本与 fixture；未知词继续诚实透传；
2. 流式 TN 小模型（StreamTN 类）只在规则覆盖率成为主要投诉时评估，本地没有合适的 0.6B 权重，别为此污染主 LLM；
3. 跨块韵律状态：ElevenLabs/Cartesia/Deepgram 的请求级上下文、MagpieTTS-LF 推理期状态、CosyVoice2 训练期方案都需要换推理栈或模型权重，会丢掉本地司南音色与「同文本 PCM 逐位一致」这一确定性证据，**不建议本轮动**。

### 不能由代码修的边界

- `plain` 全局 TTFA P95：`iter_stream()` 必须收齐一段原始 chunk 才能算伺服倍率（README:644 已列三笔代价），把段切小就多一个起头语调；这是严格语速归一与低 TTFA 的数学冲突，不是参数没调好。
- F0 / 频谱质心只是音色代理，不等于说话人验证。
- 桌面 WebView 用独立 JWT，代理脚本不能代跑；45 个 `ab-*.wav` 可听样本仍需你本人 A/B。

---

## 8. 诚实边界

- 本轮**只新增两个只读探针 + 本报告**，没有改 `sentence.ts` / `player.ts` / `mlx_voice_server.py` / `voice-api.ts`，没有重建 `bundle.js`。所有 A/B 数字来自「探针复刻前端切分 + 直连 sidecar」，**不是生产链路已经修好**。
- `atomic` 允许单请求块到 59 字，依赖服务端 `apply_tns() → split_long_text()` 的现有顺序；若该顺序被改动，保护会失效。服务端那一层也建议同步加保护（P0 表内）。
- 短块静音压缩是**离线裁剪模拟**，真机 WSOLA 与伺服顺序会改变最终时长；不能把 4.064 u/s 当成已验证结果。
- 修 `code:xl` 后矩阵仍会 FAIL 6 项，违规项必须持续可见，不得删语料或放宽阈值。
- `atomic` 两次采集数值完全一致是固定 seed 的确定性，不代表不同时段/不同语料也完全一致；落地后必须重跑全量矩阵。

---

## 9. 复现

```bash
# 离线切分质量（不请求 sidecar）
python3 scripts/voice/chunking_ab_probe.py --offline --cells code:xl,plain:xl \
    --modes baseline,atomic,atomic_firstshort

# 真机 A/B（需 8791 常驻、tns-1.0；约 2~3 分钟）
python3 scripts/voice/chunking_ab_probe.py --cells code:xl,plain:xl \
    --modes baseline,atomic,atomic_firstshort --out /tmp/dcx-chunking-ab/run
cat /tmp/dcx-chunking-ab/run/summary.json

# 短块根因 + 离线压缩模拟（3 次短请求，约 10 秒）
python3 scripts/voice/short_block_probe.py
cat /tmp/dcx-chunking-ab/numxs/report.json

# 落地后的既有门禁
npm run test:voice:matrix
npm run test:voice:longtext
npm run test:voice:tns
```

### 主要参考来源

- StreamTN, IEEE SLT 2026 — https://arxiv.org/abs/2609.24267
- Rime, *What Is Text Normalization in TTS* — https://www.rime.ai/resources/what-is-text-normalization-in-text-to-speech
- Smallest.ai, *Long-Form TTS: Consistent Speech at Scale* — https://smallest.ai/blog/long-form-tts-how-to-generate-consistent-speech-at-scale
- AIRI, *Contextual Prosody vs. Real-Time Sentence-Sync in Streaming Neural TTS* — https://github.com/sebastian-zm/airi/blob/main/docs/design-contextual-streaming-tts-and-sentence-sync.md
- Evalgent, *TTS evaluation for voice agents: beyond MOS* — https://www.evalgent.com/blog/tts-evaluation-voice-agents
- Baseten, *Cost-efficient, high-performance TTS with Qwen3-TTS* — https://www.baseten.co/blog/cost-efficient-high-performance-qwen3-tts/
- EmergentTTS-Eval — https://hyper.ai/en/papers/2505.23009
- FireRedTTS3 文本前端双轨 TN 解析 — https://blog.gitcode.com/dd8be8045ccfa108ff11026dcf27efa5.html

厂商自测数字（96.5%、75ms、94.50 等）均为弱证据，只用于方向判断，未写进任何门禁阈值。
