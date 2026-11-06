"""音色预设 / 保调变速 / 生成上限的单元测试（无第三方依赖，python3 直跑）

    python3 scripts/voice/test_voice_preset.py

背景：用户反馈「语速太慢、声音不对」。定位到两个可量化的问题：
1. 原来用 np.interp 重采样变速，speed=1.25 时 F0 从 237.6Hz 升到 279.1Hz
   （磁带快进），音高跟着速度走 —— 换成 WSOLA 保调变速；
2. 音色配置从 VoiceDesign 的中文描述切到 CustomVoice 的 vivian，
   与司南人设「成熟女性、中低音区、克制」不符 —— 做成 sinan 预设。
这里把这两个结论钉成断言，避免以后调参又退回去。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mlx_voice_server import (  # noqa: E402
    VOICE_PRESETS,
    max_tokens_for,
    resolve_speaker,
    time_stretch_wsola,
)

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS {name}")
    else:
        failures.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


SR = 24000


def tone(freq: float, seconds: float) -> np.ndarray:
    t = np.arange(int(SR * seconds), dtype=np.float32) / SR
    return (0.5 * np.sin(2 * np.pi * freq * t) + 0.15 * np.sin(2 * np.pi * 2 * freq * t)).astype(np.float32)


def f0(samples: np.ndarray) -> float:
    seg = samples[:2048] - samples[:2048].mean()
    corr = np.correlate(seg, seg, mode="full")[2047:]
    lo, hi = int(SR / 400), int(SR / 80)
    corr[:lo] = 0
    window = corr[lo:hi]
    return SR / (lo + int(np.argmax(window)))


def test_wsola_keeps_pitch() -> None:
    """保调变速的核心契约：速度按倍数变，音高不动"""
    x = tone(220.0, 3.0)
    base_f0 = f0(x)
    for speed in (1.1, 1.15, 1.2, 1.25, 1.5, 0.9):
        y = time_stretch_wsola(x, speed)
        ratio = len(x) / len(y)
        pitch = f0(y)
        check(
            f"speed={speed} 速度倍率 {ratio:.3f}",
            abs(ratio - speed) < 0.03 * speed,
            f"实际 {ratio:.3f}",
        )
        check(
            f"speed={speed} 音高不变",
            abs(pitch - base_f0) < 3.0,
            f"F0 {base_f0:.1f} -> {pitch:.1f}Hz",
        )


def test_wsola_edges() -> None:
    """边界：speed=1 原样、极短音频不处理、非正速度不炸"""
    x = tone(300.0, 0.5)
    check("speed=1 原样返回", np.array_equal(time_stretch_wsola(x, 1.0), x))
    short = tone(300.0, 0.01)
    check("极短音频直接返回", np.array_equal(time_stretch_wsola(short, 1.3), short))
    check("speed<=0 直接返回", np.array_equal(time_stretch_wsola(x, 0.0), x))


def test_voice_presets() -> None:
    """司南预设展开成 (speaker, instruct)，且与 core 的人设描述对齐"""
    speaker, instruct = resolve_speaker("sinan")
    check("sinan -> serena", speaker == "serena", f"实际 {speaker}")
    check("sinan 带风格指令", instruct is not None and "中低音区" in instruct)
    check("sinan 要求语速稍快", instruct is not None and "语速稍快" in instruct)
    check("sinan 保持克制不撒娇", instruct is not None and "克制不撒娇" in instruct)
    check("SINAN 大小写不敏感", resolve_speaker("SINAN") == resolve_speaker("sinan"))
    check("sinan-bright 可切换", resolve_speaker("sinan-bright")[0] == "vivian")
    check("原预置音色仍可用", resolve_speaker("vivian") == ("vivian", None))
    desc = "成熟女性，中低音区"
    check("自由描述回落为 instruct", resolve_speaker(desc) == ("vivian", desc))
    check("预设表有推荐与备选", "sinan" in VOICE_PRESETS and "sinan-bright" in VOICE_PRESETS)


def test_stream_budget_unchanged() -> None:
    """流式不改变生成上限：退化请求仍要被护栏兜住"""
    check("160 字上限仍有界", max_tokens_for("啊" * 160) <= 1024)
    check("极短文本仍有下限", max_tokens_for("嗯") >= 200)


print("=== WSOLA 保调变速 ===")
test_wsola_keeps_pitch()
test_wsola_edges()
print("=== 音色预设 ===")
test_voice_presets()
print("=== 生成上限回归 ===")
test_stream_budget_unchanged()

print()
if failures:
    print(f"失败 {len(failures)} 项：")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print("全部通过")
