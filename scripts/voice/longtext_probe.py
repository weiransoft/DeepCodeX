#!/usr/bin/env python3
"""长文本专项验收：复现前端「切句 → 封块 → 逐块独立请求」的真实链路。

为什么需要它（2026-11-07 真机反馈「长文本还是会变语速，音色变了」）：
既有的 check_continuity.py 把整条文本**一次** POST 给 sidecar，而真实前端
会按句切成 9~13 个独立请求，每个请求都是一次全新的自回归生成。两者
覆盖的不是同一条链路——门禁全绿时，长文本仍然可能一句一个音色。

量化目标：
1. 每块实测语速（等效发音单元/秒）与 F0 / 频谱质心；
2. 按时间窗的 F0 轨迹，看音色漂移发生在块内还是块间；
3. 块内异常长静音与拼接边界；
4. 与「整段一次请求」对照。

用法：
    python3 scripts/voice/longtext_probe.py --port 8791
    python3 scripts/voice/longtext_probe.py --check --out /tmp/dcx-longtext
    python3 scripts/voice/longtext_probe.py --cases pure_cn,mixed_tech

`--check` 按 longtext-thresholds.json 做门禁，缺测 / 401 / 空音频一律
判违规而不是留 0 蒙混过关。只做测量与落盘，不改任何仓库文件。
"""
from __future__ import annotations

import argparse
import http.client
import io
import json
import math
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

REPO = Path("/Users/wangwei/Documents/VG/DeepCodeX-cli")
sys.path.insert(0, str(REPO / "scripts/voice"))
from mlx_voice_server import rebalance_tail, speech_units  # noqa: E402
from text_normalize import normalize_for_speech  # noqa: E402
from atomic_chunks import (  # noqa: E402
    atomic_spans,
    char_inside,
    cut_ok,
    flat,
    nearest_ok_cut,
)
from continuity import (  # noqa: E402
    SILENCE_RMS_RATIO,
    _autocorr_f0,
    _spectral_centroid,
    _windows,
    analyze_clip,
    decode_wav,
    split_stream_chunks,
)

PORT = int(os.environ.get("PROBE_PORT", "8791"))
ENGINE = "qwen3-customvoice"
VOICE = "sinan"
SPEED = 1.2
OUT = Path("/tmp/dcx-longtext-probe")
# TNS 默认打开（2026-11-07 产品决策）；`--tns off` 逐字复现旧基线。
# 分母必须按服务端真正念出来的文本算，否则规范化后语速会被系统性低估。
TNS = True


def spoken(text: str) -> str:
    return normalize_for_speech(text, TNS).text


def tts_payload(text: str) -> dict:
    return {"text": text, "engine": ENGINE, "voice": VOICE, "speed": SPEED, "tns": TNS}

STRONG = set("。！？!?；;…")
WEAK = set("，,、：:")
PUNCT = "。！？!?；;，,、：:"
FIRST_WEAK_MIN = 12
WEAK_MIN = 28
MAX_SENTENCE = 120
FIRST_BLOCK_CHARS = 14
BLOCK_CHARS = 48
MAX_BLOCK_CHARS = 48
MIN_BLOCK_UNITS = 10

# 结构感知分块（2026-11-07 P0）：默认关；`--atomic` 或由矩阵探针设置。
# 关闭时 frontend_blocks() 走 031f1cc2 原实现，音频与切分逐字可复现。
ATOMIC = False

