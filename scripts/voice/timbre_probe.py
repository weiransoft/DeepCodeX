#!/usr/bin/env python3
"""块级「音色」指纹探针（2026-11-11 第十四轮）。

## 为什么单独做这份探针

第十三轮的门禁只量「整块单元/秒」「LTAS 四频带」「谱质心」，用户仍然反馈
「第一段和第二段音色明显不一样，第二段和第三段差异不大，后面都差不多」。
这些指标看的是**响度/语速/亮度**的单变量极差，没有直接量人耳所说的
「音色」——声道包络（共振峰结构）、谱倾斜、音高起点的**多维联合距离**，
更没有区分「相邻块之间」和「全体块之间」。

本探针做三件事：

1. 复刻前端切块，逐块走真实 `/tts/stream`，对每块算音色指纹
   （MFCC 声道包络 + 四频带 LTAS + 谱倾斜/质心 + F0），输出**相邻块距离**。
2. 三个因果实验，把「首块离群」拆开：
   - 同文本重复生成 → 噪声底（随机波动有多大）
   - 同一段文本放在第 1 个请求 vs 第 5 个请求 → 冷启动/顺序效应
   - 同一段文本的开头按 14/28/48 字生成 → 短文本本身的系统性偏移
3. `--comp off` 请求级对照，看 v13 谱补偿对各距离的贡献。

## 口径诚实性

- 指纹只用**有声帧**，避免各块停顿占比不同污染谱统计。
- MFCC 去掉 c0（能量项），因为 v12 已经做响度归一，c0 不代表音色。
- 距离用全体块在各维度上的标准差做 z-score 后求欧氏距离，避免量纲主导。
- 本探针**只读**，不改 sidecar 环境变量、不改阈值文件、不写生产配置。
- seg_speed 从 `~/.deepcode/logs/voice.log` 抓服务端真实打印值；**不用**
  「已变速波形」反算（那必然≈1，第十三轮曾因此产生伪数据）。

用法：
    scripts/voice/.venv/bin/python scripts/voice/timbre_probe.py --from-config
    scripts/voice/.venv/bin/python scripts/voice/timbre_probe.py --from-config --case mixed_tech --comp off
"""
from __future__ import annotations

import argparse
import io
import json
import math
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/voice"))

import longtext_probe as lp  # noqa: E402
from continuity import decode_wav, split_stream_chunks  # noqa: E402
from mlx_voice_server import speech_units  # noqa: E402
from scipy.fftpack import dct  # noqa: E402

BANDS = (0, 1000, 3000, 8000, 12000)
FRAME_S = 0.025
HOP_S = 0.010
N_FFT = 2048
N_MELS = 26
N_MFCC = 12
OUT = Path("/tmp/dcx-timbre-probe")


# ---------------------------------------------------------------------------
# 波形获取
# ---------------------------------------------------------------------------


VOICE_LOG = Path.home() / ".deepcode/logs/voice.log"
# 服务端超过 48 字会自动分多段，日志写成「N段 倍率 a,b,c」；两种格式都要认。
RATIO_RE = re.compile(r"流式语速伺服\s+\d+段\s+倍率\s+([0-9.,]+)")


def _log_size() -> int:
    try:
        return VOICE_LOG.stat().st_size
    except OSError:
        return 0


def _read_new_ratios(offset: int) -> list[float]:
    """只读本次请求期间新增的日志行，取服务端打出的真实伺服倍率。

    多段合成一行里有多个倍率，全部展开；`synth_block` 取最后一个作为该块
    展示值（仅展示，不参与任何距离计算）。
    """
    try:
        with VOICE_LOG.open("rb") as handle:
            handle.seek(offset)
            tail = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    values: list[float] = []
    for group in RATIO_RE.findall(tail):
        for raw in group.split(","):
            try:
                values.append(float(raw))
            except ValueError:
                continue
    return values


def synth_block(text: str, payload_extra: dict | None = None) -> tuple[np.ndarray, int, float, float | None]:
    """逐块走真实 /tts/stream，把流式 WAV 片段拼成该块完整波形。

    服务端倍率从 voice.log 抓，不用「已变速波形」反算（那必然≈1，是伪数据）。
    """
    payload = lp.tts_payload(text)
    if payload_extra:
        payload.update(payload_extra)
    log_at = _log_size()
    status, data, elapsed = lp.post("/tts/stream", payload)
    if status != 200:
        raise RuntimeError(f"/tts/stream HTTP {status}: {data[:200]!r}")
    ratios = _read_new_ratios(log_at)
    blobs = split_stream_chunks(data)
    if not blobs:
        raise RuntimeError("流式响应没有 WAV 块")
    parts: list[np.ndarray] = []
    rate = 24000
    for blob in blobs:
        x, rate = decode_wav(blob)
        parts.append(x)
    audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
    return audio, rate, elapsed, (ratios[-1] if ratios else None)


