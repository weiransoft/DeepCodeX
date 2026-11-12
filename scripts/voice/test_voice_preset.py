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

import mlx_voice_server as server  # noqa: E402
from mlx_voice_server import (  # noqa: E402
    TTS_MAX_TEXT_CHARS,
    VOICE_PRESETS,
    is_silent_chunk,
    max_tokens_for,
    resolve_speaker,
    split_long_text,
    time_stretch_wsola,
    trim_degenerate_tail,
    voice_seed_key,
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
    check(
        "自由描述归一为稳定预设",
        resolve_speaker(desc) == VOICE_PRESETS[server.STABLE_VOICE_FALLBACK],
        f"实际 {resolve_speaker(desc)!r}",
    )
    check("预设表有推荐与备选", "sinan" in VOICE_PRESETS and "sinan-bright" in VOICE_PRESETS)


def test_stable_voice_identity() -> None:
    """第九轮：自由描述不再逐块重新诠释，且旧行为可逐字回退

    契约变更不等于刷绿：同一组描述同时断言「新默认」与「关开关后的旧默认」，
    关掉开关必须拿到逐字一致的 (vivian, 原描述)，不能只把期望值改成新结果。
    """
    desc = "20岁女性，高音区，语速偏快，气息柔和，耐心，句尾轻收（slow pace, soft）"
    other = "少年女性，中音区，语速平稳，吐字清晰"
    stable = VOICE_PRESETS[server.STABLE_VOICE_FALLBACK]

    check("长描述归一到稳定预设", resolve_speaker(desc) == stable)
    check("不同描述归一到同一身份", resolve_speaker(desc) == resolve_speaker(other))
    check(
        "描述里增删字词不改变身份",
        resolve_speaker(desc) == resolve_speaker(desc + " "),
    )
    check("预设名不受归一影响", resolve_speaker("sinan") == VOICE_PRESETS["sinan"])
    check("预置 speaker 名不受归一影响", resolve_speaker("vivian") == ("vivian", None))

    # 种子：已有预设/speaker 路径必须逐字不变；自由描述归一后与显式写预设同键，
    # 这样第九轮的全部真机 A/B 对「配置写 sinan」和「代码兜底归一」都成立。
    check("预设名种子逐字保持", voice_seed_key("sinan") == "sinan")
    check("大小写写法种子逐字保持", voice_seed_key("SINAN") == "SINAN")
    check("speaker 名种子逐字保持", voice_seed_key("vivian") == "vivian")
    check(
        "自由描述归一后与预设同种子",
        voice_seed_key(desc) == voice_seed_key(server.STABLE_VOICE_FALLBACK),
    )

    original = server.STABLE_VOICE_IDENTITY
    try:
        server.STABLE_VOICE_IDENTITY = False
        check(
            "回退开关恢复旧行为（A/B 对照）",
            resolve_speaker(desc) == ("vivian", desc),
            f"实际 {resolve_speaker(desc)!r}",
        )
        check("回退开关恢复旧种子键", voice_seed_key(desc) == desc)
    finally:
        server.STABLE_VOICE_IDENTITY = original
    check("回退后重新生效新默认", resolve_speaker(desc) == stable)


def test_stream_budget_unchanged() -> None:
    """流式不改变生成上限：退化请求仍要被护栏兜住"""
    check("160 字上限仍有界", max_tokens_for("啊" * 160) <= 1024)
    check("极短文本仍有下限", max_tokens_for("嗯") >= 200)


def test_trim_degenerate_tail() -> None:
    """长文本退化出的尾部静音要裁掉，正常句尾停顿不能动

    真机反馈「第二段讲了几句中间就中断了」：不是播放断了，是模型一路
    生成到 max_tokens 上限，尾部吐出 21.5s 纯静音。实测退化段全在尾部，
    正常语义停顿最长 0.68s，所以阈值取 1.0s 能精确区分。
    """
    sr = 24000
    t = np.arange(sr, dtype=np.float32) / sr
    tone = (np.sin(t * 2 * np.pi * 220) * 0.5).astype(np.float32)

    normal = np.concatenate([tone, np.zeros(int(0.45 * sr), dtype=np.float32)])
    check("正常 0.45s 句尾不裁", len(trim_degenerate_tail(normal, sr)) == len(normal))

    degenerate = np.concatenate([tone, np.zeros(int(21 * sr), dtype=np.float32)])
    trimmed = trim_degenerate_tail(degenerate, sr)
    kept = (len(trimmed) - len(tone)) / sr
    check("21s 退化静音裁到约 0.25s", 0.2 <= kept <= 0.35, f"实际保留 {kept:.2f}s")
    check("裁剪不吞掉有声部分", np.array_equal(trimmed[: len(tone)], tone))

    check("纯静音块判定为静音", is_silent_chunk(np.zeros(sr, dtype=np.float32)))
    check("有声块不判静音", not is_silent_chunk(tone))


def test_split_long_text() -> None:
    """服务端长文本兜底：任何片段都不超过安全上限，且逐字可还原

    裁尾只能去掉退化静音，救不回 96 字那种「模型念到一半就塌缩」的截断
    （实测裁完只剩 8.00s 有声片段，应有 19.5s）。真正的修复是把请求拆短。
    """
    check("空文本返回空列表", split_long_text("   ") == [])
    short = "我把这三处都核对了一遍，结论比较清楚。"
    check("短文本不切分", split_long_text(short) == [short])
    check("安全上限与前端一致", TTS_MAX_TEXT_CHARS == 48)

    sentence = "我把这三处都核对了一遍，结论比较清楚：先处理回滚路径，再收敛音色，最后看生成延迟。"
    long = sentence * 4
    parts = split_long_text(long)
    check("164 字被拆成多段", len(parts) > 1, f"实际 {len(parts)} 段")
    check("每段都不超过上限", all(len(p) <= TTS_MAX_TEXT_CHARS for p in parts))
    check("拼接逐字还原", "".join(parts) == long)
    check("优先在标点处断", any(p[-1] in "。！？!?；;，,、：:" for p in parts[:-1]))

    no_punct = "这里没有标点" * 20
    parts = split_long_text(no_punct)
    check("无标点文本也不丢字", "".join(parts) == no_punct)
    check("无标点文本也不超上限", all(len(p) <= TTS_MAX_TEXT_CHARS for p in parts))


print("=== WSOLA 保调变速 ===")
test_wsola_keeps_pitch()
test_wsola_edges()
print("=== 音色预设 ===")
test_voice_presets()
print("=== 稳定音色身份（第九轮） ===")
test_stable_voice_identity()
print("=== 生成上限回归 ===")
test_stream_budget_unchanged()
print("=== 退化静音裁剪 ===")
test_trim_degenerate_tail()
print("=== 长文本服务端兜底分段 ===")
test_split_long_text()

print()
if failures:
    print(f"失败 {len(failures)} 项：")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print("全部通过")
