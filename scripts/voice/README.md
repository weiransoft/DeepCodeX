# 司南的本机语音 sidecar（MLX / Apple Silicon）

让 Web 与桌面端能用**语音**跟司南对话：说一句 → 本机 ASR（Qwen3-ASR，
缺失时回落 Whisper）转文字 → 正常走对话 → 回复按句切分 → 本机 TTS 合成 →
浏览器边播边继续收。

全程本机推理，音频不出机器。

## 为什么是独立进程

模型跑在 Python（MLX 的音频生态都在 Python），UI 在 WebView。中间用回环 HTTP 划界：

- 模型崩溃不拖垮应用
- 可以单独重启与压测
- 浏览器版与桌面版走**同一条**链路，不为桌面单独开洞

## 快速开始

```bash
# 1) 装依赖（一次性，约几百 MB）
bash scripts/voice/setup.sh

# 2) 起服务（幂等：已在跑就跳过；等到真能接请求才返回）
bash scripts/voice/start.sh          # 等价于 npm run voice:start
bash scripts/voice/start.sh -f       # 前台运行，便于看日志

# 3) 自检：只检查依赖，不起服务
scripts/voice/.venv/bin/python scripts/voice/mlx_voice_server.py --selftest
```

启动后打开 Web 设置 → 司南 → 声音，点「检测」应看到 ASR/TTS 双绿。

首次合成会下载模型权重（10~30s），之后就只加载一次。

### 谁来启动它

**没有任何一方会自动拉起 sidecar**：桌面壳只管拉起 Node 引擎，引擎只是把
`/api/voice/*` 转发到回环地址。模型进程的生命周期是独立的——这是刻意的
（见上文「为什么是独立进程」），代价就是需要单独启动一次。

`start.sh` 把这件事收敛成一条命令：检查 venv → 带 `HF_ENDPOINT` 镜像 →
后台启动 → 轮询 `/health` 直到就绪。日志追加到 `~/.deepcode/logs/voice.log`。

已在运行时不重复启动：重复 bind 会以 `EADDRINUSE` 退出，看起来像启动失败，
实际是"已经好了"，这种误报最容易让人去 kill 一个健康的服务。

## 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 依赖与就绪情况，**不加载模型**，秒回 |
| POST | `/tts` | `{text, engine, voice, speed}` → `audio/wav` |
| POST | `/asr` | 原始 WAV 字节 → `{text, durationMs, model, backend}` |
| POST | `/warmup` | 触发探测（不做实际加载） |

引擎侧不直接暴露这些端点，而是经 `packages/web/src/api/voice-api.ts` 代理：
前端只跟同源 `/api/voice/*` 说话，token 永不出进程。

## 默认模型

| 用途 | 模型 | 说明 |
|---|---|---|
| ASR（首选） | `mlx-community/Qwen3-ASR-0.6B-8bit` | 中文更准，**需要本地权重**（见下节） |
| ASR（兜底） | `mlx-community/whisper-large-v3-turbo` | 权重缺失或推理失败时自动回落 |
| TTS（默认） | `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit` | 用一句话描述音色（1.8GB） |
| TTS（轻） | `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` | 预置音色 + 情感指令，更小 |
| TTS 兜底 | `prince-canuma/Kokoro-82M` | 轻、快，"至少能出声" |

### ASR 为什么换成 Qwen3-ASR

用户反馈「语音转换准确率不高」。用同一批音频做闭环 A/B（8 句 TTS 合成，
干净 + SNR 8dB 加噪两路，字符级 CER）：

| 模型 | 干净 | 加噪 |
|---|---|---|
| `whisper-large-v3-turbo` | 6.88% | 6.88% |
| `Qwen3-ASR-0.6B` | **3.72%** | **5.89%** |

差异集中在两处，都是用户会直接感知的：

- **专有名词/数字**：whisper 把「四零四」写成 404、「王工」→「王公」、
  「Qwen3」→「Q稳」；Qwen3-ASR 干净条件下全对
- **简繁**：whisper 中文模式会输出繁体（「三点」→「三點」），Qwen3-ASR 不会

共同短板是**英文专有名词**（「Tauri」→「Tory」）。这个用 Qwen3-ASR 的
`hotwords` 治：实测同一句音频，不带热词输出「Tori」，带上就正确。默认热词表
是 `DeepCodeX / Tauri / Qwen3 / MLX / MCP`，可用环境变量覆盖：

