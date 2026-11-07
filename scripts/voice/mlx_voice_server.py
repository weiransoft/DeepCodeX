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
import struct
import sys
import threading
import time
import traceback
import urllib.parse
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# 与探针共用同一份 TNS 规则：从任意工作目录启动都要能 import 到同目录模块
sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_normalize import (  # noqa: E402
    TNS_VERSION,
    normalize_for_speech,
    request_tns_enabled,
    tns_enabled_by_env,
)
from atomic_chunks import atomic_spans, cut_ok, nearest_ok_cut  # noqa: E402

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8791

# TNS 默认打开（2026-11-07 产品决策），DCX_VOICE_TNS=0 一键回退原生文本。
# 请求体 {"tns": false} 可只关本次，供 A/B 真机对照，不必重启 sidecar。
TNS_ENABLED = tns_enabled_by_env()

# 结构感知分块（2026-11-07 调研报告 P0）：服务端二次切分时保护残留的
# 拉丁词 / 数字串 / 路径，避免规范化后的长文本再被硬切。默认关，
# DCX_VOICE_ATOMIC_CHUNK=1 打开；关闭时行为与 031f1cc2 逐字节一致。
ATOMIC_CHUNK_ENABLED = os.environ.get("DCX_VOICE_ATOMIC_CHUNK", "0") == "1"

# 短块句内静音上限（2026-11-07 调研报告 P1，默认关）。
#
# 根因不是「读得慢」：`num:xs`（14.3 单元）有声语速 5.219 u/s 正常，但模型
# 在短数字句里插了 4 段句内静音（最终输出合计 0.900s），把整段分母撑大到
# 3.659s → 3.908 u/s。更关键的是**逐段语速伺服被钳在 1.65 上限**：原始段
# 约 6.0s，即使拉满倍率也够不到 4.92 u/s 目标，所以伺服修不了它。
# `code:m` 在 P0 atomic 下出现的 3.396 u/s 是同一类现象。
#
# 做法：只对 ≤20 等效发音单元的短块，把超过 0.30s 的句内静音压到 0.30s，
# 且**在伺服之前**执行——短段变短后伺服倍率落回可达范围，语速才真正收敛。
# 长块不动（正常句读实测最长 0.68s，是听感的一部分）。
# 代价：短句停顿变短，需 WebView 真机听感确认，因此默认关、可一键回退。
SHORT_GAP_ENABLED = os.environ.get("DCX_VOICE_SHORT_GAP", "0") == "1"
SHORT_GAP_UNITS = 20.0
SHORT_GAP_MAX_S = 0.30


def request_short_gap_enabled(payload: dict) -> bool:
    """请求级覆盖：`{"shortGap": true}` 只开本次，便于同一 sidecar 做 A/B。

    语义与 `text_normalize.request_tns_enabled()` 一致：字符串 "0"/"false"/
    "off"/"no" 视为关。缺省跟随环境变量（默认关）。
    """
    raw = payload.get("shortGap")
    if raw is None:
        return SHORT_GAP_ENABLED
    if isinstance(raw, str):
        return raw.strip().lower() not in ("0", "false", "off", "no")
    return bool(raw)


def apply_tns(text: str, payload: dict) -> str:
    """TTS 文本前端：只改送去合成的文本，界面上的原文一个字都不动。"""
    if not request_tns_enabled(payload, TNS_ENABLED):
        return text
    norm = normalize_for_speech(text)
    if norm.changed:
        sys.stderr.write(
            f"[voice] TNS {TNS_VERSION} {len(text)}字→{len(norm.text)}字 "
            f"命中={','.join(f'{k}x{v}' for k, v in norm.hits.items())}\n"
        )
    return norm.text

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

# 流式分块的目标音频秒数。真机实测（41 字、热态，CustomVoice 1.7B）：
#   interval=2.0 → 首块 0.378s / 5 块
#   interval=1.0 → 首块 0.192s / 11 块   ← 默认
#   interval=0.5 → 首块 0.104s / 21 块
# 0.5s 首块更快但块数翻倍、解码开销上升；1.0s 是首字延迟与开销的平衡点。
TTS_STREAM_INTERVAL = 1.0
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

# 司南音色预设：配置里写 voice="sinan" 就拿到一整套 (speaker, 风格指令)。
#
# 为什么做成预设而不是「配置里分别填 speaker 和 instruct」：
# 1. 前端 /api/voice/tts 的 voice 字段只有一个值，网关原样转发；
# 2. 音色底子与风格指令拆开写，改一个字就"听起来不像同一个人"，
#    而它们本来就必须成对调整。
#
# 选 serena 的依据（2026-11-06 同文本 41 字实测，自相关 F0）：
#   serena  3.82 字/秒  F0 222.2Hz  跨度 94.0Hz
#   vivian  4.07 字/秒  F0 237.6Hz  跨度 103.7Hz  ← 偏亮的年轻女声
# 司南要的是成熟、中低音、克制，serena 音区低 15Hz、韵律更稳；慢的那 6%
# 由「语速稍快」指令与保调变速补回来，不用把音高一起抬上去。
VOICE_PRESETS: dict[str, tuple[str, str | None]] = {
    "sinan": (
        "serena",
        # 对齐 core 的 DEFAULT_VOICE_DESCRIPTION（成熟女性/中低音/克制不撒娇/
        # 句尾下沉）；只把「语速平稳」按本轮反馈改成「语速稍快」。
        "成熟女性，中低音区，语速稍快，吐字清晰，克制不撒娇，句尾下沉",
    ),
    # 备选：更亮、更利落的年轻女声，方便用户一句话切回来对比
    "sinan-bright": ("vivian", "语速稍快，吐字利落，不撒娇，不拖长音"),
}

