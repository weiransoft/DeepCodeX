import { bindProcessAbort } from "../common/process-abort";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import type OpenAI from "openai";
import type { CreateOpenAIClient, ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_OUTPUT_CHARS = 30000;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;
const WEB_SEARCH_TOOL_ACTIVITY_PREFIX = "WebSearch:";
const DEFAULT_WEB_SEARCH_API_URL = "https://deepcode.vegamo.cn/api/plugin/web-search";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_WEB_SEARCH_MODEL = "deepseek-v4-flash";
const EMPTY_DEEPSEEK_WEB_SEARCH_OUTPUT = "No web search results were returned.";

type SearchLanguage = "en" | "zh";

type SearchDecision = {
  dominantLanguage: SearchLanguage;
  reason: string;
};

type SearchPreparation = {
  resolvedQuery: string;
  decision: SearchDecision;
  translated: boolean;
};

type LLMClientContext = {
  signal?: AbortSignal;
  client: OpenAI;
  model: string;
  baseURL?: string;
  thinkingEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  env?: Record<string, string>;
  machineId?: string;
  plusApiKey?: string;
};

export async function handleWebSearchTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  context.signal?.throwIfAborted();
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) {
    return {
      ok: false,
      name: "WebSearch",
      error: 'Missing required "query" string.',
    };
  }

  const llmContext = context.createOpenAIClient?.();
  const scriptPath = llmContext?.webSearchTool?.trim();
  if (scriptPath) {
    return executeConfiguredWebSearch(query, scriptPath, context, llmContext?.env ?? {});
  }

  if (!hasUsableClient(llmContext)) {
    return {
      ok: false,
      name: "WebSearch",
      error:
        "WebSearch default mode requires a valid LLM configuration in ~/.deepcode/settings.json or ./.deepcode/settings.json.",
    };
  }

  return executeDefaultWebSearch(query, { ...llmContext, signal: context.signal }, context);
}

function hasUsableClient(value: ReturnType<CreateOpenAIClient> | undefined): value is LLMClientContext {
  return Boolean(value?.client);
}

async function executeConfiguredWebSearch(
  query: string,
  scriptPath: string,
  context: ToolExecutionContext,
  configuredEnv: Record<string, string>
): Promise<ToolExecutionResult> {
  context.signal?.throwIfAborted();
  const execution = await runWebSearchScript(scriptPath, query, context, configuredEnv);
  context.signal?.throwIfAborted();
  const output = execution.stdout.slice(0, MAX_OUTPUT_CHARS);
  const truncated = execution.stdout.length > MAX_OUTPUT_CHARS;

  if (execution.error) {
    return {
      ok: false,
      name: "WebSearch",
      error: execution.error,
      output: output || undefined,
      metadata: {
        exitCode: execution.exitCode,
        signal: execution.signal,
        stderr: execution.stderr || undefined,
        truncated,
      },
    };
  }

  if (execution.exitCode !== 0 || execution.signal !== null) {
    return {
      ok: false,
      name: "WebSearch",
      error: buildCommandError(execution.exitCode, execution.signal),
      output: output || undefined,
      metadata: {
        exitCode: execution.exitCode,
        signal: execution.signal,
        stderr: execution.stderr || undefined,
        truncated,
      },
    };
  }

  return {
    ok: true,
    name: "WebSearch",
    output: output || undefined,
    metadata: {
      exitCode: execution.exitCode,
      signal: execution.signal,
      truncated,
      stderr: execution.stderr || undefined,
    },
  };
}

async function executeDefaultWebSearch(
  query: string,
  llmContext: LLMClientContext,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  context.signal?.throwIfAborted();
  try {
    const prepared = await prepareSearchQuery(query, llmContext);
    // 上游 v0.3.1 新增：DeepSeek 官方 baseURL 分流（Responses API web_search 工具）
    // 与 plusApiKey 透传（默认 API 请求头携带 PLUS-API-KEY）
    context.signal?.throwIfAborted();
    const output =
      llmContext.baseURL === DEEPSEEK_BASE_URL
        ? await runDeepSeekWebSearchRequest(prepared.resolvedQuery, llmContext.client, context)
        : await runDefaultWebSearchRequest(
            prepared.resolvedQuery,
            llmContext.machineId,
            llmContext.plusApiKey,
            context
          );

    return {
      ok: true,
      name: "WebSearch",
      output,
      metadata: {
        originalQuery: query,
        resolvedQuery: prepared.resolvedQuery,
        translated: prepared.translated,
        dominantLanguage: prepared.decision.dominantLanguage,
        languageReason: prepared.decision.reason,
      },
    };
  } catch (error) {
    context.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name: "WebSearch",
      error: `WebSearch default mode failed: ${message}`,
    };
  }
}

