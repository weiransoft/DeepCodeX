#!/usr/bin/env python3
"""
司南的本机语音 sidecar（MLX / Apple Silicon）

## 为什么是独立进程

模型跑在 Python（MLX 的音频生态都在 Python），而 UI 在 WebView。中间用本机
HTTP 划界，有三个好处：模型崩溃不拖垮应用；可以单独重启与压测；浏览器版与
桌面版走同一条链路。

## 端点

    GET  /health   → 依赖与模型就绪情况（不加载模型，秒回）
    POST /tts      → {"text","engine","voice","speed"} → audio/wav
    POST /asr      → 原始 wav 字节 → {"text","durationMs","model","backend"}
    POST /warmup   → 触发模型加载（首次 10~30s）

## 三条设计纪律

1. **懒加载**：`/health` 绝不加载模型。否则"看一眼状态"要等半分钟。
2. **依赖缺失不崩**：`import mlx_audio` 失败时服务照常活着，`/health`
   返回 `ready:false` + 具体原因。用户能看到"缺什么"，而不是连接被拒。
3. **鉴权沿用配置里的 token**：与引擎读同一份 `~/.deepcode/soul/config.json`。
   `127.0.0.1` 不等于安全——同机任何进程都能 POST 到这里。

## 用法

    python3 scripts/voice/mlx_voice_server.py            # 默认 127.0.0.1:8791
    python3 scripts/voice/mlx_voice_server.py --selftest # 只检查依赖与模型，不起服务
"""

from __future__ import annotations

import argparse
import hmac
import io
import json
import os
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8791

# ASR：首选 Qwen3-ASR，兜底 whisper-large-v3-turbo
#
# ## 为什么换掉 whisper
#
# 用户反馈「语音转换准确率不高」。用同一批音频做过闭环 A/B（8 句 TTS 合成，
# 干净 + SNR 8dB 加噪两路，字符级 CER）：
#
#     whisper-large-v3-turbo   干净 6.88%   加噪 6.88%
#     Qwen3-ASR-0.6B           干净 3.72%   加噪 5.89%
#
# 错误集中在专有名词与数字：whisper 把「四零四」写成 404、「王工」→「王公」、
# 「Qwen3」→「Q稳」，还会把简体输出成繁体（「三点」→「三點」）；Qwen3-ASR
# 在干净条件下这些全对，加噪后英文词更脆弱（「Tauri」→「Tory」）。
#
# ## 为什么默认指向本地目录而不是 HF repo id
#
# 本机访问 huggingface.co 不通（curl 返回 000），走 repo id 会在第一次识别时
# 卡在下载上，表现成「点了麦克风没反应」。权重改由 ModelScope 取回后放在本地
# 目录，`mlx_audio.stt.load` 直接读目录即可（实测 965MB 权重，ModelScope 直连
# 5.9~17MB/s）。
DEFAULT_ASR_MODEL = "mlx-community/whisper-large-v3-turbo"
ASR_QWEN3_MODEL_ID = "mlx-community/Qwen3-ASR-0.6B-8bit"
DEFAULT_ASR_LOCAL_PATH = "~/.cache/qwen3-asr-mlx"
# 语言固定中文：本产品是中文助手，不交给模型自己猜（短句上猜错会整句跑偏）
ASR_LANGUAGE = "Chinese"
# whisper 的语言代码（Qwen3-ASR 用自然语言名，两者不通用）
ASR_WHISPER_LANGUAGE = "zh"
# whisper 没有简体选项，用一段简体提示词把输出先验掰向简体
ASR_WHISPER_PROMPT = "以下是普通话对话，请用简体中文转写。"

# 专有名词提示（Qwen3-ASR 的 hotwords）
#
# 实测有效：同一句「把 DeepCodeX 的 Tauri 配置再检查一遍」，不带 hotwords
# 识别成「Tori」，带上就正确。它只影响解码先验，不会往结果里插词。
#
# 默认表只放本产品日常会说到的英文名——热词表越长，对普通句子的干扰越大。
# 需要加长时用环境变量覆盖：DEEPCODE_ASR_HOTWORDS="A,B,C"
ASR_HOTWORDS_DEFAULT = ("DeepCodeX", "Tauri", "Qwen3", "MLX", "MCP")

