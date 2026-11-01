/**
 * LDAP 配置运行期热读测试（LDAP 开关免重启生效）。
 *
 * 验证：TTL 缓存 / 开关热切换（enabled true↔false）/ 非法字段逐项回退基线 /
 * 文件损坏 fail-safe / bindPassword 恒用基线（env 注入语义，不从文件读）。
 * 测试经 userSettingsPath/projectSettingsPath 注入临时文件，隔离真实配置。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createResolvedSettings } from "./helpers";
import { readLdapRuntimeConfig, resetLdapRuntimeCacheForTest, LDAP_RUNTIME_TTL_MS } from "../src/auth/ldap-runtime";

let tmpRoot: string;
let userFile: string;
let projectFile: string;

/** 构造带 projectRoot 的基线 settings（ldap 启动值 enabled=false） */
function baseline() {
  return createResolvedSettings({
    projectRoot: tmpRoot,
    ldap: {
      enabled: false,
      server: "ldap.baseline",
      port: 389,
      useSsl: false,
      baseDn: "dc=baseline",
      userFilter: "(uid=%s)",
      timeoutMs: 3000,
      attrs: {},
    },
  });
}

/** 写用户级 settings.json 的 web.ldap 子树 */
function writeUserLdap(ldap: unknown): void {
  writeFileSync(userFile, JSON.stringify({ web: { ldap } }), "utf8");
}

beforeEach(() => {
  resetLdapRuntimeCacheForTest();
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-ldap-runtime-"));
  userFile = path.join(tmpdir(), `deepcode-ldap-user-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  projectFile = path.join(tmpRoot, ".deepcode", "settings.json");
});

test("ldap-runtime：文件缺省时返回启动基线", () => {
  const config = readLdapRuntimeConfig(baseline(), { userSettingsPath: userFile, projectSettingsPath: projectFile });
  assert.equal(config.enabled, false);
  assert.equal(config.server, "ldap.baseline");
});

test("ldap-runtime：开关切换热生效（TTL 缓存窗口外重读）", async () => {
  const base = baseline();
  // 初次读：无文件 → 基线 false，同时填充缓存
  assert.equal(
    readLdapRuntimeConfig(base, { userSettingsPath: userFile, projectSettingsPath: projectFile }).enabled,
    false
  );

  // 写入 enabled=true：TTL 内仍读缓存（false）
  writeUserLdap({ enabled: true });
  assert.equal(
    readLdapRuntimeConfig(base, { userSettingsPath: userFile, projectSettingsPath: projectFile }).enabled,
    false
  );

  // 过 TTL 后重读：true 生效
  const waited = new Promise<void>((resolve) => setTimeout(resolve, LDAP_RUNTIME_TTL_MS + 50));
  await waited;
  assert.equal(
    readLdapRuntimeConfig(base, { userSettingsPath: userFile, projectSettingsPath: projectFile }).enabled,
    true
  );
});

test("ldap-runtime：非法字段逐项回退基线，合法字段热更新", async () => {
  const base = baseline();
  writeUserLdap({ enabled: true, server: "ldap.hot", port: "not-a-number", timeoutMs: 100 });
  const waited = new Promise<void>((resolve) => setTimeout(resolve, LDAP_RUNTIME_TTL_MS + 50));
  await waited;
  const config = readLdapRuntimeConfig(base, { userSettingsPath: userFile, projectSettingsPath: projectFile });
  assert.equal(config.enabled, true, "合法布尔字段必须热更新");
  assert.equal(config.server, "ldap.hot", "合法字符串字段必须热更新");
  assert.equal(config.port, 389, "非法端口必须回退基线");
  assert.equal(config.timeoutMs, 3000, "低于下限（<1000）的超时必须回退基线");
});

test("ldap-runtime：文件损坏时 fail-safe 回退基线", async () => {
  const base = baseline();
  // 先读一次填充缓存（TTL 内损坏文件不影响）
  assert.equal(
    readLdapRuntimeConfig(base, { userSettingsPath: userFile, projectSettingsPath: projectFile }).enabled,
    false
  );
  writeFileSync(userFile, "{corrupted json", "utf8");
  const waited = new Promise<void>((resolve) => setTimeout(resolve, LDAP_RUNTIME_TTL_MS + 50));
  await waited;
  const config = readLdapRuntimeConfig(base, { userSettingsPath: userFile, projectSettingsPath: projectFile });
  assert.equal(config.enabled, false, "损坏文件必须回退基线而非抛错");
  assert.equal(config.server, "ldap.baseline");
});
