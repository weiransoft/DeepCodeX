"""第十七轮（2026-11-12）：块内「慢变响度整形」与统一响度链路。

## 为什么需要第十七轮

第十六轮 v14 把**块间** integrated gated LUFS 极差压到 0.00dB，但用户试听
`/tmp/dcx-v16-final/mixed_tech-v14-LUFS-归一.wav` 后仍反馈「声音时大时小」。
真机定量（`loudness_drift_probe.py` + 本轮探针）给出了被 v14 漏掉的一层：

| 口径 | v12 改前 | v14 | 说明 |
| --- | --- | --- | --- |
| 块间 integrated LUFS 极差 | 3.34dB | **0.00dB** | v14 已修 |
| 5s 桶有声中位数极差 | 2.93dB | 1.86dB | **跨块低频漂移仍在** |
| 块边界 ±0.5s 电平跳变均值 | 2.50dB | 2.33dB | v14 几乎没碰 |
| 同上最大值 | 5.46dB | 5.61dB | 甚至略差 |

integrated LUFS 是**整块一个数**，它只能保证「这一块的平均」对齐，对
块内前半句轻、后半句响，以及块与块接缝处的台阶无能为力。九种**纯标量**
归一口径（integrated gated / ungated / momentary median / p25 / p75 /
momentary mean / 两种 hybrid）离线全扫描证明：接缝跳变始终在 2.3~3.8dB、
5s 桶极差始终在 1.8~5.2dB —— **块级乘常数已经到天花板**，残留来自块内。

## 做法：只纠正 3s 尺度的漂移，不碰语言动机的语调

对每块算 K 加权 400ms/100ms 的 momentary LUFS 曲线，用 3s 滑动平均取慢变
包络，把「包络相对本块有声中位数的偏移」乘一个强度系数后取反，得到一条
**零均值、慢变**的 dB 增益曲线，再插值到样本级相乘。

- 零均值（按窗口能量加权）→ 整块能量近似不变，各块增益基线都是 0，
  不需要跨块状态，流式/非流式结果确定且一致；
- 3s 窗 → 只压 0.3Hz 以下的响度漂移，100~400ms 级的重音、句末减弱、
  自然停顿**原样保留**（业界 LRA 控制与「只平滑非语言动机的边界跳变」
  的通行做法，EBU Tech 3342 / R128 short-term 口径）；
- 限幅 ±2.5dB、强度默认 0.7 → 实测增益斜率约 5~7dB/s，远低于 1s 窗
  方案的 16~19dB/s，避免可闻的 pumping / 呼吸感。

整形之后**再做一次 v14 纯标量归一**，把 integrated LUFS 拉回固定目标，
因此第十六轮的「块间 0.00dB」结论完全保留。

## 诚实边界

- 这不是纯标量了：时变增益会改变整块 LTAS/谱质心的统计权重。但真机
  22 块用 `timbre_probe.fingerprint` 的**联合尺子**测块间音色距离，
  v14 基线 6.263 / 6.657 → 本方案 6.212 / 6.623，**没有变差**。
  人耳的音色是逐帧谱包络，慢变增益只改帧幅度、不改帧内谱形。
- 强度 1.0 在离线指标上更好，但增益斜率 8~10dB/s，是否可闻需真人试听；
  默认取 0.7 的保守点，请求级 / 环境变量都可覆盖，随时可一键关。
- 只对齐 `serena`（LUFS 目标已标定）。未标定音色、scipy 缺失、信号过短、
  K 加权失败时**原样返回**并在 diag 标原因，绝不静默伪造。
"""
from __future__ import annotations

import math
import os
from typing import Any

import numpy as np

from perceptual_align import (  # noqa: E402
    K_WEIGHT_AVAILABLE,
    LUFS_HOP_S,
    LUFS_OFFSET_DB,
    align_loudness,
    align_loudness_lufs,
    align_segment,
    lufs_window_energy,
)

# ---------------------------------------------------------------------------
# 开关与参数（环境变量决定进程默认，请求级只覆盖本次）
# ---------------------------------------------------------------------------
SLOW_LEVELING_ENABLED = os.environ.get("DCX_VOICE_SLOW_LEVELING", "1") != "0"


