"""第十三轮：WSOLA 谱补偿真机 A/B（同一 sidecar，只切请求级开关）。

对照组 `{"wsolaCompensation": false}`，实验组走默认。两组文本、音色、语速、
切分完全相同，唯一差别是有没有补偿 WSOLA 变速的确定性高频衰减。

判定核心不是「块间谱极差变小」——那段差异主要来自文本音素，倍率只是叠加项。
这里验证的是**配对差值**：同一块 on/off 的频带能量变化，减去低频带的公共
标量增益后，应与按倍率查标定表预测的补偿量一致。这样既证明服务端确实按
「只依赖倍率」的曲线生效，也不受 align_loudness 的整体增益干扰。

观察项（不判定、强制打印）：块间谱质心极差、有声段单元语速极差、整块语速
极差、频带能量对倍率的回归斜率。
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

import longtext_probe as lp  # noqa: E402
import wsola_compensation as wc  # noqa: E402

RATE = 24000
BANDS = wc.BAND_EDGES
WIN, HOP = int(RATE * 0.04), int(RATE * 0.02)
LOG = os.path.expanduser("~/.deepcode/logs/voice.log")


def decode(blob: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(blob), "rb") as w:
        assert w.getframerate() == RATE, w.getframerate()
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def features(x: np.ndarray) -> dict:
    frames = [x[i : i + WIN] for i in range(0, max(0, x.size - WIN), HOP)]
    rms = np.array([float(np.sqrt(np.mean(f**2))) for f in frames]) if frames else np.array([0.0])
    thr = float(np.max(rms)) * 0.01 if rms.size else 0.0
    voiced = int((rms > thr).sum())
    acc = np.zeros(4)
    cents = []
    for f, r in zip(frames, rms):
        if r <= thr:
            continue
        spec = np.abs(np.fft.rfft(f * np.hanning(f.size)))
        freq = np.fft.rfftfreq(f.size, 1 / RATE)
        for b in range(4):
            acc[b] += float(np.sum(spec[(freq >= BANDS[b]) & (freq < BANDS[b + 1])]))
        cents.append(float(np.sum(spec * freq) / (np.sum(spec) or 1e-9)))
    return {
        "band": acc / max(voiced, 1),
        "centroid": float(np.median(cents)) if cents else 0.0,
        "voiced_s": voiced * HOP / RATE,
        "dur": x.size / RATE,
        "peak": float(np.max(np.abs(x))) if x.size else 0.0,
        "clip": float(np.mean(np.abs(x) > 0.999)) if x.size else 0.0,
    }


def log_line_count() -> int:
    if not os.path.exists(LOG):
        return 0
    with open(LOG, errors="replace") as f:
        return sum(1 for _ in f)


def read_from(n: int) -> list[str]:
    if not os.path.exists(LOG):
        return []
    with open(LOG, errors="replace") as f:
        return f.readlines()[n:]


def servo_ratio(new_lines: list[str], fallback: float) -> float:
    """解析本次请求打印的所有段倍率，取均值。未打印说明全部贴近 speed。"""
    for line in reversed(new_lines):
        m = re.search(r"语速伺服 \d+段 倍率 ([0-9.,]+)", line)
        if m:
            vals = [float(v) for v in m.group(1).split(",") if v]
            if vals:
                return sum(vals) / len(vals)
    return fallback


def spread_pct(vals: list[float]) -> float:
    v = [x for x in vals if x and x > 0]
    return round(100 * (max(v) - min(v)) / (sum(v) / len(v)), 2) if len(v) > 1 else 0.0


def slope(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 3 or np.std(xs) < 1e-6:
        return 0.0
    return float(np.polyfit(xs, ys, 1)[0])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-config", action="store_true", help="读真实生产 engine/voice/speed")
    ap.add_argument("--cases", default="pure_cn,mixed_tech")
    ap.add_argument("--check", action="store_true", help="启用判定，失败返回非零")
    ap.add_argument("--out", default="/tmp/dcx-spectral-ab")
    args = ap.parse_args()

    cfg = lp.production_voice_config() if args.from_config else {
        "engine": lp.ENGINE, "voice": lp.VOICE, "speed": lp.SPEED,
    }
    lp.ENGINE, lp.VOICE, lp.SPEED = cfg["engine"], cfg["voice"], cfg["speed"]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"== WSOLA 谱补偿 A/B：8791 / {lp.VOICE[:12]}… / {lp.SPEED} ==")

    report: dict = {"config": cfg, "cases": {}}
    violations: list[str] = []
    for name in [s.strip() for s in args.cases.split(",") if s.strip()]:
        if name not in lp.TEXTS:
            violations.append(f"{name}: 未知语料")
            continue
        text = lp.TEXTS[name]
        blocks = lp.frontend_blocks(text)
        sides: dict[str, list[dict]] = {"off": [], "on": []}
        for side, extra in (("off", {"wsolaCompensation": False}), ("on", {})):
            for i, block in enumerate(blocks):
                before = log_line_count()
                st, blob, _ = lp.post("/tts", {**lp.tts_payload(block), **extra})
                ratio = servo_ratio(read_from(before), cfg["speed"])
                if st != 200:
                    violations.append(f"{name}/{side} 块{i:02d} HTTP {st}")
                    continue
                x = decode(blob)
                f = features(x)
                np.save(out / f"{name}-{side}-{i:02d}.npy", x)
                units = lp.speech_units(lp.spoken(block))
                sides[side].append({
                    "i": i, "chars": len(block), "text": block[:22],
                    "units": round(units, 2), "ratio": round(ratio, 3),
                    "ups": round(units / f["dur"], 3) if f["dur"] else 0.0,
                    "voiced_ups": round(units / f["voiced_s"], 3) if f["voiced_s"] else 0.0,
                    "band": [round(float(v), 6) for v in f["band"]],
                    "centroid": round(f["centroid"], 1),
                    "dur": round(f["dur"], 4),
                    "peak": round(f["peak"], 4),
                    "clip": f["clip"],
                })
            print(f"  [{name}] {side} 组完成 {len(sides[side])} 块")

        off, on = sides["off"], sides["on"]
        if len(off) != len(on):
            violations.append(f"{name}: 两组块数不同 {len(off)}/{len(on)}")
            continue

        # 配对差值：减去 band0 的公共标量增益，消除 align_loudness 与峰值收缩
        deltas: list[list[float]] = []
        preds: list[list[float]] = []
        for a, b in zip(off, on):
            d = [20 * math.log10(max(b["band"][k], 1e-9) / max(a["band"][k], 1e-9)) for k in range(4)]
            deltas.append([d[k] - d[0] for k in range(4)])
            p = wc.band_compensation_db(b["ratio"])
            preds.append([p[k] - p[0] for k in range(4)])

        print(f"  [{name}] 倍率范围 {min(r['ratio'] for r in on):.2f}~{max(r['ratio'] for r in on):.2f}")
        for k in (1, 2, 3):
            got = float(np.mean([d[k] for d in deltas]))
            want = float(np.mean([p[k] for p in preds]))
            err = abs(got - want)
            print(f"    频带{k} ({BANDS[k]//1000}-{BANDS[k+1]//1000}k) 实测补偿 {got:+.2f}dB / 预测 {want:+.2f}dB / 误差 {err:.2f}dB")
            if err > 1.0:
                violations.append(f"{name}: 频带{k} 实测补偿与预测偏差 {err:.2f}dB > 1.0dB")

        for key, idx in (("centroid", None),):
            vals_o = [r[key] for r in off]
            vals_n = [r[key] for r in on]
            print(f"    观察项 谱质心极差 {spread_pct(vals_o):.2f}% → {spread_pct(vals_n):.2f}%")
        for key in ("ups", "voiced_ups"):
            vals_o = [r[key] for r in off]
            vals_n = [r[key] for r in on]
            print(f"    观察项 {key:<11} 极差 {spread_pct(vals_o):.2f}% → {spread_pct(vals_n):.2f}%")

        same_time = all(a["dur"] == b["dur"] for a, b in zip(off, on))
        clip_ok = all(b["clip"] <= a["clip"] + 1e-9 for a, b in zip(off, on))
        ups_o = spread_pct([r["ups"] for r in off])
        ups_n = spread_pct([r["ups"] for r in on])
        print(f"    逐块时长一致 {same_time} / 未新增削波 {clip_ok} / 整块语速极差 {ups_o:.2f}% → {ups_n:.2f}%")
        if not same_time:
            violations.append(f"{name}: 补偿改变了音频时长")
        if not clip_ok:
            violations.append(f"{name}: 补偿引入削波")
        if abs(ups_n - ups_o) > 0.5:
            violations.append(f"{name}: 语速极差变化 {ups_o:.2f}%→{ups_n:.2f}% 超过 0.5%")

        for k in (1, 2, 3):
            so = slope([r["ratio"] for r in off], [20 * math.log10(max(r["band"][k], 1e-9)) for r in off])
            sn = slope([r["ratio"] for r in on], [20 * math.log10(max(r["band"][k], 1e-9)) for r in on])
            print(f"    观察项 频带{k} 能量~倍率斜率 {so:+.2f} → {sn:+.2f} dB/倍率")

        report["cases"][name] = sides

    with open(out / "report.json", "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n报告 {out}/report.json")
    if args.check:
        if violations:
            print(f"FAIL：{len(violations)} 项")
            for v in violations:
                print(f"  - {v}")
            return 1
        print("PASS：补偿量与倍率标定一致，时长/削波/语速零回归")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
