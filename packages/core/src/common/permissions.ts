import * as fs from "fs";
import * as path from "path";
import type { DeepcodingSettings, PermissionMode, PermissionScope, PermissionSettings } from "../settings";
// 上游 v0.3.1 新增：followUpMessages 复用统一类型（role 已扩展为 "system" | "user"）
import type { ToolExecutionFollowUpMessage } from "./tool-types";
import { isAbsoluteFilePath, normalizeFilePath } from "./state";

export type BashPermissionScope = Exclude<PermissionScope, "mcp"> | "unknown";
type PermissionPolicySettings = Required<Omit<PermissionSettings, "addWorkingDirs">> &
  Pick<PermissionSettings, "addWorkingDirs">;

export type PermissionDecision = "allow" | "deny" | "ask";

export type UserToolPermission = {
  toolCallId: string;
  permission: "allow" | "deny";
};

export type MessageToolPermission = {
  toolCallId: string;
  permission: PermissionDecision;
};

export type AskPermissionScope = PermissionScope | "unknown";

export type AskPermissionRequest = {
  toolCallId: string;
  scopes: AskPermissionScope[];
  name: string;
  command: string;
  description?: string;
};

export type PermissionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type PermissionToolExecution = {
  toolCallId: string;
  content: string;
  result: {
    ok: boolean;
    name: string;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    awaitUserResponse?: boolean;
    // 上游 v0.3.1：复用 ToolExecutionFollowUpMessage 统一类型，替代本地内联结构
    followUpMessages?: ToolExecutionFollowUpMessage[];
  };
};

export type PermissionPlan = {
  permissions: MessageToolPermission[];
  askPermissions: AskPermissionRequest[];
};

export type ComputeToolCallPermissionsOptions = {
  sessionId: string;
  projectRoot: string;
  toolCalls: unknown[];
  settings?: PermissionPolicySettings;
  forceAskScopes?: readonly PermissionScope[];
  readPermissionExemptPaths?: string[];
  resolveSnippetPath?: (sessionId: string, snippetId: string) => string | null | undefined;
};

export function parseToolCallForPermissions(toolCall: unknown): PermissionToolCall | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }
  const record = toolCall as {
    id?: unknown;
    type?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  if (typeof record.id !== "string" || !record.function || typeof record.function !== "object") {
    return null;
  }
  if (typeof record.function.name !== "string") {
    return null;
  }
  return {
    id: record.id,
    type: "function",
    function: {
      name: record.function.name,
      arguments: typeof record.function.arguments === "string" ? record.function.arguments : "",
    },
  };
}

export function buildPermissionToolExecution(
  toolCall: PermissionToolCall,
  options: {
    permissionOverrides?: UserToolPermission[];
    messagePermissions?: MessageToolPermission[];
  }
): PermissionToolExecution | null {
  const permission = resolveToolCallPermission(toolCall.id, options);
  if (permission === "allow") {
    return null;
  }
  if (permission === "deny") {
    return buildSyntheticToolExecution(
      toolCall,
      "User denied the required permission for this tool call. Do not try to bypass this decision."
    );
  }
  return buildSyntheticToolExecution(
    toolCall,
    "The user has not authorized this tool call yet. Retry only if the permission is still necessary."
  );
}

export function resolveToolCallPermission(
  toolCallId: string,
  options: {
    permissionOverrides?: UserToolPermission[];
    messagePermissions?: MessageToolPermission[];
  }
): PermissionDecision {
  const override = options.permissionOverrides?.find((item) => item.toolCallId === toolCallId);
  if (override?.permission === "allow" || override?.permission === "deny") {
    return override.permission;
  }
  const messagePermission = options.messagePermissions?.find((item) => item.toolCallId === toolCallId);
  if (
    messagePermission?.permission === "allow" ||
    messagePermission?.permission === "deny" ||
    messagePermission?.permission === "ask"
  ) {
    return messagePermission.permission;
  }
  return "allow";
}

export function buildSyntheticToolExecution(toolCall: PermissionToolCall, error: string): PermissionToolExecution {
  const result = {
    ok: false,
    name: toolCall.function.name,
    error,
  };
  return {
    toolCallId: toolCall.id,
    content: JSON.stringify(result, null, 2),
    result,
  };
}