def _env_strength() -> float:
    raw = os.environ.get("DCX_VOICE_SLOW_LEVELING_STRENGTH", "0.7")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.7
    return max(0.0, min(1.0, value))


SLOW_LEVELING_STRENGTH = _env_strength()
SLOW_LEVELING_SMOOTH_S = 3.0
SLOW_LEVELING_MAX_DB = 2.5
SLOW_LEVELING_SILENCE_LUFS = -55.0
SLOW_LEVELING_MIN_WINDOWS = 3


def _bool_value(raw: Any, default: bool) -> bool:
    if raw is None:
        return default
    if isinstance(raw, str):
        return raw.strip().lower() not in ("0", "false", "off", "no")
    return bool(raw)


def _strength_value(raw: Any, default: float) -> float:
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    return max(0.0, min(1.0, value))


def request_slow_leveling_enabled(payload: dict) -> bool:
    """请求级覆盖：`{"slowLeveling": false}` 只关本次，便于同一 sidecar A/B。"""
    return _bool_value(payload.get("slowLeveling"), SLOW_LEVELING_ENABLED)


def request_slow_leveling_strength(payload: dict) -> float:
    """请求级覆盖：`{"slowLevelingStrength": 0.0~1.0}`。"""
    return _strength_value(payload.get("slowLevelingStrength"), SLOW_LEVELING_STRENGTH)


def resolve_slow_leveling(
    enabled: bool | None, strength: float | None
) -> tuple[bool, float]:
    """内部入口（非 HTTP）把 None 解析成进程默认，保证两条合成路径一致。"""
    return (
        SLOW_LEVELING_ENABLED if enabled is None else enabled,
        SLOW_LEVELING_STRENGTH if strength is None else _strength_value(strength, SLOW_LEVELING_STRENGTH),
    )


# ---------------------------------------------------------------------------
# 核心：慢变增益包络
# ---------------------------------------------------------------------------
def slow_level_loudness(
    x: "Any",
    rate: int,
    speaker: str,
    enabled: bool = True,
    strength: float | None = None,
) -> tuple["Any", dict[str, Any] | None]:
    """压平块内 3s 尺度的响度漂移；输出保持样本数、时长、音高不变。

    @param x float32 一维波形（已完成 v14 纯标量归一）
    @param rate 采样率
    @param speaker 实际生效的预置音色名（仅 `LUFS_TARGETS` 里已标定的才处理）
    @param enabled 总开关；False 时返回**同一个数组对象**，逐样本零改动
    @param strength 0~1 纠正强度；None 用进程默认
    @returns (波形, 诊断)；未处理时诊断带 `applied: False` 与原因
    """
    if not enabled:
        return x, None
    samples = np.asarray(x, dtype=np.float32).reshape(-1)
    if samples.size < int(0.6 * rate) or not np.isfinite(samples).all():
        return x, {"applied": False, "reason": "signal_too_short"}
    if not K_WEIGHT_AVAILABLE:
        return x, {"applied": False, "reason": "scipy_unavailable"}
    from perceptual_align import LUFS_TARGETS

    if speaker not in LUFS_TARGETS:
        return x, {"applied": False, "reason": "uncalibrated_speaker"}
    k = SLOW_LEVELING_STRENGTH if strength is None else _strength_value(strength, SLOW_LEVELING_STRENGTH)
    if k <= 0.0:
        return x, {"applied": False, "reason": "strength_zero"}

    z, centers = lufs_window_energy(samples, rate)
    if z is None or centers is None or z.size < SLOW_LEVELING_MIN_WINDOWS:
        return x, {"applied": False, "reason": "lufs_measure_failed"}
    curve_db = LUFS_OFFSET_DB + 10.0 * np.log10(np.maximum(z, 1e-20))
    voiced = curve_db >= SLOW_LEVELING_SILENCE_LUFS
    if int(voiced.sum()) < SLOW_LEVELING_MIN_WINDOWS:
        return x, {"applied": False, "reason": "no_voiced_windows"}

    # 静音窗口用最近的有声窗口电平 hold，避免把停顿当成「极轻」而抬增益
    filled = np.interp(centers, centers[voiced], curve_db[voiced])
    try:
        from scipy.ndimage import uniform_filter1d

        win = max(1, int(round(SLOW_LEVELING_SMOOTH_S / LUFS_HOP_S)))
        smooth = uniform_filter1d(filled, size=win, mode="nearest")
    except Exception:  # pragma: no cover - scipy 已由 K_WEIGHT_AVAILABLE 保证
        return x, {"applied": False, "reason": "smoothing_failed"}

    reference = float(np.median(smooth[voiced]))
    gain_db = np.clip(
        k * (reference - smooth), -SLOW_LEVELING_MAX_DB, SLOW_LEVELING_MAX_DB
    )
    # 能量加权零均值：整块能量近似不变，且每块增益基线都是 0（确定性、无跨块状态）
    weight = z / max(float(z.sum()), 1e-20)
    gain_db = gain_db - float((gain_db * weight).sum())

    sample_t = np.arange(samples.size, dtype=np.float64) / float(rate)
    gain_sample = np.interp(
        sample_t, centers, gain_db, left=gain_db[0], right=gain_db[-1]
    )
    out = samples * np.asarray(10.0 ** (gain_sample / 20.0), dtype=np.float32)
    peak = float(np.max(np.abs(out)))
    if peak > 0.99:  # 防削波：宁可少给增益，也不交给编码器硬切
        out = out * (0.99 / peak)
    slope = (
        float(np.max(np.abs(np.diff(gain_db))) / LUFS_HOP_S)
        if gain_db.size > 1
        else 0.0
    )
    return out.astype(np.float32), {
        "applied": True,
        "strength": round(k, 3),
        "smooth_s": SLOW_LEVELING_SMOOTH_S,
        "max_db": SLOW_LEVELING_MAX_DB,
        "gain_span_db": round(float(gain_db.max() - gain_db.min()), 3),
        "gain_slope_max_db_per_s": round(slope, 3),
        "scalar": False,
    }