# 引擎 → 模型 id（与 core 的 VoiceEngine 枚举一一对应）
#
# 这里没有 CosyVoice2：mlx-audio 0.6.4 的模型目录里根本没有它。
# 中文 + 「用一句话描述音色」这条需求，实际对应的是 Qwen3-TTS 的
# VoiceDesign 变体——它接受自然语言音色描述，正好是「御姐音」的入口。
MODEL_IDS = {
    "qwen3-voicedesign": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
    "qwen3-customvoice": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
    "kokoro": "prince-canuma/Kokoro-82M",
}
DEFAULT_TTS_ENGINE = "qwen3-voicedesign"
# 合成语言。中文助手固定 zh，避免 auto 在短句上判成英文
TTS_LANGUAGE = "Chinese"
# Kokoro 的中文音色（lang_code 'z'）
KOKORO_VOICE = "zf_xiaobei"

# ---------------------------------------------------------------------------
# CustomVoice：预置音色（音色一致性最好的那条路）
#
# 为什么这才是「音色不跳」的正解：VoiceDesign 是**每次调用现场设计**一个音色，
# 即使固定随机种子，换一段文本自回归轨迹就变了，基频会跟着漂——本机实测
# 同一音色描述下四句话的基频中位数 170.2~200.0Hz（跨度 29.8Hz），听感就是
# 「一会儿像另一个人」。CustomVoice 用的是**训练好的 speaker embedding**，
# 音色不参与采样，跨句天生一致。
#
# 业界说法一致：预置固定音色「最稳定、推理开销最低、音色一致性最好，长文本
# 不易崩音色」；而 VoiceDesign 适合角色试音，不适合长篇定稿。
#
# 1.7B 版本支持 instruct（情感/风格指令），0.6B 不支持——这是选 1.7B 的原因：
# 既能锁音色，又不至于把语气说死。
# ---------------------------------------------------------------------------
CUSTOMVOICE_SPEAKERS = (
    "serena",
    "vivian",
    "uncle_fu",
    "ryan",
    "aiden",
    "ono_anna",
    "sohee",
    "eric",
    "dylan",
)
# 默认音色：vivian 是明亮年轻女声，最接近此前自定义描述里的「少年女性、中音区、利落」
DEFAULT_CUSTOMVOICE_SPEAKER = "vivian"

# CustomVoice 权重的本地目录（ModelScope 下载；hf.co 在本机不可达）
TTS_CUSTOMVOICE_LOCAL_PATH = "~/.cache/qwen3-tts-customvoice"


def resolve_tts_model_id(engine: str) -> str:
    """
    引擎 → 实际加载的模型路径（本地权重优先于仓库 id）

    本地权重的好处不只是省下载：离线可用，且不会因为上游仓库改名/删档而失效。

    @param engine 引擎名
    @returns 本地目录或 HuggingFace / ModelScope 仓库 id
    """
    if engine == "qwen3-customvoice":
        explicit = os.environ.get("DEEPCODE_TTS_MODEL_PATH", "").strip()
        local = os.path.expanduser(explicit or TTS_CUSTOMVOICE_LOCAL_PATH)
        if os.path.isdir(local):
            return local
    return MODEL_IDS.get(engine, MODEL_IDS[DEFAULT_TTS_ENGINE])


