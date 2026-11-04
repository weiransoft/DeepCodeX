/**
 * 语音端点：本机 MLX sidecar 的代理
 *
 * ## 为什么由引擎代理，而不是前端直连
 *
 * 三个理由，缺一条就够否掉直连：
 *
 * 1. **鉴权不落地**——sidecar 的 token 只存在于引擎与 sidecar 之间。前端直连
 *    就得把 token 交给浏览器（页面脚本、扩展、缓存都会看到）。代理之后前端
 *    只跟同源端点说话，token 永不出进程。
 * 2. **错误语义可加工**——sidecar 没起、起了但模型没加载、模型加载失败，
 *    这三种在直连下都表现为"请求失败"。代理能把它们翻译成用户能照做的提示
 *    （"运行 scripts/voice/setup.sh"），而不是一个 `TypeError: Failed to fetch`。
 * 3. **浏览器版与桌面版同一条链路**——都是 HTTP 到引擎，不需要为桌面单独开洞。
 *
 * ## 三个端点
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/api/voice/status` | 探测 sidecar（1.2s 超时），返回真实就绪状态 |
 * | POST | `/api/voice/tts` | 文本 → audio/wav（转发，超时 60s） |
 * | POST | `/api/voice/asr` | audio/wav → `{text}`（转发，超时 60s） |
 *
 * ## 降级纪律
 *
 * sidecar 不在时返回 **503**，并带 `code` 与 `hint`（可执行命令）。
 * 不能返回 500——500 表示"我们坏了"，503 表示"依赖没装"，用户对这
 * 两者的反应完全不同。
 *
 * @module web/api/voice-api
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  VOICE_ENGINES,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  type SoulConfig,
  type VoiceEngine,
} from "@vegamo/deepcode-core";
import { ApiError, readJsonBody, sendJson } from "../http-utils";
import { readSoulConfig, soulConfigLocation } from "./soul-api";
import type { EngineHomeSettings } from "../engine-home";
import type { AuthContext } from "../user-identity";

/** 探测超时（sidecar 未启动时 connect 会被拒绝，1.2s 足够分辨"慢"与"没有"） */
const PROBE_TIMEOUT_MS = 1200;

/** 合成/识别超时（首次合成含模型加载，给足 60s） */
const INFER_TIMEOUT_MS = 60_000;

/** 单次合成文本上限（一句/一段，不是整篇文档） */
const TTS_TEXT_MAX = 2000;

/** 单次音频上限（16k 单声道 PCM16 ≈ 1.9MB/分钟；60s 上限给到 30MB 余量） */
const ASR_BYTES_MAX = 30 * 1024 * 1024;

/** 安装提示：用户照着能跑起来的那条命令 */
const INSTALL_HINT =
  "在仓库根运行 bash scripts/voice/setup.sh 安装 MLX 语音依赖，然后 python3 scripts/voice/mlx_voice_server.py";

/** sidecar /health 的形状（全部可选：我们只信自己用到的字段） */
type SidecarHealth = {
  ok?: boolean;
  model?: {
    asr?: { model?: string; ready?: boolean; reason?: string };
    tts?: { model?: string; ready?: boolean; reason?: string };
  };
  versions?: Record<string, string>;
};

/** GET /api/voice/status 响应体 */
export type VoiceStatusResponse = {
  /** sidecar 是否可达 */
  reachable: boolean;
  /** 语音是否被用户启用 */
  enabled: boolean;
  /** ASR/TTS 各自就绪情况 */
  asr: { model: string; ready: boolean; reason?: string };
  tts: { model: string; ready: boolean; reason?: string };
  /** sidecar 地址（回显配置，排障用） */
  endpoint: string;
  /** 版本信息（sidecar 提供时） */
  versions?: Record<string, string>;
  /** 未就绪时的可执行提示 */
  hint?: string;
  /** 配置文件位置 */
  configPath: string;
};

/**
 * 带超时的 fetch
 *
 * @param url 目标
 * @param init 请求初始化
 * @param timeoutMs 超时
 * @returns 响应
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测 sidecar 健康状态
 *
 * @param config 语音配置
 * @returns 健康响应（不可达返回 null）
 */
async function probeSidecar(config: SoulConfig["voice"]): Promise<SidecarHealth | null> {
  try {
    const res = await fetchWithTimeout(`${config.endpoint}/health`, { method: "GET" }, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await res.json()) as SidecarHealth;
  } catch {
    return null;
  }
}

