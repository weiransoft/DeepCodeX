import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, resolveSettingsSources } from "../settings";

// ============================================================================
// Qwen3 配置解析单元测试
//
// 验证点（对应设计文档 §7 验收标准 4-7）：
//   1. LLM_ 前缀环境变量别名正确解析（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
//   2. 无前缀版本优先于 LLM_ 前缀（向后兼容）
//   3. LLM_TIMEOUT 解析为 timeout 字段（秒）
//   4. TIMEOUT 优先于 LLM_TIMEOUT（无前缀优先原则）
//   5. timeout 默认值 600 秒（向后兼容）
//   6. Qwen3 模型默认启用 thinking 模式（defaultsToThinkingMode 集成）
// ============================================================================

const DEFAULTS = { model: "default-model", baseURL: "https://default.example.com" };

// ============================================================================
// 本地 baseURL 放行开关
//
// 测试用 BASE_URL=http://localhost:8000/v1 模拟本地 LLM 端点（Ollama/vLLM/MLX 等），
// 需通过 DEEPCODE_ALLOW_PRIVATE_BASE_URL=true 显式放行（settings.ts P0 安全设计：
// 默认拦截私网/回环地址防 SSRF，本地端点须显式开启）。
// SSRF 阻断与放行语义已由 provider-security.test.ts 专项覆盖，
// 本文件专注别名解析，统一携带放行开关避免与安全校验耦合。
// ============================================================================
const LOCAL_LLM_ENV = {
  DEEPCODE_ALLOW_PRIVATE_BASE_URL: "true",
} as const;

test("LLM_BASE_URL 别名解析为 baseURL", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        LLM_BASE_URL: "http://47.95.252.237:8003/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.baseURL, "http://47.95.252.237:8003/v1");
});

test("LLM_API_KEY 别名解析为 apiKey", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        LLM_API_KEY: "sk-7314d75a1e774abda07aa9c797b72326",
        BASE_URL: "http://localhost:8000/v1",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.apiKey, "sk-7314d75a1e774abda07aa9c797b72326");
});

test("LLM_MODEL 别名解析为 model", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        LLM_MODEL: "Qwen/Qwen3.6-27B",
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.model, "Qwen/Qwen3.6-27B");
});

test("无前缀版本优先于 LLM_ 前缀（BASE_URL 优先于 LLM_BASE_URL）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        BASE_URL: "https://primary.example.com/v1",
        LLM_BASE_URL: "https://fallback.example.com/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.baseURL, "https://primary.example.com/v1", "BASE_URL 应优先于 LLM_BASE_URL");
});

test("无前缀版本优先于 LLM_ 前缀（API_KEY 优先于 LLM_API_KEY）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        API_KEY: "sk-primary",
        LLM_API_KEY: "sk-fallback",
        BASE_URL: "http://localhost:8000/v1",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.apiKey, "sk-primary", "API_KEY 应优先于 LLM_API_KEY");
});

test("无前缀版本优先于 LLM_ 前缀（MODEL 优先于 LLM_MODEL）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        MODEL: "primary-model",
        LLM_MODEL: "fallback-model",
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.model, "primary-model", "MODEL 应优先于 LLM_MODEL");
});

test("LLM_TIMEOUT=1200 解析为 timeout=1200（秒）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        LLM_TIMEOUT: "1200",
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.timeout, 1200, "LLM_TIMEOUT=1200 应解析为 timeout=1200 秒");
});

test("TIMEOUT 优先于 LLM_TIMEOUT（无前缀优先原则）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        TIMEOUT: "300",
        LLM_TIMEOUT: "1200",
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.timeout, 300, "TIMEOUT=300 应优先于 LLM_TIMEOUT=1200");
});

test("timeout 默认值 600 秒（未设置任何 timeout 环境变量时）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.timeout, 600, "未设置 timeout 时应默认 600 秒");
});

test("timeout 无效值回退到默认 600 秒", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        LLM_TIMEOUT: "not-a-number",
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.timeout, 600, "LLM_TIMEOUT=非数字时应回退到默认 600 秒");
});