export function computeToolCallPermissions(options: ComputeToolCallPermissionsOptions): PermissionPlan {
  const permissions: MessageToolPermission[] = [];
  const askPermissions: AskPermissionRequest[] = [];

  // bypass（完全访问）快速通道（PM-U16）：
  // 所有工具调用一律 allow，不产生 askPermissions（审批面板不触发），
  // planMode 的 forceAskScopes 强制询问同样放行（设计文档 §3.2：bypass = 用户明确放弃审批）。
  if (options.settings?.mode === "bypass") {
    for (const rawToolCall of options.toolCalls) {
      const toolCall = parseToolCallForPermissions(rawToolCall);
      if (!toolCall) {
        continue;
      }
      permissions.push({ toolCallId: toolCall.id, permission: "allow" });
    }
    return { permissions, askPermissions };
  }

  for (const rawToolCall of options.toolCalls) {
    const toolCall = parseToolCallForPermissions(rawToolCall);
    if (!toolCall) {
      continue;
    }
    const request = describeToolPermissionRequest({
      sessionId: options.sessionId,
      projectRoot: options.projectRoot,
      addWorkingDirs: options.settings?.addWorkingDirs,
      toolCall,
      readPermissionExemptPaths: options.readPermissionExemptPaths,
      resolveSnippetPath: options.resolveSnippetPath,
    });
    const evaluatedPermission = evaluatePermissionScopes(request.scopes, options.settings);
    const forcedAskScopes =
      evaluatedPermission === "deny"
        ? []
        : getAllowedForcedAskScopes(request.scopes, options.settings, options.forceAskScopes);
    const permission = forcedAskScopes.length > 0 ? "ask" : evaluatedPermission;
    permissions.push({ toolCallId: toolCall.id, permission });
    if (permission === "ask") {
      const askScopes = mergeAskScopes(
        getPermissionScopesRequiringAsk(request.scopes, options.settings),
        forcedAskScopes
      );
      askPermissions.push({
        toolCallId: toolCall.id,
        scopes: askScopes.length > 0 ? askScopes : request.scopes,
        name: request.name,
        command: request.command,
        description: request.description,
      });
    }
  }

  return { permissions, askPermissions };
}

function getAllowedForcedAskScopes(
  scopes: AskPermissionScope[],
  settings: PermissionPolicySettings | undefined,
  forceAskScopes: readonly PermissionScope[] | undefined
): PermissionScope[] {
  if (!forceAskScopes?.length) {
    return [];
  }

  return scopes.filter(
    (scope): scope is PermissionScope =>
      scope !== "unknown" && forceAskScopes.includes(scope) && evaluatePermissionScopes([scope], settings) === "allow"
  );
}

function mergeAskScopes(existing: AskPermissionScope[], forced: PermissionScope[]): AskPermissionScope[] {
  return [...existing, ...forced.filter((scope) => !existing.includes(scope))];
}

