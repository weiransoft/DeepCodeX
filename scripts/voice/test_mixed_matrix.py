"""混合内容×长度矩阵探针的离线单测（不依赖 MLX 模型 / sidecar）。

锁住四件事：
1. 语料矩阵确实是「同类型句子池按长度拼前缀」，且极短档不切断拉丁词；
2. 25 格走真实前端分块后逐字可逆、不超 48 字、没有 <10 单元的非首块碎片；
3. 单块样本的 `spread()=0` **不能**伪装成通过——门禁必须走 N/A 替代判据；
4. 汇总 / 阈值 / 边界跳变 / 偏差口径的纯函数行为。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mixed_matrix_probe as m  # noqa: E402
from mlx_voice_server import speech_units  # noqa: E402

FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    suffix = f"  {detail}" if detail else ""
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{suffix}")
    if not ok:
        FAILED.append(label)


def fake_cell(
    name: str = "cn:m",
    *,
    blocks: int = 3,
    rate_spread: float = 1.0,
    rate_bias: float = 1.0,
    f0_spread: float = 1.0,
    median_f0: float = 220.0,
    collection_ok: bool = True,
    reversible: bool = True,
    target: float = 4.92,
    ttfa: float = 200.0,
    rtf: float = 0.3,
) -> dict:
    """构造一个形状完整、不连真机的假采集结果。"""
    n = max(1, blocks)
    per_block = [
        {
            "index": i,
            "chars": 40,
            "units": 20.0,
            "text": f"块{i}",
            "http": 200 if collection_ok else 401,
            "chunk_count": 2 if collection_ok else 0,
            "ttfa_ms": ttfa,
            "total_ms": 1500.0,
            "first_chunk_audio_s": 0.8,
            "duration_s": 4.0,
            "rate_units": 4.92,
            "rate_cps": 4.92,
            "f0_hz": median_f0,
            "centroid_hz": 1800.0,
            "rms": 0.05,
            "max_gap_ms": 200.0,
            "long_gaps": 0,
            "speech_s": 3.5,
            "gap_ms": 0.0,
            "sentence_gap_ms": 0.0 if i == 0 else 40.0,
        }
        for i in range(n)
    ]
    rates = [b["rate_units"] for b in per_block]
    f0s = [b["f0_hz"] for b in per_block]
    return {
        "name": name,
        "kind": name.split(":")[0],
        "kind_label": "纯中文",
        "length": name.split(":")[1],
        "length_label": "中",
        "chars": 40 * n,
        "units": 20.0 * n,
        "blocks": per_block,
        "block_count": n,
        "reversible": reversible,
        "collection_ok": collection_ok,
        "speed": {
            "first_block_ttfa_ms": ttfa,
            "first_block_audio_s": 4.0,
            "first_chunk_audio_s": 0.8,
            "ttfa_p95_ms": ttfa,
            "synth_total_ms": 1500.0 * n,
            "audio_duration_s": 4.0 * n,
            "rtf": rtf,
            "underrun_count": 0,
            "underrun_worst_s": 0.0,
        },
        "rate": {
            "target_units_s": target,
            "median_units_s": 4.92,
            "bias_pct": rate_bias,
            "block_spread_pct": rate_spread,
            "applicable": len(rates) >= 3,
        },
        "timbre": {
            "median_f0_hz": median_f0,
            "block_f0_spread_pct": f0_spread,
            "block_centroid_spread_pct": 1.0,
            "window_f0_spread_pct": 1.0,
            "window_centroid_spread_pct": 1.0,
            "f0_applicable": len(f0s) >= 3,
        },
        "fluency": {
            "max_internal_gap_ms": 200.0,
            "long_gaps_total": 0,
            "boundary_jump_max": 1.0,
            "boundary_jump_median": 0.8,
            "boundary_jump_note": "参考",
            "inter_block_silence_max_ms": 140.0,
            "inter_block_silence_median_ms": 137.0,
            "min_nonfirst_units": 20.0 if n > 1 else 0.0,
            "block_count_applicable": n >= 2,
        },
        "half_drift": None,
        "single_request": None,
    }


TH = m.load_thresholds(m.THRESHOLDS_PATH)

print("\n=== 语料矩阵：控制变量 ===")
for kind in m.DEFAULT_KINDS:
    sizes = [len(m.matrix_text(kind, length)) for length in m.LENGTHS]
    check(f"{kind} 长度单调递增", all(a < b for a, b in zip(sizes, sizes[1:])), str(sizes))
    prefix = m.matrix_text(kind, "s")
    check(f"{kind} s→m 是同题材前缀", m.matrix_text(kind, "m").startswith(prefix))
    check(f"{kind} xl 是 s 池两轮", m.matrix_text(kind, "xl") == "".join(m.SENTENCE_POOLS[kind]) * 2)

xs_all = " ".join(m.XS_TEXTS.values())
check("极短档不把 session.ts 切断", "session.ts" in xs_all)
check("极短档不把 URL 切断", "/api/voice/health" in xs_all)
check("极短档含数字与无标点两类", "192" in xs_all and "，" not in m.XS_TEXTS["plain"])
check("默认矩阵共 25 格", len(m.DEFAULT_KINDS) * len(m.LENGTHS) == 25)
check("口语化 A/B 语料与代码池逐句对应", len(m.SENTENCE_POOLS["spoken"]) == len(m.SENTENCE_POOLS["code"]))
check("A/B 语料默认不进门禁", "spoken" in m.KINDS and "spoken" not in m.DEFAULT_KINDS)
check("A/B 语料不含 URL/花括号", not any(c in "".join(m.SENTENCE_POOLS["spoken"]) for c in "{}://"))

print("\n=== 25 格前端分块护栏 ===")
for length in m.LENGTHS:
    for kind in m.DEFAULT_KINDS:
        text = m.matrix_text(kind, length)
        blocks = m.lp.frontend_blocks(text)
        label = f"{kind}:{length}"
        check(
            f"{label} 逐字可逆",
            m.normalized("".join(blocks)) == m.normalized(text),
            f"{len(blocks)} 块",
        )
        check(f"{label} 无超 48 字块", all(len(b) <= 48 for b in blocks))
        check(
            f"{label} 无 <10 单元非首块",
            all(speech_units(b) >= 10 for b in blocks[1:]),
            f"最短 {min((round(speech_units(b), 1) for b in blocks[1:]), default=0)}",
        )

print("\n=== 纯函数口径 ===")
check("流式主链路块间 gap=0（continuous 硬拼接）", m.STREAM_GAP_MS == 0.0)
check("整句兜底首块 gap 为 0", m.sentence_gap_ms_for("你好。", 0) == 0.0)
check("整句兜底句末 80ms", m.sentence_gap_ms_for("你好。", 1) == 80.0)
check("整句兜底逗号 20ms", m.sentence_gap_ms_for("你好，", 1) == 20.0)
check("整句兜底其余 40ms", m.sentence_gap_ms_for("你好", 1) == 40.0)
check("bias 相等为 0", m.pct_bias(4.92, 4.92) == 0.0)
check("bias 偏离 10%", m.pct_bias(5.412, 4.92) == 10.0)
check("bias 零值不伪装通过", m.pct_bias(0.0, 4.92) > 100)
check("normalized 忽略空格不丢字", m.normalized("a b\tc") == "abc")

sr = 24000
t = np.arange(sr, dtype=np.float32) / sr
voice = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
joined = np.concatenate([voice, voice])
worst, median = m.local_boundary_jumps(joined, [sr], sr)
check("连续正弦边界跳变有限且非负", np.isfinite(worst) and worst >= 0 and median >= 0, f"worst={worst}")
check("无边界时返回 0", m.local_boundary_jumps(joined, [], sr) == (0.0, 0.0))

clip = np.concatenate([
    np.zeros(int(0.09 * sr), dtype=np.float32),
    voice[:sr],
    np.zeros(int(0.05 * sr), dtype=np.float32),
])
head_ms, tail_ms = m.edge_silence_ms(clip, sr)
check("首部机械静音可测", 85 <= head_ms <= 95, f"{head_ms:.0f}ms")
check("尾部机械静音可测", 45 <= tail_ms <= 55, f"{tail_ms:.0f}ms")
check("全静音返回整段时长", m.edge_silence_ms(np.zeros(sr, dtype=np.float32), sr) == (1000.0, 1000.0))

print("\n=== 门禁：单块 N/A 不伪通过 ===")
single = fake_cell("cn:xs", blocks=1, rate_bias=TH["single_block_rate_bias_pct"] + 5)
summary = m.summarize([single], [{"name": "cn:s", "rounds": 3, "identical": True, "f0_spread_pct": 0.0, "duration_spread_pct": 0.0, "http_ok": True, "hashes": ["a"] * 3}])
violations = m.evaluate([single], summary, TH)
check("单块 rate.applicable=False", single["rate"]["applicable"] is False)
check(
    "单块偏差超标必须报 N/A 替代违规",
    any(v["metric"].startswith("单元语速偏差%(块数不足") for v in violations),
    f"违规 {len(violations)} 项",
)
check("单块不误报块间极差", not any(v["metric"] == "块间单元语速极差%" for v in violations))

single_ok = fake_cell("cn:xs", blocks=1, rate_bias=1.0)
v_ok = m.evaluate([single_ok], m.summarize([single_ok], [{"name": "cn:s", "rounds": 3, "identical": True, "f0_spread_pct": 0.0, "duration_spread_pct": 0.0, "http_ok": True, "hashes": ["a"] * 3}]), TH)
check("单块偏差达标无 N/A 违规", not any("N/A替代" in v["metric"] for v in v_ok))

multi = fake_cell("cn:m", blocks=3, rate_spread=TH["rate_units_spread_pct"] + 5)
v_multi = m.evaluate([multi], m.summarize([multi], [{"name": "cn:s", "rounds": 3, "identical": True, "f0_spread_pct": 0.0, "duration_spread_pct": 0.0, "http_ok": True, "hashes": ["a"] * 3}]), TH)
check("多块语速极差超标报违规", any(v["metric"] == "块间单元语速极差%" for v in v_multi))
check("采集失败必报违规", any(v["metric"] == "块采集完整" for v in m.evaluate([fake_cell(collection_ok=False)], m.summarize([fake_cell()], []), TH)))
check("逐字不可逆必报违规", any(v["metric"] == "逐字可逆" for v in m.evaluate([fake_cell(reversible=False)], m.summarize([fake_cell()], []), TH)))
check("基准口径被改必报违规", any(v["metric"] == "语速基准口径" for v in m.evaluate([fake_cell(target=6.0)], m.summarize([fake_cell()], []), TH)))
check("重复不一致必报违规", any(v["metric"] == "重复逐位一致" for v in m.evaluate([fake_cell()], m.summarize([fake_cell()], [{"name": "cn:s", "rounds": 3, "identical": False, "f0_spread_pct": 0.0, "duration_spread_pct": 0.0, "http_ok": True, "hashes": ["a", "b", "c"]}]), TH)))
loud_gap = fake_cell()
loud_gap["fluency"]["inter_block_silence_max_ms"] = TH["max_inter_block_silence_ms"] + 50
check("块间静音超标必报违规", any(v["metric"] == "块间机械静音ms" for v in m.evaluate([loud_gap], m.summarize([loud_gap], []), TH)))

print("\n=== 汇总与阈值 ===")
cells = [fake_cell(f"{kind}:{length}", blocks=3, median_f0=200 + i) for i, (kind, length) in enumerate([(k, l) for l in m.LENGTHS for k in m.DEFAULT_KINDS])]
s = m.summarize(cells, [])
check("汇总 25 格", s["cells"] == 25 and s["cells_ok"] == 25)
check("按长度分 5 组", len(s["by_length"]) == 5 and all(v["cells"] == 5 for v in s["by_length"].values()))
check("按内容分 5 组", len(s["by_kind"]) == 5 and all(v["cells"] == 5 for v in s["by_kind"].values()))
check("总块数正确", s["total_blocks"] == 75)
raw = json.loads(m.THRESHOLDS_PATH.read_text(encoding="utf-8"))
needed = {
    "global_rate_units_s", "rate_units_spread_pct", "rate_bias_pct", "single_block_rate_bias_pct",
    "block_f0_spread_pct", "single_block_f0_bias_pct", "max_internal_gap_ms", "long_gaps_total",
    "min_nonfirst_units", "max_inter_block_silence_ms", "ttfa_max_ms", "ttfa_p95_ms", "rtf_max",
    "cross_cell_rate_spread_pct", "cross_cell_f0_spread_pct", "length_group_rate_spread_pct",
    "length_group_f0_spread_pct", "kind_group_rate_spread_pct", "kind_group_f0_spread_pct",
    "repeat_f0_spread_pct",
}
check("阈值键齐全", needed.issubset(raw.keys()), f"缺 {needed - set(raw.keys())}")
check("阈值口径 = 4.1×1.2", abs(raw["global_rate_units_s"] - 4.1 * 1.2) < 1e-9)
check("N/A 替代阈值不宽于 100%", raw["single_block_rate_bias_pct"] < 100)

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: {', '.join(FAILED)}")
    raise SystemExit(1)
print("ALL PASS")