TEXTS = {
    "pure_cn": (
        "我先把刚才那三处改动从头到尾捋了一遍，慢慢说给你听，不急着下结论。"
        "第一处是播放队列的状态机，原来是靠一个布尔量记着有没有在播，"
        "一旦流式回调迟到了一位，这一位就会永远卡在真值上，后面新来的句子全被挡在门外。"
        "第二处是解码超时，浏览器的音频解码在设备切换的时候可能既不成功也不失败，"
        "就那么悬着，所以必须给它一个硬上限，超时就跳过这一块而不是让整条链路陪着一起挂住。"
        "第三处是取消传播，用户打断一句话的时候，不只是要停掉正在播的音频，"
        "还得把排队中的合成、飞行中的识别和模型生成一起撤掉，否则过一会儿旧内容又会冒出来。"
        "这三处合起来，其实就是把「能出声」变成「一直稳定地出声」。"
        "你要是听着觉得哪一段还是不太顺，随时打断我，我再单独把那一块拆开看。"
    ),
    "mixed_tech": (
        "这次我把 session.ts 里的思考深度调度链路重新对了一遍，结论是这样的："
        "resolveThinkingDepth 每轮读四个信号，意图、复杂度、上下文长度和时效要求，"
        "输出 off、light、balanced、full 四档之一，再透传给 openai-provider 和 anthropic-provider。"
        "实测 short turn 的 TTFT 从 321 毫秒降到 190 毫秒左右，complex turn 保持在原来的 1.8 秒，"
        "因为 full 档严格等于用户配置的 reasoning effort，一个字段都没动。"
        "另外还有两个开关，DCX_THINK_DEPTH 设成 off 就能一键回到静态基线，"
        "X-Tts-Voice 回显的 speaker 是 serena，不是 vivian，这点在排查音色问题时特别容易搞混。"
        "如果你手上有 0.6B 的权重，也可以跑一次 A/B，不过那条路径不支持 instruct。"
    ),
    "no_punct": (
        "没有标点的长文本最能暴露语速漂移的问题因为模型看不到任何句读提示只能自己决定在哪里换气"
        "一旦文本超过四十八字生成轨迹就会开始发散有时会在中间突然加速有时又拖出一大段空白"
        "前端把它切成十四字和四十字的小块之后每一块都是一次独立的自回归生成"
        "块与块之间没有共享的韵律状态所以听感上就是前后两句不像同一个人用同一种节奏在说话"
        "这也是为什么我们必须在服务端用全局固定基准做逐段语速归一而不是让每段自己决定快慢"
    ),
    "numbers": (
        "看一下这次的实测数据：短句 14 字对应 4.09 字每秒，20 字是 4.92，标准 41 字是 4.17，"
        "无标点 48 字冲到 5.35，逗号密集的又是 4.72，跨度大概 31%。"
        "温度 0.9 时基频标准差 9.8 赫兹，0.35 压到 4.5，再降到 0.2 反而反弹到 9.3。"
        "流式首块 192 毫秒，整块 1821 毫秒，ASR 热态 58 到 86 毫秒，TTFA 大约 1770 到 1919 毫秒。"
        "所以 2026 年这一版的目标很明确：把第 3 项和第 7 项的抖动压到 5% 以内。"
    ),
}


SOUL_CONFIG = Path.home() / ".deepcode/soul/config.json"


def sidecar_token() -> str:
    return str(json.loads(SOUL_CONFIG.read_text(encoding="utf-8"))["voice"]["token"])


_HEADERS: dict[str, str] | None = None


def headers() -> dict[str, str]:
    """延迟读 token：配置缺失时 `--help` 仍能正常显示，不必先起引擎。"""
    global _HEADERS
    if _HEADERS is None:
        _HEADERS = {"Authorization": f"Bearer {sidecar_token()}"}
    return _HEADERS


def post(path: str, payload: dict, timeout: float = 240.0) -> tuple[int, bytes, float]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    started = time.monotonic()
    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                **headers(),
            },
        )
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, data, (time.monotonic() - started) * 1000.0
    finally:
        conn.close()


def to_wav(x: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0) * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm.tobytes())
    return buf.getvalue()


def join_wavs(blobs: list[bytes]) -> tuple[np.ndarray, int]:
    parts: list[np.ndarray] = []
    rate = 24000
    for blob in blobs:
        x, rate = decode_wav(blob)
        parts.append(x)
    return (np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)), rate


def split_long(text: str, limit: int = MAX_BLOCK_CHARS) -> list[str]:
    rest = text.strip()
    if not rest:
        return []
    if len(rest) <= limit:
        return [rest]
    out: list[str] = []
    minimum = max(1, int(limit * 0.6))
    while len(rest) > limit:
        cut = -1
        for i in range(limit, minimum - 1, -1):
            if rest[i - 1] in PUNCT:
                cut = i
                break
        if cut < 0:
            cut = limit
        out.append(rest[:cut])
        rest = rest[cut:]
    # 与前端 splitLongText / 服务端 split_long_text 同款尾段平衡：
    # 借多少按等效发音单元算，不拿单元缺口当字符数（中英混排会漏判）。
    if rest and out and speech_units(rest) < MIN_BLOCK_UNITS:
        balanced = rebalance_tail(out[-1], rest, MIN_BLOCK_UNITS, limit)
        out[-1] = balanced[0]
        rest = balanced[1] if len(balanced) > 1 else ""
    if rest:
        out.append(rest)
    return out