export function describeToolPermissionRequest(options: {
  sessionId: string;
  projectRoot: string;
  addWorkingDirs?: string[];
  toolCall: PermissionToolCall;
  readPermissionExemptPaths?: string[];
  resolveSnippetPath?: (sessionId: string, snippetId: string) => string | null | undefined;
}): AskPermissionRequest {
  const name = options.toolCall.function.name;
  const args = parseToolArgumentsForPermissions(options.toolCall.function.arguments);

  // 上游 v0.3.1：ReadImage 图片读取工具与 read 共用同一权限分支
  if (name === "read" || name === "Read" || name === "ReadImage") {
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    return {
      toolCallId: options.toolCall.id,
      name,
      command: formatToolPathCommand(name === "ReadImage" ? "read-image" : "read", filePath),
      scopes:
        filePath && !isPathInAnyDirectory(options.projectRoot, filePath, options.readPermissionExemptPaths)
          ? [classifyFilePermissionScope(options.projectRoot, filePath, "read", options.addWorkingDirs)]
          : [],
    };
  }

  if (name === "write" || name === "Write") {
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    return {
      toolCallId: options.toolCall.id,
      name,
      command: formatToolPathCommand("write", filePath),
      scopes: filePath
        ? [classifyFilePermissionScope(options.projectRoot, filePath, "write", options.addWorkingDirs)]
        : [],
    };
  }

  if (name === "edit" || name === "Edit") {
    const filePath = resolveEditPermissionPath(options.sessionId, args, options.resolveSnippetPath);
    return {
      toolCallId: options.toolCall.id,
      name,
      command: formatToolPathCommand("edit", filePath),
      scopes: filePath
        ? [classifyFilePermissionScope(options.projectRoot, filePath, "write", options.addWorkingDirs)]
        : ["write-out-cwd"],
    };
  }

  if (name === "bash" || name === "Bash") {
    const command = typeof args.command === "string" ? args.command : "bash";
    const description = typeof args.description === "string" ? args.description : undefined;
    return {
      toolCallId: options.toolCall.id,
      name: "bash",
      command,
      description,
      scopes: parseBashSideEffects(args.sideEffects),
    };
  }

  if (name === "WebSearch") {
    const query = typeof args.query === "string" ? args.query : "WebSearch";
    return {
      toolCallId: options.toolCall.id,
      name,
      command: query,
      scopes: ["network"],
    };
  }

  // 隐私加固（2026-09-17 审计）：UnderstandImage 已改走用户自有 LLM 多模态通道，
  // 不再访问外部插件 API，因此仅需文件读取 scope，不再申请 network scope
  if (name === "UnderstandImage") {
    const imagePath = typeof args.image_path === "string" ? args.image_path : "";
    const scopes: AskPermissionScope[] = [];
    if (imagePath && !isPathInAnyDirectory(options.projectRoot, imagePath, options.readPermissionExemptPaths)) {
      scopes.push(classifyFilePermissionScope(options.projectRoot, imagePath, "read", options.addWorkingDirs));
    }
    return {
      toolCallId: options.toolCall.id,
      name,
      command: imagePath ? `understand-image ${imagePath}` : "understand-image",
      scopes,
    };
  }

  if (name.startsWith("mcp__")) {
    return {
      toolCallId: options.toolCall.id,
      name,
      command: name,
      scopes: ["mcp"],
    };
  }

  return {
    toolCallId: options.toolCall.id,
    name,
    command: name,
    scopes: [],
  };
}

export function evaluatePermissionScopes(
  scopes: AskPermissionScope[],
  settings: PermissionPolicySettings = {
    mode: "auto",
    allow: [],
    deny: [],
    ask: [],
    defaultMode: "allowAll",
    addWorkingDirs: [],
  }
): PermissionDecision {
  // 三态权限模式顶层分流（2026-09-17 设计文档 docs/dev/permission-modes.md §3.2）：
  // - "bypass"（完全访问）：所有 scope 一律放行（含 deny/unknown），
  //   安全底线由 executor/bash-handler 的灾难命令硬拦截独立保障（不依赖本函数）；
  // - "manual"（手动审批）：未显式 allow 的 scope 一律 ask，deny 黑名单仍生效；
  // - "auto"（默认）：既有 defaultMode 评估逻辑原样执行（向后兼容，行为与三态机制引入前一致）。
  if (settings.mode === "bypass") {
    return "allow";
  }

  // P0 安全修复：只要 scopes 中包含 "unknown"（例如非法 sideEffects 被降级为 unknown），
  // 即使在 allowAll 默认策略下也返回 ask，防止 LLM 通过构造非法 sideEffects 绕过权限检查。
  // 注：bypass 模式已在上方提前放行（完全访问语义），unknown 检查仅约束 manual/auto。
  if (scopes.includes("unknown")) {
    return "ask";
  }
  if (scopes.length === 0) {
    return "allow";
  }
  const permissionScopes = scopes.filter((scope): scope is PermissionScope => scope !== "unknown");
  if (permissionScopes.some((scope) => settings.deny.includes(scope))) {
    return "deny";
  }
  // manual（手动审批）：deny 未命中且未进 allow 白名单的 scope 一律询问（对齐 Trae「始终手动运行」）
  if (settings.mode === "manual") {
    return permissionScopes.every((scope) => settings.allow.includes(scope)) ? "allow" : "ask";
  }
  if (permissionScopes.some((scope) => settings.ask.includes(scope))) {
    return "ask";
  }
  if (permissionScopes.every((scope) => settings.allow.includes(scope))) {
    return "allow";
  }
  return settings.defaultMode === "askAll" ? "ask" : "allow";
}

