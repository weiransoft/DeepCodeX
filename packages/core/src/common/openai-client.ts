import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveCurrentSettings } from "../settings";

// Custom undici Agent with a 180-second keepAlive timeout.  The default
// global fetch (undici) only keeps connections alive for 4 seconds, which
// is too short for a CLI where the user may spend 10–30 seconds reading
// output between prompts.  By passing a dedicated Agent to undiciFetch we
// keep connections reusable for three minutes after the last request.
const keepAliveAgent = new Agent({ keepAliveTimeout: 180_000 });

// Module-level cache for the OpenAI client instance.  The client itself is
// a stateless fetch wrapper, so it is safe to share across calls as long as
// the apiKey + baseURL stay the same.  Model, thinking-mode and other
// settings are always read fresh from the project / user config files.
let cachedOpenAI: OpenAI | null = null;
let cachedOpenAIKey = "";

export function createOpenAIClient(projectRoot: string = process.cwd()): {
  client: OpenAI | null;
  model: string;
  baseURL: string;
  temperature?: number;
  thinkingEnabled: boolean;
  reasoningEffort: "high" | "max";
  debugLogEnabled: boolean;
  telemetryEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  env: Record<string, string>;
  machineId?: string;
} {
  const settings = resolveCurrentSettings(projectRoot);
  if (!settings.apiKey) {
    return {
      client: null,
      model: settings.model,
      baseURL: settings.baseURL,
      temperature: settings.temperature,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      telemetryEnabled: settings.telemetryEnabled,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      env: settings.env,
      machineId: getMachineId(),
    };
  }

  const cacheKey = `${settings.apiKey}::${settings.baseURL}`;
  if (cachedOpenAI && cachedOpenAIKey === cacheKey) {
    return {
      client: cachedOpenAI,
      model: settings.model,
      baseURL: settings.baseURL,
      temperature: settings.temperature,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      telemetryEnabled: settings.telemetryEnabled,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      env: settings.env,
      machineId: getMachineId(),
    };
  }

  cachedOpenAI = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch: (url: any, init: any) => undiciFetch(url, { ...init, dispatcher: keepAliveAgent }),
  });
  cachedOpenAIKey = cacheKey;

  // Fire-and-forget warmup: pre-establish TCP+TLS connection to the API
  // server while the user is composing their first prompt.  Bounded by a
  // short timeout so a slow / unreachable API never blocks process exit.
  void (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      await cachedOpenAI.models.list({ signal: ac.signal }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    client: cachedOpenAI,
    model: settings.model,
    baseURL: settings.baseURL,
    temperature: settings.temperature,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    debugLogEnabled: settings.debugLogEnabled,
    telemetryEnabled: settings.telemetryEnabled,
    notify: settings.notify,
    webSearchTool: settings.webSearchTool,
    env: settings.env,
    machineId: getMachineId(),
  };
}

function getMachineId(): string | undefined {
  try {
    const idPath = path.join(os.homedir(), ".deepcode", "machine-id");
    if (fs.existsSync(idPath)) {
      const raw = fs.readFileSync(idPath, "utf8").trim();
      if (raw) {
        return raw;
      }
    }
    const generated = `${os.hostname()}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, generated, "utf8");
    return generated;
  } catch {
    return undefined;
  }
}

// ============================================================================
// v1.4 P0-2：OpenAIClientHandle 接口与类型守卫
//
// 设计目的：
//   - 为 team-adapter.ts 的 executeDispatch 提供"注入客户端"能力
//   - 单元测试通过 injectedClient 参数注入 stub client（非 mock，真实接口契约）
//   - 生产环境通过 createOpenAIClient() 创建真实 client
//
// 与 createOpenAIClient 返回类型的区别：
//   - createOpenAIClient 返回完整对象（含 reasoningEffort / debugLogEnabled 等字段）
//   - OpenAIClientHandle 只保留 LLM 调用所需的 5 个核心字段，降低耦合
//   - createOpenAIClient 返回值可安全赋值给 OpenAIClientHandle（超集 → 子集）
// ============================================================================

/**
 * OpenAI 客户端句柄接口（team-adapter.executeDispatch 注入用）
 *
 * 6 个字段：
 *   - client: OpenAI SDK 实例（unknown 类型，避免 OpenAI 类型耦合到 team 模块）
 *   - model: 模型名称（如 "qwen-plus" / "deepseek-chat"）
 *   - baseURL: API 基础 URL
 *   - temperature: 采样温度（可选）
 *   - thinkingEnabled: 是否启用思考模式（影响 system prompt 构建）
 *   - reasoningEffort: 推理强度（"high" / "max"，可选；thinkingEnabled=true 时生效）
 *
 * v1.6 P1-1 扩展：新增 reasoningEffort 字段
 *   - 之前 executeDispatch 构造 LLM 请求体时未传 reasoning_effort 参数
 *   - 通过 reasoningEffort 字段将 settings.reasoningEffort 传递给 buildThinkingRequestOptions
 *   - 与 session.ts:3476 主对话流程的 thinkingOptions 构造保持一致
 */
export interface OpenAIClientHandle {
  /** OpenAI SDK 客户端实例（unknown 类型，避免类型耦合） */
  client: unknown;
  /** 模型名称 */
  model: string;
  /** API 基础 URL */
  baseURL: string;
  /** 采样温度（可选） */
  temperature?: number;
  /** 是否启用思考模式 */
  thinkingEnabled: boolean;
  /** 推理强度（可选，thinkingEnabled=true 时生效，默认 "high"） */
  reasoningEffort?: "high" | "max";
}

/**
 * 类型守卫：检查对象是否符合 OpenAIClientHandle 接口
 *
 * 严格校验 4 个必填字段：client / model / baseURL / thinkingEnabled
 * temperature / reasoningEffort 为可选字段，不强制校验。
 *
 * @param obj 待检查的对象
 * @returns 是否符合 OpenAIClientHandle 接口
 */
export function isOpenAIClientHandle(obj: unknown): obj is OpenAIClientHandle {
  if (obj === null || typeof obj !== "object") {
    return false;
  }
  const o = obj as Record<string, unknown>;
  // client 可以是任意类型（包括 null / undefined），但字段必须存在
  if (!("client" in o)) return false;
  if (typeof o.model !== "string") return false;
  if (typeof o.baseURL !== "string") return false;
  if (typeof o.thinkingEnabled !== "boolean") return false;
  // reasoningEffort 为可选字段，仅当存在时校验类型
  if (o.reasoningEffort !== undefined && o.reasoningEffort !== "high" && o.reasoningEffort !== "max") {
    return false;
  }
  return true;
}
