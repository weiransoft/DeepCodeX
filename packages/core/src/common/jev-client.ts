/**
 * jev 决策客户端 —— NeoHorse-Jev-4B（System One 快思考决策模型）远程判定接入
 *
 * 设计依据：docs/dev/jev-loop-decision-20261110.md（架构师审查修订版）
 *
 * 职责边界（Simplicity First）：
 * - 本文件只做「HTTP 契约层」：请求序列化、响应解析、错误分类、超时控制；
 * - 健康状态机 / 摘要构建 / 判定问题集 / 模式切换语义在 jev-loop-decision.ts
 *   （单一 JevLoopDecision 服务，三条链路共享，架构师审查 P2-6）；
 * - keep-alive：Node 全局 fetch（undici）默认按 origin 连接池复用，
 *   实测同源连发 p50 145ms（vs 每次新建连接 226ms），无需额外 Agent 配置。
 *
 * 真机契约（2026-11-10 实测 as1.hongene-sh.com，非推测）：
 * - POST /v1/decision 与 /v1/systemone 同构（Pydantic SystemOneRequest）；
 * - 请求：{ model?, messages[], state, questions: {<key>: Choice|Score|Noul} }
 *   - Choice: { type:"choice", instructions:string, criteria:Record<选项,说明> }
 *   - Score:  { type:"score",  instructions:string, criteria:string[] }
 *   - Noul:   { type:"noul",   instructions:string, criteria:{} }（空字典）
 * - 响应 200：{ model, answers: {<key>: {type, choice|score|noul, probabilities,
 *   confidence, legend?}}, input_tokens, usage? }
 * - 错误：401 unauthorized / 400 messages must be non-empty array /
 *   422 Pydantic 校验 / 404 {"detail":"Not Found"}
 *
 * 密钥安全（用户硬性规则）：
 * - API Key 只从环境变量或构造注入读取，严禁写入仓库/日志；
 * - 未配置密钥 → enabled=false，调用方直接走 heuristic 硬兜底（行为与今天一致）。
 *
 * @module common/jev-client
 */

// ============================================================================
// 配置
// ============================================================================

/**
 * jev 决策客户端配置
 */
export interface JevClientConfig {
  /** 网关 baseURL（含 /v1 前缀，如 https://as1.hongene-sh.com/v1） */
  baseUrl: string;
  /** Bearer API Key（不落盘、不入日志） */
  apiKey: string;
  /** 模型名（网关路由名，"jev" 由网关映射到 NeoHorse-Jev-4B） */
  model: string;
  /** 单次决策超时（毫秒，默认 800：keep-alive 实测 p50 145ms，800ms 覆盖 p99+抖动） */
  timeoutMs: number;
  /** 是否启用（false 时 decide 直接返回 unavailable，不发起网络请求） */
  enabled: boolean;
}

/** 环境变量名：网关 baseURL（缺省 as1 生产网关） */
export const ENV_JEV_BASE_URL = "DEEPCODE_JEV_BASE_URL";
/** 环境变量名：API Key（未配置即禁用 jev，走硬兜底） */
export const ENV_JEV_API_KEY = "DEEPCODE_JEV_API_KEY";
/** 环境变量名：模型路由名（缺省 "jev"） */
export const ENV_JEV_MODEL = "DEEPCODE_JEV_MODEL";
/** 环境变量名：单次决策超时毫秒（缺省 800） */
export const ENV_JEV_TIMEOUT_MS = "DEEPCODE_JEV_TIMEOUT_MS";

/** 缺省网关地址（公司内 LLM 代理网关，实测契约见文件头注释） */
export const DEFAULT_JEV_BASE_URL = "https://as1.hongene-sh.com/v1";
/** 缺省模型路由名 */
export const DEFAULT_JEV_MODEL = "jev";
/** 缺省决策超时（毫秒） */
export const DEFAULT_JEV_TIMEOUT_MS = 800;

/**
 * 从环境变量加载配置。
 *
 * 语义：**未配置 DEEPCODE_JEV_API_KEY 时返回 enabled=false 的配置**（而非 null），
 * 让调用方可以统一注入实例、由 enabled 字段决定是否发请求；
 * baseUrl/model/timeout 缺省对齐真机实测值。
 *
 * @returns 配置对象（enabled=false 表示密钥缺失或显式关闭）
 */
export function loadJevClientConfigFromEnv(): JevClientConfig {
  const apiKey = process.env[ENV_JEV_API_KEY] ?? "";
  const timeoutRaw = Number(process.env[ENV_JEV_TIMEOUT_MS] ?? "");
  return {
    baseUrl: process.env[ENV_JEV_BASE_URL]?.trim() || DEFAULT_JEV_BASE_URL,
    apiKey,
    model: process.env[ENV_JEV_MODEL]?.trim() || DEFAULT_JEV_MODEL,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_JEV_TIMEOUT_MS,
    // 显式 DEEPCODE_JEV_ENABLED=0/1 优先；未设置时以「是否有密钥」决定
    enabled:
      process.env.DEEPCODE_JEV_ENABLED !== undefined ? process.env.DEEPCODE_JEV_ENABLED !== "0" : apiKey.length > 0,
  };
}

