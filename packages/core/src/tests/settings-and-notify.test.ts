import { test } from "node:test";
import assert from "node:assert/strict";
// 上游 v0.3.1：readDeepcodePlusApiKey 测试需要 fs/os/path
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildNotifyEnv,
  formatDurationSeconds,
  launchNotifyScript,
  type NotifyContext,
  type NotifySpawn,
} from "../common/notify";
// 修复"工具调用卡死"2026-10-03：bash 超时默认值/下限常量复用
import { DEFAULT_BASH_TIMEOUT_MS, MIN_BASH_TIMEOUT_MS } from "../common/bash-timeout";
// 修复"工具调用卡死"2026-10-03：buildShellEnv 非交互环境变量注入单测
import { buildShellEnv } from "../common/shell-utils";
// 融合两侧：fork 保留 applyModelConfigSelection 等核心导入，上游新增 Files API 常量与 readDeepcodePlusApiKey
import {
  DEFAULT_AUTOCOMPACT_RATIO,
  DEFAULT_FILE_EXPIRES_AFTER_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  DEFAULT_MODEL,
  applyModelConfigSelection,
  readDeepcodePlusApiKey,
  readDeepcodePlusSettings,
  resolveSettings,
  resolveSettingsSources,
} from "../settings";

const TEST_PROCESS_ENV = {};

// 上游 v0.3.1 新增用例：DeepCode Plus API Key 读取
test("readDeepcodePlusApiKey reads only a non-empty env key", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-plus-settings-"));
  const settingsPath = path.join(tempDir, "settings.json");

  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { PLUS_API_KEY: "  sk-aaaaaaaaaaaaaaaaaaaaaaaa  " } }));
    assert.equal(readDeepcodePlusApiKey(settingsPath), "sk-aaaaaaaaaaaaaaaaaaaaaaaa");

    for (const settings of [{}, { env: {} }]) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      assert.equal(readDeepcodePlusApiKey(settingsPath), undefined);
    }

    fs.writeFileSync(settingsPath, "not json");
    assert.equal(readDeepcodePlusApiKey(settingsPath), undefined);
    assert.equal(readDeepcodePlusApiKey(path.join(tempDir, "missing.json")), undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveSettings reads top-level thinkingEnabled, notify, and webSearchTool", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v3.2",
        BASE_URL: "https://example.com/v1",
        API_KEY: "sk-test",
      },
      temperature: 0.3,
      thinkingEnabled: true,
      reasoningEffort: "high",
      debugLogEnabled: true,
      notify: "  /tmp/notify.sh  ",
      webSearchTool: "  /tmp/web-search.sh  ",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v3.2");
  assert.equal(resolved.baseURL, "https://example.com/v1");
  assert.equal(resolved.apiKey, "sk-test");
  assert.equal(resolved.temperature, 0.3);
  assert.equal(resolved.thinkingEnabled, true);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.notify, "/tmp/notify.sh");
  assert.equal(resolved.webSearchTool, "/tmp/web-search.sh");
});

// 上游 v0.3.1 新增用例组：multimodal 模式与 Files API 配置解析
test("resolveSettings defaults multimodal to default", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.multimodal, "default");
});

test("resolveSettings applies Files API defaults", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.filesApiEnabled, false);
  assert.equal(resolved.filesApiTimeoutMs, DEFAULT_FILES_API_TIMEOUT_MS);
  assert.equal(resolved.fileExpiresAfterSeconds, DEFAULT_FILE_EXPIRES_AFTER_SECONDS);
  assert.equal(resolved.fileRefreshMarginSeconds, DEFAULT_FILE_REFRESH_MARGIN_SECONDS);
  assert.equal(resolved.fileQuotaCleanupBatch, DEFAULT_FILE_QUOTA_CLEANUP_BATCH);
  assert.equal(resolved.maxRequestFilesBytes, DEFAULT_MAX_REQUEST_FILES_BYTES);
});

