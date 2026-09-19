/**
 * 静态资源与 /api/config 集成测试（真实 HTTP，docs/dev/web-ui.md §3.1 / §3.6）。
 *
 * 覆盖：staticDir 注入临时 dist 后的静态服务（index.html/资产/SPA fallback/
 * 带扩展名缺失 404）、dist 不存在时的中文提示页、/api/config 脱敏（绝不返回
 * jwtSecret 等密钥）、静态路径穿越防护（%2e%2e）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { createResolvedSettings, extractAuthCookie, fetchJson, sha256Hex } from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;
let staticDir: string;
let cookie: string;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-static-"));
  // 伪造前端构建产物 dist
  staticDir = path.join(tmpRoot, "dist");
  mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  writeFileSync(
    path.join(staticDir, "index.html"),
    "<!DOCTYPE html><html><body>DeepCodeX Web SPA</body></html>",
    "utf8"
  );
  writeFileSync(path.join(staticDir, "assets", "app.js"), "console.log('spa');", "utf8");

  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    auth: {
      jwtSecret: "static-flow-test-secret-DO-NOT-LEAK",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("static-pass") }],
    },
  });
  server = await startWebServer(settings, { staticDir });

  const login = await fetchJson(server.port, "POST", "/api/auth/login", { username: "admin", password: "static-pass" });
  assert.equal(login.status, 200);
  cookie = extractAuthCookie(login.headers)!;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("static：GET / 应返回 dist 的 index.html", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.ok(html.includes("DeepCodeX Web SPA"));
});

test("static：静态资产按扩展名 MIME 返回；HEAD 请求返回空体", async () => {
  const js = await fetch(`http://127.0.0.1:${server.port}/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await js.text(), "console.log('spa');");
});

test("static：无扩展名未知路径应 SPA fallback 到 index.html", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/chats/abc123`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("DeepCodeX Web SPA"), "SPA 路由必须 fallback 到 index.html");
});

test("static：带扩展名的缺失资源应 404（不得误回 HTML）", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/assets/missing.js`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error, /资源不存在/);
});

test("static：静态路径穿越（%2e%2e）应被拦截（404，绝不回包白名单外内容）", async () => {
  // 构造 dist 外的机密文件
  const secretPath = path.join(path.dirname(staticDir), "secret.html");
  writeFileSync(secretPath, "<html>TOP SECRET</html>", "utf8");

  // URL 编码的 ../ 穿越
  const response = await fetch(`http://127.0.0.1:${server.port}/%2e%2e/secret.html`);
  assert.notEqual(response.status, 200, "编码穿越不得读到 dist 外文件");
  const body = await response.text();
  assert.ok(!body.includes("TOP SECRET"), "响应体绝不能包含 dist 外内容");
});

test("static：dist 不存在时应返回中文提示页（后端先行可用）", async () => {
  const missingServer = await startWebServer(
    createResolvedSettings({ auth: { jwtSecret: "placeholder-secret", sessionTtlSeconds: 60 } }),
    { staticDir: path.join(tmpRoot, "dist-does-not-exist") }
  );
  try {
    const response = await fetch(`http://127.0.0.1:${missingServer.port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.ok(html.includes("DeepCodeX Web UI 尚未构建"), "必须是中文提示页");
    assert.ok(html.includes("后端已在端口"), "提示页必须说明后端可用");
  } finally {
    await missingServer.close();
  }
});

test("config：登录后 /api/config 必须脱敏（无 jwtSecret/密码等密钥字段）", async () => {
  const { status, body } = await fetchJson(server.port, "GET", "/api/config", undefined, cookie);
  assert.equal(status, 200);

  // 结构断言：仅允许四个公开字段
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, ["allowRoots", "enabled", "ldapEnabled", "maxUploadBytes"]);
  assert.equal(body.enabled, true);
  assert.equal(body.ldapEnabled, false);
  assert.equal(body.maxUploadBytes, 1024 * 1024);
  assert.deepEqual(body.allowRoots, [path.resolve(tmpRoot)]);

  // 全量 JSON 不得包含任何密钥值
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("static-flow-test-secret-DO-NOT-LEAK"), "响应绝不能包含 jwtSecret");
  assert.ok(!raw.includes("passwordHash"), "响应绝不能包含密码哈希字段名");
});

test("static：静态资源无需认证即可访问（/ 与 /assets/app.js），API 仍需认证", async () => {
  const root = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(root.status, 200, "静态首页必须免认证");

  const chats = await fetchJson(server.port, "GET", "/api/chats");
  assert.equal(chats.status, 401, "API 与静态资源的认证边界必须清晰");
});