export function getPermissionScopesRequiringAsk(
  scopes: AskPermissionScope[],
  settings: PermissionPolicySettings = {
    mode: "auto",
    allow: [],
    deny: [],
    ask: [],
    defaultMode: "allowAll",
    addWorkingDirs: [],
  }
): AskPermissionScope[] {
  // bypass（完全访问）：无任何 scope 需要询问（PM-U15）
  if (settings.mode === "bypass") {
    return [];
  }
  const result: AskPermissionScope[] = [];
  for (const scope of scopes) {
    // P0 安全修复：unknown scope 无条件需要用户确认，与 evaluatePermissionScopes 保持一致。
    if (scope === "unknown") {
      result.push(scope);
      continue;
    }
    if (settings.deny.includes(scope)) {
      continue;
    }
    // manual（手动审批）：未进 allow 白名单的 scope 全量入列（与 evaluatePermissionScopes 对齐）
    if (settings.mode === "manual") {
      if (!settings.allow.includes(scope)) {
        result.push(scope);
      }
      continue;
    }
    if (settings.ask.includes(scope)) {
      result.push(scope);
      continue;
    }
    if (settings.allow.includes(scope)) {
      continue;
    }
    if (settings.defaultMode === "askAll") {
      result.push(scope);
    }
  }
  return result;
}