def take_sentences(text: str) -> list[str]:
    """复刻 sentence.ts 的非流式等价切句（首句弱断 12 字，后续 28 字）。"""
    out: list[str] = []
    start = 0
    emitted = 0
    for i, ch in enumerate(text):
        length = i - start + 1
        weak_min = FIRST_WEAK_MIN if emitted == 0 else WEAK_MIN
        is_strong = ch in STRONG
        is_weak = (not is_strong) and ch in WEAK and length >= weak_min
        is_newline = ch == "\n"
        is_overflow = length >= MAX_SENTENCE
        if not (is_strong or is_weak or is_newline or is_overflow):
            continue
        piece = text[start : i + 1].strip()
        if piece:
            out.append(piece)
            emitted += 1
        start = i + 1
    if start < len(text):
        piece = text[start:].strip()
        if piece:
            out.append(piece)
    return out


def balance_blocks(blocks: list[str]) -> list[str]:
    """最后一道保险：把任何 < MIN_BLOCK_UNITS 的非首块与它的前块重划切分点。

    真实前端的 SpeechQueue 也是这个语义（碎片并入前块，或攒到下一块再发），
    这里离线复刻时用一次全局收敛，保证门禁测到的「非首块最短单元」可信，
    而不是被某一条切句路径偶然漏掉的碎片污染。
    """
    out = list(blocks)
    for _ in range(len(out) + 2):
        idx = next((i for i in range(1, len(out)) if speech_units(out[i]) < MIN_BLOCK_UNITS), -1)
        if idx < 0:
            break
        balanced = rebalance_tail(out[idx - 1], out[idx], MIN_BLOCK_UNITS, MAX_BLOCK_CHARS)
        out[idx - 1 : idx + 1] = balanced
    return out


def frontend_blocks(text: str, atomic: bool | None = None) -> list[str]:
    """复刻 SpeechQueue 的真实封块链路（首块 14 字、后续 48 字、最短 10 单元）。

    `atomic` 为 None 时跟随全局 `ATOMIC`（由 `--atomic` / 矩阵探针设置）。
    这是**门禁唯一权威实现**：`chunking_ab_probe.py`、`mixed_matrix_probe.py`
    都调用它，避免出现两份会漂移的「前端复刻」。
    """
    use_atomic = ATOMIC if atomic is None else atomic
    if use_atomic:
        return frontend_blocks_atomic(text)
    blocks: list[str] = []

    def emit(chunk: str) -> None:
        nonlocal sealed
        for part in split_long(chunk):
            if speech_units(part) < MIN_BLOCK_UNITS and blocks:
                balanced = rebalance_tail(blocks[-1], part, MIN_BLOCK_UNITS, MAX_BLOCK_CHARS)
                blocks[-1] = balanced[0]
                part = balanced[1] if len(balanced) > 1 else ""
                if not part:
                    continue
            blocks.append(part)
            sealed += 1

    sealed = 0
    buf = ""
    for sentence in take_sentences(text):
        buf += sentence
        target = FIRST_BLOCK_CHARS if sealed == 0 else BLOCK_CHARS
        if len(buf) < target and len(buf) < MAX_BLOCK_CHARS:
            continue
        if sealed > 0 and speech_units(buf) < MIN_BLOCK_UNITS:
            continue
        emit(buf)
        buf = ""
    if buf.strip():
        emit(buf)
    return balance_blocks(blocks)


# ---------------------------------------------------------------------------
# 结构感知分块（2026-11-07 调研报告 P0）
#
# 三处切点全部带原子保护：断句符、48 字硬切回扫、尾段碎片重划。
# 与前端 `packages/web/web/src/voice/atomic.ts` 同源（`atomic_chunks.py`），
# 跨语言一致性由 `atomic-parity-fixtures.json` + 两侧单测保证。
# 真机 A/B：`code:xl` 43.71% → 6.84%，基线精确复现验收报告数值。
# ---------------------------------------------------------------------------
def take_sentences_atomic(text: str) -> list[str]:
    """复刻 sentence.ts 的切句，额外跳过结构内部的标点。"""
    spans = atomic_spans(text)
    out: list[str] = []
    start = 0
    emitted = 0
    for i, ch in enumerate(text):
        if char_inside(spans, i):
            continue
        length = i - start + 1
        weak_min = FIRST_WEAK_MIN if emitted == 0 else WEAK_MIN
        is_strong = ch in STRONG
        is_weak = (not is_strong) and ch in WEAK and length >= weak_min
        is_newline = ch == "\n"
        is_overflow = length >= MAX_SENTENCE
        if not (is_strong or is_weak or is_newline or is_overflow):
            continue
        cut = i + 1
        if not cut_ok(spans, cut):
            alt = nearest_ok_cut(spans, cut, start + 1)
            if alt < 0:
                continue
            cut = alt
        piece = text[start:cut].strip()
        if piece:
            out.append(piece)
            emitted += 1
        start = cut
    if start < len(text):
        piece = text[start:].strip()
        if piece:
            out.append(piece)
    return out


