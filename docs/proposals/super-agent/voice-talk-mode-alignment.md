# 语音对话对标 OpenClaw Talk Mode：四项改造与实测

> 2026-11-05 · 语音链路（`packages/web/web/src/voice/**`）

## 一、为什么要改

现有语音是**按住说话**：手指按住 → 说话 → 松手 → 识别 → 发送。它能用，但和「陪人聊天」这件事格格不入：

| 问题                 | 用户实际感受                                                   |
| -------------------- | -------------------------------------------------------------- |
| 手要一直按着         | 一边组织语言一边维持机械动作；松早了一句被截断，松晚了全程在录 |
| 松手到出声之间全空白 | 界面没有任何反馈，不知道是没听见、在想、还是坏了               |
| 语气只能去设置里调   | 想让它「这句慢点说」，得中断对话                               |
| 首句常常很长         | 首音要等模型写完一整段从句 + 整段合成                          |

## 二、OpenClaw 的做法（调研依据）

OpenClaw 的 Talk Mode 是一个**连续语音循环**，官方文档写明：

- 「Listen for speech → Send transcript to the model → Speak it via ElevenLabs (streaming playback)」
- 「On a short pause (silence window), the current transcript is sent」——用停顿提交，不是按键
- 「Interrupt on speech (default on): if the user starts talking while the assistant is speaking, we stop playback and **note the interruption timestamp for the next prompt**」
- 回复首行可放一行 JSON 控制语音：`{ "voice": "", "once": true }`，支持 `voice` / `model` / `speed` / `stability` / `once` 等键，**该行在 TTS 前被剥离**（用户听不到）
- 延迟靠 ElevenLabs 流式 API + 增量播放，`latency_tier` 可调

来源：

- <https://openclawcn.com/en/docs/nodes/talk/>
- <https://open-claw.bot/docs/platforms/nodes/talk>
- <https://openclawvoice.com/>（本地 Whisper + WebSocket 流式的另一套实现）

## 三、本次落地的四项

### 1. 静音自动提交（`voice/endpointing.ts` + `mic.ts`）

`Endpointer` 是一个纯状态机：每 50ms 收一帧 RMS，回答「现在算不算说完了」。

| 参数     | 值       | 理由                                                                   |
| -------- | -------- | ---------------------------------------------------------------------- |
| 帧长     | 50ms     | 与打断监测同粒度，不引入第二个采样循环                                 |
| 人声阈值 | RMS 0.05 | 正常说话 0.1~0.3，环境噪声 <0.02                                       |
| 最少人声 | 300ms    | 咳嗽/碰桌子是短促的，不该被提交成「没听清」                            |
| 连续静音 | 900ms    | 中文句内停顿 200~500ms、句间 >600ms；取 900ms 落在两者之间，不切断句子 |

**没说过话就永不触发**——避免误触后立刻把一个空录音发出去。

`MicCapture.startRecording()` 现在可以带 `onEndpoint` 回调；录音期间另起一个 AudioContext 做采样（与播报期的打断监测互相关闭）。

### 2. 三相位状态机（`useVoiceTalk.phase`）

`idle → listening → thinking → speaking → idle`。

之前的 `recording` / `speaking` 两个布尔漏掉了「已松手、模型在想、还没出声」这一段。`thinking` 从**停止录音**开始，到**第一个音频开始播**结束，另有 8s 兜底（链路异常时不至于一直转圈）。按钮上以呼吸描边呈现（`.composer-mic-thinking`）。

交互改为**点一下开始**：免按住时静音自动收尾并发送；关闭免按住则退回「点一下开始、再点一下结束」。开关在设置 → 司南 → 声音，存在 localStorage（跟设备走，不跟账号走），同页即时生效（自定义事件广播）。

### 3. 语音指令行（`voice/directive.ts`）

模型回复首行若是合法 JSON 且含 `voice` / `engine` / `speed` / `once` 之一，则：

- 该行**不送 TTS**（用户听不到）；
- `voice` / `engine` / `speed` 覆盖这一次合成的参数（复用已有的 `/api/voice/tts` 覆盖字段）；
- `once: true` 只影响这一条回复，否则成为本轮默认。

三个防御：

