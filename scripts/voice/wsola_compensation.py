"""WSOLA 变速的确定性谱失真补偿（2026-11-11 第十三轮）。

## 为什么需要

长文本被切成多块后，每块用 `time_stretch_wsola(samples, seg_speed)` 按实测语速
单独变速。`seg_speed` 是逐段不同的（真机 mixed_tech 实测 0.76~1.54，跨度 2.03×），
而 WSOLA 的帧重叠相加对高频有确定性衰减，且**衰减量只由倍率决定**：

| 倍率 | 1-3k | 3-8k | 8-12k |
|---|---|---|---|
| 1.00 | 0 | 0 | 0 |
| 1.15 | -1.00 | -2.03 | -1.80 dB |
| 1.30 | -1.45 | -2.36 | -2.58 |
| 1.85 | -2.35 | -3.55 | -3.22 |

标定方式：10 块不同文本（纯中文 / 中英混排，2.6~7.6s）各施加 7 个倍率，
测有声帧幅度谱的**绝对频带能量**相对倍率=1 的偏差。跨文本标准差最大
**0.35dB**，说明这是与文本内容无关的 DSP 失真，可以统一补偿。

## 与第十/十一轮「逐段 EQ」的本质区别

v10/v11 把每段的 LTAS 拉向一个固定画像，增益由**该段测到的谱**决定，
方向和幅度随文本音素变化，等于每句套了不同 EQ，主观听感反而变差（第十二轮
已回退）。本模块的增益**只由 seg_speed 决定**：同一倍率的所有段拿到完全相同
的曲线，补偿的是「变速本身造成的衰减」，把谱拉回该段未经变速的样子，
**保留块间由文本造成的自然差异**。

## 边界

- 不动时长、不动音高、不改语速；只做幅度谱补偿。
- 曲线按标定表线性插值，端点钳位到伺服的 [0.75, 1.85] 区间。
- 倍率=1、开关关闭、极短/全静音/非有限输入一律返回**调用方原对象**，
  逐引用、逐样本零改动，保证回退无副作用。

## 开关

`DCX_VOICE_WSOLA_COMPENSATION=0` 全局回退；请求体
`{"wsolaCompensation": false}` 可在同一 sidecar 上做 A/B（语义同 `shortGap`）。
`DCX_VOICE_WSOLA_COMPENSATION_STRENGTH` 设定默认强度；请求体
`{"wsolaCompensationStrength": 0.9}` 可在**同一进程内**逐请求覆盖强度，
用于真机强度扫描，不必重启 sidecar（2026-11-11 第十四轮）。
"""
from __future__ import annotations

import math
import os
from typing import Any

import numpy as np

import perceptual_align as pa

# 复用了第十轮的 FFT-OLA 与频带定义：同一套窗/重叠参数，避免两处谱处理口径漂移
BAND_EDGES = pa.BAND_EDGES
FFT_FRAME = pa.FFT_FRAME
CURVE_SMOOTH_HZ = pa.CURVE_SMOOTH_HZ

# 倍率 → 四频带「相对倍率=1」的绝对能量偏差 dB。
# 由 /tmp/dcx_wsola_calib.py 与 0.75/0.80 补测标定，10 块不同文本取均值。
CALIBRATION: tuple[tuple[float, tuple[float, float, float, float]], ...] = (
    (0.75, (-0.09, -0.40, -0.65, -0.56)),
    (0.80, (-0.15, -0.35, -0.43, -0.28)),
    (0.85, (-0.11, -0.57, -0.90, -0.90)),
    (1.00, (0.00, 0.00, 0.00, 0.00)),
    (1.15, (-0.02, -1.00, -2.03, -1.80)),
    (1.30, (-0.12, -1.45, -2.36, -2.58)),
    (1.50, (-0.07, -1.75, -2.86, -2.48)),
    (1.70, (-0.03, -1.93, -3.28, -3.18)),
    (1.85, (-0.11, -2.35, -3.55, -3.22)),
)

# 补偿强度。离线强度扫描（22 块真机波形，见 README 第十三轮）：
#   强度  pure_cn 谱质心极差   mixed_tech 谱质心极差
#   0.0      44.62%              38.11%
#   0.6      38.47% (-6.15)      43.04% (+4.94)
#   0.9      35.36% (-9.26)      45.69% (+7.58)
#   1.0      34.24% (-10.39)     46.49% (+8.38)
# pure_cn 单调改善，mixed_tech 任何强度都单调退化——后者基线「高频~倍率」
# 斜率本就接近 0（英文块倍率大、原始高频低，DSP 衰减与文本差异恰好抵消），
# 补掉 DSP 会暴露文本固有差异。这里不追求统计极差最小（那正是 v11 翻车原因），
# 取保守折中 0.6：完全补偿会放大齿音，且把 mixed_tech 退化控制在减半幅度。
# 可用 DCX_VOICE_WSOLA_COMPENSATION_STRENGTH 调整，主观听感以对比音频为准。
try:
    COMPENSATION_STRENGTH = max(
        0.0, min(1.0, float(os.environ.get("DCX_VOICE_WSOLA_COMPENSATION_STRENGTH", "0.6")))
    )
except ValueError:
    COMPENSATION_STRENGTH = 0.6
