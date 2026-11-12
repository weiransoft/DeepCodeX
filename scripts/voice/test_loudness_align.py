"""第十二轮响度-only 对齐的离线回归测试。

运行：scripts/voice/.venv/bin/python scripts/voice/test_loudness_align.py

核心性质：`align_loudness()` 对波形只做**标量增益**，因此
    out == x * c（c 为某个正常数，含防削波回压）
这在数学上排除了逐段 EQ（改变频谱形状）与边界增益（改变局部能量分布），
正是 2026-11-09 用户主观回归的修复点。
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from perceptual_align import (  # noqa: E402
    K_WEIGHT_AVAILABLE,
    LOUDNESS_MAX_DB,
    LOUDNESS_TARGETS,
    align_loudness,
    segment_profile,
)

RATE = 24000
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(name)


def voiced(seconds: float = 1.2, amp: float = 0.05, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(RATE * seconds)) / RATE
    x = amp * (
        np.sin(2 * np.pi * freq * t)
        + 0.4 * np.sin(2 * np.pi * freq * 2.3 * t)
        + 0.2 * np.sin(2 * np.pi * freq * 5.1 * t)
    )
    return x.astype(np.float32)


def scalar_ratio(x: np.ndarray, y: np.ndarray) -> float:
    """y 对 x 的最佳标量拟合的相对残差：0 表示纯增益（无 EQ / 无边界）。"""
    denom = float(np.dot(x, x))
    if denom <= 0:
        return 0.0
    c = float(np.dot(x, y) / denom)
    resid = y - c * x
    return float(np.linalg.norm(resid) / max(np.linalg.norm(y), 1e-12))


def main() -> int:
    print("== 第十二轮：响度-only 对齐 ==")
    print(f"  K_WEIGHT_AVAILABLE={K_WEIGHT_AVAILABLE} 限幅 ±{LOUDNESS_MAX_DB}dB")

    x = voiced()
    out, diag = align_loudness(x, RATE, "serena", False)
    check("关闭时返回同一数组对象", out is x)
    check("关闭时诊断为 None", diag is None)

    out, diag = align_loudness(x, RATE, "unknown_speaker", True)
    check("未标定音色原样返回（诚实降级）", out is x and diag is None)

    for label, bad in (
        ("极短", np.zeros(16, dtype=np.float32)),
        ("全静音", np.zeros(RATE, dtype=np.float32)),
        ("含 NaN", np.full(RATE, np.nan, dtype=np.float32)),
    ):
        o, d = align_loudness(bad, RATE, "serena", True)
        check(f"{label}输入跳过且不改数据", o is bad and d is None)

    out1, d1 = align_loudness(x, RATE, "serena", True)
    out2, _ = align_loudness(x.copy(), RATE, "serena", True)
    check("输出长度不变", out1.size == x.size)
    check("输出 dtype float32", out1.dtype == np.float32)
    check("输出全部 finite", bool(np.isfinite(out1).all()))
    check("确定性（同输入同输出）", bool(np.array_equal(out1, out2)))

    resid = scalar_ratio(x, out1)
    check("输出是输入的纯标量倍（无 EQ / 无边界）", resid < 1e-5, f"残差 {resid:.2e}")

    # 偏小信号应被放大，偏大信号应被压低；方向由目标决定
    quiet = voiced(amp=0.012)
    loud = voiced(amp=0.30)
    oq, dq = align_loudness(quiet, RATE, "serena", True)
    ol, dl = align_loudness(loud, RATE, "serena", True)
    check("偏小信号给正增益", dq is not None and dq["loudness_db"] > 0,
          f"{dq and dq['loudness_db']}dB")
    check("偏大信号给负增益", dl is not None and dl["loudness_db"] < 0,
          f"{dl and dl['loudness_db']}dB")

    # 限幅：极端小信号的所需增益远大于 ±2dB，必须被钳住
    tiny = voiced(amp=1e-5)
    ot, dt = align_loudness(tiny, RATE, "serena", True)
    check("增益限幅不超过上限", dt is not None and abs(dt["loudness_db"]) <= LOUDNESS_MAX_DB + 1e-9,
          f"{dt and dt['loudness_db']}dB")
    check("限幅后仍是纯标量倍", scalar_ratio(tiny, ot) < 1e-5)

    # 限幅内应收敛到目标（K 加权口径；scipy 缺失时回退未加权）
    key = "rms_kweighted" if K_WEIGHT_AVAILABLE else "rms_voiced"
    target = LOUDNESS_TARGETS["serena"][key]
    before = segment_profile(quiet, RATE)
    after = segment_profile(oq, RATE)
    need_db = 20 * math.log10(target / before[key])
    if abs(need_db) <= LOUDNESS_MAX_DB:
        got_db = 20 * math.log10(after[key] / target)
        check("限幅内响度收敛到目标", abs(got_db) < 0.35, f"偏差 {got_db:+.3f}dB")
    else:
        check("目标与输入的偏差超限时走限幅分支", dt is not None)

    # 峰值保护：大振幅输入放大后不得削波
    hot = voiced(amp=0.9)
    oh, _ = align_loudness(hot, RATE, "serena", True)
    check("峰值不超过 0.99", float(np.max(np.abs(oh))) <= 0.99 + 1e-6,
          f"peak {float(np.max(np.abs(oh))):.4f}")
    check("峰值保护后仍是纯标量倍", scalar_ratio(hot, oh) < 1e-5)

    # 段间一致性：同一 speaker 不同响度的两段，处理后 K 加权极差应变小
    a = voiced(amp=0.02)
    b = voiced(amp=0.08)
    ka = segment_profile(a, RATE)[key]
    kb = segment_profile(b, RATE)[key]
    oa, _ = align_loudness(a, RATE, "serena", True)
    ob, _ = align_loudness(b, RATE, "serena", True)
    sa = segment_profile(oa, RATE)[key]
    sb = segment_profile(ob, RATE)[key]
    before_spread = abs(20 * math.log10(ka / kb))
    after_spread = abs(20 * math.log10(sa / sb))
    check("两段响度极差被压缩", after_spread < before_spread,
          f"{before_spread:.2f}dB → {after_spread:.2f}dB")

    print()
    if FAILED:
        print(f"结论：{len(FAILED)} 项失败 -> {FAILED}")
        return 1
    print("结论：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