# instruct 对韵律的实测影响（同文本，speaker=vivian）：
#   无指令          4.07 字/秒  F0 237.6Hz  跨度 103.7Hz
#   「利落稍快」     4.38 字/秒  F0 244.9Hz  跨度  80.5Hz  ← 快 7.6% 且更稳
# 所以风格指令里显式写「语速稍快」，而不是只靠 speed 参数硬拉。

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

    - 命中音色预设名（如 `sinan`）→ 取预设里的 (speaker, 风格指令)
    - 命中预置音色名（大小写、空格、连字符不敏感）→ 直接用
    - 否则 → 退回默认音色，原描述改当 `instruct`（1.7B 支持情感/风格指令）
      这样「语速正常、吐字清晰、利落」这类风格要求还能保留一部分

    @param voice 音色预设名、预置音色名或音色描述
    @returns (speaker, instruct)
    """
    text = (voice or "").strip()
    key = text.lower().replace("-", "_").replace(" ", "_")
    if key.replace("_", "-") in VOICE_PRESETS:
        return VOICE_PRESETS[key.replace("_", "-")]
    if key in VOICE_PRESETS:
        return VOICE_PRESETS[key]
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


# 每秒音频对应的声学 token 数（Qwen3-TTS 是 12Hz 模型，官方口径 12.5 token/s）
TTS_TOKENS_PER_SECOND = 12.5

# 中文朗读语速（等效发音单元/秒）
#
# 实测值，不是估值：三档文本（3 字 / 19 字 / 100 字）走 /tts 全链路量出的
# 音频时长换算都是 4.1 字/秒，彼此吻合。纯汉字文本下「单元数 == 汉字数」。
# 口径从「字符数」改成「等效发音单元数」的依据见下方 speech_units 的实测说明。
TTS_CHARS_PER_SECOND = 4.1

# ---------------------------------------------------------------------------
# 等效发音单元：语速伺服的正确分母（2026-11-07 长文本专项实测）
#
# 真机反馈「长文本还是会变语速，音色变了，讲话不自然不连贯」。用
# /tmp/dcx-longtext-probe/probe.py 复刻前端「切句 → 14/40/48 字封块 →
# 逐块独立请求」，两条 316/421 字真实回复的实测：
#
# | 语料       | 块数 | 块间语速极差 | 块间 F0 极差 | 极端块                     |
# |------------|------|--------------|--------------|----------------------------|
# | 纯中文     |    9 | 1.21%        | 20.57%       | —                          |
# | 中英混排   |   13 | **76.37%**   | 54.39%       | 13字→9.42字/秒、3字→F0 304Hz |
#
# 根因不是模型语速不稳，而是**分母错了**：`segment_stretch_speed()` 原来拿
# `len(piece.strip())`（字符数）当发音量。标点不发音、拉丁字母/数字按字符
# 计数却读得快，于是中英混排段被误判成「读得飞快」，倍率撞到下限 0.75
# 仍然压不回目标（实测冲到 9.42 字/秒）；纯中文段则按标点密度被施加
# 0.75~1.35 各不相同的 WSOLA 变速——**变速倍率本身制造了段间音色差**。
#
# 修法：把分母换成「等效发音单元」，模型原生语速在正确口径下本来就稳定，
# 于是伺服倍率普遍收敛到 1.0 附近，几乎不用做波形变速。语速与音色一起稳。
# ---------------------------------------------------------------------------
TTS_UNIT_LATIN_CHARS = 2.8
TTS_UNIT_DIGIT = 0.9
TTS_UNIT_DOT = 0.5
TTS_UNIT_ABBREV_MAX = 6

# 语速伺服总开关（诊断 / 一键回退用，默认开）。
# 设 DCX_VOICE_RATE_SERVO=0 会完全跳过保调变速，输出模型原生音频——用于
# 验证「原生语速在等效单元口径下是否稳定」，也方便出问题时秒回旧行为。
TTS_RATE_SERVO = os.environ.get("DCX_VOICE_RATE_SERVO", "1") != "0"


def speech_units(text: str) -> float:
    """
    把文本折算成「等效汉字发音单元数」，作为语速伺服的分母与目标口径。

    规则（按实测标定，不追求语言学精确，只求跨文本可比）：
    - 标点 / 空白 / 符号：0（不发音，但长短标点停顿的差异由音频时长体现）；
    - CJK 汉字 / 假名 / 谚文：1；
    - 拉丁字母连续串：字母数 / 2.8，最短 1；全大写短缩写逐字母念（每位 0.9）；
    - 数字串：每位 0.9，内部小数点/分隔符 0.5。

    @param text 待合成文本（已剥 Markdown）
    @returns 等效发音单元数（>= 0）
    """
    import unicodedata

    units = 0.0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if unicodedata.category(ch)[0] in ("P", "Z", "S", "C"):
            i += 1
            continue
        if ch.isascii() and ch.isalpha():
            j = i
            while j < n and text[j].isascii() and (text[j].isalpha() or text[j] in "'’"):
                j += 1
            word = text[i:j]
            letters = sum(1 for c in word if c.isalpha())
            if 0 < letters <= TTS_UNIT_ABBREV_MAX and word.isupper():
                units += letters * TTS_UNIT_DIGIT
            else:
                units += max(1.0, letters / TTS_UNIT_LATIN_CHARS)
            i = j
            continue
        if ch.isdigit():
            j = i
            digits = 0
            dots = 0
            while j < n:
                c = text[j]
                if c.isdigit():
                    digits += 1
                elif c in ".,:/-" and j + 1 < n and text[j + 1].isdigit():
                    dots += 1
                else:
                    break
                j += 1
            units += max(0.5, digits * TTS_UNIT_DIGIT + dots * TTS_UNIT_DOT)
            i = j
            continue
        units += 1.0
        i += 1
    return units

# ---------------------------------------------------------------------------
# 逐块语速伺服：把「全局等比变速」换成「按实测语速收敛到固定基准」
#
# 2026-11-06 真机反馈「还是存在语速跳变，句子一长就不行了」。同一音色、
# 同一 speed=1.2、同一次模型加载，实测**模型原生**语速（不入库探针
# /tmp/probe-rate-normalize.py）：
#
# | 样本          | 字数 | 原生语速   |
# |---------------|------|-----------|
# | 短句 14 字    |   14 | 4.09 字/秒 |
# | 短句 20 字    |   20 | 4.92 字/秒 |
# | 标准 41 字    |   41 | 4.17 字/秒 |
# | 无标点 41 字  |   41 | 5.08 字/秒 |
# | 无标点 48 字  |   48 | 5.35 字/秒 |
# | 逗号密集 48 字 |   48 | 4.72 字/秒 |
#
# 跨度 31%，取决于文本长度、标点密度与句法结构——模型「按块自选语速，
# 没有上一块的记忆」（业界与我们的观察一致）。原来的
# `time_stretch_wsola(audio, speed)` 是**整个请求一次等比变速**，只能整体
# 放大/缩小，压不住块间相对差；块一长、标点一少就明显「忽然变快」。
#
# 业界标准补救（inkwell pace-fix / ElevenLabs atempo）：实测每块字/秒，
# 用保调变速把偏离目标的部分拉回来；目标必须是**全局固定基准**，不能用
# 本轮中位数（否则整段一起快/一起慢时检测不出来）。这里的目标就是
# `TTS_CHARS_PER_SECOND × speed`，speed=1.2 → 4.92 字/秒。
#
# 离线可行性实测：按倍率 0.919~1.203 校正后，6 种文本全部收敛到
# 4.93 字/秒（±0.2%）。每次变速仍只做一次（不叠加），音高不变。
# ---------------------------------------------------------------------------
TTS_RATE_SPEED_MIN = 0.75
# 上限从 1.35 提到 1.65（2026-11-07 长文本第四轮实测）：
# `openai-provider 和 anthropic-provider。` 这类**纯拉丁复合词**块，模型原生
# 只有约 3.06 等效单元/秒，要拉回 4.92 需要 1.61 倍。旧上限把它钳在 1.35，
# 最终 4.14 单元/秒，成了整条中英混排里唯一的离群块（单元语速极差 17.08%）。
# 它不是退化段（块内最长静音 20ms），退化另由 trim_degenerate_tail() /
# compress_internal_gaps() / 门禁的 long_gaps_total 负责，不该靠倍率上限兜。
# WSOLA 保调变速在 1.6 倍仍是常见听书倍速范围内，音高不变。
TTS_RATE_SPEED_MAX = 1.65
# 段间微停顿：两次独立生成的波形硬接缝，业界用 50~200ms 微静音掩盖。
# 60ms 比正常句间停顿短，不会听成「断了一下」，又足够盖住相位跳变。
TTS_SEGMENT_GAP_S = 0.06

# 生成上限的安全系数与硬顶
#
# 为什么必须显式传 max_tokens（2026-11-06 实测）：
#   `_resolve_generation_options` 在调用方不给值时会回落到 checkpoint 里的
#   `max_new_tokens = 2048`——按 12.5 token/s 折算约 **164 秒音频**。
#   而合成是**持锁串行**的：一个跑飞的请求会把后面排队的请求全部堵住，
#   60 秒后前端逐个超时，表现为「语音服务不可用：This operation was aborted」，
#   sidecar 日志里则是一串 BrokenPipe（合成完了，但客户端已经走了）。
#
#   1.5 倍余量是按"念得比实测慢 50%"留的（2.7 字/秒），足够覆盖停顿多的文本；
#   再往上给只会让退化请求多跑几秒，不会让正常文本更好听。
TTS_MAX_TOKENS_HEADROOM = 1.5
TTS_MAX_TOKENS_FLOOR = 200
TTS_MAX_TOKENS_CEILING = 1024


def max_tokens_for(text: str) -> int:
    """
    按文本长度推导本次生成的 token 上限。

    估算链：字数 → 秒数（按实测语速）→ token 数，再乘安全余量。
    宁可略大也别太小：上限给低了会把话尾**截断**，那是听得出来的硬伤；
    给大了最多退化时多跑几秒。

    @param text 待合成文本
    @returns token 上限（含上下限钳制）
    """
    chars = len(text.strip()) or 1
    seconds = chars / TTS_CHARS_PER_SECOND
    tokens = int(seconds * TTS_TOKENS_PER_SECOND * TTS_MAX_TOKENS_HEADROOM)
    return max(TTS_MAX_TOKENS_FLOOR, min(TTS_MAX_TOKENS_CEILING, tokens))


# 单次生成的安全字数上限（与前端 player.ts 的 MAX_BLOCK_CHARS 对齐）
#
# 2026-11-06 实测（sidecar /tts，speed=1.2）：
# | 字数 | 时长 | 折合语速 | 最长静音 |
# |---|---|---|---|
# | 41 | 8.33s | 4.92 字/秒 | 0.66s |
# | 48 | 10.08s | 4.76 字/秒 | 0.79s |
# | 55 | 16.75s | 3.28 字/秒 | 4.67s |
# | 96 | 29.29s | 3.28 字/秒 | 21.49s |
# | 164 | 50.04s | 3.25 字/秒 | 21.51s |
#
# 退化不只是「尾部多吐了静音」：96 字那次裁完尾音只剩 8.00s 有声片段
# （按正常语速应有 19.5s），说明模型在长文本中途就塌缩了，后面的字
# 根本没念。所以**只裁尾不够**，必须在模型入口把请求拆短。
#
# 前端 SpeechQueue 已经把单块压到 48 字；这里是服务端的第二道保险：
# CLI、旧版 bundle、手工请求都指向同一个 sidecar，不能假设调用方都守规矩。
TTS_MAX_TEXT_CHARS = 48
TTS_SPLIT_PUNCT = "。！？!?；;，,、：:"
# 分段的最短尾段（等效单元不足这个值的碎片，模型会当成短促感叹句，用高音区、
# 极快语速念出来——实测 3 字块 F0 303.8Hz / 质心 4454.9Hz，13 字块 9.42 字/秒）
TTS_SPLIT_MIN_TAIL_UNITS = 10

# 极短请求（前端旧 bundle / CLI / 手工调用）的伺服护栏。
# 阈值必须只覆盖真正的碎片：中英混排的 48 字符块折算后常常只有 15~20 个
# 等效单元，阈值定 20 会把正常块全判成碎片、禁用伺服，实测单元语速极差
# 从 21% 反涨到 63%。只有 6 单元以下（≈3~13 字符）才是实测里 F0 冲到
# 300Hz、语速翻倍的异常块。护栏只轻推，真正的修法是前端不产生这种块。
TTS_SHORT_SEGMENT_UNITS = 6
TTS_SHORT_SPEED_MIN = 0.8
TTS_SHORT_SPEED_MAX = 1.25


def _split_boundary_class(text: str, cut: int) -> int:
    """切分点的自然度：0=标点后，1=空格/中英交界，2=词中间（最差）。

    硬切拉丁单词会把 `openai-provider` 拆成 `opena` + `i-provider`，
    两块各自起头念，听感比原来的短碎片还糟。所以达标切分点里必须先把
    词边界挑出来，只有在没有任何词边界可选时才接受硬切。
    """
    before = text[cut - 1]
    after = text[cut] if cut < len(text) else ""
    if before in TTS_SPLIT_PUNCT:
        return 0
    if before.isspace() or (after and after.isspace()):
        return 1
    if (ord(before) > 127) != (bool(after) and ord(after) > 127):
        return 1
    return 2


def rebalance_tail(
    prev: str, tail: str, min_units: float, limit: int, spans: list[tuple[int, int]] | None = None
) -> list[str]:
    """把「前一段 + 过短尾段」重划切分点，让两段都达到最短发音量。

    这是长文本碎片护栏的核心，也是 2026-11-07 第四轮真机复测里最后一处
    漏洞：**借多少必须按等效发音单元算，不能按字符算**。旧实现直接拿
    `min_units - speech_units(tail)` 当字符数往前借；中英混排里 1 个字符
    常常只值 0.36 单元，缺 3 单元只借 3 字符，借完仍然是 7~8 单元的碎片，
    照样被单独发一次合成请求（实测 `和 anthropic-provider。` 22 字符 /
    7.07 单元，把整条语料的单元语速极差从 1.38% 拉到 21.27%）。

    做法：把两段按原文顺序拼起来，在合法区间里枚举所有切分点，只保留
    「左右两段都 >= min_units」的；优先落在标点后，其次尽量靠近原切分点
    （少改动已经稳定的块）。发音量本来就撑不起两段时，退化成最大化
    较小那段的发音量，绝不吞字、不重复。

    @param prev 前一段
    @param tail 过短的尾段
    @param min_units 每段最短等效发音单元数
    @param limit 每段字数硬上限
    @returns 1~2 段，拼接后逐字等于 prev + tail
    """
    merged = prev + tail
    if len(merged) <= limit or not prev:
        return [merged]
    # 切分点合法区间：左段 <= limit，右段 <= limit
    lo = max(1, len(merged) - limit)
    hi = min(limit, len(merged) - 1)
    if lo > hi:
        return [merged[:limit], merged[limit:]]

    # 结构感知开关打开时，枚举先排除落在原子内部的切点；spans 为 None
    # （默认）时完全走原口径，保证关闭状态逐字节可复现。
    candidates = [c for c in range(lo, hi + 1) if spans is None or cut_ok(spans, c)]
    if spans is not None and not candidates:
        # 服务端是「每段 ≤limit」的最后一道保险，不能像前端那样放出超长块
        # （>50 字会触发 Qwen3-TTS 退化出十几秒尾部静音）。没有合法切点就
        # 诚实降级到无保护的原实现，宁可切开一个超长拉丁串，也不破坏长度上限。
        return rebalance_tail(prev, tail, min_units, limit)
    valid = [
        c
        for c in candidates
        if speech_units(merged[:c]) >= min_units and speech_units(merged[c:]) >= min_units
    ]
    if valid:
        # 都达标时优先自然断口（标点 > 词边界 > 词中间），其次少改动
        best = min(valid, key=lambda c: (_split_boundary_class(merged, c), abs(c - len(prev))))
    else:
        # 总发音量撑不起两块时，让较小那段尽量大，别把碎片甩到最后一段
        best = min(
            candidates,
            key=lambda c: (
                -min(speech_units(merged[:c]), speech_units(merged[c:])),
                _split_boundary_class(merged, c),
                abs(c - len(prev)),
            ),
        )
    return [merged[:best], merged[best:]]


def split_long_text(
    text: str, limit: int = TTS_MAX_TEXT_CHARS, atomic: bool | None = None
) -> list[str]:
    """
    把超长文本切成 ≤limit 字的片段，优先在标点处断

    与前端 `splitLongText()` 用同一套规则，保证两端看到的分段一致。
    拼接回去逐字等于原文（只去掉首尾空白），不会吞字也不会重复。

    `atomic`（默认取环境变量 `DCX_VOICE_ATOMIC_CHUNK`，默认关）打开时，
    切点额外排除 JSON / URL / 拉丁词 / 数字串内部。这一段作用在**规范化
    之后**的文本上，只是兜住残留的结构；真正的结构保护在前端（前端先把
    原文送进一个请求，TNS 才有机会还原完整的 `{...}`）。关闭时与
    `031f1cc2` 完全一致，见 `atomic_chunks.py`。

    @param text 待切分文本
    @param limit 每段字数上限
    @param atomic 是否启用结构感知切分（None = 跟随环境变量）
    @returns 片段列表
    """
    rest = text.strip()
    if not rest:
        return []
    if len(rest) <= limit:
        return [rest]
    use_atomic = ATOMIC_CHUNK_ENABLED if atomic is None else atomic
    out: list[str] = []
    minimum = max(1, int(limit * 0.6))
    while len(rest) > limit:
        spans = atomic_spans(rest) if use_atomic else None
        cut = -1
        # 从上限往前找标点，别把一句话拦腰切断；找不到就按字数硬切
        for i in range(limit, minimum - 1, -1):
            if rest[i - 1] in TTS_SPLIT_PUNCT and (spans is None or cut_ok(spans, i)):
                cut = i
                break
        if cut < 0 and spans is not None:
            cut = nearest_ok_cut(spans, limit, minimum)
        if cut < 0:
            # 服务端必须守住 ≤limit：原子横跨整个回扫区间时诚实降级硬切，
            # 不把超长块放进模型（前端那一层才允许整体挪到下一请求）。
            cut = limit
        out.append(rest[:cut])
        rest = rest[cut:]

    # 尾段平衡：几字碎片会让模型用「短促感叹句」的韵律起头（高音区、快语速），
    # 在长文本里听感就是"忽然换了个人"。能并回前段就并；并不下就从前段尾部
    # 借一段，让两段都达到最短发音量。拼接逐字等于原文，不吞字不重复。
    if rest and out and speech_units(rest) < TTS_SPLIT_MIN_TAIL_UNITS:
        # 借多少按等效发音单元算（见 rebalance_tail），不能拿单元缺口当字符数：
        # 中英混排 1 字符常只有 0.36 单元，按字符借会留下 7~8 单元的碎片。
        merged_spans = atomic_spans(out[-1] + rest) if use_atomic else None
        balanced = rebalance_tail(out[-1], rest, TTS_SPLIT_MIN_TAIL_UNITS, limit, merged_spans)
        out[-1] = balanced[0]
        rest = balanced[1] if len(balanced) > 1 else ""
    if rest:
        out.append(rest)
    return out


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


def configured_engine() -> str:
    """
    取用户配置里指定的 TTS 引擎，用于启动预热

    桌面与 Web 共用同一个 sidecar，但各有一份配置。这里按 `candidate_config_paths`
    的顺序取第一份合法值——预热只是为了省掉首句的冷加载，选错引擎最多白加载
    一次（真正请求时按请求体里的 engine 为准）。
    """
    for path in candidate_config_paths():
        try:
            voice = json.loads(path.read_text(encoding="utf-8")).get("voice", {})
        except Exception:
            continue
        engine = voice.get("engine")
        if isinstance(engine, str) and engine in MODEL_IDS:
            return engine
    return DEFAULT_TTS_ENGINE


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

        # mlx_audio 只是"库在"，具体模型要等首次加载才知道能不能跑。
        # 这里报**配置里的**引擎而不是 DEFAULT_TTS_ENGINE：health 是排查
        # 「音色不对」的第一现场，报硬编码常量会把排查方向带偏
        # （2026-11-06 就因此以为引擎没切过来）。
        configured = configured_engine()
        out["tts"] = {
            "engine": configured,
            "model": resolve_tts_model_id(configured),
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

    def loaded(self) -> list[str]:
        """
        已经常驻内存的引擎名（升序）

        /health 报出来，是为了区分「配置切了但权重还没加载」与「真的在跑新引擎」。
        预热线程也可能还没跑完，列表为空就说明首句仍要冷加载。
        """
        return sorted(self._models)

    def _load(self, engine: str) -> Any:
        """按需加载并缓存模型"""
        if engine in self._models:
            return self._models[engine]
        model_id = resolve_tts_model_id(engine)
        from mlx_audio.tts.utils import load_model

        model = load_model(model_id)
        self._models[engine] = model
        return model

    def warm(self, engine: str) -> None:
        """
        预加载模型（启动时后台调用）

        冷加载实测 13s。不预热这段开销就落在用户的第一句上，而播报队列会
        预取三块，逐块排队时很容易把前端 60s 超时吃掉一截——表现为
        「语音服务不可用：This operation was aborted」。放到启动后的后台线程
        里，用户开口时模型已在内存，首块合成降到几百毫秒。

        @param engine 要预热的引擎名（非法值回落配置里的引擎）
        """
        if engine not in MODEL_IDS:
            # 预热错引擎等于白等一次冷加载：非法值按配置走，而不是硬编码默认
            engine = configured_engine()
        with self._lock:
            self._load(engine)

    def iter_stream(
        self,
        text: str,
        engine: str,
        voice: str,
        speed: float,
        interval: float,
        short_gap: bool | None = None,
    ) -> "Any":
        """
        流式合成：**段级生成 → 逐段语速伺服 → 分块 yield 独立完整 WAV**

        为什么每个 chunk 单独封 WAV：浏览器 `decodeAudioData` 需要完整容器，
        给一段裸 PCM 它无法解码。独立 WAV 让前端收到一块就能立刻解码、排进
        AudioContext 时间轴。

        为什么要等「一段」生成完才吐（2026-11-06 语速伺服改造）：严格语速
        归一化必须先量出这段实际读了多久，数学上不可能在只拿到第一片时预知。
        折中是把段做小——前端 `FIRST_BLOCK_CHARS=14`，首段热态约 0.7s 就能
        出声，后续段在前一段播放期间并行生成（RTF≈0.2），播放不会断。换来
        的是所有段语速严格收敛到全局固定基准（离线实测 4.93 字/秒 ±0.2%）。

        段内用 `StreamingWsola` 有状态变速，块边界天然连续（与整块 `/tts`
        逐样本等价）；段间各自按实测语速归一化，用 60ms 微静音盖住两次独立
        模型生成的相位跳变。锁只覆盖 MLX 生成，不覆盖 yield —— 客户端读得
        慢不该占着整条语音链路共用的推理锁。

        @param text 待合成文本
        @param engine 引擎（目前只有 CustomVoice 支持流式）
        @param voice 音色预设 / 预置名
        @param speed 语速（作为全局目标基准的倍率：4.1 × speed 字/秒）
        @param interval 输出切片的目标秒数（不再是模型吐块的间隔）
        @yields 单块 WAV 字节
        """
        import numpy as np

        if engine != "qwen3-customvoice":
            # 其它引擎没有 stream 参数：一次性生成完再 yield，语义仍正确，
            # 只是拿不到流式收益。不静默回落，日志里会写明。
            audio, _, _ = self.synthesize(text, engine, voice, speed, short_gap=short_gap)
            yield audio
            return

        speaker, instruct = resolve_speaker(voice)
        pieces = split_long_text(text)
        if len(pieces) > 1:
            sys.stderr.write(
                f"[voice] tts-stream {len(text)}字 超过 {TTS_MAX_TEXT_CHARS} 字安全上限，"
                f"自动分 {len(pieces)} 段合成\n"
            )

        # **逐段流水线**：一段生成完立刻吐出去，再拿锁生成下一段。首块延迟
        # 因此只等于第一段（前端首块 14 字，热态约 0.7s）；若先把所有段都
        # 攒齐再吐，164 字实测要等 7.7s，那就完全不是流式了。锁只覆盖
        # MLX 推理这一段，裁剪/变速/切块/客户端读取都在锁外。
        applied: list[float] = []
        for seg_index, piece in enumerate(pieces):
            with self._lock:
                model = self._load(engine)
                # 每段重新按音色派生固定种子，避免跨段随机状态串味
                temperature = prepare_sampling(voice)
                max_tokens = max_tokens_for(piece)
                raw_chunks: list[Any] = []
                silent_run = 0
                stopped_early = False
                rate = 24000
                for chunk in model.generate_custom_voice(
                    text=piece,
                    speaker=speaker,
                    language=TTS_LANGUAGE,
                    instruct=instruct,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=True,
                    streaming_interval=interval,
                ):
                    rate = int(chunk.sample_rate)
                    raw = np.asarray(chunk.audio, dtype=np.float32).reshape(-1)
                    # 退化判定放在变速**之前**的原始样本上：连续几块全静音
                    # 就掐断本段生成器，既不把十几秒空白推给浏览器，也省下
                    # 剩余推理时间。
                    if is_silent_chunk(raw):
                        silent_run += 1
                        if silent_run > STREAM_SILENT_CHUNK_LIMIT:
                            stopped_early = True
                            break
                    else:
                        silent_run = 0
                    raw_chunks.append(raw)
                if stopped_early:
                    sys.stderr.write(
                        f"[voice] tts-stream {len(piece)}字 检测到退化静音，"
                        f"连续 {silent_run} 块后提前收尾\n"
                    )

            if not raw_chunks:
                continue
            samples = compress_segment_gaps(
                trim_speech_edges(trim_degenerate_tail(np.concatenate(raw_chunks), rate), rate),
                rate,
                speech_units(piece),
                short_gap,
            )
            if samples.size == 0:
                continue
            seg_speed = segment_servo_speed(samples, rate, piece, speed)
            applied.append(seg_speed)
            # 段内一条有状态时间轴：分块喂与整段一次 time_stretch_wsola()
            # 逐样本相等，流式与整块 /tts 产出的音频因此完全一致。
            stretcher = StreamingWsola(seg_speed)
            block = max(1, int(interval * rate))
            for start in range(0, samples.size, block):
                out = stretcher.feed(samples[start : start + block])
                if out.size > 0:
                    yield encode_wav_bytes(out, rate)
            # flush 不能漏：最后 frame_len + search 个样本还压在 OLA 缓冲里
            tail = stretcher.flush()
            if tail.size > 0:
                yield encode_wav_bytes(tail, rate)
            if seg_index < len(pieces) - 1:
                yield encode_wav_bytes(
                    np.zeros(int(TTS_SEGMENT_GAP_S * rate), dtype=np.float32), rate
                )

        if applied and any(abs(s - speed) > 0.05 for s in applied):
            sys.stderr.write(
                f"[voice] 流式语速伺服 {len(applied)}段 倍率 "
                f"{','.join(f'{s:.2f}' for s in applied)} "
                f"目标 {TTS_CHARS_PER_SECOND * speed:.2f}字/秒\n"
            )

    def synthesize(
        self, text: str, engine: str, voice: str, speed: float, short_gap: bool | None = None
    ) -> tuple[bytes, str, str]:
        """
        合成一段语音。

        @param text 待合成文本
        @param engine 引擎名（非法值回落默认引擎）
        @param voice 音色（语义随引擎变化，见上）
        @param speed 语速
        @returns (WAV 字节, 实际使用的引擎, 实际使用的音色)
        """
        import numpy as np

        if engine not in MODEL_IDS:
            # 引擎名写错时按配置回落：硬编码回落 VoiceDesign 会静默让音色
            # 回到"每次现场设计"的老路上，而调用方看不出异常
            engine = configured_engine()
        # 实际生效的音色要回显给调用方：排查"音色不对"时，第一件要确认的事
        # 就是这次请求到底用了哪个 speaker，而不是靠配置反推
        voice_used = voice

        pieces = split_long_text(text)
        if len(pieces) > 1:
            sys.stderr.write(
                f"[voice] tts {len(text)}字 超过 {TTS_MAX_TEXT_CHARS} 字安全上限，"
                f"自动分 {len(pieces)} 段合成\n"
            )

        with self._lock:
            model = self._load(engine)

            # 音色只跟请求有关，跟片段无关：解析一次并回显给调用方
            if engine == "qwen3-customvoice":
                speaker, instruct = resolve_speaker(voice)
                voice_used = speaker
            elif engine == "qwen3-voicedesign":
                voice_used = voice
            else:
                voice_used = voice or KOKORO_VOICE
            native_speed = engine not in ("qwen3-customvoice", "qwen3-voicedesign")

            # 只攒原始波形，裁剪与变速放到锁外：那是纯 numpy 计算，
            # 没必要占着整条语音链路共用的 MLX 推理锁。
            raw_parts: list[tuple[str, Any, int]] = []
            for piece in pieces:
                # 每段都重新按音色派生固定种子：MLX 的 RNG 是全局状态，
                # 不重置的话第二段会接着第一段的随机序列走，跨段音色就漂了。
                # 放在锁内、紧挨生成之前，并发请求不会互相打乱随机状态。
                temperature = prepare_sampling(voice)
                # 显式给生成上限：不给会回落到 2048（≈164s 音频），退化时拖死整条队列
                max_tokens = max_tokens_for(piece)

                if engine == "qwen3-voicedesign":
                    chunks = list(
                        model.generate_voice_design(
                            text=piece,
                            instruct=voice or "mature female voice, calm and steady",
                            language=TTS_LANGUAGE,
                            temperature=temperature,
                            max_tokens=max_tokens,
                        )
                    )
                elif engine == "qwen3-customvoice":
                    # 音色锁在预置 speaker 上，跨句不再重新"设计"；原描述降级为
                    # 情感/风格指令（1.7B 支持，0.6B 会被模型内部忽略）
                    chunks = list(
                        model.generate_custom_voice(
                            text=piece,
                            speaker=speaker,
                            language=TTS_LANGUAGE,
                            instruct=instruct,
                            # 温度必须显式传：这个方法的默认值是模型自带的（高温），
                            # 不传就等于每次合成都在高温下重新掷骰子——韵律、语速、
                            # 句末走向句句不同，听感就是"音色在变"。VoiceDesign 那条
                            # 分支一直传着，CustomVoice 这条漏了（2026-11-06 补）。
                            temperature=temperature,
                            max_tokens=max_tokens,
                        )
                    )
                else:
                    chunks = list(
                        model.generate(
                            text=piece,
                            voice=voice_used,
                            speed=speed,
                            lang_code="z",
                        )
                    )

                if not chunks:
                    continue
                audio = np.concatenate([np.array(c.audio, dtype=np.float32).reshape(-1) for c in chunks])
                raw_parts.append((piece, audio, int(chunks[0].sample_rate)))

        if not raw_parts:
            raise RuntimeError("模型没有产出音频")

        # 逐段语速伺服：裁首尾机械静音 → 实测语速 → 一次保调变速 → 拼接。
        # 每段独立变速而不是整段一次等比，是为了压住模型「按块自选语速」
        # 带来的块间跳变；段内仍只变速一次，没有分块边界失真。
        part_audio: list[Any] = []
        rate = 24000
        applied: list[float] = []
        for piece, raw, rate in raw_parts:
            samples = compress_segment_gaps(
                trim_speech_edges(trim_degenerate_tail(raw, rate), rate),
                rate,
                speech_units(piece),
                short_gap,
            )
            if samples.size == 0:
                continue
            if native_speed:
                out = samples
            else:
                seg_speed = segment_servo_speed(samples, rate, piece, speed)
                applied.append(seg_speed)
                out = time_stretch_wsola(samples, seg_speed)
            # 两次独立生成的波形硬接缝，用一小段静音盖住相位跳变
            if part_audio:
                part_audio.append(np.zeros(int(TTS_SEGMENT_GAP_S * rate), dtype=np.float32))
            part_audio.append(out)

        if not part_audio:
            raise RuntimeError("模型没有产出音频")
        audio = np.concatenate(part_audio)
        if applied and any(abs(s - speed) > 0.05 for s in applied):
            sys.stderr.write(
                f"[voice] 语速伺服 {len(raw_parts)}段 倍率 "
                f"{','.join(f'{s:.2f}' for s in applied)} "
                f"目标 {TTS_CHARS_PER_SECOND * speed:.2f}字/秒\n"
            )

        return encode_wav_bytes(audio, rate), engine, voice_used


def time_stretch_wsola(samples: "Any", speed: float) -> "Any":
    """
    保持音高的变速（WSOLA：波形相似重叠相加）

    为什么不能用 `np.interp` 重采样：那等价于磁带快进，速度 ×1.25 时基频
    也 ×1.25。真机实测 vivian 的 F0 中位数 237.6Hz → 279.1Hz，听起来就是
    「声音变尖、不像同一个人」——用户报的「声音不对」有一半来自这里。
    Qwen3-TTS 的 generate_* 没有原生 speed 参数，只能在波形层做时间伸缩。

    WSOLA 的做法：把音频切成重叠帧，按目标速度重新摆放；摆放时在理想位置
    附近搜索与上一帧重叠区最相似的一段，让拼接处波形连续。帧与帧用汉宁窗
    叠加并归一化，避免音量起伏。对语音比 phase vocoder 更少金属感。

    @param samples float32 一维波形
    @param speed >1 加速、<1 减速、=1 原样返回
    @returns 变速后的波形（音高不变）
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if speed <= 0 or abs(speed - 1.0) < 1e-3 or x.size < 4096:
        return x

    frame_len = 1024
    hop_analysis = frame_len // 2
    # 合成跳距决定速度；钳一下，避免极端速度下重叠区退化成 0
    hop_synth = max(frame_len // 4, min(3 * frame_len // 4, int(round(hop_analysis / speed))))
    overlap = frame_len - hop_synth
    search = frame_len // 4
    window = np.hanning(frame_len).astype(np.float32)

    out_len = int(round(x.size * hop_synth / hop_analysis)) + frame_len
    out = np.zeros(out_len, dtype=np.float32)
    weight = np.zeros(out_len, dtype=np.float32)

    ideal_xpos = 0
    ypos = 0
    target: "Any" = None
    while ideal_xpos + frame_len <= x.size and ypos + frame_len <= out_len:
        # 搜索必须围绕"理想分析位置"，且 best 只用来取这一帧、不能回写：
        # 否则每帧 ±search 的偏移会累积，输入被吃掉的速度偏离目标，
        # 实测 speed=1.25 会把 1s 压成 0.57s（而非 0.8s）。
        best = ideal_xpos
        if target is not None and overlap > 0:
            lo = max(0, ideal_xpos - search)
            hi = min(x.size - frame_len, ideal_xpos + search)
            best_score = -2.0
            for candidate in range(lo, hi + 1, 16):
                seg = x[candidate : candidate + overlap]
                if seg.size != target.size:
                    continue
                denom = float(np.sqrt(float(np.dot(seg, seg)) * float(np.dot(target, target))) + 1e-8)
                score = float(np.dot(seg, target) / denom)
                if score > best_score:
                    best_score, best = score, candidate
        frame = x[best : best + frame_len]
        out[ypos : ypos + frame_len] += frame * window
        weight[ypos : ypos + frame_len] += window
        if overlap > 0:
            target = frame[hop_synth:]
        ideal_xpos += hop_analysis
        ypos += hop_synth

    valid = weight > 1e-3
    out[valid] /= weight[valid]
    if not bool(valid.any()):
        return x
    return out[: int(np.flatnonzero(valid)[-1]) + 1]


class StreamingWsola:
    """
    跨 chunk **有状态**的 WSOLA 变速（流式专用）

    为什么需要它：流式 `/tts/stream` 以前对每个 0.8s chunk 各跑一次
    `time_stretch_wsola()`。WSOLA 是重叠相加算法，窗函数、搜索用的「上一帧
    重叠区」、理想分析位置都是**跨帧状态**；每块重新起一次，边界处就没有
    前一帧可对齐。真机实测 speed=1.2 时块边界样本跳变中位 2.8% / 最大
    19.4%（speed=1.0 只有 0.1% / 1.2%），听感就是「前后两句语速不一样」、
    「讲了几句中间像断了一下」。

    这里把同一套帧参数与搜索逻辑搬成实例状态：`x`（输入缓冲）、
    `ideal_xpos` / `ypos`、`target`（上一帧重叠区）、`out` / `weight`
    （OLA 累加）全部跨 `feed()` 延续。于是**把一段音频分 N 次喂进来，
    输出与整段一次 `time_stretch_wsola()` 逐样本相同**（单测锁住），流式块
    只是同一条时间轴的连续切片，边界不再各自重启窗函数。

    关键约束：`feed()` 只在 `ideal_xpos + frame_len + search <= x.size` 时
    处理帧，即**等搜索右窗完整可用**；`flush()` 才放宽到只剩一帧。这样分块
    喂与整段一次喂，每一帧的搜索范围 `[lo, hi]` 完全一致，结果才严格相等
    （否则先到的块搜索窗被 clamp，会悄悄改变输出）。额外等待只有
    `search=256` 样本 ≈ 10.7ms @24kHz，不影响首字延迟。
    """

    FRAME_LEN = 1024
    HOP_ANALYSIS = FRAME_LEN // 2
    SEARCH = FRAME_LEN // 4
    # 与整块 time_stretch_wsola 同一个门槛：太短的音频不做变速，否则帧数
    # 不足会把波形拉出一串窗函数伪影。总输入低于它时原样透传。
    MIN_SAMPLES = 4096

    def __init__(self, speed: float) -> None:
        import numpy as np

        self.speed = float(speed)
        # speed=1.0（或非法值）直接透传：不引入任何缓冲延迟，行为与整块一致
        self.passthrough = self.speed <= 0 or abs(self.speed - 1.0) < 1e-3
        self.x = np.zeros(0, dtype=np.float32)
        self.target: "Any" = None
        self.finished = False
        if self.passthrough:
            return
        self.hop_synth = max(
            self.FRAME_LEN // 4,
            min(3 * self.FRAME_LEN // 4, int(round(self.HOP_ANALYSIS / self.speed))),
        )
        self.overlap = self.FRAME_LEN - self.hop_synth
        self.window = np.hanning(self.FRAME_LEN).astype(np.float32)
        self.out = np.zeros(self.FRAME_LEN * 4, dtype=np.float32)
        self.weight = np.zeros(self.FRAME_LEN * 4, dtype=np.float32)
        self.ideal_xpos = 0
        self.ypos = 0
        self.emitted = 0

    def feed(self, samples: "Any") -> "Any":
        """
        喂入一段原始样本，吐出**已经确定**的变速后样本

        只有 `< ypos` 的输出样本不会再被后续帧覆盖，才能安全发给浏览器；
        不足一帧时返回空数组，调用方跳过即可。

        @param samples float32 一维原始（未变速）波形
        @returns 已确定的 float32 变速样本，可能长度为 0
        """
        import numpy as np

        x_new = np.asarray(samples, dtype=np.float32).reshape(-1)
        if x_new.size == 0:
            return x_new
        if self.passthrough:
            return x_new
        # 一个请求最多几十万样本，每次 feed 复制一次累积缓冲的成本（<0.1s）
        # 相对 MLX 推理可忽略；换来搜索能随机访问跨块历史，不必维护环形缓冲。
        self.x = np.concatenate((self.x, x_new))
        if self.x.size < self.MIN_SAMPLES:
            return np.zeros(0, dtype=np.float32)
        self._process(require_full_search=True)
        return self._drain()

    def flush(self) -> "Any":
        """
        输入结束后收尾：处理剩余不足一个搜索窗的帧，吐出累加缓冲的尾段

        必须调用，否则最后 `frame_len + search` 个样本会永远留在缓冲里，
        听感是每句话末尾被吃掉一小截。

        @returns 剩余 float32 变速样本，可能长度为 0
        """
        import numpy as np

        if self.passthrough or self.finished:
            return np.zeros(0, dtype=np.float32)
        self.finished = True
        if self.x.size < self.MIN_SAMPLES:
            # 整块实现这个长度也是原样返回，流式不能突然变速，否则句尾
            # 会出现一小段和前文语速不一致的音频
            tail = self.x
            self.x = np.zeros(0, dtype=np.float32)
            return tail
        self._process(require_full_search=False)
        return self._tail()

    def _grow(self, needed: int) -> None:
        """按需给 OLA 累加缓冲扩容（流式不知道总时长）"""
        import numpy as np

        if needed <= self.out.size:
            return
        extra = max(needed - self.out.size, self.FRAME_LEN * 8)
        self.out = np.concatenate((self.out, np.zeros(extra, dtype=np.float32)))
        self.weight = np.concatenate((self.weight, np.zeros(extra, dtype=np.float32)))

    def _process(self, require_full_search: bool) -> None:
        import numpy as np

        need = self.FRAME_LEN + (self.SEARCH if require_full_search else 0)
        while self.ideal_xpos + need <= self.x.size:
            best = self.ideal_xpos
            if self.target is not None and self.overlap > 0:
                lo = max(0, self.ideal_xpos - self.SEARCH)
                hi = min(self.x.size - self.FRAME_LEN, self.ideal_xpos + self.SEARCH)
                best_score = -2.0
                for candidate in range(lo, hi + 1, 16):
                    seg = self.x[candidate : candidate + self.overlap]
                    if seg.size != self.target.size:
                        continue
                    denom = float(
                        np.sqrt(float(np.dot(seg, seg)) * float(np.dot(self.target, self.target))) + 1e-8
                    )
                    score = float(np.dot(seg, self.target) / denom)
                    if score > best_score:
                        best_score, best = score, candidate
            frame = self.x[best : best + self.FRAME_LEN]
            end = self.ypos + self.FRAME_LEN
            self._grow(end)
            self.out[self.ypos : end] += frame * self.window
            self.weight[self.ypos : end] += self.window
            if self.overlap > 0:
                self.target = frame[self.hop_synth :]
            # best 只用于取这一帧，绝不回写理想分析位置（见整块实现同处注释）
            self.ideal_xpos += self.HOP_ANALYSIS
            self.ypos += self.hop_synth

    def _drain(self) -> "Any":
        import numpy as np

        if self.ypos <= self.emitted:
            return np.zeros(0, dtype=np.float32)
        seg = self.out[self.emitted : self.ypos].copy()
        w = self.weight[self.emitted : self.ypos]
        valid = w > 1e-3
        seg[valid] /= w[valid]
        # 与整块实现严格一致：`out[valid] /= weight[valid]` 只动有效位置，
        # 窗端点权重≈0 的位置保留累加原值（不是清零）。少这一步会让流式
        # 与整块在每个过渡位置差出 2.5e-4，虽然听不见，但等价性断言就不成立了。
        self.emitted = self.ypos
        return seg

    def _tail(self) -> "Any":
        import numpy as np

        seg = self.out[self.emitted :].copy()
        w = self.weight[self.emitted :]
        valid = w > 1e-3
        if not bool(valid.any()):
            return np.zeros(0, dtype=np.float32)
        # 对齐整块实现的 `out[: last_valid + 1]`：丢掉预分配但没写过的部分
        last = int(np.flatnonzero(valid)[-1]) + 1
        seg = seg[:last]
        v = valid[:last]
        seg[v] /= w[:last][v]
        return seg


# 判定「有声」的相对峰值阈值（约 -34dB）。与前端 playout.ts 的
# SILENCE_PEAK_RATIO 对齐：同一段音频在服务端与浏览器里的判定要一致。
DEGENERATE_SILENCE_PEAK_RATIO = 0.02

# 流式里连续全静音块的上限。每块约 0.8s，2 块 ≈1.6s，明显大于实测的
# 正常最长停顿 0.68s，又远小于退化段（最短 4.67s）。
STREAM_SILENT_CHUNK_LIMIT = 2


def is_silent_chunk(samples: "Any") -> bool:
    """
    这一块是不是纯静音（退化 chunk）

    @param samples float32 一维波形
    @returns 峰值低于相对阈值时视为静音
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return True
    # 绝对阈值而不是相对峰值：退化 chunk 几乎是数字静音，而正常语音即使
    # 整体音量偏小，峰值也远高于 0.005（约 -46dB）。用相对阈值会把一整块
    # 正常但安静的语音误判成静音。
    return float(np.max(np.abs(x))) < 0.005


def trim_degenerate_tail(samples: "Any", sample_rate: int, max_silence_s: float = 1.0, keep_tail_s: float = 0.25) -> "Any":
    """
    裁掉模型退化生成出来的超长尾部静音

    2026-11-06 真机反馈「第二段讲了几句中间就中断了 + 前后两句语速不一样」。
    实测根因不是播放链路断了，而是**长文本请求让模型一路生成到 max_tokens
    上限**，多出来的 token 全解成静音：

    | 字数 | 折合语速 | 最长连续静音 | 静音起点 |
    |---|---|---|---|
    | 41 | 4.92 字/秒 | 0.66s | 1.39s |
    | 55 | 3.28 字/秒 | 4.67s | 12.08s |
    | 96 | 3.28 字/秒 | 21.49s | 7.81s |
    | 164 | 3.28 字/秒 | 21.51s | 28.53s |

    退化后语速恒定 3.28 = 4.92 / 1.5（正好是 max_tokens 的安全余量），
    且静音起点 + 长度 ≈ 总时长 —— **静音全部堆在尾部**。所以只需裁尾，
    不必动中间的正常语义停顿（实测最长 0.68s）。

    阈值取 1.0s：比正常句间停顿宽得多，又远小于任何实测退化段。裁完保留
    0.25s 尾音，避免把句尾切得太硬。

    @param samples float32 一维波形
    @param sample_rate 采样率
    @param max_silence_s 尾部静音超过这个长度才判定为退化
    @param keep_tail_s 裁掉后保留的自然尾音
    @returns 裁剪后的波形（未退化时原样返回）
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x)))
    if peak == 0:
        return x  # 全静音交给上层报错，不要在这里凭空造声音
    loud = np.flatnonzero(np.abs(x) >= peak * DEGENERATE_SILENCE_PEAK_RATIO)
    if loud.size == 0:
        return x
    last = int(loud[-1])
    trailing = (x.size - 1 - last) / float(sample_rate)
    if trailing <= max_silence_s:
        return x
    keep = int(keep_tail_s * sample_rate)
    return x[: min(x.size, last + 1 + keep)]