```bash
DEEPCODE_ASR_HOTWORDS="DeepCodeX,Tauri,Qwen3,MyProject" bash scripts/voice/start.sh
```

### Qwen3-ASR 的权重怎么来

`mlx_audio.stt.load` 吃本地目录。默认找 `~/.cache/qwen3-asr-mlx`，不存在就
回落 whisper（`/health` 的 `asr.backend` 会如实说明用的是哪个）。

**不要指望它自己去 HuggingFace 下载**：本机访问 `huggingface.co` 不通
（curl 返回 000），会卡在首次识别上，表现成「点了麦克风没反应」。从
ModelScope 取（实测 5.9~17MB/s，965MB 约 1 分钟）：

```bash
python3 - <<'PY'
import json, urllib.request, pathlib
dst = pathlib.Path.home() / ".cache" / "qwen3-asr-mlx"; dst.mkdir(parents=True, exist_ok=True)
base = "https://modelscope.cn/models/mlx-community/Qwen3-ASR-0.6B-8bit/resolve/master/"
for name in ("config.json", "generation_config.json", "chat_template.json",
             "merges.txt", "vocab.json", "tokenizer_config.json",
             "model.safetensors.index.json", "model.safetensors"):
    try:
        urllib.request.urlretrieve(base + name, dst / name)
        print("ok", name)
    except Exception as exc:
        print("skip", name, exc)
PY
```

换目录用 `DEEPCODE_ASR_MODEL_PATH=/path/to/weights`。

注意：**没有 CosyVoice2**。`mlx-audio 0.6.4` 的模型目录里不存在这个实现，
`import mlx_audio.tts.models.cosyvoice2` 会直接 `ModuleNotFoundError`。
网上说「mlx-audio 支持 CosyVoice」指的是上游项目能力，不是这个移植版。

「御姐音」不是某个预置音色 id，而是一段**可编辑的声音描述**：

```
成熟女性，中低音区，语速平稳，略带气声，克制不撒娇，句尾下沉
（mature female, low-mid register, steady pace, slightly breathy, restrained）
```

VoiceDesign 会把这段描述当成声学指令。本机实测（同一句话只改描述）：

| 描述 | 中位基频 |
|---|---|
| 成熟女性，中低音区… | 156.9 Hz |
| 年轻女孩，高音区… | 320.0 Hz |

差近一个八度，说明描述是真的在起作用。所以改这段文字比换音色 id 更接近你想要的，
这也是配置里 `voice` 是自由文本而非枚举的原因。

英文括号部分不是凑字数：这个模型的训练语料以英文描述为主，中英并列对
「低沉、克制」这类倾向的还原更稳。

## 鉴权

sidecar 是**整机一份**的资源，而 token 是**按引擎实例**生成的——桌面端一份
（`~/.deepcode/soul/config.json`），Web 模式每个用户各一份
（`~/.deepcode/web-uploads/.engine-home/<hash>/.deepcode/soul/config.json`）。

所以校验的是**白名单**：本机所有配置文件里的 `voice.token` 都接受。

- 任何配置存在 token → 要求 `Authorization: Bearer <token>`，命中其一即放行
- 一份 token 都没有 → 不校验（仅便于本机首次调试）
- 每次请求按配置文件 mtime 重扫：**改 token 或新增 Web 用户后不用重启 sidecar**

为什么必须这样：早先只认桌面那一份，结果是 Web 引擎每次合成都被挡——
`POST /api/voice/tts` 直接返回 502「token 不匹配」，而错误信息还建议"重启
sidecar"，照着做也没用（重启后仍然只认桌面那份）。一个服务两个入口，就不
能只认一个凭证。

`127.0.0.1` 不等于安全——同机任何进程都能 POST 到这里，所以这层校验不能省。
白名单只是"接受本机所有合法引擎"，并没有放宽到"接受任意请求"：伪造 token
与不带 token 一律 401。

## 插话（barge-in）：现在做到哪一步

「能不能打断助手」是陪伴类语音交互的硬指标。当前的实现是**半双工 + 插话**，
不是真全双工，区别如下。

### 已经有的

播报期间挂一路人声监测（`MicCapture.startMonitor`），连续 300ms 超过阈值就认为
用户开口，立刻做三件事：

1. `queue.stop()` 停播（同时叫醒卡在 `playOne` 的队列，见 `voice/player.ts`）
2. 置 `interruptedRef` —— 模型这一轮后续的流式内容不再送合成，否则刚打断的
   回复会被下一个增量重新念起来