def resolve_speaker(voice: str) -> tuple[str, str | None]:
    """
    把 `voice` 归一成 (预置音色名, 情感指令)

    CustomVoice 只认预置音色名，传一句音色描述会直接抛
    `Speaker 'xxx' not supported`。而历史配置里存的是 VoiceDesign 语义的
    描述文本（如「少年女性22 岁，中音区，语速正常，吐字清晰」）。两者不能
    混用，所以在这里做一次语义转换：

    - 命中预置音色名（大小写、空格、连字符不敏感）→ 直接用
    - 否则 → 退回默认音色，原描述改当 `instruct`（1.7B 支持情感/风格指令）
      这样「语速正常、吐字清晰、利落」这类风格要求还能保留一部分

    @param voice 音色名或音色描述
    @returns (speaker, instruct)
    """
    text = (voice or "").strip()
    key = text.lower().replace("-", "_").replace(" ", "_")
    if key in CUSTOMVOICE_SPEAKERS:
        return key, None
    return DEFAULT_CUSTOMVOICE_SPEAKER, (text or None)

# 采样随机种子的派生基数
#
# 为什么必须固定种子：Qwen3-TTS 的 VoiceDesign 是自回归采样，同一个音色描述
# 每调用一次就重新"设计"一遍音色。本机实测（同一 instruct、同一句话生成两次）
# 基频中位数 199.2 → 192.1Hz、频谱质心 3025 → 3814Hz，听感就是"换了个人的感觉"。
# 而分段播报每句都是一次独立调用，于是整段回复的音色一句一个样。
#
# 修法：按音色描述派生一个稳定种子，每次合成前重置。实测固定种子后，
# 同描述的重复生成逐位完全相同（走 /tts 全链路验证过：两次请求返回
# 169004 字节，完全一致），跨文本的基频抖动也从"无种子时 swing 到听感
# 换人"收敛到文本语调本身的正常起伏。
#
# 种子由**描述文本**派生（而不是固定常量）的原因：用户换了音色描述，
# 就该得到一套新的、但仍然稳定的音色。
TTS_SEED_BASE = 20261105

# 采样温度
#
# 定值依据不是"跨文本基频跨度"——那个指标不可用：同一组三句文本在四个温度下
# 测出的跨度在 8~21Hz 之间乱跳，说明单次生成的随机噪声（±10Hz）已经盖过了
# 温度带来的系统差异，拿它选温度等于看噪声。
#
# 可靠指标是"同一句文本、只换种子"的采样方差（纯随机性，剔除了文本语调）：
#   温度 0.9（默认） → 基频 162/186/182/169，std 9.8Hz，range 24.4
#   温度 0.6         → 170/186/188/182，std 7.0Hz，range 17.9
#   温度 0.35        → 183/188/195/192，std 4.5Hz，range 11.9
#   温度 0.2         → 190/204/195/178，std 9.3Hz，range 25.8
# 0.35 是这条曲线的谷底，方差比默认温度减半；再往下降到 0.2 反而反弹
# （温度过低时模型发音开始不稳，语句间还会发平）。
#
# 注意能力的边界：降温度只压住"采样噪声"，压不住"文本本身的语调"。
# VoiceDesign 模型不接受 ref_audio 参考音频（那条路径只对 base 模型开放），
# 所以做不到音色克隆式的彻底锁死；换文本后基频仍有十几 Hz 的自然起伏，
# 那是说话内容决定的，不是音色漂移。
TTS_TEMPERATURE = 0.35


def prepare_sampling(voice: str) -> float:
    """
    按音色描述派生确定性采样参数并重置随机状态。

    必须在每次生成**之前**调用：MLX 的随机状态是全局的，重置后
    同一个 seed + 同一段文本才会产出逐位相同的音频。

    @param voice 音色描述（或 speaker 名 / 音色 id）
    @returns 本次生成使用的采样温度
    """
    import hashlib

    import mlx.core as mx

    digest = hashlib.sha256(f"{TTS_SEED_BASE}:{voice}".encode("utf-8")).digest()
    # 取 31 位，避开某些后端对超大 int 的处理差异
    mx.random.seed(int.from_bytes(digest[:4], "big") % (2**31 - 1))
    return TTS_TEMPERATURE


def soul_config_path() -> Path:
    """配置文件路径（与引擎同源：~/.deepcode/soul/config.json）"""
    home = os.environ.get("DEEPCODE_HOME") or str(Path.home())
    return Path(home) / ".deepcode" / "soul" / "config.json"