def rebalance_tail_safe(prev: str, short: str, min_units: float, limit: int) -> list[str]:
    """与 `rebalance_tail` 同语义，枚举切点时排除原子内部。"""
    merged = prev + short
    if len(merged) <= limit or not prev:
        return [merged]
    spans = atomic_spans(merged)
    lo = max(1, len(merged) - limit)
    hi = min(limit, len(merged) - 1)
    if lo > hi:
        # 两侧都装不下：整段交给服务端（它先 TNS 再按 48 字切，结构不会碎）。
        return [merged] if len(merged) <= 2 * limit else [merged[:limit], merged[limit:]]
    cuts = [c for c in range(lo, hi + 1) if cut_ok(spans, c)]
    min_side = lambda c: min(speech_units(merged[:c]), speech_units(merged[c:]))
    if not cuts or not any(min_side(c) >= min_units for c in cuts):
        # 没有「两段都够长」的合法切点：宁可让这一块超过 48 字，也不切开原子
        # 或留下 <10 单元的碎片。服务端会对整块先 TNS 再按 48 字切分。
        #
        # **已知边界（2026-11-07 全量矩阵实测）**：这条策略在 code:m 生成
        # 54 字块，服务端二次切出的短段带多段句内静音，单元语速掉到
        # 3.396 u/s、块间极差 33.67%（阈值 8%）。曾试过「不合并、选
        # minSide 最大切点」的替代策略：真机 code:xl 7.25% / code:m 0.81%
        # 两格达标，但产生 5.9 单元碎片（F0 275.9Hz），违反既有 ≥10 单元
        # 护栏，因此**未采用、也未放宽阈值**。根治需与 P1「短块句内静音
        # 上限」叠加，见 atomic-chunk-p0-2026-11-07.md §5.3。
        return (
            [merged]
            if len(merged) <= 2 * limit
            else rebalance_tail(prev, short, min_units, limit)
        )

    def prefer(a: int, b: int) -> int:
        pa = 0 if merged[a - 1] in PUNCT else 1
        pb = 0 if merged[b - 1] in PUNCT else 1
        return pa - pb or abs(a - len(prev)) - abs(b - len(prev))

    valid = [c for c in cuts if min_side(c) >= min_units]
    best = valid[0]
    for c in valid[1:]:
        if prefer(c, best) < 0:
            best = c
    return [merged[:best], merged[best:]]


def split_long_atomic(text: str, limit: int = MAX_BLOCK_CHARS) -> list[str]:
    """复刻 `splitLongText`，48 字硬切回扫时不切开原子。"""
    rest = text.strip()
    if not rest:
        return []
    if len(rest) <= limit:
        return [rest]
    out: list[str] = []
    minimum = max(1, int(limit * 0.6))
    while len(rest) > limit:
        spans = atomic_spans(rest)
        cut = -1
        for i in range(limit, minimum - 1, -1):
            if rest[i - 1] in PUNCT and cut_ok(spans, i):
                cut = i
                break
        if cut < 0:
            cut = nearest_ok_cut(spans, limit, minimum)
        if cut < 0:
            # 原子横跨上限：把切点后移到原子尾（允许这一请求块 >48 字），
            # 服务端会对整块先 TNS 再按 48 字切分。单个原子 >2×limit 才硬切。
            for start, end in spans:
                if start < limit < end:
                    cut = end if end <= 2 * limit else limit
                    break
        if cut < 0 or cut <= 0:  # 诚实降级
            cut = limit
        out.append(rest[:cut])
        rest = rest[cut:]
    if rest and out and speech_units(rest) < MIN_BLOCK_UNITS:
        balanced = rebalance_tail_safe(out[-1], rest, MIN_BLOCK_UNITS, limit)
        out[-1] = balanced[0]
        rest = balanced[1] if len(balanced) > 1 else ""
    if rest:
        out.append(rest)
    return out