3. 免按住模式下直接开录（`startTalk`）——用户正在说的那句会被收进去，说完停顿
   自动提交。按住说话模式下不自动开录（那种模式要求手一直按着，自动开录只会莫名）

播报期阈值是平时的 2 倍（`VAD_PLAYBACK_FACTOR`）：外放的声音会被麦克风拾回来，
不抬阈值就会「自己打断自己」。系统级 AEC/降噪由 `getUserMedia` 的
`echoCancellation/noiseSuppression` 提供。

### 延迟预算

业界的 P50 口径大致是：

| 环节 | 预算 |
|---|---|
| VAD 判定用户开口 | 200ms（本项目取 300ms，偏保守，为压掉咳嗽/碰桌子） |
| 停播 | 50ms |
| 取消 LLM 流 | 50ms |
| **合计** | **约 310~400ms** |

超过 P50 350ms / P95 600ms，用户开始感觉到「它没听见我」。所以停播走的是
「立即 pause + 叫醒队列」，不做淡出动画。

### 还没做的（真全双工）

现在是「停 → 再听」，不是「边播边听、开口即抢占」。差值在这两处：

- **没有流式 ASR**。录音收尾后才整段识别，「我说完到它开始想」这段延迟是
  识别耗时（本机 Qwen3-ASR 约 0.3~0.8s/句）。`mlx_audio/stt/streaming.py`
  已经定义了 `StreamingSession`（`feed` / `step` / `close`），Qwen3-ASR 也支持
  `--stream` 与 stable/provisional 两段式文本，接进来就能把这段压到百毫秒级
- **打断判定只看音量**。真正的双工要区分「用户在应答」与「用户在咳嗽/对别人说话」，
  这需要语义判断（比如先出一版 provisional 文本，看它是不是一个完整意图）

这两件事都不改现成链路的结构，属于增量，但都需要真机调，所以没有在没实测的
情况下先写。

## 已知限制（诚实边界）

写在这里而不是藏在代码注释里，因为每一条都会影响你的实际体验：

1. **`/health` 的 `ready:true` 只代表库可导入**，不代表权重已下载。首次合成仍要等 10~30s。
2. **token 变更需重启 sidecar**（启动时读取一次，不热重载）。
3. **ASR 只接受 16-bit PCM WAV**。前端已在浏览器侧用 `decodeAudioData` + `encodeWav` 转好，
   所以这条只影响你自己用 curl 调的场景。
4. **识别语言固定中文**（Qwen3-ASR 传 `Chinese`，whisper 传 `zh`）。中英混说时英文词
   更脆弱（实测「Tauri」→「Tory」），靠 `hotwords` 缓解，不靠放开语言自动判定。
5. **重采样是线性插值**，不是带抗混叠滤波的高质量重采样。对语音识别影响很小，
   但不适合当音频处理工具用。
6. **音色描述的理解程度取决于 CosyVoice2 的 instruct 能力**。同一段描述在不同模型/版本上
   效果会有差异，这不是「选了就一定这样」的确定性控制。
7. **并发被串行化**。MLX 推理不是线程安全的，所以加了锁：两个人同时说话会排队，
   排队期间第二个请求表现为「慢」而不是「错」。
8. **语速在 Qwen3-TTS 上是重采样实现的**。它的 `generate_voice_design` /
   `generate_custom_voice` 没有 `speed` 参数，所以变速靠重采样，音高会跟着变
   （像磁带快进）。实测 0.8/1.0/1.3 倍的时长比例精确（5.20s / 4.16s / 3.20s），
   在这个区间听感可接受。Kokoro 走原生 `speed`，不受影响。
9. **首次加载占内存约 3~4GB**（ASR 约 1GB + VoiceDesign 1.8GB）。
   本机 128GB 统一内存足够；8GB 机型不建议同时开两个引擎。
10. **首次加载约 13s**（权重已缓存），首次下载 1.8GB 视网络而定（本机实测 14.5 分钟）。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置页显示「未就绪」并给出 setup.sh | 依赖没装 | 跑 `setup.sh` |
| 合成一直转圈（>30s） | 首次下载权重 | 看 sidecar 终端输出，等它下完 |
| 401 token 不匹配 | sidecar 启动后配置被改过 | 重启 sidecar |
| `/tts` 返回 500 且提到 `generate_audio` | mlx-audio 版本布局不同 | 看错误里的候选路径，补一条到 `_resolve_generate` |
| 识别结果为空 | 录音太短或全是静音 | 前端 VAD 已过滤 <300ms，检查麦克风权限 |
