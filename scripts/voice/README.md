# 司南的本机语音 sidecar（MLX / Apple Silicon）

让 Web 与桌面端能用**语音**跟司南对话：说一句 → 本机 Whisper 转文字 → 正常走对话 →
回复按句切分 → 本机 TTS 合成 → 浏览器边播边继续收。

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
| POST | `/asr` | 原始 WAV 字节 → `{text, durationMs, model}` |
| POST | `/warmup` | 触发探测（不做实际加载） |

引擎侧不直接暴露这些端点，而是经 `packages/web/src/api/voice-api.ts` 代理：
前端只跟同源 `/api/voice/*` 说话，token 永不出进程。

## 默认模型

| 用途 | 模型 | 说明 |
|---|---|---|
| ASR | `mlx-community/whisper-large-v3-turbo` | 中文识别质量与速度的平衡点 |
| TTS（默认） | `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit` | 用一句话描述音色（1.8GB） |
| TTS（轻） | `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` | 预置音色 + 情感指令，更小 |
| TTS 兜底 | `prince-canuma/Kokoro-82M` | 轻、快，"至少能出声" |

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

## 已知限制（诚实边界）

写在这里而不是藏在代码注释里，因为每一条都会影响你的实际体验：

1. **`/health` 的 `ready:true` 只代表库可导入**，不代表权重已下载。首次合成仍要等 10~30s。
2. **token 变更需重启 sidecar**（启动时读取一次，不热重载）。
3. **ASR 只接受 16-bit PCM WAV**。前端已在浏览器侧用 `decodeAudioData` + `encodeWav` 转好，
   所以这条只影响你自己用 curl 调的场景。
4. **识别语言固定 `zh`**。要中英混说识别得更准，得改成 `language=None` 让 Whisper 自动判定，
   代价是偶发把中文识别成相近的英文词。
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
9. **首次加载占内存约 3~4GB**（Whisper large-v3-turbo 1.6GB + VoiceDesign 1.8GB）。
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