async function runWebSearchScript(
  scriptPath: string,
  query: string,
  context: ToolExecutionContext,
  configuredEnv: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; error?: string }> {
  context.signal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(scriptPath, [query], {
      cwd: context.projectRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, ...configuredEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bindProcessAbort(child, context.signal);
    const pid = child.pid;
    if (typeof pid === "number") {
      context.onProcessStart?.(pid, formatWebSearchActivityLabel(query));
    }

    let stdout = "";
    let stderr = "";
    let error: string | undefined;

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr = appendChunk(stderr, chunk);
    });

    child.on("error", (spawnError) => {
      error = spawnError.message;
    });

    child.on("close", (code, signal) => {
      if (typeof pid === "number") {
        context.onProcessExit?.(pid);
      }
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        error,
      });
    });
  });
}

async function prepareSearchQuery(query: string, llmContext: LLMClientContext): Promise<SearchPreparation> {
  const decision = await decideSearchLanguage(query, llmContext);
  const containsChinese = containsChineseChar(query);

  if (decision.dominantLanguage === "en" && containsChinese) {
    const translatedQuery = await translateQuery(query, "English", llmContext);
    if (translatedQuery) {
      return {
        resolvedQuery: translatedQuery,
        decision,
        translated: true,
      };
    }
  }

  if (decision.dominantLanguage === "zh" && !containsChinese) {
    const translatedQuery = await translateQuery(query, "Chinese", llmContext);
    if (translatedQuery) {
      return {
        resolvedQuery: translatedQuery,
        decision,
        translated: true,
      };
    }
  }

  return {
    resolvedQuery: query,
    decision,
    translated: false,
  };
}

function containsChineseChar(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

async function decideSearchLanguage(query: string, llmContext: LLMClientContext): Promise<SearchDecision> {
  const prompt = `Decide whether the topic below has more useful online material in English or Chinese.

Topic:
\`\`\`text
${query}
\`\`\`

Return strict JSON:
{"dominant_language":"en"|"zh","reason":"one short sentence"}
Do not include markdown or any extra text.`;

  const result = parseJsonResponse(await chat(llmContext, prompt));
  const dominantLanguage = result.dominant_language;

  if (dominantLanguage !== "en" && dominantLanguage !== "zh") {
    throw new Error(`Unexpected dominant language: ${String(dominantLanguage)}`);
  }

  return {
    dominantLanguage,
    reason: typeof result.reason === "string" ? result.reason : "",
  };
}

async function translateQuery(
  query: string,
  targetLanguage: "English" | "Chinese",
  llmContext: LLMClientContext
): Promise<string> {
  const prompt = `Translate the query text below into ${targetLanguage}.

Requirements:
- Preserve product names, library names, API names, versions, and abbreviations when appropriate.
- Return only the translated query, without quotes or explanation.

Query:
\`\`\`text
${query}
\`\`\``;

  return stripCodeFence(await chat(llmContext, prompt))
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

async function chat(llmContext: LLMClientContext, prompt: string): Promise<string> {
  llmContext.signal?.throwIfAborted();
  const response = await llmContext.client.chat.completions.create(
    {
      model: llmContext.model,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: llmContext.signal }
  );
  llmContext.signal?.throwIfAborted();

  const content = response.choices?.[0]?.message?.content as unknown;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return (content as Array<{ text?: string }>)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function parseJsonResponse(text: string): Record<string, unknown> {
  const cleaned = stripCodeFence(text).trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    }
    throw new Error(`Failed to parse JSON response: ${cleaned || "<empty>"}`);
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:[\w-]+)?\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/** 出站查询中命中的敏感内容统一替换为该占位符 */
export const SENSITIVE_REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * 出站搜索 query 脱敏（隐私加固 2026-09-17 审计建议 #4）。
 *
 * 搜索词由 LLM 从用户上下文生成，可能意外携带用户粘贴的密钥、令牌等敏感片段。
 * 在向默认搜索 API 发送前，按常见凭据格式做模式化脱敏：
 * 覆盖 OpenAI 风格密钥、AWS AccessKey、GitHub/Slack/Google 令牌、JWT、
 * Authorization 头片段、PEM 私钥标记与长十六进制串（疑似哈希/密钥）。
 *
 * @param query 原始搜索词
 * @returns 脱敏后的搜索词；未命中任何模式时原样返回
 */
export function redactSensitiveContent(query: string): string {
  let redacted = query;
  // PEM 私钥块：连同头尾标记整体移除（搜索词中不该出现私钥）
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    SENSITIVE_REDACTED_PLACEHOLDER
  );
  // PEM 私钥头标记（块被截断时兜底）
  redacted = redacted.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // OpenAI 风格密钥：sk- 前缀 + 8 位以上凭据字符
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // AWS AccessKey ID
  redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // GitHub 令牌：ghp_/gho_/ghs_/ghu_/ghr_ 前缀
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // Slack 令牌：xoxa/xoxb/xoxp/xoxs/xoxo/xoxr 前缀
  redacted = redacted.replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // Google API Key：AIza 前缀 + 30 位以上凭据字符（真实 key 为 35 位，放宽下限并
  // 依靠 \b 词边界收尾，避免精确位数导致带后缀文本无法命中）
  redacted = redacted.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // JWT（三段式 base64url）
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, SENSITIVE_REDACTED_PLACEHOLDER);
  // Authorization/Bearer 片段：认证头出现后，其后的内容整体视为敏感（搜索词中不该有认证头）
  redacted = redacted.replace(
    /\b(bearer|authorization)\b\s*[:=]\s*\S[\s\S]*/gi,
    (_match, keyword: string) => `${keyword}: ${SENSITIVE_REDACTED_PLACEHOLDER}`
  );
  // 长十六进制串（≥32 位，疑似哈希、密钥摘要或盐值）
  redacted = redacted.replace(/\b[0-9a-f]{32,}\b/gi, SENSITIVE_REDACTED_PLACEHOLDER);
  return redacted;
}

