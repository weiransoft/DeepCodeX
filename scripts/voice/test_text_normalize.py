#!/usr/bin/env python3
"""TNS 规则离线单测：纯标准库，不依赖 MLX / sidecar。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_normalize import (  # noqa: E402
    TNS_ENV,
    TNS_VERSION,
    decimal_cn,
    digits_cn,
    integer_cn,
    normalize_for_speech,
    request_tns_enabled,
    tns_enabled_by_env,
)

FIXTURES = json.loads((Path(__file__).with_name("tns-fixtures.json")).read_text(encoding="utf-8"))
_passed = 0


def check(label: str, condition: bool) -> None:
    global _passed
    if not condition:
        print(f"FAIL: {label}")
        raise SystemExit(1)
    _passed += 1


print("=== golden fixtures：15 个场景的规则输出 / 命中 / 幂等 ===")
assert FIXTURES["version"] == TNS_VERSION, "fixtures 与规则版本不一致"
for scene in FIXTURES["scenes"]:
    name = scene["name"]
    n = normalize_for_speech(scene["text"])
    check(f"{name} 输出与 golden 一致（实际 {n.text!r}）", n.text == scene["expected"])
    check(f"{name} changed 标记正确", n.changed == (scene["expected"] != scene["text"]))
    check(f"{name} 幂等", normalize_for_speech(n.text).text == n.text)
    for rule in scene["rules"]:
        check(f"{name} 命中规则 {rule}", rule in n.hits)
    if not scene["rules"]:
        check(f"{name} 对照组零命中", n.hits == {})
    check(f"{name} 原文未被就地改写", n.original == scene["text"])

print("\n=== 中文数字读法 ===")
check("逐位：127", digits_cn("127") == "一二七")
check("逐位：8791", digits_cn("8791") == "八七九一")
check("整数：0", integer_cn(0) == "零")
check("整数：10", integer_cn(10) == "十")
check("整数：11", integer_cn(11) == "十一")
check("整数：192", integer_cn(192) == "一百九十二")
check("整数：1001", integer_cn(1001) == "一千零一")
check("整数：10001", integer_cn(10001) == "一万零一")
check("整数：1821", integer_cn(1821) == "一千八百二十一")
check("整数：3000", integer_cn(3000) == "三千")
check("整数：负数", integer_cn(-25) == "负二十五")
check("整数：超大数逐位降级", integer_cn(10**13) == digits_cn(str(10**13)))
check("小数：18.6", decimal_cn("18.6") == "十八点六")
check("小数：0.79", decimal_cn("0.79") == "零点七九")
check("小数：千分位", decimal_cn("12,480.75") == "一万二千四百八十点七五")

print("\n=== 确定性 / 诚实降级 / 不误伤 ===")
check("空文本", normalize_for_speech("").text == "")
check("纯标点", normalize_for_speech("，。！？").text == "，。！？")
check("关闭开关逐字返回", normalize_for_speech(scene["text"], False).text == scene["text"])
check("关闭开关无命中", normalize_for_speech("POST https://a.com/x", False).hits == {})
check("未知结构不编造", "看不懂" not in normalize_for_speech("abc ??? xyz").text)
check("连字符复合词不展开", "X-Tts-Voice" in normalize_for_speech("X-Tts-Voice 里的 tts-stream").text)
check("金额小数不被误改", "12,480.75 元" in normalize_for_speech("预算 12,480.75 元").text)
check("普通英文 get 不被翻译", "get" in normalize_for_speech("你 get 到了吗").text)
check(
    "危险符号清理",
    all(
        token not in normalize_for_speech(FIXTURES["scenes"][0]["text"] + " {a: true} #1 && @x").text
        for token in ("://", "{", "}", "#", "&&", "@")
    ),
)

print("\n=== 开关：环境变量与请求级覆盖 ===")
old = os.environ.get(TNS_ENV)
try:
    os.environ.pop(TNS_ENV, None)
    check("默认打开", tns_enabled_by_env() is True)
    os.environ[TNS_ENV] = "0"
    check("环境变量一键回退", tns_enabled_by_env() is False)
    check("请求级可覆盖默认关闭", request_tns_enabled({"tns": True}, False) is True)
finally:
    if old is None:
        os.environ.pop(TNS_ENV, None)
    else:
        os.environ[TNS_ENV] = old
check("无参数沿用默认", request_tns_enabled({}, True) is True)
check("请求级关闭", request_tns_enabled({"tns": False}, True) is False)
check("字符串 off", request_tns_enabled({"tns": "off"}, True) is False)
check("字符串 1", request_tns_enabled({"tns": "1"}, False) is True)

print("\n=== 规则覆盖率：每条规则至少被一个场景命中 ===")
covered: set[str] = set()
for scene in FIXTURES["scenes"]:
    covered |= set(normalize_for_speech(scene["text"]).hits)
expected_rules = {
    "url", "json", "path", "unit", "percent", "date", "version", "phone",
    "issue", "slash_ab", "abbrev_upper", "abbrev", "cli_flag", "upper_snake",
    "brackets", "assign", "and", "at",
}
check(f"未覆盖规则：{sorted(expected_rules - covered)}", expected_rules <= covered)

print(f"\nALL PASS ({_passed} checks, {len(FIXTURES['scenes'])} scenes, {TNS_VERSION})")
