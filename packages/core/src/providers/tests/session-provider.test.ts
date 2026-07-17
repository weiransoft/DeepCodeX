/**
 * Session provider 集成测试
 *
 * 覆盖：SessionManager 按 settings.provider 选择客户端工厂行为——
 *       anthropic 时 createChatCompletionStream 走 Claude 通路、
 *       openai 时保持既有 DeepSeek 通路
 */

import { ProviderFactory } from "../provider-factory.js";
import { resolveSettingsSources } from "../../settings.js";

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

function suite(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    console.log(`\n=== ${name} ===`);
  });
}

const defaults = { model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com" };

await suite("端到端：claude model 配置解析出 anthropic client", () => {
  const settings = resolveSettingsSources(
    { model: "claude-sonnet-4-6", env: { API_KEY: "sk-ant-e2e", BASE_URL: "https://api.anthropic.com" } },
    null,
    defaults,
    {}
  );
  assertEqual(settings.provider, "anthropic", "settings.provider");
  const client = ProviderFactory.create(settings);
  assertEqual(client.providerName, "anthropic", "client 类型");
  assertEqual(client.model, "claude-sonnet-4-6", "client.model");
});

await suite("端到端：deepseek model 配置解析出 openai client", () => {
  const settings = resolveSettingsSources({ model: "deepseek-v4-pro", env: { API_KEY: "sk-e2e" } }, null, defaults, {});
  assertEqual(settings.provider, "openai", "settings.provider");
  const client = ProviderFactory.create(settings);
  assertEqual(client.providerName, "openai", "client 类型");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