test("resolveSettings enables Files API only for the DeepSeek API base URL", () => {
  const deepSeek = resolveSettings(
    { filesApiEnabled: true },
    { model: "default-model", baseURL: "https://api.deepseek.com" },
    TEST_PROCESS_ENV
  );
  const custom = resolveSettings(
    { env: { BASE_URL: "https://example.com/v1" }, filesApiEnabled: true },
    { model: "default-model", baseURL: "https://api.deepseek.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(deepSeek.filesApiEnabled, true);
  assert.equal(custom.filesApiEnabled, false);
});

test("resolveSettingsSources validates Files API settings and uses project precedence", () => {
  const resolved = resolveSettingsSources(
    {
      filesApiEnabled: true,
      filesApiTimeoutMs: 120_000,
      fileExpiresAfterSeconds: 86_400,
      fileRefreshMarginSeconds: 7_200,
      fileQuotaCleanupBatch: 50,
      maxRequestFilesBytes: 10_000,
    },
    {
      filesApiEnabled: false,
      filesApiTimeoutMs: 600_001,
      fileExpiresAfterSeconds: 7_200,
      fileRefreshMarginSeconds: 7_200,
      fileQuotaCleanupBatch: 200,
      maxRequestFilesBytes: 20_000,
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.filesApiEnabled, false);
  assert.equal(resolved.filesApiTimeoutMs, 120_000);
  assert.equal(resolved.fileExpiresAfterSeconds, 7_200);
  assert.equal(resolved.fileRefreshMarginSeconds, DEFAULT_FILE_REFRESH_MARGIN_SECONDS);
  assert.equal(resolved.fileQuotaCleanupBatch, 200);
  assert.equal(resolved.maxRequestFilesBytes, 20_000);
});

test("resolveSettings reads top-level multimodal and ignores invalid values", () => {
  const on = resolveSettings(
    { multimodal: "on" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const off = resolveSettings(
    { multimodal: "off" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const invalid = resolveSettings(
    { multimodal: "sometimes" as never },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(on.multimodal, "on");
  assert.equal(off.multimodal, "off");
  assert.equal(invalid.multimodal, "default");
});

test("resolveSettings reads MULTIMODAL from env", () => {
  const resolved = resolveSettings(
    { env: { MULTIMODAL: "off" } },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.multimodal, "off");
});

test("resolveSettings gives top-level multimodal priority over env MULTIMODAL", () => {
  const resolved = resolveSettings(
    {
      multimodal: "off",
      env: { MULTIMODAL: "on" },
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.multimodal, "off");
});

test("resolveSettingsSources applies multimodal source precedence", () => {
  const resolved = resolveSettingsSources(
    {
      env: { MULTIMODAL: "on" },
      multimodal: "off",
    },
    {
      env: { MULTIMODAL: "on" },
      multimodal: "off",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DEEPCODE_MULTIMODAL: "on",
    }
  );

  assert.equal(resolved.multimodal, "on");
});

test("resolveSettings gives top-level model priority over env MODEL", () => {
  const resolved = resolveSettings(
    {
      model: "deepseek-v4-flash",
      env: {
        MODEL: "deepseek-v4-pro",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v4-flash");
});

// 上游 v0.3.1 新增用例组：contextWindow / autoCompactWindow 解析（支持 "128k"/"1m" 字符串）
test("resolveSettings derives model-specific context window defaults", () => {
  const regular = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const deepseekV4 = resolveSettings(
    { model: "deepseek-v4-flash-vision-exp" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  // v1.3 D9：默认 autoCompactWindow 比例 50% → 80%（预留 20% 给输出与工具结果）
  assert.equal(regular.contextWindow, 256 * 1024);
  assert.equal(regular.autoCompactWindow, Math.floor(256 * 1024 * 0.8));
  assert.equal(deepseekV4.contextWindow, 1024 * 1024);
  assert.equal(deepseekV4.autoCompactWindow, Math.floor(1024 * 1024 * 0.8));
});

test("resolveSettings parses numeric and K/M context window settings", () => {
  const resolved = resolveSettings(
    {
      contextWindow: " 2m ",
      autoCompactWindow: 300_000,
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 2 * 1024 * 1024);
  assert.equal(resolved.autoCompactWindow, 300_000);
});

test("resolveSettings derives auto compact window from the configured context window", () => {
  const resolved = resolveSettings(
    { contextWindow: "512K" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 512 * 1024);
  // v1.3 D9：未显式配置 autoCompactWindow 时联动为 contextWindow 的 80%
  assert.equal(resolved.autoCompactWindow, Math.floor(512 * 1024 * 0.8));
});

test("resolveSettings ignores invalid windows and caps auto compact window at context window", () => {
  const invalid = resolveSettings(
    { contextWindow: "1G", autoCompactWindow: 1.5 },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const capped = resolveSettings(
    { contextWindow: "128k", autoCompactWindow: "1M" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(invalid.contextWindow, 256 * 1024);
  assert.equal(invalid.autoCompactWindow, Math.floor(256 * 1024 * 0.8));
  assert.equal(capped.contextWindow, 128 * 1024);
  assert.equal(capped.autoCompactWindow, 128 * 1024);
});

test("resolveSettingsSources applies context window source precedence", () => {
  const resolved = resolveSettingsSources(
    { contextWindow: "256K", autoCompactWindow: "64K" },
    { contextWindow: "512K", autoCompactWindow: "128K" },
    { model: "default-model", baseURL: "https://default.example.com" },
    {
      DEEPCODE_CONTEXT_WINDOW: "1M",
      DEEPCODE_AUTO_COMPACT_WINDOW: "256k",
    }
  );

  assert.equal(resolved.contextWindow, 1024 * 1024);
  assert.equal(resolved.autoCompactWindow, 256 * 1024);
});

test("resolveSettingsSources skips invalid higher-priority context window values", () => {
  const resolved = resolveSettingsSources(
    { contextWindow: "256K" },
    { contextWindow: "512K" },
    { model: "default-model", baseURL: "https://default.example.com" },
    { DEEPCODE_CONTEXT_WINDOW: "invalid" }
  );

  assert.equal(resolved.contextWindow, 512 * 1024);
  // v1.3 D9：无显式 autoCompactWindow，联动为 contextWindow 的 80%
  assert.equal(resolved.autoCompactWindow, Math.floor(512 * 1024 * 0.8));
});

// v1.3 新增（Qwen3.8 适配 D9，对应设计文档 §5.11 W1）：Qwen3.8+ 系列默认上下文窗口 128K，
// 自动 compact 阈值联动为 contextWindow 的 80%（基于真实 usage 动态触发压缩）
test("resolveSettings defaults Qwen3.8-27B context window to 128K with 64K auto-compact", () => {
  const resolved = resolveSettings(
    {},
    {
      model: "Qwen/Qwen3.8-27B-FP8",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 128 * 1024, "Qwen3.8-27B 默认上下文窗口应为 128K");
  assert.equal(resolved.autoCompactWindow, Math.floor(128 * 1024 * 0.8), "自动 compact 阈值应联动为窗口的 80%");
});

// v1.3 新增（D9，§5.11 W2）：系列级推断（isQwen38Model），非 27B 专属硬编码
test("resolveSettings defaults qwen3.8-plus context window to 128K", () => {
  const resolved = resolveSettings(
    {},
    {
      model: "qwen3.8-plus",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 128 * 1024);
  assert.equal(resolved.autoCompactWindow, Math.floor(128 * 1024 * 0.8));
});

// v1.3 新增（D9，§5.11 W3）：回归——旧 Qwen3（<3.8）仍为 256K，DeepSeek V4 仍为 1M
test("resolveSettings keeps pre-3.8 Qwen and DeepSeek V4 context window defaults", () => {
  const qwen37 = resolveSettings(
    {},
    { model: "qwen3.7-max", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(qwen37.contextWindow, 256 * 1024, "qwen3.7-max 不受 D9 影响，仍为 256K");
  assert.equal(qwen37.autoCompactWindow, Math.floor(256 * 1024 * 0.8));

  const deepseek = resolveSettings(
    {},
    { model: "deepseek-v4-flash", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(deepseek.contextWindow, 1024 * 1024, "DeepSeek V4 默认上下文窗口仍为 1M");
  assert.equal(deepseek.autoCompactWindow, Math.floor(1024 * 1024 * 0.8));
});

// v1.3 新增（D9，§5.11 W4）：显式配置优先于模型默认值，autoCompactWindow 联动为显式窗口的 80%
test("resolveSettings explicit context window overrides Qwen3.8 model default", () => {
  const resolved = resolveSettings(
    { contextWindow: "512k" },
    {
      model: "Qwen/Qwen3.8-27B-FP8",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 512 * 1024, "显式 contextWindow 应覆盖 Qwen3.8 默认 128K");
  // v1.3 D9：无显式 autoCompactWindow，联动为 contextWindow 的 80%
  assert.equal(resolved.autoCompactWindow, Math.floor(512 * 1024 * 0.8));
});

test("resolveSettings reads TEMPERATURE, THINKING_ENABLED, REASONING_EFFORT, and DEBUG_LOG_ENABLED from env", () => {
  const resolved = resolveSettings(
    {
      env: {
        TEMPERATURE: "0.7",
        THINKING_ENABLED: "true",
        REASONING_EFFORT: "high",
        DEBUG_LOG_ENABLED: "true",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, true);
  assert.equal(resolved.temperature, 0.7);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.model, "default-model");
  assert.equal(resolved.baseURL, "https://default.example.com");
});

// 隐私加固（2026-09-17 审计）：遥测改为 opt-in，默认 false，须显式开启
test("resolveSettings defaults telemetryEnabled to false (opt-in 隐私加固)", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, false);
});

test("resolveSettings reads TELEMETRY_ENABLED=1 from env to opt in telemetry", () => {
  const resolved = resolveSettings(
    { env: { TELEMETRY_ENABLED: "1" } },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, true);
});

// fork 保留用例（A2 改进 2026-07-27）：debugLogEnabled 默认 true，可被 DEBUG_LOG_ENABLED=false 显式禁用
test("resolveSettings defaults debugLogEnabled to true (A2 改进 2026-07-27)", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.debugLogEnabled, true);
});

test("resolveSettings allows DEBUG_LOG_ENABLED=false to override default true (A2)", () => {
  const resolved = resolveSettings(
    {
      env: {
        DEBUG_LOG_ENABLED: "false",
      },
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.debugLogEnabled, false);
});

test("resolveSettings reads TELEMETRY_ENABLED from env", () => {
  const resolved = resolveSettings(
    { env: { TELEMETRY_ENABLED: "0" } },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, false);
});

test("resolveSettings gives top-level telemetryEnabled priority over env TELEMETRY_ENABLED", () => {
  const resolved = resolveSettings(
    {
      telemetryEnabled: false,
      env: { TELEMETRY_ENABLED: "true" },
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, false);
});

test("resolveSettings ignores removed legacy env.THINKING", () => {
  const resolved = resolveSettings(
    {
      env: {
        THINKING: "enabled",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {}
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettingsSources applies user, project, and DEEPCODE environment precedence", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        API_KEY: "user-key",
        MODEL: "user-env-model",
        THINKING_ENABLED: "false",
        REASONING_EFFORT: "high",
        TEMPERATURE: "0.2",
        DEBUG_LOG_ENABLED: "false",
        WEBHOOK: "user-webhook",
      },
      model: "user-top-model",
      thinkingEnabled: true,
      reasoningEffort: "max",
      temperature: 0.4,
      debugLogEnabled: true,
      telemetryEnabled: false,
    },
    {
      env: {
        API_KEY: "project-key",
        MODEL: "project-env-model",
        THINKING_ENABLED: "false",
        DEBUG_LOG_ENABLED: "false",
        TEMPERATURE: "0.6",
      },
      model: "project-top-model",
      thinkingEnabled: true,
      temperature: 0.8,
      telemetryEnabled: true,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      // 上游 v0.3.1：DEEPCODE_ 前缀进程环境变量（优先级最高）
      DEEPCODE_API_KEY: "system-key",
      DEEPCODE_MODEL: "system-model",
      DEEPCODE_THINKING_ENABLED: "false",
      DEEPCODE_REASONING_EFFORT: "high",
      DEEPCODE_TEMPERATURE: "1.2",
      DEEPCODE_DEBUG_LOG_ENABLED: "true",
      DEEPCODE_TELEMETRY_ENABLED: "false",
      DEEPCODE_WEBHOOK: "system-webhook",
    }
  );

  assert.equal(resolved.model, "system-model");
  // 合并后实现：DEEPCODE_ 前缀系统环境变量优先级最高（systemEnv 合并在 env 链最末），覆盖 project API_KEY
  assert.equal(resolved.apiKey, "system-key");
  assert.equal(resolved.thinkingEnabled, false);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.temperature, 1.2);
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.telemetryEnabled, false);
  assert.equal(resolved.env.WEBHOOK, "system-webhook");
});

test("resolveSettingsSources merges permission settings", () => {
  const resolved = resolveSettingsSources(
    {
      permissions: {
        allow: ["read-in-cwd", "network"],
        ask: ["write-out-cwd"],
        defaultMode: "askAll",
        addWorkingDirs: ["../shared", "/opt/user-project", "", 42 as never],
      },
    },
    {
      permissions: {
        allow: ["write-in-cwd", "read-in-cwd"],
        deny: ["delete-out-cwd"],
        defaultMode: "allowAll",
        addWorkingDirs: ["../shared", " /opt/project "],
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.deepEqual(resolved.permissions.allow, ["read-in-cwd", "network", "write-in-cwd"]);
  assert.deepEqual(resolved.permissions.ask, ["write-out-cwd"]);
  assert.deepEqual(resolved.permissions.deny, ["delete-out-cwd"]);
  assert.equal(resolved.permissions.defaultMode, "allowAll");
  assert.deepEqual(resolved.permissions.addWorkingDirs, ["../shared", "/opt/user-project", "/opt/project"]);
});

test("resolveSettingsSources merges enabledSkills with project precedence", () => {
  const resolved = resolveSettingsSources(
    {
      enabledSkills: {
        inherited: false,
        "project-enabled": false,
        "project-disabled": true,
        invalid: "false" as never,
      },
    },
    {
      enabledSkills: {
        "project-enabled": true,
        "project-disabled": false,
        projectOnly: true,
        ignored: null as never,
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.deepEqual(resolved.enabledSkills, {
    inherited: false,
    "project-enabled": true,
    "project-disabled": false,
    projectOnly: true,
  });
});

test("resolveSettingsSources merges MCP env with documented priority", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "user-global",
      },
      mcpServers: {
        github: {
          command: "node",
          args: ["user-server.js"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "user-local",
            USER_ONLY: "1",
          },
        },
      },
    },
    {
      env: {
        MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "project-global",
      },
      mcpServers: {
        github: {
          command: "python",
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "project-local",
            PROJECT_ONLY: "1",
          },
        },
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DEEPCODE_MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    }
  );

  assert.equal(resolved.mcpServers?.github?.command, "python");
  assert.deepEqual(resolved.mcpServers?.github?.args, ["user-server.js"]);
  assert.deepEqual(resolved.mcpServers?.github?.env, {
    MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    USER_ONLY: "1",
    PROJECT_ONLY: "1",
  });
});

test("resolveSettings defaults DeepSeek v4 models to thinking mode", () => {
  // 融合两侧：fork 用 deepseek-v4-flash，上游新增 deepseek-v4-flash-vision-exp，均在 V4 系列内
  for (const model of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const resolved = resolveSettings(
      {
        env: {
          MODEL: model,
        },
      },
      {
        model: "default-model",
        baseURL: "https://default.example.com",
      },
      TEST_PROCESS_ENV
    );

    assert.equal(resolved.thinkingEnabled, true, `模型 ${model} 应默认启用 thinking`);
  }
});

// 融合两侧：采用上游测试结构（引用 DEFAULT_MODEL 常量），但断言遵循 fork 契约（DEFAULT_MODEL = "deepseek-v4-pro"）
test("resolveSettings applies thinking defaults to the default model", () => {
  const resolved = resolveSettings(
    {},
    {
      model: DEFAULT_MODEL,
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  // fork 决策：默认模型为 deepseek-v4-pro（上游为 deepseek-flash）
  assert.equal(DEFAULT_MODEL, "deepseek-v4-pro");
  assert.equal(resolved.model, DEFAULT_MODEL);
  assert.equal(resolved.thinkingEnabled, true);
});

test("resolveSettings keeps thinking mode off by default for other models", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v3.2",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettings allows explicit thinkingEnabled to override model defaults", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: false,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, false);
});

// v1.2 变更（Qwen3.8 适配，R1）：原非法样本 "medium" 已成为合法五档之一，
// 非法样本改为真非法值 "ultra"（对应设计文档 docs/qwen38-adaptation.md §5.3 T6）
test("resolveSettings defaults invalid reasoning effort (ultra) to max", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "ultra" as never,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "max");
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.3 T1）：五档中的新档位 xhigh 可正常解析
test("resolveSettings accepts xhigh reasoning effort", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "xhigh",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "xhigh");
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.3 T2）：五档中的新档位 medium 可正常解析
test("resolveSettings accepts medium reasoning effort", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "medium",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "medium");
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.3 T3）：严格字面量、大小写敏感，
// 大写 "XHIGH" 与带空格 " high" 均为非法值，回落默认 "max"
test("resolveSettings rejects case/space variants of reasoning effort", () => {
  for (const invalid of ["XHIGH", " high"] as const) {
    const resolved = resolveSettings(
      {
        reasoningEffort: invalid as never,
      },
      {
        model: "default-model",
        baseURL: "https://default.example.com",
      },
      TEST_PROCESS_ENV
    );

    assert.equal(resolved.reasoningEffort, "max", `非法档位 ${invalid} 应回落默认 max`);
  }
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.3 T4）：新档位经系统环境变量路径穿透解析
// 注意：collectDeepcodeEnv 仅收集 DEEPCODE_ 前缀的进程环境变量（去前缀后映射为配置项）
test("resolveSettings accepts xhigh reasoning effort from system env", () => {
  const resolved = resolveSettings(
    {},
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      ...TEST_PROCESS_ENV,
      DEEPCODE_REASONING_EFFORT: "xhigh",
    }
  );

  assert.equal(resolved.reasoningEffort, "xhigh");
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.3 T5）：优先级回归——
// 系统环境变量 DEEPCODE_REASONING_EFFORT 优先级高于用户配置 reasoningEffort
test("resolveSettings keeps system env precedence for reasoning effort", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "high",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      ...TEST_PROCESS_ENV,
      DEEPCODE_REASONING_EFFORT: "low",
    }
  );

  assert.equal(resolved.reasoningEffort, "low");
});

// 上游 v0.3.1 新增用例：reasoning effort 支持 "low" 档位
test("resolveSettings accepts low reasoning effort", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "low",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "low");
});

test("resolveSettings ignores invalid temperature values", () => {
  const resolved = resolveSettings(
    {
      env: {
        TEMPERATURE: "hot",
      },
      temperature: 3,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.temperature, undefined);
});

test("applyModelConfigSelection writes model only when the effective model changes or already exists", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: false,
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: false,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.changed, true);
  assert.equal(result.settings.model, undefined);
  assert.equal(result.settings.thinkingEnabled, true);
  assert.equal(result.settings.reasoningEffort, "high");
});

test("applyModelConfigSelection persists a new selected model and thinking option", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
        BASE_URL: "https://api.deepseek.com",
        API_KEY: "sk-test",
      },
      thinkingEnabled: false,
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: false,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-flash",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.changed, true);
  assert.equal(result.settings.env?.MODEL, "deepseek-v4-pro");
  assert.equal(result.settings.model, "deepseek-flash");
  assert.equal(result.settings.thinkingEnabled, true);
  assert.equal(result.settings.reasoningEffort, "high");
});

test("applyModelConfigSelection leaves settings untouched when the effective selection is unchanged", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: true,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
    }
  );

  assert.equal(result.changed, false);
  assert.equal(result.settings.model, undefined);
});

test("formatDurationSeconds preserves sub-second precision and trims trailing zeros", () => {
  assert.equal(formatDurationSeconds(0), "0");
  assert.equal(formatDurationSeconds(1250), "1");
  assert.equal(formatDurationSeconds(4000), "4");
});

test("buildNotifyEnv injects DURATION without context", () => {
  const env = buildNotifyEnv(2750, { HOME: "/tmp/home" });
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DURATION, "2");
  assert.equal(env.STATUS, undefined);
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv injects STATUS, FAIL_REASON, BODY, and TITLE from context", () => {
  const context: NotifyContext = {
    status: "failed",
    failReason: "API key not found",
    body: "Hello, this is the last assistant message.",
    title: "Fix login bug",
  };
  const env = buildNotifyEnv(5000, { HOME: "/tmp/home" }, context);
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DURATION, "5");
  assert.equal(env.STATUS, "failed");
  assert.equal(env.FAIL_REASON, "API key not found");
  assert.equal(env.BODY, "Hello, this is the last assistant message.");
  assert.equal(env.TITLE, "Fix login bug");
});

test("buildNotifyEnv omits optional context fields when not provided", () => {
  const env = buildNotifyEnv(
    1000,
    {
      HOME: "/tmp/home",
      STATUS: "stale-status",
      FAIL_REASON: "stale-failure",
      BODY: "stale-body",
      TITLE: "stale-title",
    },
    { status: "completed" }
  );
  assert.equal(env.STATUS, "completed");
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv ignores empty strings in context", () => {
  const env = buildNotifyEnv(
    1000,
    { HOME: "/tmp/home" },
    {
      status: "",
      failReason: "",
      body: "",
      title: "",
    }
  );
  assert.equal(env.STATUS, undefined);
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv preserves special characters in body and title", () => {
  const context: NotifyContext = {
    body: 'Line 1\nLine 2\tindented "quoted"',
    title: "Fix: login & signup (urgent)",
  };
  const env = buildNotifyEnv(1000, {}, context);
  assert.equal(env.BODY, 'Line 1\nLine 2\tindented "quoted"');
  assert.equal(env.TITLE, "Fix: login & signup (urgent)");
});

test(
  "launchNotifyScript passes DURATION, context vars, and falls back to /bin/sh for non-executable scripts",
  { skip: process.platform === "win32" },
  () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { cwd?: string | URL; env?: NodeJS.ProcessEnv };
    }> = [];

    const spawnProcess: NotifySpawn = (command, args, options) => {
      calls.push({ command, args, options: { cwd: options.cwd, env: options.env } });

      return {
        once(event, listener) {
          if (event === "error" && calls.length === 1) {
            listener({ code: "EACCES" } as NodeJS.ErrnoException);
          }
          return this;
        },
        unref() {
          return undefined;
        },
      };
    };

    const context: NotifyContext = {
      status: "completed",
      body: "Task finished successfully.",
      title: "Fix login bug",
    };

    launchNotifyScript("/tmp/notify.sh", 2750, "/tmp/project", spawnProcess, { WEBHOOK: "configured" }, context);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.command, "/tmp/notify.sh");
    assert.deepEqual(calls[0]?.args, []);
    assert.equal(calls[0]?.options.cwd, "/tmp/project");
    assert.equal(calls[0]?.options.env?.DURATION, "2");
    assert.equal(calls[0]?.options.env?.WEBHOOK, "configured");
    assert.equal(calls[0]?.options.env?.STATUS, "completed");
    assert.equal(calls[0]?.options.env?.FAIL_REASON, undefined);
    assert.equal(calls[0]?.options.env?.BODY, "Task finished successfully.");
    assert.equal(calls[0]?.options.env?.TITLE, "Fix login bug");
    assert.equal(calls[1]?.command, "/bin/sh");
    assert.deepEqual(calls[1]?.args, ["/tmp/notify.sh"]);
    assert.equal(calls[1]?.options.cwd, "/tmp/project");
    assert.equal(calls[1]?.options.env?.DURATION, "2");
    assert.equal(calls[1]?.options.env?.STATUS, "completed");
    assert.equal(calls[1]?.options.env?.BODY, "Task finished successfully.");
    assert.equal(calls[1]?.options.env?.TITLE, "Fix login bug");
  }
);

test("resolveSettings applies deepseek-flash capabilities and respects explicit overrides", () => {
  const defaults = { model: "default-model", baseURL: "https://api.deepseek.com" };
  const resolved = resolveSettings({ model: "deepseek-flash" }, defaults, TEST_PROCESS_ENV);
  assert.equal(resolved.model, "deepseek-flash");
  assert.equal(resolved.thinkingEnabled, true);
  const expectedContextWindow = 1024 * 1024;
  assert.equal(resolved.contextWindow, expectedContextWindow);
  // autoCompactWindow 默认值 = contextWindow * DEFAULT_AUTOCOMPACT_RATIO（fork 0.8，upstream 0.5）
  assert.equal(resolved.autoCompactWindow, Math.floor(expectedContextWindow * DEFAULT_AUTOCOMPACT_RATIO));

  const overridden = resolveSettings(
    { model: "deepseek-flash", thinkingEnabled: false, contextWindow: "512K", autoCompactWindow: "128K" },
    defaults,
    TEST_PROCESS_ENV
  );
  assert.equal(overridden.thinkingEnabled, false);
  assert.equal(overridden.contextWindow, 512 * 1024);
  assert.equal(overridden.autoCompactWindow, 128 * 1024);
});

// ============================================================================
// 修复"工具调用卡死"2026-10-03：bash 超时（settings.bashTimeoutMs / env.BASH_TIMEOUT_MS）
// 解析链单测——默认 120s、后缀解析、优先级、下限钳制
// ============================================================================

test("resolveSettings bashTimeoutMs 默认 120s（无任何配置）", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  const resolved = resolveSettings({}, defaults, TEST_PROCESS_ENV);
  assert.equal(resolved.bashTimeoutMs, DEFAULT_BASH_TIMEOUT_MS);
  assert.equal(DEFAULT_BASH_TIMEOUT_MS, 120_000);
});

test("resolveSettings bashTimeoutMs 从 settings 字段读取（number 与带后缀字符串）", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  assert.equal(resolveSettings({ bashTimeoutMs: 300000 }, defaults, TEST_PROCESS_ENV).bashTimeoutMs, 300000);
  assert.equal(resolveSettings({ bashTimeoutMs: 90_000 }, defaults, TEST_PROCESS_ENV).bashTimeoutMs, 90_000);
});

test("resolveSettings bashTimeoutMs 从 settings.env.BASH_TIMEOUT_MS 读取并解析后缀（s/m）", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  // 用户级 settings.json 的 env 段解析（processEnv 需 DEEPCODE_ 前缀，与 TIMEOUT 等配置语义一致）
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "180s" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    180_000
  );
  assert.equal(resolveSettings({ env: { BASH_TIMEOUT_MS: "5m" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs, 300_000);
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "90000" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    90_000
  );
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "200000ms" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    200_000
  );
});

test("resolveSettings bashTimeoutMs 从 DEEPCODE_BASH_TIMEOUT_MS 进程环境变量读取", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  assert.equal(resolveSettings({}, defaults, { DEEPCODE_BASH_TIMEOUT_MS: "150s" }).bashTimeoutMs, 150_000);
});

test("resolveSettings bashTimeoutMs 非法值回落默认 120s", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  // 非法字符串、0、负数：parseTimeoutMsValue 返回 undefined → 默认
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "abc" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    DEFAULT_BASH_TIMEOUT_MS
  );
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "0" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    DEFAULT_BASH_TIMEOUT_MS
  );
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "-5s" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    DEFAULT_BASH_TIMEOUT_MS
  );
});

test("resolveSettings bashTimeoutMs 低于下限钳制到 MIN_BASH_TIMEOUT_MS（60s）", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  // 30s < MIN_BASH_TIMEOUT_MS(60s)：合法解析但被 clampBashTimeoutMs 钳到下限
  assert.equal(
    resolveSettings({ env: { BASH_TIMEOUT_MS: "30s" } }, defaults, TEST_PROCESS_ENV).bashTimeoutMs,
    MIN_BASH_TIMEOUT_MS
  );
  assert.equal(MIN_BASH_TIMEOUT_MS, 60_000);
});

test("resolveSettings bashTimeoutMs 优先级 settings 字段 > settings.env（与 timeout 解析链一致）", () => {
  const defaults = { model: "test-model", baseURL: "https://api.example.com" };
  // 顶层字段命中时忽略同级 env（与 reasoningEffort/timeout 解析链语义一致：
  // systemEnv > projectSettings > projectEnv > userSettings > userEnv）
  const resolved = resolveSettings({ bashTimeoutMs: 300_000, env: { BASH_TIMEOUT_MS: "90s" } }, defaults, {});
  assert.equal(resolved.bashTimeoutMs, 300_000);
});

// ============================================================================
// 修复"工具调用卡死"2026-10-03：buildShellEnv 非交互化环境变量注入单测
// ============================================================================

test("buildShellEnv 注入分页器禁用与非交互环境变量组", () => {
  const env = buildShellEnv("/bin/bash");
  // git/pager 类交互卡死的根治组
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.PAGER, "cat");
  assert.equal(env.GIT_EDITOR, "true");
  assert.equal(env.GIT_MERGE_AUTOEDIT, "no");
  assert.equal(env.DEBIAN_FRONTEND, "noninteractive");
  assert.equal(env.PIP_NO_INPUT, "1");
  assert.equal(env.SHELL, "/bin/bash");
});

test("buildShellEnv 非交互变量不被 extraEnv 覆盖失败（extraEnv 先合并、硬编码在后）", () => {
  // 硬编码非交互变量在 extraEnv 展开之后写入 → 用户 env 段无法意外破坏该组防线
  const env = buildShellEnv("/bin/bash", { GIT_PAGER: "less", CUSTOM_VAR: "keep-me" });
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.CUSTOM_VAR, "keep-me");
});

// 上游 v0.4.3 新增：PLUS 订阅套餐字段（subscriptionPlan）归一化解析单测
test("PLUS settings normalize subscriptionPlan and keep it separate from env", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-plus-plan-"));
  const settingsPath = path.join(tempDir, "settings.json");
  try {
    for (const value of ["default", "on", "off", "invalid", null, 1, undefined]) {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ subscriptionPlan: value, env: { PLUS_API_KEY: " sk-aaaaaaaaaaaaaaaaaaaaaaaa " } })
      );
      assert.deepEqual(readDeepcodePlusSettings(settingsPath), {
        apiKey: "sk-aaaaaaaaaaaaaaaaaaaaaaaa",
        subscriptionPlan: value === "on" || value === "off" ? value : "default",
      });
    }
    for (const value of [null, [], {}, { env: { subscriptionPlan: "on" } }]) {
      fs.writeFileSync(settingsPath, JSON.stringify(value));
      assert.equal(readDeepcodePlusSettings(settingsPath).subscriptionPlan, "default");
      assert.equal(readDeepcodePlusSettings(settingsPath).apiKey, undefined);
    }
    fs.writeFileSync(settingsPath, "invalid json");
    assert.deepEqual(readDeepcodePlusSettings(settingsPath), { subscriptionPlan: "default" });
    assert.deepEqual(readDeepcodePlusSettings(path.join(tempDir, "absent")), { subscriptionPlan: "default" });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
