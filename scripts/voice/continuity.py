"""
语音连贯性客观指标内核（纯 numpy + 标准库，不加载 MLX 模型）

## 为什么需要这一层

「语音连贯」在用户侧是几件不同的事，靠听感无法回归：

1. **语速连贯** —— 前后句不能忽快忽慢。服务端逐块 pace normalization 把
   原生 4.09~5.35 字/秒收敛到 4.92 字/秒，但只有量化每轮实际输出的
   `chars/s` 才能防止日后被改回去。
2. **时间轴连贯** —— 流式块拼接点不能有 click，句内不能出现几百毫秒的
   空白（用户说的「中间卡顿」「讲了几句就断了」）。
3. **音色连贯** —— 司南预设靠固定 speaker + 固定 seed 锁音色，用 F0 与
   频谱质心的跨轮离散度做客观代理指标；同一文本重复合成还能做严格对照。
4. **流式等价** —— `/tts/stream` 拼起来应与 `/tts` 等时长，否则说明分块
   逻辑改变了内容（丢字或重复）。
5. **多轮不劣化** —— 「越聊越迟钝」表现为 TTFA/总耗时随轮次增长。
6. **文本连贯** —— 切句拼接不丢字不重念（在 TS 侧单测里锁）。

这里只做**可离线重放**的信号分析：输入 WAV 字节，输出机器可读指标。
采集与阈值判定在 `check_continuity.py`，合成信号回归在 `test_continuity.py`。

## 设计约束

- 不 import `mlx_voice_server`（会拉起 MLX 依赖），只要有 numpy 就能跑；
  因此 CI / 非 Apple Silicon 机器也能跑离线单测与 `--replay`。
- 不依赖 librosa/scipy，F0 用短时自相关、音色用频谱质心，全部自己算。
- 指标只描述事实，不判定好坏；判定统一交给 `evaluate()`，阈值外置到
  `continuity-thresholds.json`，避免把本机一次实测悄悄写成硬编码真理。
"""

from __future__ import annotations

import io
import json
import math
import struct
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

# ---------------------------------------------------------------------------
# 分析参数
# ---------------------------------------------------------------------------

FRAME_MS = 40
HOP_MS = 20
# 相对峰值 RMS 的静音门限：-40dB。取相对值是为了不依赖录音电平，
# 与 playout.ts 的 SILENCE_PEAK_RATIO 同一思路，但按帧能量而非逐样本。
SILENCE_RMS_RATIO = 0.01
# 超过这个长度的句内静音算「卡顿」。真机实测正常语义停顿 620~660ms
# （41 字长句、逗号密集句），因此门槛放到 800ms；首尾 padding 不算句内。
LONG_GAP_MS = 800
# 计算 F0/质心时最多取多少个有声帧（长文本控制耗时）
MAX_FEATURE_FRAMES = 240
F0_MIN_HZ = 70.0
F0_MAX_HZ = 400.0
# 自相关峰值低于此值视为清音/无基频，不计入 F0 中位数
F0_CONFIDENCE = 0.30

DEFAULT_THRESHOLDS: dict[str, float] = {
    # 跨轮语速极差 / 均值。服务端逐块伺服实测 0.5~1.0%，留 6% 余量。
    "rate_spread_pct": 6.0,
    # 句内最长静音。语义停顿允许，但出现 >900ms 就是「讲了几句断了」。
    "max_internal_gap_ms": 900.0,
    # 全程超过 LONG_GAP_MS 的静音段总数
    "long_gaps_total": 2.0,
    # 流式拼接与整块的时长差（取各轮最大值）
    "stream_batch_duration_delta_pct": 3.0,
    # 块边界跳变 / 全信号差分 P95。>3 说明拼接点有 click。
    "boundary_jump_ratio": 3.0,
    # 跨轮音色离散度（不同文本 F0 本来就会变，阈值有意放宽）
    "f0_spread_pct": 25.0,
    "centroid_spread_pct": 35.0,
    # 同一文本重复合成的严格对照
    "same_text_f0_drift_pct": 8.0,
    "same_text_centroid_drift_pct": 12.0,
    # 后段 TTFA / 前段 TTFA 的增幅上限（越聊越迟钝）
    "ttfa_growth_pct": 60.0,
    # 流式至少交付这么多块（1 块等于没流式）
    "min_stream_chunks": 2.0,
}