def balance_blocks_safe(blocks: list[str]) -> list[str]:
    out = list(blocks)
    for _ in range(len(out) + 2):
        idx = next((i for i in range(1, len(out)) if speech_units(out[i]) < MIN_BLOCK_UNITS), -1)
        if idx < 0:
            break
        balanced = rebalance_tail_safe(out[idx - 1], out[idx], MIN_BLOCK_UNITS, MAX_BLOCK_CHARS)
        out[idx - 1 : idx + 1] = balanced
    return out


def frontend_blocks_atomic(text: str) -> list[str]:
    """结构感知版封块：三处切点都避开原子内部，逐字可逆。"""
    blocks: list[str] = []
    sealed = 0

    def emit(chunk: str) -> None:
        nonlocal sealed
        for part in split_long_atomic(chunk):
            if speech_units(part) < MIN_BLOCK_UNITS and blocks:
                balanced = rebalance_tail_safe(blocks[-1], part, MIN_BLOCK_UNITS, MAX_BLOCK_CHARS)
                blocks[-1] = balanced[0]
                part = balanced[1] if len(balanced) > 1 else ""
                if not part:
                    continue
            blocks.append(part)
            sealed += 1

    buf = ""
    for sentence in take_sentences_atomic(text):
        buf += sentence
        target = FIRST_BLOCK_CHARS if sealed == 0 else BLOCK_CHARS
        if len(buf) < target and len(buf) < MAX_BLOCK_CHARS:
            continue
        if sealed > 0 and speech_units(buf) < MIN_BLOCK_UNITS:
            continue
        emit(buf)
        buf = ""
    if buf.strip():
        emit(buf)
    return balance_blocks_safe(blocks)


def split_quality(text: str, blocks: list[str]) -> dict:
    """离线切分质量：逐字可逆、切断原子数、最长块、最短非首块。"""
    src = flat(text)
    spans = atomic_spans(src)
    joined = "".join(flat(b) for b in blocks)
    offset = 0
    broken = []
    for i, block in enumerate(blocks[:-1]):
        offset += len(flat(block))
        if not cut_ok(spans, offset):
            broken.append(
                {"boundary": i + 1, "offset": offset, "context": src[max(0, offset - 14) : offset + 14]}
            )
    return {
        "block_count": len(blocks),
        "reversible": joined == src,
        "broken_atom_boundaries": len(broken),
        "broken_examples": broken[:6],
        "max_chars": max((len(b) for b in blocks), default=0),
        "min_nonfirst_units": round(min((speech_units(b) for b in blocks[1:]), default=0.0), 2),
    }


