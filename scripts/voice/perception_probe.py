#!/usr/bin/env python3
"""感知域 A/B 探针：同一 sidecar、同一语料，只切请求级 `perceptualAlign`。

## 为什么单独做一个探针

`longtext_probe.py --check` 的门禁指标（单元语速、F0、静音）第十轮之前就已
达标，但人耳仍能听出块间差异。真机实测差异集中在**响度与长时平均谱**上：
语速极差 0.69% 的同时，有声帧响度极差 3.77dB、1-3k 频带占比极差 174%。

本探针用「剔除文本」的方式量化这两项，并做开/关对照：
- 对照组：`{"perceptualAlign": false}`，等价于第九轮行为；
- 实验组：服务端默认（段级感知对齐开启）。

只做测量与落盘，不改仓库文件。`--check` 用**相对对照**判定，不设绝对阈值：
实验组的有声帧响度极差必须小于对照组，各 LTAS 频带极差均需改善，且逐块
时长完全一致、不新增削波。峰值极差与边界台阶属于观察项（对齐按 RMS 归一，
不按峰值；句尾自然衰减也不是本轮目标），不判定但强制打印，退化时显式标注。

用法：
    python3 scripts/voice/perception_probe.py --from-config
    python3 scripts/voice/perception_probe.py --from-config --cases pure_cn,mixed_tech --check
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import longtext_probe as lp  # noqa: E402
from continuity import SILENCE_RMS_RATIO, _windows  # noqa: E402

# 与 perceptual_align.py 的频带划分一致
BANDS = (0, 1000, 3000, 8000, 12000)


def payload(text: str, align: bool) -> dict:
    p = lp.tts_payload(text)
    p["perceptualAlign"] = align
    return p


def synth(text: str, align: bool) -> tuple[np.ndarray, int]:
    status, data, _ = lp.post("/tts/stream", payload(text, align))
    if status != 200:
        raise RuntimeError(f"HTTP {status}: {data[:200]!r}")
    return lp.join_wavs(lp.split_stream_chunks(data))


def db(v: float) -> float:
    return 20 * math.log10(v) if v > 0 else -120.0


def spread_db(values: list[float]) -> float:
    clean = [db(v) for v in values if math.isfinite(v) and v > 0]
    return round(max(clean) - min(clean), 2) if len(clean) > 1 else 0.0


def spread_pct(values: list[float]) -> float:
    mean = sum(values) / len(values)
    return round((max(values) - min(values)) / mean * 100, 2) if mean > 0 else 0.0


def features(x: np.ndarray, rate: int) -> dict[str, Any]:
    """有声帧响度 + 四频带长时平均谱（口径与 continuity.py 一致）。"""
    frames, width, _ = _windows(x, rate)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    peak = float(rms.max()) if rms.size else 0.0
    voiced = rms > peak * SILENCE_RMS_RATIO if peak > 0 else np.zeros(rms.size, dtype=bool)
    vf = frames[voiced]
    if vf.size == 0:
        return {}
    spec = np.abs(np.fft.rfft(vf * np.hanning(width).astype(np.float32), axis=1)).mean(axis=0)
    freqs = np.fft.rfftfreq(width, d=1.0 / rate)
    energy = spec.astype(np.float64) ** 2
    bands = [
        float(energy[(freqs >= lo) & (freqs < hi)].sum())
        for lo, hi in zip(BANDS[:-1], BANDS[1:])
    ]
    total = sum(bands) or 1.0
    return {
        "rms_all": round(float(np.sqrt(float(np.mean(x.astype(np.float64) ** 2)))), 6),
        "rms_voiced": round(float(np.median(rms[voiced])), 6),
        "peak": round(float(np.max(np.abs(x))), 6),
        "ltas": [round(b / total, 5) for b in bands],
    }


def boundary_steps(full: np.ndarray, rate: int, bounds: list[int]) -> list[float]:
    """边界前后 100ms 的有声样本 RMS 差（dB）。

    阈值取全局绝对分位，不用窗口相对峰值——后者会把「几乎全静音的 100ms」
    里的噪声当成有声，算出 25dB 的测量伪影。
    """
    thr = float(np.percentile(np.abs(full), 99)) * 0.02
    win = int(0.1 * rate)
    out: list[float] = []
    for pos in bounds[1:]:
        before = np.abs(full[max(0, pos - win) : pos])
        after = np.abs(full[pos : pos + win])
        vb, va = before[before > thr], after[after > thr]
        if vb.size < 100 or va.size < 100:
            continue
        rb = float(np.sqrt((vb.astype(np.float64) ** 2).mean()))
        ra = float(np.sqrt((va.astype(np.float64) ** 2).mean()))
        out.append(round(db(ra) - db(rb), 2))
    return out


def run_case(name: str, text: str, align: bool) -> dict[str, Any]:
    blocks = lp.frontend_blocks(text)
    feats: list[dict[str, Any]] = []
    waves: list[np.ndarray] = []
    bounds: list[int] = []
    durations: list[float] = []
    cursor = 0
    rate = 24000
    for block in blocks:
        x, rate = synth(block, align)
        f = features(x, rate)
        if not f:
            raise RuntimeError(f"[{name}] 出现空音频块：{block[:20]}")
        feats.append(f)
        durations.append(round(x.size / rate, 4))
        bounds.append(cursor)
        waves.append(x)
        cursor += x.size
    full = np.concatenate(waves)
    steps = boundary_steps(full, rate, bounds)
    return {
        "name": name,
        "align": align,
        "blocks": len(blocks),
        "durations_s": durations,
        "total_duration_s": round(full.size / rate, 4),
        "rms_voiced_spread_db": spread_db([f["rms_voiced"] for f in feats]),
        "rms_all_spread_db": spread_db([f["rms_all"] for f in feats]),
        "peak_spread_db": spread_db([f["peak"] for f in feats]),
        "ltas_spread_pct": [spread_pct([f["ltas"][i] for f in feats]) for i in range(4)],
        "rms_voiced_vals": [round(f["rms_voiced"], 6) for f in feats],
        "boundary_step_db": steps,
        "boundary_step_abs_max_db": round(max((abs(v) for v in steps), default=0.0), 2),
        "clip_ratio": round(float(np.mean(np.abs(full) >= 0.999)), 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="感知域 A/B（响度 / 长时平均谱）")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--from-config", action="store_true", help="按生产 voice/engine/speed 跑")
    parser.add_argument("--voice", default=None)
    parser.add_argument("--speed", type=float, default=None)
    parser.add_argument("--cases", default="pure_cn")
    parser.add_argument("--out", default="/tmp/dcx-perception-ab")
    parser.add_argument("--check", action="store_true", help="相对对照判定（无绝对阈值）")
    args = parser.parse_args()

    lp.PORT = args.port
    if args.from_config:
        cfg = lp.production_voice_config()
        lp.ENGINE, lp.VOICE, lp.SPEED = cfg["engine"], cfg["voice"], cfg["speed"]
    if args.voice is not None:
        lp.VOICE = args.voice
    if args.speed is not None:
        lp.SPEED = args.speed
    lp.TNS = True
    lp.PERCEPTUAL_ALIGN = True  # 由每次请求的 payload 显式控制，不受全局影响
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    selected = [s.strip() for s in args.cases.split(",") if s.strip()]
    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "port": lp.PORT,
        "voice": lp.VOICE,
        "speed": lp.SPEED,
        "cases": [],
    }
    violations: list[str] = []
    print(f"== 感知域 A/B：{lp.PORT} / {lp.VOICE} / {lp.SPEED} ==")
    for name in selected:
        if name not in lp.TEXTS:
            print(f"!! 未知语料 {name}")
            continue
        text = lp.TEXTS[name]
        off = run_case(name, text, False)
        print(f"  [{name}] 对照组完成", flush=True)
        on = run_case(name, text, True)
        print(f"  [{name}] 实验组完成", flush=True)
        report["cases"].append({"name": name, "off": off, "on": on})

        def row(label: str, key: str, unit: str = "") -> None:
            a, b = off[key], on[key]
            print(f"    {label:<24} off={a:>8.2f}{unit}  on={b:>8.2f}{unit}  Δ={b - a:+.2f}")

        row("有声帧响度极差", "rms_voiced_spread_db", "dB")
        row("整段响度极差", "rms_all_spread_db", "dB")
        row("峰值极差", "peak_spread_db", "dB")
        print(f"    {'LTAS 频带极差%':<24} off={off['ltas_spread_pct']} -> on={on['ltas_spread_pct']}")
        print(f"    {'边界台阶最大':<24} off={off['boundary_step_abs_max_db']}dB -> on={on['boundary_step_abs_max_db']}dB")
        same_time = off["durations_s"] == on["durations_s"]
        print(f"    逐块时长一致: {same_time} / 削波: off={off['clip_ratio']} on={on['clip_ratio']}")
        # 观察项不判定，但必须显式打印：峰值按 RMS 归一而非峰值归一，中英混排
        # 下可能略退化；边界台阶反映句尾自然衰减，不是本次修复目标。
        peak_delta = on["peak_spread_db"] - off["peak_spread_db"]
        step_delta = on["boundary_step_abs_max_db"] - off["boundary_step_abs_max_db"]
        flag = "  ← 略退化（观察项，不隐藏）" if peak_delta > 0 or step_delta > 0 else ""
        print(
            f"    观察项（不判定）：峰值极差 {peak_delta:+.2f}dB，"
            f"边界台阶 {step_delta:+.2f}dB{flag}"
        )

        if args.check:
            if on["rms_voiced_spread_db"] >= off["rms_voiced_spread_db"]:
                violations.append(f"{name}: 响度极差未改善")
            if not same_time:
                violations.append(f"{name}: 对齐改变了音频时长")
            if on["clip_ratio"] > off["clip_ratio"]:
                violations.append(f"{name}: 对齐引入削波")
            if any(o >= f for o, f in zip(on["ltas_spread_pct"], off["ltas_spread_pct"])):
                violations.append(f"{name}: 存在 LTAS 频带极差未改善")

    path = out_dir / f"report-{lp.PORT}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告：{path}")
    if args.check:
        if violations:
            print(f"FAIL：{len(violations)} 项")
            for item in violations:
                print(f"  - {item}")
            return 1
        print(
            f"PASS：{len(report['cases'])} 条语料的核心感知指标（响度 / LTAS）均改善，"
            "时长与削波零回归；峰值极差与边界台阶为观察项，未纳入判定，退化值见上方输出"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
