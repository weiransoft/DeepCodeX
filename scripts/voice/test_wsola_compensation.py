"""wsola_compensation.py 离线单测：锁住「只依赖倍率」这一契约。"""
from __future__ import annotations

import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

import wsola_compensation as wc  # noqa: E402
from mlx_voice_server import time_stretch_wsola  # noqa: E402

RATE = 24000
BANDS = wc.BAND_EDGES
WIN, HOP = int(RATE * 0.04), int(RATE * 0.02)
CHECKS = 0


def check(cond: bool, label: str) -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(f"FAIL: {label}")
    print(f"  ok  {label}")


def band_energy(x: np.ndarray) -> np.ndarray:
    frames = [x[i : i + WIN] for i in range(0, max(0, x.size - WIN), HOP)]
    if not frames:
        return np.zeros(4)
    rms = np.array([float(np.sqrt(np.mean(f**2))) for f in frames])
    thr = float(np.max(rms)) * 0.01
    acc = np.zeros(4)
    n = 0
    for f, r in zip(frames, rms):
        if r <= thr:
            continue
        spec = np.abs(np.fft.rfft(f * np.hanning(f.size)))
        freq = np.fft.rfftfreq(f.size, 1 / RATE)
        for b in range(4):
            acc[b] += float(np.sum(spec[(freq >= BANDS[b]) & (freq < BANDS[b + 1])]))
        n += 1
    return acc / max(n, 1)


