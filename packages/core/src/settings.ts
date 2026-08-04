import { defaultsToThinkingMode } from "./common/model-capabilities";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type DeepcodingEnv = Record<string, string | undefined> & {
  MODEL?: string;
  BASE_URL?: string;
  API_KEY?: string;
  TEMPERATURE?: string;
  THINKING_ENABLED?: string;
  REASONING_EFFORT?: string;
  DEBUG_LOG_ENABLED?: string;
  TELEMETRY_ENABLED?: string;
  /** v1.1 新增：LLM_ 前缀环境变量别名（无前缀版本优先，LLM_ 前缀作为后备） */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT?: string;
  LLM_CONTEXT_WINDOW?: string;
  /** v1.1 新增：超时配置（优先级高于 LLM_TIMEOUT） */
  TIMEOUT?: string;
  /** v1.1 新增：上下文窗口配置（预留，当前无消费方） */
  CONTEXT_WINDOW?: string;
};

export type ReasoningEffort = "high" | "max";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type PermissionScope =
  | "read-in-cwd"
  | "read-out-cwd"
  | "write-in-cwd"
  | "write-out-cwd"
  | "delete-in-cwd"
  | "delete-out-cwd"
  | "query-git-log"
  | "mutate-git-log"
  | "network"
  | "mcp";

export type PermissionDefaultMode = "allowAll" | "askAll";

export type PermissionSettings = {
  allow?: PermissionScope[];
  deny?: PermissionScope[];
  ask?: PermissionScope[];
  defaultMode?: PermissionDefaultMode;
};

export type EnabledSkillsSettings = Record<string, boolean>;

export type StatusLineProviderConfig =
  | {
      type: "command";
      id?: string;
      command: string;
      cwd?: string;
      timeoutMs?: number;
      color?: string;
      newLine?: boolean;
      maxLength?: number;
    }
  | {
      type: "module";
      id?: string;
      path: string;
      timeoutMs?: number;
      color?: string;
      newLine?: boolean;
      maxLength?: number;
    };

export type StatusLineSettings = {
  enabled?: boolean;
  refreshMs?: number;
  separator?: string;
  providers?: StatusLineProviderConfig[];
};

export type ResolvedStatusLineSettings = {
  enabled: boolean;
  refreshMs: number;
  separator: string;
  providers: StatusLineProviderConfig[];
};

export type DeepcodingSettings = {
  env?: DeepcodingEnv;
  model?: string;
  /** LLM provider 显式声明（最高优先级），未设置时按 env/model 前缀推断 */
  provider?: "openai" | "anthropic";
  temperature?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  telemetryEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: PermissionSettings;
  enabledSkills?: EnabledSkillsSettings;
  statusline?: StatusLineSettings;
  /**
   * 是否放行本地/私有/元数据 baseURL（本地 Ollama/vLLM 等场景）。
   * 优先级低于环境变量 DEEPCODE_ALLOW_PRIVATE_BASE_URL。
   */
  allowPrivateBaseURL?: boolean;
  /**
   * V2 上下文记忆体系配置子树（v2.8）
   * 对应 V2_CONTEXT_MEMORY_TECH_DESIGN.md §9.4 的 V2Config，由 buildV2Config 消费。
   * 使用 Record<string, unknown> 以兼容 schema 演进，实际校验在 mergeV2Config 中进行。
   */
  v2?: Record<string, unknown>;
};