THRESHOLDS_PATH = Path(__file__).with_name("continuity-thresholds.json")


def load_thresholds(path: Path | None = None) -> dict[str, float]:
    """读取外置阈值；文件缺失时用内置默认值。

    @param path 阈值文件（默认同目录 continuity-thresholds.json）
    @returns 阈值字典
    """
    target = path or THRESHOLDS_PATH
    if not target.is_file():
        return dict(DEFAULT_THRESHOLDS)
    raw = json.loads(target.read_text(encoding="utf-8"))
    merged = dict(DEFAULT_THRESHOLDS)
    for key, value in raw.items():
        if key.startswith("_"):
            continue  # 注释字段
        if key not in merged:
            raise ValueError(f"未知阈值 {key}（可用：{', '.join(sorted(merged))}）")
        merged[key] = float(value)
    return merged


# ---------------------------------------------------------------------------
# WAV 解码与流式协议
# ---------------------------------------------------------------------------


def decode_wav(blob: bytes) -> tuple[np.ndarray, int]:
    """sidecar 输出（PCM16 单声道 WAV）→ float32 单声道样本。

    @param blob 完整 WAV 字节
    @returns (样本, 采样率)
    """
    with wave.open(io.BytesIO(blob), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        raw = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"只支持 PCM16 WAV，实际 sampwidth={width}")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        usable = samples.size - samples.size % channels
        samples = samples[:usable].reshape(-1, channels).mean(axis=1)
    return np.ascontiguousarray(samples, dtype=np.float32), int(rate)


def split_stream_chunks(blob: bytes) -> list[bytes]:
    """解析 `[4B 大端长度][独立 WAV]` 重复流。

    @param blob `/tts/stream` 的完整响应体
    @returns 每块独立 WAV 字节
    """
    chunks: list[bytes] = []
    pos = 0
    size = len(blob)
    while pos < size:
        if size - pos < 4:
            raise ValueError(f"流式响应尾部剩 {size - pos} 字节，不足 4B 长度头")
        length = struct.unpack_from(">I", blob, pos)[0]
        pos += 4
        if length == 0 or pos + length > size:
            raise ValueError(f"流式块长度非法：length={length} 剩余={size - pos}")
        chunks.append(blob[pos : pos + length])
        pos += length
    return chunks


# ---------------------------------------------------------------------------
# 单段音频指标
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClipMetrics:
    """一段朗读音频的客观指标（可 JSON 序列化）。"""

    duration_s: float
    speech_s: float
    chars: float
    # 与服务端 segment_servo_speed 同口径：等效发音单元 / 整段时长（含有声 +
    # 语义停顿）。不能用「只算有声」的分母：长句静音占比从 8% 涨到 25%，会把
    # 长句虚高成「读得更快」。也不能用字符数：标点不发音、中英混排按字符计会
    # 把发音量少算一半（2026-11-07 实测中英混排块间语速极差 76%）。
    chars_per_second: float
    # 参考值：只算有声样本。与上面一起看能分辨「语速变了」还是「停顿变多了」。
    chars_per_second_speech: float
    max_internal_gap_ms: float
    long_gaps: int
    segments: int
    f0_hz: float
    centroid_hz: float
    rms: float
    clip_ratio: float

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _windows(x: np.ndarray, rate: int) -> tuple[np.ndarray, int, int]:
    """切帧，返回 (帧矩阵, 窗长, 步长)。样本不足一帧时补零。"""
    width = max(1, int(round(rate * FRAME_MS / 1000)))
    hop = max(1, int(round(rate * HOP_MS / 1000)))
    if x.size < width:
        padded = np.zeros(width, dtype=np.float32)
        padded[: x.size] = x
        return padded.reshape(1, width), width, hop
    return sliding_window_view(x, width)[::hop], width, hop


def _voiced_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """布尔帧序列 → 连续 True 的帧区间 [start, end)。"""
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    return [(int(edges[i]), int(edges[i + 1])) for i in range(0, edges.size, 2)]