def web_engine_config_paths() -> list[Path]:
    """
    枚举 Web 模式各用户的 soul 配置

    Web 引擎按 per-user 口径把配置落在 `.engine-home/<hash>/.deepcode/soul/`，
    每份都带自己的 `voice.token`。桌面模式则用 `~/.deepcode/soul/config.json`。
    这两个布局都在同一台机器上，指向同一个回环 sidecar。
    """
    home = os.environ.get("DEEPCODE_HOME") or str(Path.home())
    base = Path(home) / ".deepcode" / "web-uploads" / ".engine-home"
    try:
        return sorted(base.glob("*/.deepcode/soul/config.json"))
    except OSError:
        return []


def candidate_config_paths() -> list[Path]:
    """所有可能持有一份 sidecar token 的配置文件（去重保序）"""
    paths: list[Path] = [soul_config_path()]
    for path in web_engine_config_paths():
        if path not in paths:
            paths.append(path)
    return paths


def _read_tokens_uncached() -> set[str]:
    """逐个配置文件读 `voice.token`，坏文件跳过（一个用户配置损坏不该拖垮鉴权）"""
    tokens: set[str] = set()
    for path in candidate_config_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        token = data.get("voice", {}).get("token", "")
        if isinstance(token, str) and token:
            tokens.add(token)
    return tokens


# 上次扫描的文件指纹（路径 + mtime）与结果；配置变更后自动重新扫描，
# 免去「改完 token 必须重启 sidecar」这一步——那一步很容易被忘掉，
# 忘掉的表现是语音突然 401，而错误信息指向的是「重启 sidecar」，
# 用户会以为服务挂了。
_token_cache: dict[str, Any] = {"fingerprint": None, "tokens": frozenset()}


def read_tokens() -> set[str]:
    """
    读取本机所有引擎实例写入的 token

    为什么是复数：sidecar 是**整机一份**的资源，而 token 是**按引擎实例/用户**
    生成的。只认其中一份，另一个入口（桌面 vs Web）就必然 401——实测
    `POST /api/voice/tts` 直接 502。接受本机全部合法 token 才能同时服务两者。

    返回空集合表示「没有任何配置声明 token」，此时放行（仅本机首次调试）。
    """
    paths = candidate_config_paths()
    fingerprint = []
    for path in paths:
        try:
            fingerprint.append((str(path), path.stat().st_mtime_ns))
        except OSError:
            fingerprint.append((str(path), 0))
    key = tuple(fingerprint)
    if _token_cache["fingerprint"] == key:
        return set(_token_cache["tokens"])
    tokens = _read_tokens_uncached()
    _token_cache["fingerprint"] = key
    _token_cache["tokens"] = frozenset(tokens)
    return tokens


# ---------------------------------------------------------------------------
# 依赖探测（导入成功不等于模型可用，分开报）
# ---------------------------------------------------------------------------

def probe_asr() -> dict[str, Any]:
    """
    ASR 就绪情况（不加载权重）

    与 `AsrEngine._resolve` 保持同一套判定顺序：本地 Qwen3-ASR 权重优先，
    其次 whisper。这里只验"库在 + 目录在"，真正的加载要等首次识别。

    @returns {"backend","model","ready"}[,"reason"]
    """
    explicit = os.environ.get("DEEPCODE_ASR_MODEL_PATH", "").strip()
    local = os.path.expanduser(explicit or DEFAULT_ASR_LOCAL_PATH)
    if os.path.isdir(local):
        try:
            from mlx_audio.stt import load as _load_stt  # noqa: F401

            return {
                "backend": "qwen3-asr",
                # model 给人看（界面直接展示），path 是实际权重目录
                "model": ASR_QWEN3_MODEL_ID,
                "path": local,
                "ready": True,
            }
        except Exception as exc:  # noqa: BLE001 - 环境相关
            return {
                "backend": "qwen3-asr",
                "model": ASR_QWEN3_MODEL_ID,
                "path": local,
                "ready": False,
                "reason": f"mlx_audio.stt 不可用：{exc}",
            }
    try:
        import mlx_whisper  # noqa: F401

        return {
            "backend": "whisper",
            "model": DEFAULT_ASR_MODEL,
            "ready": True,
            "reason": f"未找到本地 Qwen3-ASR 权重（{local}），使用 whisper 兜底",
        }
    except Exception as exc:  # noqa: BLE001 - 环境相关
        return {
            "backend": "whisper",
            "model": DEFAULT_ASR_MODEL,
            "ready": False,
            "reason": f"mlx_whisper 不可用：{exc}",
        }


