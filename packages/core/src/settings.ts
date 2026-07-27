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
    // 关联事件：docs/code-review-process-incident.md（原始 review 报告失实事件）
    // 用户仍可通过 DEBUG_LOG_ENABLED=false 或 settings.json 显式禁用
    true;

  const telemetryEnabled =
    parseBoolean(systemEnv.TELEMETRY_ENABLED) ??
    parseBoolean(projectSettings?.telemetryEnabled) ??
    parseBoolean(projectEnv.TELEMETRY_ENABLED) ??
    parseBoolean(userSettings?.telemetryEnabled) ??
    parseBoolean(userEnv.TELEMETRY_ENABLED) ??
    true;

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

  return {
    env,
    apiKey: trimString(env.API_KEY) || undefined,
    baseURL: trimString(env.BASE_URL) || defaultBaseURL,
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

function writeSettingsFile(settingsPath: string, settings: DeepcodingSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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
