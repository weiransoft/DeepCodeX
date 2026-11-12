"""段级感知一致性对齐（2026-11-08 第十轮）。

## 要解决的问题

第九轮把「语速 / 音色身份」收敛后（单元语速极差 0.69%、同句重复合成逐位
相同），人耳仍能听出块间差异。真机实测（8791、sinan/1.35、pure_cn 9 块）：

- 有声帧 RMS 极差 **3.77dB**（约 1.55 倍音量）；
- 长时平均谱 1-3k / 3-8k / 8-12k 频带占比极差 **174% / 173% / 135%**；
- F0 极差 22.19%，但单请求整段合成的内部时间窗也有 41% —— 那是文本语调，
  不是音色漂移，本模块**不动音高**（移调反而更像换人）。

同波形只改 WSOLA 倍率的对照实验表明：0.89~1.63 倍变速会单独造成 8-12k
频带 47% 的高频丢失，与倍率单调相关；但倍率与块间各指标的相关性 |r|≤0.23，
只能解释约三分之一。主因仍是 **CustomVoice 对每段文本独立预测韵律，请求之间
没有共享声学状态**（当前 CustomVoice 权重不含 speaker_encoder，底层
`ref_audio` voice-clone 路径只对 base 模型开放，见 mlx_audio 源码）。

## 做法

不触碰模型、不改时长、不改音高，只在**段级**（不是流式 chunk 级）做一次
确定性后处理，把每段的响度与谱包络拉向同一份按 speaker 标定的参考画像：

1. 有声帧 RMS → 目标响度，增益限幅 ±3dB；
2. 三个中高频带相对低频带的能量占比 → 目标占比，增益限幅 ±2.5dB；
3. 用 FFT 重叠相加应用一条平滑的频域增益曲线（幅度谱域，线性相位不变）。

参考画像由 speaker 查表；**未标定的音色原样返回**（诚实降级，不猜一个目标
去强行拉）。整段用同一条曲线，因此流式切块之间不会引入新的音量跳变。

## 第十一轮（2026-11-08）：从「物理能量」升级到「感知响度 + 接缝」

第十轮把未加权 `rms_voiced` 极差压到 0.44/1.42dB 后，人耳仍能听出细微差异。
真机诊断（`speed=1.3` 生产态、pure_cn/mixed_tech 22 块）给出两个硬数据：

- **ITU-R BS.1770 K 加权**感知响度极差 0.84/1.03dB，且加权/未加权比值在
  1.010~1.101 之间逐块波动 —— 未加权 RMS 不看人耳频率灵敏度，**系统性地
  掩盖了偏亮块的感知响度**。业界（EBU R128 / Google Assistant -19 LUFS /
  CSDN 分句响度综述）一致把 K 加权列为分段 TTS 的归一化黄金标准。
- **段首能量相对段内在 0.13~3.70 倍之间乱跳（28 倍跨度）**，同口径边界
  台阶 |max| 22.44/16.80dB。这正是 MagpieTTS-LF 论文与长文本工程实践里
  说的 "prosody reset / boundary energy discontinuity"：每块独立起头，
  句尾收尾与下一句起音的落差逐次不同，耳朵听成「接缝处换了一下人」。

所以本轮在两个地方做增量，均不改时长、不动音高、不碰模型：

1. **响度目标换口径**：阶段二的归一目标由未加权 RMS 换成 K 加权有声帧 RMS。
   只归一一次，不是叠加两个增益。
2. **边界能量温和压缩**：把段首/段尾 100ms 的有声能量向参考比例拉，**限幅
   ±3dB 后再打五折**（实际最多 ±1.5dB），用半 Hann 斜坡平滑过渡；按能量
   门控，静音边直接跳过。目标是让接缝落差「每次都一样」，不是把自然句尾
   衰减压成零 —— 强行抹平语调反而更像换人。

**不做的三件事（能力边界，见 README）**：stateful inference / 历史文本编码
（要改模型推理）、context priming（CustomVoice 的 `instruct` 是风格指令不是
文本前缀，第九轮实测会吞字）、扩大单请求文本（前端 48 字是有实测依据的
`max_tokens` 退化硬上限）。

## 开关

`DCX_VOICE_PERCEPTUAL_ALIGN=0` 一键回退到第九轮；请求体
`{"perceptualAlign": false}` 可在同一 sidecar 上做 A/B（语义同 `shortGap`）。
第十一轮两个增量各有独立开关：`DCX_VOICE_KWEIGHTED_ALIGN` /
`DCX_VOICE_EDGE_ALIGN`（默认开），请求级 `kweightedAlign` / `edgeAlign`。
两个都关时，输出与第十轮**逐样本一致**。关闭时逐样本返回原数组。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

# 画像测量必须与标定脚本 / continuity.py 用**同一口径**（40ms 帧、20ms hop、
# 0.01 相对峰值阈值）。口径不一致会让目标响度系统性偏移：真机 A/B 曾出现
# 「对齐后各块都偏低 0.5~1.7dB」的假收敛。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from continuity import SILENCE_RMS_RATIO, _windows  # noqa: E402

# 长时平均谱的频带边界（Hz），与感知诊断脚本一致
BAND_EDGES: tuple[int, ...] = (0, 1000, 3000, 8000, 12000)

# 单段补偿上限：宁可留一点残余差异，也不把声音拉到发闷/发飘
MAX_LOUDNESS_DB = 3.0
MAX_BAND_DB = 2.5

# FFT 重叠相加参数：hann 窗 + 半窗 hop 满足 COLA，显式累加窗平方和做归一化
FFT_FRAME = 2048
FFT_HOP = FFT_FRAME // 2
# 频带增益曲线在频带边界的平滑宽度（Hz），避免阶跃产生 pre-echo
CURVE_SMOOTH_HZ = 250.0

# ---------------------------------------------------------------------------
# 第十一轮：ITU-R BS.1770-4 K 加权（pre-filter 两级 biquad）
#
# stage1 high-shelf +4dB @1681.974Hz（RBJ，S=1）模拟人耳 2~5kHz 灵敏度；
# stage2 二阶 high-pass @38.135Hz Q=0.5 去掉低频轰鸣/DC。
# 系数按当前采样率实时计算，不硬编码官方给的 48kHz 表（TTS 输出是 24kHz）。
# ---------------------------------------------------------------------------
try:
    from scipy.signal import lfilter as _lfilter

    K_WEIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - 生产 venv 自带 scipy，此处保留诚实降级
    _lfilter = None
    K_WEIGHT_AVAILABLE = False

K_SHELF_HZ = 1681.974
K_SHELF_DB = 4.0
K_HP_HZ = 38.135
K_HP_Q = 0.5

# 段边界能量压缩：100ms 窗、限幅 ±3dB 后打五折 ⇒ 实际最多 ±1.5dB
EDGE_WIN_S = 0.10
EDGE_MIN_VOICED_SAMPLES = 100
EDGE_ABS_THR_RATIO = 0.02
EDGE_MAX_GAIN_DB = 3.0
EDGE_SOFTEN = 0.5


def _biquad_shelf(rate: int) -> tuple[np.ndarray, np.ndarray]:
    """RBJ high-shelf；返回 (b, a)，a[0] 已归一。"""
    gain = 10.0 ** (K_SHELF_DB / 40.0)
    w0 = 2.0 * math.pi * K_SHELF_HZ / rate
    alpha = math.sin(w0) / 2.0 * math.sqrt((gain + 1.0 / gain) * 2.0)
    cos_w, sq = math.cos(w0), 2.0 * math.sqrt(gain) * alpha
    b = np.array([
        gain * ((gain + 1) + (gain - 1) * cos_w + sq),
        -2 * gain * ((gain - 1) + (gain + 1) * cos_w),
        gain * ((gain + 1) + (gain - 1) * cos_w - sq),
    ])
    a = np.array([
        (gain + 1) - (gain - 1) * cos_w + sq,
        2 * ((gain - 1) - (gain + 1) * cos_w),
        (gain + 1) - (gain - 1) * cos_w - sq,
    ])
    return b / a[0], a / a[0]


def _biquad_highpass(rate: int) -> tuple[np.ndarray, np.ndarray]:
    """RBJ 二阶 high-pass；返回 (b, a)，a[0] 已归一。"""
    w0 = 2.0 * math.pi * K_HP_HZ / rate
    alpha = math.sin(w0) / (2.0 * K_HP_Q)
    cos_w = math.cos(w0)
    b = np.array([(1 + cos_w) / 2, -(1 + cos_w), (1 + cos_w) / 2])
    a = np.array([1 + alpha, -2 * cos_w, 1 - alpha])
    return b / a[0], a / a[0]


def k_weight(x: np.ndarray, rate: int) -> np.ndarray | None:
    """K 加权滤波；scipy 不可用时返回 None（调用方诚实降级到未加权口径）。"""
    if not K_WEIGHT_AVAILABLE or _lfilter is None or rate <= 0:
        return None
    y = np.asarray(x, dtype=np.float64)
    for b, a in (_biquad_shelf(rate), _biquad_highpass(rate)):
        y = _lfilter(b, a, y)
    return y


def _kweighted_voiced_rms(x: np.ndarray, rate: int) -> float | None:
    """K 加权域的有声帧 RMS 中位数（帧/阈值口径与 segment_profile 完全一致）。"""
    weighted = k_weight(x, rate)
    if weighted is None:
        return None
    frames, _, _ = _windows(weighted, rate)
    if frames.shape[0] < 2:
        return None
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    peak = float(rms.max()) if rms.size else 0.0
    if peak <= 0:
        return None
    voiced = rms[rms > peak * SILENCE_RMS_RATIO]
    return float(np.median(voiced)) if voiced.size else None


def _edge_voiced_rms(x: np.ndarray, rate: int, side: str) -> float | None:
    """段首/段尾 100ms 内**有声样本**的 RMS（全局分位绝对阈值，非窗口相对峰值）。

    与 `consistency_probe.py` 的 `edge_rms()` 同口径；探针的 `boundary_steps()`
    用相对窗口阈值会把静音窗里的噪声放大成 25dB 伪影，这里刻意避开。
    """
    win = int(EDGE_WIN_S * rate)
    if win < EDGE_MIN_VOICED_SAMPLES or x.size < win:
        return None
    part = x[:win] if side == "head" else x[-win:]
    thr = float(np.percentile(np.abs(x), 99)) * EDGE_ABS_THR_RATIO
    voiced = part[np.abs(part) > thr]
    if voiced.size < EDGE_MIN_VOICED_SAMPLES:
        return None
    return float(np.sqrt((voiced.astype(np.float64) ** 2).mean()))


def _align_edges(
    x: np.ndarray, rate: int, profile: dict[str, Any], rms_ref: float
) -> tuple[np.ndarray, dict[str, Any]]:
    """把段首/尾 100ms 的能量温和拉向参考比例，减少块间接缝落差的**方差**。

    不追求把台阶压到 0（句尾自然衰减是语调），只让每次接缝差不多。
    增益按半 Hann 斜坡从端点向内过渡到 1，避免突变产生新的台阶。
    """
    out = x.astype(np.float32).copy()
    win = int(EDGE_WIN_S * rate)
    t = np.linspace(0.0, 1.0, win, dtype=np.float64)
    diag: dict[str, Any] = {}
    for side, key in (("head", "head_ratio"), ("tail", "tail_ratio")):
        current = _edge_voiced_rms(out, rate, side)
        target = float(profile[key]) * rms_ref
        if current is None or current <= 0 or target <= 0:
            diag[f"{side}_gain_db"] = None  # 能量门控：静音边不碰
            continue
        raw_db = 20.0 * math.log10(target / current)
        gain_db = max(-EDGE_MAX_GAIN_DB, min(EDGE_MAX_GAIN_DB, raw_db)) * EDGE_SOFTEN
        gain = float(10.0 ** (gain_db / 20.0))
        # head: 端点=gain → 窗末=1；tail: 端点前=1 → 端点=gain
        ramp = (gain + (1.0 - gain) * (0.5 - 0.5 * np.cos(math.pi * t))
                if side == "head"
                else 1.0 + (gain - 1.0) * (0.5 - 0.5 * np.cos(math.pi * t)))
        if side == "head":
            out[:win] *= ramp.astype(np.float32)
        else:
            out[-win:] *= ramp.astype(np.float32)
        diag[f"{side}_gain_db"] = round(gain_db, 3)
        diag[f"{side}_rms_before"] = round(current, 6)
    return out, diag


# 按 speaker 标定的参考画像。
#
# 标定来源：2026-11-08 真机 `longtext_probe` 生产链路（8791、sinan/serena、
# speed=1.35、TNS on），pure_cn 语料按前端 14/48 字切 9 块，取各块中位数；
# 并用「整段单请求」的等长窗口中位数交叉验证（rms 0.0404 vs 0.0392，
# 1-3k 0.0418 vs 0.0423，量级一致）。高频带取两组之间的折中值，避免把
# 本就偏亮的中英混排块压暗。样本量有限，故配合上面的限幅使用。
PERCEPTUAL_PROFILES: dict[str, dict[str, Any]] = {
    "serena": {
        # 第十轮：speed=1.35 标定，未加权口径
        "rms_voiced": 0.0398,
        "ltas": (0.905, 0.042, 0.025, 0.014),
        # 第十一轮：speed=1.3 当前生产态，pure_cn 9 块 + mixed_tech 13 块
        # 真机中位数。K 加权 0.040880/0.040838 → 0.04086；
        # head/rms 1.755/1.305 → 1.40，tail/rms 0.418/0.361 → 0.39。
        # 取两组折中而非单语料最优，避免过拟合某一类文本。
        "rms_kweighted": 0.04086,
        "head_ratio": 1.40,
        "tail_ratio": 0.39,
    },
}


def _voiced_frame_mask(frames: np.ndarray) -> np.ndarray:
    """相对峰值判定有声帧（复用 continuity.py 的口径与阈值）。"""
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    peak = float(rms.max()) if rms.size else 0.0
    if peak <= 0:
        return np.zeros(rms.size, dtype=bool)
    return rms > peak * SILENCE_RMS_RATIO


def segment_profile(x: np.ndarray, rate: int) -> dict[str, Any] | None:
    """测一段波形的感知画像：有声帧 RMS 中位数 + 四频带长时平均谱占比。

    帧参数/阈值与 `continuity._windows()` 以及标定脚本完全一致；FFT 重叠
    相加另用 `FFT_FRAME`（那是**处理**帧长，与测量口径无关）。

    @param x float32 一维波形
    @param rate 采样率
    @returns 画像；样本不足 / 全静音时返回 None（调用方应原样放行）
    """
    if rate <= 0 or x.size < int(rate * 0.04):
        return None
    frames, width, _ = _windows(x, rate)
    if frames.shape[0] < 2:
        return None
    vf = frames[_voiced_frame_mask(frames)]
    if vf.size == 0:
        return None
    rms_voiced = float(
        np.median(np.sqrt((vf.astype(np.float64) ** 2).mean(axis=1)))
    )
    if rms_voiced <= 0:
        return None

    window = np.hanning(width).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(vf * window, axis=1)).mean(axis=0)
    energy = spectrum.astype(np.float64) ** 2
    freqs = np.fft.rfftfreq(width, d=1.0 / rate)
    bands = [
        float(energy[(freqs >= lo) & (freqs < hi)].sum())
        for lo, hi in zip(BAND_EDGES[:-1], BAND_EDGES[1:])
    ]
    total = sum(bands)
    if total <= 0:
        return None
    profile: dict[str, Any] = {
        "rms_voiced": rms_voiced,
        "ltas": [b / total for b in bands],
    }
    # K 加权口径：scipy 不可用或信号异常时为 None，调用方**诚实降级**到
    # 未加权 RMS，不编造一个目标值。
    profile["rms_kweighted"] = _kweighted_voiced_rms(x, rate)
    return profile


def _gain_curve_db(
    current: dict[str, Any], target: dict[str, Any], rate: int
) -> tuple[np.ndarray, dict[str, Any]]:
    """由当前/目标画像算**纯谱形**的平滑频域增益曲线（dB）与诊断信息。

    刻意不含响度增益：改谱形本身就会改变整体 RMS，若把两者的 dB 直接相加，
    响度会过冲/欠冲（真机 A/B 实测：目标 0.0398 的块反而被压到 0.0305）。
    响度由 `align_segment()` 在谱形补偿**之后**重新测量再单独施加。
    """
    cur, tgt = current["ltas"], target["ltas"]
    base_cur, base_tgt = max(cur[0], 1e-9), max(tgt[0], 1e-9)
    band_db = [0.0]
    for i in range(1, len(tgt)):
        cur_ratio = max(cur[i], 1e-9) / base_cur
        tgt_ratio = max(tgt[i], 1e-9) / base_tgt
        raw = 10.0 * math.log10(max(tgt_ratio / cur_ratio, 1e-9))
        band_db.append(max(-MAX_BAND_DB, min(MAX_BAND_DB, raw)))

    freqs = np.fft.rfftfreq(FFT_FRAME, d=1.0 / rate)
    # 分段常数 → 平滑过渡，避免频带边界的锐利台阶
    edges = np.asarray(BAND_EDGES[1:-1], dtype=np.float64)
    curve = np.interp(freqs, edges, np.asarray(band_db[1:], dtype=np.float64),
                      left=band_db[0], right=band_db[-1])
    width = max(1, int(CURVE_SMOOTH_HZ / (rate / FFT_FRAME)))
    kernel = np.hanning(width * 2 + 1).astype(np.float64)
    kernel /= kernel.sum()
    curve = np.convolve(curve, kernel, mode="same")
    return curve, {"band_db": [round(v, 3) for v in band_db]}


def _apply_gain_curve(x: np.ndarray, curve_db: np.ndarray) -> np.ndarray:
    """FFT 重叠相加应用幅度增益；curve 全 0 时输出与原信号逐样本近似相等。"""
    from numpy.lib.stride_tricks import sliding_window_view

    gain = (10.0 ** (curve_db / 20.0)).astype(np.float32)
    pad = FFT_FRAME
    padded = np.pad(x.astype(np.float32), (pad, pad), mode="constant")
    frames = sliding_window_view(padded, FFT_FRAME)[::FFT_HOP]
    window = np.hanning(FFT_FRAME).astype(np.float32)
    windowed = frames * window
    spec = np.fft.rfft(windowed, axis=1)
    restored = np.fft.irfft(spec * gain, n=FFT_FRAME, axis=1) * window

    out = np.zeros(padded.size, dtype=np.float64)
    weight = np.zeros(padded.size, dtype=np.float64)
    starts = np.arange(frames.shape[0]) * FFT_HOP
    for start, frame in zip(starts, restored):
        out[start : start + FFT_FRAME] += frame
        weight[start : start + FFT_FRAME] += window.astype(np.float64) ** 2
    np.divide(out, weight, out=out, where=weight > 1e-9)
    return out[pad : pad + x.size].astype(np.float32)


def align_segment(
    x: "Any",
    rate: int,
    speaker: str,
    enabled: bool = True,
    kweighted: bool = False,
    edge: bool = False,
) -> tuple["Any", dict[str, Any] | None]:
    """把一段 TTS 波形的响度与谱包络对齐到该 speaker 的参考画像。

    @param x float32 一维波形（已裁静音、已变速）
    @param rate 采样率
    @param speaker 实际生效的预置音色名（如 `serena`）
    @param enabled 总开关；False 时**返回同一个数组对象**，逐样本零改动
    @param kweighted 第十一轮：响度目标改用 K 加权感知响度（默认 False = 第十轮）
    @param edge 第十一轮：段首尾 100ms 边界能量温和压缩（默认 False = 第十轮）
    @returns (波形, 诊断信息)；跳过对齐时诊断为 None

    `kweighted` / `edge` 同时为 False 时，输出与第十轮**逐样本一致**，
    这是 A/B 的对照组，也是回退保证。
    """
    # 所有跳过路径都返回**调用方传入的原对象**：下游 `samples, _ = ...` 拿回
    # 的必须逐样本、逐引用零改动，回退时不能悄悄换成一个 reshape 视图。
    if not enabled or speaker not in PERCEPTUAL_PROFILES:
        return x, None
    samples = np.asarray(x, dtype=np.float32).reshape(-1)
    if samples.size < int(0.2 * rate) or not np.isfinite(samples).all():
        return x, None
    current = segment_profile(samples, rate)
    if current is None:
        return x, None
    target = PERCEPTUAL_PROFILES[speaker]
    curve_db, diag = _gain_curve_db(current, target, rate)

    # 阶段一：整谱形（可能改变整体能量）
    shaped = _apply_gain_curve(samples, curve_db) if np.any(curve_db) else samples
    # 阶段二：按**补偿后**的实测响度单独归一，避免与谱增益叠加造成过冲。
    # 第十一轮可把目标口径换成 K 加权；不可用时诚实退回未加权，不编造目标。
    after_shape = segment_profile(shaped, rate)
    if after_shape is None:
        return x, None
    loud_key = "rms_kweighted" if kweighted and K_WEIGHT_AVAILABLE else "rms_voiced"
    target_loud = float(target[loud_key])
    after_loud = after_shape.get(loud_key)
    if after_loud is None or after_loud <= 0:
        loud_key = "rms_voiced"
        target_loud = float(target["rms_voiced"])
        after_loud = after_shape["rms_voiced"]
    loud_db = 20.0 * math.log10(max(target_loud / max(after_loud, 1e-9), 1e-9))
    loud_db = max(-MAX_LOUDNESS_DB, min(MAX_LOUDNESS_DB, loud_db))
    gain = float(10.0 ** (loud_db / 20.0))
    aligned = shaped * gain

    # 阶段三（第十一轮）：边界能量。用**对齐后**的段内未加权 RMS 作参考，
    # 这样 head/tail 目标会跟着整体响度走，不会与阶段二互相打架。
    if edge:
        ref_rms = float(after_shape["rms_voiced"]) * gain
        aligned, edge_diag = _align_edges(aligned, rate, target, ref_rms)
        diag["edge"] = edge_diag

    # 防削波：极端峰值时宁可少给一点增益，也不把波形交给 encode_wav_bytes 硬切
    peak = float(np.max(np.abs(aligned)))
    if peak > 0.99:
        aligned = aligned * (0.99 / peak)
    aligned = aligned.astype(np.float32)

    diag.update({
        "speaker": speaker,
        "loudness_key": loud_key,
        "loudness_db": round(loud_db, 3),
        "before_rms_voiced": round(current["rms_voiced"], 6),
        "after_rms_voiced": round(after_shape["rms_voiced"] * gain, 6),
        "before_ltas": [round(v, 5) for v in current["ltas"]],
    })
    return aligned, diag


# ---------------------------------------------------------------------------
# 第十二轮（2026-11-09）：回退「逐段 EQ + 边界增益」，只做温和响度归一
#
# 用户实测回归：第十一轮客观指标更好（K 加权响度极差 0.14/0.15dB），但主观
# 「不同句子明显不一样，比前面还差」。真机逐段处理量诊断（22 块）给出原因：
#
# - **频带增益曲线逐段方向相反且频繁打满 ±2.5dB 限幅**：同一篇里既有
#   [0,-2.5,-2.5,-2.5]（压中高频）也有 [0,+1.75,+1.46,-0.28]（提中频），
#   等于给每句施加**不同的 EQ**——这才是「音色一句一个样」的直接来源。
#   LTAS 段间差本来就主要由文本音素决定（与第九轮 F0/质心同理），强行拉向
#   单点画像只会扭曲，不会统一。
# - **响度补偿打满 ±3dB**（mixed_tech 三块以上）：硬编码目标 0.04086 低于
#   技术英文语料的实际中位数 0.04795，钳制后各段被压的程度参差不齐。
# - **边界增益在段间正负交替打满 ±1.5dB**：接缝处「这句起音被压、下句被推」。
#
# 业界做法与第十/十一轮的「逐段孤立归一化」相反：Xie 等综述指出逐段孤立优化
# 会忽略跨段响度趋势、无法保证平滑过渡，推荐「良好局部韵律 + 轻微全局归一」；
# 接缝应使用等功率 crossfade，而不是逐段边界增益（本模块因此**不再**做边界
# 增益，而不是换一种更激进的边界处理）。
#
# 所以第十二轮只保留**响度**这一个不伤害音色的维度：
# - 目标改为 22 块真实输出（pure_cn 9 + mixed_tech 13）的**合并中位数**，
#   K 加权 0.0456 / 未加权回退 0.0417，不再偏离实际分布；
# - 限幅 ±2.0dB。离线模拟（同一批原始波形）：K 加权响度极差 pure 0.40dB /
#   mixed 0.68dB，打满仅 1/9 与 2/13，接近第十一轮的 0.14/0.15dB，
#   但完全没有逐段 EQ 与边界推压。
# - 不引入运行中位数/EMA：实测更差，且破坏「同请求同结果」的确定性。
# ---------------------------------------------------------------------------
LOUDNESS_MAX_DB = 2.0
LOUDNESS_TARGETS: dict[str, dict[str, float]] = {
    "serena": {"rms_kweighted": 0.0456, "rms_voiced": 0.0417},
}


def align_loudness(
    x: "Any", rate: int, speaker: str, enabled: bool = True
) -> tuple["Any", dict[str, Any] | None]:
    """第十二轮默认路径：**只**做整段响度归一，不碰频谱、不碰边界、不动时长。

    @param x float32 一维波形（已裁静音、已变速）
    @param rate 采样率
    @param speaker 实际生效的预置音色名（如 `serena`）
    @param enabled 总开关；False 时返回**同一个数组对象**，逐样本零改动
    @returns (波形, 诊断信息)；跳过时诊断为 None
    """
    if not enabled or speaker not in LOUDNESS_TARGETS:
        return x, None
    samples = np.asarray(x, dtype=np.float32).reshape(-1)
    if samples.size < int(0.2 * rate) or not np.isfinite(samples).all():
        return x, None
    current = segment_profile(samples, rate)
    if current is None:
        return x, None
    key = "rms_kweighted" if K_WEIGHT_AVAILABLE else "rms_voiced"
    after = current.get(key)
    if after is None or after <= 0:  # 诚实降级，不编造 K 加权值
        key = "rms_voiced"
        after = current["rms_voiced"]
    target = float(LOUDNESS_TARGETS[speaker][key])
    loud_db = 20.0 * math.log10(max(target / max(after, 1e-9), 1e-9))
    loud_db = max(-LOUDNESS_MAX_DB, min(LOUDNESS_MAX_DB, loud_db))
    aligned = samples * float(10.0 ** (loud_db / 20.0))
    peak = float(np.max(np.abs(aligned)))
    if peak > 0.99:  # 防削波：宁可少给增益，也不交给编码器硬切
        aligned = aligned * (0.99 / peak)
    return aligned.astype(np.float32), {
        "speaker": speaker,
        "loudness_key": key,
        "loudness_db": round(loud_db, 3),
        "before": round(after, 6),
        "target": target,
        "spectral": False,
        "edge": False,
    }


# ---------------------------------------------------------------------------
# 第十六轮（2026-11-12）：响度口径换成 EBU R128 integrated gated LUFS
#
# 用户主观判据：第十五轮 `voice=serena` 那条音色/语速一致性最好，但「整体
# 音量大小会有起伏」。真机测量（loudness_drift_probe.py、serena/1.15、
# 关闭段级对齐的 22 块原始波形）给出根因：
#
# - 原始块间 **integrated LUFS 极差 4.39dB / 4.37dB**（mixed_tech / pure_cn）；
# - v12 的「K 加权**有声帧 RMS 中位数**」口径只压到 3.01 / 1.65dB；
#   **放宽限幅到 ±6dB 反而更差（3.35dB）** —— 不是力度不够，是量错了量：
#   帧中位数对段内静音占比、持续高能量句完全不敏感，人耳听的却是整段响度；
# - 换成 EBU R128 / ITU-R BS.1770 integrated gated loudness（400ms 窗、
#   75% 重叠、绝对门 -70 LUFS、相对门 -10 LU）后，±4dB 限幅即把两条语料
#   的块间极差都压到 **0.00dB**，实际增益仅 -3.04~+2.83dB。
#
# 仍是**纯标量**：`out = x * g`，g 只由该段 LUFS 决定，不改谱形、F0、
# 时长、边界。真机逐块指纹实证 raw vs 归一后谱质心 ≤0.5Hz、MFCC ≤0.046
# （PCM16 二次量化量级），所以第十五轮被认可的音色一致性结构上不会退化。
#
# 目标取两语料原始中位数 -25.099 / -27.577 的折中 **-26.3 LUFS**（沿用
# 第十二轮「取两组折中，避免过拟合单一文本」的做法）。固定目标，不引入
# 运行中位数/EMA —— 那会破坏「同请求同结果」的确定性（第十二轮已证伪）。
#
# 诚实降级：scipy 不可用、speaker 未标定、信号过短或测量失败时，**退回
# v12 的 align_loudness()**，绝不编造一个 LUFS 目标或静默放行。
# ---------------------------------------------------------------------------
LUFS_OFFSET_DB = -0.691
LUFS_WIN_S = 0.400
LUFS_HOP_S = 0.100
LUFS_ABS_GATE = -70.0
LUFS_REL_GATE_LU = 10.0
LUFS_MAX_DB = 4.0
LUFS_TARGETS: dict[str, float] = {"serena": -26.3}


def lufs_window_energy(x: np.ndarray, rate: int) -> tuple[np.ndarray | None, np.ndarray | None]:
    """K 加权后 400ms/100ms 滑窗的均方能量与窗口中心时刻（秒）。

    @returns (z, centers)；scipy 不可用或信号异常时 (None, None)
    """
    if rate <= 0 or x.size == 0:
        return None, None
    weighted = k_weight(np.asarray(x, dtype=np.float32), rate)
    if weighted is None:
        return None, None
    weighted = np.asarray(weighted, dtype=np.float64)
    win = max(1, int(round(LUFS_WIN_S * rate)))
    hop = max(1, int(round(LUFS_HOP_S * rate)))
    if weighted.size < win:
        return (
            np.asarray([float((weighted**2).mean())]),
            np.asarray([weighted.size / rate / 2.0]),
        )
    from numpy.lib.stride_tricks import sliding_window_view

    frames = sliding_window_view(weighted, win)[::hop]
    z = (frames * frames).mean(axis=1)
    centers = (np.arange(z.size) * hop + win / 2.0) / rate
    return z, centers


def lufs_from_window_energy(z: np.ndarray, gated: bool = True) -> float | None:
    """由 400ms 窗口均方能量算 integrated LUFS：绝对门 -70 + 相对门 -10 LU。

    探针与线上共用这**同一份**门控实现，避免两套口径。
    """
    z = np.asarray(z, dtype=np.float64)
    z = z[z > 0]
    if z.size == 0 or not np.isfinite(z).all():
        return None
    lufs_i = LUFS_OFFSET_DB + 10.0 * np.log10(z)
    keep = lufs_i >= LUFS_ABS_GATE
    if not keep.any():
        return None
    zz = z[keep]
    if not gated:
        return float(LUFS_OFFSET_DB + 10.0 * np.log10(zz.mean()))
    ungated = LUFS_OFFSET_DB + 10.0 * np.log10(zz.mean())
    rel = lufs_i[keep] >= (ungated - LUFS_REL_GATE_LU)
    use = zz[rel] if rel.any() else zz
    return float(LUFS_OFFSET_DB + 10.0 * np.log10(use.mean()))


def integrated_lufs(x: np.ndarray, rate: int, gated: bool = True) -> float | None:
    """ITU-R BS.1770 / EBU R128 integrated loudness（LUFS）。

    400ms 窗、75% 重叠、绝对门 -70 LUFS、相对门 -10 LU（相对 ungated 均值）。
    @returns LUFS；测量不可用时返回 None（调用方诚实降级）
    """
    z, _ = lufs_window_energy(x, rate)
    if z is None:
        return None
    return lufs_from_window_energy(z, gated)


def align_loudness_lufs(
    x: "Any", rate: int, speaker: str, enabled: bool = True
) -> tuple["Any", dict[str, Any] | None]:
    """第十六轮 v14：按 integrated gated LUFS 做**纯标量**段级响度归一。

    与 v12 的唯一区别是「量的东西」：v12 用有声帧 RMS 中位数，v14 用整段
    gated LUFS。输出恒等于输入乘一个常数（外加防削波时的整体收缩），因此
    不改音色、不改时长、不改音高、不碰边界。

    @param x float32 一维波形（已裁静音、已变速、已做 WSOLA 谱补偿）
    @param rate 采样率
    @param speaker 实际生效的预置音色名
    @param enabled 总开关；False 时返回**同一个数组对象**，逐样本零改动
    @returns (波形, 诊断信息)；降级到 v12 时诊断带 `fallback` 字段
    """
    if not enabled:
        return x, None
    samples = np.asarray(x, dtype=np.float32).reshape(-1)
    if samples.size < int(0.2 * rate) or not np.isfinite(samples).all():
        return x, None
    def fallback_v12(reason: str) -> tuple["Any", dict[str, Any]]:
        """降级到 v12；v12 自身对未标定音色也可能原样放行，如实标注。"""
        out, diag = align_loudness(samples, rate, speaker, True)
        base = {} if diag is None else dict(diag)
        base.update({
            "profile": "v12",
            "fallback": reason,
            "aligned": diag is not None,
        })
        return out, base

    if not K_WEIGHT_AVAILABLE or speaker not in LUFS_TARGETS:
        # 未标定的音色不猜目标；保持 v12 原有行为，零回归
        return fallback_v12("no_lufs_target")
    current = integrated_lufs(samples, rate)
    if current is None:
        return fallback_v12("lufs_measure_failed")
    target = float(LUFS_TARGETS[speaker])
    loud_db = max(-LUFS_MAX_DB, min(LUFS_MAX_DB, float(target - current)))
    aligned = samples * float(10.0 ** (loud_db / 20.0))
    peak = float(np.max(np.abs(aligned)))
    if peak > 0.99:  # 防削波：宁可少给增益，也不交给编码器硬切
        aligned = aligned * (0.99 / peak)
    return aligned.astype(np.float32), {
        "speaker": speaker,
        "profile": "v14",
        "loudness_key": "lufs_gated",
        "loudness_db": round(loud_db, 3),
        "before_lufs": round(current, 3),
        "target_lufs": target,
        "scalar": True,
        "spectral": False,
        "edge": False,
        "fallback": None,
    }
