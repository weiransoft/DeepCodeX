/**
 * Settings provider 解析单元测试
 *
 * 覆盖：显式声明 > env 变量 > model 前缀推断 > 默认 openai 的优先级链
 */

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

await suite("显式 settings.provider 优先", () => {
  const r = resolveSettingsSources({ provider: "anthropic", model: "claude-sonnet-4-6" }, null, defaults, {});
  assertEqual(r.provider, "anthropic", "provider 字段直读");
});

await suite("env.PROVIDER 次之", () => {
  const r = resolveSettingsSources({ env: { PROVIDER: "anthropic" } }, null, defaults, {});
  assertEqual(r.provider, "anthropic", "env.PROVIDER 生效");
});

await suite("model 前缀推断 claude-*", () => {
  const r = resolveSettingsSources({ model: "claude-opus-4-7" }, null, defaults, {});
  assertEqual(r.provider, "anthropic", "claude 前缀推断");
});

await suite("model 前缀推断 deepseek-*", () => {
  const r = resolveSettingsSources({ model: "deepseek-v4-flash" }, null, defaults, {});
  assertEqual(r.provider, "openai", "deepseek 前缀推断");
});

await suite("默认 openai（无线索时）", () => {
  const r = resolveSettingsSources(null, null, defaults, {});
  assertEqual(r.provider, "openai", "缺省回退 openai");
});

await suite("anthropic 配置块解析", () => {
  const r = resolveSettingsSources(
    { env: { PROVIDER: "anthropic", ANTHROPIC_BETA: "extended-thinking,prompt-caching" } },
    null,
    defaults,
    {}
  );
  assertEqual(r.anthropic?.betaFeatures.join(","), "extended-thinking,prompt-caching", "beta 列表");
  assertEqual(r.anthropic?.maxTokens, 8192, "maxTokens 默认 8192");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