def trim_speech_edges(
    samples: "Any", sample_rate: int, keep_head_s: float = 0.02, keep_tail_s: float = 0.08
) -> "Any":
    """
    裁掉 TTS 自带的句首 / 句尾机械静音

    Qwen3-TTS 每次生成都会在句首补约 88ms、句尾补约 46ms 的机械 padding。
    它不属于语义停顿，却会被算进「字数 / 时长」，让短句看起来比长句快；
    分段拼接时还会在接缝多出一段空白。保留一点边距是为了不切掉句首轻声
    辅音和句尾收尾。**句内**的语义停顿不动（实测最长 0.68s），那是听感的一部分。

    @param samples float32 一维波形
    @param sample_rate 采样率
    @param keep_head_s 首个有声样本前保留的边距
    @param keep_tail_s 末个有声样本后保留的边距
    @returns 裁剪后的波形；纯静音返回空数组
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x)))
    if peak == 0:
        return np.zeros(0, dtype=np.float32)
    loud = np.flatnonzero(np.abs(x) >= peak * DEGENERATE_SILENCE_PEAK_RATIO)
    if loud.size == 0:
        return np.zeros(0, dtype=np.float32)
    head = max(0, int(loud[0]) - int(keep_head_s * sample_rate))
    tail = min(x.size, int(loud[-1]) + 1 + int(keep_tail_s * sample_rate))
    return x[head:tail]


# 段内异常长静音压缩（2026-11-07 长文本专项实测）
#
# 长文本里偶发 1.2~1.4 秒的段内空白（不是句读停顿，正常句读实测最长
# 0.68s），听感就是「讲着讲着卡了一下」。它们通常伴随模型局部退化，
# 裁尾解决不了（不在尾部）。只压超过 0.9s 的区间，保留 0.45s 作自然
# 换气；阈值与 continuity.py 的 LONG_GAP_MS 对齐。
TTS_COMPRESS_GAP_S = 0.9
TTS_COMPRESS_KEEP_S = 0.45


def compress_internal_gaps(
    samples: "Any",
    sample_rate: int,
    max_gap_s: float = TTS_COMPRESS_GAP_S,
    keep_s: float = TTS_COMPRESS_KEEP_S,
) -> "Any":
    """
    把段内异常长的静音压短，保留自然句读停顿

    @param samples 已裁首尾机械静音的波形
    @param sample_rate 采样率
    @param max_gap_s 超过这个长度的静音才处理
    @param keep_s 长静音保留的长度
    @returns 压缩后的波形；没有超长静音时原样返回
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0 or sample_rate <= 0:
        return x
    frame = max(1, int(0.02 * sample_rate))
    frames_n = x.size // frame
    if frames_n < 3:
        return x
    peak = float(np.max(np.abs(x)))
    if peak <= 0:
        return x
    rms = np.sqrt((x[: frames_n * frame].reshape(frames_n, frame).astype(np.float64) ** 2).mean(axis=1))
    quiet = rms < peak * DEGENERATE_SILENCE_PEAK_RATIO
    gap_frames = max(1, int(max_gap_s * sample_rate / frame))
    keep_frames = max(1, int(keep_s * sample_rate / frame))

    pieces: list[Any] = []
    cursor = 0
    i = 0
    while i < frames_n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < frames_n and quiet[j]:
            j += 1
        if j - i > gap_frames:
            keep_end = min(j, i + keep_frames) * frame
            skip_end = j * frame
            pieces.append(x[cursor:keep_end])
            cursor = skip_end
        i = j
    if cursor == 0:
        return x
    pieces.append(x[cursor:])
    return np.concatenate(pieces)