def _autocorr_f0(frame: np.ndarray, rate: int) -> float:
    """短时归一化自相关估 F0（无外部依赖）。

    @param frame 单帧样本
    @param rate 采样率
    @returns 基频 Hz；无可靠峰值返回 0
    """
    x = frame - float(frame.mean())
    denom = float(np.dot(x, x))
    if denom <= 1e-12:
        return 0.0
    lo = max(1, int(rate / F0_MAX_HZ))
    hi = min(int(rate / F0_MIN_HZ), x.size - 1)
    if hi <= lo:
        return 0.0
    best_lag = 0
    best = 0.0
    for lag in range(lo, hi + 1):
        corr = float(np.dot(x[: x.size - lag], x[lag:])) / denom
        if corr > best:
            best, best_lag = corr, lag
    if best < F0_CONFIDENCE or best_lag == 0:
        return 0.0
    return rate / float(best_lag)


def _spectral_centroid(frame: np.ndarray, rate: int) -> float:
    """单帧幅度谱质心（Hz），用作音色亮度的粗代理。"""
    windowed = frame * np.hanning(frame.size).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(windowed))
    total = float(spectrum.sum())
    if total <= 1e-12:
        return 0.0
    freqs = np.fft.rfftfreq(frame.size, d=1.0 / rate)
    return float(np.dot(freqs, spectrum) / total)


def analyze_clip(blob: bytes, chars: float) -> ClipMetrics:
    """分析一段 TTS WAV。

    语速用**整段时长**，与服务端 `segment_servo_speed()` 同口径：等效发音单元
    除以 samples.size/rate。不改用「只算有声」的分母——真机实测长句静音占比
    8%→25%，那样会把 4.92 单元/秒虚高成 6.59，制造假的语速跳变。
    另给 `chars_per_second_speech`，两者一起看能分辨「语速变了」还是
    「句内停顿变多了」。

    @param blob 完整 WAV 字节
    @param chars 这段的等效发音单元数（由 speech_units(text) 给出）
    @returns 指标
    """
    x, rate = decode_wav(blob)
    duration_s = x.size / float(rate)
    if x.size == 0:
        return ClipMetrics(0.0, 0.0, chars, 0.0, 0.0, 0.0, 0, 0, 0.0, 0.0, 0.0, 0.0)

    frames, width, hop = _windows(x, rate)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    peak = float(rms.max())
    voiced = rms > peak * SILENCE_RMS_RATIO if peak > 0 else np.zeros(rms.size, dtype=bool)
    runs = _voiced_runs(voiced)

    # 有声区间按帧还原到样本；相邻区间之间即句内静音
    sample_runs = [(min(s * hop, x.size), min(e * hop + width - hop, x.size)) for s, e in runs]
    speech_samples = sum(end - start for start, end in sample_runs if end > start)
    speech_s = speech_samples / float(rate)
    gaps_ms = [
        (sample_runs[i + 1][0] - sample_runs[i][1]) / float(rate) * 1000.0
        for i in range(len(sample_runs) - 1)
    ]
    max_gap = max(gaps_ms, default=0.0)
    long_gaps = sum(1 for gap in gaps_ms if gap >= LONG_GAP_MS)

    # 音色特征只取有声帧；长文本等距抽样，避免 O(分钟数) 的自相关循环
    idx = np.flatnonzero(voiced)
    if idx.size > MAX_FEATURE_FRAMES:
        idx = idx[np.linspace(0, idx.size - 1, MAX_FEATURE_FRAMES).astype(int)]
    f0s: list[float] = []
    centroids: list[float] = []
    for i in idx:
        frame = frames[int(i)]
        f0 = _autocorr_f0(frame, rate)
        if f0 > 0:
            f0s.append(f0)
        centroid = _spectral_centroid(frame, rate)
        if centroid > 0:
            centroids.append(centroid)

    return ClipMetrics(
        duration_s=round(duration_s, 4),
        speech_s=round(speech_s, 4),
        chars=round(float(chars), 2),
        # 完全没有人声时不能报一个「看起来正常」的语速，否则静音段会混过门禁
        chars_per_second=round(chars / duration_s, 3) if duration_s > 0 and speech_s > 0 else 0.0,
        chars_per_second_speech=round(chars / speech_s, 3) if speech_s > 0 else 0.0,
        max_internal_gap_ms=round(max_gap, 1),
        long_gaps=int(long_gaps),
        segments=len(runs),
        f0_hz=round(float(np.median(f0s)), 2) if f0s else 0.0,
        centroid_hz=round(float(np.median(centroids)), 2) if centroids else 0.0,
        rms=round(float(np.sqrt(float(np.mean(x.astype(np.float64) ** 2)))), 5),
        clip_ratio=round(float(np.mean(np.abs(x) >= 0.999)), 6),
    )


