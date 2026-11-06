"""跨 chunk 有状态 WSOLA 的等价性单测（无第三方依赖，python3 直跑）

    python3 scripts/voice/test_streaming_wsola.py

背景：流式 `/tts/stream` 以前对每个 0.8s chunk 各跑一次 `time_stretch_wsola()`。
WSOLA 的窗函数、搜索用的「上一帧重叠区」、理想分析位置都是跨帧状态，每块
重新起一次就没有前一帧可对齐。真机实测 speed=1.2 时块边界样本跳变中位
2.8% / 最大 19.4%（speed=1.0 只有 0.1% / 1.2%），听感就是「前后两句语速
不一样」「讲了几句中间像断了一下」。

`StreamingWsola` 把状态留在实例上。这里把最关键的性质钉成断言：

    分 N 次 feed() + flush()  ==  整段一次 time_stretch_wsola()

只要这条成立，流式块就只是「整块变速结果」的连续时间切片，边界不可能再
因为变速重启而失真；默认打开流式才站得住脚。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mlx_voice_server import (  # noqa: E402
    StreamingWsola,
    time_stretch_wsola,
)

failures: list[str] = []

SR = 24000


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS {name}")
    else:
        failures.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


def make_signal(seconds: float = 3.0, seed: int = 7) -> np.ndarray:
    """确定性「类语音」信号：基频 + 谐波 + 慢包络 + 极轻噪声"""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    env = (0.5 + 0.5 * np.sin(2 * np.pi * 2.3 * t)).astype(np.float32)
    carrier = (
        np.sin(2 * np.pi * 213 * t) * 0.55
        + np.sin(2 * np.pi * 426 * t) * 0.20
        + np.sin(2 * np.pi * 851 * t) * 0.08
    )
    return (carrier * env + rng.normal(0, 0.002, n)).astype(np.float32)


def split_even(x: np.ndarray, chunk_s: float = 0.8) -> list[np.ndarray]:
    """模拟真机：interval=1.0 时约每 0.8s 一块"""
    size = int(chunk_s * SR)
    return [x[i : i + size] for i in range(0, x.size, size)]


def split_irregular(x: np.ndarray, seed: int = 11) -> list[np.ndarray]:
    """不规则块长：覆盖「不足一帧」与「跨多帧」两类 feed"""
    rng = np.random.default_rng(seed)
    out: list[np.ndarray] = []
    pos = 0
    while pos < x.size:
        step = int(rng.integers(300, 6000))
        out.append(x[pos : pos + step])
        pos += step
    return out


def streamed(chunks: list[np.ndarray], speed: float) -> tuple[np.ndarray, list[np.ndarray]]:
    """喂完所有块并收尾，返回 (拼接结果, 各块输出)"""
    stretcher = StreamingWsola(speed)
    parts = [stretcher.feed(chunk) for chunk in chunks]
    parts.append(stretcher.flush())
    return np.concatenate(parts), parts


def independent(chunks: list[np.ndarray], speed: float) -> list[np.ndarray]:
    """旧行为对照：每块独立跑一次离线 WSOLA"""
    return [time_stretch_wsola(chunk, speed) for chunk in chunks]


def boundary_jumps(parts: list[np.ndarray], peak: float) -> list[float]:
    """相邻块边界的样本跳变 / 全局峰值"""
    jumps: list[float] = []
    for left, right in zip(parts, parts[1:]):
        if left.size == 0 or right.size == 0:
            continue
        jumps.append(abs(float(right[0]) - float(left[-1])) / peak)
    return jumps


def max_diff(a: np.ndarray, b: np.ndarray) -> float:
    if a.size != b.size:
        return float("inf")
    return float(np.max(np.abs(a - b))) if a.size else 0.0


print("=== 有状态 WSOLA == 整块离线 WSOLA ===")
signal = make_signal()
peak = float(np.max(np.abs(signal)))
for speed in (1.2, 0.85, 1.5):
    whole = time_stretch_wsola(signal, speed)

    once, _ = streamed([signal], speed)
    check(
        f"speed={speed} 一次 feed+flush 与整块逐样本一致",
        max_diff(once, whole) < 1e-6,
        f"长度 {once.size} vs {whole.size}, max_diff={max_diff(once, whole):.2e}",
    )

    even = split_even(signal)
    even_out, _ = streamed(even, speed)
    check(
        f"speed={speed} 等长分 {len(even)} 块与整块逐样本一致",
        max_diff(even_out, whole) < 1e-6,
        f"长度 {even_out.size} vs {whole.size}, max_diff={max_diff(even_out, whole):.2e}",
    )

    odd = split_irregular(signal)
    odd_out, _ = streamed(odd, speed)
    check(
        f"speed={speed} 不规则分 {len(odd)} 块与整块逐样本一致",
        max_diff(odd_out, whole) < 1e-6,
        f"长度 {odd_out.size} vs {whole.size}, max_diff={max_diff(odd_out, whole):.2e}",
    )

    check(
        f"speed={speed} 时长倍率正确",
        abs(whole.size / signal.size - 1.0 / speed) < 0.02,
        f"实测 {whole.size / signal.size:.4f}, 期望 {1.0 / speed:.4f}",
    )

print("=== 块边界失真：有状态 vs 逐块独立 WSOLA ===")
speed = 1.2
even = split_even(signal)
_, state_parts = streamed(even, speed)
old_parts = independent(even, speed)
state_jumps = boundary_jumps([p for p in state_parts if p.size], peak)
old_jumps = boundary_jumps(old_parts, peak)
print(
    f"  逐块独立: 中位 {np.median(old_jumps) * 100:.1f}%  最大 {max(old_jumps) * 100:.1f}%"
)
print(
    f"  有状态  : 中位 {np.median(state_jumps) * 100:.1f}%  最大 {max(state_jumps) * 100:.1f}%"
)
check(
    "有状态边界跳变显著小于逐块独立（最大 < 逐块的 1/4）",
    max(state_jumps) < max(old_jumps) / 4,
    f"{max(state_jumps) * 100:.1f}% vs {max(old_jumps) * 100:.1f}%",
)

print("=== 保调与直通 ===")
tone = (np.sin(2 * np.pi * 220 * np.arange(SR) / SR) * 0.6).astype(np.float32)
st = StreamingWsola(1.25)
stretched = np.concatenate([st.feed(tone), st.flush()])
spectrum = np.abs(np.fft.rfft(stretched * np.hanning(stretched.size)))
freqs = np.fft.rfftfreq(stretched.size, 1.0 / SR)
f0 = float(freqs[int(np.argmax(spectrum))])
check("speed=1.25 后 F0 仍为 220Hz（保调）", abs(f0 - 220.0) <= 2.0, f"实测 {f0:.1f}Hz")
check("speed=1.25 时长压缩到约 0.8s", abs(stretched.size / SR - 0.8) < 0.02, f"实测 {stretched.size / SR:.4f}s")

st1 = StreamingWsola(1.0)
out1 = st1.feed(signal)
tail1 = st1.flush()
check("speed=1.0 feed 原样透传（零额外缓冲延迟）", np.array_equal(out1, signal))
check("speed=1.0 flush 为空", tail1.size == 0)
check("flush 幂等，第二次不重复吐样本", st1.flush().size == 0)

short = signal[: 2000]
st2 = StreamingWsola(1.2)
short_out = np.concatenate([st2.feed(short), st2.flush()])
check(
    "短输入（<4096）与整块实现一致：原样透传不变速",
    np.array_equal(short_out, short),
    f"输出 {short_out.size} vs 输入 {short.size}",
)

# 流式最后一个 chunk 往往不足一帧，flush 必须把它吐出来而不是丢掉
st3 = StreamingWsola(1.2)
parts3 = [st3.feed(chunk) for chunk in split_even(signal)]
parts3.append(st3.flush())
check(
    "flush 收尾后拼接长度等于整块变速结果",
    sum(p.size for p in parts3) == time_stretch_wsola(signal, 1.2).size,
    f"{sum(p.size for p in parts3)} vs {time_stretch_wsola(signal, 1.2).size}",
)

print()
if failures:
    print(f"FAILED: {len(failures)}")
    for item in failures:
        print(f"  - {item}")
    sys.exit(1)
print("ALL PASS")
