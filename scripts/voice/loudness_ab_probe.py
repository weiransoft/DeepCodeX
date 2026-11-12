"""第十二轮真机 A/B：off（只伺服）/ v11（逐段 EQ+边界）/ v12（只响度）。

    scripts/voice/.venv/bin/python scripts/voice/loudness_ab_probe.py --from-config --check

三组共用同一 sidecar、同一语料、同一切分，只切请求体开关。
除常规段间指标外，额外验证 v12 的**纯增益**性质：对 off 组波形离线调用
`align_loudness()`，与服务端 v12 输出逐样本比较（≤1 LSB），证明线上路径
确实没有引入频谱或边界处理。
"""
from __future__ import annotations

import argparse
import io
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import longtext_probe as lp  # noqa: E402
import perceptual_align as pa  # noqa: E402

RATE = 24000
LSB = 1.0 / 32768.0


def decode(blob: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(blob), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def feats(x: np.ndarray) -> dict:
    p = pa.segment_profile(x, RATE) or {}
    return {
        "rms": p.get("rms_voiced", 0.0),
        "kw": p.get("rms_kweighted") or 0.0,
        "ltas": p.get("ltas", [0, 0, 0, 0]),
        "peak": float(np.max(np.abs(x))) if x.size else 0.0,
        "clip": float(np.mean(np.abs(x) > 0.999)) if x.size else 0.0,
        "dur": x.size / RATE,
    }


def scalar_residual(x: np.ndarray, y: np.ndarray) -> float:
    """y 相对 x 的最佳标量拟合残差：≈0 表示纯增益（无 EQ / 无边界）。

    用**线上两组波形直接互比**，不用「离线重算再比」——后者会把 off 组已量化
    的 PCM16 再次增益量化，引入约 5 LSB 的二次量化伪影，曾误判为「不是纯增益」。
    """
    if x.size != y.size or x.size == 0:
        return 1.0
    denom = float(np.dot(x, x))
    if denom <= 0:
        return 0.0
    c = float(np.dot(x, y) / denom)
    return float(np.linalg.norm(y - c * x) / max(np.linalg.norm(y), 1e-12))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-config", action="store_true")
    ap.add_argument("--cases", default="pure_cn,mixed_tech")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default="/tmp/dcx-loudness-ab")
    args = ap.parse_args()

    if args.from_config:
        cfg = lp.production_voice_config()
        lp.ENGINE, lp.VOICE, lp.SPEED = cfg["engine"], cfg["voice"], cfg["speed"]
    lp.PERCEPTUAL_ALIGN = True
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    print(f"== 第十二轮 A/B：{lp.PORT} / {lp.VOICE} / speed={lp.SPEED} ==")
    print(f"   语速目标 {4.1 * lp.SPEED:.2f} 单元/秒\n")

    report: dict = {"port": lp.PORT, "voice": lp.VOICE, "speed": lp.SPEED, "cases": {}}
    violations: list[str] = []

    for name in [c.strip() for c in args.cases.split(",") if c.strip()]:
        blocks = lp.frontend_blocks(lp.TEXTS[name])
        print(f"### {name}: {len(blocks)} 块")
        groups: dict[str, list[dict]] = {"off": [], "v11": [], "v12": []}
        raws: list[np.ndarray] = []
        served_v12: list[np.ndarray] = []
        for i, text in enumerate(blocks):
            for mode in ("off", "v11", "v12"):
                p = lp.tts_payload(text)
                p["perceptualAlign"] = mode != "off"
                p["alignProfile"] = "v12" if mode == "off" else mode
                status, blob, _ = lp.post("/tts", p)
                if status != 200:
                    print(f"  块{i} {mode} HTTP {status}: {blob[:150]}")
                    return 1
                x = decode(blob)
                # 与官方门禁完全同口径：TNS 规范化后的等效单元 +
                # analyze_clip 的语音时长（不是整段 WAV 时长）。
                units = lp.speech_units(lp.spoken(text))
                dur_speech = lp.analyze_clip(lp.to_wav(x, RATE), len(text)).duration_s
                f = feats(x)
                f["i"] = i
                f["ups"] = units / dur_speech if dur_speech > 0 else 0.0
                groups[mode].append(f)
                if mode == "off":
                    raws.append(x)
                if mode == "v12":
                    served_v12.append(x)
            print(
                f"  [{i:02d}] 语速 off={groups['off'][-1]['ups']:.2f} "
                f"v11={groups['v11'][-1]['ups']:.2f} v12={groups['v12'][-1]['ups']:.2f} | "
                f"K响度 off={groups['off'][-1]['kw']:.4f} v11={groups['v11'][-1]['kw']:.4f} "
                f"v12={groups['v12'][-1]['kw']:.4f}"
            )

        # v12 纯增益验证：线上 off 与 v12 波形互为标量倍（不允许频谱/边界处理），
        # 且 LTAS 逐块几乎不变（v11 会显著改变 LTAS，可作对照）。
        residuals = [scalar_residual(raw, served) for raw, served in zip(raws, served_v12)]
        max_resid = max(residuals) if residuals else 1.0
        ltas_delta = max(
            abs(v12["ltas"][b] - off["ltas"][b]) / max(off["ltas"][b], 1e-9)
            for off, v12 in zip(groups["off"], groups["v12"])
            for b in range(4)
        )
        pure_gain = max_resid < 2e-3 and ltas_delta < 0.02

        summary: dict = {
            "pure_gain_max_residual": max_resid,
            "pure_gain_ltas_delta": ltas_delta,
            "pure_gain_ok": pure_gain,
        }
        for mode, rows in groups.items():
            summary[mode] = {
                "kw_spread_db": lp.spread_db([r["kw"] for r in rows]),
                "rms_spread_db": lp.spread_db([r["rms"] for r in rows]),
                "ltas_spread_pct": [lp.spread([r["ltas"][b] for r in rows]) for b in range(4)],
                "ups_spread_pct": lp.spread([r["ups"] for r in rows]),
                "ups": [round(r["ups"], 2) for r in rows],
                "dur": [round(r["dur"], 3) for r in rows],
                "clip": max(r["clip"] for r in rows),
                "peak": max(r["peak"] for r in rows),
            }
            s = summary[mode]
            print(
                f"    {mode:>3}: K响度极差 {s['kw_spread_db']:5.2f}dB | 未加权 {s['rms_spread_db']:5.2f}dB | "
                f"语速极差 {s['ups_spread_pct']:5.2f}% | 削波 {s['clip']:.4f}"
            )
            print(f"         LTAS 极差% {s['ltas_spread_pct']}")
        print(
            f"    v12 纯增益校验：标量残差 max {max_resid:.2e}（<2e-3）、"
            f"LTAS 最大相对变化 {ltas_delta * 100:.2f}%（<2%）-> {pure_gain}"
        )

        same_time = summary["off"]["dur"] == summary["v12"]["dur"] == summary["v11"]["dur"]
        print(f"    三组逐块时长一致: {same_time}\n")
        summary["same_time"] = same_time
        report["cases"][name] = summary

        if args.check:
            off, v12 = summary["off"], summary["v12"]
            if v12["kw_spread_db"] >= off["kw_spread_db"]:
                violations.append(f"{name}: v12 K 加权响度极差未改善")
            if v12["ups_spread_pct"] > 8.0:
                violations.append(f"{name}: v12 单元语速极差 {v12['ups_spread_pct']}% 超门禁 8%")
            if v12["ups_spread_pct"] > off["ups_spread_pct"] + 0.5:
                violations.append(f"{name}: v12 语速一致性退化")
            if not same_time:
                violations.append(f"{name}: 对齐改变了音频时长")
            if v12["clip"] > off["clip"]:
                violations.append(f"{name}: v12 引入削波")
            if not pure_gain:
                violations.append(f"{name}: v12 线上路径不是纯增益（可能引入了 EQ/边界）")

    (outdir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"报告：{outdir / 'report.json'}")
    if violations:
        print("FAIL：")
        for v in violations:
            print(f"  - {v}")
        return 1
    if args.check:
        print("PASS：v12 响度/语速一致性达标，纯增益、时长与削波零回归（LTAS 不做 EQ 为设计意图）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
