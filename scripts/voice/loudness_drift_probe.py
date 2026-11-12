#!/usr/bin/env python3
"""第十六轮（2026-11-12）：长文本「整体音量起伏」的量化与纯标量归一 A/B。

## 为什么单独做这个探针

用户主观判据（第十五轮 A/B 试听）：`voice=serena` 那条音色/语速一致性最好，
但「整体音量大小会有起伏」。既有 `longtext_probe.py` 只有 `rms_spread_db`
（**有声帧 RMS 中位数**的极差），它衡量的是「帧中位数」，不是人耳听到的
「这一整段有多响」：

- 中位数对段内动态、静音占比、持续高能量句都不敏感；
- 服务端 `align_loudness()` 用的正是这个口径，目标 `0.0456` 还是按
  `sinan/1.3` 时代 22 块标定的，而用户选的是 `serena/1.15`（零 instruct）。

所以本探针改用 **ITU-R BS.1770 / EBU R128 integrated gated loudness**（LUFS）
作为主口径：400ms 窗、75% 重叠、绝对门 -70 LUFS、相对门 -10 LU。这是
业界测「整段听起来多响」的标准，也是响度归一化应该对齐的量。

## 关键设计：纯标量，音色逐位不变

候选方案统一为「每块乘一个常数 g」，`g` 只由该块的响度测量决定。
乘常数不改变谱形、F0、谱质心、MFCC（除振幅维），所以第十五轮被用户
认可的音色一致性**结构上不可能被破坏**。这让 A/B 可以完全离线在已生成的
逐块 wav 上重组，无需重新跑模型，且结论可直接搬回服务端。

## 模式

1. `--blocks-dir DIR`  离线分析：逐块 integrated LUFS、全曲滑窗曲线、
   块间极差 / 标准差、5s 分桶趋势、最响与最轻区间。
2. `--simulate`        在**同一批原始块**上模拟多种归一口径，输出各方案
   的残余起伏并生成可直接试听的 `full.wav`。
3. `--live`            真机生成：用真实 `/tts/stream` 拉两组块
   （`voice=serena`；`perceptualAlign=false` 原始组 / 默认 v12 组）。

## 诚实边界

- 本探针**只读生产配置和阈值文件**，不改 sidecar 环境变量、不改门禁阈值。
- 离线模拟在「已归一波形」上再乘标量时，等价于单次总增益 g12*g_new，
  仅有 PCM16 二次量化误差；报告会标注 `source_kind`。
- 不做逐段 EQ、不动时长、不动音高、不做边界增益（第十二轮已证伪）。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from perceptual_align import (  # noqa: E402
    K_WEIGHT_AVAILABLE,
    LUFS_ABS_GATE,
    LUFS_OFFSET_DB,
    LUFS_REL_GATE_LU,
    integrated_lufs,
    k_weight,
    lufs_from_window_energy,
    lufs_window_energy,
)

# EBU R128 / BS.1770-4 常量**一律复用生产模块**，避免探针与线上出现两套口径
# （第十一轮曾因口径不一致产生「对齐后各块都偏低 0.5~1.7dB」的假收敛）。
LUFS_OFFSET = LUFS_OFFSET_DB
ABS_GATE_LUFS = LUFS_ABS_GATE
REL_GATE_LU = LUFS_REL_GATE_LU
MOMENTARY_WIN_S = 0.400
MOMENTARY_HOP_S = 0.100
# 短时曲线里视为「静音」的门：低于该值不参与起伏统计（避免段间空白变成伪影）
CURVE_SILENCE_LUFS = -55.0


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        rate = int(handle.getframerate())
        raw = handle.readframes(handle.getnframes())
        channels = handle.getnchannels()
        width = handle.getsampwidth()
    if width != 2:
        raise ValueError(f"只支持 PCM16: {path}")
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32767.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm.reshape(-1), rate


def write_wav(path: Path, x: np.ndarray, rate: int) -> None:
    pcm = (np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm.tobytes())


def _window_energy(x: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray]:
    """K 加权后的 400ms/100ms 滑窗均方能量；返回 (z, 窗口中心时刻 s)。

    scipy 不可用时诚实抛错（不静默退化成未加权，否则口径会漂）。
    """
    if not K_WEIGHT_AVAILABLE:
        raise RuntimeError("scipy 不可用，无法做 K 加权；拒绝用未加权口径冒充")
    z, centers = lufs_window_energy(np.asarray(x, dtype=np.float32), rate)
    if z is None or centers is None:
        raise RuntimeError("lufs_window_energy 返回 None")
    return z, centers


def lufs_from_energy(z: np.ndarray, gated: bool = True) -> float:
    """由窗口均方能量算 integrated loudness（委托生产模块，口径唯一）。"""
    value = lufs_from_window_energy(z, gated)
    return float("-inf") if value is None else value


def measure(x: np.ndarray, rate: int) -> dict[str, Any]:
    """一块波形的完整响度画像。"""
    z, centers = _window_energy(x, rate)
    lufs_i = LUFS_OFFSET + 10.0 * np.log10(np.maximum(z, 1e-20))
    voiced = lufs_i >= CURVE_SILENCE_LUFS
    v = lufs_i[voiced]
    rms_full = float(np.sqrt((np.asarray(x, dtype=np.float64) ** 2).mean()))
    out: dict[str, Any] = {
        "duration_s": round(x.size / rate, 3),
        "lufs_integrated": round(lufs_from_energy(z), 3),
        "lufs_ungated": round(lufs_from_energy(z, gated=False), 3),
        "lufs_shortterm_median": round(float(np.median(v)), 3) if v.size else None,
        "lufs_shortterm_p10": round(float(np.percentile(v, 10)), 3) if v.size else None,
        "lufs_shortterm_p90": round(float(np.percentile(v, 90)), 3) if v.size else None,
        "shortterm_span_db": round(float(v.max() - v.min()), 3) if v.size else None,
        "rms_full": round(rms_full, 6),
        "peak": round(float(np.max(np.abs(x))), 5),
    }
    return out


def curve(x: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray]:
    z, centers = _window_energy(x, rate)
    return LUFS_OFFSET + 10.0 * np.log10(np.maximum(z, 1e-20)), centers


def spread_stats(values: list[float]) -> dict[str, Any]:
    a = np.asarray([v for v in values if math.isfinite(v)], dtype=np.float64)
    if a.size == 0:
        return {"n": 0}
    return {
        "n": int(a.size),
        "min": round(float(a.min()), 3),
        "max": round(float(a.max()), 3),
        "spread_db": round(float(a.max() - a.min()), 3),
        "std_db": round(float(a.std()), 3),
        "mean": round(float(a.mean()), 3),
    }


def analyze_blocks(paths: list[Path], label: str) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    waves: list[np.ndarray] = []
    rate = 24000
    for i, path in enumerate(paths, 1):
        x, rate = read_wav(path)
        waves.append(x)
        blocks.append({"index": i, "file": path.name, **measure(x, rate)})
    full = np.concatenate(waves) if len(waves) > 1 else waves[0]
    c, t = curve(full, rate)
    voiced = c >= CURVE_SILENCE_LUFS
    # 相邻短时窗跳变（只在同为有声时计，避免静音边界伪影）
    jumps = [
        abs(float(c[i + 1] - c[i]))
        for i in range(c.size - 1)
        if voiced[i] and voiced[i + 1]
    ]
    # 5s 分桶中位数趋势
    buckets: dict[str, float] = {}
    for b in range(int(math.ceil(t[-1] / 5.0))):
        m = (t >= b * 5) & (t < (b + 1) * 5) & voiced
        if m.any():
            buckets[f"{b * 5:02d}-{b * 5 + 5:02d}s"] = round(float(np.median(c[m])), 2)
    block_lufs = [b["lufs_integrated"] for b in blocks]
    bstats = spread_stats(block_lufs)
    # 最响 / 最轻的短时区间（1s 粒度）
    sec_best: list[tuple[float, float]] = []
    for s in range(int(math.floor(t[-1]))):
        m = (t >= s) & (t < s + 1) & voiced
        if m.any():
            sec_best.append((float(np.median(c[m])), float(s)))
    sec_best.sort()
    # 第十七轮：块边界 ±0.5s 的有声窗口中位数跳变（人耳「这一段突然变响」
    # 的直接对应量），以及 5s 桶趋势极差（跨块低频漂移）。
    seams: list[float] = []
    offset = 0
    for w in waves[:-1]:
        offset += w.size
        center = offset / rate
        left = c[(t >= center - 0.5) & (t < center) & voiced]
        right = c[(t >= center) & (t < center + 0.5) & voiced]
        if left.size and right.size:
            seams.append(abs(float(np.median(right) - np.median(left))))
    bucket_values = list(buckets.values())
    return {
        "label": label,
        "seam_jump_mean_db": round(float(np.mean(seams)), 3) if seams else None,
        "seam_jump_max_db": round(float(np.max(seams)), 3) if seams else None,
        "bucket_5s_spread_db": round(max(bucket_values) - min(bucket_values), 3) if bucket_values else None,
        "rate": rate,
        "block_count": len(blocks),
        "total_duration_s": round(full.size / rate, 3),
        "blocks": blocks,
        "block_lufs_spread": bstats,
        "shortterm": {
            **spread_stats([float(v) for v in c[voiced]]),
            "median": round(float(np.median(c[voiced])), 3) if voiced.any() else None,
            "adjacent_jump_max_db": round(max(jumps), 3) if jumps else None,
            "adjacent_jump_p95_db": round(float(np.percentile(jumps, 95)), 3) if jumps else None,
        },
        "buckets_5s_median_lufs": buckets,
        "quietest_seconds": [{"sec": s, "lufs": round(v, 2)} for v, s in sec_best[:5]],
        "loudest_seconds": [{"sec": s, "lufs": round(v, 2)} for v, s in sec_best[-5:][::-1]],
    }


# ---------------------------------------------------------------------------
# 纯标量归一方案模拟
# ---------------------------------------------------------------------------

def gain_for(
    x: np.ndarray,
    rate: int,
    method: str,
    target_lufs: float | None,
    max_db: float,
    kweighted: bool,
) -> tuple[float, float]:
    """返回 (增益线性值, 施加 dB)。target_lufs=None 时按全批中位数自动标定。"""
    if method == "none":
        return 1.0, 0.0
    if method == "lufs_gated":
        z, _ = _window_energy(x, rate)
        current = lufs_from_energy(z)
    elif method == "lufs_ungated":
        z, _ = _window_energy(x, rate)
        current = lufs_from_energy(z, gated=False)
    elif method == "rms_full":
        current = 20.0 * math.log10(max(float(np.sqrt((np.asarray(x, dtype=np.float64) ** 2).mean())), 1e-9))
    elif method == "rms_voiced":
        # 复刻 v12 服务端口径：有声帧 RMS 中位数（40ms/20ms、相对峰值门）
        from continuity import SILENCE_RMS_RATIO, _windows

        src = k_weight(x, rate) if kweighted else np.asarray(x, dtype=np.float64)
        frames, _, _ = _windows(np.asarray(src, dtype=np.float32), rate)
        rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
        peak = float(rms.max()) if rms.size else 0.0
        if peak <= 0:
            return 1.0, 0.0
        vf = rms[rms > peak * SILENCE_RMS_RATIO]
        if vf.size == 0:
            return 1.0, 0.0
        current = 20.0 * math.log10(max(float(np.median(vf)), 1e-9))
    else:
        raise ValueError(f"未知口径: {method}")

    if target_lufs is None:
        return 1.0, 0.0
    raw_db = float(target_lufs - current)
    db = max(-max_db, min(max_db, raw_db))
    return float(10.0 ** (db / 20.0)), db


def simulate(
    paths: list[Path], out_dir: Path, label: str,
    schemes: list[tuple[str, str, float, bool, float | None]],
) -> dict[str, Any]:
    """在原始块上模拟多种归一方案。

    scheme = (tag, method, max_db, kweighted, fixed_target)；
    `fixed_target=None` 时用全批该口径中位数（仅用于探索），
    非 None 时**复刻线上固定目标**（可直接搬回服务端）。
    """
    waves: list[np.ndarray] = []
    rate = 24000
    for p in paths:
        x, rate = read_wav(p)
        waves.append(x)
    results: dict[str, Any] = {}
    for tag, method, max_db, kweighted, fixed_target in schemes:
        # 第一遍：算全批中位数作为目标（EBU 风格「批量归一化目标」）
        currents = []
        for x in waves:
            z, _ = _window_energy(x, rate)
            if method == "lufs_gated":
                currents.append(lufs_from_energy(z))
            elif method == "lufs_ungated":
                currents.append(lufs_from_energy(z, gated=False))
            elif method == "rms_full":
                currents.append(20.0 * math.log10(max(float(np.sqrt((x.astype(np.float64) ** 2).mean())), 1e-9)))
            elif method == "rms_voiced":
                from continuity import SILENCE_RMS_RATIO, _windows

                src = k_weight(x, rate) if kweighted else x
                frames, _, _ = _windows(np.asarray(src, dtype=np.float32), rate)
                rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
                peak = float(rms.max()) if rms.size else 0.0
                vf = rms[rms > peak * SILENCE_RMS_RATIO] if peak > 0 else rms[:0]
                currents.append(20.0 * math.log10(max(float(np.median(vf)) if vf.size else 1e-9, 1e-9)))
            else:
                currents.append(0.0)
        target = (
            0.0 if method == "none"
            else fixed_target if fixed_target is not None
            else float(np.median(currents))
        )
        gained: list[np.ndarray] = []
        gains: list[float] = []
        for x in waves:
            g, db = gain_for(x, rate, method, target, max_db, kweighted)
            y = x * g
            # 防削波与服务端一致
            peak = float(np.max(np.abs(y)))
            if peak > 0.99:
                y = y * (0.99 / peak)
            gained.append(y.astype(np.float32))
            gains.append(round(db, 3))
        full = np.concatenate(gained) if len(gained) > 1 else gained[0]
        group_out = out_dir / tag
        group_out.mkdir(parents=True, exist_ok=True)
        write_wav(group_out / "full.wav", full, rate)
        for i, y in enumerate(gained, 1):
            write_wav(group_out / f"block-{i:02d}.wav", y, rate)
        rep = analyze_blocks(sorted(group_out.glob("block-*.wav")), tag)
        results[tag] = {
            "method": method,
            "max_db": max_db,
            "kweighted": kweighted,
            "target": round(target, 4),
            "gains_db": gains,
            "block_lufs_spread": rep["block_lufs_spread"],
            "shortterm": rep["shortterm"],
            "buckets_5s_median_lufs": rep["buckets_5s_median_lufs"],
        }
        print(
            f"  [{tag:<22}] target={target:8.3f} 块间极差={rep['block_lufs_spread']['spread_db']:6.2f}dB "
            f"std={rep['block_lufs_spread']['std_db']:5.2f} "
            f"短时p95跳变={rep['shortterm']['adjacent_jump_p95_db']}dB "
            f"增益范围=[{min(gains):.2f},{max(gains):.2f}]",
            flush=True,
        )
    return {"label": label, "source_blocks": [p.name for p in paths], "schemes": results}


def compare_groups(dirs: list[Path]) -> dict[str, Any]:
    """同一把归一化尺子比较多个真机组：响度起伏 + 音色距离零回归。"""
    from timbre_probe import distances, fingerprint, joint_scale

    groups: list[tuple[Path, list[dict]]] = []
    for d in dirs:
        paths = sorted(d.glob("block-*.wav"))
        if not paths:
            raise RuntimeError(f"{d} 下没有 block-*.wav")
        fps = []
        for p in paths:
            x, rate = read_wav(p)
            fps.append(fingerprint(x, rate))
        groups.append((d, fps))
    # A/B 组必须用同一把归一化尺子，否则音色距离不可比
    scale = joint_scale([fps for _, fps in groups])
    out: dict[str, Any] = {}
    print(f"\n=== 真机组对比（共 {len(dirs)} 组，统一归一化尺子）===", flush=True)
    for d, fps in groups:
        rep = analyze_blocks(sorted(d.glob("block-*.wav")), d.name)
        dist = distances(fps, scale)
        joint, band = dist["adjacent_joint"], dist["adjacent_band_db"]
        s = rep["block_lufs_spread"]
        entry = {
            "block_lufs_spread_db": s["spread_db"],
            "block_lufs_std_db": s["std_db"],
            "shortterm_jump_p95_db": rep["shortterm"]["adjacent_jump_p95_db"],
            "seam_jump_mean_db": rep["seam_jump_mean_db"],
            "seam_jump_max_db": rep["seam_jump_max_db"],
            "bucket_5s_spread_db": rep["bucket_5s_spread_db"],
            "per_block_lufs": [b["lufs_integrated"] for b in rep["blocks"]],
            "adjacent_joint": joint,
            "adjacent_joint_mean": round(float(np.mean(joint)), 3),
            "adjacent_band_mean": round(float(np.mean(band)), 3),
            "all_pairwise_mean": dist["all_pairwise_mean"],
            "buckets_5s_median_lufs": rep["buckets_5s_median_lufs"],
        }
        out[d.name] = entry
        print(
            f"  [{d.name:<10}] 块间LUFS极差={s['spread_db']:6.2f}dB std={s['std_db']:5.2f} "
            f"短时p95跳变={entry['shortterm_jump_p95_db']:5.2f}dB "
            f"接缝均值={entry['seam_jump_mean_db']:5.2f}dB "
            f"5s桶极差={entry['bucket_5s_spread_db']:5.2f}dB "
            f"音色联合相邻均值={entry['adjacent_joint_mean']:6.3f} "
            f"频带相邻均值={entry['adjacent_band_mean']:5.3f}",
            flush=True,
        )
    return out


def live(
    out_dir: Path, case: str, voice: str, from_config: bool,
    with_v12: bool, with_v14: bool, skip_raw: bool = False,
    with_v16: bool = False, with_v17: bool = False, with_v17_strong: bool = False,
) -> None:
    """真机生成块：原始（关段级对齐）必生成，v12 / v14 可选且显式指定 profile。

    与 `timbre_probe --from-config --comp on --instructs ...` 的生成条件逐字一致：
    engine/speed 取生产配置，voice 由 extra 覆盖，WSOLA 补偿保持默认开。
    profile **显式写在请求里**，不依赖服务端当前默认值，保证报告可复现。
    """
    import longtext_probe as lp
    from timbre_probe import synth_block, save_wav

    if from_config:
        cfg = lp.production_voice_config()
        lp.ENGINE, lp.VOICE, lp.SPEED = cfg["engine"], cfg["voice"], cfg["speed"]
    print(
        f"[live] engine={lp.ENGINE} speed={lp.SPEED} voice_override={voice} case={case}",
        flush=True,
    )
    text = lp.TEXTS[case]
    blocks = lp.frontend_blocks(text)
    print(f"[live] {case} 共 {len(blocks)} 块, 字数 {[len(b) for b in blocks]}", flush=True)
    groups: list[tuple[str, dict]] = []
    if not skip_raw:
        groups.append(("raw", {"voice": voice, "perceptualAlign": False}))
    if with_v12:
        groups.append(("v12", {"voice": voice, "alignProfile": "v12"}))
    if with_v14:
        groups.append(("v14", {"voice": voice, "alignProfile": "v14"}))
    # 第十七轮 A/B：v16 = 请求级同时关掉整形与双口径伺服，精确复现第十六轮；
    # v17 = 跟随服务端新默认；v17-k10 = 强档整形，供真人试听选强度。
    if with_v16:
        groups.append(("v16", {
            "voice": voice, "alignProfile": "v14",
            "slowLeveling": False, "dualRateAlpha": 0,
        }))
    if with_v17:
        groups.append(("v17", {"voice": voice, "alignProfile": "v14"}))
    if with_v17_strong:
        groups.append(("v17-k10", {
            "voice": voice, "alignProfile": "v14", "slowLevelingStrength": 1.0,
        }))
    for tag, extra in groups:
        group_out = out_dir / tag
        group_out.mkdir(parents=True, exist_ok=True)
        parts: list[np.ndarray] = []
        rate = 24000
        for i, block in enumerate(blocks, 1):
            x, rate, _, _ = synth_block(block, extra)
            save_wav(group_out / f"block-{i:02d}.wav", x, rate)
            parts.append(x)
            print(f"  [{tag}] #{i:02d} {len(block):2d}字 {x.size / rate:.2f}s", flush=True)
        write_wav(group_out / "full.wav", np.concatenate(parts), rate)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blocks-dir", help="含 block-*.wav 的目录（离线分析）")
    parser.add_argument("--wav", help="单个完整 wav（按滑窗分析）")
    parser.add_argument("--live", action="store_true", help="真机生成 raw / v12 / v14 组块")
    parser.add_argument("--from-config", action="store_true", help="live 时用生产 engine/speed")
    parser.add_argument("--case", default="mixed_tech", help="live 用语料名")
    parser.add_argument("--voice", default="serena", help="live 时覆盖的 voice")
    parser.add_argument("--with-v12", action="store_true", help="live 额外生成 v12 组（请求级显式回退）")
    parser.add_argument("--with-v14", action="store_true", help="live 额外生成 v14 组（请求级显式启用）")
    parser.add_argument("--with-v16", action="store_true", help="live 生成第十六轮精确复现组（关整形+关双口径伺服）")
    parser.add_argument("--with-v17", action="store_true", help="live 生成第十七轮默认组")
    parser.add_argument("--with-v17-strong", action="store_true", help="live 生成第十七轮强档整形组（强度 1.0）")
    parser.add_argument("--skip-raw", action="store_true", help="live 跳过 raw 组（目录里已有原始块时省一轮真机合成）")
    parser.add_argument("--compare", nargs="+", help="比较多个含 block-*.wav 的目录（统一音色尺子）")
    parser.add_argument("--simulate", action="store_true", help="在 blocks-dir 上模拟归一方案")
    parser.add_argument("--out", default="/tmp/dcx-loudness-r16")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.compare:
        report = compare_groups([Path(d) for d in args.compare])
        (out / "group-comparison.json").write_text(
            json.dumps({"created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "groups": report},
                       ensure_ascii=False, indent=2)
        )
        return 0

    if args.live:
        live(out, args.case, args.voice, args.from_config, args.with_v12, args.with_v14,
             args.skip_raw, args.with_v16, args.with_v17, args.with_v17_strong)
        return 0

    if args.wav:
        x, rate = read_wav(Path(args.wav))
        c, t = curve(x, rate)
        voiced = c >= CURVE_SILENCE_LUFS
        rep = {
            "wav": args.wav,
            "duration_s": round(x.size / rate, 3),
            "integrated_lufs": round(lufs_from_energy(_window_energy(x, rate)[0]), 3),
            "shortterm": spread_stats([float(v) for v in c[voiced]]),
        }
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        (out / "single_wav_report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2))
        return 0

    if not args.blocks_dir:
        parser.error("需要 --blocks-dir / --wav / --live 之一")
    paths = sorted(Path(args.blocks_dir).glob("block-*.wav"))
    if not paths:
        raise RuntimeError(f"{args.blocks_dir} 下没有 block-*.wav")
    label = Path(args.blocks_dir).name
    print(f"=== 离线分析 {label}: {len(paths)} 块 ===", flush=True)
    rep = analyze_blocks(paths, label)
    print(f"  块间 integrated LUFS 极差 = {rep['block_lufs_spread']['spread_db']}dB "
          f"(std {rep['block_lufs_spread']['std_db']}dB)", flush=True)
    print(f"  短时响度 p95 相邻跳变 = {rep['shortterm']['adjacent_jump_p95_db']}dB", flush=True)
    print("  逐块 LUFS:", [b["lufs_integrated"] for b in rep["blocks"]], flush=True)
    print("  5s 分桶:", rep["buckets_5s_median_lufs"], flush=True)
    (out / f"analysis-{label}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2))

    if args.simulate:
        # -26.3 LUFS = 线上 LUFS_TARGETS["serena"]（两语料中位数折中）
        from perceptual_align import LUFS_MAX_DB, LUFS_TARGETS

        fixed = LUFS_TARGETS["serena"]
        schemes = [
            ("none", "none", 99.0, False, None),
            ("v12_rmsvoiced_kw", "rms_voiced", 2.0, True, None),
            ("v12_rmsvoiced_wide", "rms_voiced", 6.0, True, None),
            ("lufs_gated_2db", "lufs_gated", 2.0, True, None),
            ("lufs_gated_4db", "lufs_gated", 4.0, True, None),
            ("lufs_gated_free", "lufs_gated", 12.0, True, None),
            ("v14_fixed_online", "lufs_gated", LUFS_MAX_DB, True, fixed),
            ("lufs_ungated_free", "lufs_ungated", 12.0, True, None),
            ("rms_full_free", "rms_full", 12.0, True, None),
        ]
        print(f"\n=== 归一方案模拟（{label}）===", flush=True)
        srep = simulate(paths, out / f"sim-{label}", label, schemes)
        (out / f"sim-{label}" / "report.json").write_text(
            json.dumps({**srep, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, ensure_ascii=False, indent=2)
        )
        print(f"\n[out] {out / f'sim-{label}'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