// ============================================================================
// 判定问题与答案类型（与网关 Pydantic 模型一一对应）
// ============================================================================

/**
 * 判定问题定义（三选一联合类型，字段名与网关 Pydantic 契约严格一致）
 *
 * - Choice：从 criteria 选项字典中选一项（循环继续/终止、是否空轮等）
 * - Score：按 criteria 评分档输出归一化分数（0-1，附 legend 与分布）
 * - Noul：仅指令无选项（自由判定，返回 noul 概率）
 */
export type JevQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] }
  | { readonly type: "noul"; readonly instructions: string; readonly criteria: Readonly<Record<string, never>> };

/**
 * 判定上下文消息（与 LLM 消息同构，但内容必须是**脱敏后**的摘要）
 */
export interface JevDigestMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
}

/**
 * 决策请求体（endpoint="decision" | "systemone" 同构共用）
 */
export interface JevDecisionRequest {
  /** 判定上下文（脱敏摘要，见 jev-loop-decision.ts 构建规则） */
  readonly messages: readonly JevDigestMessage[];
  /** 会话状态串（自由文本：轮次计数、最近签名变化等观测信息） */
  readonly state: string;
  /** 判定问题集（至少 1 项，网关强制非空字典） */
  readonly questions: Readonly<Record<string, JevQuestion>>;
  /** 覆盖缺省模型路由名（缺省用配置的 model） */
  readonly model?: string;
}

// ---------------------------------------------------------------------------
// 答案类型
// ---------------------------------------------------------------------------

/** Choice 答案：选中的选项 + 选项概率分布 + 置信度 */
export interface JevChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

/** Score 答案：归一化分数（0-1）+ 评分档 legend + 档位概率分布 */
export interface JevScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

/** Noul 答案：自由判定的标量概率 */
export interface JevNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** 判定答案联合类型 */
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

// ============================================================================
// 决策结果（成功/失败判别联合，错误分类四态）
// ============================================================================

/** 决策成功结果 */
export interface JevDecisionOk {
  readonly ok: true;
  /** 网关实际路由的模型名（实测为 NeoHorse-Jev-4B） */
  readonly model: string;
  /** 问题 key → 答案 */
  readonly answers: Readonly<Record<string, JevAnswer>>;
  /** 输入 token 数（观测用，jev 摘要很小） */
  readonly inputTokens: number;
  /** 本次决策耗时（毫秒，观测口径） */
  readonly latencyMs: number;
}

/** 决策失败状态四分类（方案 §4.1） */
export type JevDecisionErrorStatus =
  /** 未启用/网络不可达/连接失败 */
  | "unavailable"
  /** 超时（AbortSignal 触发） */
  | "timeout"
  /** HTTP 非 2xx（附状态码） */
  | "http-error"
  /** HTTP 2xx 但响应体不符合契约（JSON 解析失败/字段缺失/类型不符） */
  | "invalid-output";

/** 决策失败结果 */
export interface JevDecisionError {
  readonly ok: false;
  readonly status: JevDecisionErrorStatus;
  /** HTTP 状态码（仅 http-error 时有值） */
  readonly httpStatus?: number;
  /** 失败原因（已脱敏：不含请求体、不含密钥） */
  readonly reason: string;
}

/** 决策结果判别联合 */
export type JevDecisionResult = JevDecisionOk | JevDecisionError;

// ============================================================================
// 客户端
// ============================================================================

/**
 * jev 决策客户端
 *
 * 无状态（健康状态机在上层 JevLoopDecision），可安全并发调用；
 * 全局 fetch 的 undici 连接池按 origin 自动 keep-alive 复用。
 */
export class JevDecisionClient {
  private readonly config: Readonly<JevClientConfig>;

  constructor(config: JevClientConfig) {
    // 冻结配置：运行期不可变（密钥/端点不被调用方篡改）
    this.config = Object.freeze({ ...config });
  }

  /** 是否启用（false 时 decide 直接返回 unavailable） */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 配置快照（脱敏：不含 apiKey） */
  snapshot(): Omit<JevClientConfig, "apiKey"> {
    const { apiKey, ...rest } = this.config;
    // 显式引用 apiKey 以确认剥离语义（未返回给调用方）
    void apiKey;
    return rest;
  }

