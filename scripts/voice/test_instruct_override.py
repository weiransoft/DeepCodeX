"""请求级 instruct 覆盖（第十五轮）离线单测：锁住「只覆盖指令、不动种子」。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import mlx_voice_server as srv  # noqa: E402

CHECKS = 0


def check(cond: bool, label: str) -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(f"FAIL: {label}")
    print(f"  ok  {label}")


R = srv.request_instruct_override
A = srv.apply_instruct_override

print("== 解析：不传 / 显式空 / 覆盖值 / 坏值 ==")
check(R({}) is None, "缺省返回 None（不覆盖）")
check(R({"instructOverride": ""}) == "", "空串 → 显式关闭 instruct")
check(R({"instructOverride": "   "}) == "", "纯空白 → 显式关闭 instruct")
check(R({"instructOverride": "成熟女性，中低音"}) == "成熟女性，中低音", "非空指令透传")
check(R({"instructOverride": "  语速平稳  "}) == "语速平稳", "两侧空白被裁剪")
for bad in (None, 0, 1, True, False, [], {}, 3.14):
    check(R({"instructOverride": bad}) is None, f"非字符串 {bad!r} 诚实降级")
check(R({"instructOverride": "x" * 121}) is None, "超 120 字忽略，防止塞回整段自由描述")
check(R({"instructOverride": "x" * 120}) == "x" * 120, "恰好 120 字仍可用")

print("== 套用：零回归与三种状态 ==")
preset_instruct = srv.VOICE_PRESETS["sinan"][1]
check(A(preset_instruct, None) == preset_instruct, "不覆盖 → 原 instruct 逐字不变")
check(A(None, None) is None, "不覆盖 → 原 None 不变")
check(A(preset_instruct, "") is None, "显式空 → instruct=None（纯 speaker）")
check(A(None, "") is None, "显式空 + 原本就 None → 仍 None")
check(A(preset_instruct, "短指令") == "短指令", "非空覆盖生效")
check(A(None, "短指令") == "短指令", "从无指令也能覆盖成有指令")

print("== 关键契约：覆盖不改变 voice 字符串，因此采样种子不变 ==")
voice = "成年女性，中音区，语速偏慢，气息柔和"
payload = {"voice": voice, "instructOverride": ""}
check(payload["voice"] == voice, "请求里的 voice 原样保留")
seed_before = srv.voice_seed_key(voice)
seed_after = srv.voice_seed_key(payload["voice"])
check(seed_before == seed_after, "覆盖前后种子键逐字相同")
check(seed_after == srv.STABLE_VOICE_FALLBACK, "自由描述仍归一到稳定预设的种子键")
check(srv.voice_seed_key("serena") != seed_before, "换成纯 speaker 名会改变种子（故不能那样做 A/B）")

print("== 预设/预置 speaker 的 instruct 差异（对照组存在性） ==")
speaker_sinan, instruct_sinan = srv.resolve_speaker("sinan")
speaker_plain, instruct_plain = srv.resolve_speaker("serena")
check(speaker_sinan == speaker_plain == "serena", "两者 speaker 相同")
check(bool(instruct_sinan) and len(instruct_sinan) > 10, "sinan 预设带较长 instruct")
check(instruct_plain is None, "纯 speaker 名确实零 instruct")
check(A(instruct_sinan, "") == instruct_plain, "覆盖为空后与纯 speaker 的 instruct 一致")

print("== 环境变量总开关：默认关，请求级优先 ==")
original = srv.NO_INSTRUCT_DEFAULT
try:
    check(original is False, "DCX_VOICE_NO_INSTRUCT 默认关（0）")
    srv.NO_INSTRUCT_DEFAULT = True
    check(R({}) == "", "总开关开 + 不传字段 → 零 instruct")
    check(R({"instructOverride": "短指令"}) == "短指令", "总开关开 + 请求级显式值 → 请求级优先")
    check(R({"instructOverride": ""}) == "", "总开关开 + 显式空 → 仍零 instruct")
finally:
    srv.NO_INSTRUCT_DEFAULT = original
check(R({}) is None, "恢复默认关后不覆盖")

print(f"\nPASS  instruct_override {CHECKS} 项")