/**
 * 处理 GET /api/voice/status
 *
 * 永远返回 200：状态本身是"能查到"的，未就绪写在字段里。
 * 用 4xx/5xx 表达"未就绪"会让前端把状态查询当错误处理，得不偿失。
 *
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export async function handleVoiceStatus(
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): Promise<void> {
  const { config } = readSoulConfig(ctx, settings);
  const health = await probeSidecar(config.voice);
  const asr = health?.model?.asr;
  const tts = health?.model?.tts;

  const payload: VoiceStatusResponse = {
    reachable: health !== null,
    enabled: config.voice.enabled,
    asr: {
      model: asr?.model ?? "未探测到",
      ready: asr?.ready === true,
      ...(asr?.reason !== undefined ? { reason: asr.reason } : {}),
    },
    tts: {
      model: tts?.model ?? "未探测到",
      ready: tts?.ready === true,
      ...(tts?.reason !== undefined ? { reason: tts.reason } : {}),
    },
    endpoint: config.voice.endpoint,
    ...(health?.versions !== undefined ? { versions: health.versions } : {}),
    ...(health === null || asr?.ready !== true || tts?.ready !== true ? { hint: INSTALL_HINT } : {}),
    configPath: soulConfigLocation(settings, ctx.userId),
  };
  sendJson(res, 200, payload);
}

/**
 * 转发一次 sidecar 调用，并把失败翻译成带提示的错误
 *
 * @param voiceConfig 语音配置
 * @param path sidecar 路径
 * @param init 请求初始化
 * @returns 响应
 */
async function callSidecar(voiceConfig: SoulConfig["voice"], path: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetchWithTimeout(`${voiceConfig.endpoint}${path}`, init, INFER_TIMEOUT_MS);
    if (res.status === 401) {
      throw new ApiError(502, "语音服务拒绝了请求：token 不匹配。请重启 sidecar（它会读取最新配置里的 token）");
    }
    return res;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      `语音服务不可用（${voiceConfig.endpoint}）：${error instanceof Error ? error.message : String(error)}。${INSTALL_HINT}`
    );
  }
}

/**
 * 处理 POST /api/voice/tts
 *
 * 请求体：`{text, engine?, voice?, speed?}`；缺省项取配置值。
 * 响应：`audio/wav` 二进制（不包 JSON，避免 base64 放大 33% 体积）。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export async function handleVoiceTts(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): Promise<void> {
  const body = (await readJsonBody(req)) as { text?: unknown; engine?: unknown; voice?: unknown; speed?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) throw new ApiError(400, "待合成文本不能为空");
  if (text.length > TTS_TEXT_MAX) throw new ApiError(400, `待合成文本过长（上限 ${TTS_TEXT_MAX} 字）`);

  const { config } = readSoulConfig(ctx, settings);
  const engine =
    typeof body.engine === "string" && VOICE_ENGINES.includes(body.engine as VoiceEngine)
      ? (body.engine as VoiceEngine)
      : config.voice.engine;
  const voice = typeof body.voice === "string" && body.voice.trim().length > 0 ? body.voice.trim() : config.voice.voice;
  const speed =
    typeof body.speed === "number" && Number.isFinite(body.speed)
      ? Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, body.speed))
      : config.voice.speed;

  const upstream = await callSidecar(config.voice, "/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.voice.token}` },
    body: JSON.stringify({ text, engine, voice, speed }),
  });

  if (!upstream.ok) {
    const detail = await safeErrorText(upstream);
    throw new ApiError(upstream.status === 503 ? 503 : 502, `语音合成失败：${detail}`);
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") ?? "audio/wav",
    "Content-Length": String(audio.byteLength),
    "Cache-Control": "no-store",
  });
  res.end(audio);
}

/**
 * 处理 POST /api/voice/asr
 *
 * 请求体是**原始音频字节**（前端已在浏览器侧编码为 PCM16 WAV）。
 * 用二进制而不是 JSON+base64：60 秒音频 base64 后多 33% 体积，且前端要多一次编解码。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export async function handleVoiceAsr(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): Promise<void> {
  const audio = await readRawBody(req, ASR_BYTES_MAX);
  if (audio.byteLength === 0) throw new ApiError(400, "音频内容为空");

  const { config } = readSoulConfig(ctx, settings);
  const upstream = await callSidecar(config.voice, "/asr", {
    method: "POST",
    headers: {
      "Content-Type": req.headers["content-type"] ?? "audio/wav",
      Authorization: `Bearer ${config.voice.token}`,
    },
    body: new Uint8Array(audio),
  });

  if (!upstream.ok) {
    const detail = await safeErrorText(upstream);
    throw new ApiError(upstream.status === 503 ? 503 : 502, `语音识别失败：${detail}`);
  }
  const result = (await upstream.json()) as { text?: unknown; durationMs?: unknown; model?: unknown };
  sendJson(res, 200, {
    text: typeof result.text === "string" ? result.text : "",
    durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
    model: typeof result.model === "string" ? result.model : "",
  });
}

/**
 * 读取 sidecar 的错误正文（截断，防超长 HTML 塞进 toast）
 *
 * @param res 上游响应
 * @returns 错误描述
 */
async function safeErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * 读取原始请求体
 *
 * @param req 请求对象
 * @param limit 上限字节
 * @returns 字节缓冲
 */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.byteLength;
    if (total > limit) throw new ApiError(413, `请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