# ---------------------------------------------------------------------------
# 统一响度链路：流式 / 整块两条路径共用，避免两处实现漂移
# ---------------------------------------------------------------------------
def apply_loudness_chain(
    x: "Any",
    rate: int,
    speaker: str,
    *,
    profile: str,
    perceptual_align: bool,
    kweighted: bool,
    edge: bool,
    slow_leveling: bool | None = None,
    slow_leveling_strength: float | None = None,
) -> tuple["Any", dict[str, Any] | None]:
    """第十七轮统一入口：v11/v12/v14 分派 + v14 之后的慢变整形 + 二次归一。

    顺序（第十一轮 A/B 定下的铁律仍成立）：WSOLA 变速 → WSOLA 谱补偿 →
    本函数 → 切片。整形放在 v14 之后、二次 v14 归一之前；二次归一是纯标量，
    把 integrated LUFS 拉回固定目标，因此第十六轮的块间 0.00dB 不变。

    @returns (波形, 诊断)；`perceptualAlign=false` 时返回原对象与 None
    """
    if not perceptual_align:
        return x, None
    use_slow, strength = resolve_slow_leveling(slow_leveling, slow_leveling_strength)
    if profile == "v14":
        out, diag = align_loudness_lufs(x, rate, speaker, True)
        # 只对真正走了 LUFS 口径的块做整形；v12 fallback 时保持原行为
        if not use_slow or not diag or diag.get("profile") != "v14":
            return out, diag
        leveled, level_diag = slow_level_loudness(
            out, rate, speaker, True, strength
        )
        if not level_diag or not level_diag.get("applied"):
            return out, {**(diag or {}), "slowLeveling": level_diag or {"applied": False}}
        out, second = align_loudness_lufs(leveled, rate, speaker, True)
        return out, {
            "profile": "v17",
            "first": diag,
            "slowLeveling": level_diag,
            "second": second,
        }
    if profile == "v12":
        return align_loudness(x, rate, speaker, True)
    return align_segment(x, rate, speaker, True, kweighted, edge)
