#!/usr/bin/env python3
"""结构感知分块：不可切分的「原子区间」与合法切点判定。

只做**切分边界保护**，不做文本规范化（TNS 仍是服务端单点规则，
见 ``text_normalize.py``）。这是 2026-11-07 调研报告 P0 的落地实现：
前端把 ``{...}`` / URL / 拉丁词 / 数字串切碎后，服务端 TNS 只能看到
半截 JSON，无法还原结构，于是 ``code:xl`` 出现 43.71% 的块间语速极差。
本模块给出「哪些位置不能下刀」，由调用方决定切分策略。

与前端 ``packages/web/web/src/voice/atomic.ts`` 是同一套规则，
跨语言一致性由 ``atomic-parity-fixtures.json`` + 两侧单测保证。

规则（按优先级）：
  1. 成对 ``{} [] ()``，含嵌套；流式下未闭合的结构保护到文本末尾；
  2. ASCII URL（只吃 ASCII 字符集，避免一路吞掉后面中文正文）；
  3. POSIX 路径 / ``~/`` 路径；
  4. 拉丁词（含连字符、点号、下划线复合词）；
  5. 数字串（含 ``. , : + - /`` 分隔）。

全部区间做闭开合并，``cut_ok(spans, cut)`` 只允许切点落在原子边界或外部。
"""
from __future__ import annotations

import re

Span = tuple[int, int]

PAIRS = {"{": "}", "[": "]", "(": ")"}
# URL 只吃 ASCII：允许中文会一路吞到后面的正文，把「URL 完整结束」误判成切断原子。
URL_RE = re.compile(
    r"(?i)(?:https?|ftp)://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+"
)
PATH_RE = re.compile(r"(?<![\w:/])(?:~/|/)[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*")
LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.'’\-]*")
# 数字串只认 ASCII 数字：与 TS 侧 [0-9] 严格对齐（speech_units 的 Nd 口径另算）。
NUM_RE = re.compile(r"[0-9][0-9.,:+\-/]*[0-9]|[0-9]")


def flat(text: str) -> str:
    """与矩阵探针同口径：只比非空白字符（切分可逆性检查用）。"""
    return re.sub(r"\s+", "", text)


def atomic_spans(text: str) -> list[Span]:
    """返回不可切分的原子区间（已排序、已合并、互不重叠）。"""
    spans: list[Span] = []
    stack: list[tuple[str, int]] = []
    for i, ch in enumerate(text):
        if ch in PAIRS:
            stack.append((ch, i))
        elif ch in PAIRS.values() and stack and PAIRS[stack[-1][0]] == ch:
            _, start = stack.pop()
            spans.append((start, i + 1))
    # 流式下结构可能尚未闭合：整段尾巴都保护起来（下次重扫会重新识别）。
    while stack:
        _, start = stack.pop()
        spans.append((start, len(text)))
    for rx in (URL_RE, PATH_RE, LATIN_RE, NUM_RE):
        spans.extend(m.span() for m in rx.finditer(text))
    spans.sort()
    merged: list[Span] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def char_inside(spans: list[Span], i: int) -> bool:
    """下标 i 的字符是否落在原子内部（禁止结构内标点触发断句）。"""
    for start, end in spans:
        if start <= i < end:
            return True
        if start > i:
            break
    return False


def cut_ok(spans: list[Span], cut: int) -> bool:
    """切点 cut（slice 位置）是否合法：不能落在原子内部，落在边界可以。"""
    for start, end in spans:
        if start < cut < end:
            return False
        if start >= cut:
            break
    return True


def nearest_ok_cut(spans: list[Span], want: int, lo: int) -> int:
    """从 want 往前找合法切点；找不到返回 -1（调用方决定如何诚实降级）。"""
    for cut in range(want, lo - 1, -1):
        if cut_ok(spans, cut):
            return cut
    return -1


def atom_end_after(spans: list[Span], cut: int, max_len: int) -> int:
    """横跨 cut 的原子的尾部；超过 max_len 返回 -1（调用方降级硬切）。"""
    for start, end in spans:
        if start < cut < end:
            return end if end <= max_len else -1
        if start >= cut:
            break
    return -1
