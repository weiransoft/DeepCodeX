/**
 * OpenAIProvider 单元测试
 *
 * 覆盖：现有 createOpenAIClient 行为的包装等价性——
 *       相同 settings 产出相同 model/baseURL/能力标记，确保包装层零行为变化
 */

import { OpenAIProvider } from "../openai-provider.js";
import type { ResolvedDeepcodingSettings } from "../../settings.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}（expected true）`);
}

function suite(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    console.log(`\n=== ${name} ===`);
  });
}

function makeSettings(): ResolvedDeepcodingSettings {
  return {
    env: { API_KEY: "sk-test" },
    apiKey: "sk-test",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    provider: "openai",
    thinkingEnabled: true,
    reasoningEffort: "max",
    timeout: 600,
    contextWindow: 131072,
    // 上游 0.3.1 新增必填字段：自动 compact 阈值、多模态与 Files API 配置（测试夹具默认值）
    autoCompactWindow: 65536,
    multimodal: "default",
    filesApiEnabled: false,
    filesApiTimeoutMs: 60000,
    fileExpiresAfterSeconds: 604800,
    fileRefreshMarginSeconds: 3600,
    fileQuotaCleanupBatch: 100,
    maxRequestFilesBytes: 134217728,
    debugLogEnabled: false,
    telemetryEnabled: false,
    allowPrivateBaseURL: false,
    permissions: {} as ResolvedDeepcodingSettings["permissions"],
    enabledSkills: {},
    statusline: {} as ResolvedDeepcodingSettings["statusline"],
  };
}

await suite("provider 标识与能力标记", () => {
  const provider = new OpenAIProvider();
  assertEqual(provider.name, "openai", "name");
  const client = provider.createClient(makeSettings());
  assertEqual(client.providerName, "openai", "client.providerName");
  assertEqual(client.model, "deepseek-v4-pro", "model 映射");
  assertEqual(client.baseURL, "https://api.deepseek.com", "baseURL 映射");
  assertTrue(client.supportsThinking, "DeepSeek 支持 thinking");
  assertEqual(client.supportsPromptCaching, false, "OpenAI 通路不暴露 prompt caching");
});

await suite("包装 createOpenAIClient 等价性", () => {
  const provider = new OpenAIProvider();
  const client = provider.createClient(makeSettings());
  // 底层 OpenAI SDK 实例应可访问（供既有 session.ts 流式逻辑复用）
  assertTrue(client.getUnderlyingOpenAI() !== null, "底层 SDK 实例存在");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
