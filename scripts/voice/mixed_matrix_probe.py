#!/usr/bin/env python3
"""混合内容 × 长度矩阵验收：流畅性 / 速度 / 语速 / 音色一致性。

为什么单独做一层（2026-11-07 第五轮）：
`longtext_probe.py` 只有 4 条 300~400 字的长文本，门禁还强制 `min_blocks>=3`。
真实陪伴模式里既有「嗯，我在。」这种十几字的短句，也有中英混排、数字密集、
代码符号、无标点长串，还可能一口气念 600 字。长度与内容类型同时变化时，
固定 speaker + 固定 seed 是否仍能给出**同一个人的同一种节奏**，需要一层
控制变量的矩阵实测才能下结论。

控制变量的设计：
每种内容类型给一组固定句子池，长度档位取同一批句子的前缀/两轮重复，
所以「同类型、不同长度」之间只差长度，不差题材；「同长度、不同类型」
之间只差字符构成。这样才能把 F0 / 语速的波动归因到长度或内容，而不是
把不同题材的自然差异误判成音色漂移。

量化四类指标：
1. 流畅性：块内静音、异常长静音、拼接边界局部 P95 跳变、逐字可逆、
   串行时序模型下的欠流（underrun）估计；
2. 速度：真流式首片 TTFA、每片到达时间、逐块生成总耗时、播放总时长、
   RTF、与「整段一次请求」的 TTFA / 总耗时对照；
3. 语速：等效发音单元/秒的块间极差、与全局固定基准 4.1×speed 的偏差、
   跨语料 / 跨长度 / 跨内容类型的极差；
4. 音色：F0 / 频谱质心块间极差、2 秒时间窗 F0 起伏、跨语料 F0 极差、
   同文本重复三次的逐位一致性与 F0 稳定性。

单块语料没有「块间极差」可算，`spread()` 返回的 0 **不是通过**：报告里
标 `applicable=false`，门禁改用「与全局语速基准 / 跨语料 F0 中位数的偏差」
作为替代判据，并在 Markdown 表格里显式写 `N/A`。

用法：
    python3 scripts/voice/mixed_matrix_probe.py --check --out /tmp/dcx-matrix
    python3 scripts/voice/mixed_matrix_probe.py --lengths xs,s --kinds cn,mixed
    python3 scripts/voice/mixed_matrix_probe.py --cells cn:xs,mixed:xl --skip-existing
    python3 scripts/voice/mixed_matrix_probe.py --repeat 0   # 跳过重复性采集

只做测量与落盘，不改任何仓库文件；每格单独落 `cells/<name>.json`，中断后
`--skip-existing` 可续跑。`--check` 按 mixed-matrix-thresholds.json 判定。
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

REPO = Path("/Users/wangwei/Documents/VG/DeepCodeX-cli")
sys.path.insert(0, str(REPO / "scripts/voice"))
import longtext_probe as lp  # noqa: E402
from continuity import analyze_clip, decode_wav, drift_pct  # noqa: E402
from mlx_voice_server import TTS_CHARS_PER_SECOND, speech_units  # noqa: E402
from text_normalize import normalize_for_speech  # noqa: E402

PORT = int(os.environ.get("PROBE_PORT", "8791"))
ENGINE = "qwen3-customvoice"
VOICE = "sinan"
SPEED = 1.2
OUT = Path("/tmp/dcx-voice-matrix")
# TNS 默认打开（2026-11-07 产品决策）。`--tns off` 逐字复现旧基线：
# 请求体关掉规范化，语速分母也退回原文，两次结果才可比。
TNS = True
# 短块句内静音上限（P1，默认关）。请求级 {"shortGap": true} 只开本次，
# 同一 sidecar 就能做 off/on A/B，不必重启、不必重新预热模型。
SHORT_GAP = False


def spoken(text: str) -> str:
    """真正送进模型的文本：与服务端 apply_tns() 同口径。"""
    return normalize_for_speech(text, TNS).text


def units_of(text: str) -> float:
    """分母必须是念出来的那份文本，不是界面上的原文。"""
    return speech_units(spoken(text))


def tts_payload(text: str) -> dict[str, Any]:
    payload = {"text": text, "engine": ENGINE, "voice": VOICE, "speed": SPEED, "tns": TNS}
    if SHORT_GAP:
        payload["shortGap"] = True
    return payload

# ---------------------------------------------------------------------------
# 语料矩阵：5 种内容类型 × 5 个长度档位
# ---------------------------------------------------------------------------
# 句子池刻意覆盖 TTS 最容易「换人 / 变速」的字符构成：
# - cn    纯中文 + 标点，作对照组
# - mixed 中英混排：技术名词、点号文件名、连字符复合词、大写缩写
# - num   数字密集：百分比、金额、小数、日期、版本号、区间、大数
# - code  符号/代码：URL、@、#、括号、等号、斜杠、全大写缩写
# - plain 无标点长串：模型只能自己找换气点，最考验语速伺服
SENTENCE_POOLS: dict[str, list[str]] = {
    "cn": [
        "我先把刚才那三处改动从头到尾捋了一遍，慢慢说给你听，不急着下结论。",
        "第一处是播放队列的状态机，原来只靠一个布尔量记着有没有在播，流式回调迟到一位就会永远卡住。",
        "第二处是解码超时，设备切换时浏览器可能既不成功也不失败，得给一个硬上限才不会拖住整条链路。",
        "第三处是取消传播，打断一句话时排队中的合成、飞行中的识别和模型生成都得一起撤掉。",
        "这三处合起来，其实就是把能出声变成一直稳定地出声，听着不顺随时打断我，我再单独拆开看。",
        "另外补一句，情绪陪伴和复杂任务走的是两条不同的思考路径，但说话的语气始终要像同一个人。",
    ],
    "mixed": [
        "这次我把 session.ts 里的 resolveThinkingDepth 链路重新对了一遍，结论其实挺简单的。",
        "它每轮读 intent、complexity、context 和 latency 四个信号，输出 off、light、balanced、full 四档。",
        "openai-provider 和 anthropic-provider 都优先读请求级的 reasoningEffort，回落才用 settings。",
        "实测 short turn 的 TTFT 从 321ms 降到 190ms，complex turn 仍保持 1.8s，因为 full 档没动。",
        "另外 X-Tts-Voice 回显的 speaker 是 serena 而不是 vivian，排查音色问题时特别容易搞混。",
        "如果你手上有 0.6B 的权重也可以跑一次 A/B，不过那条路径不支持 instruct，别拿它当基线。",
    ],
    "num": [
        "看一下这次的实测数据：短句 14 字对应 4.09 字每秒，20 字是 4.92，标准 41 字是 4.17。",
        "温度 0.9 时基频标准差 9.8 赫兹，0.35 压到 4.5，再降到 0.2 反而反弹到 9.3。",
        "流式首块 192 毫秒，整块 1821 毫秒，ASR 热态 58 到 86 毫秒，TTFA 约 1770 到 1919 毫秒。",
        "预算是 12,480.75 元，同比上涨 18.6%，其中第 3 项占 47.2%，第 7 项只占 2.05%。",
        "版本号从 v2.14.3 升到 v3.0.1，发布日期 2026-11-07，工单号 #10247，联系电话 400-800-1234。",
        "所以 2026 年这一版的目标很明确：把 0.79% 和 1.66% 的抖动压到 5% 以内，误差不超过 0.03。",
    ],
    "code": [
        "入口是 GET /api/voice/health，返回 {ok: true, model: {asr, tts}}，超时设成 3000ms 就够。",
        "POST https://127.0.0.1:8791/tts/stream 的 body 是 {text, engine, voice, speed}，别漏 Bearer token。",
        "环境变量 DCX_VOICE_RATE_SERVO=0 可一键回退，X-Tts-Voice 里的 speaker=serena (ASR/TTS 共用)。",
        "配置写在 ~/.deepcode/soul/config.json，字段 voice.token；# 开头的行为注释，不参与解析。",
        "日志里 [voice] tts-stream chunks=6 首块=192ms 表示流式生效，若 chunks=1 说明退回整块。",
        "最后跑 npm run check && npx tsc --noEmit，两条都绿才算过关；别用 git push --force。",
    ],
    "plain": [
        "没有标点的长文本最能暴露语速漂移因为模型看不到任何句读提示只能自己决定在哪里换气",
        "一旦文本超过四十八字生成轨迹就会开始发散有时会在中间突然加速有时又拖出一大段空白",
        "前端把它切成十四字和四十八字的小块之后每一块都是一次独立的自回归生成",
        "块与块之间没有共享的韵律状态所以听感上就是前后两句不像同一个人用同一种节奏在说话",
        "这也是为什么必须在服务端用全局固定基准做逐段语速归一而不是让每段自己决定快慢",
        "把发音单元当成统一分母之后中文和拉丁串终于可以放在同一条基准线上比较不再互相干扰",
    ],
    # A/B 对照：与 code 池**信息量相同**，但把 URL / JSON / 路径 / 版本号
    # 改写成自然口语。用来验证「符号密集块的语速漂移」是不是文本前端
    # 规范化（TNS）能解决的，而不是伺服参数能修的。默认矩阵不含这一类型，
    # 需要显式 --kinds ...,spoken 或 --cells spoken:m 才会采集。
    "spoken": [
        "入口是查询语音服务状态的接口，调用一下就能知道引擎有没有准备好。",
        "返回成功状态和模型字段，把超时设成三秒就够，不用等更久。",
        "向本地地址发送合成请求的时候，请求体里要带文本、引擎、音色和语速四个字段。",
        "别忘了带上访问令牌，否则会被拒之门外；开关写在配置文件的语音小节里。",
        "井号开头的行是注释，不参与解析；响应头里的音色字段是排查问题的关键。",
        "日志里看到六个流式分片说明流式生效，如果只有一个分片就是退回整块了。",
    ],
}

LENGTHS = ("xs", "s", "m", "l", "xl")
KINDS = ("cn", "mixed", "num", "code", "plain", "spoken")
DEFAULT_KINDS = KINDS[:5]
LENGTH_LABEL = {"xs": "极短", "s": "短", "m": "中", "l": "长", "xl": "超长"}
KIND_LABEL = {
    "cn": "纯中文",
    "mixed": "中英混排",
    "num": "数字密集",
    "code": "符号代码",
    "plain": "无标点",
    "spoken": "口语化改写",
}
# 极短档不用机械截断：句子池首句里常含 session.ts / /api/voice/health，
# 切前 16 字会把拉丁词拦腰切开（正是上一轮修掉的碎片问题）。各类型手写一句
# 自然短句，保留本类型最有代表性的字符构成，且都在 1 块以内。
XS_TEXTS: dict[str, str] = {
    "cn": "嗯，我在，慢慢说给你听。",
    "mixed": "我把 session.ts 重新对了一遍。",
    "num": "首块 192 毫秒，整块 1821 毫秒。",
    "code": "入口是 GET /api/voice/health。",
    "plain": "没有标点的短文本也能暴露语速漂移",
    "spoken": "入口是查询语音状态的接口。",
}
# 每档取几个句子；xl 是同一批句子整轮重复两遍，用来观察「同一段话念到
# 后半程时音色/语速会不会漂」，不是为了避免缓存（sidecar 没有结果缓存）。
SENTENCE_COUNT = {"xs": 1, "s": 1, "m": 2, "l": 5, "xl": 6}
REPEAT_ROUNDS = {"xs": 1, "s": 1, "m": 1, "l": 1, "xl": 2}


def matrix_text(kind: str, length: str) -> str:
    """按长度档位从同一类型句子池拼前缀，控制变量只留『长度』。"""
    if length == "xs":
        return XS_TEXTS[kind]
    pool = SENTENCE_POOLS[kind]
    count = SENTENCE_COUNT[length]
    rounds = REPEAT_ROUNDS[length]
    return "".join(pool[:count] * rounds)


def cell_name(kind: str, length: str) -> str:
    return f"{kind}:{length}"


# ---------------------------------------------------------------------------
# 真流式请求：边读边计时，而不是等整段响应读完
# ---------------------------------------------------------------------------
def stream_request(path: str, payload: dict, timeout: float = 300.0) -> dict[str, Any]:
    """POST 并逐片读取 `[4B 大端长度][WAV]`，记录每片到达时刻。

    服务端每片都 `wfile.flush()`，所以这里量到的是真 TTFA；用 `post()` 那种
    `resp.read()` 一次读完只能得到总耗时，测不出首片延迟。
    """
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    started = time.monotonic()
    chunks: list[bytes] = []
    at_ms: list[float] = []
    status = 0
    buf = b""
    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                **lp.headers(),
            },
        )
        resp = conn.getresponse()
        status = resp.status
        expected = -1
        while True:
            if expected < 0:
                if len(buf) < 4:
                    piece = resp.read(4 - len(buf))
                    if not piece:
                        break
                    buf += piece
                    continue
                expected = int.from_bytes(buf[:4], "big")
                buf = buf[4:]
                if expected <= 0:
                    break
            if len(buf) < expected:
                piece = resp.read(expected - len(buf))
                if not piece:
                    break
                buf += piece
                continue
            chunks.append(buf[:expected])
            at_ms.append((time.monotonic() - started) * 1000.0)
            buf = buf[expected:]
            expected = -1
    finally:
        conn.close()
    total_ms = (time.monotonic() - started) * 1000.0
    audio_s = 0.0
    first_chunk_s = 0.0
    for index, chunk in enumerate(chunks):
        x, rate = decode_wav(chunk)
        seconds = x.size / float(rate) if rate > 0 else 0.0
        audio_s += seconds
        if index == 0:
            first_chunk_s = seconds
    return {
        "http": status,
        "chunks": chunks,
        "chunk_count": len(chunks),
        "chunk_at_ms": [round(v, 1) for v in at_ms],
        "ttfa_ms": round(at_ms[0], 1) if at_ms else 0.0,
        "total_ms": round(total_ms, 1),
        "first_chunk_audio_s": round(first_chunk_s, 4),
        "audio_s": round(audio_s, 4),
    }


def wav_of(chunks: list[bytes]) -> tuple[np.ndarray, int]:
    return lp.join_wavs(chunks)


def local_boundary_jumps(x: np.ndarray, boundaries: list[int], rate: int) -> tuple[float, float]:
    """块边界一阶差分 / 该点 ±10ms 局部差分 P95，返回 (最坏, 中位)。

    沿用 continuity.compare_stream_batch 的判据：全信号 P95 会随整体能量
    在 0.06~2.27 乱跳；局部 P95 健康音频稳定在 0.63~1.23，且必须取最坏边界。
    """
    window = max(8, int(0.010 * rate))
    ratios: list[float] = []
    for pos in boundaries:
        if not 0 < pos < x.size:
            continue
        jump = abs(float(x[pos]) - float(x[pos - 1]))
        local = np.abs(np.diff(x[max(1, pos - window) : min(x.size, pos + window)]))
        p95 = float(np.percentile(local, 95)) if local.size else 0.0
        if p95 > 0:
            ratios.append(jump / p95)
    if not ratios:
        return 0.0, 0.0
    return round(float(np.max(ratios)), 3), round(float(np.median(ratios)), 3)


def edge_silence_ms(x: np.ndarray, rate: int) -> tuple[float, float]:
    """一段音频首尾连续机械静音的时长（毫秒），阈值同 playout 的 2% 峰值。

    流式 continuous 排程不裁首尾（裁了会吞字），所以「前一块尾静音 +
    后一块首静音」就是用户听到的块间空档。playout.ts 注释记录的先验是
    句首约 88ms、句尾 46~49ms，合计约 137ms；边界跳变因此恒为 0，
    真正该量的是这段静音有多长。
    """
    if x.size == 0 or rate <= 0:
        return 0.0, 0.0
    peak = float(np.max(np.abs(x)))
    threshold = peak * 0.02
    if threshold <= 0:
        return round(x.size / rate * 1000.0, 1), round(x.size / rate * 1000.0, 1)
    voiced = np.flatnonzero(np.abs(x) >= threshold)
    if voiced.size == 0:
        return round(x.size / rate * 1000.0, 1), round(x.size / rate * 1000.0, 1)
    head = float(voiced[0]) / rate * 1000.0
    tail = float(x.size - 1 - voiced[-1]) / rate * 1000.0
    return round(head, 1), round(tail, 1)


def spread(values: list[float]) -> float:
    return lp.spread(values)


def pct_bias(value: float, target: float) -> float:
    if value <= 0 or target <= 0:
        return 999.0
    return round(abs(value - target) / target * 100.0, 2)


# 流式主链路的块间停顿：player.ts 的 drainStreaming 对每个 chunk 都传
# continuous=true，playout.ts 里 `continuous ? 0 : gapBeforeMs` 直接忽略标点
# 停顿；连不同 HTTP 请求（不同块）之间也是采样点硬拼接。按标点加 gap 只用于
# 整块 /tts 兜底路径（continuous=false）。这里必须复刻主链路，否则：
#   1) 拼接音频凭空多出 20~80ms/块的静音，总时长与时间窗指标全偏；
#   2) 边界跳变测到的是插入的零样本，永远接近 0，会伪装成「接缝完美」。
STREAM_GAP_MS = 0.0


def sentence_gap_ms_for(block: str, index: int) -> float:
    """整块 /tts 兜底路径的标点停顿（仅作对照，不用于流式主链路）。"""
    if index == 0:
        return 0.0
    tail = block.rstrip()[-1:]
    if tail in "。！？!?":
        return 80.0
    if tail in "，、；：,;:":
        return 20.0
    return 40.0


def normalized(text: str) -> str:
    """逐字可逆只比非空白字符：前端切句会 strip，空格位置不算丢字。"""
    return re.sub(r"\s+", "", text)


# ---------------------------------------------------------------------------
# 单格采集
# ---------------------------------------------------------------------------
def run_cell(kind: str, length: str, do_single_ref: bool, atomic: bool | None = None) -> dict[str, Any]:
    text = matrix_text(kind, length)
    name = cell_name(kind, length)
    # atomic=None 跟随 lp.ATOMIC（--atomic）；A/B 探针可显式传 True/False。
    blocks = lp.frontend_blocks(text, atomic=atomic)
    units = units_of(text)
    print(
        f"\n=== {name} {KIND_LABEL[kind]}/{LENGTH_LABEL[length]} {len(text)}字 {units:.1f}单元 "
        f"→ {len(blocks)}块 TNS={'on' if TNS else 'off'} "
        f"atomic={'on' if (lp.ATOMIC if atomic is None else atomic) else 'off'} ===",
        flush=True,
    )

    per_block: list[dict[str, Any]] = []
    all_samples: list[np.ndarray] = []
    boundaries: list[int] = []
    rate = 24000
    synth_total_ms = 0.0
    sentence_extra_ms = 0.0
    play_t = 0.0
    underruns: list[float] = []
    for index, block in enumerate(blocks):
        got = stream_request("/tts/stream", tts_payload(block))
        x, rate = wav_of(got["chunks"])
        b_units = units_of(block)
        metrics = analyze_clip(lp.to_wav(x, rate), b_units)
        head_silence_ms, tail_silence_ms = edge_silence_ms(x, rate)
        duration = metrics.duration_s
        gap_ms = STREAM_GAP_MS
        sentence_gap_ms = sentence_gap_ms_for(block, index)
        sentence_extra_ms += sentence_gap_ms
        synth_total_ms += got["total_ms"]
        # 保守串行模型：第 i 块合成完的累计时刻 vs 前面所有块播完的时刻
        if index > 0 and synth_total_ms / 1000.0 > play_t:
            underruns.append(round(synth_total_ms / 1000.0 - play_t, 3))
        play_t += duration + gap_ms / 1000.0
        per_block.append(
            {
                "index": index,
                "chars": len(block),
                "units": round(b_units, 2),
                "text": block[:26],
                "http": got["http"],
                "chunk_count": got["chunk_count"],
                "ttfa_ms": got["ttfa_ms"],
                "total_ms": got["total_ms"],
                "first_chunk_audio_s": got["first_chunk_audio_s"],
                "duration_s": duration,
                "rate_units": round(b_units / duration, 3) if duration > 0 else 0.0,
                "rate_cps": metrics.chars_per_second,
                "f0_hz": metrics.f0_hz,
                "centroid_hz": metrics.centroid_hz,
                "rms": metrics.rms,
                "max_gap_ms": metrics.max_internal_gap_ms,
                "long_gaps": metrics.long_gaps,
                "speech_s": metrics.speech_s,
                "head_silence_ms": head_silence_ms,
                "tail_silence_ms": tail_silence_ms,
                "gap_ms": gap_ms,
                "sentence_gap_ms": sentence_gap_ms,
            }
        )
        if all_samples and gap_ms > 0:
            all_samples.append(np.zeros(int(gap_ms / 1000.0 * rate), dtype=np.float32))
        boundaries.append(sum(part.size for part in all_samples))
        all_samples.append(x)
        print(
            f"  #{index + 1:02d} {len(block):>3}字 {b_units:>5.1f}单元 "
            f"TTFA={got['ttfa_ms']:>6.0f}ms 合成={got['total_ms']:>6.0f}ms "
            f"音频={duration:>5.2f}s {b_units / duration if duration else 0:>5.2f}u/s "
            f"F0={metrics.f0_hz:>6.1f} 静音={metrics.max_internal_gap_ms:>5.0f}ms "
            f"片={got['chunk_count']:>2}",
            flush=True,
        )

    inter_block_silence = [
        round(per_block[i - 1]["tail_silence_ms"] + per_block[i]["head_silence_ms"], 1)
        for i in range(1, len(per_block))
    ]

    # xl 档的原文是同一批句子整轮重复两遍：前后半是**同一段话**，比较它们
    # 的中位语速/F0 就能把「念久了会不会换人、会不会越念越快」单独量出来。
    # 切分点未必逐块对齐（首块规则只作用于全段第一块），所以用中位数比较。
    half_drift: dict[str, Any] | None = None
    if length == "xl" and len(per_block) >= 6:
        mid = len(per_block) // 2
        first_half, second_half = per_block[:mid], per_block[mid:]
        r1 = [b["rate_units"] for b in first_half if b["rate_units"] > 0]
        r2 = [b["rate_units"] for b in second_half if b["rate_units"] > 0]
        f1 = [b["f0_hz"] for b in first_half if b["f0_hz"] > 0]
        f2 = [b["f0_hz"] for b in second_half if b["f0_hz"] > 0]
        half_drift = {
            "first_blocks": len(first_half),
            "second_blocks": len(second_half),
            "rate_drift_pct": drift_pct(float(np.median(r1)), float(np.median(r2))) if r1 and r2 else 999.0,
            "f0_drift_pct": drift_pct(float(np.median(f1)), float(np.median(f2))) if f1 and f2 else 999.0,
            "note": "前后半为同文本重复，切分点按中位数近似对照",
        }

    full = np.concatenate(all_samples) if all_samples else np.zeros(0, dtype=np.float32)
    windows = lp.time_window_features(full, rate)
    jump_max, jump_median = local_boundary_jumps(full, boundaries, rate)
    block_rates = [b["rate_units"] for b in per_block if b["rate_units"] > 0]
    block_f0s = [b["f0_hz"] for b in per_block if b["f0_hz"] > 0]
    block_cents = [b["centroid_hz"] for b in per_block if b["centroid_hz"] > 0]
    target_units_s = TTS_CHARS_PER_SECOND * SPEED
    median_rate = float(np.median(block_rates)) if block_rates else 0.0
    median_f0 = float(np.median(block_f0s)) if block_f0s else 0.0
    audio_s = full.size / float(rate)
    rtf = round(synth_total_ms / 1000.0 / audio_s, 3) if audio_s > 0 else 999.0

    result: dict[str, Any] = {
        "name": name,
        "kind": kind,
        "kind_label": KIND_LABEL[kind],
        "length": length,
        "length_label": LENGTH_LABEL[length],
        "chars": len(text),
        "units": round(units, 2),
        "blocks": per_block,
        "block_count": len(blocks),
        "reversible": normalized("".join(blocks)) == normalized(text),
        "playout_model": "stream_continuous_gap0",
        "sentence_path_extra_ms": round(sentence_extra_ms, 1),
        "collection_ok": all(
            b["http"] == 200 and b["chunk_count"] > 0 and b["duration_s"] > 0 and b["speech_s"] > 0
            for b in per_block
        ),
        "speed": {
            "first_block_ttfa_ms": per_block[0]["ttfa_ms"] if per_block else 0.0,
            "first_block_audio_s": per_block[0]["duration_s"] if per_block else 0.0,
            "first_chunk_audio_s": per_block[0]["first_chunk_audio_s"] if per_block else 0.0,
            "ttfa_p95_ms": round(float(np.percentile([b["ttfa_ms"] for b in per_block], 95)), 1) if per_block else 0.0,
            "synth_total_ms": round(synth_total_ms, 1),
            "audio_duration_s": round(audio_s, 3),
            "rtf": rtf,
            "underrun_count": len(underruns),
            "underrun_worst_s": max(underruns, default=0.0),
        },
        "rate": {
            "target_units_s": round(target_units_s, 2),
            "median_units_s": round(median_rate, 3),
            "bias_pct": pct_bias(median_rate, target_units_s),
            "block_spread_pct": spread(block_rates),
            "applicable": len(block_rates) >= 3,
        },
        "timbre": {
            "median_f0_hz": round(median_f0, 2),
            "block_f0_spread_pct": spread(block_f0s),
            "block_centroid_spread_pct": spread(block_cents),
            "window_f0_spread_pct": spread([w["f0_hz"] for w in windows]),
            "window_centroid_spread_pct": spread([w["centroid_hz"] for w in windows]),
            "f0_applicable": len(block_f0s) >= 3,
        },
        "fluency": {
            "max_internal_gap_ms": max((b["max_gap_ms"] for b in per_block), default=0.0),
            "long_gaps_total": sum(int(b["long_gaps"]) for b in per_block),
            "boundary_jump_max": jump_max,
            "boundary_jump_median": jump_median,
            "boundary_jump_note": "流式块边界落在模型 padding 静音内，该值恒为 0、无区分度；改看块间机械静音",
            "inter_block_silence_max_ms": max(inter_block_silence, default=0.0),
            "inter_block_silence_median_ms": round(float(np.median(inter_block_silence)), 1) if inter_block_silence else 0.0,
            "min_nonfirst_units": min((b["units"] for b in per_block[1:]), default=0.0),
            "block_count_applicable": len(per_block) >= 2,
        },
        "half_drift": half_drift,
        "single_request": None,
    }

    if do_single_ref:
        ref = stream_request("/tts/stream", tts_payload(text))
        ref_x, ref_rate = wav_of(ref["chunks"])
        ref_metrics = analyze_clip(lp.to_wav(ref_x, ref_rate), units)
        result["single_request"] = {
            "http": ref["http"],
            "chunk_count": ref["chunk_count"],
            "ttfa_ms": ref["ttfa_ms"],
            "total_ms": ref["total_ms"],
            "audio_s": round(ref_x.size / float(ref_rate), 3),
            "rate_units": round(units / (ref_x.size / float(ref_rate)), 3) if ref_x.size else 0.0,
            "f0_hz": ref_metrics.f0_hz,
            "max_internal_gap_ms": ref_metrics.max_internal_gap_ms,
            "long_gaps": ref_metrics.long_gaps,
        }

    print(
        f"  → 中位 {median_rate:.2f}u/s（基准 {target_units_s:.2f}，偏差 {result['rate']['bias_pct']:.1f}%）"
        f" 块间语速极差 {result['rate']['block_spread_pct']:.2f}% F0极差 {result['timbre']['block_f0_spread_pct']:.2f}%"
        f" TTFA {result['speed']['first_block_ttfa_ms']:.0f}ms RTF {rtf:.2f}"
        f" 边界 {jump_max:.2f}",
        flush=True,
    )
    return result


def run_repeat(kind: str, length: str, rounds: int) -> dict[str, Any]:
    """同文本重复采集：固定 seed 下应逐位一致，F0 不能有可测漂移。"""
    text = matrix_text(kind, length)
    name = cell_name(kind, length)
    print(f"\n=== 重复稳定性 {name} × {rounds} ===", flush=True)
    hashes: list[str] = []
    blob_hashes: list[str] = []
    f0s: list[float] = []
    durations: list[float] = []
    for i in range(rounds):
        got = stream_request("/tts/stream", tts_payload(text))
        blob_hashes.append(hashlib.sha256(b"".join(got["chunks"])).hexdigest()[:16])
        x, rate = wav_of(got["chunks"])
        metrics = analyze_clip(lp.to_wav(x, rate), units_of(text))
        # 判据必须落在**解码后的 PCM 样本**上：流式分片边界按时间窗切，
        # 每片 WAV 头不同会让拼接 blob 的哈希天然不同，那是假失败。
        hashes.append(hashlib.sha256(np.ascontiguousarray(x, dtype=np.float32).tobytes()).hexdigest()[:16])
        f0s.append(metrics.f0_hz)
        durations.append(metrics.duration_s)
        print(f"  #{i + 1} pcm={hashes[-1]} blob={blob_hashes[-1]} F0={metrics.f0_hz:.2f}Hz 时长={metrics.duration_s:.3f}s", flush=True)
    return {
        "name": name,
        "rounds": rounds,
        "hashes": hashes,
        "blob_hashes": blob_hashes,
        "identical": len(set(hashes)) == 1,
        "blob_identical": len(set(blob_hashes)) == 1,
        "f0_spread_pct": spread(f0s),
        "duration_spread_pct": spread(durations),
        "http_ok": all(d > 0 for d in durations),
    }


# ---------------------------------------------------------------------------
# 汇总与门禁
# ---------------------------------------------------------------------------
def summarize(cells: list[dict[str, Any]], repeats: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [c for c in cells if "error" not in c]
    by_length: dict[str, dict[str, Any]] = {}
    for length in LENGTHS:
        group = [c for c in ok if c["length"] == length]
        if not group:
            continue
        rates = [c["rate"]["median_units_s"] for c in group if c["rate"]["median_units_s"] > 0]
        f0s = [c["timbre"]["median_f0_hz"] for c in group if c["timbre"]["median_f0_hz"] > 0]
        ttfas = [c["speed"]["first_block_ttfa_ms"] for c in group if c["speed"]["first_block_ttfa_ms"] > 0]
        by_length[length] = {
            "cells": len(group),
            "median_units_s": round(float(np.median(rates)), 3) if rates else 0.0,
            "median_f0_hz": round(float(np.median(f0s)), 2) if f0s else 0.0,
            "median_ttfa_ms": round(float(np.median(ttfas)), 1) if ttfas else 0.0,
            "rate_spread_pct": spread(rates),
            "f0_spread_pct": spread(f0s),
        }
    by_kind: dict[str, dict[str, Any]] = {}
    for kind in KINDS:
        group = [c for c in ok if c["kind"] == kind]
        if not group:
            continue
        rates = [c["rate"]["median_units_s"] for c in group if c["rate"]["median_units_s"] > 0]
        f0s = [c["timbre"]["median_f0_hz"] for c in group if c["timbre"]["median_f0_hz"] > 0]
        by_kind[kind] = {
            "cells": len(group),
            "median_units_s": round(float(np.median(rates)), 3) if rates else 0.0,
            "median_f0_hz": round(float(np.median(f0s)), 2) if f0s else 0.0,
            "rate_spread_pct": spread(rates),
            "f0_spread_pct": spread(f0s),
        }
    all_rates = [c["rate"]["median_units_s"] for c in ok if c["rate"]["median_units_s"] > 0]
    all_f0s = [c["timbre"]["median_f0_hz"] for c in ok if c["timbre"]["median_f0_hz"] > 0]
    all_ttfa = [c["speed"]["first_block_ttfa_ms"] for c in ok if c["speed"]["first_block_ttfa_ms"] > 0]
    return {
        "cells": len(cells),
        "cells_ok": len(ok),
        "total_blocks": sum(c["block_count"] for c in ok),
        "total_audio_s": round(sum(c["speed"]["audio_duration_s"] for c in ok), 2),
        "cross_cell_rate_spread_pct": spread(all_rates),
        "cross_cell_f0_spread_pct": spread(all_f0s),
        "ttfa_p95_ms": round(float(np.percentile(all_ttfa, 95)), 1) if all_ttfa else 0.0,
        "ttfa_max_ms": round(max(all_ttfa, default=0.0), 1),
        "rtf_max": round(max((c["speed"]["rtf"] for c in ok), default=0.0), 3),
        "long_gaps_total": sum(c["fluency"]["long_gaps_total"] for c in ok),
        "max_internal_gap_ms": max((c["fluency"]["max_internal_gap_ms"] for c in ok), default=0.0),
        "boundary_jump_max": max((c["fluency"]["boundary_jump_max"] for c in ok), default=0.0),
        "underrun_cells": sum(1 for c in ok if c["speed"]["underrun_count"] > 0),
        "half_drift": [
            {
                "name": c["name"],
                **c["half_drift"],
            }
            for c in ok
            if c.get("half_drift")
        ],
        "by_length": by_length,
        "by_kind": by_kind,
        "length_group_rate_spread_pct": spread([v["median_units_s"] for v in by_length.values()]),
        "length_group_f0_spread_pct": spread([v["median_f0_hz"] for v in by_length.values()]),
        "kind_group_rate_spread_pct": spread([v["median_units_s"] for v in by_kind.values()]),
        "kind_group_f0_spread_pct": spread([v["median_f0_hz"] for v in by_kind.values()]),
        "repeat": {
            "items": repeats,
            "all_identical": all(r["identical"] for r in repeats) if repeats else False,
            "f0_spread_max_pct": max((r["f0_spread_pct"] for r in repeats), default=0.0),
            "tested": len(repeats),
        },
    }


THRESHOLDS_PATH = Path(__file__).with_name("mixed-matrix-thresholds.json")


def load_thresholds(path: Path) -> dict[str, float]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {k: float(v) for k, v in raw.items() if not k.startswith("_")}


def evaluate(cells: list[dict[str, Any]], summary: dict[str, Any], th: dict[str, float]) -> list[dict[str, Any]]:
    """逐格 + 全局门禁；单块样本走替代判据并在报告里显式标 N/A。"""
    violations: list[dict[str, Any]] = []

    def add(where: str, metric: str, value: Any, limit: Any, ok: bool) -> None:
        if not ok:
            violations.append({"where": where, "metric": metric, "value": value, "limit": limit})

    if summary["cells_ok"] != summary["cells"]:
        bad = [c["name"] for c in cells if "error" in c]
        add("全局", "采集完整", ",".join(bad), "无失败格", False)
    global_f0_values = [
        c["timbre"]["median_f0_hz"]
        for c in cells
        if "error" not in c and c["timbre"]["median_f0_hz"] > 0
    ]
    global_f0 = float(np.median(global_f0_values)) if global_f0_values else 0.0

    for c in cells:
        if "error" in c:
            add(c["name"], "采集", c["error"], "无异常", False)
            continue
        name = c["name"]
        rate, timbre, fluency, speed = c["rate"], c["timbre"], c["fluency"], c["speed"]
        add(name, "逐字可逆", c["reversible"], True, c["reversible"])
        add(name, "块采集完整", c["collection_ok"], True, c["collection_ok"])
        add(name, "块内最长静音ms", fluency["max_internal_gap_ms"], f"<= {th['max_internal_gap_ms']}", fluency["max_internal_gap_ms"] <= th["max_internal_gap_ms"])
        add(name, "异常长静音总数", fluency["long_gaps_total"], f"<= {th['long_gaps_total']}", fluency["long_gaps_total"] <= th["long_gaps_total"])
        # 边界跳变在流式 continuous 链路恒为 0（接缝落在 padding 静音内），
        # 没有区分度，只留在报告里作参考；硬判据换成块间机械静音时长。
        add(name, "块间机械静音ms", fluency["inter_block_silence_max_ms"], f"<= {th['max_inter_block_silence_ms']}", fluency["inter_block_silence_max_ms"] <= th["max_inter_block_silence_ms"])
        if fluency["block_count_applicable"]:
            add(name, "非首块最短单元", round(fluency["min_nonfirst_units"], 2), f">= {th['min_nonfirst_units']}", fluency["min_nonfirst_units"] >= th["min_nonfirst_units"])
        add(name, "语速基准口径", rate["target_units_s"], f"== {th['global_rate_units_s']}", abs(rate["target_units_s"] - th["global_rate_units_s"]) < 0.01)
        if rate["applicable"]:
            add(name, "块间单元语速极差%", rate["block_spread_pct"], f"<= {th['rate_units_spread_pct']}", rate["block_spread_pct"] <= th["rate_units_spread_pct"])
            add(name, "单元语速偏差%", rate["bias_pct"], f"<= {th['rate_bias_pct']}", rate["bias_pct"] <= th["rate_bias_pct"])
        else:
            # 单块/双块没有块间极差，用「与全局固定基准的偏差」替代，不放行 0
            add(name, "单元语速偏差%(块数不足,N/A替代)", rate["bias_pct"], f"<= {th['single_block_rate_bias_pct']}", rate["bias_pct"] <= th["single_block_rate_bias_pct"])
        if timbre["f0_applicable"]:
            add(name, "块间F0极差%", timbre["block_f0_spread_pct"], f"<= {th['block_f0_spread_pct']}", timbre["block_f0_spread_pct"] <= th["block_f0_spread_pct"])
        elif global_f0 > 0:
            bias = pct_bias(timbre["median_f0_hz"], global_f0)
            add(name, "F0偏差%(块数不足,N/A替代)", bias, f"<= {th['single_block_f0_bias_pct']}", bias <= th["single_block_f0_bias_pct"])
        add(name, "首块TTFA ms", speed["first_block_ttfa_ms"], f"<= {th['ttfa_max_ms']}", speed["first_block_ttfa_ms"] <= th["ttfa_max_ms"])
        add(name, "RTF", speed["rtf"], f"<= {th['rtf_max']}", speed["rtf"] <= th["rtf_max"])

    s = summary
    add("全局", "跨语料语速极差%", s["cross_cell_rate_spread_pct"], f"<= {th['cross_cell_rate_spread_pct']}", s["cross_cell_rate_spread_pct"] <= th["cross_cell_rate_spread_pct"])
    add("全局", "跨语料F0极差%", s["cross_cell_f0_spread_pct"], f"<= {th['cross_cell_f0_spread_pct']}", s["cross_cell_f0_spread_pct"] <= th["cross_cell_f0_spread_pct"])
    add("全局", "长度组间语速极差%", s["length_group_rate_spread_pct"], f"<= {th['length_group_rate_spread_pct']}", s["length_group_rate_spread_pct"] <= th["length_group_rate_spread_pct"])
    add("全局", "长度组间F0极差%", s["length_group_f0_spread_pct"], f"<= {th['length_group_f0_spread_pct']}", s["length_group_f0_spread_pct"] <= th["length_group_f0_spread_pct"])
    add("全局", "内容组间语速极差%", s["kind_group_rate_spread_pct"], f"<= {th['kind_group_rate_spread_pct']}", s["kind_group_rate_spread_pct"] <= th["kind_group_rate_spread_pct"])
    add("全局", "内容组间F0极差%", s["kind_group_f0_spread_pct"], f"<= {th['kind_group_f0_spread_pct']}", s["kind_group_f0_spread_pct"] <= th["kind_group_f0_spread_pct"])
    add("全局", "TTFA P95 ms", s["ttfa_p95_ms"], f"<= {th['ttfa_p95_ms']}", s["ttfa_p95_ms"] <= th["ttfa_p95_ms"])
    add("全局", "RTF 最大值", s["rtf_max"], f"<= {th['rtf_max']}", s["rtf_max"] <= th["rtf_max"])
    add("全局", "重复逐位一致", s["repeat"]["all_identical"], True, s["repeat"]["all_identical"] and s["repeat"]["tested"] > 0)
    add("全局", "重复F0极差%", s["repeat"]["f0_spread_max_pct"], f"<= {th['repeat_f0_spread_pct']}", s["repeat"]["f0_spread_max_pct"] <= th["repeat_f0_spread_pct"])
    return violations


def markdown(report: dict[str, Any], violations: list[dict[str, Any]]) -> str:
    """中文可读报告；N/A 明写，不拿 0 伪装通过。"""
    s = report["summary"]
    lines = [
        "# 混合内容 × 长度 语音一致性验收",
        "",
        f"- 采集时间：{report['created_at']}",
        f"- sidecar：`127.0.0.1:{report['port']}`，engine={report['engine']}，voice={report['voice']}，speed={report['speed']}",
        f"- 语料：{s['cells_ok']}/{s['cells']} 格成功，共 {s['total_blocks']} 个前端块，{s['total_audio_s']}s 音频",
        f"- 结论：{'✅ PASS' if not violations else '❌ FAIL（' + str(len(violations)) + ' 项违规）'}",
        "",
        "## 逐格实测",
        "",
        "| 语料 | 字数 | 单元 | 块数 | 语速 u/s | 偏差% | 块间语速极差 | F0 Hz | 块间F0极差 | TTFA ms | RTF | 最长静音 | 块间静音max |",
        "|---|---:|---:|---:|---:|---:|---|---:|---|---:|---:|---:|---:|",
    ]
    for c in report["cases"]:
        if "error" in c:
            lines.append(f"| {c['name']} | — | — | — | 采集失败：{c['error']} | | | | | | | | |")
            continue
        r, t, f, sp = c["rate"], c["timbre"], c["fluency"], c["speed"]
        rate_spread = f"{r['block_spread_pct']:.2f}%" if r["applicable"] else "N/A(1~2块)"
        f0_spread = f"{t['block_f0_spread_pct']:.2f}%" if t["f0_applicable"] else "N/A(1~2块)"
        lines.append(
            f"| {c['kind_label']}/{c['length_label']} | {c['chars']} | {c['units']:.1f} | {c['block_count']} | "
            f"{r['median_units_s']:.2f} | {r['bias_pct']:.1f} | {rate_spread} | {t['median_f0_hz']:.1f} | {f0_spread} | "
            f"{sp['first_block_ttfa_ms']:.0f} | {sp['rtf']:.2f} | {f['max_internal_gap_ms']:.0f}ms | {f['inter_block_silence_max_ms']:.0f}ms |"
        )
    lines += [
        "",
        "语速基准为全局固定 `4.1 × speed`；N/A 的格子改判「与基准的偏差」和与全局 F0 中位数的偏差，不把单块的 0 极差当成通过。",
        "",
        "主链路复刻流式 `continuous` 排程：块间 gap=0、按采样点硬拼接（`player.ts` 的 `drainStreaming` 对每个 chunk 都传 `continuous: true`）。按标点 20/80ms 停顿只属于整块 `/tts` 兜底路径，另记为 `sentence_path_extra_ms` 作对照。",
        "",
        "**边界跳变在本链路恒为 0、无区分度**：模型每块首尾自带机械静音（句首约 88ms、句尾 46~49ms），硬接缝落在静音里，测不出波形跳变。因此硬判据改用「相邻块尾静音 + 首静音」的块间机械静音时长，阈值 200ms 由 playout.ts 已记录的 137ms 先验给 1.45 倍余量得出；边界跳变只留在 JSON 报告里作参考。",
        "",
        "## 按长度分组（内容取中位数，看长度本身会不会改变音色/节奏）",
        "",
        "| 长度 | 格数 | 语速 u/s | 组内语速极差 | F0 Hz | 组内F0极差 | 首块TTFA中位 ms |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for k, v in s["by_length"].items():
        lines.append(f"| {LENGTH_LABEL.get(k, k)} | {v['cells']} | {v['median_units_s']:.2f} | {v['rate_spread_pct']:.2f}% | {v['median_f0_hz']:.1f} | {v['f0_spread_pct']:.2f}% | {v['median_ttfa_ms']:.0f} |")
    lines += [
        "",
        "## 按内容类型分组（长度取中位数，看字符构成会不会改变音色/节奏）",
        "",
        "| 内容 | 格数 | 语速 u/s | 组内语速极差 | F0 Hz | 组内F0极差 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for k, v in s["by_kind"].items():
        lines.append(f"| {KIND_LABEL.get(k, k)} | {v['cells']} | {v['median_units_s']:.2f} | {v['rate_spread_pct']:.2f}% | {v['median_f0_hz']:.1f} | {v['f0_spread_pct']:.2f}% |")
    lines += [
        "",
        "## 全局一致性",
        "",
        "| 指标 | 实测 | 阈值 |",
        "|---|---:|---:|",
        f"| 跨语料语速极差 | {s['cross_cell_rate_spread_pct']:.2f}% | ≤{report['thresholds']['cross_cell_rate_spread_pct']:.0f}% |",
        f"| 跨语料 F0 极差 | {s['cross_cell_f0_spread_pct']:.2f}% | ≤{report['thresholds']['cross_cell_f0_spread_pct']:.0f}% |",
        f"| 长度组间语速极差 | {s['length_group_rate_spread_pct']:.2f}% | ≤{report['thresholds']['length_group_rate_spread_pct']:.0f}% |",
        f"| 长度组间 F0 极差 | {s['length_group_f0_spread_pct']:.2f}% | ≤{report['thresholds']['length_group_f0_spread_pct']:.0f}% |",
        f"| 内容组间语速极差 | {s['kind_group_rate_spread_pct']:.2f}% | ≤{report['thresholds']['kind_group_rate_spread_pct']:.0f}% |",
        f"| 内容组间 F0 极差 | {s['kind_group_f0_spread_pct']:.2f}% | ≤{report['thresholds']['kind_group_f0_spread_pct']:.0f}% |",
        f"| TTFA P95 | {s['ttfa_p95_ms']:.0f}ms | ≤{report['thresholds']['ttfa_p95_ms']:.0f}ms |",
        f"| RTF 最大 | {s['rtf_max']:.2f} | ≤{report['thresholds']['rtf_max']:.2f} |",
        f"| 异常长静音总数 | {s['long_gaps_total']} | ≤{report['thresholds']['long_gaps_total']:.0f} |",
        f"| 串行模型欠流格数 | {s['underrun_cells']} | 参考指标 |",
        "",
        "## 重复稳定性（固定 seed）",
        "",
        "| 语料 | 次数 | 逐位一致 | F0极差 | 时长极差 |",
        "|---|---:|---|---:|---:|",
    ]
    for r in s["repeat"]["items"]:
        lines.append(f"| {r['name']} | {r['rounds']} | {'✅' if r['identical'] else '❌'} | {r['f0_spread_pct']:.2f}% | {r['duration_spread_pct']:.2f}% |")
    if s["half_drift"]:
        lines += [
            "",
            "## 超长档前后半同文本漂移（参考指标，未设门禁阈值）",
            "",
            "`xl` 原文是同一批句子整轮重复两遍，前后半念的是同一段话；这里比较两半的中位语速与 F0，观察「念久了会不会越读越快 / 换个人」。",
            "",
            "| 语料 | 前半块数 | 后半块数 | 语速漂移 | F0 漂移 |",
            "|---|---:|---:|---:|---:|",
        ]
        for h in s["half_drift"]:
            lines.append(f"| {KIND_LABEL.get(h['name'].split(':')[0], h['name'])}/{LENGTH_LABEL['xl']} | {h['first_blocks']} | {h['second_blocks']} | {h['rate_drift_pct']:.2f}% | {h['f0_drift_pct']:.2f}% |")
    if violations:
        lines += ["", "## 违规明细", ""]
        for v in violations:
            lines.append(f"- `{v['where']}` / {v['metric']}：实测 `{v['value']}`，要求 `{v['limit']}`")
    lines += [
        "",
        "## 诚实边界",
        "",
        "- 量的是本机 sidecar 的**客观音频/时序指标**，F0 与频谱质心只是音色代理，不等于说话人验证，也不等于桌面 WebView 真机听感。",
        "- RTF 与欠流用「逐块串行」保守模型；前端 SpeechQueue 会提前预取，实际听感的断流风险不高于这里的值。",
        "- 拼接按流式 `continuous` 硬接缝（gap=0）；整块 `/tts` 兜底路径会按标点多出 20~80ms/块，本层的 `sentence_path_extra_ms` 只记差值，不替它下听感结论。",
        "- `l` / `xl` 档不做整段一次请求对照（长文本那一层由 `longtext_probe.py` 覆盖），避免重复采集拖长门禁。",
        "- 固定 speaker 能压住块间语速与 F0，但**多次独立自回归生成的起头语调**仍会带来时间窗 F0 起伏；彻底跨段音色克隆需换 base 模型权重，本轮未做。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    global PORT, ENGINE, VOICE, SPEED, OUT, TNS, SHORT_GAP
    parser = argparse.ArgumentParser(description="混合内容×长度矩阵：流畅性/速度/语速/音色一致性验收")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PROBE_PORT", "8791")))
    parser.add_argument("--engine", default=ENGINE)
    parser.add_argument("--voice", default=VOICE)
    parser.add_argument("--speed", type=float, default=SPEED)
    parser.add_argument("--tns", choices=("on", "off"), default="on", help="TTS 文本前端规范化开关：on=生产默认，off=旧基线对照")
    parser.add_argument("--atomic", action="store_true", help="结构感知分块（默认关）；需前端偏好/服务端变量同时打开才是生产态")
    parser.add_argument("--short-gap", action="store_true", help='短块句内静音上限 P1（默认关）；请求级 {"shortGap": true} 只开本次，可与 --atomic 叠加')
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--lengths", default=",".join(LENGTHS), help="逗号分隔：xs,s,m,l,xl")
    parser.add_argument("--kinds", default=",".join(DEFAULT_KINDS), help="逗号分隔：cn,mixed,num,code,plain；加 spoken 可跑口语化改写 A/B")
    parser.add_argument("--cells", default="", help="精确指定格子，如 cn:xs,mixed:xl（优先于 --lengths/--kinds）")
    parser.add_argument("--repeat", type=int, default=3, help="同文本重复采集轮数，0 跳过")
    parser.add_argument("--repeat-cells", default="cn:s,mixed:s,num:s", help="重复稳定性取样格")
    parser.add_argument("--single-ref", default="xs,s,m", help="对哪些长度档做整段一次请求对照，空串关闭")
    parser.add_argument("--skip-existing", action="store_true", help="已有 cells/<name>.json 则跳过，便于中断续跑")
    parser.add_argument("--thresholds", default=str(THRESHOLDS_PATH))
    parser.add_argument("--check", action="store_true", help="按阈值门禁判定，违规退出码 1")
    args = parser.parse_args()

    PORT, ENGINE, VOICE, SPEED = args.port, args.engine, args.voice, args.speed
    TNS = args.tns == "on"
    lp.ATOMIC = args.atomic
    SHORT_GAP = args.short_gap
    OUT = Path(args.out)
    cell_dir = OUT / "cells"
    OUT.mkdir(parents=True, exist_ok=True)
    cell_dir.mkdir(parents=True, exist_ok=True)

    if args.cells.strip():
        pairs = [tuple(item.strip().split(":", 1)) for item in args.cells.split(",") if item.strip()]
    else:
        lengths = [x.strip() for x in args.lengths.split(",") if x.strip()]
        kinds = [x.strip() for x in args.kinds.split(",") if x.strip()]
        pairs = [(k, l) for l in lengths for k in kinds]
    for kind, length in pairs:
        if kind not in KINDS or length not in LENGTHS:
            parser.error(f"未知格子 {kind}:{length}（kinds={KINDS}, lengths={LENGTHS}）")
    single_lengths = {x.strip() for x in args.single_ref.split(",") if x.strip()}

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "port": PORT,
        "engine": ENGINE,
        "voice": VOICE,
        "speed": SPEED,
        "tns": TNS,
        "atomic": lp.ATOMIC,
        "shortGap": SHORT_GAP,
        "cells_requested": [cell_name(k, l) for k, l in pairs],
        "cases": [],
        "repeats": [],
        "thresholds": load_thresholds(Path(args.thresholds)),
    }
    for kind, length in pairs:
        name = cell_name(kind, length)
        path = cell_dir / f"{name.replace(':', '_')}.json"
        if args.skip_existing and path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            report["cases"].append(data)
            print(f"跳过已有 {name}", flush=True)
            continue
        try:
            data = run_cell(kind, length, length in single_lengths)
        except Exception as exc:  # 单格失败不影响矩阵其它格
            print(f"!! {name} 失败：{exc}", flush=True)
            data = {"name": name, "kind": kind, "length": length, "error": str(exc)}
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        report["cases"].append(data)

    if args.repeat > 0:
        for item in [x.strip() for x in args.repeat_cells.split(",") if x.strip()]:
            if ":" not in item:
                continue
            kind, length = item.split(":", 1)
            if (kind, length) not in pairs:
                continue
            try:
                report["repeats"].append(run_repeat(kind, length, args.repeat))
            except Exception as exc:
                report["repeats"].append({"name": item, "rounds": args.repeat, "identical": False, "f0_spread_pct": 999.0, "duration_spread_pct": 999.0, "http_ok": False, "hashes": [], "error": str(exc)})

    report["summary"] = summarize(report["cases"], report["repeats"])
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    violations = evaluate(report["cases"], report["summary"], report["thresholds"]) if args.check else []
    (OUT / "report.md").write_text(markdown(report, violations), encoding="utf-8")

    s = report["summary"]
    print("\n=== 矩阵汇总 ===")
    print(f"格数 {s['cells_ok']}/{s['cells']}  块数 {s['total_blocks']}  音频 {s['total_audio_s']}s")
    print(f"跨语料语速极差 {s['cross_cell_rate_spread_pct']:.2f}%  F0极差 {s['cross_cell_f0_spread_pct']:.2f}%")
    print(f"长度组间 语速 {s['length_group_rate_spread_pct']:.2f}% / F0 {s['length_group_f0_spread_pct']:.2f}%")
    print(f"内容组间 语速 {s['kind_group_rate_spread_pct']:.2f}% / F0 {s['kind_group_f0_spread_pct']:.2f}%")
    print(f"TTFA P95 {s['ttfa_p95_ms']:.0f}ms  RTF max {s['rtf_max']:.2f}  异常长静音 {s['long_gaps_total']}")
    print(f"重复一致 {s['repeat']['all_identical']}  F0极差 {s['repeat']['f0_spread_max_pct']:.2f}%")
    print(f"报告：{OUT / 'report.json'} / {OUT / 'report.md'}")
    if args.check:
        if violations:
            print(f"\nFAIL：{len(violations)} 项违规")
            for v in violations:
                print(f"  - {v['where']} / {v['metric']}：实测 {v['value']}，要求 {v['limit']}")
            return 1
        print(f"\nPASS：{s['cells_ok']} 格全部达标")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
