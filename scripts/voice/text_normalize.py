#!/usr/bin/env python3
"""
TNS（Text Normalization for Speech）：把非口语文本规范化成可朗读的中文。

只做**确定性、可审计**的替换，不做语义翻译、不猜测代码含义、不补写内容：

1. URL / IP / 端口 / 路径 → 可读中文结构
2. JSON 花括号、冒号、true/false/null → 「是 / 真 / 假 / 空」
3. 数字 + 单位、百分比、版本号、日期、编号 → 中文读法
4. 有限同义缩写白名单（API/ASR/TTS/GET/POST…），未知词原样保留
5. 符号（=、#、@、&&、[]、大写下划线标识符、A/B）→ 中文或空格

设计红线（真机教训见 docs/proposals/super-agent/voice/）：

- **诚实降级**：没命中的原样返回；超长数字、看不懂的结构逐位读，绝不编造。
- **幂等**：`normalize(f(x)) == normalize(x)`，前端已规范化时服务端二次执行不会串改。
- **不误伤口语**：纯中文、无标点长句、普通中英混排应几乎逐字不变。
- **口径一致**：规范化后的文本才是 `speech_units()` 的分母。旧版拿
  `speech_units("https://…")` 当分母，模型却念了 5.5 秒，伺服倍率必然算错。

纯标准库，无 MLX 依赖；Python 与探针共用同一份实现。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Callable, Pattern

TNS_VERSION = "tns-1.0"
TNS_ENV = "DCX_VOICE_TNS"

_CN_DIGITS = "零一二三四五六七八九"
_CN_UNITS = ("", "十", "百", "千")
_CN_BIG = ("", "万", "亿")

# 只放「确定等价、且模型容易念错」的缩写。普通技术词（session.ts、
# openai-provider、X-Tts-Voice）保留原样——真机中英混排本来就达标，
# 把它们翻译掉反而是幻觉。
ABBREV_CI: dict[str, str] = {
    "api": "接口",
    "url": "网址",
    "asr": "语音识别",
    "tts": "语音合成",
    "llm": "大语言模型",
    "sdk": "开发工具包",
    "cli": "命令行",
    "gpu": "显卡",
    "cpu": "处理器",
    "ttfa": "首次出声延迟",
    "ttft": "首次响应延迟",
    "rtf": "实时率",
    "f0": "基频",
    # 命令行工具：真机 ASR 把 `npm` 听成「MPM」、`npx tsc` 逐字母念成
    # 「N P X T S C」并拖出 23% 语速偏差。展开成确定的中文等价词，
    # 不是翻译句子含义，只是把工具名念清楚。
    "npm": "Node 包管理器",
    "npx": "Node 包执行器",
    "tsc": "TypeScript 编译检查",
}
# 全大写才展开，避免把口语里的 "get 到了吗" 误改成「读取到了吗」。
ABBREV_UPPER: dict[str, str] = {
    "GET": "读取",
    "POST": "发送",
    "PUT": "更新",
    "DELETE": "删除",
    "TOKEN": "令牌",
    "OK": "正常",
    "JSON": "J S O N 格式",
}
_UNIT_CN: dict[str, str] = {
    "ms": "毫秒",
    "s": "秒",
    "us": "微秒",
    "ns": "纳秒",
    "hz": "赫兹",
    "khz": "千赫兹",
    "kb": "千字节",
    "mb": "兆字节",
    "gb": "吉字节",
    "tb": "太字节",
    "km": "公里",
    "kg": "千克",
    "mg": "毫克",
    "cm": "厘米",
    "mm": "毫米",
    "fps": "帧每秒",
    "px": "像素",
}


def tns_enabled_by_env() -> bool:
    """默认打开（产品决策 2026-11-07）；`DCX_VOICE_TNS=0` 一键回退原生文本。"""
    return os.environ.get(TNS_ENV, "1").strip().lower() not in ("0", "false", "off", "no")


def request_tns_enabled(payload: dict, default: bool) -> bool:
    """请求级覆盖：`{"tns": false}` 关掉本次，便于 A/B 真机对照。"""
    raw = payload.get("tns")
    if raw is None:
        return default
    if isinstance(raw, str):
        return raw.strip().lower() not in ("0", "false", "off", "no")
    return bool(raw)


def digits_cn(value: str) -> str:
    """逐位读：127 → 一二七（IP / 端口 / 编号 / 电话用这个）。"""
    return "".join(_CN_DIGITS[int(c)] for c in value if c.isdigit())


def integer_cn(n: int) -> str:
    """按中文数位读：3000 → 三千，192 → 一百九十二；超大数退化为逐位读。"""
    if n < 0:
        return "负" + integer_cn(-n)
    if n == 0:
        return "零"
    if n >= 10**12:
        return digits_cn(str(n))
    sections: list[int] = []
    while n > 0:
        sections.append(n % 10000)
        n //= 10000
    out = ""
    need_zero = False
    for i in range(len(sections) - 1, -1, -1):
        seg = sections[i]
        if seg == 0:
            need_zero = True
            continue
        if out and (need_zero or seg < 1000):
            out += "零"
        seg_s = ""
        zero = False
        for pos in range(3, -1, -1):
            d = (seg // 10**pos) % 10
            if d == 0:
                if seg_s:
                    zero = True
            else:
                if zero:
                    seg_s += "零"
                    zero = False
                seg_s += _CN_DIGITS[d] + _CN_UNITS[pos]
        if seg_s.startswith("一十"):
            seg_s = seg_s[1:]
        out += seg_s + _CN_BIG[i]
        need_zero = False
    return out


def decimal_cn(value: str) -> str:
    """带千分位/小数的读法：18.6 → 十八点六，12,480.75 → 一万二千四百八十点七五。"""
    clean = value.replace(",", "")
    if "." in clean:
        head, tail = clean.split(".", 1)
        return integer_cn(int(head or "0")) + "点" + digits_cn(tail)
    return integer_cn(int(clean))


def _abbrev(word: str) -> str:
    if word in ABBREV_UPPER:
        return ABBREV_UPPER[word]
    return ABBREV_CI.get(word.lower(), word)


def _url_repl(m: re.Match[str]) -> str:
    scheme, rest = m.group(1).lower(), m.group(2)
    parsed = re.match(r"^([^/:?#]+)(?::(\d+))?([/?#].*)?$", rest)
    if not parsed:
        return "网址 " + rest  # 看不懂就别猜，至少去掉协议冒号
    host, port, tail = parsed.group(1), parsed.group(2), parsed.group(3) or ""
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", host):
        host_cn = "点".join(digits_cn(p) for p in host.split("."))
    else:
        host_cn = host.replace(".", " 点 ")
    prefix = "加密网址 " if scheme == "https" else "网址 "
    out = prefix + host_cn
    if port:
        out += "，端口" + digits_cn(port)
    path = tail.lstrip("/").split("?", 1)[0]
    segs = [s for s in path.split("/") if s]
    if segs:
        out += "，路径 " + "，".join(_abbrev(s) for s in segs)
    return out


def _brace_repl(m: re.Match[str]) -> str:
    inner = m.group(0)[1:-1].strip()
    if not inner:
        return ""
    inner = re.sub(r"\s*:\s*", " 是 ", inner)
    inner = re.sub(r"\s*,\s*", "，", inner)
    inner = re.sub(r"(?i)\btrue\b", "真", inner)
    inner = re.sub(r"(?i)\bfalse\b", "假", inner)
    inner = re.sub(r"(?i)\bnull\b", "空", inner)
    return inner


def _path_repl(m: re.Match[str]) -> str:
    prefix = "用户主目录下的路径 " if m.group(1) == "~/" else "路径 "
    parts: list[str] = []
    for seg in m.group(2).split("/"):
        if re.fullmatch(r"[\w-]+\.[A-Za-z0-9]{1,6}", seg):
            base, ext = seg.rsplit(".", 1)
            parts.append(f"{base} 点 {ext}")
        elif seg.startswith(".") and len(seg) > 1:
            parts.append("隐藏目录 " + _abbrev(seg[1:]))
        else:
            parts.append(_abbrev(seg))
    return prefix + "，".join(parts)


@dataclass(frozen=True)
class Normalized:
    """规范化结果；hits 用于真机日志与验收报告逐条审计。"""

    text: str
    original: str
    hits: dict[str, int]
    version: str = TNS_VERSION

    @property
    def changed(self) -> bool:
        return self.text != self.original


class _Ctx:
    def __init__(self) -> None:
        self.hits: dict[str, int] = {}

    def sub(
        self,
        name: str,
        pattern: Pattern[str],
        repl: str | Callable[[re.Match[str]], str],
        text: str,
    ) -> str:
        if callable(repl):
            count = 0

            def wrap(m: re.Match[str]) -> str:
                nonlocal count
                count += 1
                return repl(m)

            result = pattern.sub(wrap, text)
        else:
            count = len(pattern.findall(text))
            result = pattern.sub(repl, text)
        if count:
            self.hits[name] = self.hits.get(name, 0) + count
        return result


_URL = re.compile(r"(?i)\b(https?|ftp)://([^\s，。；、！？（）「」\[\]{}<>\"']+)")
_PERCENT = re.compile(r"(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s*%")
_UNIT = re.compile(
    r"(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s*(" + "|".join(sorted(_UNIT_CN, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)
_DATE = re.compile(r"(?<![\w.-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\w.-])")
_VERSION = re.compile(r"(?<![\w.])(?:[vV](\d+(?:\.\d+){1,3})|(\d+(?:\.\d+){2,}))(?![\w.])")
_JSON = re.compile(r"\{[^{}]*\}")
_PATH = re.compile(r"(?<![\w:/])(~/|/)([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)")
_HASH_NUM = re.compile(r"#(\d{3,})")
_FLAG = re.compile(r"(?<=\s)--([A-Za-z][\w-]*)")
_UPPER_SNAKE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
_SLASH_AB = re.compile(r"(?<=[A-Za-z])/(?=[A-Za-z])")
_BRACKETS = re.compile(r"\[([^\]]{1,40})\]")
_ASSIGN = re.compile(r"\s*=\s*")
_PHONE = re.compile(r"(?<![\w.-])(\d{3,4})[- ](\d{3,4})[- ](\d{4})(?![\w.-])")
# 缩写必须避开连字符复合词：X-Tts-Voice / tts-stream 整体是普通技术词，
# 把里面的 tts 单独展开会造出「X-语音合成-Voice」这种更糟的文本。
_ABBREV_UPPER_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(" + "|".join(ABBREV_UPPER) + r")(?![A-Za-z0-9_-])"
)
_ABBREV_CI_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(" + "|".join(ABBREV_CI) + r")(?![A-Za-z0-9_-])"
)


def normalize_for_speech(text: str, enabled: bool = True) -> Normalized:
    """把待合成文本规范化。关掉时逐字返回，不吞字、不猜测。"""
    if not enabled or not text:
        return Normalized(text=text, original=text, hits={})
    ctx = _Ctx()
    out = text

    # ① 大结构优先：URL / JSON / 路径。它们的输出里不再含 ://、{}、前导 /，
    #    后面的符号规则不会二次踩踏。
    if _URL.search(out):
        out = ctx.sub("url", _URL, _url_repl, out)
    for _ in range(8):
        if not _JSON.search(out):
            break
        before = out
        out = ctx.sub("json", _JSON, _brace_repl, out)
        if out == before:
            break
    if _PATH.search(out):
        out = ctx.sub("path", _PATH, _path_repl, out)

    # ② 数字类：百分比 → 单位 → 日期 → 版本 → 编号。顺序不能反：
    #    版本号 2.14.3 含小数点，先按小数处理就再也认不回来了。
    if _PERCENT.search(out):
        out = ctx.sub("percent", _PERCENT, lambda m: "百分之" + decimal_cn(m.group(1)), out)
    if _UNIT.search(out):
        out = ctx.sub(
            "unit",
            _UNIT,
            lambda m: decimal_cn(m.group(1)) + _UNIT_CN[m.group(2).lower()],
            out,
        )
    if _DATE.search(out):
        out = ctx.sub(
            "date",
            _DATE,
            lambda m: f"{digits_cn(m.group(1))}年{integer_cn(int(m.group(2)))}月{integer_cn(int(m.group(3)))}日",
            out,
        )
    if _VERSION.search(out):
        out = ctx.sub(
            "version",
            _VERSION,
            lambda m: "版本" + "点".join(integer_cn(int(p)) for p in (m.group(1) or m.group(2)).split(".")),
            out,
        )
    if _PHONE.search(out):
        out = ctx.sub(
            "phone",
            _PHONE,
            lambda m: " ".join(digits_cn(m.group(i)) for i in (1, 2, 3)),
            out,
        )
    if _HASH_NUM.search(out):
        out = ctx.sub("issue", _HASH_NUM, lambda m: "编号" + digits_cn(m.group(1)), out)

    # ③ A/B 斜杠必须在缩写展开**之前**：ASR/TTS 换完中文后，斜杠两侧
    #    不再满足 (?<=[A-Za-z])，会漏成「语音识别/语音合成」。
    out = ctx.sub("slash_ab", _SLASH_AB, " 和 ", out)

    # ④ 有限同义白名单。全大写与纯缩写分开，避免误伤口语里的普通英文词；
    #    连字符复合词整体跳过（见 _ABBREV_*_RE 的注释）。
    if _ABBREV_UPPER_RE.search(out):
        out = ctx.sub("abbrev_upper", _ABBREV_UPPER_RE, lambda m: ABBREV_UPPER[m.group(1)], out)
    if _ABBREV_CI_RE.search(out):
        out = ctx.sub("abbrev", _ABBREV_CI_RE, lambda m: ABBREV_CI[m.group(1).lower()], out)

    # ⑤ 符号级收尾。连字符复合词（openai-provider / X-Tts-Voice）刻意不动：
    #    真机中英混排本来就达标，改了只会引入新的不确定。
    if _FLAG.search(out):
        out = ctx.sub("cli_flag", _FLAG, lambda m: "参数 " + m.group(1), out)
    if _UPPER_SNAKE.search(out):
        out = ctx.sub("upper_snake", _UPPER_SNAKE, lambda m: m.group(0).replace("_", " "), out)
    if _BRACKETS.search(out):
        out = ctx.sub("brackets", _BRACKETS, lambda m: m.group(1), out)
    if _ASSIGN.search(out):
        out = ctx.sub("assign", _ASSIGN, " 等于 ", out)
    out = ctx.sub("and", re.compile(r"&&"), " 并且 ", out)
    out = ctx.sub("or", re.compile(r"\|\|"), " 或者 ", out)
    out = ctx.sub("hash", re.compile(r"#"), "井号", out)
    out = ctx.sub("at", re.compile(r"@"), " 艾特 ", out)

    # ⑤ 空白/重复标点清理。中文句末标点保留，交给 TTS 自己找换气点。
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s*，\s*", "，", out)
    out = re.sub(r"，{2,}", "，", out)
    out = re.sub(r"井号\s+", "井号", out)
    # 纯标点文本没有「内容」，首尾清理会把「，。！？」削成「。！？」——
    # 宁可不清理，也不能为了排版吞掉原文字符。
    if re.search(r"[\w\u4e00-\u9fff]", out):
        out = re.sub(r"^[，\s]+|[，\s]+$", "", out)
    return Normalized(text=out, original=text, hits=ctx.hits)


def explain(text: str) -> dict:
    n = normalize_for_speech(text)
    return {
        "original": n.original,
        "text": n.text,
        "changed": n.changed,
        "hits": n.hits,
        "version": n.version,
        "idempotent": normalize_for_speech(n.text).text == n.text,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="TNS 文本规范化（可 --explain 逐条看命中）")
    parser.add_argument("text", nargs="*", help="待规范化文本；不给则从 stdin 逐行读")
    parser.add_argument("--off", action="store_true", help="关闭规范化，原样输出")
    parser.add_argument("--json", action="store_true", help="输出 JSON（含命中规则）")
    args = parser.parse_args()
    lines = args.text if args.text else [ln.rstrip("\n") for ln in sys.stdin if ln.strip()]
    for line in lines:
        if args.json:
            print(json.dumps(explain(line) if not args.off else {"original": line, "text": line, "changed": False, "hits": {}, "version": TNS_VERSION, "idempotent": True}, ensure_ascii=False))
        else:
            print(line if args.off else normalize_for_speech(line).text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
