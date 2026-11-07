#!/usr/bin/env python3
"""短块语速偏差根因探针：区分「读得慢」与「静音占比大」。

只读真机采集 + 离线静音压缩模拟；不改服务端、不改判据、不放宽阈值。

用法：python3 scripts/voice/short_block_probe.py
产物：/tmp/dcx-chunking-ab/numxs/{report.json,*.wav}

`compress_simulation` 是**离线裁剪静音样本**的预估，不是服务端改完之后的实测：
真机上 WSOLA 变速与伺服的执行顺序会改变最终时长，落地前必须重新真机采集。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/voice"))
import longtext_probe as lp  # noqa: E402
import mixed_matrix_probe as mmp  # noqa: E402
import continuity as ct  # noqa: E402

OUT = Path("/tmp/dcx-chunking-ab/numxs")
OUT.mkdir(parents=True, exist_ok=True)


def silence_runs(x: np.ndarray, rate: int) -> list[tuple[int, int, float]]:
    frames, width, hop = ct._windows(x, rate)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    peak = float(rms.max())
    voiced = rms > peak * ct.SILENCE_RMS_RATIO if peak > 0 else np.zeros(rms.size, dtype=bool)
    runs = ct._voiced_runs(voiced)
    sample_runs = [(min(s * hop, x.size), min(e * hop + width - hop, x.size)) for s, e in runs]
    gaps = []
    for i in range(len(sample_runs) - 1):
        start, end = sample_runs[i][1], sample_runs[i + 1][0]
        if end > start:
            gaps.append((start, end, (end - start) / float(rate)))
    return gaps


def compress(x: np.ndarray, rate: int, max_gap_s: float) -> np.ndarray:
    """把所有超过 max_gap_s 的句内静音压到 max_gap_s（离线模拟，不是服务端行为）。"""
    gaps = silence_runs(x, rate)
    limit = int(max_gap_s * rate)
    pieces = []
    cursor = 0
    for start, end, _ in gaps:
        if end - start <= limit:
            continue
        pieces.append(x[cursor : start + limit])
        cursor = end
    pieces.append(x[cursor:])
    return np.concatenate(pieces) if pieces else x


def main() -> int:
    results = {}
    for cell in ("num:xs", "cn:xs", "code:xs"):
        kind, length = cell.split(":")
        text = mmp.matrix_text(kind, length)
        units = mmp.units_of(text)
        got = mmp.stream_request("/tts/stream", mmp.tts_payload(text))
        x, rate = mmp.wav_of(got["chunks"])
        wav = lp.to_wav(x, rate)
        m = ct.analyze_clip(wav, units)
        gaps = silence_runs(x, rate)
        (OUT / f"{kind}-{length}.wav").write_bytes(wav)
        sims = {}
        for cap in (0.45, 0.30, 0.20, 0.12):
            y = compress(x, rate, cap)
            dur = y.size / float(rate)
            sims[f"cap_{int(cap*1000)}ms"] = {
                "duration_s": round(dur, 3),
                "rate_units_s": round(units / dur, 3) if dur > 0 else 0.0,
                "bias_pct": round(abs(units / dur - 4.92) / 4.92 * 100, 2) if dur > 0 else 999.0,
            }
        results[cell] = {
            "text": text,
            "normalized": mmp.spoken(text),
            "units": round(units, 2),
            "duration_s": m.duration_s,
            "speech_s": m.speech_s,
            "rate_whole": m.chars_per_second,
            "rate_speech_only": m.chars_per_second_speech,
            "bias_pct": round(abs(m.chars_per_second - 4.92) / 4.92 * 100, 2),
            "max_internal_gap_ms": m.max_internal_gap_ms,
            "gap_runs": [round(g[2] * 1000, 1) for g in gaps],
            "gap_total_s": round(sum(g[2] for g in gaps), 3),
            "compress_simulation": sims,
            "http": got["http"],
            "chunk_count": got["chunk_count"],
            "ttfa_ms": got["ttfa_ms"],
        }
        print(f"\n=== {cell} | {text} ===")
        print(f"  规范化: {mmp.spoken(text)}")
        print(f"  {units:.2f}单元 整段 {m.duration_s:.3f}s 有声 {m.speech_s:.3f}s "
              f"整段语速 {m.chars_per_second:.3f} 有声语速 {m.chars_per_second_speech:.3f} "
              f"偏差 {results[cell]['bias_pct']:.2f}%")
        print(f"  句内静音段(ms) {[round(g[2]*1000) for g in gaps]} 合计 {sum(g[2] for g in gaps):.3f}s "
              f"最长 {m.max_internal_gap_ms:.0f}ms")
        for k, v in sims.items():
            print(f"  模拟压到 {k:12s} → {v['duration_s']:.3f}s / {v['rate_units_s']:.3f}u/s / 偏差 {v['bias_pct']:.2f}%")
    (OUT / "report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
