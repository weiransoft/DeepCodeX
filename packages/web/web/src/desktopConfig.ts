/**
 * 桌面配置桥接层（与 desktop/src-tauri/src/config_persist.rs 对齐）。
 *
 * 经 DeepCode Desktop 壳注入的桥（window.__DEEPCODE_DESKTOP__）调用
 * `config_get` / `config_save` IPC 命令，持久化：
 * - 模型元数据（名称 / 类型 / Base URL / 默认标记）→ settings.json `models`；
 * - 明文 API Key → 本地 SQLite 密钥库（settings.json 仅存 apiKeyRef 引用名）；
 * - MCP 服务 → settings.json `mcpServers`（引擎标准配置键）；
 * - LDAP 认证（非机密字段）→ desktop.json + settings.json `web.ldap`（引擎消费）；
 *   绑定口令 → 本地 SQLite 密钥库（engine:ldapBindPassword，经 env 注入引擎）。
 *
 * 纯浏览器（无桥）访问时调用抛错——该能力仅 DeepCode Desktop 内可用。
 */

import { getDesktopBridge } from "./desktop-bridge";

/** 模型供应商类型（下拉候选；custom 允许自由输入） */
export type ModelType = "openai" | "anthropic" | "azure" | "ollama" | "gemini" | "custom";

/** 已知供应商类型候选（UI 下拉 + 自定义） */
export const MODEL_TYPE_OPTIONS: { value: ModelType; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "azure", label: "Azure OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama（本地）" },
  { value: "custom", label: "自定义 / 其它" },
];

/** 模型配置（与壳 ModelConfig 逐字段对齐，camelCase） */
export interface DesktopModel {
  /** 唯一标识（前端 crypto.randomUUID 生成） */
  id: string;
  /** 展示名称 */
  name: string;
  /**
   * 模型标识（API Model ID，如 gpt-4o / claude-3-5-sonnet）。
   * 这是真正发给 LLM 提供商的模型名；留空时回落到 name。
   */
  model?: string;
  /** 供应商类型 */
  type: ModelType | string;
  /** API Base URL（留空走供应商默认） */
  baseUrl: string;
  /**
   * 仅保存时携带明文（新增 / 修改密钥）；读取恒为 null / 缺省。
   * 留空表示"保持已保存密钥不变"。
   */
  apiKey?: string | null;
  /** 钥匙串引用名（model:<id>）；读取时回填，用于判断密钥是否已保存 */
  apiKeyRef?: string;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 是否默认模型（全局至多一个） */
  isDefault?: boolean;
  /** 创建时间（ISO） */
  createdAt?: string;
  /** 读取时：钥匙串是否已保存该模型密钥（前端展示"已保存"占位） */
  hasKey?: boolean;
  // ---------- 高级配置（桌面高级配置 2026-10-30；全部可选，留空走引擎默认） ----------
  /** 模型系列（prompt 优化预留；default=默认配置） */
  series?: string;
  /** 上下文窗口输入（Token）→ 引擎 CONTEXT_WINDOW */
  contextInputTokens?: number | null;
  /** 上下文窗口输出（Token）→ 引擎 ANTHROPIC_MAX_TOKENS */
  contextOutputTokens?: number | null;
  /** 工具调用轮数（引擎默认 40）→ DEEPCODE_MAX_TOOL_ROUNDS */
  maxToolRounds?: number | null;
  /** 支持图片输入："default"跟随模型 / "yes" / "no" */
  imageInput?: string;
  /** 思考模式："default"跟随模型 / "on" / "off" → THINKING_ENABLED */
  thinkingMode?: string;
  /** 采样温度（0~2，留空最佳配置）→ TEMPERATURE */
  temperature?: number | null;
  /** Top P（0~1，预留）→ DEEPCODE_TOP_P */
  topP?: number | null;
  /** Top K（1~100，预留）→ DEEPCODE_TOP_K */
  topK?: number | null;
}

/** MCP 服务配置（标准 MCP 契约，与壳 McpServerConfig 对齐） */
export interface DesktopMcpServer {
  /** 唯一标识 */
  id: string;
  /** 展示名称 */
  name: string;
  /** 启动命令（uvx / npx / node …） */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量（KEY=VALUE） */
  env?: Record<string, string>;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/** LDAP 认证配置（与壳 LdapConfig 逐字段对齐，camelCase；引擎消费键见 core WebLdapSettings） */
export interface DesktopLdapConfig {
  /** 是否启用 LDAP 登录（关闭时走本地用户兜底） */
  enabled: boolean;
  /** LDAP 服务器主机名/IP（启用时必填） */
  server: string;
  /** 端口（留空 → 引擎默认随 SSL 切换：636 / 389） */
  port?: number | null;
  /** 是否使用 ldaps:// */
  useSsl?: boolean;
  /** 服务账号 DN（留空 → 匿名 bind） */
  bindDn?: string;
  /**
   * 仅保存时携带明文（修改绑定口令）；读取恒为 null / 缺省。
   * 留空表示"保持已保存口令不变"。
   */
  bindPassword?: string | null;
  /** 搜索基准 DN（启用时必填） */
  baseDn: string;
  /** 用户过滤模板，支持 %s 占位（留空 → (uid=%s)） */
  userFilter?: string;
  /** 连接/搜索超时毫秒（留空 → 引擎默认 10000） */
  timeoutMs?: number | null;
  /** 展示名属性映射（留空 → displayName） */
  displayNameAttr?: string;
  /** 邮箱属性映射（留空 → mail） */
  mailAttr?: string;
  /** 读取时：密钥库是否已保存绑定口令（前端展示"已保存"占位） */
  hasBindPassword?: boolean;
}

/** 桌面配置快照（GET 返回） */
export interface DesktopConfig {
  models: DesktopModel[];
  mcpServers: DesktopMcpServer[];
  /** LDAP 认证配置（未配置过为 null） */
  ldap?: DesktopLdapConfig | null;
  /** 首次登录向导是否已完成 */
  firstLoginDone: boolean;
}

/** 保存输入（POST 同名参数 payload） */
export interface DesktopConfigSave {
  models: DesktopModel[];
  mcpServers: DesktopMcpServer[];
  /** LDAP 配置草稿（缺省 = 保持既有配置不变） */
  ldap?: DesktopLdapConfig | null;
  /** 是否标记首次登录向导完成 */
  setupCompleted: boolean;
}

/** 取桥；非桌面环境抛错 */
function requireBridge() {
  const b = getDesktopBridge();
  if (!b) {
    throw new Error("当前环境不支持桌面配置（仅 DeepCode Desktop 内可用）");
  }
  return b;
}

/** 读取桌面配置（模型密钥不回传，仅 hasKey 标记） */
export async function getDesktopConfig(): Promise<DesktopConfig> {
  return requireBridge().invoke<DesktopConfig>("config_get");
}

/** 保存桌面配置（models / mcpServers 为完整列表，缺省即清空） */
export async function saveDesktopConfig(payload: DesktopConfigSave): Promise<DesktopConfig> {
  return requireBridge().invoke<DesktopConfig>("config_save", { payload });
}