def db_dev(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return 20 * np.log10(np.maximum(a, 1e-9) / np.maximum(b, 1e-9))


# ---------------------------------------------------------------- 契约
print("== 契约：增益只由倍率决定 ==")
c1 = wc.compensation_curve_db(1.30, RATE)
c2 = wc.compensation_curve_db(1.30, RATE)
c3 = wc.compensation_curve_db(1.50, RATE)
check(np.array_equal(c1, c2), "同一倍率曲线逐元素相同（与输入波形无关）")
check(not np.array_equal(c1, c3), "不同倍率曲线不同")
check(c1.size == wc.FFT_FRAME // 2 + 1, "曲线长度等于 rfft 频点数")

bands = [wc.band_compensation_db(r) for r in (0.75, 0.85, 1.0, 1.15, 1.30, 1.50, 1.70, 1.85)]
check(all(abs(v) < 1e-9 for v in bands[2]), "倍率=1 时四频带补偿全为 0")
for i in (1, 2, 3):
    check(all(b[i] >= 0 for b in bands), f"频带{i}补偿非负（只补衰减，不压高频）")
seq = [bands[j][2] for j in (3, 4, 5, 6, 7)]
check(all(a <= b + 1e-9 for a, b in zip(seq, seq[1:])), "加速端 3-8k 补偿随倍率单调不减")
check(all(v <= wc.MAX_COMPENSATION_DB + 1e-9 for b in bands for v in b), f"单频带不超过 {wc.MAX_COMPENSATION_DB}dB 上限")
check(wc.band_compensation_db(9.9) == wc.band_compensation_db(1.85), "超上限倍率钳位到端点")
check(wc.band_compensation_db(0.1) == wc.band_compensation_db(0.75), "低于下限倍率钳位到端点")

# ---------------------------------------------------------------- 跳过路径
print("== 跳过路径：逐引用零改动 ==")
rng = np.random.default_rng(20261113)
t = np.arange(RATE * 2, dtype=np.float32) / RATE
x = (0.12 * np.sin(2 * np.pi * 220 * t) + 0.05 * np.sin(2 * np.pi * 3400 * t)
     + 0.02 * rng.standard_normal(t.size)).astype(np.float32)
for label, args in (
    ("关闭开关", (x, RATE, 1.5, False)),
    ("倍率=1", (x, RATE, 1.0, True)),
    ("死区内倍率", (x, RATE, 1.005, True)),
    ("非有限倍率", (x, RATE, float("nan"), True)),
):
    out, diag = wc.compensate_wsola(*args)
    check(out is x and diag is None, f"{label} 返回同一数组对象且无诊断")

short = np.zeros(64, dtype=np.float32)
check(wc.compensate_wsola(short, RATE, 1.5)[0] is short, "极短输入跳过")
silence = np.zeros(RATE, dtype=np.float32)
check(wc.compensate_wsola(silence, RATE, 1.5)[0] is silence, "全静音输入跳过")
nan = x.copy()
nan[10] = float("nan")
check(wc.compensate_wsola(nan, RATE, 1.5)[0] is nan, "非有限输入跳过")

# ---------------------------------------------------------------- 输出性质
print("== 输出性质 ==")
out, diag = wc.compensate_wsola(x, RATE, 1.5)
check(out is not x, "生效时返回新数组（不原地改输入）")
check(out.shape == x.shape and out.dtype == np.float32, "形状与 dtype 不变")
check(np.isfinite(out).all(), "输出全有限")
check(np.array_equal(wc.compensate_wsola(x, RATE, 1.5)[0], out), "同输入同倍率确定性")
check(diag is not None and diag["ratio"] == 1.5, "诊断记录倍率")

# ---------------------------------------------------------------- 核心有效性
print("== 核心有效性：补偿后谱更接近未变速基准 ==")
wave_path = "/tmp/dcx-gen13/pure_cn-00.npy"
if os.path.exists(wave_path):
    base = np.load(wave_path).astype(np.float32)
    e0 = band_energy(base)
    for r in (0.85, 1.15, 1.30, 1.50, 1.70):
        stretched = time_stretch_wsola(base, r)
        before = band_energy(stretched)
        compensated, _ = wc.compensate_wsola(stretched, RATE, r)
        after = band_energy(compensated)
        err_before = float(np.mean(np.abs(db_dev(before, e0)[1:])))
        err_after = float(np.mean(np.abs(db_dev(after, e0)[1:])))
        print(f"  倍率 {r:.2f}  高频偏差 {err_before:.2f}dB → {err_after:.2f}dB")
        check(err_after < err_before, f"倍率 {r:.2f} 补偿后高频更接近基准")
        check(compensated.size == stretched.size, f"倍率 {r:.2f} 时长不变")
        check(float(np.max(np.abs(compensated))) <= 0.991, f"倍率 {r:.2f} 不削波")
else:
    print("  (跳过真机波形用例：/tmp/dcx-gen13/pure_cn-00.npy 不存在)")

# ------------------------------------------------ 第十四轮：请求级强度覆盖
print("== 请求级强度：解析、钳位、零回归 ==")
R = wc.request_wsola_compensation_strength
check(R({}) is None, "缺省返回 None（跟随模块默认）")
check(R({"wsolaCompensationStrength": 0.9}) == 0.9, "数值强度透传")
check(R({"wsolaCompensationStrength": "0.35"}) == 0.35, "字符串数值可解析")
check(R({"wsolaCompensationStrength": -1}) == 0.0, "下界钳到 0")
check(R({"wsolaCompensationStrength": 5}) == 1.0, "上界钳到 1")
for bad in ("abc", "", None, float("nan"), float("inf"), [], {}):
    check(R({"wsolaCompensationStrength": bad}) is None, f"坏值 {bad!r} 诚实降级为 None")

d0 = wc.band_compensation_db(1.5, 0.0)
check(all(abs(v) < 1e-9 for v in d0), "强度 0 → 全频带 0dB")
d_default = wc.band_compensation_db(1.5)
d_same = wc.band_compensation_db(1.5, wc.COMPENSATION_STRENGTH)
check(d_default == d_same, "显式默认强度 == 缺省（零回归）")
d_full = wc.band_compensation_db(1.5, 1.0)
check(d_full[2] > d_default[2] > d0[2], "高频增益随强度单调增大")
check(wc.resolve_strength(None) == wc.COMPENSATION_STRENGTH, "resolve_strength(None) 跟随默认")
check(wc.resolve_strength(9) == 1.0, "resolve_strength 再钳位")

zero_out, zero_diag = wc.compensate_wsola(x, RATE, 1.5, True, 0.0)
check(zero_out is x, "强度 0 返回调用方原对象（逐引用零改动）")
check(zero_diag is None, "强度 0 不产生补偿诊断")
base_out, base_diag = wc.compensate_wsola(x, RATE, 1.5)
explicit_out, _ = wc.compensate_wsola(x, RATE, 1.5, True, wc.COMPENSATION_STRENGTH)
check(np.array_equal(base_out, explicit_out), "显式默认强度与缺省逐样本一致")
check(base_diag is not None and "strength" in base_diag, "诊断回显实际强度")
full_out, full_diag = wc.compensate_wsola(x, RATE, 1.5, True, 1.0)
check(full_diag is not None and full_diag["strength"] == 1.0, "请求级强度写入诊断")
check(full_out.size == base_out.size == x.size, "强度不改样本数")
freq = np.fft.rfftfreq(x.size, 1 / RATE)
hi = (freq >= 3000) & (freq < 8000)
lo = (freq >= 200) & (freq < 1000)


def hi_ratio(y: np.ndarray) -> float:
    """高频/低频能量比：用相对量，避开峰值收缩带来的整体缩放干扰。"""
    sp = np.abs(np.fft.rfft(y * np.hanning(y.size)))
    return float(sp[hi].sum() / max(sp[lo].sum(), 1e-9))


check(hi_ratio(full_out) > hi_ratio(base_out), "强度 1.0 的相对高频高于默认强度")
check(np.isfinite(full_out).all() and float(np.max(np.abs(full_out))) <= 0.991, "全强度不削波/全有限")

print(f"\nPASS  wsola_compensation {CHECKS} 项")