  /**
   * 发起一次决策请求
   *
   * @param endpoint 端点："decision"（运行时主判）| "systemone"（同构验证）
   * @param request 决策请求（messages 必须已脱敏，本层不再脱敏）
   * @returns 判别联合结果——绝不抛异常（所有失败都归类为 JevDecisionError）
   */
  async decide(endpoint: "decision" | "systemone", request: JevDecisionRequest): Promise<JevDecisionResult> {
    // 未启用：同步快速失败，不产生网络开销（调用方据此走 heuristic 兜底）
    if (!this.config.enabled) {
      return {
        ok: false,
        status: "unavailable",
        reason: "jev disabled (missing DEEPCODE_JEV_API_KEY or explicitly disabled)",
      };
    }
    // 网关前置校验语义复刻（实测 400）：messages 必须非空数组，避免一次必败的网络往返
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      return { ok: false, status: "invalid-output", reason: "messages must be non-empty array (client-side precheck)" };
    }

    const startedAt = Date.now();
    // AbortController 超时控制：fetch 与 body 读取全程可中断
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Bearer 鉴权（401 语义实测确认）
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? this.config.model,
          messages: request.messages,
          state: request.state,
          questions: request.questions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 非 2xx：读取错误体（截断防日志爆炸），reason 不回显请求内容（防泄密）
        const bodyText = await response.text().catch(() => "");
        return {
          ok: false,
          status: "http-error",
          httpStatus: response.status,
          reason: `gateway ${response.status}: ${bodyText.slice(0, 200)}`,
        };
      }

      // 2xx：严格 JSON 解析 + 契约字段校验（invalid-output 单列，供观测网关脏数据率）
      const parsed: unknown = await response.json().catch(() => undefined);
      const answers = extractAnswers(parsed);
      if (answers == null) {
        return {
          ok: false,
          status: "invalid-output",
          reason: "response missing/invalid answers field",
        };
      }
      const model =
        typeof (parsed as Record<string, unknown>).model === "string"
          ? ((parsed as Record<string, unknown>).model as string)
          : this.config.model;
      const inputTokens = readNumber((parsed as Record<string, unknown>).input_tokens) ?? 0;
      return {
        ok: true,
        model,
        answers,
        inputTokens,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      // AbortError → timeout；其余网络异常 → unavailable
      const isAbort = error instanceof Error && error.name === "AbortError";
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: isAbort ? "timeout" : "unavailable",
        reason: isAbort ? `decision timeout after ${this.config.timeoutMs}ms` : message,
      };
    } finally {
      // 无论成败都清掉定时器，防止悬挂句柄阻塞进程退出
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// 内部解析工具
// ============================================================================

/**
 * 从响应 JSON 中提取并校验 answers 字段
 *
 * 校验规则（宽松但结构可信）：
 * - answers 必须是非空对象；
 * - 每项必须有 type ∈ {choice, score, noul} 且对应必填字段类型正确；
 * - 任一项不合规即整体判 invalid-output（宁可误判失败走兜底，不可带脏数据主判）。
 *
 * @param parsed 已 JSON.parse 的响应体
 * @returns 合规 answers；不合规返回 null
 */
function extractAnswers(parsed: unknown): Record<string, JevAnswer> | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const rawAnswers = (parsed as Record<string, unknown>).answers;
  if (rawAnswers == null || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) return null;
  const entries = Object.entries(rawAnswers as Record<string, unknown>);
  if (entries.length === 0) return null;

  const answers: Record<string, JevAnswer> = {};
  for (const [key, value] of entries) {
    if (value == null || typeof value !== "object") return null;
    const answer = value as Record<string, unknown>;
    switch (answer.type) {
      case "choice": {
        if (typeof answer.choice !== "string") return null;
        const probabilities = readProbabilityMap(answer.probabilities);
        if (probabilities == null) return null;
        answers[key] = {
          type: "choice",
          choice: answer.choice,
          probabilities,
          confidence: readNumber(answer.confidence) ?? 0,
        };
        break;
      }
      case "score": {
        const score = readNumber(answer.score);
        if (score == null) return null;
        const probabilities = readProbabilityMap(answer.probabilities);
        if (probabilities == null) return null;
        const legendRaw = answer.legend;
        const legend: Record<string, string> = {};
        if (legendRaw != null && typeof legendRaw === "object" && !Array.isArray(legendRaw)) {
          for (const [k, v] of Object.entries(legendRaw as Record<string, unknown>)) {
            if (typeof v === "string") legend[k] = v;
          }
        }
        answers[key] = { type: "score", score, legend, probabilities, confidence: readNumber(answer.confidence) ?? 0 };
        break;
      }
      case "noul": {
        const noul = readNumber(answer.noul);
        if (noul == null) return null;
        const probabilities = readProbabilityMap(answer.probabilities);
        if (probabilities == null) return null;
        answers[key] = { type: "noul", noul, probabilities };
        break;
      }
      default:
        // 未知 type：整体判不合规（契约升级时显式扩展，不静默吞掉）
        return null;
    }
  }
  return answers;
}

/**
 * 读取概率分布字典（key→0-1 数值），不合规返回 null
 */
function readProbabilityMap(value: unknown): Record<string, number> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = readNumber(v);
    if (n == null) return null;
    result[k] = n;
  }
  return result;
}

/**
 * 安全读取数值字段（NaN/Infinity 视为缺失）
 */
function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
