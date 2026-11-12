#!/usr/bin/env python3
"""段级感知对齐的离线单测（不依赖模型 / sidecar）。

覆盖：回退零改动、未标定音色降级、边界输入、确定性、限幅、补偿方向、
以及「增益全 0 时 FFT-OLA 逐样本还原」。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from perceptual_align import (  # noqa: E402
    MAX_BAND_DB,
    MAX_LOUDNESS_DB,
    PERCEPTUAL_PROFILES,
    _apply_gain_curve,
    _gain_curve_db,
    align_segment,
    segment_profile,
)

RATE = 24000
FAILED: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name} {detail}")


def tone(seconds: float = 1.0, scale: float = 1.0, highs: float = 1.0) -> np.ndarray:
    """多正弦 + 缓慢包络，模拟有稳定有声帧的语音样信号。"""
    t = np.arange(int(RATE * seconds)) / RATE
    env = 0.55 + 0.45 * np.sin(2 * np.pi * 3 * t)
    wave = (
        0.60 * np.sin(2 * np.pi * 220 * t)
        + 0.22 * np.sin(2 * np.pi * 1100 * t)
        + 0.12 * highs * np.sin(2 * np.pi * 4200 * t)
        + 0.06 * highs * np.sin(2 * np.pi * 9000 * t)
    )
    return (wave * env * 0.06 * scale).astype(np.float32)


def test_off_path() -> None:
    x = tone(scale=0.5)
    out, diag = align_segment(x, RATE, "serena", enabled=False)
    check("关闭时返回同一数组对象", out is x)
    check("关闭时诊断为 None", diag is None)
    out2, diag2 = align_segment(x, RATE, "unknown_speaker", enabled=True)
    check("未标定音色原样返回", out2 is x and diag2 is None)
    for name, bad in (
        ("极短输入", np.zeros(100, dtype=np.float32)),
        ("全静音", np.zeros(RATE, dtype=np.float32)),
        ("含 NaN", np.array([np.nan] * RATE, dtype=np.float32)),
    ):
        got, info = align_segment(bad, RATE, "serena", enabled=True)
        check(f"{name}不崩且跳过", got is bad and info is None)


def test_determinism_and_shape() -> None:
    x = tone(seconds=1.2, scale=0.62, highs=0.35)
    out, diag = align_segment(x, RATE, "serena", enabled=True)
    out2, diag2 = align_segment(x, RATE, "serena", enabled=True)
    check("输出长度不变", out.size == x.size, f"{out.size} vs {x.size}")
    check("输出 dtype float32", out.dtype == np.float32)
    check("输出无 NaN/Inf", bool(np.isfinite(out).all()))
    check("同输入逐位确定", np.array_equal(out, out2))
    check("诊断含增益与画像", diag is not None and "loudness_db" in diag and "before_ltas" in diag)
    if diag:
        check("响度增益在限幅内", abs(diag["loudness_db"]) <= MAX_LOUDNESS_DB + 1e-6,
              str(diag["loudness_db"]))
        check("频带增益在限幅内", all(abs(v) <= MAX_BAND_DB + 1e-6 for v in diag["band_db"]),
              str(diag["band_db"]))


def test_gain_directions() -> None:
    target = PERCEPTUAL_PROFILES["serena"]
    # 响度偏小 → 应放大，且对齐后更接近目标
    quiet = tone(seconds=1.2, scale=0.45, highs=0.4)
    before = segment_profile(quiet, RATE)
    out, diag = align_segment(quiet, RATE, "serena", enabled=True)
    after = segment_profile(out, RATE)
    check("偏小信号被放大", diag is not None and diag["loudness_db"] > 0)
    check(
        "响度更接近目标",
        before is not None and after is not None
        and abs(math.log10(after["rms_voiced"] / target["rms_voiced"]))
        < abs(math.log10(before["rms_voiced"] / target["rms_voiced"])),
        f"before={before['rms_voiced'] if before else None} after={after['rms_voiced'] if after else None}",
    )
    # 高频偏弱 → 高频带增益应为正、占比上升
    dull = tone(seconds=1.2, scale=0.8, highs=0.02)
    b = segment_profile(dull, RATE)
    out2, diag2 = align_segment(dull, RATE, "serena", enabled=True)
    a = segment_profile(out2, RATE)
    check("高频偏弱时给正增益", diag2 is not None and diag2["band_db"][-1] > 0,
          str(diag2["band_db"] if diag2 else None))
    check("高频占比上升", b is not None and a is not None and a["ltas"][3] > b["ltas"][3],
          f"{b['ltas'][3] if b else None} -> {a['ltas'][3] if a else None}")


def test_curve_and_identity() -> None:
    x = tone(seconds=1.0)
    zeros = np.zeros(1025, dtype=np.float64)  # rfft(2048) 的 bin 数
    restored = _apply_gain_curve(x, zeros)
    err = float(np.max(np.abs(restored - x)))
    check("全 0 增益 FFT-OLA 逐样本还原", err < 2e-4, f"max err={err}")
    current = {"rms_voiced": 0.02, "ltas": [0.97, 0.01, 0.01, 0.01]}
    target = PERCEPTUAL_PROFILES["serena"]
    _curve, diag = _gain_curve_db(current, target, RATE)
    check("曲线只含谱形增益", "loudness_db" not in diag and "band_db" in diag)
    check("极端输入频带被钳到上限", max(diag["band_db"]) <= MAX_BAND_DB + 1e-6)
    # 两阶段：谱形补偿之后重新测响度，最终值应落在目标附近。
    # 输入刻意构造在 ±3dB 限幅**以内**（目标 -2.5dB），否则测的是限幅而非收敛。
    base = tone(seconds=1.2, scale=1.0, highs=0.4)
    base_rms = segment_profile(base, RATE)["rms_voiced"]  # type: ignore[index]
    want = target["rms_voiced"]
    near = tone(seconds=1.2, scale=(want * 0.75) / base_rms, highs=0.4)
    _out, info = align_segment(near, RATE, "serena", enabled=True)
    after = segment_profile(_out, RATE)
    check(
        "两阶段后响度收敛到目标",
        info is not None and after is not None
        and abs(20 * math.log10(after["rms_voiced"] / want)) < 0.5,
        f"after={after['rms_voiced'] if after else None} target={want}",
    )
    check("诊断记录最终响度", info is not None and "after_rms_voiced" in info)


def main() -> int:
    print("=== 感知对齐：回退 / 降级 ===")
    test_off_path()
    print("=== 感知对齐：确定性 / 形状 / 限幅 ===")
    test_determinism_and_shape()
    print("=== 感知对齐：补偿方向 ===")
    test_gain_directions()
    print("=== 感知对齐：FFT-OLA 还原与钳位 ===")
    test_curve_and_identity()
    print(f"\n结果：{'全部通过' if not FAILED else '失败 ' + ', '.join(FAILED)}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
