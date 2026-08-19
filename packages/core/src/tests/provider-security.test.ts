/**
 * Provider / Settings P0 安全修复单元测试
 *
 * 覆盖范围：
 * - P0-1 baseURL SSRF 校验（sanitizeBaseURL + resolveSettingsSources）
 * - P0-2 OpenAILLMClient 构造器 fail-fast 校验 apiKey
 * - P0-3 writeSettingsFile / writeProjectSettings 写入前对 env 脱敏
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实的 resolveSettingsSources / OpenAIProvider / 临时文件
 * - 中文注释
 *
 * @module core/tests/provider-security
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveSettingsSources,
  sanitizeBaseURL,
  writeSettings,
  writeProjectSettings,
  getProjectSettingsPath,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
} from "../settings";
import { OpenAIProvider } from "../providers/openai-provider";
import type { ResolvedDeepcodingSettings } from "../settings";

// ============================================================================
// 1. P0-1 baseURL SSRF 校验
// ============================================================================

test("sanitizeBaseURL 默认拦截回环地址 127.0.0.1", () => {
  assert.throws(() => sanitizeBaseURL("http://127.0.0.1:8000/v1", {}), /SSRF/);
});

test("sanitizeBaseURL 默认拦截 localhost", () => {
  assert.throws(() => sanitizeBaseURL("http://localhost:11434/v1", {}), /SSRF/);
});

test("sanitizeBaseURL 默认拦截私网地址 192.168.x.x", () => {
  assert.throws(() => sanitizeBaseURL("http://192.168.1.10/v1", {}), /SSRF/);
});

test("sanitizeBaseURL 默认拦截云厂商元数据地址 169.254.169.254", () => {
  assert.throws(() => sanitizeBaseURL("http://169.254.169.254/latest/meta-data/", {}), /SSRF/);
});

test("sanitizeBaseURL 拦截 file:// 协议", () => {
  assert.throws(() => sanitizeBaseURL("file:///etc/passwd", {}), /协议不被允许/);
});

test("sanitizeBaseURL 拦截 ftp:// 协议", () => {
  assert.throws(() => sanitizeBaseURL("ftp://example.com/v1", {}), /协议不被允许/);
});

test("sanitizeBaseURL 拦截包含用户名密码的 URL", () => {
  assert.throws(() => sanitizeBaseURL("http://user:pass@example.com/v1", {}), /用户名或密码/);
});

test("sanitizeBaseURL 允许合法公网 https 端点", () => {
  const result = sanitizeBaseURL("https://api.deepseek.com/v1", {});
  assert.equal(result, "https://api.deepseek.com/v1");
});

test("sanitizeBaseURL 在 DEEPCODE_ALLOW_PRIVATE_BASE_URL=true 时放行 127.0.0.1", () => {
  const result = sanitizeBaseURL("http://127.0.0.1:8000/v1", {
    DEEPCODE_ALLOW_PRIVATE_BASE_URL: "true",
  });
  assert.equal(result, "http://127.0.0.1:8000/v1");
});

test("sanitizeBaseURL 显式 allowPrivate=true 参数可放行本地地址", () => {
  const result = sanitizeBaseURL("http://127.0.0.1:8000/v1", {}, true);
  assert.equal(result, "http://127.0.0.1:8000/v1");
});

test("sanitizeBaseURL 显式 allowPrivate=false 参数优先于环境变量放行", () => {
  assert.throws(
    () => sanitizeBaseURL("http://127.0.0.1:8000/v1", { DEEPCODE_ALLOW_PRIVATE_BASE_URL: "true" }, false),
    /SSRF/
  );
});

test("resolveSettingsSources 对 env.BASE_URL 做 SSRF 校验", () => {
  assert.throws(
    () =>
      resolveSettingsSources(
        { env: { BASE_URL: "http://127.0.0.1:8000/v1" } },
        null,
        { model: DEFAULT_MODEL, baseURL: DEFAULT_BASE_URL },
        {}
      ),
    /SSRF/
  );
});

test("resolveSettingsSources 默认官方端点可通过校验", () => {
  const resolved = resolveSettingsSources(null, null, { model: DEFAULT_MODEL, baseURL: DEFAULT_BASE_URL }, {});
  assert.equal(resolved.baseURL, "https://api.deepseek.com");
});

test("resolveSettingsSources 在 DEEPCODE_ALLOW_PRIVATE_BASE_URL=true 时使用本地 baseURL", () => {
  const resolved = resolveSettingsSources(
    { env: { BASE_URL: "http://127.0.0.1:8000/v1" } },
    null,
    { model: DEFAULT_MODEL, baseURL: DEFAULT_BASE_URL },
    { DEEPCODE_ALLOW_PRIVATE_BASE_URL: "true" }
  );
  assert.equal(resolved.baseURL, "http://127.0.0.1:8000/v1");
});

test("resolveSettingsSources 通过 settings.allowPrivateBaseURL 放行本地 baseURL", () => {
  const resolved = resolveSettingsSources(
    {
      env: { BASE_URL: "http://127.0.0.1:8000/v1" },
      allowPrivateBaseURL: true,
    },
    null,
    { model: DEFAULT_MODEL, baseURL: DEFAULT_BASE_URL },
    {}
  );
  assert.equal(resolved.baseURL, "http://127.0.0.1:8000/v1");
  assert.equal(resolved.allowPrivateBaseURL, true);
});

// ============================================================================
// 2. P0-2 OpenAI fail-fast 校验 apiKey
// ============================================================================

test("OpenAIProvider.createClient 在 apiKey 缺失时立即抛错", () => {
  const provider = new OpenAIProvider();
  const settings: ResolvedDeepcodingSettings = {
    env: {},
    apiKey: undefined,
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    provider: "openai",
    thinkingEnabled: false,
    reasoningEffort: "max",
    timeout: 600,
    contextWindow: 131072,
    debugLogEnabled: false,
    telemetryEnabled: false,
    allowPrivateBaseURL: false,
    permissions: {},
    enabledSkills: {},
    statusline: {},
  };

  assert.throws(() => provider.createClient(settings), /API_KEY/);
});

test("OpenAIProvider.createClient 在 apiKey 为空字符串时立即抛错", () => {
  const provider = new OpenAIProvider();
  const settings: ResolvedDeepcodingSettings = {
    env: { API_KEY: "" },
    apiKey: "",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    provider: "openai",
    thinkingEnabled: false,
    reasoningEffort: "max",
    timeout: 600,
    contextWindow: 131072,
    debugLogEnabled: false,
    telemetryEnabled: false,
    allowPrivateBaseURL: false,
    permissions: {},
    enabledSkills: {},
    statusline: {},
  };

  assert.throws(() => provider.createClient(settings), /API_KEY/);
});

// ============================================================================
// 3. P0-3 settings.json 密钥脱敏
// ============================================================================

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("writeProjectSettings 写入前从顶层 env 移除 API_KEY", () => {
  const projectRoot = createTempDir("deepcode-provider-security-");
  try {
    writeProjectSettings(
      {
        env: {
          API_KEY: "sk-live-secret",
          MODEL: "custom-model",
        },
      },
      projectRoot
    );

    const settingsPath = getProjectSettingsPath(projectRoot);
    const raw = fs.readFileSync(settingsPath, "utf8");
    assert.doesNotMatch(raw, /sk-live-secret/);
    assert.doesNotMatch(raw, /"API_KEY"/);
    assert.match(raw, /custom-model/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("writeProjectSettings 移除多种敏感键但保留普通键", () => {
  const projectRoot = createTempDir("deepcode-provider-security-");
  try {
    writeProjectSettings(
      {
        env: {
          API_KEY: "sk-openai",
          LLM_API_KEY: "sk-llm",
          ANTHROPIC_API_KEY: "sk-ant",
          OPENAI_API_KEY: "sk-openai-2",
          MODEL: "model-a",
          TEMPERATURE: "0.7",
        },
      },
      projectRoot
    );

    const settingsPath = getProjectSettingsPath(projectRoot);
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, string> };

    assert.equal(parsed.env?.API_KEY, undefined);
    assert.equal(parsed.env?.LLM_API_KEY, undefined);
    assert.equal(parsed.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(parsed.env?.OPENAI_API_KEY, undefined);
    assert.equal(parsed.env?.MODEL, "model-a");
    assert.equal(parsed.env?.TEMPERATURE, "0.7");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("writeSettings 不修改传入对象", () => {
  const original = {
    env: {
      API_KEY: "sk-mutable-check",
      MODEL: "model-b",
    },
  };
  const projectRoot = createTempDir("deepcode-provider-security-");
  try {
    writeProjectSettings(original, projectRoot);
    assert.equal(original.env.API_KEY, "sk-mutable-check");
    assert.equal(original.env.MODEL, "model-b");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
