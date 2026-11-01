/**
 * LDAP 登录慢问题回归测试（登录快速失败三件套）。
 *
 * 背景：LDAP enabled 且服务器不可达时，每次登录都白等一个完整 connectTimeout
 * 才落到本地兜底（实测 10.5s）。修复项：
 * 1. 本地用户短路——用户名命中 localUsers 直接本地校验，跳过 LDAP；
 * 2. 连接类失败熔断 30s——冷却期内跳过 LDAP 快速失败，恢复期自动重试；
 * 3. 凭据类错误不熔断（服务健康只是密码错，仍应真实探测）。
 *
 * 测试用不可路由黑洞地址 10.255.255.1（SYN 无响应 → ldapts connectTimeout 先触发，
 * 稳定模拟"服务器不可达"），timeoutMs=3000 保证非短路路径显著慢于断言阈值。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { createResolvedSettings, fetchJson, sha256Hex } from "./helpers";
import { isLdapConnectError, resetLdapCircuitForTest } from "../src/api/auth-api";

/** 不可路由黑洞地址：TCP SYN 永无响应，连接只能靠 connectTimeout 中止 */
const LDAP_BLACKHOLE = "10.255.255.1";
const LDAP_TIMEOUT_MS = 3000;

let server: RunningWebServer;
let tmpRoot: string;

before(async () => {
  resetLdapCircuitForTest();
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-ldap-failover-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    auth: {
      jwtSecret: "ldap-failover-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "desktop", passwordHash: sha256Hex("desktop-pass"), displayName: "本地用户" }],
    },
    ldap: {
      enabled: true,
      server: LDAP_BLACKHOLE,
      port: 389,
      useSsl: false,
      baseDn: "DC=test,DC=local",
      userFilter: "(sAMAccountName=%s)",
      timeoutMs: LDAP_TIMEOUT_MS,
      attrs: {},
    },
  });
  server = await startWebServer(settings);
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("ldap-failover：本地用户登录短路 LDAP，不等 connectTimeout", async () => {
  const started = Date.now();
  const { status, body } = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "desktop",
    password: "desktop-pass",
  });
  const elapsed = Date.now() - started;

  assert.equal(status, 200, "本地用户必须登录成功");
  assert.equal(body.authSource, "local");
  // 短路路径应远快于 timeoutMs（3000ms）；放宽到 1.5s 容忍 CI 调度抖动
  assert.ok(elapsed < 1500, `本地用户登录必须短路 LDAP（实际 ${elapsed}ms，阈值 1500ms）`);
});

test("ldap-failover：LDAP 用户首次 401 触发熔断，冷却期内二次请求快速失败", async () => {
  // 首次：LDAP 连接超时（~timeoutMs）后本地兜底无此用户 → 401 + 500ms 防爆破延迟。
  // 首次耗时不设上限断言（黑洞地址下约 3.5s 属预期），只断言结果。
  const first = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "ldap-only-user",
    password: "whatever",
  });
  assert.equal(first.status, 401);
  assert.equal(first.body.error, "用户名或密码错误");

  // 二次：熔断冷却期内跳过 LDAP，只剩 500ms 固定延迟 → 必须显著小于 timeoutMs。
  const secondStarted = Date.now();
  const second = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "ldap-only-user",
    password: "whatever",
  });
  const secondElapsed = Date.now() - secondStarted;
  assert.equal(second.status, 401);
  assert.ok(secondElapsed < 1500, `熔断冷却期内登录必须快速失败（实际 ${secondElapsed}ms，阈值 1500ms）`);
});

test("ldap-failover：isLdapConnectError 只对连接类错误熔断", () => {
  // 连接类 → true（ldapts 实测形态：Connection timeout / Operation timed out / node ECONNREFUSED）
  assert.equal(isLdapConnectError("Connection timeout"), true);
  assert.equal(isLdapConnectError("BindResponse: Operation timed out"), true);
  assert.equal(isLdapConnectError("connect ECONNREFUSED 192.168.0.250:389"), true);
  assert.equal(isLdapConnectError("connect ETIMEDOUT 10.255.255.1:389"), true);
  assert.equal(isLdapConnectError("getaddrinfo ENOTFOUND ldap.corp"), true);

  // 凭据/业务类 → false（服务健康，不应熔断）
  assert.equal(isLdapConnectError("invalid credentials"), false);
  assert.equal(isLdapConnectError("no such object"), false);
  assert.equal(isLdapConnectError("undefined attribute type"), false);
});
