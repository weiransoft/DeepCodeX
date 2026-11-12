#!/usr/bin/env python3
"""第十七轮：块内慢变响度整形 + 双口径语速折中的单元测试。

运行：`scripts/voice/.venv/bin/python scripts/voice/test_slow_leveling.py`
（venv 自带 scipy；系统 python3 可能缺，见 README 排障）
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import slow_leveling as sl  # noqa: E402
from perceptual_align import (  # noqa: E402
    LUFS_HOP_S,
    LUFS_OFFSET_DB,
    LUFS_TARGETS,
    align_loudness_lufs,
    integrated_lufs,
    lufs_window_energy,
)
from mlx_voice_server import (  # noqa: E402
    DUAL_RATE_ALPHA,
    TTS_RATE_SPEED_MAX,
    TTS_RATE_SPEED_MIN,
    VOICED_RATIO_REF,
    request_dual_rate_alpha,
    segment_stretch_speed,
    voiced_ratio_of,
)

RATE = 24000
CHECKS = 0


def check(cond: bool, name: str) -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok  {name}")


def tone(seconds: float, freq: float = 220.0, amp: float = 0.10) -> np.ndarray:
    t = np.arange(int(seconds * RATE), dtype=np.float64) / RATE
    return (amp * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


def drifted(seconds: float = 12.0, depth_db: float = 2.0, f: float = 0.09) -> np.ndarray:
    """0.09Hz（≈11s 周期）的慢变响度漂移，3s 平滑窗能完整跟踪。"""
    t = np.arange(int(seconds * RATE), dtype=np.float64) / RATE
    env = 10.0 ** (depth_db * np.sin(2.0 * np.pi * f * t) / 20.0)
    return (tone(seconds) * env).astype(np.float32)


def smooth_curve(x: np.ndarray, rate: int) -> np.ndarray:
    z, _ = lufs_window_energy(x, rate)
    return LUFS_OFFSET_DB + 10.0 * np.log10(np.maximum(z, 1e-20))


# ---------------------------------------------------------------------------
print("== 参数解析与诚实降级 ==")

check(sl.SLOW_LEVELING_ENABLED is True, "进程默认开启慢变整形")
check(0.0 < sl.SLOW_LEVELING_STRENGTH <= 1.0, "默认强度在 (0,1]")
check(sl.SLOW_LEVELING_SMOOTH_S >= 2.0, "平滑窗不小于 2s（不碰句内语调）")
check(sl.SLOW_LEVELING_MAX_DB <= 3.0, "增益限幅不超过 3dB")
check(sl.request_slow_leveling_enabled({}) is sl.SLOW_LEVELING_ENABLED, "请求缺省跟随进程默认")
for raw in (False, "0", "false", "off", "no", 0):
    check(sl.request_slow_leveling_enabled({"slowLeveling": raw}) is False, f"请求级关闭 {raw!r}")
for raw in (True, "1", "on", 1):
    check(sl.request_slow_leveling_enabled({"slowLeveling": raw}) is True, f"请求级开启 {raw!r}")
check(sl.request_slow_leveling_strength({}) == sl.SLOW_LEVELING_STRENGTH, "强度缺省跟随默认")
check(sl.request_slow_leveling_strength({"slowLevelingStrength": 0}) == 0.0, "强度 0 合法")
check(sl.request_slow_leveling_strength({"slowLevelingStrength": 1}) == 1.0, "强度 1 合法")
check(sl.request_slow_leveling_strength({"slowLevelingStrength": 99}) == 1.0, "强度上限钳制")
check(sl.request_slow_leveling_strength({"slowLevelingStrength": -5}) == 0.0, "强度下限钳制")
check(sl.request_slow_leveling_strength({"slowLevelingStrength": "abc"}) == sl.SLOW_LEVELING_STRENGTH, "非法强度回落默认")
check(sl.resolve_slow_leveling(None, None) == (sl.SLOW_LEVELING_ENABLED, sl.SLOW_LEVELING_STRENGTH), "内部入口 None 解析")
check(sl.resolve_slow_leveling(False, 0.2) == (False, 0.2), "内部入口显式覆盖")

print("== slow_level_loudness 降级与不变量 ==")
x = drifted()
out, diag = sl.slow_level_loudness(x, RATE, "serena", False)
check(out is x and diag is None, "关闭时返回同一数组对象、诊断 None")
out, diag = sl.slow_level_loudness(x, RATE, "serena", True, 0.0)
check(out is x and diag and not diag["applied"], "强度 0 不处理且标注原因")
short, diag = sl.slow_level_loudness(tone(0.2), RATE, "serena", True)
check(short.size == int(0.2 * RATE) and diag and diag["reason"] == "signal_too_short", "过短信号诚实降级")
unknown, diag = sl.slow_level_loudness(x, RATE, "no_such_voice", True)
check(unknown is x and diag and diag["reason"] == "uncalibrated_speaker", "未标定音色原样返回")
nan = x.copy()
nan[10] = float("nan")
_, diag = sl.slow_level_loudness(nan, RATE, "serena", True)
check(diag and not diag["applied"], "非有限样本诚实降级")

out, diag = sl.slow_level_loudness(x, RATE, "serena", True, 0.7)
check(diag is not None and diag["applied"] is True, "正常路径确实施加整形")
check(out.shape == x.shape and out.dtype == np.float32, "样本数与 dtype 不变")
check(np.isfinite(out).all(), "输出全有限")
check(float(np.max(np.abs(out))) <= 0.99 + 1e-6, "峰值不削波")
check(diag["gain_span_db"] <= 2 * sl.SLOW_LEVELING_MAX_DB + 1e-6, "增益跨度不超双向限幅")
check(diag["gain_slope_max_db_per_s"] < 12.0, "增益斜率低于可闻 pumping 阈值")
check(diag["scalar"] is False, "诊断如实标注不再是纯标量")

# 零均值增益：整块 integrated LUFS 变化应很小
before = integrated_lufs(x, RATE)
after = integrated_lufs(out, RATE)
check(before is not None and after is not None and abs(after - before) < 0.6,
      f"零均值增益保持整块 LUFS（{before:.2f}→{after:.2f}）")

# 慢变漂移被压平（3s 尺度），但保留 100ms 级细节：只比较平滑后曲线的极差
b = smooth_curve(tone(12.0), RATE)
check(b.size > 50, "稳态信号能算出 momentary 曲线")
c0 = smooth_curve(x, RATE)
c1 = smooth_curve(out, RATE)
check(c1.max() - c1.min() < c0.max() - c0.min() - 0.5,
      f"慢变响度极差下降（{c0.max()-c0.min():.2f}→{c1.max()-c1.min():.2f}dB）")

# 强度单调性
spreads = []
for k in (0.0, 0.3, 0.7, 1.0):
    w, _ = sl.slow_level_loudness(x, RATE, "serena", True, k)
    c = smooth_curve(w, RATE)
    spreads.append(float(c.max() - c.min()))
check(spreads[0] > spreads[1] > spreads[2] > spreads[3],
      f"强度越大压得越平 {[round(v, 2) for v in spreads]}")

# 稳态信号不该被改变多少（增益接近 0）
steady = tone(6.0)
w, d = sl.slow_level_loudness(steady, RATE, "serena", True, 1.0)
check(d and d["gain_span_db"] < 0.5, "稳态信号几乎不施加增益")
check(float(np.max(np.abs(w - steady))) < 0.002, "稳态信号波形近似不变")

# 静音窗口不被抬增益（hold 而非当成极轻）
gapped = x.copy()
gapped[int(5 * RATE):int(5.5 * RATE)] = 0.0
w, d = sl.slow_level_loudness(gapped, RATE, "serena", True, 0.7)
check(d and d["applied"] and float(np.max(np.abs(w[int(5 * RATE):int(5.5 * RATE)]))) < 1e-6,
      "静音段保持静音（未被抬高）")

print("== apply_loudness_chain 分派与回退 ==")
raw = drifted(6.0)
chain_off, d = sl.apply_loudness_chain(
    raw, RATE, "serena", profile="v14", perceptual_align=False,
    kweighted=True, edge=True, slow_leveling=True,
)
check(chain_off is raw and d is None, "perceptualAlign=false 逐样本零改动")

ref, _ = align_loudness_lufs(raw, RATE, "serena", True)
chain_v14_off, d = sl.apply_loudness_chain(
    raw, RATE, "serena", profile="v14", perceptual_align=True,
    kweighted=True, edge=True, slow_leveling=False,
)
check(np.array_equal(chain_v14_off, ref), "slowLeveling=false 与 v14 逐样本一致")
check(d and d.get("profile") == "v14", "回退时诊断仍是 v14")

chain_on, d = sl.apply_loudness_chain(
    raw, RATE, "serena", profile="v14", perceptual_align=True,
    kweighted=True, edge=True, slow_leveling=True, slow_leveling_strength=0.7,
)
check(d and d.get("profile") == "v17", "整形后诊断标 v17")
check(d and {"first", "slowLeveling", "second"} <= set(d), "诊断含三段链路")
check(d and d["second"].get("loudness_key") == "lufs_gated", "二次归一仍是 LUFS 口径")
lufs_on = integrated_lufs(chain_on, RATE)
check(lufs_on is not None and abs(lufs_on - LUFS_TARGETS["serena"]) < 0.15,
      f"二次归一后 integrated LUFS 回到目标（{lufs_on:.2f}）")

for p in ("v11", "v12"):
    _, dp = sl.apply_loudness_chain(
        raw, RATE, "serena", profile=p, perceptual_align=True,
        kweighted=True, edge=True, slow_leveling=True,
    )
    check(not (dp and dp.get("profile") == "v17"), f"{p} 不触发 v17 整形")

_, dfb = sl.apply_loudness_chain(
    raw, RATE, "unknown_voice", profile="v14", perceptual_align=True,
    kweighted=True, edge=True, slow_leveling=True,
)
check(not (dfb and dfb.get("profile") == "v17"), "未标定音色 fallback 时不整形")

print("== 双口径语速折中 ==")
check(0.0 <= DUAL_RATE_ALPHA <= 1.0, "进程 alpha 在 [0,1]")
check(0.0 < VOICED_RATIO_REF <= 1.0, "有声占比参考值合法")
check(request_dual_rate_alpha({}) == DUAL_RATE_ALPHA, "请求缺省跟随 alpha")
check(request_dual_rate_alpha({"dualRateAlpha": 0}) == 0.0, "请求级 0 一键回退")
check(request_dual_rate_alpha({"dualRateAlpha": 99}) == DUAL_RATE_ALPHA, "越界回落默认")
check(request_dual_rate_alpha({"dualRateAlpha": "x"}) == DUAL_RATE_ALPHA, "非法回落默认")

base = segment_stretch_speed(tone(3.0), RATE, 15.0, 1.15)
check(segment_stretch_speed(tone(3.0), RATE, 15.0, 1.15, 0.0, 0.8) == base,
      "alpha=0 与第十六轮逐字一致")
lower = segment_stretch_speed(tone(3.0), RATE, 15.0, 1.15, 0.3, VOICED_RATIO_REF * 0.8)
higher = segment_stretch_speed(tone(3.0), RATE, 15.0, 1.15, 0.3, VOICED_RATIO_REF * 1.1)
check(lower < base, "有声占比低于参考 → 倍率降低")
check(higher >= base, "有声占比高于参考 → 倍率不降（受上限钳制时相等）")
check(segment_stretch_speed(tone(3.0), RATE, 15.0, 1.15, 0.3, VOICED_RATIO_REF) == base,
      "正好等于参考时无偏置")
check(TTS_RATE_SPEED_MIN <= lower <= TTS_RATE_SPEED_MAX, "偏置后仍在倍率钳制区间")

check(voiced_ratio_of(np.zeros(RATE), RATE) == 1.0, "全零信号诚实返回 1.0（不除零）")
check(voiced_ratio_of(tone(3.0), RATE) > 0.9, "纯连续音有声占比接近 1")
half = tone(3.0)
half[int(1.0 * RATE):int(2.0 * RATE)] = 0.0
check(0.5 < voiced_ratio_of(half, RATE) < 0.8, "带 1s 静音时占比落在 (0.5,0.8)")

print(f"\nPASS：{CHECKS} 项检查全部通过")