MAX_COMPENSATION_DB = 4.0
# 倍率足够接近 1 时标定表本身接近全 0，直接跳过以省一次 FFT-OLA
RATIO_DEADBAND = 0.02
MIN_SAMPLES = FFT_FRAME * 2

WSOLA_COMPENSATION_ENABLED = os.environ.get("DCX_VOICE_WSOLA_COMPENSATION", "1") != "0"


def request_wsola_compensation_enabled(payload: dict) -> bool:
    """请求级开关；缺省时跟随环境变量（默认开）。"""
    raw = payload.get("wsolaCompensation")
    if raw is None:
        return WSOLA_COMPENSATION_ENABLED
    if isinstance(raw, str):
        return raw.strip().lower() not in ("0", "false", "off", "no")
    return bool(raw)


def request_wsola_compensation_strength(payload: dict) -> float | None:
    """请求级强度覆盖；缺省/非法值返回 None（跟随模块默认，诚实降级）。

    只接受有限数值并钳位到 [0, 1]；字符串用 float() 解析，解析失败一律
    None，不把坏值当成 0 或 1。这样坏请求不会静默改变线上音色。
    """
    raw = payload.get("wsolaCompensationStrength")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return max(0.0, min(1.0, value))


def resolve_strength(strength: float | None) -> float:
    """None → 模块默认；显式值再钳一次，防调用方绕过请求级校验。"""
    if strength is None:
        return COMPENSATION_STRENGTH
    return max(0.0, min(1.0, float(strength)))


def band_compensation_db(ratio: float, strength: float | None = None) -> list[float]:
    """按倍率插值出四频带的补偿增益 dB（非负，与输入波形无关）。

    `strength=None` 走模块默认，行为与第十四轮之前逐字一致。
    """
    s = resolve_strength(strength)
    r = max(CALIBRATION[0][0], min(CALIBRATION[-1][0], float(ratio)))
    rows = CALIBRATION
    for i in range(len(rows) - 1):
        lo, hi = rows[i], rows[i + 1]
        if lo[0] <= r <= hi[0]:
            t = 0.0 if hi[0] == lo[0] else (r - lo[0]) / (hi[0] - lo[0])
            devs = [a + (b - a) * t for a, b in zip(lo[1], hi[1])]
            break
    else:
        devs = list(rows[-1][1])
    return [max(0.0, min(MAX_COMPENSATION_DB, -d * s)) for d in devs]


def compensation_curve_db(
    ratio: float, rate: int, strength: float | None = None
) -> np.ndarray:
    """四频带增益 → 平滑 rfft 频率轴曲线（dB）。只依赖倍率、采样率与强度。"""
    band_db = band_compensation_db(ratio, strength)
    freqs = np.fft.rfftfreq(FFT_FRAME, d=1.0 / rate)
    edges = np.asarray(BAND_EDGES[1:-1], dtype=np.float64)
    curve = np.interp(
        freqs, edges, np.asarray(band_db[1:], dtype=np.float64),
        left=band_db[0], right=band_db[-1],
    )
    width = max(1, int(CURVE_SMOOTH_HZ / (rate / FFT_FRAME)))
    kernel = np.hanning(width * 2 + 1).astype(np.float64)
    kernel /= kernel.sum()
    return np.convolve(curve, kernel, mode="same")


def compensate_wsola(
    x: "Any",
    rate: int,
    ratio: float,
    enabled: bool = True,
    strength: float | None = None,
) -> tuple["Any", dict[str, Any] | None]:
    """补偿 WSOLA 变速引入的确定性高频衰减。

    @param x float32 一维波形（**已变速**）
    @param rate 采样率
    @param ratio 该段实际施加的 WSOLA 倍率 seg_speed
    @param enabled 总开关；False 时返回同一个数组对象
    @param strength 请求级强度覆盖；None 时跟随模块默认（零回归）
    @returns (波形, 诊断信息)；跳过补偿时诊断为 None
    """
    if not enabled or not math.isfinite(ratio) or abs(ratio - 1.0) < RATIO_DEADBAND:
        return x, None
    samples = np.asarray(x, dtype=np.float32).reshape(-1)
    if samples.size < MIN_SAMPLES or not np.isfinite(samples).all():
        return x, None
    if float(np.max(np.abs(samples))) < 1e-6:
        return x, None

    band_db = band_compensation_db(ratio, strength)
    if max(band_db) < 1e-4:
        return x, None
    curve_db = compensation_curve_db(ratio, rate, strength)
    out = pa._apply_gain_curve(samples, curve_db)
    if out.shape != samples.shape or not np.isfinite(out).all():
        return x, None
    # 补偿最多 +4dB，极端峰值时收缩防削波；后续 align_loudness 会重新测 RMS
    peak = float(np.max(np.abs(out)))
    if peak > 0.99:
        out = out * (0.99 / peak)
    return out.astype(np.float32), {
        "ratio": round(float(ratio), 4),
        "strength": round(resolve_strength(strength), 4),
        "band_db": [round(v, 3) for v in band_db],
        "peak_before": round(float(np.max(np.abs(samples))), 4),
        "peak_after": round(min(peak, 0.99), 4),
    }
