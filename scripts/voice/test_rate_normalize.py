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
    TTS_MAX_TEXT_CHARS,
    TTS_RATE_SPEED_MAX,
    TTS_RATE_SPEED_MIN,
    TTS_SEGMENT_GAP_S,
    TTS_SHORT_SPEED_MAX,
    TTS_SHORT_SPEED_MIN,
    TTS_SPLIT_MIN_TAIL_UNITS,
    _split_boundary_class,
    compress_internal_gaps,
    rebalance_tail,
    segment_servo_speed,
    segment_stretch_speed,
    speech_units,
    split_long_text,
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

# ---------------------------------------------------------------------------
# 2026-11-07 长文本专项：等效发音单元 / 短块护栏 / 尾段平衡 / 异常静音
#
# 真机反馈「长文本还是会变语速，音色变了」。用 316/421 字真实回复复刻前端
# 分块链路实测：中英混排块间语速极差 76.37%、3 字碎片 F0 冲到 304Hz，
# 根因是伺服拿「字符数」当发音量，以及几字碎片被模型当短促感叹句。
# ---------------------------------------------------------------------------
print("\n=== 等效发音单元：语速伺服的正确分母 ===")
cn = "我先把刚才那三处改动捋了一遍，慢慢说给你听。"
hanzi = sum(1 for c in cn if "\u4e00" <= c <= "\u9fff")
check("纯中文 units == 汉字数（标点为 0）", abs(speech_units(cn) - hanzi) < 1e-6, f"{speech_units(cn):.2f} vs {hanzi}")
check("标点不发音", abs(speech_units("你好。") - speech_units("你好")) < 1e-6)
mixed = "resolveThinkingDepth 每轮输出 off、light、balanced、full 四档。"
check(
    "中英混排 units 显著小于字符数",
    speech_units(mixed) < len(mixed) * 0.75,
    f"{speech_units(mixed):.2f} units / {len(mixed)} chars",
)
check("全大写缩写逐字母念", speech_units("TTFT") > speech_units("ttft"), f"{speech_units('TTFT'):.2f} > {speech_units('ttft'):.2f}")
check("数字串按位折算", 2.5 < speech_units("2026") < 4.5, f"{speech_units('2026'):.2f}")
check("空文本 / 纯标点返回 0", speech_units("") == 0 and speech_units("，。！") == 0)

print("\n=== 段级伺服：不同原生语速收敛到同一目标 ===")
servo_text = "这是一段普通的中文说明文字，用来验证语速伺服是否收敛到全局目标语速。"
servo_units = speech_units(servo_text)
servo_rates: list[float] = []
for native in (3.9, 4.92, 6.1):
    seconds = servo_units / native
    raw = tone(seconds)
    ratio = segment_servo_speed(raw, SR, servo_text, SPEED)
    out = time_stretch_wsola(raw, ratio)
    rate = servo_units / (out.size / SR)
    servo_rates.append(rate)
    check(f"原生 {native:.2f} 单元/秒收敛到 {TARGET:.2f} ±5%", abs(rate - TARGET) / TARGET < 0.05, f"{rate:.2f} (倍率 {ratio:.3f})")
check("收敛后跨度 < 5%", (max(servo_rates) - min(servo_rates)) / float(np.mean(servo_rates)) < 0.05)

tiny = "嗯。"
tiny_ratio = segment_servo_speed(tone(0.2), SR, tiny, SPEED)
check(
    "极短碎片倍率被护栏钳住（不极端变速）",
    TTS_SHORT_SPEED_MIN <= tiny_ratio <= TTS_SHORT_SPEED_MAX,
    f"{tiny_ratio:.3f}",
)
plain = tone(servo_units / 4.0)
check(
    "正常块不被短块护栏改写",
    abs(segment_servo_speed(plain, SR, servo_text, SPEED) - segment_stretch_speed(plain, SR, servo_units, SPEED)) < 1e-9,
)

print("\n=== 长文本分段：不产生碎片且逐字可逆 ===")
long_text = "没有标点的长文本最能暴露语速漂移的问题因为模型看不到任何句读提示只能自己决定在哪里换气" * 3
parts = split_long_text(long_text)
check("拼接逐字等于原文", "".join(parts) == long_text.strip())
check("每段不超过安全上限", all(len(p) <= TTS_MAX_TEXT_CHARS for p in parts), str([len(p) for p in parts]))
check("尾段达到最短发音量", speech_units(parts[-1]) >= TTS_SPLIT_MIN_TAIL_UNITS, f"{speech_units(parts[-1]):.1f} units")