export type ResolvedDeepcodingSettings = {
  env: Record<string, string>;
  apiKey?: string;
  baseURL: string;
  model: string;
  /** 解析后的 LLM provider（路由依据） */
  provider: "openai" | "anthropic";
  /** Anthropic 专属配置（provider=anthropic 时填充） */
  anthropic?: {
    /** 启用的 beta 特性列表（来自 env.ANTHROPIC_BETA，逗号分隔） */
    betaFeatures: string[];
    /** Claude 必填的最大输出 token（默认 8192，可用 env.ANTHROPIC_MAX_TOKENS 覆盖） */
    maxTokens: number;
    /** extended thinking 预算 token（env.ANTHROPIC_THINKING_BUDGET，默认 4096） */
    thinkingBudgetTokens?: number;
  };
  temperature?: number;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  /** v1.1 新增：LLM 请求超时（秒），来自 env.TIMEOUT / env.LLM_TIMEOUT，默认 600（10 分钟） */
  timeout: number;
  /**
   * v1.2 新增：模型上下文窗口大小（token 数）
   * 来自 env.CONTEXT_WINDOW / env.LLM_CONTEXT_WINDOW，默认 131072（128K）
   * 用途：计算 compact 阈值（contextWindow * 0.8），预留 20% 给 output + tool 结果
   */
  contextWindow: number;
  debugLogEnabled: boolean;
  telemetryEnabled: boolean;
  /**
   * 是否放行本地/私有/元数据 baseURL。
   * 由 settings.json / env 合并得到，供 sanitizeBaseURL 使用。
   */
  allowPrivateBaseURL: boolean;
  notify?: string;
  webSearchTool?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissions: Required<PermissionSettings>;
  enabledSkills: EnabledSkillsSettings;
  statusline: ResolvedStatusLineSettings;
};

export type ModelConfigSelection = {
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
};

export type SettingsProcessEnv = Record<string, string | undefined>;

function resolveReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "high" || value === "max" ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "enabled", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "disabled", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseTemperature(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0 || raw > 2) {
    return undefined;
  }
  return raw;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const VALID_PERMISSION_SCOPES = new Set<PermissionScope>([
  "read-in-cwd",
  "read-out-cwd",
  "write-in-cwd",
  "write-out-cwd",
  "delete-in-cwd",
  "delete-out-cwd",
  "query-git-log",
  "mutate-git-log",
  "network",
  "mcp",
]);

function normalizePermissionList(value: unknown): PermissionScope[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: PermissionScope[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !VALID_PERMISSION_SCOPES.has(item as PermissionScope)) {
      continue;
    }
    const scope = item as PermissionScope;
    if (!result.includes(scope)) {
      result.push(scope);
    }
  }
  return result;
}

function mergePermissionLists(...lists: Array<PermissionScope[] | undefined>): PermissionScope[] {
  const result: PermissionScope[] = [];
  for (const list of lists) {
    for (const scope of list ?? []) {
      if (!result.includes(scope)) {
        result.push(scope);
      }
    }
  }
  return result;
}

function normalizePermissionDefaultMode(value: unknown): PermissionDefaultMode | undefined {
  return value === "allowAll" || value === "askAll" ? value : undefined;
}

function normalizePermissions(settings: PermissionSettings | null | undefined): Required<PermissionSettings> {
  return {
    allow: normalizePermissionList(settings?.allow),
    deny: normalizePermissionList(settings?.deny),
    ask: normalizePermissionList(settings?.ask),
    defaultMode: normalizePermissionDefaultMode(settings?.defaultMode) ?? "allowAll",
  };
}

function mergePermissions(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined
): Required<PermissionSettings> {
  const userPermissions = normalizePermissions(userSettings?.permissions);
  const projectPermissions = normalizePermissions(projectSettings?.permissions);
  return {
    allow: mergePermissionLists(userPermissions.allow, projectPermissions.allow),
    deny: mergePermissionLists(userPermissions.deny, projectPermissions.deny),
    ask: mergePermissionLists(userPermissions.ask, projectPermissions.ask),
    defaultMode: projectSettings?.permissions
      ? projectPermissions.defaultMode
      : userSettings?.permissions
        ? userPermissions.defaultMode
        : "allowAll",
  };
}

function normalizeEnabledSkills(value: unknown): EnabledSkillsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: EnabledSkillsSettings = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (!name || typeof enabled !== "boolean") {
      continue;
    }
    result[name] = enabled;
  }
  return result;
}

