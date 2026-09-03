import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { readDeepcodePlusApiKey, resolveCurrentSettings, type ReasoningEffort } from "../settings";

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

/** 上游 v0.3.1 新增：DeepCode Plus 插件通道的固定 baseURL（PLUS_API_KEY 场景） */
export const DEEPCODE_PLUS_BASE_URL = "https://deepcode.vegamo.cn/plugin/openai";

/**
 * 上游 v0.3.1 新增：解析实际生效的 API 连接信息。
 *
 * 优先级：用户自配 apiKey（任意 baseURL）> plusApiKey（走 DeepCode Plus 通道）。
 * 这样 PLUS_API_KEY 可以作为"无自配 Key 时"的兜底凭据。
 *
 * @param settings 当前解析出的设置（apiKey / baseURL）
 * @param plusApiKey PLUS_API_KEY 环境变量读取结果
 * @returns 实际使用的 apiKey + baseURL 组合
 */
export function resolveOpenAIConnection(
  settings: { apiKey?: string; baseURL: string },
  plusApiKey?: string
): { apiKey?: string; baseURL: string } {
  if (settings.apiKey) {
    return { apiKey: settings.apiKey, baseURL: settings.baseURL };
  }
  if (plusApiKey) {
    return { apiKey: plusApiKey, baseURL: DEEPCODE_PLUS_BASE_URL };
  }
  return { apiKey: undefined, baseURL: settings.baseURL };
}

export function createOpenAIClient(projectRoot: string = process.cwd()): {
  client: OpenAI | null;
  /** 上游 v0.3.1 新增：实际生效的 apiKey（plusApiKey 兜底后可能来自 PLUS_API_KEY） */
  apiKey?: string;
  model: string;
  baseURL: string;
  temperature?: number;
  thinkingEnabled: boolean;
  // 上游 v0.3.1：reasoningEffort 采用 ReasoningEffort 类型，支持新增的 "low" 档
  reasoningEffort: ReasoningEffort;
  debugLogEnabled: boolean;
  telemetryEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  env: Record<string, string>;
  machineId?: string;
  /** 上游 v0.3.1 新增：透传 PLUS_API_KEY，供调用方区分计费通道 */
  plusApiKey?: string;
} {
  const settings = resolveCurrentSettings(projectRoot);
  const plusApiKey = readDeepcodePlusApiKey();
  const connection = resolveOpenAIConnection(settings, plusApiKey);
  if (!connection.apiKey) {
    return {
      client: null,
      apiKey: undefined,
      model: settings.model,
      baseURL: connection.baseURL,
      temperature: settings.temperature,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      telemetryEnabled: settings.telemetryEnabled,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      env: settings.env,
      machineId: getMachineId(),
      plusApiKey,
    };
  }

  // v1.1 修改：缓存 key 包含 timeout，确保 timeout 配置变更后重建客户端
  // 语义合并：连接信息改用上游的 connection（plusApiKey 兜底），并保留 fork 的 timeout 维度
  const cacheKey = `${connection.apiKey}::${connection.baseURL}::${settings.timeout}`;
  if (cachedOpenAI && cachedOpenAIKey === cacheKey) {
    return {
      client: cachedOpenAI,
      apiKey: connection.apiKey,
      model: settings.model,
      baseURL: connection.baseURL,
      temperature: settings.temperature,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      telemetryEnabled: settings.telemetryEnabled,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      env: settings.env,
      machineId: getMachineId(),
      // 上游 v0.3.1 新增：缓存命中路径同样透传 plusApiKey
      plusApiKey,
    };
  }

  cachedOpenAI = new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL || undefined,
    // v1.1 新增：注入 timeout（秒 → 毫秒），来自 env.TIMEOUT / env.LLM_TIMEOUT
    // 默认 600 秒（10 分钟），与 OpenAI SDK 默认超时一致
    timeout: settings.timeout * 1000,
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
    apiKey: connection.apiKey,
    model: settings.model,
    baseURL: connection.baseURL,
    temperature: settings.temperature,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    debugLogEnabled: settings.debugLogEnabled,
    telemetryEnabled: settings.telemetryEnabled,
    notify: settings.notify,
    webSearchTool: settings.webSearchTool,
    env: settings.env,
    machineId: getMachineId(),
    // 上游 v0.3.1 新增：透传 PLUS_API_KEY，供调用方区分计费通道
    plusApiKey,
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
 *   - reasoningEffort: 推理强度（可选；thinkingEnabled=true 时生效）
 *
 * v1.6 P1-1 扩展：新增 reasoningEffort 字段
 *   - 之前 executeDispatch 构造 LLM 请求体时未传 reasoning_effort 参数
 *   - 通过 reasoningEffort 字段将 settings.reasoningEffort 传递给 buildThinkingRequestOptions
 *   - 与 session.ts 主对话流程的 thinkingOptions 构造保持一致
 *
 * v2.1.2 扩展：新增 debugLogEnabled 可选字段
 *   - 用于 executeDispatch 等非 SessionManager 路径记录 debug.log 和 error.log
 *   - 可选字段，保持向后兼容（现有调用方无需修改）
 *   - 类型守卫 isOpenAIClientHandle 不强制校验此字段
 *
 * v0.3.1 合并扩展：reasoningEffort 类型从 "high" | "max" 放宽为 ReasoningEffort，
 *   以兼容上游新增的 "low" 档，保证 createOpenAIClient 返回值仍可整体赋给句柄。
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
  /** 推理强度（可选，thinkingEnabled=true 时生效，默认 "high"；v0.3.1 起支持 "low" 档） */
  reasoningEffort?: ReasoningEffort;
  /**
   * 是否启用调试日志（可选）
   *
   * 用于 executeDispatch 等非 SessionManager 路径：
   * - true：调用 logOpenAIChatCompletionDebug 记录请求/响应到 debug.log
   * - true：调用 logApiError 记录错误到 error.log
   * - false / undefined：不记录日志（默认，保持向后兼容）
   *
   * 字段来源：createOpenAIClient 返回值的 created.debugLogEnabled
   * 传递链：createOpenAIClient → executeAutonomousCommand/executeDispatch → callLlmOnce
   */
  debugLogEnabled?: boolean;
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
  // reasoningEffort 为可选字段，仅当存在时校验类型（v0.3.1 起支持 "low" 档）
  // v1.2 变更（Qwen3.8 适配）：放宽至五档 low/medium/high/xhigh/max（见 settings.ts ReasoningEffort）
  if (
    o.reasoningEffort !== undefined &&
    o.reasoningEffort !== "low" &&
    o.reasoningEffort !== "medium" &&
    o.reasoningEffort !== "high" &&
    o.reasoningEffort !== "xhigh" &&
    o.reasoningEffort !== "max"
  ) {
    return false;
  }
  return true;
}
