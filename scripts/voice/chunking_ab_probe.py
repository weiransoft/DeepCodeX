#!/usr/bin/env python3
"""结构感知分块 A/B 探针（只读，不参与生产链路）。

对照组 = `longtext_probe.frontend_blocks(text, atomic=False)`（031f1cc2 原实现）。
实验组 = `longtext_probe.frontend_blocks(text, atomic=True)`（2026-11-07 P0 落地实现）。

**2026-11-07 更新**：P0 已落地到前端 TS / 服务端 / 门禁探针，本文件不再自带
第二份切分算法，改为复用 `longtext_probe` 的**唯一权威实现**，避免出现两份
会漂移的「前端复刻」。真机指标沿用 `mixed_matrix_probe.run_cell()` 的全部
口径（同一阈值、同一语料、同一 sidecar），只替换切块函数。

用法：
  python3 scripts/voice/chunking_ab_probe.py --offline --cells code:xl,plain:xl
  python3 scripts/voice/chunking_ab_probe.py --cells code:xl,plain:xl \
      --modes baseline,atomic --out /tmp/dcx-chunking-ab/run

注意：本探针是「Python 复刻前端切分 + 直连 sidecar」，**不等于桌面 WebView
已生效**。生产态还需前端偏好 `dcx.voice.atomicChunk.v1` 与服务端
`DCX_VOICE_ATOMIC_CHUNK=1` 同时打开（二者默认均关）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/voice"))
import longtext_probe as lp  # noqa: E402
import mixed_matrix_probe as mmp  # noqa: E402
from atomic_chunks import atomic_spans, nearest_ok_cut  # noqa: E402
from mlx_voice_server import speech_units  # noqa: E402

ORIGINAL = lp.frontend_blocks


def atomic_firstshort(text: str) -> list[str]:
    """P1 实验（默认关、不进生产）：在 atomic 基础上把无标点长串首块压到 ≤20 字。

    调研报告 §5 的 `atomic_firstshort` 是「首轮实验实现」；这里按 P0 落地后的
    单一实现重做（先取 atomic 分块，再对首块二次切分），数字只作趋势 A/B，
    不作为门禁依据。历史数值见 `tns-residual-fix-research-2026-11-07.md`。
    """
    blocks = ORIGINAL(text, atomic=True)
    if not blocks or len(blocks[0]) <= 20:
        return blocks
    head = blocks[0]
    spans = atomic_spans(head)
    cut = nearest_ok_cut(spans, 20, 10)
    if cut <= 0 or cut >= len(head):
        return blocks
    tail = lp.split_long_atomic(head[cut:])
    parts = [head[:cut]] + tail + blocks[1:]
    # 二次切分不能留下 <10 单元的非首块；保持原有护栏语义。
    merged: list[str] = []
    for part in parts:
        if merged and speech_units(part) < lp.MIN_BLOCK_UNITS:
            balanced = lp.rebalance_tail_safe(merged[-1], part, lp.MIN_BLOCK_UNITS, lp.MAX_BLOCK_CHARS)
            merged[-1] = balanced[0]
            part = balanced[1] if len(balanced) > 1 else ""
            if not part:
                continue
        merged.append(part)
    return merged


VARIANTS = {
    "baseline": lambda t: ORIGINAL(t, atomic=False),
    "atomic": lambda t: ORIGINAL(t, atomic=True),
    "atomic_firstshort": atomic_firstshort,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cells", default="code:xl,plain:xl")
    ap.add_argument("--modes", default="baseline,atomic")
    ap.add_argument("--offline", action="store_true", help="只做离线切分对比，不请求 sidecar")
    ap.add_argument("--out", default="/tmp/dcx-chunking-ab/run")
    args = ap.parse_args()
    cells = [c.strip() for c in args.cells.split(",") if c.strip()]
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    for mode in modes:
        if mode not in VARIANTS:
            raise SystemExit(f"unknown mode: {mode}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    offline = {}
    for cell in cells:
        text = mmp.matrix_text(*cell.split(":"))
        offline[cell] = {
            name: lp.split_quality(text, VARIANTS[name](text))
            for name in modes
        }
        (out / "split-quality.json").write_text(
            json.dumps(offline, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n=== {cell} 离线切分 ===")
        for name, q in offline[cell].items():
            print(
                f"  {name:20s} 块={q['block_count']:3d} 可逆={q['reversible']} "
                f"切断原子={q['broken_atom_boundaries']:2d} 最长={q['max_chars']:3d}字 "
                f"最短非首块={q['min_nonfirst_units']:.1f}单元"
            )
            for ex in q["broken_examples"][:3]:
                print(f"      ✗ #{ex['boundary']} …{ex['context']}…")

    if args.offline:
        return 0

    summary = {}
    for cell in cells:
        for mode in modes:
            # run_cell 内部调用 lp.frontend_blocks(text, atomic=None)；临时替换
            # 即可在不改矩阵探针的前提下做同机同语料 A/B。
            lp.frontend_blocks = lambda t, atomic=None, _m=mode: VARIANTS[_m](t)
            t0 = time.time()
            try:
                result = mmp.run_cell(*cell.split(":"), False)
            finally:
                lp.frontend_blocks = ORIGINAL
            key = f"{cell}-{mode}"
            (out / f"{key}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            summary[key] = {
                "block_count": result["block_count"],
                "collection_ok": result["collection_ok"],
                "reversible": result["reversible"],
                "rate_median": result["rate"]["median_units_s"],
                "rate_bias_pct": result["rate"]["bias_pct"],
                "rate_spread_pct": result["rate"]["block_spread_pct"],
                "f0_spread_pct": result["timbre"]["block_f0_spread_pct"],
                "first_block_ttfa_ms": result["speed"]["first_block_ttfa_ms"],
                "ttfa_p95_ms": result["speed"]["ttfa_p95_ms"],
                "max_internal_gap_ms": result["fluency"]["max_internal_gap_ms"],
                "inter_block_silence_max_ms": result["fluency"]["inter_block_silence_max_ms"],
                "min_nonfirst_units": result["fluency"]["min_nonfirst_units"],
                "rtf": result["speed"]["rtf"],
                "audio_duration_s": result["speed"]["audio_duration_s"],
                "elapsed_s": round(time.time() - t0, 1),
            }
            (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
            print(
                f"\n>>> {key}: 块间语速极差 {summary[key]['rate_spread_pct']:.2f}% "
                f"TTFA首块 {summary[key]['first_block_ttfa_ms']:.0f}ms "
                f"P95 {summary[key]['ttfa_p95_ms']:.0f}ms "
                f"最长静音 {summary[key]['max_internal_gap_ms']:.0f}ms "
                f"采集OK={summary[key]['collection_ok']} 可逆={summary[key]['reversible']}",
                flush=True,
            )
    print("\n=== 汇总 ===")
    for key, s in summary.items():
        print(
            f"  {key:32s} 块={s['block_count']:3d} 语速极差={s['rate_spread_pct']:6.2f}% "
            f"F0极差={s['f0_spread_pct']:6.2f}% 首块TTFA={s['first_block_ttfa_ms']:6.0f}ms "
            f"静音={s['max_internal_gap_ms']:5.0f}ms 音频={s['audio_duration_s']:6.1f}s"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
