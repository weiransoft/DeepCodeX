#!/usr/bin/env python3
"""结构感知分块 A/B 探针（只读实验，不参与生产链路）。

目的：验证 TNS 验收报告里唯一未根治的 `code:xl` 43.71% 语速极差，能否靠
「前端不切断 JSON / URL / 拉丁词 / 数字串」修复，而不复制一份 TS 版 TNS 规则。

对照组 = 仓库现有 `longtext_probe.frontend_blocks()`（原文 48 字硬切）。
实验组 = 同一套封块/碎片规则，只在切点上加「原子 span 保护」：
  ① 断句符落在成对结构 / URL / 路径 / 拉丁词 / 数字串内部时不断句；
  ② 48 字硬切回扫时跳过落在原子内部的切点，必要时把整个原子挪到下一块；
  ③ 尾段碎片重划同样只在合法切点枚举。

复用 `mixed_matrix_probe.run_cell()` 的全部指标口径（同一阈值、同一语料、
同一个 sidecar），只 monkey-patch 切块函数，因此「块间语速极差」可以直接比。

用法：
  python3 scripts/voice/chunking_ab_probe.py --offline --cells code:xl,plain:xl
  python3 scripts/voice/chunking_ab_probe.py --cells code:xl,plain:xl \
      --modes baseline,atomic,atomic_firstshort --out /tmp/dcx-chunking-ab/run

本文件是**只读实验探针**：只 monkey-patch 内存里的切块函数并复用既有矩阵探针，
不改任何生产链路文件，也不写仓库内产物。生产落地前必须先按调研报告做前端 TS
改造并重建 bundle，再用 25 格矩阵全量复验。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/voice"))
import longtext_probe as lp  # noqa: E402
import mixed_matrix_probe as mmp  # noqa: E402
from mlx_voice_server import speech_units  # noqa: E402

BASELINE = lp.frontend_blocks

PAIRS = {"{": "}", "[": "]", "(": ")"}
# 只吃 ASCII URL 字符集：去空白后的离线复核里，若允许中文会一路吞到后面的正文，
# 把「URL 完整结束」误判成「切断原子」。
URL_RE = re.compile(r"(?i)(?:https?|ftp)://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")
PATH_RE = re.compile(r"(?<![\w:/])(?:~/|/)[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*")
LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.'’\-]*")
NUM_RE = re.compile(r"\d[\d.,:+\-/]*\d|\d")
PUNCT = "。！？!?；;，,、：:"


def flat(text: str) -> str:
    """与 mixed_matrix_probe.normalized() 同口径：只比非空白字符。"""
    return re.sub(r"\s+", "", text)


def atomic_spans(text: str) -> list[tuple[int, int]]:
    """不可切分的原子区间：成对结构 > URL > 路径 > 拉丁词 > 数字串。"""
    spans: list[tuple[int, int]] = []
    stack: list[tuple[str, int]] = []
    for i, ch in enumerate(text):
        if ch in PAIRS:
            stack.append((ch, i))
        elif ch in PAIRS.values() and stack and PAIRS[stack[-1][0]] == ch:
            _, start = stack.pop()
            spans.append((start, i + 1))
    while stack:  # 流式下结构可能尚未闭合：整段尾巴都保护起来
        _, start = stack.pop()
        spans.append((start, len(text)))
    for rx in (URL_RE, PATH_RE, LATIN_RE, NUM_RE):
        for m in rx.finditer(text):
            spans.append(m.span())
    spans.sort()
    merged: list[tuple[int, int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def char_inside(spans: list[tuple[int, int]], i: int) -> bool:
    """下标 i 的字符是否落在原子内部（用于禁止结构内的标点触发断句）。"""
    for start, end in spans:
        if start <= i < end:
            return True
        if start > i:
            break
    return False


def cut_ok(spans: list[tuple[int, int]], cut: int) -> bool:
    """切点 cut（slice 位置）是否合法：不能落在原子内部，落在边界可以。"""
    for start, end in spans:
        if start < cut < end:
            return False
        if start >= cut:
            break
    return True


def nearest_ok_cut(spans: list[tuple[int, int]], want: int, lo: int) -> int:
    """从 want 往前找不切开原子的合法切点；找不到返回 -1（由调用方降级）。"""
    for cut in range(want, lo - 1, -1):
        if cut_ok(spans, cut):
            return cut
    return -1


def atomic_take_sentences(text: str) -> list[str]:
    """复刻 sentence.ts / lp.take_sentences，额外保护结构内部标点。"""
    spans = atomic_spans(text)
    out: list[str] = []
    start = 0
    emitted = 0
    for i, ch in enumerate(text):
        if char_inside(spans, i):
            continue
        length = i - start + 1
        weak_min = lp.FIRST_WEAK_MIN if emitted == 0 else lp.WEAK_MIN
        is_strong = ch in lp.STRONG
        is_weak = (not is_strong) and ch in lp.WEAK and length >= weak_min
        is_newline = ch == "\n"
        is_overflow = length >= lp.MAX_SENTENCE
        if not (is_strong or is_weak or is_newline or is_overflow):
            continue
        cut = i + 1
        if not cut_ok(spans, cut):
            alt = nearest_ok_cut(spans, cut, start + 1)
            if alt < 0:
                continue
            cut = alt
        piece = text[start:cut].strip()
        if piece:
            out.append(piece)
            emitted += 1
        start = cut
    if start < len(text):
        piece = text[start:].strip()
        if piece:
            out.append(piece)
    return out


def rebalance_tail_safe(prev: str, short: str, min_units: float, limit: int) -> list[str]:
    """与 lp.rebalance_tail 同语义，枚举切点时排除原子内部。"""
    merged = prev + short
    if len(merged) <= limit or not prev:
        return [merged]
    spans = atomic_spans(merged)
    lo = max(1, len(merged) - limit)
    hi = min(limit, len(merged) - 1)
    if lo > hi:
        # 两侧都装不下：整段交给服务端（它先 TNS 再按 48 字切，结构不会碎）。
        return [merged] if len(merged) <= 2 * limit else [merged[:limit], merged[limit:]]
    cuts = [c for c in range(lo, hi + 1) if cut_ok(spans, c)]
    min_side = lambda c: min(speech_units(merged[:c]), speech_units(merged[c:]))
    if not cuts or not any(min_side(c) >= min_units for c in cuts):
        # 没有「两段都够长」的合法切点：宁可让这一块超过 48 字，也不切开原子
        # 或留下 <10 单元的碎片。服务端会在规范化后安全切分。
        return [merged] if len(merged) <= 2 * limit else lp.rebalance_tail(prev, short, min_units, limit)
    def prefer(a: int, b: int) -> int:
        pa = 0 if merged[a - 1] in PUNCT else 1
        pb = 0 if merged[b - 1] in PUNCT else 1
        return pa - pb or abs(a - len(prev)) - abs(b - len(prev))
    valid = [c for c in cuts if min_side(c) >= min_units]
    if valid:
        best = valid[0]
        for c in valid[1:]:
            if prefer(c, best) < 0:
                best = c
    else:
        best = cuts[0]
        for c in cuts[1:]:
            delta = min_side(c) - min_side(best)
            if delta > 1e-9 or (abs(delta) <= 1e-9 and prefer(c, best) < 0):
                best = c
    return [merged[:best], merged[best:]]


def atomic_split_long(text: str, limit: int = lp.MAX_BLOCK_CHARS) -> list[str]:
    """复刻 lp.split_long，48 字硬切回扫时不切开原子。"""
    rest = text.strip()
    if not rest:
        return []
    if len(rest) <= limit:
        return [rest]
    out: list[str] = []
    minimum = max(1, int(limit * 0.6))
    while len(rest) > limit:
        spans = atomic_spans(rest)
        cut = -1
        for i in range(limit, minimum - 1, -1):
            if rest[i - 1] in PUNCT and cut_ok(spans, i):
                cut = i
                break
        if cut < 0:
            cut = nearest_ok_cut(spans, limit, minimum)
        if cut < 0:
            # 原子横跨上限且回扫区间内没有合法切点：把切点后移到原子尾，
            # 允许这一块 >48 字。服务端会对整块先 TNS 再按 48 字切分，
            # 那时结构已还原成中文，不会再切坏 JSON / URL / 拉丁词。
            for start, end in spans:
                if start < limit < end:
                    cut = end if end <= 2 * limit else limit
                    break
        if cut < 0 or cut <= 0:  # 单个原子比 96 字还长：诚实降级
            cut = limit
        out.append(rest[:cut])
        rest = rest[cut:]
    if rest and out and speech_units(rest) < lp.MIN_BLOCK_UNITS:
        balanced = rebalance_tail_safe(out[-1], rest, lp.MIN_BLOCK_UNITS, limit)
        out[-1] = balanced[0]
        rest = balanced[1] if len(balanced) > 1 else ""
    if rest:
        out.append(rest)
    return out


def balance_blocks_safe(blocks: list[str]) -> list[str]:
    out = list(blocks)
    for _ in range(len(out) + 2):
        idx = next((i for i in range(1, len(out)) if speech_units(out[i]) < lp.MIN_BLOCK_UNITS), -1)
        if idx < 0:
            break
        balanced = rebalance_tail_safe(out[idx - 1], out[idx], lp.MIN_BLOCK_UNITS, lp.MAX_BLOCK_CHARS)
        out[idx - 1 : idx + 1] = balanced
    return out


def atomic_frontend_blocks(text: str, first_short: bool = False) -> list[str]:
    """复刻 SpeechQueue 封块规则，全部切点带原子保护。"""
    blocks: list[str] = []
    sealed = 0

    def emit(chunk: str) -> None:
        nonlocal sealed
        parts = atomic_split_long(chunk)
        # 无标点长串的首块快路径：把首块再压到 ≤20 字，验证 TTFA 能不能降。
        if first_short and sealed == 0 and parts and len(parts[0]) > 20:
            head = parts[0]
            spans = atomic_spans(head)
            cut = nearest_ok_cut(spans, 20, 10)
            if cut > 0:
                parts = [head[:cut]] + atomic_split_long(head[cut:]) + parts[1:]
        for part in parts:
            if speech_units(part) < lp.MIN_BLOCK_UNITS and blocks:
                balanced = rebalance_tail_safe(blocks[-1], part, lp.MIN_BLOCK_UNITS, lp.MAX_BLOCK_CHARS)
                blocks[-1] = balanced[0]
                part = balanced[1] if len(balanced) > 1 else ""
                if not part:
                    continue
            blocks.append(part)
            sealed += 1

    buf = ""
    for sentence in atomic_take_sentences(text):
        buf += sentence
        target = lp.FIRST_BLOCK_CHARS if sealed == 0 else lp.BLOCK_CHARS
        if len(buf) < target and len(buf) < lp.MAX_BLOCK_CHARS:
            continue
        if sealed > 0 and speech_units(buf) < lp.MIN_BLOCK_UNITS:
            continue
        emit(buf)
        buf = ""
    if buf.strip():
        emit(buf)
    return balance_blocks_safe(blocks)


# ---------------------------------------------------------------------------
# 离线切分质量
# ---------------------------------------------------------------------------
def split_quality(text: str, blocks: list[str]) -> dict:
    src = flat(text)
    spans = atomic_spans(src)
    joined = "".join(flat(b) for b in blocks)
    offset = 0
    broken = []
    for i, block in enumerate(blocks[:-1]):
        offset += len(flat(block))
        if not cut_ok(spans, offset):
            broken.append({"boundary": i + 1, "offset": offset,
                           "context": src[max(0, offset - 14) : offset + 14]})
    return {
        "block_count": len(blocks),
        "reversible": joined == src,
        "broken_atom_boundaries": len(broken),
        "broken_examples": broken[:6],
        "max_chars": max((len(b) for b in blocks), default=0),
        "min_nonfirst_units": round(min((speech_units(b) for b in blocks[1:]), default=0.0), 2),
        "blocks": [b[:60] for b in blocks],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cells", default="code:xl,plain:xl")
    ap.add_argument("--modes", default="baseline,atomic")
    ap.add_argument("--offline", action="store_true", help="只做离线切分对比，不请求 sidecar")
    ap.add_argument("--out", default="/tmp/dcx-chunking-ab/run")
    args = ap.parse_args()
    cells = [c.strip() for c in args.cells.split(",") if c.strip()]
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    offline = {}
    for cell in cells:
        text = mmp.matrix_text(*cell.split(":"))
        variants = {"baseline": BASELINE(text)}
        if "atomic" in modes or "atomic_firstshort" in modes:
            variants["atomic"] = atomic_frontend_blocks(text)
        if "atomic_firstshort" in modes:
            variants["atomic_firstshort"] = atomic_frontend_blocks(text, first_short=True)
        offline[cell] = {name: split_quality(text, blocks) for name, blocks in variants.items()}
        (out / "split-quality.json").write_text(json.dumps(offline, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n=== {cell} 离线切分 ===")
        for name, q in offline[cell].items():
            print(f"  {name:20s} 块={q['block_count']:3d} 可逆={q['reversible']} "
                  f"切断原子={q['broken_atom_boundaries']:2d} 最长={q['max_chars']:3d}字 "
                  f"最短非首块={q['min_nonfirst_units']:.1f}单元")
            for ex in q["broken_examples"][:3]:
                print(f"      ✗ #{ex['boundary']} …{ex['context']}…")

    if args.offline:
        return 0

    summary = {}
    for cell in cells:
        for mode in modes:
            if mode == "baseline":
                lp.frontend_blocks = BASELINE
            elif mode == "atomic":
                lp.frontend_blocks = atomic_frontend_blocks
            elif mode == "atomic_firstshort":
                lp.frontend_blocks = lambda t: atomic_frontend_blocks(t, first_short=True)
            else:
                raise SystemExit(f"unknown mode: {mode}")
            t0 = time.time()
            result = mmp.run_cell(*cell.split(":"), False)
            key = f"{cell}-{mode}"
            (out / f"{key}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            summary[key] = {
                "block_count": result["block_count"],
                "collection_ok": result["collection_ok"],
                "reversible": result["reversible"],
                "rate_median": result["rate"]["median_units_s"],
                "rate_bias_pct": result["rate"]["bias_pct"],
                "rate_spread_pct": result["rate"]["block_spread_pct"],
                "f0_spread_pct": result["timbre"]["block_f0_spread_pct"],
                "first_block_ttfa_ms": result["speed"]["first_block_ttfa_ms"],
                "ttfa_p95_ms": result["speed"]["ttfa_p95_ms"],
                "max_internal_gap_ms": result["fluency"]["max_internal_gap_ms"],
                "inter_block_silence_max_ms": result["fluency"]["inter_block_silence_max_ms"],
                "min_nonfirst_units": result["fluency"]["min_nonfirst_units"],
                "rtf": result["speed"]["rtf"],
                "audio_duration_s": result["speed"]["audio_duration_s"],
                "elapsed_s": round(time.time() - t0, 1),
            }
            (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"\n>>> {key}: 块间语速极差 {summary[key]['rate_spread_pct']:.2f}% "
                  f"TTFA首块 {summary[key]['first_block_ttfa_ms']:.0f}ms "
                  f"P95 {summary[key]['ttfa_p95_ms']:.0f}ms "
                  f"最长静音 {summary[key]['max_internal_gap_ms']:.0f}ms "
                  f"采集OK={summary[key]['collection_ok']} 可逆={summary[key]['reversible']}", flush=True)
    print("\n=== 汇总 ===")
    for key, s in summary.items():
        print(f"  {key:32s} 块={s['block_count']:3d} 语速极差={s['rate_spread_pct']:6.2f}% "
              f"F0极差={s['f0_spread_pct']:6.2f}% 首块TTFA={s['first_block_ttfa_ms']:6.0f}ms "
              f"静音={s['max_internal_gap_ms']:5.0f}ms 音频={s['audio_duration_s']:6.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