export function parseBashSideEffects(value: unknown): AskPermissionScope[] {
  const validScopes = new Set<AskPermissionScope>([
    "read-in-cwd",
    "read-in-tmp",
    "read-out-cwd",
    "write-in-cwd",
    "write-in-tmp",
    "write-out-cwd",
    "delete-in-cwd",
    "delete-out-cwd",
    "query-git-log",
    "mutate-git-log",
    "network",
    "unknown",
  ]);
  if (!Array.isArray(value)) {
    return ["unknown"];
  }
  const scopes: AskPermissionScope[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !validScopes.has(item as AskPermissionScope)) {
      return ["unknown"];
    }
    const scope = item as AskPermissionScope;
    if (!scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  if (scopes.includes("unknown")) {
    return ["unknown"];
  }
  return scopes;
}

export function parseToolArgumentsForPermissions(rawArguments: string): Record<string, unknown> {
  if (!rawArguments) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function resolveEditPermissionPath(
  sessionId: string,
  args: Record<string, unknown>,
  resolveSnippetPath?: (sessionId: string, snippetId: string) => string | null | undefined
): string {
  const filePath = typeof args.file_path === "string" ? args.file_path : "";
  if (filePath) {
    return filePath;
  }
  const snippetId = typeof args.snippet_id === "string" ? args.snippet_id : "";
  return snippetId ? (resolveSnippetPath?.(sessionId, snippetId) ?? "") : "";
}

export function formatToolPathCommand(toolName: string, filePath: string): string {
  return filePath ? `${toolName} ${filePath}` : toolName;
}

export function isPathInProject(projectRoot: string, filePath: string): boolean {
  return isPathInDirectory(projectRoot, filePath, projectRoot);
}

export function classifyFilePermissionScope(
  projectRoot: string,
  filePath: string,
  operation: "read" | "write",
  addWorkingDirs: string[] = []
): PermissionScope {
  if (isPathInProject(projectRoot, filePath) || isPathInAnyDirectory(projectRoot, filePath, addWorkingDirs)) {
    return operation === "read" ? "read-in-cwd" : "write-in-cwd";
  }
  if (isPathInAnyDirectory(projectRoot, filePath, ["/tmp", "/private/tmp"])) {
    return operation === "read" ? "read-in-tmp" : "write-in-tmp";
  }
  return operation === "read" ? "read-out-cwd" : "write-out-cwd";
}

function isPathInDirectory(projectRoot: string, filePath: string, directory: string): boolean {
  const normalized = normalizeFilePath(filePath);
  const absolutePath = isAbsoluteFilePath(normalized) ? normalized : path.resolve(projectRoot, normalized);
  const normalizedDirectory = normalizeFilePath(directory);
  const absoluteDirectory = isAbsoluteFilePath(normalizedDirectory)
    ? normalizedDirectory
    : path.resolve(projectRoot, normalizedDirectory);
  const relative = path.relative(path.resolve(absoluteDirectory), path.resolve(absolutePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isPathInAnyDirectory(
  projectRoot: string,
  filePath: string,
  directories: string[] | undefined
): boolean {
  if (!directories?.length) {
    return false;
  }

  const normalized = normalizeFilePath(filePath);
  const absolutePath = isAbsoluteFilePath(normalized) ? normalized : path.resolve(projectRoot, normalized);
  for (const directory of directories) {
    if (isPathInDirectory(projectRoot, absolutePath, directory)) {
      return true;
    }
  }
  return false;
}

export function hasUserPermissionReplies(value: { permissions?: unknown; alwaysAllows?: unknown }): boolean {
  return Boolean(
    (Array.isArray(value.permissions) && value.permissions.length > 0) ||
    (Array.isArray(value.alwaysAllows) && value.alwaysAllows.length > 0)
  );
}

export function appendProjectPermissionAllows(
  projectRoot: string,
  scopes: PermissionScope[] | undefined,
  options: { inheritedPermissions?: PermissionPolicySettings } = {}
): void {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return;
  }
  const validScopes = new Set<PermissionScope>([
    "read-in-cwd",
    "read-in-tmp",
    "read-out-cwd",
    "write-in-cwd",
    "write-in-tmp",
    "write-out-cwd",
    "delete-in-cwd",
    "delete-out-cwd",
    "query-git-log",
    "mutate-git-log",
    "network",
    "mcp",
  ]);
  const nextScopes = scopes.filter((scope) => validScopes.has(scope));
  if (nextScopes.length === 0) {
    return;
  }
  const settingsPath = path.join(projectRoot, ".deepcode", "settings.json");
  let settings: DeepcodingSettings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as DeepcodingSettings;
      }
    }
  } catch {
    settings = {};
  }

  const existingPermissions = settings.permissions;
  const permissions: PermissionSettings = existingPermissions
    ? { ...existingPermissions }
    : options.inheritedPermissions
      ? {
          // 三态权限模式：回写 settings.json 时保留继承的模式（避免 always allow 回写丢失 mode 字段）
          mode: options.inheritedPermissions.mode,
          allow: [...options.inheritedPermissions.allow],
          deny: [...options.inheritedPermissions.deny],
          ask: [...options.inheritedPermissions.ask],
          defaultMode: options.inheritedPermissions.defaultMode,
          ...((options.inheritedPermissions.addWorkingDirs?.length ?? 0) > 0
            ? { addWorkingDirs: [...(options.inheritedPermissions.addWorkingDirs ?? [])] }
            : {}),
        }
      : {};

  const currentAllow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const allow = [...currentAllow];
  for (const scope of nextScopes) {
    if (!allow.includes(scope)) {
      allow.push(scope);
    }
  }
  const currentDeny = Array.isArray(permissions.deny) ? permissions.deny : undefined;
  const currentAsk = Array.isArray(permissions.ask) ? permissions.ask : undefined;
  const deny = currentDeny ? currentDeny.filter((scope) => !nextScopes.includes(scope)) : permissions.deny;
  const ask = currentAsk ? currentAsk.filter((scope) => !nextScopes.includes(scope)) : permissions.ask;
  const changed =
    allow.length !== currentAllow.length ||
    (currentDeny ? (deny as PermissionScope[]).length !== currentDeny.length : false) ||
    (currentAsk ? (ask as PermissionScope[]).length !== currentAsk.length : false);
  if (existingPermissions && !changed) {
    return;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        ...settings,
        permissions: {
          ...permissions,
          deny,
          ask,
          allow,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

export function normalizeAskPermissions(value: unknown): AskPermissionRequest[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: AskPermissionRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.toolCallId !== "string" || typeof record.name !== "string") {
      continue;
    }
    const scopes = Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is AskPermissionScope => isAskPermissionScope(scope))
      : [];
    result.push({
      toolCallId: record.toolCallId,
      scopes,
      name: record.name,
      command: typeof record.command === "string" ? record.command : record.name,
      description: typeof record.description === "string" ? record.description : undefined,
    });
  }
  return result.length > 0 ? result : undefined;
}

export function isAskPermissionScope(value: unknown): value is AskPermissionScope {
  return (
    value === "read-in-cwd" ||
    value === "read-in-tmp" ||
    value === "read-out-cwd" ||
    value === "write-in-cwd" ||
    value === "write-in-tmp" ||
    value === "write-out-cwd" ||
    value === "delete-in-cwd" ||
    value === "delete-out-cwd" ||
    value === "query-git-log" ||
    value === "mutate-git-log" ||
    value === "network" ||
    value === "mcp" ||
    value === "unknown"
  );
}
