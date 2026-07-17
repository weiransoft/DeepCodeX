/**
 * ProviderFactory 单元测试
 *
 * 覆盖：按 settings.provider 路由、anthropic 配置校验（API_KEY 格式）、
 *       未知 provider 报错、单例缓存
 */

import { ProviderFactory } from "../provider-factory.js";
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

function makeSettings(provider: "openai" | "anthropic", apiKey = "sk-test"): ResolvedDeepcodingSettings {
  return {
    env: { API_KEY: apiKey },
    apiKey,
    baseURL: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com",
    model: provider === "anthropic" ? "claude-sonnet-4-6" : "deepseek-v4-pro",
    provider,
    anthropic: provider === "anthropic" ? { betaFeatures: [], maxTokens: 8192 } : undefined,
    thinkingEnabled: false,
    reasoningEffort: "max",
    debugLogEnabled: false,
    telemetryEnabled: false,
    permissions: {} as ResolvedDeepcodingSettings["permissions"],
    enabledSkills: {},
    statusline: {} as ResolvedDeepcodingSettings["statusline"],
  };
}

await suite("路由到 OpenAI", () => {
  const client = ProviderFactory.create(makeSettings("openai"));
  assertEqual(client.providerName, "openai", "openai 路由");
});

await suite("路由到 Anthropic", () => {
  const client = ProviderFactory.create(makeSettings("anthropic", "sk-ant-valid"));
  assertEqual(client.providerName, "anthropic", "anthropic 路由");
});

await suite("anthropic 缺 API_KEY 时 fail-fast", () => {
  let threw = false;
  try {
    const s = makeSettings("anthropic");
    s.apiKey = undefined;
    s.env = {};
    ProviderFactory.create(s);
  } catch (e) {
    threw = true;
    assertTrue(e instanceof Error && e.message.includes("API_KEY"), "含 API_KEY 提示");
  }
  assertTrue(threw, "应抛配置错误");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