async function runDefaultWebSearchRequest(
  query: string,
  machineId: string | undefined,
  plusApiKey: string | undefined,
  context: ToolExecutionContext
): Promise<string> {
  if (!machineId) {
    // 隐私加固（2026-09-17 审计）：标识已改为扩展级随机 UUID，不再使用 vscode.env.machineId
    throw new Error("Missing anonymous machine id for the default WebSearch request.");
  }

  const activityId = `web-search-${randomUUID()}`;
  context.onProcessStart?.(activityId, formatWebSearchActivityLabel(query));
  try {
    const response = await fetch(DEFAULT_WEB_SEARCH_API_URL, {
      method: "POST",
      signal: context.signal,
      headers: {
        "Content-Type": "application/json",
        Token: machineId,
        // 上游 v0.3.1 新增：plusApiKey 透传（PLUS-API-KEY 请求头）
        ...(plusApiKey ? { "PLUS-API-KEY": plusApiKey } : {}),
      },
      body: JSON.stringify({ query: redactSensitiveContent(query) }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`WebSearch API request failed with status ${response.status}${body ? `: ${body}` : ""}`);
    }

    context.signal?.throwIfAborted();
    const payload = (await response.json()) as {
      success?: unknown;
      result?: unknown;
      reason?: unknown;
    };

    // 上游 v0.3.1 新增：success 语义校验；限流时回调 onPluginRateLimitExceeded
    // （由 session/CLI 层提示用户插件配额耗尽）
    context.signal?.throwIfAborted();
    if (payload.success !== true) {
      const reason =
        typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : "Unknown error";
      if (reason.includes("rate limit exceeded")) {
        context.onPluginRateLimitExceeded?.("WebSearch");
      }
      throw new Error(`WebSearch API failed: ${reason}`);
    }

    if (typeof payload.result === "string" && payload.result.trim()) {
      return payload.result.trim();
    }
  } finally {
    context.onProcessExit?.(activityId);
  }

  throw new Error("The web search response was empty.");
}

async function runDeepSeekWebSearchRequest(
  query: string,
  client: OpenAI,
  context: ToolExecutionContext
): Promise<string> {
  const activityId = `web-search-${randomUUID()}`;
  context.onProcessStart?.(activityId, formatWebSearchActivityLabel(query));
  try {
    const response = await client.responses.create(
      {
        model: DEEPSEEK_WEB_SEARCH_MODEL,
        input: query,
        tools: [{ type: "web_search" }],
        tool_choice: "required",
      },
      { signal: context.signal }
    );
    context.signal?.throwIfAborted();

    if (response.status === "failed") {
      throw new Error(`DeepSeek Responses API returned status ${response.status}.`);
    }

    const output = response.output_text.trim();
    return output || EMPTY_DEEPSEEK_WEB_SEARCH_OUTPUT;
  } finally {
    context.onProcessExit?.(activityId);
  }
}

function appendChunk(existing: string, chunk: string | Buffer): string {
  if (existing.length >= MAX_CAPTURE_CHARS) {
    return existing;
  }
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const remaining = MAX_CAPTURE_CHARS - existing.length;
  return `${existing}${text.slice(0, remaining)}`;
}

function formatWebSearchActivityLabel(query: string): string {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const maxQueryLength = 180;
  const clippedQuery =
    normalizedQuery.length > maxQueryLength ? `${normalizedQuery.slice(0, maxQueryLength - 3)}...` : normalizedQuery;
  return `${WEB_SEARCH_TOOL_ACTIVITY_PREFIX} ${clippedQuery}`;
}

function buildCommandError(exitCode: number | null, signal: string | null): string {
  if (signal) {
    return `WebSearch command terminated by signal ${signal}.`;
  }
  if (exitCode !== null) {
    return `WebSearch command failed with exit code ${exitCode}.`;
  }
  return "WebSearch command failed.";
}