def time_window_features(x: np.ndarray, rate: int, window_s: float = 2.0) -> list[dict]:
    """按时间窗测 F0/质心/RMS，用来观察音色随时间的漂移。"""
    width = int(window_s * rate)
    result: list[dict] = []
    for start in range(0, x.size, width):
        seg = x[start : start + width]
        if seg.size < int(0.3 * rate):
            continue
        frames, _, hop = _windows(seg, rate)
        rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
        peak = float(rms.max())
        voiced = rms > peak * SILENCE_RMS_RATIO if peak > 0 else np.zeros(rms.size, dtype=bool)
        idx = np.flatnonzero(voiced)
        f0s: list[float] = []
        cents: list[float] = []
        for i in idx[:: max(1, len(idx) // 40)]:
            frame = frames[int(i)]
            f0 = _autocorr_f0(frame, rate)
            if f0 > 0:
                f0s.append(f0)
            c = _spectral_centroid(frame, rate)
            if c > 0:
                cents.append(c)
        result.append(
            {
                "t_s": round(start / rate, 2),
                "f0_hz": round(float(np.median(f0s)), 2) if f0s else 0.0,
                "centroid_hz": round(float(np.median(cents)), 2) if cents else 0.0,
                "rms": round(float(np.sqrt(float(np.mean(seg.astype(np.float64) ** 2)))), 5),
                "voiced_frames": int(idx.size),
            }
        )
    return result


def boundary_jumps(x: np.ndarray, rate: int, boundaries: list[int]) -> list[float]:
    """块边界前后的样本幅度跳变 / 全局 RMS（越大越可能听出「咔」）。"""
    global_rms = float(np.sqrt(float(np.mean(x.astype(np.float64) ** 2)))) or 1e-9
    width = max(1, int(0.005 * rate))
    out: list[float] = []
    for pos in boundaries:
        if pos <= width or pos >= x.size - width:
            continue
        before = float(np.abs(x[pos - width : pos]).mean())
        after = float(np.abs(x[pos : pos + width]).mean())
        out.append(round(abs(after - before) / global_rms, 3))
    return out


def spread(values: list[float]) -> float:
    clean = [v for v in values if math.isfinite(v) and v > 0]
    if len(clean) < 2:
        return 0.0
    mean = sum(clean) / len(clean)
    return round((max(clean) - min(clean)) / mean * 100.0, 2) if mean > 0 else 0.0


def run_one(name: str, text: str) -> dict:
    print(f"\n=== {name} ({len(text)} 字) ===", flush=True)
    blocks = frontend_blocks(text)
    print(f"前端分 {len(blocks)} 块：{[len(b) for b in blocks]}", flush=True)

    per_block: list[dict] = []
    all_samples: list[np.ndarray] = []
    boundaries: list[int] = []
    rate = 24000
    for index, block in enumerate(blocks):
        status, data, elapsed = post("/tts/stream", tts_payload(block))
        chunks = split_stream_chunks(data) if status == 200 else []
        x, rate = join_wavs(chunks)
        units = speech_units(spoken(block))
        metrics = analyze_clip(to_wav(x, rate), len(block))
        per_block.append(
            {
                "index": index,
                "chars": len(block),
                "units": round(units, 2),
                "text": block[:24],
                "http": status,
                "chunks": len(chunks),
                "elapsed_ms": round(elapsed, 1),
                "duration_s": metrics.duration_s,
                "rate_cps": metrics.chars_per_second,
                "rate_units": round(units / metrics.duration_s, 3) if metrics.duration_s > 0 else 0.0,
                "rate_speech_cps": metrics.chars_per_second_speech,
                "f0_hz": metrics.f0_hz,
                "centroid_hz": metrics.centroid_hz,
                "max_gap_ms": metrics.max_internal_gap_ms,
                "long_gaps": metrics.long_gaps,
                "segments": metrics.segments,
            }
        )
        # 流式主链路：player.ts 的 drainStreaming 对每个 chunk 都传
        # continuous=true，playout.ts 里 `continuous ? 0 : gapBeforeMs` 让标点
        # 停顿被忽略——连不同请求（不同块）之间也是采样点硬拼接。旧版误用了
        # 整块 /tts 兜底路径的 20/80ms gap，凭空加静音，还让 boundary_jumps
        # 测到插入的零样本而不是真实波形接缝。门禁的逐块指标不受影响。
        gap_ms = 0
        if all_samples and gap_ms > 0:
            all_samples.append(np.zeros(int(gap_ms / 1000.0 * rate), dtype=np.float32))
        boundaries.append(sum(p.size for p in all_samples))
        all_samples.append(x)
        print(
            f"  #{index + 1:02d} {len(block):>2}字 {metrics.chars_per_second:>5.2f}字/秒 "
            f"F0={metrics.f0_hz:>6.1f}Hz 质心={metrics.centroid_hz:>7.1f}Hz "
            f"时长={metrics.duration_s:>5.2f}s 最长静音={metrics.max_internal_gap_ms:>6.0f}ms "
            f"块数={len(chunks):>2} {elapsed:>6.0f}ms",
            flush=True,
        )

    full = np.concatenate(all_samples) if all_samples else np.zeros(0, dtype=np.float32)
    full_metrics = analyze_clip(to_wav(full, rate), len(text))
    windows = time_window_features(full, rate)
    jumps = boundary_jumps(full, rate, boundaries)

    # 对照：整段一次请求（服务端内部按 48 字分段）
    status, data, elapsed = post("/tts/stream", tts_payload(text))
    ref_chunks = split_stream_chunks(data) if status == 200 else []
    ref_x, ref_rate = join_wavs(ref_chunks)
    ref_metrics = analyze_clip(to_wav(ref_x, ref_rate), len(text))
    ref_windows = time_window_features(ref_x, ref_rate)

    result = {
        "name": name,
        "chars": len(text),
        "frontend_blocks": per_block,
        "frontend": {
            "duration_s": full_metrics.duration_s,
            "rate_cps": full_metrics.chars_per_second,
            "rate_spread_pct": spread([b["rate_cps"] for b in per_block]),
            "rate_units_spread_pct": spread([b["rate_units"] for b in per_block]),
            "f0_spread_pct": spread([b["f0_hz"] for b in per_block]),
            "centroid_spread_pct": spread([b["centroid_hz"] for b in per_block]),
            "max_internal_gap_ms": full_metrics.max_internal_gap_ms,
            "long_gaps": full_metrics.long_gaps,
            "boundary_jumps": jumps,
            "boundary_jump_max": max(jumps, default=0.0),
            "windows": windows,
            "window_f0_spread_pct": spread([w["f0_hz"] for w in windows]),
            "window_centroid_spread_pct": spread([w["centroid_hz"] for w in windows]),
        },
        "single_request": {
            "http": status,
            "chunks": len(ref_chunks),
            "elapsed_ms": round(elapsed, 1),
            "duration_s": ref_metrics.duration_s,
            "rate_cps": ref_metrics.chars_per_second,
            "max_internal_gap_ms": ref_metrics.max_internal_gap_ms,
            "long_gaps": ref_metrics.long_gaps,
            "windows": ref_windows,
            "window_f0_spread_pct": spread([w["f0_hz"] for w in ref_windows]),
            "window_centroid_spread_pct": spread([w["centroid_hz"] for w in ref_windows]),
        },
    }
    print(
        f"  → 前端链路：语速 {full_metrics.chars_per_second:.2f} 字/秒，字符口径极差 {result['frontend']['rate_spread_pct']:.2f}%，"
        f"单元口径极差 {result['frontend']['rate_units_spread_pct']:.2f}%，"
        f"F0 极差 {result['frontend']['f0_spread_pct']:.2f}%，时间窗 F0 极差 {result['frontend']['window_f0_spread_pct']:.2f}%，"
        f"边界跳变 max {result['frontend']['boundary_jump_max']:.2f}",
        flush=True,
    )
    print(
        f"  → 单请求：语速 {ref_metrics.chars_per_second:.2f} 字/秒，时间窗 F0 极差 {result['single_request']['window_f0_spread_pct']:.2f}%，"
        f"耗时 {elapsed:.0f}ms",
        flush=True,
    )
    return result


THRESHOLDS_PATH = Path(__file__).with_name("longtext-thresholds.json")


def load_thresholds(path: Path) -> dict[str, float]:
    """读阈值 JSON，跳过 `_` 开头的说明字段。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {key: float(value) for key, value in raw.items() if not key.startswith("_")}


def evaluate_case(case: dict[str, Any], thresholds: dict[str, float]) -> list[dict[str, Any]]:
    """一条语料的门禁判定；401 / 空音频 / 采集异常一律算违规，不留 0 蒙混过关。"""
    name = str(case["name"])
    if "error" in case:
        return [{"name": name, "metric": "采集", "value": str(case["error"]), "limit": "无异常"}]
    front = case["frontend"]
    blocks: list[dict[str, Any]] = case["frontend_blocks"]
    violations: list[dict[str, Any]] = []

    def add(metric: str, value: Any, limit: Any, ok: bool) -> None:
        if not ok:
            violations.append({"name": name, "metric": metric, "value": value, "limit": limit})

    broken = [b["index"] for b in blocks if b["http"] != 200 or b["chunks"] == 0 or b["duration_s"] <= 0]
    add("块采集完整", f"异常块 {broken}", "0 块", len(broken) == 0)
    add("块数", len(blocks), f">= {thresholds['min_blocks']:.0f}", len(blocks) >= thresholds["min_blocks"])
    add(
        "单元语速极差%",
        round(front["rate_units_spread_pct"], 2),
        f"<= {thresholds['rate_units_spread_pct']}",
        front["rate_units_spread_pct"] <= thresholds["rate_units_spread_pct"],
    )
    add(
        "块间 F0 极差%",
        round(front["f0_spread_pct"], 2),
        f"<= {thresholds['block_f0_spread_pct']}",
        front["f0_spread_pct"] <= thresholds["block_f0_spread_pct"],
    )
    max_gap = max((float(b["max_gap_ms"]) for b in blocks), default=0.0)
    add("块内最长静音ms", max_gap, f"<= {thresholds['max_block_gap_ms']}", max_gap <= thresholds["max_block_gap_ms"])
    long_total = sum(int(b["long_gaps"]) for b in blocks)
    add("异常长静音总数", long_total, f"<= {thresholds['long_gaps_total']:.0f}", long_total <= thresholds["long_gaps_total"])
    min_units = min((float(b["units"]) for b in blocks[1:]), default=0.0)
    add(
        "非首块最短单元",
        round(min_units, 2),
        f">= {thresholds['min_frontend_units']}",
        min_units >= thresholds["min_frontend_units"],
    )
    return violations


def main() -> int:
    global PORT, ENGINE, VOICE, SPEED, OUT, TNS, ATOMIC
    parser = argparse.ArgumentParser(description="长文本语音连贯性专项验收（复刻前端分块链路）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PROBE_PORT", "8791")), help="sidecar 端口")
    parser.add_argument("--engine", default=ENGINE)
    parser.add_argument("--voice", default=VOICE)
    parser.add_argument("--speed", type=float, default=SPEED)
    parser.add_argument("--tns", choices=("on", "off"), default="on", help="TTS 文本前端规范化开关：on=生产默认，off=旧基线对照")
    parser.add_argument("--atomic", action="store_true", help="结构感知分块（默认关，对应前端偏好 dcx.voice.atomicChunk.v1）")
    parser.add_argument("--out", default=str(OUT), help="报告输出目录")
    parser.add_argument("--cases", default="", help="逗号分隔的语料名，默认全部")
    parser.add_argument("--texts", default="", help="自定义语料文件（每行一条，# 开头为注释）")
    parser.add_argument("--thresholds", default=str(THRESHOLDS_PATH))
    parser.add_argument("--check", action="store_true", help="按阈值门禁判定，违规时退出码 1")
    args = parser.parse_args()

    PORT, ENGINE, VOICE, SPEED = args.port, args.engine, args.voice, args.speed
    TNS = args.tns == "on"
    ATOMIC = args.atomic
    OUT = Path(args.out)
    OUT.mkdir(parents=True, exist_ok=True)

    texts = dict(TEXTS)
    if args.texts:
        lines = [
            line.strip()
            for line in Path(args.texts).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        texts = {f"line-{index + 1}": line for index, line in enumerate(lines)}
    selected = [item.strip() for item in args.cases.split(",") if item.strip()] or list(texts)

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "port": PORT,
        "engine": ENGINE,
        "voice": VOICE,
        "speed": SPEED,
        "tns": TNS,
        "cases": [],
    }
    for name in selected:
        if name not in texts:
            print(f"!! 未知语料 {name}（可选：{', '.join(texts)}）", flush=True)
            report["cases"].append({"name": name, "error": "未知语料"})
            continue
        try:
            report["cases"].append(run_one(name, texts[name]))
        except Exception as exc:  # 单个样本失败不影响其它样本
            print(f"!! {name} 失败：{exc}", flush=True)
            report["cases"].append({"name": name, "error": str(exc)})

    path = OUT / f"report-{PORT}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告已写入 {path}", flush=True)

    if not args.check:
        return 0
    thresholds = load_thresholds(Path(args.thresholds))
    violations: list[dict[str, Any]] = []
    for case in report["cases"]:
        violations.extend(evaluate_case(case, thresholds))
    print("\n=== 长文本门禁 ===")
    print(f"{'语料':<14} {'块数':>4} {'单元语速极差':>13} {'块间F0极差':>11} {'最长静音':>10} {'最短非首块单元':>15}")
    for case in report["cases"]:
        if "error" in case:
            print(f"{case['name']:<14} 采集失败：{case['error']}")
            continue
        blocks = case["frontend_blocks"]
        print(
            f"{case['name']:<14} {len(blocks):>4} "
            f"{case['frontend']['rate_units_spread_pct']:>12.2f}% "
            f"{case['frontend']['f0_spread_pct']:>10.2f}% "
            f"{max((b['max_gap_ms'] for b in blocks), default=0):>9.0f}ms "
            f"{min((b['units'] for b in blocks[1:]), default=0):>14.1f}"
        )
    if violations:
        print(f"\nFAIL：{len(violations)} 项违规")
        for item in violations:
            print(f"  - {item['name']} / {item['metric']}：实测 {item['value']}，要求 {item['limit']}")
        return 1
    print(f"\nPASS：{len(report['cases'])} 条语料全部达标")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
