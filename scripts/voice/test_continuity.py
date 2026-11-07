"""语音连贯性分析内核的离线回归（纯合成信号，不需要 MLX / 不需要服务）

验证两件事，缺一不可：
1. 指标**能检出**真实故障（长静音、语速跳变、音色跳变、块边界 click、
   流式与整块不等价、TTFA 随轮次劣化）；
2. 指标**不误报**健康样本（否则门禁会变成噪声，迟早被人关掉）。

与 test_rate_normalize.py 一样用手写 check()，可直接
`python3 scripts/voice/test_continuity.py` 跑。
"""
import io
import math
import struct
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from continuity import (  # noqa: E402
    DEFAULT_THRESHOLDS,
    LONG_GAP_MS,
    analyze_clip,
    compare_stream_batch,
    decode_wav,
    drift_pct,
    evaluate,
    load_thresholds,
    spread_pct,
    split_stream_chunks,
    summarize_rounds,
)

SR = 24000
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(name)


def tone(seconds: float, freq: float = 220.0, amp: float = 0.5) -> np.ndarray:
    """带轻微包络的谐波音，纯稳态正弦会让自相关相似度退化。"""
    t = np.arange(int(seconds * SR)) / SR
    env = 0.75 + 0.25 * np.sin(2 * np.pi * 3 * t)
    base = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 2 * freq * t)
    return (base * env * amp).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def cat(*parts: np.ndarray) -> np.ndarray:
    return np.concatenate([np.asarray(p, dtype=np.float32).reshape(-1) for p in parts])


def wav(x: np.ndarray, rate: int = SR) -> bytes:
    """float32 → PCM16 WAV（与 sidecar encode_wav_bytes 同格式）。"""
    pcm = (np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0) * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())
    return buf.getvalue()


def framed_blob(blob: bytes) -> bytes:
    return struct.pack(">I", len(blob)) + blob


# 健康样本：三段 0.8s 人声 + 两段 0.2s 语义停顿 + 首尾机械 padding
CLEAN = cat(silence(0.1), tone(0.8), silence(0.2), tone(0.8), silence(0.2), tone(0.8), silence(0.08))
CLEAN_WAV = wav(CLEAN)
# 故障样本：中段塞 1.2s 空白（用户说的「讲了几句中间就断了」）
STALL = cat(silence(0.1), tone(0.8), silence(1.2), tone(0.8), silence(0.08))
STALL_WAV = wav(STALL)

print("=== WAV 解码与流式协议 ===")
x, rate = decode_wav(CLEAN_WAV)
check("采样率 24kHz", rate == SR, f"{rate}")
check("样本数与长度一致", x.size == CLEAN.size, f"{x.size} vs {CLEAN.size}")
check("幅值大致还原", abs(float(np.max(np.abs(x))) - float(np.max(np.abs(CLEAN)))) < 0.002)
check("空 WAV 不抛异常", decode_wav(wav(np.zeros(0, dtype=np.float32)))[0].size == 0)

parts = [wav(tone(0.3)), wav(tone(0.3, 180.0)), wav(tone(0.3, 260.0))]
stream = b"".join(framed_blob(p) for p in parts)
check("流式协议解析出 3 块", len(split_stream_chunks(stream)) == 3)
check("流式块字节逐块一致", split_stream_chunks(stream) == parts)
check("空流解析为 0 块", len(split_stream_chunks(b"")) == 0)
try:
    split_stream_chunks(b"\x00\x00\x00\x10abc")
    check("截断的长度头被拒绝", False, "未抛异常")
except ValueError:
    check("截断的长度头被拒绝", True)

print("\n=== 语速与静音间隙 ===")
clean = analyze_clip(CLEAN_WAV, 24)
stall = analyze_clip(STALL_WAV, 24)
check("健康样本语速在合理区间", 3.0 < clean.chars_per_second < 12.0, f"{clean.chars_per_second:.2f} 字/秒")
check("健康样本有声时长接近 2.4s", abs(clean.speech_s - 2.4) < 0.15, f"{clean.speech_s:.3f}s")
check(f"健康样本最长句内静音 < {LONG_GAP_MS}ms", clean.max_internal_gap_ms < LONG_GAP_MS,
      f"{clean.max_internal_gap_ms:.0f}ms")