def probe_deps() -> dict[str, Any]:
    """探测依赖与模型是否可导入（不加载权重）"""
    out: dict[str, Any] = {"versions": {}, "asr": {}, "tts": {}}
    try:
        import mlx.core as mx  # noqa: F401

        out["versions"]["mlx"] = getattr(mx, "__version__", "unknown")
    except Exception as exc:  # pragma: no cover - 环境相关
        out["versions"]["mlx"] = f"missing: {exc}"

    try:
        out["asr"] = probe_asr()
        out["versions"]["mlx_whisper"] = "ok"
    except Exception as exc:  # pragma: no cover - 环境相关
        out["asr"] = {"ready": False, "reason": str(exc)}

    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.utils import load_model  # noqa: F401

        # mlx_audio 只是"库在"，具体模型要等首次加载才知道能不能跑
        out["tts"] = {
            "engine": DEFAULT_TTS_ENGINE,
            "model": resolve_tts_model_id(DEFAULT_TTS_ENGINE),
            # 预置音色列表：/health 报出来，用户才知道能填哪些名字
            "speakers": list(CUSTOMVOICE_SPEAKERS),
            "ready": True,
        }
        out["versions"]["mlx_audio"] = getattr(mlx_audio, "version", None) or "ok"
    except Exception as exc:
        out["tts"] = {
            "engine": DEFAULT_TTS_ENGINE,
            "model": resolve_tts_model_id(DEFAULT_TTS_ENGINE),
            "ready": False,
            "reason": f"mlx_audio 不可用：{exc}",
        }
    return out


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

class TtsEngine:
    """
    按引擎缓存已加载的模型（加载一次几十秒，不能每个请求都加载）

    用锁串行化合成：`ThreadingHTTPServer` 会并发处理请求，而 MLX 的
    计算图与模型状态不是线程安全的。前端播报队列 + 用户手动试听完全
    可能同时打到两个请求，不加锁的表现是随机崩溃或串音。

    三种引擎的调用方式不同，不能统一成 `generate()`：
    - VoiceDesign：`generate_voice_design(text, instruct, language)`
    - CustomVoice：`generate_custom_voice(text, speaker, language, instruct)`
    - Kokoro：`generate(text, voice, speed, lang_code)`
    这些都是 mlx-audio 0.6.4 的真实签名，不是推测。
    """

    def __init__(self) -> None:
        self._models: dict[str, Any] = {}
        self._lock = threading.Lock()

    def _load(self, engine: str) -> Any:
        """按需加载并缓存模型"""
        if engine in self._models:
            return self._models[engine]
        model_id = resolve_tts_model_id(engine)
        from mlx_audio.tts.utils import load_model

        model = load_model(model_id)
        self._models[engine] = model
        return model

    def synthesize(self, text: str, engine: str, voice: str, speed: float) -> bytes:
        """
        合成一段语音，返回 WAV 字节。

        `voice` 的语义随引擎变化：VoiceDesign 是**音色描述**，
        CustomVoice 是预置 speaker 名，Kokoro 是音色 id。
        """
        import numpy as np

        if engine not in MODEL_IDS:
            engine = DEFAULT_TTS_ENGINE

        with self._lock:
            model = self._load(engine)

            # 固定采样种子：每句都是独立调用，不固定就会一句一个音色
            # （见 TTS_SEED_BASE 的说明）。放在锁内、紧挨生成之前，
            # 保证并发的两个请求不会互相打乱随机状态。
            temperature = prepare_sampling(voice)

            if engine == "qwen3-voicedesign":
                chunks = list(
                    model.generate_voice_design(
                        text=text,
                        instruct=voice or "mature female voice, calm and steady",
                        language=TTS_LANGUAGE,
                        temperature=temperature,
                    )
                )
                native_speed = False
            elif engine == "qwen3-customvoice":
                # 音色锁在预置 speaker 上，跨句不再重新"设计"；原描述降级为
                # 情感/风格指令（1.7B 支持，0.6B 会被模型内部忽略）
                speaker, instruct = resolve_speaker(voice)
                chunks = list(
                    model.generate_custom_voice(
                        text=text,
                        speaker=speaker,
                        language=TTS_LANGUAGE,
                        instruct=instruct,
                    )
                )
                native_speed = False
            else:
                chunks = list(
                    model.generate(
                        text=text,
                        voice=voice or KOKORO_VOICE,
                        speed=speed,
                        lang_code="z",
                    )
                )
                native_speed = True

            if not chunks:
                raise RuntimeError("模型没有产出音频")

            audio = np.concatenate([np.array(c.audio, dtype=np.float32).reshape(-1) for c in chunks])
            rate = int(chunks[0].sample_rate)

        # Qwen3-TTS 的 generate_* 没有 speed 参数，只能用重采样变速。
        # 代价是音高跟着变（像磁带快进），对语音助手的 0.8~1.3 倍区间
        # 听感可接受；kokoro 走原生 speed，不做这一步。
        if not native_speed and speed != 1.0 and speed > 0:
            target = max(1, int(len(audio) / speed))
            audio = np.interp(
                np.linspace(0, len(audio), target, endpoint=False),
                np.arange(len(audio)),
                audio,
            )

        return encode_wav_bytes(audio, rate)


