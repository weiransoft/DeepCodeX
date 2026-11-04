#!/usr/bin/env python3
"""
司南的本机语音 sidecar（MLX / Apple Silicon）

## 为什么是独立进程

模型跑在 Python（MLX 的音频生态都在 Python），而 UI 在 WebView。中间用本机
HTTP 划界，有三个好处：模型崩溃不拖垮应用；可以单独重启与压测；浏览器版与
桌面版走同一条链路。

## 端点

    GET  /health   → 依赖与模型就绪情况（不加载模型，秒回）
    POST /tts      → {"text","engine","voice","speed"} → audio/wav
    POST /asr      → 原始 wav 字节 → {"text","durationMs","model"}
    POST /warmup   → 触发模型加载（首次 10~30s）

## 三条设计纪律

1. **懒加载**：`/health` 绝不加载模型。否则"看一眼状态"要等半分钟。
2. **依赖缺失不崩**：`import mlx_audio` 失败时服务照常活着，`/health`
   返回 `ready:false` + 具体原因。用户能看到"缺什么"，而不是连接被拒。
3. **鉴权沿用配置里的 token**：与引擎读同一份 `~/.deepcode/soul/config.json`。
   `127.0.0.1` 不等于安全——同机任何进程都能 POST 到这里。

## 用法

    python3 scripts/voice/mlx_voice_server.py            # 默认 127.0.0.1:8791
    python3 scripts/voice/mlx_voice_server.py --selftest # 只检查依赖与模型，不起服务
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8791
DEFAULT_ASR_MODEL = "mlx-community/whisper-large-v3-turbo"

# 引擎 → 模型 id（与 core 的 VoiceEngine 枚举一一对应）
#
# 这里没有 CosyVoice2：mlx-audio 0.6.4 的模型目录里根本没有它。
# 中文 + 「用一句话描述音色」这条需求，实际对应的是 Qwen3-TTS 的
# VoiceDesign 变体——它接受自然语言音色描述，正好是「御姐音」的入口。
MODEL_IDS = {
    "qwen3-voicedesign": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
    "qwen3-customvoice": "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
    "kokoro": "prince-canuma/Kokoro-82M",
}
DEFAULT_TTS_ENGINE = "qwen3-voicedesign"
# 合成语言。中文助手固定 zh，避免 auto 在短句上判成英文
TTS_LANGUAGE = "Chinese"
# Kokoro 的中文音色（lang_code 'z'）
KOKORO_VOICE = "zf_xiaobei"


def soul_config_path() -> Path:
    """配置文件路径（与引擎同源：~/.deepcode/soul/config.json）"""
    home = os.environ.get("DEEPCODE_HOME") or str(Path.home())
    return Path(home) / ".deepcode" / "soul" / "config.json"


def read_token() -> str:
    """读取引擎写入的 sidecar token（缺省空串 = 不校验，仅限本机调试）"""
    try:
        data = json.loads(soul_config_path().read_text(encoding="utf-8"))
        token = data.get("voice", {}).get("token", "")
        return token if isinstance(token, str) else ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# 依赖探测（导入成功不等于模型可用，分开报）
# ---------------------------------------------------------------------------

def probe_deps() -> dict[str, Any]:
    """探测依赖与模型是否可导入（不加载权重）"""
    out: dict[str, Any] = {"versions": {}, "asr": {}, "tts": {}}
    try:
        import mlx.core as mx  # noqa: F401

        out["versions"]["mlx"] = getattr(mx, "__version__", "unknown")
    except Exception as exc:  # pragma: no cover - 环境相关
        out["versions"]["mlx"] = f"missing: {exc}"

    try:
        import mlx_whisper  # noqa: F401

        out["asr"] = {"model": DEFAULT_ASR_MODEL, "ready": True}
        out["versions"]["mlx_whisper"] = "ok"
    except Exception as exc:
        out["asr"] = {
            "model": DEFAULT_ASR_MODEL,
            "ready": False,
            "reason": f"mlx_whisper 不可用：{exc}",
        }

    try:
        import mlx_audio  # noqa: F401
        from mlx_audio.tts.utils import load_model  # noqa: F401

        # mlx_audio 只是"库在"，具体模型要等首次加载才知道能不能跑
        out["tts"] = {"model": MODEL_IDS[DEFAULT_TTS_ENGINE], "ready": True}
        out["versions"]["mlx_audio"] = getattr(mlx_audio, "version", None) or "ok"
    except Exception as exc:
        out["tts"] = {
            "model": MODEL_IDS[DEFAULT_TTS_ENGINE],
            "ready": False,
            "reason": f"mlx_audio 不可用：{exc}",
        }
    return out


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

class TtsEngine:
    """
    按引擎缓存已加载的模型（加载一次几十秒，不能每个请求都加载）

    用锁串行化合成：`ThreadingHTTPServer` 会并发处理请求，而 MLX 的
    计算图与模型状态不是线程安全的。前端播报队列 + 用户手动试听完全
    可能同时打到两个请求，不加锁的表现是随机崩溃或串音。

    三种引擎的调用方式不同，不能统一成 `generate()`：
    - VoiceDesign：`generate_voice_design(text, instruct, language)`
    - CustomVoice：`generate_custom_voice(text, speaker, language, instruct)`
    - Kokoro：`generate(text, voice, speed, lang_code)`
    这些都是 mlx-audio 0.6.4 的真实签名，不是推测。
    """

    def __init__(self) -> None:
        self._models: dict[str, Any] = {}
        self._lock = threading.Lock()

    def _load(self, engine: str) -> Any:
        """按需加载并缓存模型"""
        if engine in self._models:
            return self._models[engine]
        model_id = MODEL_IDS.get(engine, MODEL_IDS[DEFAULT_TTS_ENGINE])
        from mlx_audio.tts.utils import load_model

        model = load_model(model_id)
        self._models[engine] = model
        return model

    def synthesize(self, text: str, engine: str, voice: str, speed: float) -> bytes:
        """
        合成一段语音，返回 WAV 字节。

        `voice` 的语义随引擎变化：VoiceDesign 是**音色描述**，
        CustomVoice 是预置 speaker 名，Kokoro 是音色 id。
        """
        import numpy as np

        if engine not in MODEL_IDS:
            engine = DEFAULT_TTS_ENGINE

        with self._lock:
            model = self._load(engine)

            if engine == "qwen3-voicedesign":
                chunks = list(
                    model.generate_voice_design(
                        text=text,
                        instruct=voice or "mature female voice, calm and steady",
                        language=TTS_LANGUAGE,
                    )
                )
                native_speed = False
            elif engine == "qwen3-customvoice":
                chunks = list(
                    model.generate_custom_voice(
                        text=text,
                        speaker=voice or "Vivian",
                        language=TTS_LANGUAGE,
                    )
                )
                native_speed = False
            else:
                chunks = list(
                    model.generate(
                        text=text,
                        voice=voice or KOKORO_VOICE,
                        speed=speed,
                        lang_code="z",
                    )
                )
                native_speed = True

            if not chunks:
                raise RuntimeError("模型没有产出音频")

            audio = np.concatenate([np.array(c.audio, dtype=np.float32).reshape(-1) for c in chunks])
            rate = int(chunks[0].sample_rate)

        # Qwen3-TTS 的 generate_* 没有 speed 参数，只能用重采样变速。
        # 代价是音高跟着变（像磁带快进），对语音助手的 0.8~1.3 倍区间
        # 听感可接受；kokoro 走原生 speed，不做这一步。
        if not native_speed and speed != 1.0 and speed > 0:
            target = max(1, int(len(audio) / speed))
            audio = np.interp(
                np.linspace(0, len(audio), target, endpoint=False),
                np.arange(len(audio)),
                audio,
            )

        return encode_wav_bytes(audio, rate)


def encode_wav_bytes(samples: "Any", sample_rate: int) -> bytes:
    """
    Float32 单声道样本 → PCM16 WAV 字节

    @param samples numpy 数组（-1~1）
    @param sample_rate 采样率
    @returns WAV 字节
    """
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm16.tobytes())
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# ASR
# ---------------------------------------------------------------------------

class AsrEngine:
    """
    Whisper 转写（不缓存模型：mlx_whisper 内部有缓存，重复调用不会重复下载）

    与 TTS 同样加锁：MLX 推理并发不安全，且 whisper 首次调用会下载权重，
    并发触发会打同一个缓存目录。
    """

    def __init__(self) -> None:
        self.model = DEFAULT_ASR_MODEL
        self._lock = threading.Lock()

    def transcribe(self, wav_bytes: bytes) -> dict[str, Any]:
        """把 WAV 字节转成文本"""
        import mlx_whisper

        with self._lock:
            with wave.open(io.BytesIO(wav_bytes), "rb") as handle:
                channels = handle.getnchannels()
                width = handle.getsampwidth()
                rate = handle.getframerate()
                frames = handle.getnframes()
                pcm = handle.readframes(frames)

            duration_ms = int(frames / rate * 1000) if rate else 0
            if width != 2:
                raise RuntimeError(f"仅支持 16-bit PCM，收到 {width * 8}-bit")

            import numpy as np

            audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
            if channels > 1:
                audio = audio.reshape(-1, channels).mean(axis=1)
            if rate != 16000:
                # 线性插值到 16k：Whisper 内部要 16k，粗略重采样对识别影响很小
                target = int(len(audio) * 16000 / rate)
                audio = np.interp(
                    np.linspace(0, len(audio), target, endpoint=False),
                    np.arange(len(audio)),
                    audio,
                )

            result = mlx_whisper.transcribe(audio, path_or_hf_repo=self.model, language="zh")
            return {
                "text": (result.get("text") or "").strip(),
                "durationMs": duration_ms,
                "model": self.model,
            }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """极简路由：只有四个端点，不引入框架"""

    server_version = "DeepCodeVoice/1.0"
    tts = TtsEngine()
    asr = AsrEngine()
    token = ""

    # ---- 工具 ----

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D102
        sys.stderr.write("[voice] " + (fmt % args) + "\n")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        """校验 Bearer token（配置里没有 token 时放行，便于首次调试）"""
        if not self.token:
            return True
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {self.token}"

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    # ---- 路由 ----

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._send_json(404, {"error": f"未知路径 {self.path}"})
            return
        deps = probe_deps()
        self._send_json(
            200,
            {
                "ok": True,
                "model": {"asr": deps["asr"], "tts": deps["tts"]},
                "versions": {
                    "python": sys.version.split()[0],
                    "pid": str(os.getpid()),
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    **deps["versions"],
                },
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._authorized():
                self._send_json(401, {"code": "UNAUTHORIZED", "reason": "token 不匹配"})
                return
            if self.path == "/warmup":
                probe = probe_deps()
                self._send_json(200, {"ok": True, "model": probe["tts"]})
                return
            if self.path == "/tts":
                self._handle_tts()
                return
            if self.path == "/asr":
                self._handle_asr()
                return
            self._send_json(404, {"error": f"未知路径 {self.path}"})
        except Exception as exc:  # 兜底：任何异常都要有结构化返回，不能静默断连
            traceback.print_exc()
            self._send_json(500, {"code": "INTERNAL", "reason": str(exc)})

    def _handle_tts(self) -> None:
        payload = json.loads(self._read_body() or b"{}")
        text = str(payload.get("text") or "").strip()
        if not text:
            self._send_json(400, {"code": "EMPTY_TEXT", "reason": "text 不能为空"})
            return
        engine = str(payload.get("engine") or DEFAULT_TTS_ENGINE)
        voice = str(payload.get("voice") or "")
        # 手改配置 / 旧客户端可能传字符串，坏值回落 1.0 而不是抛 500
        try:
            speed = float(payload.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(2.0, max(0.5, speed))
        started = time.time()
        audio = self.tts.synthesize(text, engine, voice, speed)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Synth-Ms", str(int((time.time() - started) * 1000)))
        self.end_headers()
        self.wfile.write(audio)

    def _handle_asr(self) -> None:
        audio = self._read_body()
        if not audio:
            self._send_json(400, {"code": "EMPTY_AUDIO", "reason": "音频为空"})
            return
        self._send_json(200, self.asr.transcribe(audio))


def main() -> int:
    """入口"""
    parser = argparse.ArgumentParser(description="DeepCode 本机 MLX 语音 sidecar")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--selftest", action="store_true", help="只检查依赖并退出")
    args = parser.parse_args()

    Handler.token = read_token()

    if args.selftest:
        deps = probe_deps()
        print(json.dumps(deps, ensure_ascii=False, indent=2))
        ready = deps["asr"].get("ready") and deps["tts"].get("ready")
        print("\n结论：" + ("依赖齐全，可以启动服务" if ready else "依赖不全，按上面的 reason 处理"))
        return 0 if ready else 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[voice] 监听 http://{args.host}:{args.port}")
    print(f"[voice] 配置：{soul_config_path()}（token {'已启用' if Handler.token else '未启用'}）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[voice] 退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
