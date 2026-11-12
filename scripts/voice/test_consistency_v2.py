#!/usr/bin/env python3
"""第十一轮一致性优化离线单测（K 加权响度 + 边界能量压缩）。

覆盖：滤波器方向、回退逐样本零改动、口径选择、诚实降级、限幅、能量门控、
确定性、长度/dtype/finite 不变。不依赖 sidecar，不需要模型。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import perceptual_align as pa  # noqa: E402
from perceptual_align import align_segment, k_weight  # noqa: E402

RATE = 24000
FAILS: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("  PASS " if ok else "  FAIL ") + name)
    if not ok:
        FAILS.append(name)


def tone(freq: float, seconds: float = 1.0, amp: float = 0.1) -> np.ndarray:
    t = np.arange(int(RATE * seconds)) / RATE
    return (amp * np.sin(2 * math.pi * freq * t)).astype(np.float32)


def speech_like(seconds: float = 2.5, seed: int = 7) -> np.ndarray:
    """带首尾能量差的准语音信号，保证 segment_profile() 能测出画像。"""
    rng = np.random.default_rng(seed)
    n = int(RATE * seconds)
    t = np.arange(n) / RATE
    carrier = np.sin(2 * math.pi * 180 * t) + 0.5 * np.sin(2 * math.pi * 2400 * t)
    noise = rng.normal(0, 0.35, n)
    env = np.ones(n, dtype=np.float64)
    head = int(0.10 * RATE)
    tail = int(0.10 * RATE)
    env[:head] *= 2.2
    env[-tail:] *= 0.25
    x = (0.04 * carrier * env + 0.012 * noise * env).astype(np.float32)
    x[: int(0.02 * RATE)] = 0.0
    x[-int(0.08 * RATE) :] = 0.0
    return x


print("== K 加权滤波器（ITU-R BS.1770 pre-filter）==")
if pa.K_WEIGHT_AVAILABLE:
    gains = {}
    for f in (60.0, 200.0, 3000.0, 6000.0):
        s = tone(f)
        y = k_weight(s, RATE)
        gains[f] = float(np.sqrt(np.mean(y[RATE // 5 :] ** 2))
                         / np.sqrt(np.mean(s[RATE // 5 :].astype(np.float64) ** 2)))
    print("  增益:", {k: round(v, 3) for k, v in gains.items()})
    check("低频 60Hz 被 high-pass 抑制 (<0.8)", gains[60.0] < 0.8)
    check("高频 6kHz 被 high-shelf 提升 (1.3~1.8)", 1.3 < gains[6000.0] < 1.8)
    check("高频增益大于中频", gains[6000.0] > gains[200.0])
    check("K 加权输出有限值", bool(np.isfinite(k_weight(speech_like(), RATE)).all()))
else:  # scipy 不可用时的诚实降级
    check("scipy 不可用时 k_weight 返回 None", k_weight(tone(1000), RATE) is None)

print("== 回退与口径 ==")
x = speech_like()
v1, d1 = align_segment(x, RATE, "serena", True, False, False)
v1_default, _ = align_segment(x, RATE, "serena", True)
check("v1 参数与第十轮默认调用逐样本一致",
      np.array_equal(np.asarray(v1), np.asarray(v1_default)))
check("v1 使用未加权响度口径", d1 is not None and d1["loudness_key"] == "rms_voiced")

off, doff = align_segment(x, RATE, "serena", False, True, True)
check("总开关关闭返回同一数组对象", off is x)
check("总开关关闭诊断为 None", doff is None)
unknown, dunknown = align_segment(x, RATE, "不存在的音色", True, True, True)
check("未标定音色原样返回", unknown is x and dunknown is None)

v2, d2 = align_segment(x, RATE, "serena", True, True, True)
check("v2 使用 K 加权响度口径",
      d2 is not None and d2["loudness_key"] == ("rms_kweighted" if pa.K_WEIGHT_AVAILABLE else "rms_voiced"))
check("v2 输出长度与输入一致", np.asarray(v2).size == x.size)
check("v2 输出 dtype 为 float32", np.asarray(v2).dtype == np.float32)
check("v2 输出全部有限", bool(np.isfinite(np.asarray(v2)).all()))
check("v2 逐样本确定性", np.array_equal(np.asarray(v2),
      np.asarray(align_segment(x, RATE, "serena", True, True, True)[0])))
check("v2 与 v1 确有差异（优化真的生效）",
      not np.array_equal(np.asarray(v1), np.asarray(v2)))

print("== 边界能量对齐 ==")
edge_diag = (d2 or {}).get("edge") or {}
check("诊断记录了 head/tail 增益", "head_gain_db" in edge_diag and "tail_gain_db" in edge_diag)
for side in ("head", "tail"):
    g = edge_diag.get(f"{side}_gain_db")
    check(f"{side} 增益受限幅 ±{pa.EDGE_MAX_GAIN_DB * pa.EDGE_SOFTEN:.1f}dB",
          g is None or abs(g) <= pa.EDGE_MAX_GAIN_DB * pa.EDGE_SOFTEN + 1e-6)

silent = speech_like()
silent[: int(0.10 * RATE)] = 0.0
_, dsilent = align_segment(silent, RATE, "serena", True, True, True)
esilent = (dsilent or {}).get("edge") or {}
check("全静音段首触发能量门控（不施加增益）", esilent.get("head_gain_db") is None)

short = np.zeros(100, dtype=np.float32)
sout, sd = align_segment(short, RATE, "serena", True, True, True)
check("极短信号原样返回", sout is short and sd is None)

nan = speech_like()
nan[100] = np.nan
nout, nd = align_segment(nan, RATE, "serena", True, True, True)
check("含 NaN 输入原样返回", nout is nan and nd is None)

print("== scipy 不可用时的诚实降级 ==")
saved = pa.K_WEIGHT_AVAILABLE
try:
    pa.K_WEIGHT_AVAILABLE = False
    down, dd = align_segment(x, RATE, "serena", True, True, True)
    check("降级后响度口径回到未加权 RMS",
          dd is not None and dd["loudness_key"] == "rms_voiced")
    check("降级后输出有限且长度不变",
          np.asarray(down).size == x.size and bool(np.isfinite(np.asarray(down)).all()))
finally:
    pa.K_WEIGHT_AVAILABLE = saved

print()
if FAILS:
    print(f"结果：{len(FAILS)} 项失败 -> {FAILS}")
    sys.exit(1)
print("结果：全部通过")