1. **只认第一行**——正文里的 JSON 示例不会被误吞；
2. **白名单字段**——`{"foo":1}` 这种合法但无关节的 JSON 按正文处理；
3. **流式 pending**——第一批增量可能只有 `{"spe`，此时既不朗读也不判定「没有指令」，先挂起；超过 200 字符认定不是指令。

流结束时若仍是 pending（单行指令没有换行），`settleVoiceDirective` 再试一次；解析不了就当正文念——**宁可多念一句，也不能整段没声音**。

### 4. 首句更短的弱断点（`sentence.ts`）

首句的弱断句阈值从 28 字降到 12 字，第二句起恢复 28。

这不是拍脑袋：实测同一 sidecar 的合成耗时（24kHz 单声道 WAV，经引擎代理）：

| 文本长度 | 合成耗时   | 备注     |
| -------- | ---------- | -------- |
| 12 字    | **435ms**  | 首句阈值 |
| 27 字    | **941ms**  | 常规阈值 |
| 45 字    | **1588ms** | 长句     |

近似线性：约 **35ms/字 + 15ms 固定开销**。首句从 28 字收到 12 字，单这一项就把首音等待压掉约 **500ms**，而且模型写到 12 个字也比写到 28 个字更早——两段时间同时缩短。

### 5. 识别输出固定简体（`scripts/voice/mlx_voice_server.py`）

测试时发现：同一段音频，Whisper 有时回「重启**之後**，**雨**音**還能**用**嗎**」——全繁体，而且「语音」被听成「雨音」。用户看到的是「自己刚才说的是繁体字」，体验很怪。

`language="zh"` 只锁定*中文*，不区分简繁；Whisper 也没有简体选项。官方推荐做法是给一段简体 `initial_prompt` 当风格先验（零成本，只影响解码倾向）：

```python
mlx_whisper.transcribe(audio, ..., language="zh",
                       initial_prompt="以下是普通话对话，请用简体中文转写。")
```

实测同一段音频连测 3 次：**全部稳定输出简体**（「重启之后,雨音还能用吗?」）。同音字错（语音→雨音）仍在，那是声学层面的事，`initial_prompt` 管不了。

## 四、诚实边界

| 没做的                   | 为什么                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **流式音频**（边说边收） | sidecar 的 `/tts` 是「整段合成完返回 wav」，不是分块流。真要流式得让 sidecar 输出 chunked wav 或 PCM 帧 + 前端 AudioWorklet 拼接；WAV 头里写着长度，分块语义要重定义。这是下一步，不在本次范围 |
| **真 VAD 模型**          | 现在用 RMS 能量阈值，不是 Silero/WebRTC VAD。安静环境够用，嘈杂环境会误判；真正的改进是接一个 20KB 的 VAD 模型，代价是加载与 WASM 体积                                                         |
| **打断时间戳进 prompt**  | 已记录 `lastInterruption`（含被打断时已念出的文本），但把它注入下一轮上下文要动 session 的消息拼装；先留出数据，不动发送链路                                                                   |
| **指令行的模型配合度**   | 模型不一定愿意输出这行 JSON。没有指令时零影响（正常朗读），有指令时省一次去设置页的往返。要不要在人格提示里教它用，取决于实测效果                                                              |
| **语气随模式变化**       | 陪伴模式的提示词已经写好，但本机模型端（`127.0.0.1:8804`）未启动，**没有做真实回复的语气评测**——这条仍未验证                                                                                   |

## 五、验证

| 项                          | 结果                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `voice-endpointing.test.ts` | 6/6（说完触发一次、纯静音不触发、咳嗽不触发、句内停顿不触发、阈值可调、reset 隔离）             |
| `voice-directive.test.ts`   | 10/10（剥离、pending、非法 JSON 保留、越界夹紧、别名、未知引擎忽略、单行收尾）                  |
| `voice-sentence.test.ts`    | 14/14（新增首句阈值与收尾两例）                                                                 |
| TTS/ASR round-trip          | TTS 435~1588ms；ASR 冷启 2238ms、热态 **287ms**；回识重合度 100% / 90.9%                        |
| 降级                        | 停 sidecar：`/api/voice/status` → `reachable:false` + 可执行 hint；`/tts` → **503**（不是 500） |
| typecheck / lint / prettier | 见提交说明                                                                                      |