def save_wav(path: Path, x: np.ndarray, rate: int) -> None:
    pcm = (np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------
# 音色指纹
# ---------------------------------------------------------------------------


def _mel_filterbank(rate: int) -> np.ndarray:
    def hz2mel(h: float) -> float:
        return 2595.0 * math.log10(1.0 + h / 700.0)

    def mel2hz(m: float) -> float:
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    pts = mel2hz(np.linspace(hz2mel(0.0), hz2mel(rate / 2.0), N_MELS + 2))
    bins = np.floor((N_FFT + 1) * pts / rate).astype(int)
    fb = np.zeros((N_MELS, N_FFT // 2 + 1), dtype=np.float64)
    for m in range(1, N_MELS + 1):
        left, center, right = int(bins[m - 1]), int(bins[m]), int(bins[m + 1])
        if center > left:
            fb[m - 1, left:center] = (np.arange(left, center) - left) / (center - left)
        if right > center:
            fb[m - 1, center:right] = (right - np.arange(center, right)) / (right - center)
    return fb


def _frames(x: np.ndarray, rate: int) -> np.ndarray:
    flen = max(1, int(FRAME_S * rate))
    hop = max(1, int(HOP_S * rate))
    if x.size < flen:
        x = np.pad(x, (0, flen - x.size))
    count = 1 + (x.size - flen) // hop
    idx = np.arange(flen)[None, :] + hop * np.arange(count)[:, None]
    return x[idx] * np.hanning(flen)[None, :]


def _autocorr_f0(frame: np.ndarray, rate: int) -> float:
    """70~400Hz 自相关基频估计，失败返回 0。"""
    frame = frame - float(frame.mean())
    power = float(np.dot(frame, frame))
    if power < 1e-9:
        return 0.0
    lo = max(2, int(rate / 400.0))
    hi = min(frame.size - 1, int(rate / 70.0))
    if hi <= lo:
        return 0.0
    n = 1 << (2 * frame.size - 1).bit_length()
    spec = np.fft.rfft(frame, n)
    ac = np.fft.irfft(spec * np.conj(spec), n)[: frame.size]
    seg = ac[lo:hi]
    if seg.size == 0 or ac[0] <= 0:
        return 0.0
    peak = int(np.argmax(seg)) + lo
    if ac[peak] / ac[0] < 0.35:
        return 0.0
    return float(rate) / peak


def fingerprint(x: np.ndarray, rate: int) -> dict[str, Any]:
    """一块波形的音色指纹。只统计有声帧。"""
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    frames = _frames(x, rate)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    # 有声帧：绝对下限 + 相对该块 90 分位，避免静音/呼吸被算进谱
    threshold = max(0.004, 0.16 * float(np.percentile(rms, 90)))
    voiced = frames[rms > threshold]
    if voiced.size == 0:
        voiced = frames[rms > np.percentile(rms, 70)]
    spec = np.abs(np.fft.rfft(voiced, n=N_FFT, axis=1))
    freqs = np.fft.rfftfreq(N_FFT, d=1.0 / rate)
    power = spec**2

    # 四频带 LTAS（相对总能量的占比 → dB），对响度不敏感
    total = float(power.sum())
    band_db: list[float] = []
    for lo, hi in zip(BANDS[:-1], BANDS[1:]):
        sel = (freqs >= lo) & (freqs < hi)
        band_db.append(round(10.0 * math.log10(max(float(power[:, sel].sum()) / max(total, 1e-12), 1e-12)), 3))

    ltas = power.mean(axis=0)
    centroid = float((freqs * ltas).sum() / max(ltas.sum(), 1e-12))
    cumsum = np.cumsum(ltas)
    rolloff = float(freqs[int(np.searchsorted(cumsum, 0.85 * cumsum[-1]))])
    # 谱倾斜：低频带与高频带能量比（dB），直接对应「厚/薄」
    low = float(power[:, (freqs >= 100) & (freqs < 1000)].sum())
    high = float(power[:, (freqs >= 3000) & (freqs < 8000)].sum())
    tilt = 10.0 * math.log10(max(low, 1e-12) / max(high, 1e-12))

    fb = _mel_filterbank(rate)
    mel = np.log(np.maximum(fb @ power.T, 1e-10)).T  # [frames, n_mels]
    mfcc_all = dct(mel, type=2, axis=1, norm="ortho")
    mfcc = [round(float(v), 4) for v in mfcc_all[:, 1 : N_MFCC + 1].mean(axis=0)]

    # F0 抽样（每 3 帧一次，控制耗时）
    f0s = [_autocorr_f0(voiced[i], rate) for i in range(0, voiced.shape[0], 3)]
    f0s = [v for v in f0s if v > 0]
    f0_med = float(np.median(f0s)) if f0s else 0.0
    f0_std = float(np.std(f0s)) if len(f0s) > 1 else 0.0

    return {
        "duration_s": round(x.size / float(rate), 3),
        "voiced_ratio": round(float(voiced.shape[0] / max(frames.shape[0], 1)), 3),
        "band_db": band_db,
        "centroid_hz": round(centroid, 1),
        "rolloff_hz": round(rolloff, 1),
        "tilt_db": round(tilt, 3),
        "mfcc": mfcc,
        "f0_hz": round(f0_med, 1),
        "f0_std_hz": round(f0_std, 1),
        "rms_voiced": round(float(np.mean(rms[rms > threshold])), 5),
    }


def feature_vector(fp: dict) -> np.ndarray:
    """用于距离的联合向量：MFCC(12) + 四频带(4) + 倾斜 + 质心 + F0(半音尺度)。"""
    vals = list(fp["mfcc"]) + list(fp["band_db"]) + [fp["tilt_db"], fp["centroid_hz"] / 1000.0]
    vals.append(12.0 * math.log2(max(fp["f0_hz"], 1.0) / 200.0) if fp["f0_hz"] > 0 else 0.0)
    return np.asarray(vals, dtype=np.float64)


def joint_scale(groups: list[list[dict]]) -> tuple[np.ndarray, np.ndarray]:
    """跨组共用的归一化尺度——A/B 两组必须用同一把尺子，否则距离不可比。"""
    vecs = np.vstack([np.stack([feature_vector(f) for f in g]) for g in groups])
    std = vecs.std(axis=0)
    mfcc = np.vstack([np.stack([np.asarray(f["mfcc"]) for f in g]) for g in groups])
    mstd = mfcc.std(axis=0)
    return np.where(std > 1e-6, std, 1.0), np.where(mstd > 1e-6, mstd, 1.0)


def distances(
    fps: list[dict], scale: tuple[np.ndarray, np.ndarray] | None = None
) -> dict[str, Any]:
    vecs = np.stack([feature_vector(f) for f in fps])
    # 各维按全体块的标准差归一；标准差为 0 的维度不参与（避免除零放大噪声）
    std = vecs.std(axis=0)
    own = np.where(std > 1e-6, std, 1.0)
    z = vecs / (scale[0] if scale else own)
    adjacent = [round(float(np.linalg.norm(z[i + 1] - z[i])), 3) for i in range(len(z) - 1)]

    mfcc = np.stack([np.asarray(f["mfcc"]) for f in fps])
    own_m = np.where(mfcc.std(axis=0) > 1e-6, mfcc.std(axis=0), 1.0)
    mz = mfcc / (scale[1] if scale else own_m)
    adj_mfcc = [round(float(np.linalg.norm(mz[i + 1] - mz[i])), 3) for i in range(len(mz) - 1)]
    adj_band = [
        round(float(np.linalg.norm(np.asarray(fps[i + 1]["band_db"]) - np.asarray(fps[i]["band_db"]))), 3)
        for i in range(len(fps) - 1)
    ]
    adj_f0 = [
        round(abs(12.0 * math.log2(max(fps[i + 1]["f0_hz"], 1.0) / max(fps[i]["f0_hz"], 1.0))), 3)
        for i in range(len(fps) - 1)
    ]
    return {
        "adjacent_joint": adjacent,
        "adjacent_mfcc": adj_mfcc,
        "adjacent_band_db": adj_band,
        "adjacent_f0_semitone": adj_f0,
        "all_pairwise_mean": round(
            float(np.mean([np.linalg.norm(z[i] - z[j]) for i in range(len(z)) for j in range(i + 1, len(z))])), 3
        ),
        "dimension_std": [round(float(v), 4) for v in std],
    }


def resplit_pair(merged: str, min_chars: int, limit: int) -> list[str] | None:
    """把「短块 + 相邻块」按标点重划成两块，都尽量落在 [min_chars, limit]。"""
    lo = max(min_chars, len(merged) - limit)
    hi = min(limit, len(merged) - min_chars)
    if lo > hi:
        return None
    punct = "。！？!?；;，,、：: "
    candidates = list(range(lo, hi + 1))
    candidates.sort(key=lambda c: (0 if (merged[c - 1] in punct) else 1, abs(c - len(merged) // 2)))
    return [merged[: candidates[0]], merged[candidates[0] :]]


def uniform_blocks(blocks: list[str], min_chars: int = 30, limit: int = 48) -> list[str]:
    """第十四轮候选修复：消灭首/尾短块，中间块保持不动。

    只重划首尾两处，不改中间块——用户反馈「第二、第三差异不大，后面都差不多」，
    真机相邻频带距离也显示最大两处正是首尾短块。
    """
    out = list(blocks)
    if len(out) >= 2 and len(out[0]) < min_chars:
        pair = resplit_pair(out[0] + out[1], min_chars, limit)
        if pair:
            out[0:2] = pair
    if len(out) >= 2 and len(out[-1]) < min_chars:
        pair = resplit_pair(out[-2] + out[-1], min_chars, limit)
        if pair:
            out[-2:] = pair
    return out


def delta(a: dict, b: dict) -> dict[str, Any]:
    return {
        "joint": round(float(np.linalg.norm(feature_vector(a) - feature_vector(b))), 3),
        "mfcc": round(float(np.linalg.norm(np.asarray(a["mfcc"]) - np.asarray(b["mfcc"]))), 3),
        "band_db": [round(x - y, 3) for x, y in zip(a["band_db"], b["band_db"])],
        "centroid_hz": round(a["centroid_hz"] - b["centroid_hz"], 1),
        "tilt_db": round(a["tilt_db"] - b["tilt_db"], 3),
        "f0_hz": round(a["f0_hz"] - b["f0_hz"], 1),
        "rms_voiced": round(a["rms_voiced"] - b["rms_voiced"], 5),
    }


def fingerprint_signature(gfps: list[dict]) -> list[float]:
    """把一组块指纹展平成标量序列，用于「两组是否逐值相同」的零回归判定。"""
    out: list[float] = []
    for f in gfps:
        out.extend(
            float(v)
            for v in (
                f["centroid_hz"], f["tilt_db"], f["f0_hz"],
                f["rms_voiced"], *f["band_db"], *f["mfcc"],
            )
        )
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="块级音色指纹与首块离群归因")
    parser.add_argument("--from-config", action="store_true", help="用生产 voice/engine/speed")
    parser.add_argument("--case", default="pure_cn", choices=sorted(lp.TEXTS))
    parser.add_argument("--comp", choices=("on", "off"), default="on", help="v13 谱补偿请求级开关")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--skip-experiments", action="store_true")
    parser.add_argument("--compare-blocks", action="store_true", help="额外跑「首尾短块重划」组并给 A/B 距离")
    parser.add_argument("--steady", action="store_true", help="compare 组用生产 `frontend_blocks(steady=True)` 的真实切分（否则用离线重划预演）")
    parser.add_argument(
        "--strengths",
        default="",
        help="第十四轮：WSOLA 补偿强度扫描，逗号分隔，如 0,0.3,0.6,0.85,1.0；"
        "同一 sidecar 上逐请求覆盖强度，各组用 joint_scale 统一尺度比较",
    )
    parser.add_argument(
        "--instructs",
        default="",
        help="第十五轮：instruct 单变量 A/B，'|' 分隔；default=不传字段、"
        "none=显式零 instruct（纯 speaker）、其余字符串作为 instruct 文本。"
        "voice 字符串与采样种子在组间保持完全相同",
    )
    args = parser.parse_args()

    if args.from_config:
        cfg = lp.production_voice_config()
        lp.ENGINE, lp.VOICE, lp.SPEED = cfg["engine"], cfg["voice"], cfg["speed"]
    extra = {} if args.comp == "on" else {"wsolaCompensation": False}
    out = Path(args.out) / f"{args.case}-comp-{args.comp}"
    out.mkdir(parents=True, exist_ok=True)

    print(
        f"[config] engine={lp.ENGINE} speed={lp.SPEED} voice={lp.VOICE[:40]} comp={args.comp}",
        flush=True,
    )
    text = lp.TEXTS[args.case]
    blocks = lp.frontend_blocks(text)
    print(f"[blocks] {len(blocks)} 块：{', '.join(str(len(b)) for b in blocks)} 字", flush=True)

    from wsola_compensation import band_compensation_db

    ratio_missing = 0

    def run_group(
        blks: list[str], tag: str, payload_extra: dict | None = None
    ) -> tuple[list[dict], list[dict]]:
        nonlocal ratio_missing
        group_out = out / tag
        group_out.mkdir(parents=True, exist_ok=True)
        group_fps: list[dict] = []
        group_rows: list[dict] = []
        audio_parts: list[np.ndarray] = []
        rate = 24000
        ex = {**extra, **(payload_extra or {})}
        group_strength = (payload_extra or {}).get("wsolaCompensationStrength")
        for i, block in enumerate(blks, 1):
            x, rate, elapsed, ratio = synth_block(block, ex)
            fp = fingerprint(x, rate)
            save_wav(group_out / f"block-{i:02d}.wav", x, rate)
            audio_parts.append(x)
            # 长驻前台启动时 voice.log 可能没落盘 → 倍率读不到。此时**不能**
            # 把补偿 dB 记成 0：服务端其实按请求级强度照常补偿了，写 0 是假数据。
            if args.comp != "on":
                comp_db: list[float] | None = [0.0] * 4
            elif ratio is None:
                comp_db = None
                ratio_missing += 1
            else:
                comp_db = [round(v, 2) for v in band_compensation_db(ratio, group_strength)]
            group_fps.append(fp)
            group_rows.append(
                {
                    "index": i,
                    "chars": len(block),
                    "units": round(speech_units(block), 1),
                    "text": block[:28],
                    "elapsed_ms": round(elapsed),
                    "seg_speed_server": ratio,
                    "comp_band_db": comp_db,
                    **fp,
                }
            )
            print(
                f"  [{tag}] #{i:02d} {len(block):2d}字 {fp['duration_s']:5.2f}s "
                f"ratio={ratio} comp={'n/a(日志不可读)' if comp_db is None else comp_db} "
                f"centroid={fp['centroid_hz']:.0f}Hz "
                f"tilt={fp['tilt_db']:.1f}dB f0={fp['f0_hz']:.0f}Hz band={fp['band_db']}",
                flush=True,
            )
        save_wav(group_out / "full.wav", np.concatenate(audio_parts), rate)
        print(f"  [{tag}] 完整音频 {group_out / 'full.wav'}", flush=True)
        return group_fps, group_rows

    fps, rows = run_group(blocks, "baseline")
    dist = distances(fps)
    print("\n=== 相邻块距离（baseline） ===", flush=True)
    print(f"  联合      : {dist['adjacent_joint']}", flush=True)
    print(f"  MFCC      : {dist['adjacent_mfcc']}", flush=True)
    print(f"  频带 dB   : {dist['adjacent_band_db']}", flush=True)
    print(f"  F0 半音   : {dist['adjacent_f0_semitone']}", flush=True)
    print(f"  全体对均值: {dist['all_pairwise_mean']}", flush=True)

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "case": args.case,
        "engine": lp.ENGINE,
        "voice": lp.VOICE,
        "speed": lp.SPEED,
        "wsolaCompensation": args.comp,
        "ratio_log_available": ratio_missing == 0,
        "ratio_missing_count": ratio_missing,
        "block_chars_baseline": [len(b) for b in blocks],
        "blocks": rows,
        "distances": dist,
        "experiments": {},
    }

    if args.compare_blocks:
        new_blocks = lp.frontend_blocks(text, steady=True) if args.steady else uniform_blocks(blocks)
        tag = "steady" if args.steady else "uniform"
        print(
            f"\n=== {tag} 分块 === {len(new_blocks)} 块：{', '.join(str(len(b)) for b in new_blocks)} 字",
            flush=True,
        )
        uf, ur = run_group(new_blocks, tag)
        scale = joint_scale([fps, uf])
        bd, ud = distances(fps, scale), distances(uf, scale)
        report["uniform_blocks"] = {
            "block_chars": [len(b) for b in new_blocks],
            "rows": ur,
            "distances": ud,
            "baseline_distances_same_scale": bd,
            "comparison": {
                "adjacent_joint_max": [max(bd["adjacent_joint"]), max(ud["adjacent_joint"])],
                "adjacent_joint_mean": [round(float(np.mean(bd["adjacent_joint"])), 3), round(float(np.mean(ud["adjacent_joint"])), 3)],
                "adjacent_band_max": [max(bd["adjacent_band_db"]), max(ud["adjacent_band_db"])],
                "adjacent_band_mean": [round(float(np.mean(bd["adjacent_band_db"])), 3), round(float(np.mean(ud["adjacent_band_db"])), 3)],
                "all_pairwise_mean": [bd["all_pairwise_mean"], ud["all_pairwise_mean"]],
            },
        }
        print("\n=== A/B（同一把归一化尺子） ===", flush=True)
        print(f"  baseline 联合: {bd['adjacent_joint']}", flush=True)
        print(f"  uniform  联合: {ud['adjacent_joint']}", flush=True)
        print(f"  baseline 频带: {bd['adjacent_band_db']}", flush=True)
        print(f"  uniform  频带: {ud['adjacent_band_db']}", flush=True)
        print(f"  comparison: {report['uniform_blocks']['comparison']}", flush=True)

    if args.strengths:
        if args.comp != "on":
            print("[strengths] --comp off 时强度无意义，请用 --comp on", flush=True)
            return 2
        strengths: list[float] = []
        for raw in args.strengths.split(","):
            raw = raw.strip()
            if not raw:
                continue
            try:
                value = float(raw)
            except ValueError:
                print(f"[strengths] 忽略非法值 {raw!r}", flush=True)
                continue
            if 0.0 <= value <= 1.0 and value not in strengths:
                strengths.append(value)
        if not strengths:
            print("[strengths] 没有合法强度值", flush=True)
            return 2

        print(f"\n=== WSOLA 补偿强度扫描 === {strengths}", flush=True)
        groups: dict[str, list[dict]] = {"baseline-default": fps}
        group_rows: dict[str, list[dict]] = {"baseline-default": rows}
        for s in strengths:
            tag = f"strength-{s:g}"
            gfps, grows = run_group(blocks, tag, {"wsolaCompensationStrength": s})
            groups[tag], group_rows[tag] = gfps, grows

        # 关键：所有强度组共用同一把归一化尺子，否则跨组距离不可比
        scale = joint_scale(list(groups.values()))
        scan: dict[str, Any] = {}
        print("\n=== 强度扫描（跨组统一归一化尺度） ===", flush=True)
        print(
            "  group              jointMean jointMax  bandMean  bandMax  1to2Joint 1to2Band  allPair centroidSpread%",
            flush=True,
        )
        for tag, gfps in groups.items():
            d = distances(gfps, scale)
            cents = [f["centroid_hz"] for f in gfps]
            spread = round((max(cents) - min(cents)) / max(float(np.mean(cents)), 1e-6) * 100, 2)
            scan[tag] = {
                "adjacent_joint": d["adjacent_joint"],
                "adjacent_band_db": d["adjacent_band_db"],
                "joint_mean": round(float(np.mean(d["adjacent_joint"])), 3),
                "joint_max": max(d["adjacent_joint"]),
                "band_mean": round(float(np.mean(d["adjacent_band_db"])), 3),
                "band_max": max(d["adjacent_band_db"]),
                "first_pair_joint": d["adjacent_joint"][0],
                "first_pair_band": d["adjacent_band_db"][0],
                "all_pairwise_mean": d["all_pairwise_mean"],
                "centroid_spread_pct": spread,
            }
            v = scan[tag]
            print(
                f"  {tag:<18} {v['joint_mean']:>9.3f} {v['joint_max']:>8.3f} "
                f"{v['band_mean']:>9.3f} {v['band_max']:>8.3f} "
                f"{v['first_pair_joint']:>9.3f} {v['first_pair_band']:>9.3f} "
                f"{v['all_pairwise_mean']:>8.3f} {spread:>14.2f}",
                flush=True,
            )

        # 请求级参数零回归：显式传默认强度，应与不带该字段的 baseline 逐块指纹一致
        from wsola_compensation import COMPENSATION_STRENGTH as LOCAL_DEFAULT

        explicit = groups.get(f"strength-{LOCAL_DEFAULT:g}")
        zero_regression = (
            explicit is not None
            and len(fingerprint_signature(explicit)) == len(fingerprint_signature(fps))
            and all(
                abs(a - b) < 1e-6
                for a, b in zip(fingerprint_signature(explicit), fingerprint_signature(fps))
            )
        )
        print(f"\n  请求级默认强度零回归: {'PASS' if zero_regression else 'NOT VERIFIED'}", flush=True)
        print(f"  对比音频: {out}/strength-*/full.wav", flush=True)

        report["strength_scan"] = {
            "strengths": strengths,
            "module_default_strength": LOCAL_DEFAULT,
            "scale": "joint_scale across all groups",
            "ratio_log_available": ratio_missing == 0,
            "ratio_missing_count": ratio_missing,
            "note": (
                "倍率/补偿 dB 仅用于展示，不参与任何距离计算；"
                "若 ratio_log_available=false，是长驻前台启动未把日志落盘，"
                "请求级强度仍由 zero_regression 与组间指纹差异独立证明生效。"
            ),
            "groups": scan,
            "zero_regression_default_vs_explicit": zero_regression,
            "rows": group_rows,
        }
        (out / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n[out] {out}", flush=True)
        return 0

    if args.instructs:
        raw_specs = [s.strip() for s in args.instructs.split("|") if s.strip()]
        specs: list[tuple[str, dict, str]] = []
        for i, raw in enumerate(raw_specs):
            if raw == "default":
                specs.append((f"instruct-{i:02d}-default", {}, "default(不传字段=当前生产)"))
            elif raw == "none":
                specs.append((f"instruct-{i:02d}-none", {"instructOverride": ""}, "none(零 instruct / 纯 speaker)"))
            elif raw.startswith("voice:"):
                v = raw.split(":", 1)[1].strip()
                specs.append((f"instruct-{i:02d}-voice-{v}", {"voice": v}, f"voice={v}(纯 speaker 名，种子会变)"))
            else:
                specs.append((f"instruct-{i:02d}-short", {"instructOverride": raw}, raw))
        if not specs:
            print("[instructs] 没有合法项", flush=True)
            return 2

        print(
            f"\n=== instruct 单变量 A/B（voice / 采样种子组间完全相同）=== {len(specs)} 组",
            flush=True,
        )
        igroups: dict[str, list[dict]] = {"baseline-default": fps}
        irows: dict[str, list[dict]] = {"baseline-default": rows}
        meta: dict[str, str] = {"baseline-default": "default(不传字段=当前生产)"}
        for tag, payload_extra, label in specs:
            gfps, grows = run_group(blocks, tag, payload_extra)
            igroups[tag], irows[tag], meta[tag] = gfps, grows, label

        # 全部组共用一把尺子；否则跨组距离没有可比性
        scale = joint_scale(list(igroups.values()))

        def late_indices(gfps: list[dict], threshold: float = 40.0) -> list[int]:
            """累计时长越过 40s 之后的相邻对下标（用户反馈的后段区间）。"""
            acc: float = 0.0
            hit: list[int] = []
            for i, f in enumerate(gfps[:-1]):
                acc += f["duration_s"]
                if acc >= threshold:
                    hit.append(i)
            return hit

        iscan: dict[str, Any] = {}
        print("\n=== instruct 扫描（late40s = 累计 40s 之后的相邻对） ===", flush=True)
        print(
            "  group                      jointMean  bandMean  1to2Joint  1to2Band  late40sJoint  late40sBand  centroidSpread%",
            flush=True,
        )
        for tag, gfps in igroups.items():
            d = distances(gfps, scale)
            cents = [f["centroid_hz"] for f in gfps]
            spread = round((max(cents) - min(cents)) / max(float(np.mean(cents)), 1e-6) * 100, 2)
            li = late_indices(gfps)
            lj = round(float(np.mean([d["adjacent_joint"][i] for i in li])), 3) if li else None
            lb = round(float(np.mean([d["adjacent_band_db"][i] for i in li])), 3) if li else None
            iscan[tag] = {
                "label": meta[tag],
                "adjacent_joint": d["adjacent_joint"],
                "adjacent_band_db": d["adjacent_band_db"],
                "joint_mean": round(float(np.mean(d["adjacent_joint"])), 3),
                "band_mean": round(float(np.mean(d["adjacent_band_db"])), 3),
                "first_pair_joint": d["adjacent_joint"][0],
                "first_pair_band": d["adjacent_band_db"][0],
                "late40s_pair_indices": li,
                "late40s_joint_mean": lj,
                "late40s_band_mean": lb,
                "all_pairwise_mean": d["all_pairwise_mean"],
                "centroid_spread_pct": spread,
            }
            v = iscan[tag]
            print(
                f"  {tag:<26} {v['joint_mean']:>9.3f} {v['band_mean']:>9.3f} "
                f"{v['first_pair_joint']:>10.3f} {v['first_pair_band']:>9.3f} "
                f"{str(lj):>13} {str(lb):>12} {spread:>14.2f}",
                flush=True,
            )

        # 不传字段组必须与 baseline 逐块指纹一致（请求级参数零回归）
        default_tags = [t for t, e, _ in specs if e == {}]
        zero_regression = True
        if default_tags:
            t = default_tags[0]
            zero_regression = len(fingerprint_signature(igroups[t])) == len(
                fingerprint_signature(fps)
            ) and all(
                abs(a - b) < 1e-6
                for a, b in zip(fingerprint_signature(igroups[t]), fingerprint_signature(fps))
            )
        print(f"\n  请求级零回归: {'PASS' if zero_regression else 'NOT VERIFIED'}", flush=True)
        print(f"  对比音频: {out}/instruct-*/full.wav", flush=True)

        report["instruct_scan"] = {
            "specs": [{"tag": t, "payloadExtra": e, "label": m} for t, e, m in specs],
            "scale": "joint_scale across all groups",
            "control": (
                "default/none 组 voice 字符串与采样种子完全相同，唯一变量是 instruct；"
                "voice:* 组覆盖 voice，种子随之变化，仅用于验证零代码改动方案是否近似等价"
            ),
            "groups": iscan,
            "zero_regression_default_vs_baseline": zero_regression,
            "ratio_log_available": ratio_missing == 0,
            "ratio_missing_count": ratio_missing,
            "rows": irows,
        }
        (out / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n[out] {out}", flush=True)
        return 0

    if not args.skip_experiments:
        first = blocks[0]
        # E1 噪声底：同文本、同配置连生成两次
        x1, r1, _, _ = synth_block(first, extra)
        x2, r2, _, _ = synth_block(first, extra)
        e1 = delta(fingerprint(x1, r1), fingerprint(x2, r2))
        e1["bitwise_identical"] = bool(x1.shape == x2.shape and np.array_equal(x1, x2))
        report["experiments"]["E1_noise_floor_same_text"] = e1
        print(f"\n=== E1 噪声底（同文本重复） === {e1}", flush=True)

        # E2 位置效应：先跑 3 个无关请求，再生成同一段首块文本
        for warm in ("第一段预热文本，用来把模型推到稳定状态。", "第二段预热文本，内容完全不同。", "第三段预热文本，避免相邻重复。", ):
            try:
                synth_block(warm, extra)
            except Exception as exc:  # noqa: BLE001
                print(f"  [warn] 预热请求失败：{exc}", flush=True)
        x3, r3, _, _ = synth_block(first, extra)
        e2 = delta(fingerprint(x3, r3), fingerprint(x1, r1))
        e2["note"] = "位置 5 vs 位置 1；接近噪声底 => 无冷启动/顺序效应"
        report["experiments"]["E2_position_effect"] = e2
        print(f"=== E2 位置效应 === {e2}", flush=True)

        # E3 跨文本长度标定：4 个语料 × 4 个前缀长度。
        # 判据沿用第十三轮 WSOLA 标定的思路：若「短块相对 44 字基线的音色偏移」
        # 跨文本标准差远小于偏移本身，说明这是与文本内容无关的确定性规律，
        # 才允许按长度做统一补偿；否则必须诚实放弃，改走分块收敛。
        lengths = (14, 24, 34, 44)
        cases = ("pure_cn", "mixed_tech", "no_punct", "numbers")
        e3: dict[str, Any] = {"lengths": list(lengths), "per_case": {}, "cross_text": {}}
        per_case: dict[str, dict[str, dict]] = {}
        for case in cases:
            src = lp.TEXTS[case]
            per_case[case] = {}
            for n in lengths:
                seg = src[:n]
                xl, rl, _, ratio = synth_block(seg, extra)
                fpl = fingerprint(xl, rl)
                save_wav(out / f"length-{case}-{n:02d}.wav", xl, rl)
                per_case[case][str(n)] = {**fpl, "seg_speed_server": ratio}
                print(
                    f"=== E3 {case:11s} {n:2d}字 === ratio={ratio} "
                    f"centroid={fpl['centroid_hz']:.0f}Hz tilt={fpl['tilt_db']:.1f}dB "
                    f"f0={fpl['f0_hz']:.0f}Hz band1={fpl['band_db'][1]:.2f}dB",
                    flush=True,
                )
            e3["per_case"][case] = per_case[case]

        for metric in ("centroid_hz", "tilt_db", "f0_hz"):
            by_len: dict[str, list[float]] = {str(n): [] for n in lengths}
            for case in cases:
                base = per_case[case]["44"][metric]
                for n in lengths:
                    by_len[str(n)].append(per_case[case][str(n)][metric] - base)
            e3["cross_text"][metric] = {
                n: {
                    "delta_mean": round(float(np.mean(v)), 2),
                    "delta_std": round(float(np.std(v)), 2),
                    "delta_values": [round(x, 2) for x in v],
                }
                for n, v in by_len.items()
            }
            print(f"=== E3 cross-text {metric} ===", flush=True)
            for n in lengths:
                item = e3["cross_text"][metric][str(n)]
                print(f"    {n:2d}字  Δ均值={item['delta_mean']:7.2f} 跨文本σ={item['delta_std']:6.2f} {item['delta_values']}", flush=True)

        band_by_len: dict[str, list[list[float]]] = {str(n): [] for n in lengths}
        for case in cases:
            base = np.asarray(per_case[case]["44"]["band_db"])
            for n in lengths:
                band_by_len[str(n)].append((np.asarray(per_case[case][str(n)]["band_db"]) - base).tolist())
        e3["cross_text"]["band_db"] = {
            n: {
                "delta_mean": [round(float(v), 2) for v in np.mean(v, axis=0)],
                "delta_std": [round(float(v), 2) for v in np.std(v, axis=0)],
            }
            for n, v in band_by_len.items()
        }
        print("=== E3 cross-text band_db Δ均值 / 跨文本σ ===", flush=True)
        for n in lengths:
            item = e3["cross_text"]["band_db"][str(n)]
            print(f"    {n:2d}字  mean={item['delta_mean']} std={item['delta_std']}", flush=True)
        report["experiments"]["E3_length_effect"] = e3

    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[out] {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