def compress_segment_gaps(
    samples: "Any",
    sample_rate: int,
    units: float,
    short_gap: bool | None = None,
) -> "Any":
    """段级静音处理：异常长静音（既有）+ 短块句内静音上限（P1，默认关）。

    顺序很重要：短块压缩必须在 `segment_servo_speed()` / WSOLA **之前**。
    伺服按「整段时长」算倍率，先压缩才能把倍率从 1.65 钳位拉回可达区间，
    这是 `num:xs` 3.908 u/s 的真正修法；若放在变速之后，流式分段就没法
    边生成边吐（要攒齐整段才能裁），TTFA 会退化。

    @param samples 已裁首尾机械静音与退化尾音的波形
    @param sample_rate 采样率
    @param units 本段等效发音单元数（>20 视为长块，不启用短块上限）
    @param short_gap 请求级开关；None = 跟随环境变量（默认关）
    @returns 波形；关闭态与既有 `compress_internal_gaps()` 逐样本一致
    """
    base = compress_internal_gaps(samples, sample_rate)
    use_short_gap = SHORT_GAP_ENABLED if short_gap is None else short_gap
    if not use_short_gap or units > SHORT_GAP_UNITS:
        return base
    return compress_internal_gaps(
        base,
        sample_rate,
        max_gap_s=SHORT_GAP_MAX_S,
        keep_s=SHORT_GAP_MAX_S,
    )


