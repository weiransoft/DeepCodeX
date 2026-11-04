/**
 * Soul 路由集成测试（真实 HTTP + startWebServer）
 *
 * 单元测试只验证处理器本身；这里验证**接线**：中间件拦截、路径分发、
 * 方法分派、响应结构。历史上有过「处理器写好了但路由没挂」的先例，
 * 单测全绿、菜单点进去 404——所以这一层必须真起服务器。
 *
 * 覆盖：
 * - R1 未登录 GET /api/soul → 401（记忆属个人资产，不能裸奔）
 * - R2 登录后 GET → 200，人格齐全
 * - R3 POST 记一条 → 200，GET 回读可见
 * - R4 DELETE 删除 → 200，GET 回读消失
 * - R5 POST 空内容 → 400
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
let engineHomeRoot: string;
let cookie: string;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-soul-"));
  engineHomeRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-soul-home-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    // 记忆落本用户的引擎数据目录：与生产口径一致，且与真实家目录隔离
    personalOnly: true,
    engineHomeRoot,
    auth: {
      jwtSecret: "soul-route-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("admin-pass-123"), displayName: "管理员" }],
    },
  });
  server = await startWebServer(settings);
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });
  const authCookie = extractAuthCookie(login.headers);
  assert.ok(authCookie, "测试前置：登录应下发 Cookie");
  cookie = authCookie;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(engineHomeRoot, { recursive: true, force: true });
});

test("R1 未登录访问 /api/soul → 401", async () => {
  const { status } = await fetchJson(server.port, "GET", "/api/soul");
  assert.equal(status, 401);
});

test("R2 登录后 GET /api/soul → 200 且人格齐全", async () => {
  const { status, body } = await fetchJson(server.port, "GET", "/api/soul", undefined, cookie);
  assert.equal(status, 200);
  assert.equal(body.snapshot.name.primary, "司南");
  assert.equal(body.snapshot.memoryStats.total, 0);
  assert.ok(Array.isArray(body.categories) && body.categories.length === 10);
});

test("R3 POST 记一条 → 200；GET 回读可见且不含明文凭证", async () => {
  const created = await fetchJson(
    server.port,
    "POST",
    "/api/soul/memory",
    { text: "生产部署在 10.0.0.8，docker compose 起", category: "deploy" },
    cookie
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.category, "deploy");

  const secret = await fetchJson(
    server.port,
    "POST",
    "/api/soul/memory",
    { text: "数据库密码是 Passw0rd!2026" },
    cookie
  );
  assert.equal(secret.status, 200);
  assert.equal(secret.body.secret, true);

  const read = await fetchJson(server.port, "GET", "/api/soul", undefined, cookie);
  assert.equal(read.body.snapshot.memoryStats.total, 2);
  assert.ok(JSON.stringify(read.body).includes("10.0.0.8"), "普通记忆应可回读");
  assert.ok(!JSON.stringify(read.body).includes("Passw0rd"), "凭证明文不得下发");
});

test("R4 DELETE 删除 → 200；GET 回读减少", async () => {
  const before = await fetchJson(server.port, "GET", "/api/soul", undefined, cookie);
  const group = (before.body.snapshot.memoryGroups as Array<{ category: string; items: Array<{ id: string }> }>).find(
    (item) => item.category === "deploy"
  );
  assert.ok(group, "测试前置：应存在部署记忆");
  const id = group.items[0]!.id;

  const removed = await fetchJson(
    server.port,
    "DELETE",
    `/api/soul/memory/${encodeURIComponent(id)}`,
    undefined,
    cookie
  );
  assert.equal(removed.status, 200);

  const after = await fetchJson(server.port, "GET", "/api/soul", undefined, cookie);
  assert.equal(after.body.snapshot.memoryStats.total, 1);
});

test("R5 POST 空内容 → 400", async () => {
  const { status, body } = await fetchJson(server.port, "POST", "/api/soul/memory", { text: "   " }, cookie);
  assert.equal(status, 400);
  assert.ok(typeof body?.error === "string" || typeof body?.message === "string", "应返回可读错误");
});
