"""
语音连贯性自动化验收（真机采集 / 离线重放 → 客观指标 → 阈值门禁）

## 用法

    # 真机：自动选网关（8799）或直连 sidecar（8791），8 轮
    python3 scripts/voice/check_continuity.py

    # 快速冒烟（4 轮）
    python3 scripts/voice/check_continuity.py --quick

    # 指定产物目录，之后可离线重放（不发网络请求、不需要模型）
    python3 scripts/voice/check_continuity.py --out /tmp/dcx-voice-run
    python3 scripts/voice/check_continuity.py --replay /tmp/dcx-voice-run

    # 自定义阈值 / 自定义文本集（每行一条）
    python3 scripts/voice/check_continuity.py --thresholds my.json --texts my-texts.txt

## 退出码（诚实边界）

- `0` 全部指标达标；
- `1` 有指标超出阈值（报告里逐项列出实测值 / 阈值）；
- `2` **环境不可用，本次没有实测**——sidecar/网关没起来或鉴权材料缺失。
  绝不把「没跑成」伪装成通过。

## 为什么既存 WAV 又存报告

真机 TTS 有随机性（即使固定 seed，模型输出也可能有细微差异）。把每轮原始
WAV 落盘后，任何人都能用 `--replay` 在没有 MLX 的机器上复核同一份结论，
也能直接拖进播放器人工听，避免「绿灯但用户听着不对」时无从对证。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.client
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from continuity import (  # noqa: E402
    analyze_clip,
    compare_stream_batch,
    evaluate,
    load_thresholds,
    split_stream_chunks,
    summarize_rounds,
)

HOME = Path.home()
SOUL_CONFIG = HOME / ".deepcode/soul/config.json"
JWT_SECRET = HOME / ".deepcode/web-jwt-secret"

DEFAULT_TEXTS = [
    "这一句只有十来个字，用来测短句语速。",
    "没有标点的长句会一直念下去中间不换气象这样一直读到底最容易暴露语速漂移的问题",
    "我把这三处都核对了一遍，结论比较清楚：先处理回滚路径，再收敛音色，最后看生成延迟。",
    "长文本会触发服务端按四十八字自动分段因此需要额外检查段与段之间的衔接是否连贯不会出现前半段快后半段慢或者中间突然静音的情况还要确认尾部没有退化成长时间的空白。",
]
# 采集时把基础集**重复两遍**（见 read_texts）。两个目的：
# 1. 前后半是同一串文本，ttfa_growth_pct 才不会把「后半恰好分到长句」
#    误判成「越聊越迟钝」——真机首版就踩了这个坑（107% 假增长）；
# 2. 同文本的 F0 / 质心漂移是音色连贯性的严格对照，比不同文本之间的
#    宽松离散度更能抓到「每句重新设计音色」。

DEFAULT_OUT = Path("/tmp/dcx-voice-continuity")


def log(message: str) -> None:
    print(message, flush=True)


def get_json(port: int, path: str, headers: dict[str, str], timeout: float = 5.0) -> tuple[int, bytes]:
    """GET 一个端点，返回 (状态码, 响应体)。连接失败抛 OSError。"""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def post(port: int, path: str, payload: dict[str, Any], headers: dict[str, str], timeout: float = 180.0) -> dict[str, Any]:
    """POST 语音端点，返回状态码、响应体与毫秒级计时。

    `stream_first_ms` 定义为「请求发出 → 响应体第一个字节到达」，与
    /tmp/measure-ttfa.mjs 同口径：量的是绝对墙钟，不是相对响应头的偏移。
    流式响应每个 TCP 段到达时立刻可读，所以首字节就是首块可播放音频的
    到达下界；整块响应则是生成完才发，首字节≈完成时刻。
    """
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request_headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
        **headers,
    }
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    started = time.monotonic()
    try:
        conn.request("POST", path, body=body, headers=request_headers)
        resp = conn.getresponse()
        status = resp.status
        first_ms: float | None = None
        first = resp.read(1)
        buffer = bytearray(first)
        if first:
            first_ms = (time.monotonic() - started) * 1000.0
        buffer.extend(resp.read())
        total_ms = (time.monotonic() - started) * 1000.0
        return {
            "status": status,
            "body": bytes(buffer),
            "first_ms": first_ms,
            "total_ms": total_ms,
        }
    finally:
        conn.close()


def make_jwt(secret: str) -> str:
    """自签与独立 Web 引擎同口径的 HS256 会话 JWT。"""
    def enc(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=").decode()

    iat = int(time.time())
    signing_input = f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc({'sub': 'admin', 'displayName': 'admin', 'mail': '', 'authSource': 'local', 'iat': iat, 'exp': iat + 3600})}"
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def sidecar_headers() -> dict[str, str]:
    if not SOUL_CONFIG.is_file():
        raise FileNotFoundError(f"缺少 {SOUL_CONFIG}，无法取 sidecar token")
    token = json.loads(SOUL_CONFIG.read_text(encoding="utf-8"))["voice"]["token"]
    return {"Authorization": f"Bearer {token}"}


def gateway_headers() -> dict[str, str]:
    if not JWT_SECRET.is_file():
        raise FileNotFoundError(f"缺少 {JWT_SECRET}，无法自签网关会话")
    secret = JWT_SECRET.read_text(encoding="utf-8").strip()
    return {"Cookie": f"deepcode_web_token={make_jwt(secret)}"}


def resolve_endpoint(mode: str, gateway_port: int, sidecar_port: int) -> tuple[str, int, dict[str, str], str, str]:
    """选择可用链路，返回 (名称, 端口, headers, 整块路径, 流式路径)。"""
    candidates: list[tuple[str, int, dict[str, str], str, str, str]] = []
    if mode in ("auto", "gateway"):
        candidates.append(("gateway", gateway_port, gateway_headers, "/api/health", "/api/voice/tts", "/api/voice/tts/stream"))
    if mode in ("auto", "sidecar"):
        candidates.append(("sidecar", sidecar_port, sidecar_headers, "/health", "/tts", "/tts/stream"))
    errors: list[str] = []
    for name, port, header_fn, health_path, batch_path, stream_path in candidates:
        try:
            headers = header_fn()
            status, _ = get_json(port, health_path, headers)
            if status == 200:
                return name, port, headers, batch_path, stream_path
            errors.append(f"{name}:{port} /health → {status}")
        except (OSError, KeyError, FileNotFoundError, ValueError) as exc:
            errors.append(f"{name}:{port} → {exc}")
    raise RuntimeError("；".join(errors))


def read_texts(path: str | None, rounds: int) -> list[str]:
    """构造本轮文本序列。

    默认文本集按「基础集 + 同一序列重复」铺满 rounds，使前后半文本完全
    一致：TTFA 增长与同文本音色漂移都变成干净的重复测量，不受句子长度
    这个混淆变量影响。自定义 --texts 时保持用户给的顺序不变。
    """
    if path:
        lines = [line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines()]
        texts = [line for line in lines if line and not line.startswith("#")]
        if not texts:
            raise ValueError("文本集为空")
        return [texts[i % len(texts)] for i in range(rounds)]
    half = max(1, (rounds + 1) // 2)
    base = [DEFAULT_TEXTS[i % len(DEFAULT_TEXTS)] for i in range(half)]
    repeated = (base * ((rounds + half - 1) // half))[:rounds]
    return repeated


def collect(args: argparse.Namespace, out: Path) -> dict[str, Any]:
    """真机采集：每轮整块 + 流式各一次，落盘原始 WAV。"""
    name, port, headers, batch_path, stream_path = resolve_endpoint(
        args.endpoint, args.gateway_port, args.sidecar_port
    )
    texts = read_texts(args.texts, args.rounds)
    base = {"engine": args.engine, "voice": args.voice, "speed": args.speed}
    log(f"链路: {name} 127.0.0.1:{port}  engine={args.engine} voice={args.voice} speed={args.speed}")
    log(f"轮次: {len(texts)}（含同文本重复对照）\n")

    # 预热一次：MLX 首次推理会编译 metal kernel，混进前几轮会把
    # ttfa_growth / rate_spread 全带偏，必须在计时前烧掉。
    warm = post(port, batch_path, {**base, "text": texts[0]}, headers)
    if warm["status"] != 200:
        raise RuntimeError(f"预热请求失败 status={warm['status']} body={warm['body'][:200]!r}")
    log(f"预热完成（{warm['total_ms']:.0f}ms），不计入指标\n")

    entries: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        batch_file = f"round-{index:02d}-batch.wav"
        stream_file = f"round-{index:02d}-stream.bin"
        batch = post(port, batch_path, {**base, "text": text}, headers)
        if batch["status"] != 200:
            raise RuntimeError(f"第 {index + 1} 轮整块失败 status={batch['status']} body={batch['body'][:200]!r}")
        (out / batch_file).write_bytes(batch["body"])

        stream = post(port, stream_path, {**base, "text": text, "interval": args.interval}, headers)
        if stream["status"] != 200:
            raise RuntimeError(f"第 {index + 1} 轮流式失败 status={stream['status']} body={stream['body'][:200]!r}")
        (out / stream_file).write_bytes(stream["body"])
        chunks = split_stream_chunks(stream["body"])
        # 每块单独落 WAV，便于人工拖进播放器核对边界听感
        for chunk_index, chunk in enumerate(chunks):
            (out / f"round-{index:02d}-chunk-{chunk_index:02d}.wav").write_bytes(chunk)

        entry = {
            "index": index,
            "text": text,
            "batch_file": batch_file,
            "stream_file": stream_file,
            "timing": {
                "batch_ms": round(batch["total_ms"], 1),
                "stream_first_ms": round(stream["first_ms"] or stream["total_ms"], 1),
                "stream_total_ms": round(stream["total_ms"], 1),
            },
        }
        entries.append(entry)
        log(f"  {index + 1:2d}/{len(texts)}  {len(text):3d}字  "
            f"整块 {entry['timing']['batch_ms']:7.0f}ms  "
            f"流式首块 {entry['timing']['stream_first_ms']:7.0f}ms  "
            f"{len(chunks):2d} 块")

    return {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "mode": "live",
        "endpoint": name,
        "port": port,
        "engine": args.engine,
        "voice": args.voice,
        "speed": args.speed,
        "interval": args.interval,
        "thresholds_file": str(args.thresholds),
        "rounds": entries,
    }


def load_manifest(out: Path) -> dict[str, Any]:
    manifest_path = out / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"缺少 {manifest_path}，无法重放；请先真机采集一次")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def analyze_manifest(manifest: dict[str, Any], out: Path) -> dict[str, Any]:
    """对 manifest 指向的 WAV 跑分析内核（采集与重放共用）。"""
    rounds: list[dict[str, Any]] = []
    for entry in manifest["rounds"]:
        batch_bytes = (out / entry["batch_file"]).read_bytes()
        stream_bytes = (out / entry["stream_file"]).read_bytes()
        chunks = split_stream_chunks(stream_bytes)
        batch_metric = analyze_clip(batch_bytes, len(entry["text"])).as_dict()
        comparison = compare_stream_batch(chunks, batch_bytes)
        rounds.append({
            "index": entry["index"],
            "text": entry["text"],
            "batch": batch_metric,
            "stream": comparison,
            "timing": entry["timing"],
        })
    return {"summary": summarize_rounds(rounds), "rounds": rounds}


def print_report(manifest: dict[str, Any], result: dict[str, Any], thresholds: dict[str, float],
                 violations: list[dict[str, Any]], out: Path, report_path: Path, json_only: bool) -> None:
    if json_only:
        return
    summary = result["summary"]
    log("\n=== 逐轮明细 ===")
    log(f"{'轮':>3} {'字数':>4} {'语速':>9} {'最长静音':>10} {'块数':>5} {'时长差':>9} {'边界跳变':>9} {'F0':>8} {'TTFA':>9}")
    for item in result["rounds"]:
        b, s, t = item["batch"], item["stream"], item["timing"]
        log(f"{item['index'] + 1:>3} {len(item['text']):>4} {b['chars_per_second']:>8.2f} "
            f"{b['max_internal_gap_ms']:>9.0f}ms {s['chunk_count']:>5} "
            f"{s['duration_delta_pct']:>8.2f}% {s['boundary_jump_ratio']:>9.3f} "
            f"{b['f0_hz']:>7.1f}Hz {t['stream_first_ms']:>8.0f}ms")

    log("\n=== 门槛判定 ===")
    log(f"{'指标':<38} {'实测':>12} {'阈值':>12}  结论")
    for key, limit in thresholds.items():
        value = summary.get(key)
        ok = value is not None and (value >= limit if key == "min_stream_chunks" else value <= limit)
        shown = "—" if value is None else f"{value:.2f}"
        direction = ">=" if key == "min_stream_chunks" else "<="
        log(f"{key:<38} {shown:>12} {f'{direction} {limit:.2f}':>12}  {'PASS' if ok else 'FAIL'}")

    log(f"\nTTFA 前半 {summary['ttfa_head_ms']:.0f}ms → 后半 {summary['ttfa_tail_ms']:.0f}ms "
        f"（增幅 {summary['ttfa_growth_pct']:.1f}%，前后半为同一串文本）")
    log(f"每字延迟离散度 {summary['ttfa_per_char_spread_pct']:.1f}%"
        f"（参考：确认增长不是文本长度混淆）")
    log(f"同文本重复：F0 漂移 {summary['same_text_f0_drift_pct']:.2f}%，"
        f"质心漂移 {summary['same_text_centroid_drift_pct']:.2f}%")
    if violations:
        log(f"\nFAIL {len(violations)} 项不达标：")
        for item in violations:
            log(f"  - {item['metric']}: 实测 {item['value']} / 限制 {item['limit']}（{item['reason']}）")
    else:
        log("\nPASS 语音连贯性全部指标达标")
    log(f"产物: {out}")
    log(f"报告: {report_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="语音连贯性自动化验收")
    parser.add_argument("--endpoint", choices=["auto", "gateway", "sidecar"], default="auto")
    parser.add_argument("--gateway-port", type=int, default=8799)
    parser.add_argument("--sidecar-port", type=int, default=8791)
    parser.add_argument("--rounds", type=int, default=2 * len(DEFAULT_TEXTS),
                        help="轮数；默认基础文本集重复两遍（前后半同序列）")
    parser.add_argument("--quick", action="store_true", help="只跑前 4 轮")
    parser.add_argument("--replay", type=str, help="离线重放目录（不发网络请求）")
    parser.add_argument("--out", type=str, help="产物目录（默认 /tmp/dcx-voice-continuity/<时间戳>）")
    parser.add_argument("--texts", type=str, help="自定义文本集，每行一条，# 开头为注释")
    parser.add_argument("--thresholds", type=str, help="阈值 JSON 路径")
    parser.add_argument("--engine", default="qwen3-customvoice")
    parser.add_argument("--voice", default="sinan")
    parser.add_argument("--speed", type=float, default=1.2)
    parser.add_argument("--interval", type=float, default=1.0, help="流式块目标秒数")
    parser.add_argument("--json-only", action="store_true", help="只输出 JSON 报告")
    args = parser.parse_args()
    if args.quick and args.texts is None:
        args.rounds = min(4, args.rounds)
    args.thresholds = str(Path(args.thresholds).resolve()) if args.thresholds else None

    out = Path(args.replay) if args.replay else (Path(args.out) if args.out else DEFAULT_OUT / datetime.now().strftime("%Y%m%d-%H%M%S"))
    out.mkdir(parents=True, exist_ok=True)

    try:
        thresholds = load_thresholds(Path(args.thresholds) if args.thresholds else None)
        if args.replay:
            manifest = load_manifest(out)
            log(f"离线重放: {out}（{manifest.get('endpoint', '?')}，{len(manifest['rounds'])} 轮）")
        else:
            manifest = collect(args, out)
            (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        result = analyze_manifest(manifest, out)
    except (RuntimeError, OSError, ValueError, KeyError, FileNotFoundError) as exc:
        log(f"\nNOT TESTED 环境不可用 / 数据不可用，本次没有实测：{exc}")
        log("请先跑 `npm run voice:start` 启动 sidecar，或 `npm run start:web` 启动网关；"
            "桌面引擎注入独立 JWT secret，不能用于本脚本。")
        return 2

    violations = evaluate(result["summary"], thresholds)
    report = {
        "manifest": manifest,
        "thresholds": thresholds,
        "summary": result["summary"],
        "violations": violations,
        "verdict": "PASS" if not violations else "FAIL",
        "rounds": result["rounds"],
        "analysis_sha256": hashlib.sha256(
            json.dumps(result["rounds"], ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()[:16],
    }
    # 重放可能带完全不同的 --thresholds，绝不能覆盖原采集那份报告：
    # 曾经用极严阈值 replay 后把 full/report.json 从 PASS 覆写成 FAIL，
    # 事后看报告会以为那次真机验收没过。重放单独落一份。
    report_path = out / ("report-replay.json" if args.replay else "report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print_report(manifest, result, thresholds, violations, out, report_path, args.json_only)
    if args.json_only:
        print(json.dumps({"verdict": report["verdict"], "summary": result["summary"],
                          "violations": violations, "report": str(report_path)}, ensure_ascii=False))
    return 0 if not violations else 1


if __name__ == "__main__":
    raise SystemExit(main())