def segment_stretch_speed(samples: "Any", sample_rate: int, units: float, speed: float) -> float:
    """
    算这一段需要的保调变速倍率，把它的实测语速拉到全局固定基准

    `target = TTS_CHARS_PER_SECOND × speed`，`actual = units / duration`，
    倍率 = target / actual（>1 加速、<1 放慢）。钳制在 0.75~1.65：这个范围
    覆盖真机实测的全部正常段（最慢的是纯拉丁复合词块，实测需要 1.61 倍）；
    再往外多半是模型退化，交给 `trim_degenerate_tail()` /
    `compress_internal_gaps()` 与退化日志处理更合适，硬拉只会把音质拉坏。

    `units` 必须是 `speech_units(piece)` 的**等效发音单元数**，不是字符数：
    标点不发音，中英混排/数字按字符计会把发音量少算一半，伺服会误判成
    「读得飞快」并施加极端变速，制造语速与音色双重跳变（2026-11-07 实测
    中英混排块间语速极差 76.37%）。

    注意目标取**全局固定值**，不能用本轮各段的中位数——否则整段一起快或
    一起慢时伺服检测不出来，这正是业界反复强调的坑。

    @param samples 已裁掉首尾机械静音与退化尾音的波形
    @param sample_rate 采样率
    @param units 这一段的等效发音单元数
    @param speed 用户设置的语速
    @returns 传给 `time_stretch_wsola()` / `StreamingWsola()` 的倍率
    """
    if not TTS_RATE_SERVO:
        return 1.0
    duration = samples.size / float(sample_rate) if sample_rate > 0 else 0.0
    if duration <= 0 or units <= 0:
        return speed if speed > 0 else 1.0
    target = TTS_CHARS_PER_SECOND * (speed if speed > 0 else 1.0)
    actual = units / duration
    return max(TTS_RATE_SPEED_MIN, min(TTS_RATE_SPEED_MAX, target / actual))