def encode_wav_bytes(samples: "Any", sample_rate: int) -> bytes:
    """
    Float32 单声道样本 → PCM16 WAV 字节

    @param samples numpy 数组（-1~1）
    @param sample_rate 采样率
    @returns WAV 字节
    """
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm16.tobytes())
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# ASR
# ---------------------------------------------------------------------------

class AsrEngine:
    """
    转写：优先 Qwen3-ASR（本地权重），不可用时回落到 whisper

    ## 为什么要两档而不是写死一个

    Qwen3-ASR 的准确性明显更好（见文件头 A/B 数据），但它需要本地权重目录。
    目录不存在时（新机器、清过缓存、换过用户）如果直接抛错，用户看到的是
    「语音坏了」——而 whisper 那条路本来就是能用的。所以：本地权重在就用它，
    不在就回落 whisper，具体用了哪个由 `/health` 的 `asr.backend` 如实报出。

    推理期失败也一样回落：权重损坏、版本不兼容都只该降级一次，不该让识别
    整个不可用。

    ## 为什么加锁

    与 TTS 同源：MLX 推理并发不安全，且首次调用会加载权重。`ThreadingHTTPServer`
    会并发处理请求，不加锁的表现是随机崩溃。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engine: Any = None
        self._backend = ""
        self._display = ""
        self._model = ""
        self._reason = ""

    def _resolve(self) -> None:
        """决定用哪个引擎（只看文件是否存在，不加载权重）"""
        if self._backend:
            return
        explicit = os.environ.get("DEEPCODE_ASR_MODEL_PATH", "").strip()
        candidate = os.path.expanduser(explicit or DEFAULT_ASR_LOCAL_PATH)
        if os.path.isdir(candidate):
            self._backend = "qwen3-asr"
            self._display = ASR_QWEN3_MODEL_ID
            self._model = candidate
            return
        self._backend = "whisper"
        self._display = DEFAULT_ASR_MODEL
        self._model = DEFAULT_ASR_MODEL
        self._reason = f"未找到本地 Qwen3-ASR 权重（{candidate}），已回落 whisper"

    def describe(self) -> dict[str, Any]:
        """当前实际使用的后端（/health 用）"""
        self._resolve()
        info: dict[str, Any] = {"backend": self._backend, "model": self._display}
        if self._model != self._display:
            # 本地权重目录不是给人看的，单独给一个字段，界面只展示 model
            info["path"] = self._model
        if self._reason:
            info["reason"] = self._reason
        return info

    def transcribe(self, wav_bytes: bytes) -> dict[str, Any]:
        """把 WAV 字节转成文本"""
        self._resolve()
        with self._lock:
            audio, duration_ms = decode_wav_to_mono16k(wav_bytes)
            if self._backend == "qwen3-asr":
                try:
                    return self._transcribe_qwen(audio, duration_ms)
                except Exception as exc:  # noqa: BLE001 - 任何推理失败都只降级一次
                    self._backend = "whisper"
                    self._display = DEFAULT_ASR_MODEL
                    self._model = DEFAULT_ASR_MODEL
                    self._reason = f"Qwen3-ASR 推理失败（{exc}），已回落 whisper"
                    self._engine = None
            return self._transcribe_whisper(audio, duration_ms)

    def _transcribe_qwen(self, audio: Any, duration_ms: int) -> dict[str, Any]:
        """Qwen3-ASR（mlx_audio）"""
        from mlx_audio.stt import load as load_stt

        if self._engine is None:
            self._engine = load_stt(self._model)
        # generate 接受 numpy 数组：不必落临时文件，省一次磁盘写
        result = self._engine.generate(audio, language=ASR_LANGUAGE, hotwords=asr_hotwords())
        text = getattr(result, "text", None)
        if text is None:
            text = str(result)
        return {
            "text": str(text).strip(),
            "durationMs": duration_ms,
            "model": self._display,
            "backend": "qwen3-asr",
        }

    def _transcribe_whisper(self, audio: Any, duration_ms: int) -> dict[str, Any]:
        """whisper 兜底（mlx_whisper）"""
        import mlx_whisper

        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._model,
            language=ASR_WHISPER_LANGUAGE,
            initial_prompt=ASR_WHISPER_PROMPT,
        )
        return {
            "text": (result.get("text") or "").strip(),
            "durationMs": duration_ms,
            "model": self._display,
            "backend": "whisper",
        }


def asr_hotwords() -> list[str]:
    """
    专有名词提示（Qwen3-ASR 的 hotwords）

    环境变量 `DEEPCODE_ASR_HOTWORDS`（逗号分隔）优先，未设置时用默认表。
    返回空列表也是合法输入（等于关闭热词）。

    @returns 热词列表
    """
    raw = os.environ.get("DEEPCODE_ASR_HOTWORDS", "").strip()
    if raw:
        return [word.strip() for word in raw.split(",") if word.strip()]
    return list(ASR_HOTWORDS_DEFAULT)


def decode_wav_to_mono16k(wav_bytes: bytes) -> tuple[Any, int]:
    """
    WAV 字节 → (float32 单声道 16k, 时长毫秒)

    两个 ASR 后端都要 16k 单声道 float32，所以解码只做一次。前端上传的是
    44.1k/48k 立体声（`encodeWav` 按 `audio.sampleRate` 原样写），这里不
    转换就会让模型听到变速的声音。

    @param wav_bytes 原始 WAV
    @returns (音频数组, 时长毫秒)
    """
    import numpy as np

    with wave.open(io.BytesIO(wav_bytes), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.getnframes()
        pcm = handle.readframes(frames)

    duration_ms = int(frames / rate * 1000) if rate else 0
    if width != 2:
        raise RuntimeError(f"仅支持 16-bit PCM，收到 {width * 8}-bit")

    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # 线性插值到 16k：两个模型都按 16k 训练，粗略重采样对识别影响很小
        target = int(len(audio) * 16000 / rate)
        audio = np.interp(
            np.linspace(0, len(audio), target, endpoint=False),
            np.arange(len(audio)),
            audio,
        )
    return audio, duration_ms


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """极简路由：只有四个端点，不引入框架"""

    server_version = "DeepCodeVoice/1.0"
    tts = TtsEngine()
    asr = AsrEngine()

    # ---- 工具 ----

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D102
        sys.stderr.write("[voice] " + (fmt % args) + "\n")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        """
        校验 Bearer token

        接受本机任意一份配置里的 token（见 `read_tokens` 的说明）：桌面与 Web
        是两个引擎实例，各自生成一份 token，而 sidecar 只有一份。
        没有任何配置声明 token 时放行，便于本机首次调试。
        比较用 `hmac.compare_digest`，避免按字节提前返回泄漏前缀。
        """
        tokens = read_tokens()
        if not tokens:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        presented = header[len("Bearer ") :]
        matched = False
        for candidate in tokens:
            # 不短路：每个候选都跑一次比较，耗时差可忽略，时序不泄漏"第几个命中"
            if hmac.compare_digest(presented, candidate):
                matched = True
        return matched

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    # ---- 路由 ----

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._send_json(404, {"error": f"未知路径 {self.path}"})
            return
        deps = probe_deps()
        self._send_json(
            200,
            {
                "ok": True,
                "model": {"asr": deps["asr"], "tts": deps["tts"]},
                "versions": {
                    "python": sys.version.split()[0],
                    "pid": str(os.getpid()),
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    **deps["versions"],
                },
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._authorized():
                self._send_json(401, {"code": "UNAUTHORIZED", "reason": "token 不匹配"})
                return
            if self.path == "/warmup":
                probe = probe_deps()
                self._send_json(200, {"ok": True, "model": probe["tts"]})
                return
            if self.path == "/tts":
                self._handle_tts()
                return
            if self.path == "/asr":
                self._handle_asr()
                return
            self._send_json(404, {"error": f"未知路径 {self.path}"})
        except Exception as exc:  # 兜底：任何异常都要有结构化返回，不能静默断连
            traceback.print_exc()
            self._send_json(500, {"code": "INTERNAL", "reason": str(exc)})

    def _handle_tts(self) -> None:
        payload = json.loads(self._read_body() or b"{}")
        text = str(payload.get("text") or "").strip()
        if not text:
            self._send_json(400, {"code": "EMPTY_TEXT", "reason": "text 不能为空"})
            return
        engine = str(payload.get("engine") or DEFAULT_TTS_ENGINE)
        voice = str(payload.get("voice") or "")
        # 手改配置 / 旧客户端可能传字符串，坏值回落 1.0 而不是抛 500
        try:
            speed = float(payload.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(2.0, max(0.5, speed))
        started = time.time()
        audio = self.tts.synthesize(text, engine, voice, speed)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Synth-Ms", str(int((time.time() - started) * 1000)))
        self.end_headers()
        self.wfile.write(audio)

    def _handle_asr(self) -> None:
        audio = self._read_body()
        if not audio:
            self._send_json(400, {"code": "EMPTY_AUDIO", "reason": "音频为空"})
            return
        self._send_json(200, self.asr.transcribe(audio))


def main() -> int:
    """入口"""
    parser = argparse.ArgumentParser(description="DeepCode 本机 MLX 语音 sidecar")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--selftest", action="store_true", help="只检查依赖并退出")
    args = parser.parse_args()

    # 启动时先扫一次，让日志里能立刻看到鉴权状态；之后每次请求按 mtime 校验，
    # 配置变更（含新增 Web 用户）无需重启 sidecar。
    tokens = read_tokens()

    if args.selftest:
        deps = probe_deps()
        print(json.dumps(deps, ensure_ascii=False, indent=2))
        ready = deps["asr"].get("ready") and deps["tts"].get("ready")
        print("\n结论：" + ("依赖齐全，可以启动服务" if ready else "依赖不全，按上面的 reason 处理"))
        return 0 if ready else 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[voice] 监听 http://{args.host}:{args.port}")
    print(f"[voice] 配置：{soul_config_path()}")
    print(
        "[voice] 鉴权："
        + (
            f"{len(tokens)} 份 token 已启用（本机桌面与 Web 引擎各一份；配置变动自动生效）"
            if tokens
            else "未声明 token（本机调试模式，任何请求都放行）"
        )
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[voice] 退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
