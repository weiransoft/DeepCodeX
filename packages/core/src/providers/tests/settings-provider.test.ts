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

// ---------------------------------------------------------------------------
// M1：baseURL provider 感知默认值
// provider=anthropic 且 env.BASE_URL 未显式设置时，缺省指向 Claude 官方端点；
// provider=openai 时保持 defaults.baseURL（DeepSeek）现状；显式 BASE_URL 始终优先。
// ---------------------------------------------------------------------------

await suite("M1: anthropic 缺省 baseURL 指向 Claude 官方端点", () => {
  const r = resolveSettingsSources({ provider: "anthropic", model: "claude-sonnet-4-6" }, null, defaults, {});
  assertEqual(r.baseURL, "https://api.anthropic.com", "anthropic 缺省 baseURL");
});

await suite("M1: model 前缀推断 anthropic 时缺省 baseURL 同样指向 Claude 官方端点", () => {
  const r = resolveSettingsSources({ model: "claude-opus-4-7" }, null, defaults, {});
  assertEqual(r.provider, "anthropic", "前缀推断确认");
  assertEqual(r.baseURL, "https://api.anthropic.com", "推断 anthropic 的缺省 baseURL");
});

await suite("M1: anthropic + 显式 BASE_URL 时显式值优先", () => {
  const r = resolveSettingsSources(
    { provider: "anthropic", env: { BASE_URL: "https://gateway.example.com/claude" } },
    null,
    defaults,
    {}
  );
  assertEqual(r.baseURL, "https://gateway.example.com/claude", "显式 BASE_URL 覆盖默认值");
});

await suite("M1: openai 缺省 baseURL 保持 defaults（零回归）", () => {
  const r = resolveSettingsSources({ provider: "openai" }, null, defaults, {});
  assertEqual(r.baseURL, "https://api.deepseek.com", "openai 缺省 baseURL 不变");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