test("Qwen3 模型默认启用 thinking 模式（defaultsToThinkingMode 集成）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        LLM_MODEL: "Qwen/Qwen3.6-27B",
        LLM_BASE_URL: "http://47.95.252.237:8003/v1",
        LLM_API_KEY: "sk-test",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.model, "Qwen/Qwen3.6-27B");
  assert.equal(resolved.thinkingEnabled, true, "Qwen3 模型应默认启用 thinking 模式");
  assert.equal(resolved.timeout, 600, "未设置 LLM_TIMEOUT 时应默认 600 秒");
});

test("用户完整参数集成测试（LLM_BASE_URL + LLM_API_KEY + LLM_MODEL + LLM_TIMEOUT）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        LLM_BASE_URL: "http://47.95.252.237:8003/v1",
        LLM_API_KEY: "sk-7314d75a1e774abda07aa9c797b72326",
        LLM_MODEL: "Qwen/Qwen3.6-27B",
        LLM_TIMEOUT: "1200",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.baseURL, "http://47.95.252.237:8003/v1");
  assert.equal(resolved.apiKey, "sk-7314d75a1e774abda07aa9c797b72326");
  assert.equal(resolved.model, "Qwen/Qwen3.6-27B");
  assert.equal(resolved.timeout, 1200);
  assert.equal(resolved.thinkingEnabled, true, "Qwen3 模型应默认启用 thinking");
  assert.equal(resolved.provider, "openai", "Qwen3 应使用 openai provider（OpenAI 兼容 API）");
});

test("LLM_CONTEXT_WINDOW 解析为 contextWindow 字段（v1.2 已实现，用于 compact 阈值计算）", () => {
  // v1.2 变更：contextWindow 字段已实现（S4 推迟的，现在有消费方：getCompactPromptTokenThreshold）
  // LLM_CONTEXT_WINDOW 环境变量解析为 contextWindow 字段，用于计算 compact 阈值
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        LLM_CONTEXT_WINDOW: "131072",
        LLM_BASE_URL: "http://localhost:8000/v1",
        LLM_API_KEY: "sk-test",
        LLM_MODEL: "Qwen/Qwen3.6-27B",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  // 确保解析成功，不抛异常
  assert.equal(resolved.model, "Qwen/Qwen3.6-27B");
  assert.equal(resolved.baseURL, "http://localhost:8000/v1");
  // v1.2：contextWindow 字段应正确解析
  assert.equal(resolved.contextWindow, 131072, "LLM_CONTEXT_WINDOW=131072 应解析为 contextWindow=131072");
});

test("contextWindow 默认值按模型推断（gpt-4 为 262144）", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
        MODEL: "gpt-4",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  // 合并上游 0.3.1 后默认值语义变更：不再硬编码 131072，改为按模型推断
  // （DeepSeek V4 系列 = 1M，其余模型 = 256K，见 getDefaultContextWindow）
  assert.equal(resolved.contextWindow, 262144, "未设置 CONTEXT_WINDOW 时 gpt-4 默认 262144（256K）");
});

test("CONTEXT_WINDOW 无前缀优先于 LLM_CONTEXT_WINDOW", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        ...LOCAL_LLM_ENV,
        CONTEXT_WINDOW: "65536",
        LLM_CONTEXT_WINDOW: "131072",
        BASE_URL: "http://localhost:8000/v1",
        API_KEY: "sk-test",
        MODEL: "gpt-4",
      },
    },
    null,
    DEFAULTS,
    {}
  );
  assert.equal(resolved.contextWindow, 65536, "CONTEXT_WINDOW 优先于 LLM_CONTEXT_WINDOW");
});

test("resolveSettings 顶层入口函数也支持 LLM_ 前缀别名", () => {
  // resolveSettings 是 resolveSettingsSources 的封装，读取 ~/.deepcode/settings.json + 项目 settings.json
  // 此测试验证封装后 LLM_ 前缀别名仍然生效
  const resolved = resolveSettings(
    {
      env: {
        LLM_BASE_URL: "http://47.95.252.237:8003/v1",
        LLM_API_KEY: "sk-test",
        LLM_MODEL: "Qwen/Qwen3.6-27B",
        LLM_TIMEOUT: "1200",
      },
    },
    DEFAULTS,
    {}
  );
  assert.equal(resolved.baseURL, "http://47.95.252.237:8003/v1");
  assert.equal(resolved.apiKey, "sk-test");
  assert.equal(resolved.model, "Qwen/Qwen3.6-27B");
  assert.equal(resolved.timeout, 1200);
});