# ---------------------------------------------------------------------------
# 跨段 / 跨轮比较
# ---------------------------------------------------------------------------


def spread_pct(values: list[float]) -> float:
    """(max-min)/mean × 100；样本不足或均值为 0 时返回 0。"""
    clean = [v for v in values if math.isfinite(v) and v > 0]
    if len(clean) < 2:
        return 0.0
    mean = float(np.mean(clean))
    return round((max(clean) - min(clean)) / mean * 100.0, 2) if mean > 0 else 0.0


def drift_pct(a: float, b: float) -> float:
    """两值相对漂移百分比。"""
    if a <= 0 or b <= 0:
        return 0.0
    return round(abs(a - b) / ((a + b) / 2.0) * 100.0, 2)


def compare_stream_batch(chunks: list[bytes], batch: bytes) -> dict[str, Any]:
    """流式拼接 vs 整块合成。

    @param chunks 每块独立 WAV
    @param batch 同一文本的整块 WAV
    @returns 时长差、局部边界跳变比（最坏/中位/全局参考）、波形相关系数
    """
    decoded = [decode_wav(chunk) for chunk in chunks]
    if not decoded:
        return {"chunk_count": 0, "stream_duration_s": 0.0, "batch_duration_s": 0.0,
                "duration_delta_pct": 0.0, "boundary_jump_ratio": 0.0, "waveform_corr": 0.0}
    rate = decoded[0][1]
    parts = [part for part, _ in decoded]
    joined = np.concatenate(parts)
    bx, brate = decode_wav(batch)

    stream_s = joined.size / float(rate)
    batch_s = bx.size / float(brate)
    delta = abs(stream_s - batch_s) / batch_s * 100.0 if batch_s > 0 else 0.0

    # 块边界跳变：拼接点的一阶差分 / 该点附近 ±10ms 的一阶差分 P95。
    # 用**局部**基准而不是全信号 P95：真机实测全局判据在 0.059~2.267 之间
    # 随整体波形能量乱跳，局部判据稳定在 0.63~1.23（本来就是连续波形）。
    # 取最坏边界而非中位数：5 块里只要 1 个拼接点有 click 用户就能听出来。
    window = max(8, int(0.010 * rate))
    ratios: list[float] = []
    global_ratios: list[float] = []
    global_diff = np.abs(np.diff(joined))
    global_p95 = float(np.percentile(global_diff, 95)) if global_diff.size else 0.0
    pos = 0
    for part in parts[:-1]:
        pos += part.size
        if not 0 < pos < joined.size:
            continue
        jump = abs(float(joined[pos]) - float(joined[pos - 1]))
        lo = max(1, pos - window)
        hi = min(joined.size, pos + window)
        local = np.abs(np.diff(joined[lo:hi]))
        local_p95 = float(np.percentile(local, 95)) if local.size else 0.0
        if local_p95 > 0:
            ratios.append(jump / local_p95)
        if global_p95 > 0:
            global_ratios.append(jump / global_p95)
    ratio = float(np.max(ratios)) if ratios else 0.0
    median_ratio = float(np.median(ratios)) if ratios else 0.0
    global_ratio = float(np.max(global_ratios)) if global_ratios else 0.0

    # 波形相关只作参考指标：服务端流式与整块各自做 pace normalization，
    # 采样级未必逐点相等，但同文本、同音色时应高度相似。
    corr = 0.0
    if rate == brate and joined.size > 0 and bx.size > 0:
        n = min(joined.size, bx.size)
        a = joined[:n].astype(np.float64)
        b = bx[:n].astype(np.float64)
        if float(np.std(a)) > 1e-9 and float(np.std(b)) > 1e-9:
            corr = float(np.corrcoef(a, b)[0, 1])

    return {
        "chunk_count": len(chunks),
        "stream_duration_s": round(stream_s, 4),
        "batch_duration_s": round(batch_s, 4),
        "duration_delta_pct": round(delta, 2),
        "boundary_jump_ratio": round(ratio, 3),
        "boundary_jump_ratio_median": round(median_ratio, 3),
        "boundary_jump_ratio_global": round(global_ratio, 3),
        "waveform_corr": round(corr, 4),
    }


