#!/usr/bin/env python3
"""第十一轮一致性 A/B 探针：同一 sidecar、同一语料，三组请求级开关对照。

## 为什么不是 `perception_probe.py`

那个探针的对照组是「完全不对齐」（第九轮），用于证明第十轮有效。本轮的
对照组必须是**第十轮已经对齐后的状态**，否则量不出增量。三组定义：

| 组 | kweightedAlign | edgeAlign | 含义 |
|---|---|---|---|
| v1 | false | false | 第十轮基线（未加权 RMS 归一） |
| kw | true  | false | 只换成 K 加权感知响度口径 |
| v2 | true  | true  | 完整第十一轮（再加边界能量压缩） |

## 指标（口径与 perceptual_align.py 严格同源）

- `k_spread_db`：ITU-R BS.1770 K 加权有声帧 RMS 极差 —— **人耳感知响度**。
- `edge_step_db`：相邻块「前块段尾有声能量 → 后块段首有声能量」的 dB 台阶，
  用 `_edge_voiced_rms()` 段级绝对阈值测量；目标是让**台阶的离散度**下降，
  不是把自然句尾衰减压成零。
- `rms_spread_db`：未加权 RMS 极差，换口径后可能变大，**只打印不判定**。
- 逐块时长一致、削波不增加：硬约束。

`--check` 用相对对照判定，不设绝对阈值，也不改 longtext-thresholds.json。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import longtext_probe as lp  # noqa: E402
import perception_probe as pp  # noqa: E402
import perceptual_align as pa  # noqa: E402

MODES = ("v1", "kw", "v2")
DEFAULT_OUT = "/tmp/dcx-consistency-v2"


def payload(text: str, mode: str) -> dict:
    p = lp.tts_payload(text)
    # 三组都保持总对齐开启，只切第十一轮两个子开关
    p["perceptualAlign"] = True
    p["kweightedAlign"] = mode in ("kw", "v2")
    p["edgeAlign"] = mode == "v2"
    return p


def synth(text: str, mode: str) -> tuple[np.ndarray, int]:
    status, data, _ = lp.post("/tts/stream", payload(text, mode))
    if status != 200:
        raise RuntimeError(f"HTTP {status}: {data[:200]!r}")
    return lp.join_wavs(lp.split_stream_chunks(data))


def db(v: float) -> float:
    return 20 * math.log10(v) if v > 0 else -120.0


def spread_db(values: list[float]) -> float:
    clean = [v for v in values if v and math.isfinite(v) and v > 0]
    return round(max(20 * math.log10(v) for v in clean)
                 - min(20 * math.log10(v) for v in clean), 2) if len(clean) > 1 else 0.0


def spread_linear(values: list[float]) -> float:
    return round(max(values) - min(values), 2) if len(values) > 1 else 0.0


def features(x: np.ndarray, rate: int) -> dict[str, Any]:
    f = pp.features(x, rate)
    f["k_voiced"] = pa._kweighted_voiced_rms(x, rate)
    f["head"] = pa._edge_voiced_rms(x, rate, "head")
    f["tail"] = pa._edge_voiced_rms(x, rate, "tail")
    f["clip_ratio"] = round(float(np.mean(np.abs(x) >= 0.999)), 6)
    return f


def step_db(a: float | None, b: float | None) -> float | None:
    if not a or not b or a <= 0 or b <= 0:
        return None
    return round(20 * math.log10(b / a), 2)


def run_case(name: str, text: str, mode: str) -> dict[str, Any]:
    blocks = lp.frontend_blocks(text)
    feats: list[dict[str, Any]] = []
    durations: list[float] = []
    for block in blocks:
        x, rate = synth(block, mode)
        f = features(x, rate)
        if not f:
            raise RuntimeError(f"[{name}/{mode}] 空音频块：{block[:20]}")
        feats.append(f)
        durations.append(round(x.size / rate, 6))
    ks = [f["k_voiced"] for f in feats if f["k_voiced"]]
    rms = [f["rms_voiced"] for f in feats]
    steps = [s for s in (step_db(feats[i]["tail"], feats[i + 1]["head"])
                         for i in range(len(feats) - 1)) if s is not None]
    return {
        "mode": mode,
        "blocks": len(blocks),
        "durations_s": durations,
        "total_duration_s": round(sum(durations), 4),
        "k_spread_db": spread_db(ks),
        "rms_spread_db": spread_db(rms),
        "peak_spread_db": spread_db([f["peak"] for f in feats]),
        "ltas_spread_pct": [
            pp.spread_pct([f["ltas"][i] for f in feats]) for i in range(4)
        ],
        "edge_step_db": steps,
        "edge_step_spread_db": spread_linear(steps),
        "edge_step_abs_max_db": round(max((abs(s) for s in steps), default=0.0), 2),
        "clip_ratio": round(max(f["clip_ratio"] for f in feats), 6),
        "per_block": feats,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from-config", action="store_true", help="读取真实生产 engine/voice/speed")
    ap.add_argument("--cases", default="pure_cn,mixed_tech")
    ap.add_argument("--check", action="store_true", help="相对对照判定")
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    # fail loud：系统 python3 通常没有 scipy，K 加权全部退化成 None 会让
    # 三组指标都变成 0，既测不出差异也不该被当成 PASS。
    if not pa.K_WEIGHT_AVAILABLE:
        raise SystemExit(
            "K 加权不可用（缺 scipy）：请用 scripts/voice/.venv/bin/python "
            "运行本探针，不要用系统 python3"
        )

    cfg = lp.production_voice_config() if args.from_config else {
        "engine": lp.ENGINE, "voice": lp.VOICE, "speed": lp.SPEED,
    }
    lp.ENGINE, lp.VOICE, lp.SPEED = cfg["engine"], cfg["voice"], cfg["speed"]
    print(f"== 一致性三组 A/B：8791 / {lp.VOICE} / {lp.SPEED} ==")
    print(f"   K 加权可用: {pa.K_WEIGHT_AVAILABLE}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {"config": cfg, "k_weight_available": pa.K_WEIGHT_AVAILABLE,
                              "cases": {}}
    violations: list[str] = []

    for name in (s.strip() for s in args.cases.split(",") if s.strip()):
        if name not in lp.TEXTS:
            raise SystemExit(f"未知语料: {name}")
        text = lp.TEXTS[name]
        results: dict[str, Any] = {}
        for mode in MODES:
            results[mode] = run_case(name, text, mode)
            print(f"  [{name}] {mode} 完成", flush=True)
        report["cases"][name] = results

        v1, kw, v2 = results["v1"], results["kw"], results["v2"]
        print(f"\n  -- {name} --")
        print(f"    K 加权响度极差   v1={v1['k_spread_db']:5.2f}dB  "
              f"kw={kw['k_spread_db']:5.2f}dB  v2={v2['k_spread_db']:5.2f}dB  "
              f"Δ={v2['k_spread_db'] - v1['k_spread_db']:+.2f}")
        print(f"    边界台阶离散度   v1={v1['edge_step_spread_db']:5.2f}dB  "
              f"kw={kw['edge_step_spread_db']:5.2f}dB  v2={v2['edge_step_spread_db']:5.2f}dB  "
              f"Δ={v2['edge_step_spread_db'] - v1['edge_step_spread_db']:+.2f}")
        print(f"    边界台阶 |max|   v1={v1['edge_step_abs_max_db']:5.2f}dB  "
              f"v2={v2['edge_step_abs_max_db']:5.2f}dB")
        print(f"    LTAS 频带极差%   v1={v1['ltas_spread_pct']} -> v2={v2['ltas_spread_pct']}")
        rms_delta = v2["rms_spread_db"] - v1["rms_spread_db"]
        print(f"    观察项（不判定）：未加权 RMS 极差 {v1['rms_spread_db']:.2f} -> "
              f"{v2['rms_spread_db']:.2f}dB ({rms_delta:+.2f})，"
              f"峰值极差 {v1['peak_spread_db']:.2f} -> {v2['peak_spread_db']:.2f}dB")
        same_time = all(v1["durations_s"] == m["durations_s"] for m in (kw, v2))
        print(f"    逐块时长一致: {same_time} / 削波: v1={v1['clip_ratio']} "
              f"v2={v2['clip_ratio']}")

        if args.check:
            if v2["k_spread_db"] >= v1["k_spread_db"]:
                violations.append(f"{name}: K 加权响度极差未改善")
            if v2["edge_step_spread_db"] >= v1["edge_step_spread_db"]:
                violations.append(f"{name}: 边界台阶离散度未改善")
            if not same_time:
                violations.append(f"{name}: 三组逐块时长不一致")
            if v2["clip_ratio"] > v1["clip_ratio"]:
                violations.append(f"{name}: 引入削波")

    (out_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n报告：{out_dir / 'report.json'}")
    if args.check:
        if violations:
            for v in violations:
                print("  VIOLATION " + v)
            print("FAIL：存在未达标项")
            return 1
        print("PASS：两条语料的 K 加权响度极差与边界台阶离散度均改善，时长/削波零回归")
    return 0


if __name__ == "__main__":
    sys.exit(main())
