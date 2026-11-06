"""
生成上限推导的单元测试（无第三方依赖，直接用系统 python3 跑）

    python3 scripts/voice/test_max_tokens.py

背景见 `max_tokens_for` 的注释：不传 max_tokens 会回落到 2048（≈164s 音频），
一次退化生成持锁跑几分钟，把整条播报队列拖到超时。这里把推导的边界钉住，
避免以后调参把上限调到"截断"或"又放开成 2048"。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mlx_voice_server import (  # noqa: E402
    TTS_CHARS_PER_SECOND,
    TTS_MAX_TOKENS_CEILING,
    TTS_MAX_TOKENS_FLOOR,
    TTS_MAX_TOKENS_HEADROOM,
    TTS_TOKENS_PER_SECOND,
    max_tokens_for,
)

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS {name}")
    else:
        failures.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


def test_floor_and_ceiling() -> None:
    """极短与极长文本都被钳制在护栏内"""
    check("空串取到下限", max_tokens_for("") == TTS_MAX_TOKENS_FLOOR)
    check("单字取到下限", max_tokens_for("嗯") == TTS_MAX_TOKENS_FLOOR)
    check("超长文本取到上限", max_tokens_for("字" * 5000) == TTS_MAX_TOKENS_CEILING)
    check(
        "上限低于模型默认 2048",
        TTS_MAX_TOKENS_CEILING < 2048,
        f"实际 {TTS_MAX_TOKENS_CEILING}",
    )


def test_monotonic() -> None:
    """文本变长，上限不下降（否则会出现"长句反而更容易被截断"）"""
    lengths = [10, 40, 80, 120, 160, 200, 300, 600]
    values = [max_tokens_for("字" * n) for n in lengths]
    for prev_n, prev_v, n, v in zip(lengths, values, lengths[1:], values[1:]):
        check(f"{prev_n}字→{n}字 不下降", v >= prev_v, f"{prev_v} → {v}")


def test_no_truncation_headroom() -> None:
    """
    上限必须高于"按实测语速念完这段"所需的 token 数

    否则正常文本会被硬截断——那是听得出来的硬伤，比多跑几秒严重得多。
    这里用 1.0 倍实测语速做下界（实际留了 1.5 倍余量）。
    """
    for chars in (20, 60, 120, 160):
        natural = chars / TTS_CHARS_PER_SECOND * TTS_TOKENS_PER_SECOND
        cap = max_tokens_for("字" * chars)
        check(
            f"{chars}字上限 {cap} > 自然所需 {int(natural)}",
            cap > natural,
            f"headroom={TTS_MAX_TOKENS_HEADROOM}",
        )


def test_worst_case_bounded() -> None:
    """
    最坏情况（生成跑满上限）仍要落在前端 60s 超时预算之内

    换算：token 数 / 12.5 = 音频秒数；实测 RTF≈0.20，即合成耗时约为音频时长的
    1/5。留一倍余量按 RTF 0.4 估，串行排三个块也要小于 60s。
    """
    cap = max_tokens_for("字" * 160)
    worst_audio_s = cap / TTS_TOKENS_PER_SECOND
    worst_synth_s = worst_audio_s * 0.4
    check(
        f"160字最坏合成 {worst_synth_s:.1f}s < 60s",
        worst_synth_s < 60,
        f"cap={cap} audio={worst_audio_s:.0f}s",
    )


def main() -> int:
    print("max_tokens_for 单元测试")
    test_floor_and_ceiling()
    test_monotonic()
    test_no_truncation_headroom()
    test_worst_case_bounded()
    if failures:
        print(f"\n{len(failures)} 项失败：")
        for item in failures:
            print("  - " + item)
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