def summarize_rounds(rounds: list[dict[str, Any]]) -> dict[str, Any]:
    """把逐轮采集结果汇总成可对照阈值的指标集合。

    @param rounds 每轮含 text / batch(ClipMetrics dict) / stream(compare dict)
                  / timing 的字典
    @returns 汇总指标
    """
    batches = [r["batch"] for r in rounds]
    streams = [r["stream"] for r in rounds]
    rates = [float(b["chars_per_second"]) for b in batches if b["chars_per_second"] > 0]
    ttfa = [float(r["timing"]["stream_first_ms"]) for r in rounds]
    # 每字延迟：不同长度的文本 TTFA 本来就不一样，这个归一化值用来确认
    # 「变慢」不是因为后半段恰好分到了更长的句子。只作参考，不设门槛。
    per_char = [ms / max(1, len(str(r["text"]))) for r, ms in zip(rounds, ttfa)]

    # 同文本重复对照：按文本分组，取每组内首尾两次
    by_text: dict[str, list[dict[str, Any]]] = {}
    for round_item in rounds:
        by_text.setdefault(str(round_item.get("text", "")), []).append(round_item["batch"])
    same_f0: list[float] = []
    same_centroid: list[float] = []
    for group in by_text.values():
        if len(group) < 2:
            continue
        same_f0.append(drift_pct(group[0]["f0_hz"], group[-1]["f0_hz"]))
        same_centroid.append(drift_pct(group[0]["centroid_hz"], group[-1]["centroid_hz"]))

    # 「越聊越迟钝」：后半段 TTFA 均值 / 前半段，>1 表示在变慢
    growth = 0.0
    if len(ttfa) >= 4:
        half = len(ttfa) // 2
        head = float(np.mean(ttfa[:half]))
        tail = float(np.mean(ttfa[half:]))
        growth = (tail - head) / head * 100.0 if head > 0 else 0.0

    return {
        "rounds": len(rounds),
        "rate_spread_pct": spread_pct(rates),
        "rate_min": round(min(rates), 3) if rates else 0.0,
        "rate_max": round(max(rates), 3) if rates else 0.0,
        "max_internal_gap_ms": max((b["max_internal_gap_ms"] for b in batches), default=0.0),
        "long_gaps_total": sum(int(b["long_gaps"]) for b in batches),
        "f0_spread_pct": spread_pct([b["f0_hz"] for b in batches]),
        "centroid_spread_pct": spread_pct([b["centroid_hz"] for b in batches]),
        "same_text_f0_drift_pct": round(max(same_f0, default=0.0), 2),
        "same_text_centroid_drift_pct": round(max(same_centroid, default=0.0), 2),
        "stream_batch_duration_delta_pct": max(
            (s["duration_delta_pct"] for s in streams), default=0.0
        ),
        "boundary_jump_ratio": max((s["boundary_jump_ratio"] for s in streams), default=0.0),
        "min_stream_chunks": min((s["chunk_count"] for s in streams), default=0),
        "ttfa_growth_pct": round(growth, 2),
        "ttfa_per_char_spread_pct": spread_pct(per_char),
        "ttfa_head_ms": round(float(np.mean(ttfa[: len(ttfa) // 2])), 1) if ttfa else 0.0,
        "ttfa_tail_ms": round(float(np.mean(ttfa[len(ttfa) // 2 :])), 1) if ttfa else 0.0,
    }


def evaluate(summary: dict[str, Any], thresholds: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """按阈值判定，返回全部不达标项（空列表 = 通过）。

    「越大越坏」的指标用 <= 判定；`min_stream_chunks` 反过来用 >=。

    @param summary `summarize_rounds` 的输出
    @param thresholds 阈值（默认读外置 JSON）
    @returns 违规项列表
    """
    limits = thresholds or load_thresholds()
    violations: list[dict[str, Any]] = []
    for key, limit in limits.items():
        value = summary.get(key)
        if value is None:
            violations.append({"metric": key, "value": None, "limit": limit, "reason": "缺少指标"})
            continue
        ok = value >= limit if key == "min_stream_chunks" else value <= limit
        if not ok:
            violations.append({"metric": key, "value": value, "limit": limit, "reason": "超出阈值"})
    return violations