check("健康样本无长静音", clean.long_gaps == 0, f"{clean.long_gaps}")
check("卡顿样本检出 1.2s 静音", stall.max_internal_gap_ms > 1100, f"{stall.max_internal_gap_ms:.0f}ms")
check("卡顿样本 long_gaps >= 1", stall.long_gaps >= 1, f"{stall.long_gaps}")
check("首/尾 padding 不算句内静音", clean.max_internal_gap_ms < 400, f"{clean.max_internal_gap_ms:.0f}ms")
padded = analyze_clip(wav(cat(CLEAN, silence(0.5))), 24)
check("尾音 padding 拉低整段语速但不改有声语速（双口径可分辨停顿变化）",
      padded.chars_per_second < clean.chars_per_second
      and abs(padded.chars_per_second_speech - clean.chars_per_second_speech) < 0.02,
      f"{clean.chars_per_second:.2f}→{padded.chars_per_second:.2f} / "
      f"有声 {clean.chars_per_second_speech:.2f}→{padded.chars_per_second_speech:.2f}")
silent_clip = analyze_clip(wav(silence(1.0)), 10)
check("纯静音段不产生除零，且不会被报成正常语速",
      silent_clip.chars_per_second == 0.0 and silent_clip.chars_per_second_speech == 0.0,
      f"{silent_clip.chars_per_second} / {silent_clip.chars_per_second_speech}")
slower = analyze_clip(wav(cat(silence(0.1), tone(1.6), silence(0.2), tone(1.6), silence(0.2), tone(1.6), silence(0.08))), 24)
check("同样字数音频拉长 → 语速下降", slower.chars_per_second < clean.chars_per_second * 0.6,
      f"{clean.chars_per_second:.2f} → {slower.chars_per_second:.2f}")

print("\n=== 音色特征 ===")
low = analyze_clip(wav(cat(silence(0.05), tone(1.0, 160.0), silence(0.05))), 10)
high = analyze_clip(wav(cat(silence(0.05), tone(1.0, 320.0), silence(0.05))), 10)
check("160Hz 基频估计正确", abs(low.f0_hz - 160.0) < 8.0, f"{low.f0_hz:.1f}Hz")
check("320Hz 基频估计正确", abs(high.f0_hz - 320.0) < 12.0, f"{high.f0_hz:.1f}Hz")
check("音色跳变在 F0 上可见", drift_pct(low.f0_hz, high.f0_hz) > 50.0,
      f"漂移 {drift_pct(low.f0_hz, high.f0_hz):.1f}%")
check("频谱质心随基频上升", high.centroid_hz > low.centroid_hz,
      f"{low.centroid_hz:.0f} → {high.centroid_hz:.0f}Hz")
repeat = analyze_clip(wav(cat(silence(0.05), tone(1.0, 160.0), silence(0.05))), 10)
check("同一波形重复合成特征完全一致", drift_pct(low.f0_hz, repeat.f0_hz) < 0.01
      and drift_pct(low.centroid_hz, repeat.centroid_hz) < 0.01)
check("削波比例可检出", analyze_clip(wav(np.ones(2400, dtype=np.float32)), 10).clip_ratio > 0.9)

print("\n=== 流式 / 整块等价与块边界 ===")
# 把同一段波形按等长切成 5 块，每块独立 WAV（模拟 /tts/stream）
chunk_samples = np.array_split(CLEAN, 5)
chunks = [wav(c) for c in chunk_samples]
good_cmp = compare_stream_batch(chunks, CLEAN_WAV)
check("拼接时长与整块一致", good_cmp["duration_delta_pct"] < 0.01, f"{good_cmp['duration_delta_pct']:.3f}%")
check("拼接波形与整块高度相关", good_cmp["waveform_corr"] > 0.99, f"{good_cmp['waveform_corr']:.4f}")
check("相位连续时最坏边界跳变比低于阈值 3", good_cmp["boundary_jump_ratio"] < 3.0,
      f"{good_cmp['boundary_jump_ratio']:.3f}")
check("块数正确", good_cmp["chunk_count"] == 5)
# 在第 2 块开头制造一个阶跃（模拟 click）
broken = list(chunk_samples)
broken[1] = broken[1].copy()
broken[1][0] = -0.95
bad_cmp = compare_stream_batch([wav(c) for c in broken], CLEAN_WAV)
check("块边界 click 被检出", bad_cmp["boundary_jump_ratio"] > good_cmp["boundary_jump_ratio"] * 3,
      f"{good_cmp['boundary_jump_ratio']:.3f} → {bad_cmp['boundary_jump_ratio']:.3f}")
check("少一块会被时长差检出", compare_stream_batch(chunks[:-1], CLEAN_WAV)["duration_delta_pct"] > 15.0)
check("空块列表返回安全默认值", compare_stream_batch([], CLEAN_WAV)["chunk_count"] == 0)

