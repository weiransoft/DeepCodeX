/**
 * 认证流程集成测试（真实 HTTP + startWebServer，docs/dev/web-ui.md §3.4）。
 *
 * 全链路：登录（localUsers 兜底）→ Set-Cookie → /me → 受保护端点 → 登出 → 401。
 * settings 经 createResolvedSettings 完全受控（不读本机配置）；
 * LDAP 未启用（enabled=false），验证本地兜底链路（设计文档 §5.2 认可的测试路径）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { createResolvedSettings, extractAuthCookie, fetchJson, sha256Hex } from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-auth-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    auth: {
      jwtSecret: "auth-flow-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("admin-pass-123"), displayName: "管理员" }],
    },
  });
  server = await startWebServer(settings);
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("auth：正确凭证登录 → 200 + HttpOnly Cookie + authSource=local", async () => {
  const { status, headers, body } = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });

  assert.equal(status, 200);
  assert.equal(body.username, "admin");
  assert.equal(body.displayName, "管理员");
  assert.equal(body.authSource, "local", "LDAP 未启用时本地兜底用户必须标记 local");

  const setCookie = headers.getSetCookie();
  const authCookie = setCookie.find((cookie) => cookie.startsWith("deepcode_web_token="));
  assert.ok(authCookie, "必须下发认证 Cookie");
  assert.ok(authCookie.includes("HttpOnly"), "Cookie 必须带 HttpOnly");
  assert.ok(authCookie.includes("SameSite=Strict"), "Cookie 必须带 SameSite=Strict");
  assert.ok(authCookie.includes("Path=/"), "Cookie 必须带 Path=/");
  assert.ok(authCookie.includes("Max-Age=3600"), "Cookie Max-Age 必须与 sessionTtlSeconds 对齐");
});

test("auth：登录后携带 Cookie 访问 /api/auth/me 应返回用户信息", async () => {
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });
  const cookie = extractAuthCookie(login.headers);
  assert.ok(cookie, "登录响应必须可提取 Cookie");

  const me = await fetchJson(server.port, "GET", "/api/auth/me", undefined, cookie!);
  assert.equal(me.status, 200);
  assert.equal(me.body.username, "admin");
  assert.equal(me.body.displayName, "管理员");
  assert.equal(me.body.authSource, "local");
});

test("auth：错误密码登录应 401（统一文案，防账号枚举）", async () => {
  const started = Date.now();
  const { status, body } = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "wrong-password",
  });

  assert.equal(status, 401);
  assert.equal(body.error, "用户名或密码错误");
  // 固定 500ms 延迟防暴力破解（允许少许调度误差）
  assert.ok(Date.now() - started >= 450, `登录失败必须引入固定延迟（实际 ${Date.now() - started}ms）`);
});

test("auth：不存在的用户名同样 401 且不泄露存在性", async () => {
  const { status, body } = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "ghost-user",
    password: "whatever",
  });
  assert.equal(status, 401);
  assert.equal(body.error, "用户名或密码错误");
});

test("auth：畸形请求体（缺字段/非对象）应 400 而非 401", async () => {
  const missing = await fetchJson(server.port, "POST", "/api/auth/login", { username: "admin" });
  assert.equal(missing.status, 400);

  const empty = await fetchJson(server.port, "POST", "/api/auth/login", {});
  assert.equal(empty.status, 400);

  const notObject = await fetch(server.port ? `http://127.0.0.1:${server.port}/api/auth/login` : "", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([1, 2]),
  });
  assert.equal(notObject.status, 400, "数组请求体必须 400");
});

test("auth：未认证访问受保护端点应 401（含 /api/config 与 /api/chats）", async () => {
  const config = await fetchJson(server.port, "GET", "/api/config");
  assert.equal(config.status, 401);
  const chats = await fetchJson(server.port, "GET", "/api/chats");
  assert.equal(chats.status, 401);
});

test("auth：伪造/篡改的 Cookie 应 401", async () => {
  const forged = await fetchJson(server.port, "GET", "/api/auth/me", undefined, "deepcode_web_token=abc.def.ghi");
  assert.equal(forged.status, 401);

  // 真实 token 篡改 payload 后必须失效
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });
  const cookie = extractAuthCookie(login.headers)!;
  const token = decodeURIComponent(cookie.split("=")[1]);
  const [headerB64, , signatureB64] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "root", iat: 1, exp: 9999999999 }), "utf8").toString(
    "base64url"
  );
  const tampered = await fetchJson(
    server.port,
    "GET",
    "/api/auth/me",
    undefined,
    `deepcode_web_token=${encodeURIComponent(`${headerB64}.${forgedPayload}.${signatureB64}`)}`
  );
  assert.equal(tampered.status, 401, "篡改载荷的 token 必须被拒绝");
});

test("auth：登出清除 Cookie → 再访问 /me 应 401", async () => {
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });
  const cookie = extractAuthCookie(login.headers)!;

  const logout = await fetchJson(server.port, "POST", "/api/auth/logout", undefined, cookie);
  assert.equal(logout.status, 200);
  assert.ok(logout.body.ok);

  // 登出响应的 Set-Cookie 必须是清除语义（Max-Age=0）
  const cleared = logout.headers.getSetCookie().find((item) => item.startsWith("deepcode_web_token="));
  assert.ok(cleared, "登出必须下发清除 Cookie");
  assert.ok(cleared.includes("Max-Age=0"));

  // 旧 token 仍在有效期内，但登出语义由客户端清 Cookie 实现；旧 Cookie 直接回带仍可用是 JWT 无状态设计的预期行为，
  // 此处验证清除后的空 Cookie 访问 /me 必须 401
  const emptyCookie = "deepcode_web_token=";
  const me = await fetchJson(server.port, "GET", "/api/auth/me", undefined, emptyCookie);
  assert.equal(me.status, 401);
});