def segment_servo_speed(samples: "Any", sample_rate: int, piece: str, speed: float) -> float:
    """
    一段文本的最终伺服倍率（等效单元口径 + 极短段护栏）

    `segment_stretch_speed()` 保持纯数学，便于单测；文本折算与护栏放在这里，
    两处调用（整块 `/tts`、流式 `/tts/stream`）走同一份逻辑，不会各自漂移。

    @param samples 已裁首尾静音的波形
    @param sample_rate 采样率
    @param piece 这一段原文（用来算等效发音单元）
    @param speed 用户设置的语速
    @returns 保调变速倍率
    """
    units = speech_units(piece)
    ratio = segment_stretch_speed(samples, sample_rate, units, speed)
    if units < TTS_SHORT_SEGMENT_UNITS:
        return max(TTS_SHORT_SPEED_MIN, min(TTS_SHORT_SPEED_MAX, ratio))
    return ratio


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
        # 补一项：哪些引擎已经常驻（配置报的是"该用哪个"，这里报"已经在跑的"）
        if isinstance(deps.get("tts"), dict):
            deps["tts"]["loaded"] = self.tts.loaded()
        self._send_json(
            200,
            {
                "ok": True,
                "model": {"asr": deps["asr"], "tts": deps["tts"]},
                "versions": {
                    "python": sys.version.split()[0],
                    "pid": str(os.getpid()),
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "tns": TNS_VERSION if TNS_ENABLED else "off",
                    "atomicChunk": "on" if ATOMIC_CHUNK_ENABLED else "off",
                    "shortGap": "on" if SHORT_GAP_ENABLED else "off",
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
            if self.path == "/tts/normalize":
                # 只回规范化结果、不加载模型：探针用它核对「服务端跑的到底
                # 是哪一版规则」，避免本地规则与线上实现悄悄分叉。
                payload = json.loads(self._read_body() or b"{}")
                raw = str(payload.get("text") or "").strip()
                enabled = request_tns_enabled(payload, TNS_ENABLED)
                norm = normalize_for_speech(raw, enabled)
                self._send_json(
                    200,
                    {
                        "text": norm.text,
                        "original": norm.original,
                        "changed": norm.changed,
                        "hits": norm.hits,
                        "version": TNS_VERSION,
                        "enabled": enabled,
                    },
                )
                return
            if self.path == "/tts":
                self._handle_tts()
                return
            if self.path == "/tts/stream":
                # 流式端点自己管连接与异常：头已经发出去之后再走外层
                # `_send_json(500)` 会把 JSON 混进二进制流里，客户端解析必炸
                self._handle_tts_stream()
                return
            if self.path == "/asr":
                self._handle_asr()
                return
            self._send_json(404, {"error": f"未知路径 {self.path}"})
        except BrokenPipeError:
            # 兜底分支再写一次响应也会断：客户端已经走了，静默收尾
            sys.stderr.write("[voice] 客户端已断开（BrokenPipe），本次请求丢弃\n")
        except Exception as exc:  # 兜底：任何异常都要有结构化返回，不能静默断连
            traceback.print_exc()
            try:
                self._send_json(500, {"code": "INTERNAL", "reason": str(exc)})
            except BrokenPipeError:
                sys.stderr.write("[voice] 返回错误时客户端已断开\n")

    def _handle_tts(self) -> None:
        payload = json.loads(self._read_body() or b"{}")
        text = apply_tns(str(payload.get("text") or "").strip(), payload)
        short_gap = request_short_gap_enabled(payload)
        if not text:
            self._send_json(400, {"code": "EMPTY_TEXT", "reason": "text 不能为空"})
            return
        # 请求体没带 engine 时按**配置**回落，不能回落到硬编码的 VoiceDesign：
        # 那会让"配置已切到 CustomVoice"从直连路径上失效，音色又开始每句重设计。
        engine = str(payload.get("engine") or configured_engine())
        voice = str(payload.get("voice") or "")
        # 手改配置 / 旧客户端可能传字符串，坏值回落 1.0 而不是抛 500
        try:
            speed = float(payload.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(2.0, max(0.5, speed))
        started = time.time()
        audio, engine_used, voice_used = self.tts.synthesize(
            text, engine, voice, speed, short_gap=short_gap
        )
        elapsed = int((time.time() - started) * 1000)
        # 一行固定格式的合成日志：正常与退化在日志里差别一目了然
        # （正常几百毫秒，退化几十秒），排查超时不必再靠猜。
        # 长文本会被自动分段，所以这里报的是**实际每段**的 token 上限，
        # 不是整段文本的估值（整段已经不会一次性进模型了）。
        pieces = split_long_text(text)
        per_piece_cap = max((max_tokens_for(p) for p in pieces), default=0)
        sys.stderr.write(
            f"[voice] tts {len(text)}字 engine={engine_used} 段={len(pieces)} "
            f"max_tokens={per_piece_cap} audio={len(audio) // 1024}KB {elapsed}ms\n"
        )
        try:
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Synth-Ms", str(elapsed))
            # 回显实际生效的引擎与音色：排查"音色不对"时不必再猜配置。
            # 音色可能是中文描述，URL 编码后才是合法的 ASCII 头值
            self.send_header("X-Tts-Engine", engine_used)
            self.send_header("X-Tts-Voice", urllib.parse.quote(voice_used))
            self.end_headers()
            self.wfile.write(audio)
        except BrokenPipeError:
            # 客户端先断了（典型是 Node 网关 60s 超时）：这不是 sidecar 故障，
            # 打一行就够，堆栈只会淹没真正的错误
            sys.stderr.write(f"[voice] tts 客户端已断开，丢弃 {len(audio) // 1024}KB 音频\n")

    def _handle_tts_stream(self) -> None:
        """
        POST /tts/stream → 分块音频流（异步流式生成）

        线上格式：`[4B 大端长度][独立 WAV 字节]` 重复 N 次，直到连接关闭。
        用 `Connection: close` 而不是 HTTP chunked：Handler 是 HTTP/1.0，
        改 protocol_version 会影响所有既有端点；close-delimited 对 Node fetch
        的 `response.body` 一样是边到边读。

        首块延迟实测（41 字、热态）：整块模式 1.821s → 流式 interval=1.0
        **0.192s**，总生成耗时几乎不变（1.83s → 1.87s）。
        """
        payload = json.loads(self._read_body() or b"{}")
        text = apply_tns(str(payload.get("text") or "").strip(), payload)
        short_gap = request_short_gap_enabled(payload)
        if not text:
            self._send_json(400, {"code": "EMPTY_TEXT", "reason": "text 不能为空"})
            return
        engine = str(payload.get("engine") or configured_engine())
        voice = str(payload.get("voice") or "")
        try:
            speed = float(payload.get("speed") or 1.0)
            interval = float(payload.get("interval") or TTS_STREAM_INTERVAL)
        except (TypeError, ValueError):
            speed, interval = 1.0, TTS_STREAM_INTERVAL
        speed = min(2.0, max(0.5, speed))
        interval = min(4.0, max(0.3, interval))

        speaker = resolve_speaker(voice)[0]
        started = time.time()
        first_at: float | None = None
        count = 0
        total_bytes = 0
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Tts-Engine", engine)
            self.send_header("X-Tts-Voice", urllib.parse.quote(speaker))
            self.send_header("X-Stream-Interval", str(interval))
            self.end_headers()
            for wav in self.tts.iter_stream(
                text, engine, voice, speed, interval, short_gap=short_gap
            ):
                if first_at is None:
                    first_at = time.time() - started
                blob = struct.pack(">I", len(wav)) + wav
                self.wfile.write(blob)
                self.wfile.flush()  # 不 flush 就被缓冲，等于没流式
                count += 1
                total_bytes += len(wav)
            sys.stderr.write(
                f"[voice] tts-stream {len(text)}字 engine={engine} voice={speaker} "
                f"chunks={count} 首块={int((first_at or 0)*1000)}ms "
                f"audio={total_bytes//1024}KB {int((time.time()-started)*1000)}ms\n"
            )
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write(f"[voice] tts-stream 客户端已断开，已发 {count} 块\n")
        except Exception as exc:
            # 头已经发出，不能再写 JSON 错误体：只记日志，由连接结束告诉客户端
            traceback.print_exc()
            sys.stderr.write(f"[voice] tts-stream 生成失败：{exc}\n")

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
        # 后台预热：把这 13 秒的冷加载从"用户第一句"挪到"服务刚起来"。
        # daemon 线程，失败只记日志——真正请求时会重试并报出真实原因。
        warm_engine = configured_engine()

        def _warm() -> None:
            started = time.time()
            try:
                Handler.tts.warm(warm_engine)
                sys.stderr.write(
                    f"[voice] 预热完成 engine={warm_engine} {int((time.time() - started) * 1000)}ms\n"
                )
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"[voice] 预热失败（不影响服务）：{exc}\n")

        threading.Thread(target=_warm, name="tts-warm", daemon=True).start()
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[voice] 退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