function mergeEnabledSkills(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined
): EnabledSkillsSettings {
  return {
    ...normalizeEnabledSkills(userSettings?.enabledSkills),
    ...normalizeEnabledSkills(projectSettings?.enabledSkills),
  };
}

const DEFAULT_STATUSLINE_REFRESH_MS = 2000;
const MIN_STATUSLINE_REFRESH_MS = 500;
const DEFAULT_STATUSLINE_SEPARATOR = " · ";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStatusLineProvider(value: unknown): StatusLineProviderConfig | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const type = value["type"];
  const idRaw = trimString(value["id"]);
  const id = idRaw || undefined;
  const timeoutRaw = value["timeoutMs"];
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : undefined;
  const colorRaw = trimString(value["color"]);
  const color = colorRaw || undefined;
  const maxLengthRaw = value["maxLength"];
  const maxLength =
    typeof maxLengthRaw === "number" && Number.isFinite(maxLengthRaw) && maxLengthRaw > 0
      ? Math.floor(maxLengthRaw)
      : undefined;
  const newLine = value["newLine"] === true ? true : undefined;

  if (type === "command") {
    const command = trimString(value["command"]);
    if (!command) {
      return null;
    }
    const cwdRaw = trimString(value["cwd"]);
    return {
      type: "command",
      id,
      command,
      cwd: cwdRaw || undefined,
      timeoutMs,
      color,
      newLine,
      maxLength,
    };
  }
  if (type === "module") {
    const modulePath = trimString(value["path"]);
    if (!modulePath) {
      return null;
    }
    return {
      type: "module",
      id,
      path: modulePath,
      timeoutMs,
      color,
      newLine,
      maxLength,
    };
  }
  return null;
}

function normalizeStatusLine(value: unknown): StatusLineSettings | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const result: StatusLineSettings = {};
  const enabled = parseBoolean(value["enabled"]);
  if (enabled !== undefined) {
    result.enabled = enabled;
  }
  const refreshRaw = value["refreshMs"];
  if (typeof refreshRaw === "number" && Number.isFinite(refreshRaw) && refreshRaw >= MIN_STATUSLINE_REFRESH_MS) {
    result.refreshMs = Math.floor(refreshRaw);
  }
  const separator = value["separator"];
  if (typeof separator === "string") {
    result.separator = separator;
  }
  const providers = value["providers"];
  if (Array.isArray(providers)) {
    const normalized: StatusLineProviderConfig[] = [];
    for (const entry of providers) {
      const provider = normalizeStatusLineProvider(entry);
      if (provider) {
        normalized.push(provider);
      }
    }
    result.providers = normalized;
  }
  return result;
}

function mergeStatusLine(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined
): ResolvedStatusLineSettings {
  const userConfig = normalizeStatusLine(userSettings?.statusline) ?? {};
  const projectConfig = normalizeStatusLine(projectSettings?.statusline) ?? {};
  const userProviders = userConfig.providers ?? [];
  const projectProviders = projectConfig.providers ?? [];
  const projectIds = new Set(projectProviders.map((p) => p.id));
  const providers = [...userProviders.filter((p) => !projectIds.has(p.id)), ...projectProviders];
  const enabled = projectConfig.enabled ?? userConfig.enabled ?? providers.length > 0;
  const refreshMs = projectConfig.refreshMs ?? userConfig.refreshMs ?? DEFAULT_STATUSLINE_REFRESH_MS;
  const separator = projectConfig.separator ?? userConfig.separator ?? DEFAULT_STATUSLINE_SEPARATOR;
  return {
    enabled,
    refreshMs,
    separator,
    providers,
  };
}

