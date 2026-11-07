"""结构感知分块（P0）的离线单测：不依赖 MLX 模型 / sidecar。

锁住五件事：
1. `atomic-parity-fixtures.json` 的 Python 侧输出自洽（同一份 fixture 供 TS 单测比对，
   保证 `atomic.ts` 与 `atomic_chunks.py` 不会漂移）；
2. **开关关闭时与 `031f1cc2` 逐字一致**：`code:xl` 仍是 26 块 / 5 处切断原子；
3. 开关打开时离线切分质量达标：`code:xl` 23 块 / 0 处切断原子 / 最长 59 字 /
   逐字可逆 / 最短非首块 ≥10 单元；25 格矩阵全部逐字可逆；
4. 服务端 `split_long_text` 两态都守住 ≤48 字且逐字可逆（它是长度的最后一道保险）；
5. 原子判定的语义边界：URL 内冒号、未闭合结构、纯中文零原子。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import longtext_probe as lp  # noqa: E402
import mixed_matrix_probe as mmp  # noqa: E402
from atomic_chunks import atomic_spans, char_inside, flat  # noqa: E402
from mlx_voice_server import rebalance_tail, split_long_text, speech_units  # noqa: E402

FIXTURES = json.loads((HERE / "atomic-parity-fixtures.json").read_text(encoding="utf-8"))
LIMIT = FIXTURES["limit"]
MIN_UNITS = FIXTURES["minUnits"]
FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    suffix = f"  {detail}" if detail else ""
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{suffix}")
    if not ok:
        FAILED.append(label)


print("=== 1. 跨语言 parity fixture（Python 侧自洽）===")
for case in FIXTURES["cases"]:
    name = case["name"]
    text = case["text"]
    spans = [[s, e] for s, e in atomic_spans(text)]
    check(f"{name}: spans 与 fixture 一致", spans == case["spans"], f"{len(spans)} 个区间")
    check(f"{name}: splitOff 与 fixture 一致", lp.split_long(text, LIMIT) == case["splitOff"])
    check(f"{name}: splitOn 与 fixture 一致", lp.split_long_atomic(text, LIMIT) == case["splitOn"])
    check(f"{name}: splitOn 逐字可逆", "".join(case["splitOn"]) == text.strip())
for i, pair in enumerate(FIXTURES["rebalance"]):
    off = rebalance_tail(pair["prev"], pair["short"], MIN_UNITS, LIMIT)
    on = lp.rebalance_tail_safe(pair["prev"], pair["short"], MIN_UNITS, LIMIT)
    check(f"重划 #{i}: off 与 fixture 一致", off == pair["off"])
    check(f"重划 #{i}: on 与 fixture 一致", on == pair["on"])
    check(f"重划 #{i}: 两态逐字可逆", "".join(off) == "".join(on) == pair["prev"] + pair["short"])

print("\n=== 2. 关闭态 = 031f1cc2 历史基线 ===")
code_xl = mmp.matrix_text("code", "xl")
q_off = lp.split_quality(code_xl, lp.frontend_blocks(code_xl, atomic=False))
check("code:xl 关闭态 26 块", q_off["block_count"] == 26, str(q_off["block_count"]))
check("code:xl 关闭态 5 处切断原子", q_off["broken_atom_boundaries"] == 5, str(q_off["broken_atom_boundaries"]))
check("code:xl 关闭态最长 48 字", q_off["max_chars"] == 48)
check("code:xl 关闭态逐字可逆", q_off["reversible"])
plain_xl = mmp.matrix_text("plain", "xl")
check("plain:xl 关闭态 12 块", len(lp.frontend_blocks(plain_xl, atomic=False)) == 12)

print("\n=== 3. 开启态离线切分质量 ===")
q_on = lp.split_quality(code_xl, lp.frontend_blocks(code_xl, atomic=True))
check("code:xl 开启态 23 块", q_on["block_count"] == 23, str(q_on["block_count"]))
check("code:xl 开启态 0 处切断原子", q_on["broken_atom_boundaries"] == 0, str(q_on["broken_atom_boundaries"]))
check("code:xl 开启态最长 59 字", q_on["max_chars"] == 59, str(q_on["max_chars"]))
check("code:xl 开启态逐字可逆", q_on["reversible"])
check("code:xl 开启态最短非首块 ≥10 单元", q_on["min_nonfirst_units"] >= MIN_UNITS, str(q_on["min_nonfirst_units"]))
check("plain:xl 两态完全相同", lp.frontend_blocks(plain_xl, atomic=False) == lp.frontend_blocks(plain_xl, atomic=True))

all_reversible = True
all_broken = 0
all_short = []
for kind in mmp.DEFAULT_KINDS:
    for length in mmp.LENGTHS:
        text = mmp.matrix_text(kind, length)
        blocks = lp.frontend_blocks(text, atomic=True)
        q = lp.split_quality(text, blocks)
        all_reversible &= q["reversible"]
        all_broken += q["broken_atom_boundaries"]
        if len(blocks) > 1:
            all_short.append(q["min_nonfirst_units"])
check("25 格矩阵开启态全部逐字可逆", all_reversible)
check("25 格矩阵开启态切断原子总数 0", all_broken == 0, str(all_broken))
check("25 格矩阵多块格最短非首块均 ≥10 单元", all(v >= MIN_UNITS for v in all_short), f"最小 {min(all_short):.2f}")

print("\n=== 4. 服务端两态守住 ≤48 字 ===")
server_texts = [
    mmp.matrix_text(k, l) for k in mmp.DEFAULT_KINDS for l in mmp.LENGTHS
] + [case["text"] for case in FIXTURES["cases"]]
off_ok = on_ok = reversible_ok = True
for text in server_texts:
    off = split_long_text(text, atomic=False)
    on = split_long_text(text, atomic=True)
    off_ok &= off == split_long_text(text)
    off_ok &= all(len(p) <= LIMIT for p in off)
    on_ok &= all(len(p) <= LIMIT for p in on)
    reversible_ok &= "".join(off) == "".join(on) == text.strip()
check(f"关闭态 {len(server_texts)} 条：默认参数一致且每段 ≤{LIMIT} 字", off_ok)
check(f"开启态 {len(server_texts)} 条：每段 ≤{LIMIT} 字", on_ok)
check(f"两态 {len(server_texts)} 条：逐字可逆", reversible_ok)

print("\n=== 5. 原子判定语义边界 ===")
url = "见 https://127.0.0.1:8791/tts/stream 的说明，然后继续。"
spans = atomic_spans(url)
check("URL 被识别为原子", len(spans) == 1 and url[spans[0][0] : spans[0][1]].startswith("https://"))
check("URL 内冒号处于原子内部", char_inside(spans, url.index("://") + 1))
check("URL 后的中文逗号不在原子内部", not char_inside(spans, url.index("的说明") - 1))
unclosed = "配置是 {text: hello, engine: qwen3 还没写完"
u_spans = atomic_spans(unclosed)
check("未闭合结构保护到文本末尾", any(e == len(unclosed) for _, e in u_spans))
check("纯中文没有原子", atomic_spans("这是一段完全由汉字组成的普通中文句子。") == [])
check("flat 只去空白", flat(" a b\nc ") == "abc")
check("speech_units 与服务端同口径可用", speech_units("abc 123") > 0)

print()
if FAILED:
    print(f"FAILED {len(FAILED)}: {', '.join(FAILED)}")
    raise SystemExit(1)
print("ALL PASS")
