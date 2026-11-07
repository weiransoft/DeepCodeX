#!/usr/bin/env python3
"""短块句内静音上限（P1）纯函数单测（不依赖 MLX 模型，可离线跑）。

锁住四件事：
1. 关闭态逐样本等于既有 `compress_internal_gaps()`（默认关、可一键回退）；
2. ≤20 等效发音单元的短块，>0.30s 的句内静音压到 0.30s，自然停顿不动；
3. >20 单元的长块完全不受短块规则影响（仍只压 >0.9s 的异常空白到 0.45s）；
4. 请求级 `shortGap` 覆盖语义与 TNS 一致，且压缩不吞掉任何有声样本。

背景：2026-11-07 `num:xs` 有声语速 5.219 u/s 正常，整段却只有 3.908 u/s；
模型在短数字句里插了 4 段句内静音（最终输出合计 0.900s），把原始段撑到
约 6.0s，逐段语速伺服被钳在 1.65 上限，够不到 4.92 u/s 目标。压缩必须在
**伺服之前**执行，才能把倍率拉回可达区间。真机效果见同时期的 P1 报告，
本文件只锁纯函数行为。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mlx_voice_server import (  # noqa: E402
    SHORT_GAP_ENABLED,
    SHORT_GAP_MAX_S,
    SHORT_GAP_UNITS,
    compress_internal_gaps,
    compress_segment_gaps,
    request_short_gap_enabled,
    speech_units,
)

SR = 24000
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(name)


def tone(seconds: float) -> np.ndarray:
    t = np.arange(int(seconds * SR), dtype=np.float32) / SR
    return (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)


def gap(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def assemble(*sections: tuple[str, float]) -> np.ndarray:
    parts = [tone(s) if k == "v" else gap(s) for k, s in sections]
    return np.concatenate(parts)


def internal_gaps(x: np.ndarray) -> list[float]:
    """精确零静音段长度（合成信号里静音就是全 0，不引入门限误差）。"""
    quiet = (np.asarray(x) == 0).tolist()
    first = next((i for i, v in enumerate(quiet) if not v), None)
    if first is None:
        return []
    last = len(quiet) - 1 - next(i for i, v in enumerate(reversed(quiet)) if not v)
    runs: list[float] = []
    run = 0
    for i in range(first, last + 1):
        if quiet[i]:
            run += 1
        else:
            if run:
                runs.append(run / SR)
            run = 0
    if run:
        runs.append(run / SR)
    return runs


print("=== 开关契约 ===")
check("环境变量默认关", SHORT_GAP_ENABLED is False, f"SHORT_GAP_ENABLED={SHORT_GAP_ENABLED}")
check("短块阈值 = 20 等效发音单元", SHORT_GAP_UNITS == 20.0)
check("静音上限 = 0.30s", abs(SHORT_GAP_MAX_S - 0.30) < 1e-9)
check("请求缺省跟随环境（关）", request_short_gap_enabled({}) is False)
check("请求 shortGap=true 打开本次", request_short_gap_enabled({"shortGap": True}) is True)
check("请求 shortGap='1' 打开本次", request_short_gap_enabled({"shortGap": "1"}) is True)
check("请求 shortGap=false 关本次", request_short_gap_enabled({"shortGap": False}) is False)
check("请求 shortGap='off' 关本次", request_short_gap_enabled({"shortGap": "off"}) is False)
check("请求 shortGap='false' 不被当成真值", request_short_gap_enabled({"shortGap": "false"}) is False)
check("请求 shortGap=0 关本次", request_short_gap_enabled({"shortGap": 0}) is False)

print("\n=== 关闭态逐样本等价 ===")
SHORT_TEXT = "首块 192 毫秒，整块 1821 毫秒。"
LONG_TEXT = "我先把刚才那三处改动从头到尾捋了一遍，慢慢说给你听，不急着下结论。"
check("短数字句 14.3 单元（≤20）", abs(speech_units(SHORT_TEXT) - 14.3) < 1e-6, f"{speech_units(SHORT_TEXT):.2f}")
check("中文长句 >20 单元", speech_units(LONG_TEXT) > SHORT_GAP_UNITS, f"{speech_units(LONG_TEXT):.2f}")

signals = {
    "纯有声": tone(1.0),
    "0.5s 自然停顿": assemble(("v", 0.5), ("s", 0.5), ("v", 0.5)),
    "0.6s 停顿": assemble(("v", 0.5), ("s", 0.6), ("v", 0.5)),
    "1.4s 异常空白": assemble(("v", 0.5), ("s", 1.4), ("v", 0.5)),
    "多段停顿": assemble(("v", 0.4), ("s", 0.5), ("v", 0.4), ("s", 0.4), ("v", 0.4), ("s", 0.1), ("v", 0.4)),
}
for name, x in signals.items():
    base = compress_internal_gaps(x, SR)
    for units in (speech_units(SHORT_TEXT), speech_units(LONG_TEXT)):
        check(
            f"{name} / {units:.1f}单元 显式关 == 既有实现",
            np.array_equal(compress_segment_gaps(x, SR, units, short_gap=False), base),
        )
        check(
            f"{name} / {units:.1f}单元 缺省关 == 既有实现",
            np.array_equal(compress_segment_gaps(x, SR, units), base),
        )

print("\n=== 短块：句内静音上限 ===")
x = assemble(("v", 0.5), ("s", 0.6), ("v", 0.5))
y = compress_segment_gaps(x, SR, speech_units(SHORT_TEXT), short_gap=True)
check("0.6s 停顿压到 0.30s", abs(internal_gaps(y)[0] - 0.30) < 0.02, f"{[round(g, 3) for g in internal_gaps(y)]}")
check("总时长 = 1.0s 有声 + 0.30s 停顿", abs(y.size / SR - 1.30) < 0.03, f"{y.size / SR:.3f}s")
check("有声样本一个不少", int(np.count_nonzero(y)) == int(np.count_nonzero(x)))
check("有声波形逐样本保留", np.array_equal(y[y != 0], x[x != 0]))

x2 = assemble(("v", 0.5), ("s", 0.28), ("v", 0.5))
y2 = compress_segment_gaps(x2, SR, speech_units(SHORT_TEXT), short_gap=True)
check("0.28s 自然停顿原样保留", np.array_equal(y2, x2), f"{[round(g, 3) for g in internal_gaps(y2)]}")

x3 = signals["多段停顿"]
y3 = compress_segment_gaps(x3, SR, speech_units(SHORT_TEXT), short_gap=True)
g3 = internal_gaps(y3)
check("多段停顿逐段压到 0.30s", len(g3) == 3 and abs(g3[0] - 0.30) < 0.02 and abs(g3[1] - 0.30) < 0.02 and abs(g3[2] - 0.10) < 0.02, f"{[round(g, 3) for g in g3]}")
check("多段场景有声样本不丢", int(np.count_nonzero(y3)) == int(np.count_nonzero(x3)))

print("\n=== 长块：不受短块规则影响 ===")
x4 = assemble(("v", 0.5), ("s", 0.6), ("v", 0.5))
y4 = compress_segment_gaps(x4, SR, speech_units(LONG_TEXT), short_gap=True)
check(">20 单元时 0.6s 停顿原样保留", np.array_equal(y4, x4))
x5 = signals["1.4s 异常空白"]
y5 = compress_segment_gaps(x5, SR, speech_units(LONG_TEXT), short_gap=True)
y5_short = compress_segment_gaps(x5, SR, speech_units(SHORT_TEXT), short_gap=True)
check("长块仍走既有 0.45s 异常空白规则", abs(internal_gaps(y5)[0] - 0.45) < 0.02, f"{[round(g, 3) for g in internal_gaps(y5)]}")
check("短块同一信号压到 0.30s（规则确实分叉）", abs(internal_gaps(y5_short)[0] - 0.30) < 0.02, f"{[round(g, 3) for g in internal_gaps(y5_short)]}")

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: {', '.join(FAILED)}")
    raise SystemExit(1)
print("ALL PASS")
