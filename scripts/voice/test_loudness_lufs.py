#!/usr/bin/env python3
"""第十六轮：v14 integrated gated LUFS 纯标量响度归一的单元测试。

运行：`scripts/voice/.venv/bin/python scripts/voice/test_loudness_lufs.py`
（venv 自带 scipy；系统 python3 可能缺，见 README 排障）
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import perceptual_align as pa  # noqa: E402
from perceptual_align import (  # noqa: E402
    LUFS_MAX_DB,
    LUFS_TARGETS,
    align_loudness,
    align_loudness_lufs,
    integrated_lufs,
    lufs_from_window_energy,
    lufs_window_energy,
)

RATE = 24000
CHECKS = 0


def check(cond: bool, name: str) -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok  {name}")


def tone(seconds: float, amp: float, freq: float = 220.0, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def noise(seconds: float, amp: float, seed: int, rate: int = RATE) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(seconds * rate)).astype(np.float32)
    return (x / max(float(np.sqrt((x**2).mean())), 1e-9) * amp).astype(np.float32)


# ---------------------------------------------------------------------------
print("=== 1. LUFS 测量口径 ===")

check(pa.K_WEIGHT_AVAILABLE, "venv 提供 scipy，K 加权可用")
check(abs(LUFS_TARGETS["serena"] - (-26.3)) < 1e-9, "serena 目标为两语料折中 -26.3 LUFS")
check(LUFS_MAX_DB == 4.0, "限幅 ±4dB（实测两语料最大需 3.04dB，留余量）")

x1 = tone(3.0, 0.1)
l1 = integrated_lufs(x1, RATE)
check(l1 is not None and math.isfinite(l1), "纯音测得有限 LUFS")
x2 = x1 * 2.0
l2 = integrated_lufs(x2, RATE)
check(abs((l2 - l1) - 20.0 * math.log10(2.0)) < 0.05, "幅度翻倍 → LUFS +6.02dB")

z, centers = lufs_window_energy(x1, RATE)
check(z is not None and centers is not None and z.size > 10, "400ms/100ms 滑窗数量正确")
check(abs(math.log10(centers[1] - centers[0]) - math.log10(0.1)) < 1e-6, "窗口 hop = 100ms")
check(abs(lufs_from_window_energy(z) - integrated_lufs(x1, RATE)) < 1e-9,
      "门控函数与 integrated_lufs 逐值一致（口径唯一）")
check(integrated_lufs(np.zeros(RATE, dtype=np.float32), RATE) is None, "全静音返回 None（诚实降级）")
check(integrated_lufs(tone(0.002, 0.1), RATE) is not None,
      "极短信号按单窗测量（不抛异常）")
check(lufs_window_energy(np.zeros(10, dtype=np.float32), 0) == (None, None),
      "非法采样率返回 None")

# ungated 必须 ≥ gated（相对门只保留响的窗）
lu = integrated_lufs(noise(4.0, 0.08, 7), RATE, gated=False)
lg = integrated_lufs(noise(4.0, 0.08, 7), RATE, gated=True)
check(lu is not None and lg is not None and lu <= lg + 1e-9, "相对门控不会抬高 integrated LUFS")

# ---------------------------------------------------------------------------
print("\n=== 2. 纯标量契约（音色结构上不可能被改） ===")

for amp, seed in ((0.05, 1), (0.12, 2), (0.30, 3)):
    src = noise(3.5, amp, seed)
    out, diag = align_loudness_lufs(src, RATE, "serena")
    assert diag is not None
    ratio = out / np.where(np.abs(src) > 1e-7, src, np.nan)
    ratio = ratio[np.isfinite(ratio)]
    check(float(ratio.std()) < 1e-6, f"amp={amp}: 输出 = 输入 × 单一常数（std<1e-6）")
    check(out.shape == src.shape and out.dtype == np.float32, f"amp={amp}: 时长/形状/dtype 不变")
    check(np.isfinite(out).all() and float(np.max(np.abs(out))) <= 0.990001,
          f"amp={amp}: 有限值且无削波")
    # diag 的 dB 保留 3 位小数，换算回线性增益有 ≤6e-5 的量化误差
    check(abs(float(ratio.mean()) - 10 ** (diag["loudness_db"] / 20.0)) < 1.5e-4,
          f"amp={amp}: 实测增益与诊断 loudness_db 一致")
    check(diag["profile"] == "v14" and diag["scalar"] is True
          and diag["spectral"] is False and diag["edge"] is False,
          f"amp={amp}: 诊断标明纯标量 / 无 EQ / 无边界增益")

# 谱形不变：FFT 幅度谱只差一个常数
src = noise(3.0, 0.1, 11)
out, _ = align_loudness_lufs(src, RATE, "serena")
a = np.abs(np.fft.rfft(src * np.hanning(src.size)))
b = np.abs(np.fft.rfft(out * np.hanning(out.size)))
sel = np.isfinite(a) & (a > a.max() * 1e-4)
ratio = b[sel] / a[sel]
check(float(ratio.std() / max(ratio.mean(), 1e-9)) < 1e-5, "幅度谱形状逐频点等比（不改音色）")

# ---------------------------------------------------------------------------
print("\n=== 3. 收敛、限幅与确定性 ===")

target = LUFS_TARGETS["serena"]
for amp in (0.04, 0.09, 0.18):
    src = noise(4.0, amp, 20 + int(amp * 100))
    before = integrated_lufs(src, RATE)
    out, diag = align_loudness_lufs(src, RATE, "serena")
    after = integrated_lufs(out, RATE)
    improvement = abs(after - target) <= abs(before - target) + 1e-6
    check(improvement, f"amp={amp}: 归一后更接近目标 ({before:.2f}→{after:.2f} LUFS)")
    check(abs(diag["loudness_db"]) <= LUFS_MAX_DB + 1e-9, f"amp={amp}: 增益不超 ±4dB")

very_loud = noise(3.0, 0.9, 31)
out, diag = align_loudness_lufs(very_loud, RATE, "serena")
check(abs(diag["loudness_db"]) <= LUFS_MAX_DB, "极响信号增益被限幅且不削波")
check(float(np.max(np.abs(out))) <= 0.990001, "防削波生效")
very_quiet = noise(3.0, 0.001, 32)
out, diag = align_loudness_lufs(very_quiet, RATE, "serena")
check(abs(diag["loudness_db"]) <= LUFS_MAX_DB, "极轻信号增益被限幅（不无限放大）")

src = noise(3.0, 0.11, 41)
a1, _ = align_loudness_lufs(src.copy(), RATE, "serena")
a2, _ = align_loudness_lufs(src.copy(), RATE, "serena")
check(np.array_equal(a1, a2), "同输入逐样本确定性（无随机 / 无运行中位数）")

# 块间起伏：模拟 6 块不同响度，v14 必须压到 ~0。
# 幅度贴近真机（22 块原始起伏 4.39/4.37dB），不构造超出 ±4dB 限幅能力的极端跨度。
# 合成噪声的绝对电平与真机标定不同，故**按本批中位数临时标定目标**——
# 等价于线上「用同类真实输出的中位数标定」，避免把「目标电平不匹配」
# 误测成「口径无效」。跑完立即恢复常量，不污染后续用例。
pieces = [noise(3.0 + 0.2 * i, 0.04 * (1.12**i), 50 + i) for i in range(6)]
raw_lufs = [integrated_lufs(p, RATE) for p in pieces]
raw_spread = max(raw_lufs) - min(raw_lufs)
orig_lufs_target = LUFS_TARGETS["serena"]
orig_v12_target = pa.LOUDNESS_TARGETS["serena"]["rms_kweighted"]
LUFS_TARGETS["serena"] = float(np.median(raw_lufs))
v12_mids = []
for p in pieces:
    frames, _, _ = pa._windows(p, RATE)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    v12_mids.append(float(np.median(rms[rms > rms.max() * pa.SILENCE_RMS_RATIO])))
pa.LOUDNESS_TARGETS["serena"]["rms_kweighted"] = float(np.median(v12_mids))
try:
    out_lufs = [integrated_lufs(align_loudness_lufs(p, RATE, "serena")[0], RATE) for p in pieces]
    v12_lufs = [integrated_lufs(align_loudness(p, RATE, "serena")[0], RATE) for p in pieces]
finally:
    LUFS_TARGETS["serena"] = orig_lufs_target
    pa.LOUDNESS_TARGETS["serena"]["rms_kweighted"] = orig_v12_target
v14_spread = max(out_lufs) - min(out_lufs)
v12_spread = max(v12_lufs) - min(v12_lufs)
check(raw_spread > 3.0, f"构造的块间原始起伏足够大 ({raw_spread:.2f}dB)")
check(v14_spread < 0.05, f"v14 块间 LUFS 极差压到 {v14_spread:.3f}dB")
check(abs(LUFS_TARGETS["serena"] - orig_lufs_target) < 1e-9, "临时标定后目标常量已恢复")
# 平稳噪声上两种口径高度相关，合成用例只要求「不劣于」；严格优于由
# loudness_drift_probe.py 的 22 块真机数据（3.01/1.65 → 0.00/0.00dB）证明。
check(v14_spread <= v12_spread + 1e-6,
      f"v14 不劣于 v12（{v14_spread:.2f} vs {v12_spread:.2f}dB）")

# ---------------------------------------------------------------------------
print("\n=== 4. 开关与诚实降级 ===")

src = noise(3.0, 0.1, 61)
out, diag = align_loudness_lufs(src, RATE, "serena", enabled=False)
check(out is src and diag is None, "enabled=False 返回同一个数组对象，逐引用零改动")

out, diag = align_loudness_lufs(src, RATE, "unknown_speaker")
check(diag is not None and diag["profile"] == "v12"
      and diag["fallback"] == "no_lufs_target",
      "未标定 speaker 诚实降级到 v12（不猜目标）")
v12_out, _ = align_loudness(src, RATE, "unknown_speaker")
check(np.array_equal(out, v12_out), "降级路径与直接跑 v12 逐样本一致")


def _no_k(_x, _rate):
    return None


orig = pa.k_weight
try:
    pa.k_weight = _no_k
    out, diag = align_loudness_lufs(src, RATE, "serena")
    check(diag is not None and diag["profile"] == "v12"
          and diag["fallback"] == "lufs_measure_failed",
          "K 加权不可用时降级到 v12，绝不编造 LUFS 目标")
finally:
    pa.k_weight = orig

# 服务端 profile 解析：v14 是默认，v12/v11 可请求级回退
import mlx_voice_server as srv  # noqa: E402

check(srv.ALIGN_PROFILE == "v14", "服务端默认 alignProfile=v14")
check(srv.request_align_profile({}) == "v14", "空请求取默认 v14")
for p in ("v11", "v12", "v14"):
    check(srv.request_align_profile({"alignProfile": p}) == p, f"请求级可覆盖为 {p}")
check(srv.request_align_profile({"alignProfile": "V12"}) == "v12", "请求值大小写归一")
check(srv.request_align_profile({"alignProfile": "bogus"}) == "v14", "非法值回退默认，不吞错放行")

print(f"\nPASS  loudness_lufs {CHECKS} 项")