print("\n=== 汇总与阈值判定 ===")
check("spread_pct 过滤非正值", spread_pct([0.0, 0.0, 4.9]) == 0.0)
check("spread_pct 计算极差/均值", abs(spread_pct([4.8, 5.0]) - (0.2 / 4.9 * 100)) < 0.01)
check("drift_pct 对称", drift_pct(100.0, 120.0) == drift_pct(120.0, 100.0))
check("drift_pct 零值安全", drift_pct(0.0, 100.0) == 0.0)


def metric(chars_per_second: float, f0: float, centroid: float, gap: float) -> dict:
    return {
        "duration_s": 2.5, "speech_s": 2.4, "chars": 12,
        "chars_per_second": chars_per_second, "chars_per_second_speech": chars_per_second + 0.4,
        "max_internal_gap_ms": gap,
        "long_gaps": 0, "segments": 3, "f0_hz": f0, "centroid_hz": centroid,
        "rms": 0.2, "clip_ratio": 0.0,
    }


def round_item(text: str, rate: float, f0: float, gap: float, first_ms: float) -> dict:
    return {
        "text": text,
        "batch": metric(rate, f0, 900.0, gap),
        "stream": {
            "chunk_count": 5, "stream_duration_s": 2.5, "batch_duration_s": 2.5,
            "duration_delta_pct": 0.0, "boundary_jump_ratio": 0.3, "waveform_corr": 0.99,
        },
        "timing": {"stream_first_ms": first_ms, "batch_ms": 1800.0},
    }


healthy_rounds = [
    round_item("第一句文本。", 4.90, 210.0, 250.0, 400.0),
    round_item("第二句稍长一些的文本。", 4.92, 212.0, 300.0, 410.0),
    round_item("第三句文本。", 4.91, 208.0, 280.0, 420.0),
    round_item("第一句文本。", 4.93, 210.0, 260.0, 430.0),
]
good_summary = summarize_rounds(healthy_rounds)
check("健康会话所有阈值通过", evaluate(good_summary) == [], str(evaluate(good_summary)))
check("同文本重复 F0 漂移为 0", good_summary["same_text_f0_drift_pct"] == 0.0)
check("语速极差小于 1%", good_summary["rate_spread_pct"] < 1.0, f"{good_summary['rate_spread_pct']:.2f}%")
check("TTFA 增幅被量化", 0 < good_summary["ttfa_growth_pct"] < 10, f"{good_summary['ttfa_growth_pct']:.2f}%")

# 逐个注入故障，确认 evaluate 精确指出对应指标
cases = [
    ("语速跳变", lambda r: r[:1] + [round_item("跳变句。", 7.50, 210.0, 250.0, 410.0)] + r[2:], "rate_spread_pct"),
    ("句中长静音", lambda r: [round_item(t, 4.9, 210.0, 1500.0, 400.0) for t in ["甲。", "乙。", "丙。", "甲。"]], "max_internal_gap_ms"),
    ("音色跳脱", lambda r: r[:1] + [round_item("跳音色。", 4.9, 330.0, 250.0, 410.0)] + r[2:], "f0_spread_pct"),
    ("越聊越迟钝", lambda r: [round_item(t, 4.9, 210.0, 250.0, ms) for t, ms in
                        [("甲。", 400), ("乙。", 420), ("丙。", 1600), ("甲。", 1800)]], "ttfa_growth_pct"),
]
for label, mutate, expected in cases:
    bad = evaluate(summarize_rounds(mutate(healthy_rounds)))
    check(f"{label}被判定为不达标", any(v["metric"] == expected for v in bad), str(bad))

# 流式退化为 1 块、流式/整块不等价
broken_rounds = [dict(r, stream={**r["stream"], "chunk_count": 1, "duration_delta_pct": 12.0,
                                 "boundary_jump_ratio": 8.0}) for r in healthy_rounds]
broken_violations = evaluate(summarize_rounds(broken_rounds))
reported = {v["metric"] for v in broken_violations}
check("流式退化/不等价/边界 click 同时被报出",
      {"min_stream_chunks", "stream_batch_duration_delta_pct", "boundary_jump_ratio"} <= reported,
      str(sorted(reported)))
check("违规项带 value 与 limit", all("value" in v and "limit" in v for v in broken_violations))
check("外置阈值文件可加载", load_thresholds()["rate_spread_pct"] == 6.0)
check("内置默认阈值覆盖全部判定项", set(DEFAULT_THRESHOLDS) <= set(good_summary),
      str(set(DEFAULT_THRESHOLDS) - set(good_summary)))
check("所有指标可 JSON 序列化（无 NaN/Inf）",
      all(math.isfinite(float(v)) for v in good_summary.values() if isinstance(v, (int, float))))

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: {', '.join(FAILED)}")
    raise SystemExit(1)
print("ALL PASS")