function normalizeEnv(env: DeepcodingSettings["env"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!env) {
    return result;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function collectDeepcodeEnv(processEnv: SettingsProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (!key.startsWith("DEEPCODE_") || typeof value !== "string") {
      continue;
    }
    const strippedKey = key.slice("DEEPCODE_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function extractMcpEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MCP_")) {
      continue;
    }
    const strippedKey = key.slice("MCP_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function mergeMcpServers(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  userEnv: Record<string, string>,
  projectEnv: Record<string, string>,
  systemEnv: Record<string, string>
): Record<string, McpServerConfig> | undefined {
  const userServers = userSettings?.mcpServers ?? {};
  const projectServers = projectSettings?.mcpServers ?? {};
  const serverNames = new Set([...Object.keys(userServers), ...Object.keys(projectServers)]);
  if (serverNames.size === 0) {
    return undefined;
  }

  const userMcpEnv = extractMcpEnv(userEnv);
  const projectMcpEnv = extractMcpEnv(projectEnv);
  const systemMcpEnv = extractMcpEnv(systemEnv);
  const merged: Record<string, McpServerConfig> = {};

  for (const name of serverNames) {
    const userConfig = userServers[name];
    const projectConfig = projectServers[name];
    const command = projectConfig?.command ?? userConfig?.command;
    if (!command) {
      continue;
    }

    const env = {
      ...userEnv,
      ...(userConfig?.env ?? {}),
      ...userMcpEnv,
      ...projectEnv,
      ...(projectConfig?.env ?? {}),
      ...projectMcpEnv,
      ...systemEnv,
      ...systemMcpEnv,
    };
    const config: McpServerConfig = {
      command,
      args: projectConfig?.args ?? userConfig?.args,
    };
    if (Object.keys(env).length > 0) {
      config.env = env;
    }
    merged[name] = config;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveSettingsSources(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env
): ResolvedDeepcodingSettings {
  const userEnv = normalizeEnv(userSettings?.env);
  const projectEnv = normalizeEnv(projectSettings?.env);
  const systemEnv = collectDeepcodeEnv(processEnv);
  const env = {
    ...userEnv,
    ...projectEnv,
    ...systemEnv,
  };

  // v1.1 新增：LLM_ 前缀环境变量别名解析
  // 无前缀版本（BASE_URL / API_KEY / MODEL）优先，LLM_ 前缀作为后备
  // 用户可通过 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 等环境变量配置，
  // 与无前缀版本等价，降低配置心智成本
  const llmBaseUrl = trimString(env.LLM_BASE_URL);
  if (llmBaseUrl && !trimString(env.BASE_URL)) {
    env.BASE_URL = llmBaseUrl;
  }
  const llmApiKey = trimString(env.LLM_API_KEY);
  if (llmApiKey && !trimString(env.API_KEY)) {
    env.API_KEY = llmApiKey;
  }
  const llmModel = trimString(env.LLM_MODEL);
  if (llmModel && !trimString(env.MODEL)) {
    env.MODEL = llmModel;
  }

  const model =
    trimString(systemEnv.MODEL) ||
    trimString(projectSettings?.model) ||
    trimString(projectEnv.MODEL) ||
    trimString(userSettings?.model) ||
    trimString(userEnv.MODEL) ||
    // v1.1 新增：LLM_MODEL 别名回退
    // LLM_ 前缀别名解析后 env.MODEL 可能被填充（仅当无前缀 MODEL 未设置时），
    // 需要加入解析链，否则 LLM_MODEL 环境变量无法生效
    trimString(env.MODEL) ||
    defaults.model;

  const thinkingEnabled =
    parseBoolean(systemEnv.THINKING_ENABLED) ??
    parseBoolean(projectSettings?.thinkingEnabled) ??
    parseBoolean(projectEnv.THINKING_ENABLED) ??
    parseBoolean(userSettings?.thinkingEnabled) ??
    parseBoolean(userEnv.THINKING_ENABLED) ??
    defaultsToThinkingMode(model);

  const reasoningEffort =
    resolveReasoningEffort(systemEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(projectSettings?.reasoningEffort) ??
    resolveReasoningEffort(projectEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(userSettings?.reasoningEffort) ??
    resolveReasoningEffort(userEnv.REASONING_EFFORT) ??
    "max";

  const temperature =
    parseTemperature(systemEnv.TEMPERATURE) ??
    parseTemperature(projectSettings?.temperature) ??
    parseTemperature(projectEnv.TEMPERATURE) ??
    parseTemperature(userSettings?.temperature) ??
    parseTemperature(userEnv.TEMPERATURE);

  const debugLogEnabled =
    parseBoolean(systemEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(projectSettings?.debugLogEnabled) ??
    parseBoolean(projectEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(userSettings?.debugLogEnabled) ??
    parseBoolean(userEnv.DEBUG_LOG_ENABLED) ??
    // A2 改进（2026-07-27）：默认启用 debug 日志，便于追溯 LLM 工具调用历史
    // 关联事件：docs/archive/code-review-process-incident.md（原始 review 报告失实事件）
    // 用户仍可通过 DEBUG_LOG_ENABLED=false 或 settings.json 显式禁用
    true;

  const telemetryEnabled =
    parseBoolean(systemEnv.TELEMETRY_ENABLED) ??
    parseBoolean(projectSettings?.telemetryEnabled) ??
    parseBoolean(projectEnv.TELEMETRY_ENABLED) ??
    parseBoolean(userSettings?.telemetryEnabled) ??
    parseBoolean(userEnv.TELEMETRY_ENABLED) ??
    true;

  // P0 安全：允许通过 settings.json 或环境变量放行本地/私有 baseURL。
  // 进程环境变量 DEEPCODE_ALLOW_PRIVATE_BASE_URL=true 优先级最高，便于 CI/脚本覆盖；
  // 其次读取 settings.json 中的 allowPrivateBaseURL 字段。
  const allowPrivateBaseURL =
    parseBoolean(processEnv.DEEPCODE_ALLOW_PRIVATE_BASE_URL) ??
    parseBoolean(projectSettings?.allowPrivateBaseURL) ??
    parseBoolean(projectEnv.DEEPCODE_ALLOW_PRIVATE_BASE_URL) ??
    parseBoolean(userSettings?.allowPrivateBaseURL) ??
    parseBoolean(userEnv.DEEPCODE_ALLOW_PRIVATE_BASE_URL) ??
    false;

  const notify =
    trimString(systemEnv.NOTIFY) || trimString(projectSettings?.notify) || trimString(userSettings?.notify) || "";
  const webSearchTool =
    trimString(systemEnv.WEB_SEARCH_TOOL) ||
    trimString(projectSettings?.webSearchTool) ||
    trimString(userSettings?.webSearchTool) ||
    "";

  // ------------------------------------------------------------------
  // Provider 解析（优先级：settings.provider > env 变量 > model 前缀 > 默认 openai）
  // 显式声明内部冲突时 project settings 优先于 user settings（M4），
  // 与同文件 model/thinkingEnabled/temperature 等字段的合并惯例保持一致。
  // ------------------------------------------------------------------
  const explicitProvider =
    projectSettings?.provider === "anthropic" || projectSettings?.provider === "openai"
      ? projectSettings.provider
      : userSettings?.provider === "anthropic" || userSettings?.provider === "openai"
        ? userSettings.provider
        : undefined;

  const envProviderRaw = trimString(env.PROVIDER) || trimString(env.LLM_PROVIDER);
  const envProvider = envProviderRaw === "anthropic" || envProviderRaw === "openai" ? envProviderRaw : undefined;

  /** 按 model 前缀推断 provider：claude-* → anthropic，其余 → openai */
  const inferredProvider: "openai" | "anthropic" = model.startsWith("claude-") ? "anthropic" : "openai";

  const provider: "openai" | "anthropic" = explicitProvider ?? envProvider ?? inferredProvider;

  /** Anthropic 专属配置（仅 provider=anthropic 时填充，避免误导消费方） */
  const anthropic =
    provider === "anthropic"
      ? {
          betaFeatures: trimString(env.ANTHROPIC_BETA)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          maxTokens: Number(trimString(env.ANTHROPIC_MAX_TOKENS)) || 8192,
          thinkingBudgetTokens: Number(trimString(env.ANTHROPIC_THINKING_BUDGET)) || 4096,
        }
      : undefined;

  // baseURL 默认值 provider 感知（M1）：
  // - 显式 env.BASE_URL 始终优先（自建网关/代理场景）；
  // - provider=anthropic 且未显式设置时，缺省指向 Claude 官方端点
  //   （原先回退 defaults.baseURL=DeepSeek 端点，会导致 Claude 请求发往错误地址）；
  // - provider=openai 时保持 defaults.baseURL 现状（DeepSeek 默认，零回归）。
  const defaultBaseURL = provider === "anthropic" ? "https://api.anthropic.com" : defaults.baseURL;

  // v1.1 新增：timeout 解析（无前缀优先：TIMEOUT 优先于 LLM_TIMEOUT）
  // 默认 600 秒（10 分钟），与 OpenAI SDK 默认超时保持一致，确保向后兼容
  const timeout = Number(trimString(env.TIMEOUT) || trimString(env.LLM_TIMEOUT)) || 600;

  // v1.2 新增：contextWindow 解析（无前缀优先：CONTEXT_WINDOW 优先于 LLM_CONTEXT_WINDOW）
  // 默认 131072（128K），用于计算 compact 阈值，避免上下文超限
  const contextWindow = Number(trimString(env.CONTEXT_WINDOW) || trimString(env.LLM_CONTEXT_WINDOW)) || 131072;

  // P0 安全修复：对 baseURL 做 SSRF 校验，防御 file://、ftp://、私网/回环/元数据地址。
  // 默认 URL（官方端点）也过校验，形成防御纵深；本地 Ollama 等场景可通过
  // settings.json 的 allowPrivateBaseURL 或 DEEPCODE_ALLOW_PRIVATE_BASE_URL=true 显式放行。
  const rawBaseURL = trimString(env.BASE_URL) || defaultBaseURL;
  const baseURL = sanitizeBaseURL(rawBaseURL, processEnv, allowPrivateBaseURL);

  return {
    env,
    apiKey: trimString(env.API_KEY) || undefined,
    baseURL,
    model,
    provider,
    anthropic,
    temperature,
    thinkingEnabled,
    reasoningEffort,
    timeout,
    contextWindow,
    debugLogEnabled,
    telemetryEnabled,
    allowPrivateBaseURL,
    notify: notify || undefined,
    webSearchTool: webSearchTool || undefined,
    mcpServers: mergeMcpServers(userSettings, projectSettings, userEnv, projectEnv, systemEnv),
    permissions: mergePermissions(userSettings, projectSettings),
    enabledSkills: mergeEnabledSkills(userSettings, projectSettings),
    statusline: mergeStatusLine(userSettings, projectSettings),
  };
}

export function resolveSettings(
  settings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env
): ResolvedDeepcodingSettings {
  return resolveSettingsSources(settings, null, defaults, processEnv);
}

export function modelConfigKey(config: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">): string {
  return config.thinkingEnabled ? `thinking:${config.reasoningEffort}` : "thinking:none";
}

export function applyModelConfigSelection(
  settings: DeepcodingSettings | null | undefined,
  current: ModelConfigSelection,
  selected: ModelConfigSelection
): { settings: DeepcodingSettings; changed: boolean } {
  const changed = selected.model !== current.model || modelConfigKey(selected) !== modelConfigKey(current);
  const next: DeepcodingSettings = { ...(settings ?? {}) };

  if (!changed) {
    return { settings: next, changed: false };
  }

  if (selected.model !== current.model || Object.prototype.hasOwnProperty.call(next, "model")) {
    next.model = selected.model;
  } else {
    delete next.model;
  }

  next.thinkingEnabled = selected.thinkingEnabled;
  if (selected.thinkingEnabled) {
    next.reasoningEffort = selected.reasoningEffort;
  }

  return { settings: next, changed: true };
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "deepseek-v4-pro";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * 判断 IPv4 地址是否属于私有/本地/链路本地/元数据地址。
 *
 * 拦截范围（SSRF 防御）：
 * - 127.0.0.0/8 回环地址
 * - 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 私有地址
 * - 169.254.0.0/16 链路本地地址（含云厂商元数据 169.254.169.254）
 * - 100.64.0.0/10 CGNAT 地址
 * - 0.0.0.0
 *
 * @param ip 点分十进制 IPv4 地址
 * @returns 是否为需拦截的地址
 */
function isPrivateOrLocalIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const nums = parts.map((part) => parseInt(part, 10));
  if (nums.some((num) => Number.isNaN(num) || num < 0 || num > 255)) {
    return false;
  }
  const [a, b, c, d] = nums;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  // 云厂商元数据地址精确拦截
  if (a === 169 && b === 254 && c === 169 && d === 254) return true;
  return false;
}

/**
 * 判断主机名是否为 SSRF 高风险目标。
 *
 * 拦截范围：
 * - localhost / ip6-localhost / ip6-loopback
 * - IPv6 回环 ::1
 * - IPv4 私有/本地/链路本地地址
 * - 含用户信息的 URL（user:pass@host）
 *
 * @param hostname URL 主机名
 * @returns 是否应拦截
 */
function isForbiddenBaseURLHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().trim();
  if (!lower) {
    return true;
  }
  if (lower === "localhost" || lower === "ip6-localhost" || lower === "ip6-loopback") {
    return true;
  }
  if (lower === "::1" || lower === "::") {
    return true;
  }
  // IPv6 唯一本地地址（ULA）fc00::/7
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  // IPv6 链路本地地址 fe80::/10
  if (lower.startsWith("fe80:")) {
    return true;
  }
  // IPv4-mapped IPv6 回环/私有地址，如 ::ffff:127.0.0.1
  const mappedMatch = lower.match(/^\[?::ffff:([\d.]+)\]?$/);
  if (mappedMatch && isPrivateOrLocalIPv4(mappedMatch[1])) {
    return true;
  }
  if (isPrivateOrLocalIPv4(lower)) {
    return true;
  }
  return false;
}

/**
 * 校验并规范化 LLM baseURL（SSRF 防御）。
 *
 * 规则：
 * 1. 必须是合法 URL；
 * 2. 仅允许 http:// 或 https:// 协议；
 * 3. 禁止 file://、ftp:// 等非网络协议；
 * 4. 禁止 localhost、回环、私有地址、链路本地地址、云元数据地址；
 * 5. 禁止 URL 中携带用户名/密码（避免凭据泄露与意外身份）；
 * 6. 允许通过 settings.json 的 allowPrivateBaseURL 或 DEEPCODE_ALLOW_PRIVATE_BASE_URL=true
 *    显式放行私有地址（本地 Ollama/vLLM 等调试场景）。
 *
 * @param baseURL 待校验的 baseURL 字符串
 * @param processEnv 进程环境变量（用于读取放行开关，当 allowPrivate 未显式传入时）
 * @param allowPrivate 是否显式放行私有地址；未传入时回退到环境变量
 * @returns 规范化后的 baseURL 字符串
 * @throws 校验失败时抛出 Error，错误信息中不包含敏感配置值
 */
export function sanitizeBaseURL(
  baseURL: string,
  processEnv: SettingsProcessEnv = process.env,
  allowPrivate?: boolean
): string {
  const trimmed = trimString(baseURL);
  if (!trimmed) {
    throw new Error("baseURL 不能为空");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("baseURL 不是合法的 URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`baseURL 协议不被允许：仅支持 http(s)`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("baseURL 不允许携带用户名或密码");
  }

  const allowPrivateFlag =
    typeof allowPrivate === "boolean"
      ? allowPrivate
      : trimString(processEnv.DEEPCODE_ALLOW_PRIVATE_BASE_URL) === "true";
  if (!allowPrivateFlag && isForbiddenBaseURLHost(parsed.hostname)) {
    throw new Error("baseURL 指向本地、私有或元数据地址，存在 SSRF 风险");
  }

  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Settings file I/O
// ---------------------------------------------------------------------------

export function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".deepcode", "settings.json");
}

export function getProjectSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, ".deepcode", "settings.json");
}

export function readSettingsFile(settingsPath: string): DeepcodingSettings | null {
  try {
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as DeepcodingSettings;
  } catch {
    return null;
  }
}

export function readSettings(): DeepcodingSettings | null {
  return readSettingsFile(getUserSettingsPath());
}

export function readProjectSettings(projectRoot: string = process.cwd()): DeepcodingSettings | null {
  return readSettingsFile(getProjectSettingsPath(projectRoot));
}

/**
 * 写入 settings.json 前必须从顶层 env 中脱敏的敏感键。
 *
 * 这些键代表真实凭证，不应明文持久化到磁盘；用户应改用环境变量或系统密钥链。
 * 注意：BASE_URL / LLM_BASE_URL 不属于凭证，不在这里脱敏，避免本地端点配置失效。
 */
const SENSITIVE_ENV_KEYS = new Set<string>(["API_KEY", "LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

/**
 * 返回一份 env 已被脱敏的 settings 副本，不修改原始对象。
 *
 * @param settings 待写入的 settings
 * @returns 脱敏后的副本
 */
function maskSensitiveEnv(settings: DeepcodingSettings): DeepcodingSettings {
  if (!settings.env) {
    return settings;
  }
  const maskedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === "string" && !SENSITIVE_ENV_KEYS.has(key)) {
      maskedEnv[key] = value;
    }
  }
  return {
    ...settings,
    env: maskedEnv,
  };
}

function writeSettingsFile(settingsPath: string, settings: DeepcodingSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  // P0 安全修复：写入前对 env 做密钥脱敏，避免 API_KEY 等明文落盘。
  const safeSettings = maskSensitiveEnv(settings);
  fs.writeFileSync(settingsPath, `${JSON.stringify(safeSettings, null, 2)}\n`, "utf8");
}

export function writeSettings(settings: DeepcodingSettings): void {
  const settingsPath = getUserSettingsPath();
  writeSettingsFile(settingsPath, settings);
}

export function writeProjectSettings(settings: DeepcodingSettings, projectRoot: string = process.cwd()): void {
  const settingsPath = getProjectSettingsPath(projectRoot);
  writeSettingsFile(settingsPath, settings);
}

export function writeModelConfigSelection(
  selection: ModelConfigSelection,
  current: ModelConfigSelection = resolveCurrentSettings(),
  projectRoot: string = process.cwd()
): { changed: boolean; settings: DeepcodingSettings } {
  const projectSettingsPath = getProjectSettingsPath(projectRoot);
  const shouldWriteProjectSettings = fs.existsSync(projectSettingsPath);
  const rawSettings = shouldWriteProjectSettings ? readProjectSettings(projectRoot) : readSettings();
  const result = applyModelConfigSelection(rawSettings, current, selection);
  if (result.changed) {
    if (shouldWriteProjectSettings) {
      writeProjectSettings(result.settings, projectRoot);
    } else {
      writeSettings(result.settings);
    }
  }
  return result;
}

export function resolveCurrentSettings(projectRoot: string = process.cwd()): ResolvedDeepcodingSettings {
  const userPath = path.resolve(getUserSettingsPath());
  const projectPath = path.resolve(getProjectSettingsPath(projectRoot));
  const sameFile = userPath === projectPath;
  return resolveSettingsSources(
    readSettings(),
    sameFile ? null : readProjectSettings(projectRoot),
    {
      model: DEFAULT_MODEL,
      baseURL: DEFAULT_BASE_URL,
    },
    process.env
  );
}