print("\n=== 伺服上限：纯拉丁复合词慢段也要能拉回全局基准 ===")
# 真机实测：`openai-provider 和 anthropic-provider。` 原生只有 3.06 单元/秒，
# 需要 1.61 倍。旧上限 1.35 把它钳在 4.14 单元/秒，成为中英混排里唯一的
# 离群块（单元语速极差 17.08%）。这段没有长静音，是正常段而非模型退化。
latin = "openai-provider 和 anthropic-provider。"
latin_units = speech_units(latin)
latin_native_s = latin_units / 3.06
latin_ratio = segment_servo_speed(tone(latin_native_s), SR, latin, SPEED)
check("纯拉丁慢段倍率超过旧上限 1.35", latin_ratio > 1.35, f"{latin_ratio:.3f}")
check("倍率仍在新上限内", latin_ratio <= TTS_RATE_SPEED_MAX, f"{latin_ratio:.3f} <= {TTS_RATE_SPEED_MAX}")
latin_out = time_stretch_wsola(tone(latin_native_s), latin_ratio)
latin_rate = latin_units / (latin_out.size / SR)
check("纯拉丁慢段收敛到 4.92 ±5%", abs(latin_rate - TARGET) / TARGET < 0.05, f"{latin_rate:.2f} 单元/秒")

print("\n=== 碎片重划：按等效发音单元借字符，不再留 7 单元短块 ===")
# 2026-11-07 最后一处真机漏洞：旧版把「单元缺口」直接当字符数往前借，
# 中英混排 1 字符只值 ~0.36 单元，借 2~3 字符补不上，碎片仍被单独合成。
prev = "balanced、full 四档之一，再透传给 openai-provider"
tiny_tail = "和 anthropic-provider。"
check("复现用短尾段确实 <10 单元", speech_units(tiny_tail) < 10, f"{speech_units(tiny_tail):.2f} units")
balanced = rebalance_tail(prev, tiny_tail, TTS_SPLIT_MIN_TAIL_UNITS, TTS_MAX_TEXT_CHARS)
check("重划后仍是 2 段", len(balanced) == 2, str([len(p) for p in balanced]))
check("拼接逐字可逆", "".join(balanced) == prev + tiny_tail)
check("两段都 >= 最短发音量", all(speech_units(p) >= TTS_SPLIT_MIN_TAIL_UNITS for p in balanced), str([round(speech_units(p), 2) for p in balanced]))
check("两段都不超 48 字", all(len(p) <= TTS_MAX_TEXT_CHARS for p in balanced))
check(
    "切分点不落在拉丁单词中间",
    _split_boundary_class("".join(balanced), len(balanced[0])) <= 1,
    f"前段结尾 …{balanced[0][-14:]}",
)
check("合并后不超上限时直接并成一段", rebalance_tail("短句。", "嗯。", 10, 48) == ["短句。嗯。"])

mixed_long = (
    "这次我把 session.ts 里的思考深度调度链路重新对了一遍，结论是这样的："
    "resolveThinkingDepth 每轮读四个信号，输出 off、light、balanced、full 四档之一，再透传给 "
    "openai-provider 和 anthropic-provider。实测 short turn 的 TTFT 从 321 毫秒降到 190 毫秒左右。"
)
mixed_parts = split_long_text(mixed_long)
check("中英混排分段逐字可逆", "".join(mixed_parts) == mixed_long.strip())
check("中英混排每段不超 48 字", all(len(p) <= TTS_MAX_TEXT_CHARS for p in mixed_parts))
check(
    "中英混排不产生 <10 单元碎片",
    all(speech_units(p) >= TTS_SPLIT_MIN_TAIL_UNITS for p in mixed_parts[1:]),
    str([round(speech_units(p), 2) for p in mixed_parts]),
)

print("\n=== 段内异常长静音压缩 ===")
voice = tone(1.0)
long_gap = np.zeros(int(1.4 * SR), dtype=np.float32)
with_gap = concat(voice, long_gap, voice)
compressed = compress_internal_gaps(with_gap, SR)
check("1.4s 异常空白压到 0.45s", abs(compressed.size / SR - 2.45) < 0.06, f"{compressed.size / SR:.3f}s")
normal_gap = concat(voice, np.zeros(int(0.5 * SR), dtype=np.float32), voice)
check("0.5s 自然句读原样保留", compress_internal_gaps(normal_gap, SR).size == normal_gap.size)
check("无长静音时逐样本不变", np.array_equal(compress_internal_gaps(voice, SR), voice))

print("\n=== 段间微停顿 ===")
check("停顿落在业界建议的 50~200ms", 0.05 <= TTS_SEGMENT_GAP_S <= 0.2, f"{TTS_SEGMENT_GAP_S*1000:.0f}ms")

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: {', '.join(FAILED)}")
    raise SystemExit(1)
print("ALL PASS")
