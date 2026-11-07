#!/usr/bin/env python3
"""
TNS 多场景真机验收：代码规则 + 语音真实表现，两条证据链都要过。

每个场景做三件事：

1. **代码层**：POST `/tts/normalize`，把服务端实际跑的规则输出与本地 golden
   fixtures 逐字比对。防止「本地规则对了，但 sidecar 还加载着旧代码」。
2. **语音层 A/B**：同一段原文分别以 `tns=false` / `tns=true` 请求
   `/tts/stream`，各自量真 TTFA、音频时长、等效单元语速、F0、块内静音，
   并把 WAV 落盘（可直接听）。
3. **ASR 回听**：把两路音频送回 `/asr`，看模型**实际念出了什么**。用
   fixtures 里的同义关键词组与荒谬模式判定，而不是只看波形指标。

诚实边界：ASR 自己会认错字，所以关键词按「同义组命中任一」判定；
没命中就如实记违规，不因为「指标看着还行」而放行。

用法：
    python3 scripts/voice/tns_probe.py --port 8791 --check --out /tmp/dcx-tns
    python3 scripts/voice/tns_probe.py --scenes url_ip_port,json_nested --out /tmp/dcx-tns-smoke
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import longtext_probe as lp  # noqa: E402
import mixed_matrix_probe as mm  # noqa: E402
from continuity import analyze_clip  # noqa: E402
from mlx_voice_server import speech_units  # noqa: E402
from text_normalize import TNS_VERSION, normalize_for_speech  # noqa: E402

ENGINE = "qwen3-customvoice"
VOICE = "sinan"
SPEED = 1.2
FIXTURES_PATH = HERE / "tns-fixtures.json"
THRESHOLDS_PATH = HERE / "tns-thresholds.json"
OUT = Path("/tmp/dcx-tns")


def port_of(args_port: int) -> int:
    return args_port or int(os.environ.get("PROBE_PORT", "8791"))


def post_json(port: int, path: str, payload: dict, timeout: float = 60.0) -> tuple[int, dict]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                **lp.headers(),
            },
        )
        resp = conn.getresponse()
        raw = resp.read()
        status = resp.status
    finally:
        conn.close()
    try:
        return status, json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return status, {"raw": raw[:200].decode("utf-8", "replace")}


def transcribe(port: int, wav: bytes, timeout: float = 300.0) -> dict[str, Any]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(
            "POST",
            "/asr",
            body=wav,
            headers={
                "Content-Type": "application/wav",
                "Content-Length": str(len(wav)),
                **lp.headers(),
            },
        )
        resp = conn.getresponse()
        raw = resp.read()
        status = resp.status
    finally:
        conn.close()
    if status != 200:
        return {"ok": False, "text": "", "error": raw[:200].decode("utf-8", "replace")}
    try:
        data = json.loads(raw)
        return {"ok": True, "text": str(data.get("text") or ""), "duration_ms": data.get("durationMs")}
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "text": "", "error": raw[:200].decode("utf-8", "replace")}


def health(port: int) -> dict[str, Any]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", "/health")
        resp = conn.getresponse()
        return json.loads(resp.read()).get("versions", {})
    finally:
        conn.close()


def code_check(port: int, scene: dict, expected_version: str) -> dict[str, Any]:
    status, data = post_json(port, "/tts/normalize", {"text": scene["text"], "tns": True})
    local = normalize_for_speech(scene["text"])
    ok = (
        status == 200
        and data.get("text") == scene["expected"]
        and data.get("text") == local.text
        and data.get("version") == expected_version
        and data.get("enabled") is True
        and all(rule in data.get("hits", {}) for rule in scene["rules"])
    )
    return {"http": status, "ok": ok, "server_text": data.get("text"), "server_hits": data.get("hits"), "version": data.get("version")}


def asr_ok(text: str, groups: list[list[str]]) -> tuple[bool, list[list[str]]]:
    """每组同义写法命中任一即算；返回未命中的组，便于如实列出。

    ASR 会把 `config` 写成 `Config`、把 `npm` 写成 `MPM`，大小写不是 TTS
    的错读，统一折叠后比较；这只放宽「字面大小写」，不放宽关键词本身。
    """
    folded = text.lower()
    missed = [g for g in groups if not any(k and k.lower() in folded for k in g)]
    return not missed, missed


def collect(port: int, text: str, tns: bool, th: dict[str, float], audio_dir: Path, stem: str, short_gap: bool = False) -> dict[str, Any]:
    payload = {"text": text, "engine": ENGINE, "voice": VOICE, "speed": SPEED, "tns": tns}
    if short_gap:
        payload["shortGap"] = True
    got = mm.stream_request("/tts/stream", payload)
    blobs: list[bytes] = got["chunks"]
    if got["http"] != 200 or not blobs:
        return {"http": got["http"], "error": "空音频或请求失败", "chunk_count": got["chunk_count"], "audio_s": 0.0}
    x, rate = lp.join_wavs(blobs)
    wav = lp.to_wav(x, rate)
    (audio_dir / f"{stem}.wav").write_bytes(wav)
    # 分母必须是**真正送去合成**的文本：off 用原文，on 用规范化文本。
    # 拿原文 units 去除规范化音频时长，等于人为制造「语速变慢」的假象。
    spoken_text = normalize_for_speech(text, tns).text
    units = speech_units(spoken_text)
    metrics = analyze_clip(wav, units).as_dict()
    duration = float(metrics["duration_s"])
    rate_units = units / duration if duration > 0 else 0.0
    bias = abs(rate_units - th["global_rate_units_s"]) / th["global_rate_units_s"] * 100.0
    asr = transcribe(port, wav)
    return {
        "http": got["http"],
        "ttfa_ms": got["ttfa_ms"],
        "total_ms": got["total_ms"],
        "chunk_count": got["chunk_count"],
        "audio_s": round(duration, 3),
        "spoken_text": spoken_text,
        "units": round(units, 2),
        "rate_units": round(rate_units, 3),
        "rate_bias_pct": round(bias, 2),
        "f0_hz": metrics["f0_hz"],
        "centroid_hz": metrics["centroid_hz"],
        "max_internal_gap_ms": metrics["max_internal_gap_ms"],
        "long_gaps": metrics["long_gaps"],
        "speech_ratio_pct": round(metrics["speech_s"] / duration * 100, 1) if duration else 0.0,
        "asr": asr,
        "samples": x,
        "sample_rate": rate,
        "wav_path": str(audio_dir / f"{stem}.wav"),
    }


def evaluate(scene: dict, code: dict, off: dict, on: dict, th: dict[str, float]) -> list[dict[str, Any]]:
    bad: list[dict[str, Any]] = []

    def add(metric: str, actual: Any, expect: str, ok: bool) -> None:
        if not ok:
            bad.append({"scene": scene["name"], "metric": metric, "actual": actual, "expect": expect})

    add("代码层规则一致", code.get("server_text"), "golden 逐字一致 + 规则命中 + 版本", code.get("ok") is True)
    for side, data in (("off", off), ("on", on)):
        add(f"{side} 有效音频", data.get("error", data.get("audio_s")), f">={th['min_audio_s']}s 且 chunks>={int(th['min_chunks'])}", data.get("audio_s", 0.0) >= th["min_audio_s"] and data.get("chunk_count", 0) >= th["min_chunks"])
        if data.get("error"):
            add(f"{side} ASR 成功", data.get("error"), "HTTP 200 + 文本", False)
    if on.get("error"):
        return bad
    add("on 语速偏差%", on["rate_bias_pct"], f"<= {th['rate_bias_pct']}", on["rate_bias_pct"] <= th["rate_bias_pct"])
    add("on 块内最长静音ms", on["max_internal_gap_ms"], f"<= {th['max_internal_gap_ms']}", on["max_internal_gap_ms"] <= th["max_internal_gap_ms"])
    add("on 异常长静音数", on["long_gaps"], f"<= {int(th['long_gaps'])}", on["long_gaps"] <= th["long_gaps"])
    asr_text = on.get("asr", {}).get("text", "")
    add("on ASR 成功", on.get("asr", {}).get("error", asr_text[:60]), "非空转录", on.get("asr", {}).get("ok") is True and bool(asr_text))
    hit, missed = asr_ok(asr_text, scene["asr_expect"])
    add("on ASR 关键词组", f"未命中 {missed}", "每组同义写法命中任一", hit)
    for pattern in scene["asr_forbid"]:
        add(f"on ASR 荒谬模式「{pattern}」", asr_text, "不得出现", pattern not in asr_text)
    return bad


def markdown(report: dict[str, Any], violations: list[dict[str, Any]]) -> str:
    th = report["thresholds"]
    lines = [
        "# TNS 多场景验收：代码规则 + 语音真实表现",
        "",
        f"- 时间：{report['generated_at']}",
        f"- 服务：`127.0.0.1:{report['port']}`，pid `{report['health'].get('pid')}`，TNS `{report['health'].get('tns')}`，规则 `{TNS_VERSION}`",
        f"- 引擎：`{ENGINE}` / `{VOICE}` / speed `{SPEED}`；语速基准 `{th['global_rate_units_s']}` 等效单元/秒",
        f"- 场景：{len(report['scenes'])} 个 × `tns=false/true` 两路 = {len(report['scenes']) * 2} 次合成 + {len(report['scenes']) * 2} 次 ASR 回听",
        "",
        "> 判定不靠波形自证：每路音频都送回 ASR，看模型**实际念出了什么**。ASR 自身会认错字，关键词按同义组判定；未命中如实记违规。",
        "",
        "## 逐场景结果",
        "",
        "| 场景 | 代码层 | off 时长 | on 时长 | 时长变化 | on TTFA | on 语速偏差 | on 最长静音 | ASR 关键词 | 荒谬模式 | 判定 |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|---|---|",
    ]
    for s in report["scenes"]:
        off, on = s["off"], s["on"]
        delta = (on.get("audio_s", 0) - off.get("audio_s", 0)) / off.get("audio_s", 1) * 100 if off.get("audio_s") else 0.0
        asr_text = on.get("asr", {}).get("text", "")
        hit, missed = asr_ok(asr_text, s["asr_expect"])
        forbid = [p for p in s["asr_forbid"] if p in asr_text]
        state = "✅" if not any(v["scene"] == s["name"] for v in violations) else "❌"
        lines.append(
            f"| {s['label']} | {'✅' if s['code']['ok'] else '❌'} | "
            f"{off.get('audio_s', 0):.2f}s | {on.get('audio_s', 0):.2f}s | {delta:+.0f}% | "
            f"{on.get('ttfa_ms', 0):.0f}ms | {on.get('rate_bias_pct', 0):.1f}% | "
            f"{on.get('max_internal_gap_ms', 0):.0f}ms | "
            f"{'✅' if hit else '❌ ' + str(missed)} | {'✅' if not forbid else '❌ ' + str(forbid)} | {state} |"
        )
    lines += ["", "## ASR 回听原文（off → on）", ""]
    for s in report["scenes"]:
        lines += [
            f"### {s['label']}（`{s['name']}`）",
            "",
            f"- 原文：`{s['text']}`",
            f"- 规范化：`{s['expected']}`",
            f"- off ASR：`{s['off'].get('asr', {}).get('text', '(失败)')}`",
            f"- on ASR：`{s['on'].get('asr', {}).get('text', '(失败)')}`",
            f"- off/on 语速：{s['off'].get('rate_units', 0):.2f} / {s['on'].get('rate_units', 0):.2f} 单元每秒；"
            f"F0 {s['off'].get('f0_hz', 0):.1f} / {s['on'].get('f0_hz', 0):.1f} Hz；"
            f"有声占比 {s['off'].get('speech_ratio_pct', 0):.0f}% / {s['on'].get('speech_ratio_pct', 0):.0f}%",
            "",
        ]
    lines += [
        "## 门禁",
        "",
        f"- 阈值：`{THRESHOLDS_PATH.name}`（先验值，不按本次结果倒推）",
        f"- 违规：**{len(violations)} 项**" if violations else "- 违规：**0 项**",
        "",
    ]
    if violations:
        lines += ["| 场景 | 指标 | 实测 | 要求 |", "|---|---|---|---|"]
        lines += [f"| {v['scene']} | {v['metric']} | {v['actual']} | {v['expect']} |" for v in violations]
    lines += [
        "",
        "## 可听样本",
        "",
        "`audio/<scene>-off.wav` 与 `-on.wav` 是两路原始音频；`ab-<scene>.wav` 把两路用 0.7 秒静音隔开，可直接 A/B 听。",
        "",
        "## 诚实边界",
        "",
        "- 这里量的是本机 sidecar 的客观音频/时序指标 + ASR 转录；**不等于桌面 WebView 真机听感**。",
        "- ASR 会把「一二七」写成「127」、把英文词写错，关键词才用同义组；不应把 ASR 的错字当成 TTS 的错读。",
        "- TNS 只改送去合成的文本，界面上展示的原文一个字不动；规范化必然导致「看到的字」与「听到的字」略有差异。",
        "- 有限同义白名单只覆盖 `text_normalize.py` 里列出的缩写，未知词原样透传，遇到新类型非口语文本仍需补充规则。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    global ENGINE, VOICE, SPEED
    parser = argparse.ArgumentParser(description="TNS 多场景真机验收（代码规则 + ASR 回听）")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--scenes", default="", help="逗号分隔场景名，空串跑全部")
    parser.add_argument("--check", action="store_true", help="按阈值门禁判定，违规退出码 1")
    parser.add_argument("--thresholds", default=str(THRESHOLDS_PATH))
    parser.add_argument("--engine", default=ENGINE)
    parser.add_argument("--voice", default=VOICE)
    parser.add_argument("--speed", type=float, default=SPEED)
    parser.add_argument("--short-gap", action="store_true", help='短块句内静音上限 P1（默认关）；请求级 {"shortGap": true} 只开本次')
    args = parser.parse_args()

    ENGINE, VOICE, SPEED = args.engine, args.voice, args.speed
    port = port_of(args.port)
    mm.PORT = port
    out = Path(args.out)
    audio_dir = out / "audio"
    out.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    th = json.loads(Path(args.thresholds).read_text(encoding="utf-8"))
    fixtures = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
    scenes = fixtures["scenes"]
    if args.scenes:
        wanted = set(args.scenes.split(","))
        scenes = [s for s in scenes if s["name"] in wanted]
    h = health(port)
    print(f"=== TNS 多场景验收 port={port} pid={h.get('pid')} tns={h.get('tns')} 场景={len(scenes)} ===", flush=True)
    if h.get("tns") != th["code_version"]:
        print(f"!! 服务 TNS 状态是 {h.get('tns')}，期望 {th['code_version']}", flush=True)

    results: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    for i, scene in enumerate(scenes, 1):
        name = scene["name"]
        print(f"[{i:02d}/{len(scenes)}] {name} — 代码层 + off + on + 2×ASR", flush=True)
        code = code_check(port, scene, th["code_version"])
        off = collect(port, scene["text"], False, th, audio_dir, f"{name}-off", args.short_gap)
        on = collect(port, scene["text"], True, th, audio_dir, f"{name}-on", args.short_gap)
        # A/B 可听对照：off → 0.7s 静音 → on
        if "samples" in off and "samples" in on:
            rate = on["sample_rate"]
            joined = np.concatenate(
                [off["samples"], np.zeros(int(0.7 * rate), dtype=np.float32), on["samples"]]
            )
            (audio_dir / f"ab-{name}.wav").write_bytes(lp.to_wav(joined, rate))
        bad = evaluate(scene, code, off, on, th)
        violations += bad
        results.append({
            "name": name,
            "label": scene["label"],
            "text": scene["text"],
            "expected": scene["expected"],
            "rules": scene["rules"],
            "asr_expect": scene["asr_expect"],
            "asr_forbid": scene["asr_forbid"],
            "code": code,
            "off": {k: v for k, v in off.items() if k not in ("samples", "sample_rate")},
            "on": {k: v for k, v in on.items() if k not in ("samples", "sample_rate")},
            "violations": bad,
        })
        print(
            f"    代码={'PASS' if code['ok'] else 'FAIL'} "
            f"off={off.get('audio_s', 0):.2f}s/{off.get('rate_units', 0):.2f}u/s "
            f"on={on.get('audio_s', 0):.2f}s/{on.get('rate_units', 0):.2f}u/s "
            f"ASR(on)={on.get('asr', {}).get('text', '(失败)')[:40]} 违规={len(bad)}",
            flush=True,
        )

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "port": port,
        "health": h,
        "engine": ENGINE,
        "voice": VOICE,
        "speed": SPEED,
        "tns_version": TNS_VERSION,
        "thresholds": th,
        "scenes": results,
        "violations": violations,
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "report.md").write_text(markdown(report, violations), encoding="utf-8")
    print(f"\n=== 门禁：{len(violations)} 项违规 ===", flush=True)
    for v in violations:
        print(f"  - {v['scene']} / {v['metric']}：实测 {v['actual']}，要求 {v['expect']}", flush=True)
    print(f"报告：{out / 'report.md'}；音频：{audio_dir}", flush=True)
    return 1 if (args.check and violations) else 0


if __name__ == "__main__":
    raise SystemExit(main())
