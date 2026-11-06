"""逐块语速伺服的纯函数单测（不依赖 MLX 模型，可离线跑）。

锁住三件事：
1. `trim_speech_edges()` 只裁首尾机械静音，不动句内语义停顿，也不吞有声样本；
2. `segment_stretch_speed()` 按「全局固定基准 / 实测语速」算倍率并钳制；
3. 应用这个倍率后，不同原生语速的段都收敛到同一个目标语速。

背景：2026-11-06 真机反馈「还是存在语速跳变，句子一长就不行了」。
同一次模型加载下实测原生语速 4.09~5.35 字/秒（跨度 31%），原来的
「整段一次等比变速」压不住块间相对差，才改成按块伺服。
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mlx_voice_server import (  # noqa: E402
    TTS_CHARS_PER_SECOND,
    TTS_RATE_SPEED_MAX,
    TTS_RATE_SPEED_MIN,
    TTS_SEGMENT_GAP_S,
    segment_stretch_speed,
    time_stretch_wsola,
    trim_speech_edges,
)

SR = 24000
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(name)


def tone(seconds: float, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    # 加一点包络，避免纯稳态正弦让 WSOLA 的相似度搜索退化
    env = 0.6 + 0.3 * np.sin(2 * np.pi * 3 * t)
    return (np.sin(2 * np.pi * freq * t) * env).astype(np.float32)


def concat(*parts: np.ndarray) -> np.ndarray:
    return np.concatenate([np.asarray(p, dtype=np.float32).reshape(-1) for p in parts])


print("=== trim_speech_edges：只裁首尾机械静音 ===")
voice = tone(1.0)
pad_head = np.zeros(int(0.5 * SR), dtype=np.float32)
pad_tail = np.zeros(int(0.7 * SR), dtype=np.float32)
trimmed = trim_speech_edges(concat(pad_head, voice, pad_tail), SR)
expected = 1.0 + 0.02 + 0.08
check("首尾 padding 被裁掉", abs(len(trimmed) / SR - expected) < 0.01, f"{len(trimmed)/SR:.3f}s vs {expected:.2f}s")
check("裁完不含 0.5s 头部空白", float(np.max(np.abs(trimmed[: int(0.3 * SR)]))) > 0.1)

mid_gap = np.zeros(int(0.45 * SR), dtype=np.float32)
with_gap = trim_speech_edges(concat(pad_head, voice, mid_gap, voice, pad_tail), SR)
check("句内 0.45s 语义停顿完整保留", abs(len(with_gap) / SR - (2.0 + 0.45 + 0.1)) < 0.02, f"{len(with_gap)/SR:.3f}s")
# 裁完布局：0.02s 边距 + 1.0s 有声 + 0.45s 停顿 + 1.0s 有声 + 0.08s 边距
gap_region = with_gap[int(1.05 * SR) : int(1.42 * SR)]
check("停顿区确实仍是静音", float(np.max(np.abs(gap_region))) < 1e-6)

silence = np.zeros(int(1.0 * SR), dtype=np.float32)
check("纯静音段返回空数组", trim_speech_edges(silence, SR).size == 0)
check("空输入返回空数组", trim_speech_edges(np.zeros(0, dtype=np.float32), SR).size == 0)
already_clean = trim_speech_edges(voice, SR)
check("无 padding 时不吞掉有声样本", abs(len(already_clean) / SR - 1.0) < 0.02, f"{len(already_clean)/SR:.3f}s")

print("\n=== segment_stretch_speed：全局固定基准 / 实测语速 ===")
SPEED = 1.2
TARGET = TTS_CHARS_PER_SECOND * SPEED  # 4.92 字/秒


def speed_for(chars: int, seconds: float) -> float:
    return segment_stretch_speed(tone(seconds), SR, chars, SPEED)


check("目标基准 = 4.1 × speed", abs(TARGET - 4.92) < 1e-6, f"{TARGET:.3f}")
s_fast = speed_for(48, 9.0)  # 5.33 字/秒，读太快 → 放慢
s_slow = speed_for(41, 9.83)  # 4.17 字/秒，读太慢 → 加速
check("读太快的段倍率 <1（放慢）", s_fast < 1.0, f"{s_fast:.3f}")
check("读太慢的段倍率 >1（加速）", s_slow > 1.0, f"{s_slow:.3f}")
check("倍率 ≈ 目标/实测（快段）", abs(s_fast - TARGET / (48 / 9.0)) < 1e-6, f"{s_fast:.3f}")
check("倍率 ≈ 目标/实测（慢段）", abs(s_slow - TARGET / (41 / 9.83)) < 1e-6, f"{s_slow:.3f}")
check("speed=1.0 时目标为 4.1 字/秒", abs(segment_stretch_speed(tone(4.0), SR, 20, 1.0) - 4.1 / 5.0) < 1e-6)
check("极端快被钳到下限", segment_stretch_speed(tone(1.0), SR, 200, SPEED) == TTS_RATE_SPEED_MIN)
check("极端慢被钳到上限", segment_stretch_speed(tone(20.0), SR, 2, SPEED) == TTS_RATE_SPEED_MAX)
check("零时长回落到 speed", segment_stretch_speed(np.zeros(0, dtype=np.float32), SR, 20, SPEED) == SPEED)
check("零字数回落到 speed", segment_stretch_speed(tone(1.0), SR, 0, SPEED) == SPEED)
check("非法 speed 不产生非正倍率", segment_stretch_speed(tone(1.0), SR, 20, 0.0) > 0)

print("\n=== 归一化后语速收敛（离线等价验证）===")
# 模拟真机实测的 6 段原生语速（字数 / 时长）
CASES = [
    ("短句 14 字", 14, 3.424),
    ("短句 20 字", 20, 4.069),
    ("标准 41 字", 41, 9.833),
    ("无标点 41 字", 41, 8.074),
    ("无标点 48 字", 48, 8.965),
    ("逗号密集 48 字", 48, 10.171),
]
raw_rates: list[float] = []
out_rates: list[float] = []
for label, chars, seconds in CASES:
    samples = tone(seconds)
    s = segment_stretch_speed(samples, SR, chars, SPEED)
    stretched = time_stretch_wsola(samples, s)
    raw_rates.append(chars / seconds)
    out_rates.append(chars / (stretched.size / SR))
    print(f"  {label:<16} 原生 {raw_rates[-1]:5.2f} → 归一 {out_rates[-1]:5.2f} 字/秒 (倍率 {s:.3f})")
    check(f"{label} 收敛到目标 ±3%", abs(out_rates[-1] - TARGET) / TARGET < 0.03)

check(
    "归一化把语速跨度从 31% 压到 3% 以内",
    (max(raw_rates) - min(raw_rates)) / float(np.mean(raw_rates)) > 0.25
    and (max(out_rates) - min(out_rates)) / float(np.mean(out_rates)) < 0.03,
    f"原生极差 {(max(raw_rates)-min(raw_rates))/float(np.mean(raw_rates))*100:.1f}% → 归一后 {(max(out_rates)-min(out_rates))/float(np.mean(out_rates))*100:.1f}%",
)

print("\n=== 段间微停顿 ===")
check("停顿落在业界建议的 50~200ms", 0.05 <= TTS_SEGMENT_GAP_S <= 0.2, f"{TTS_SEGMENT_GAP_S*1000:.0f}ms")

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: {', '.join(FAILED)}")
    raise SystemExit(1)
print("ALL PASS")
