/**
 * memory-search-route.test.ts — GET /api/memory/search 真实 HTTP 接线测试
 *
 * 验证路由确实挂在全局 JWT 门禁之后（401）、参数校验（400）、
 * 以及成功检索（200 + per-user sourcePrefix）。fake CLI 经环境变量注入保证确定性。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { createResolvedSettings, extractAuthCookie, fetchJson, sha256Hex } from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;
let engineHomeRoot: string;
let cookie: string;
let fakeBin: string;

const FAKE_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "memsearch, version 0.4.23"; exit 0; fi
if [ "$1" = "search" ]; then
  cat <<'JSON'
[{"chunk_hash":"aaa111","content":"轨道 A 默认 4 轮","source":"/tmp/eag.md","heading":"无进展双轨熔断","heading_level":2,"start_line":6,"end_line":8,"score":0.97}]
JSON
  exit 0
fi
echo "unsupported" >&2
exit 1
`;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "dcx-ms-route-"));
  engineHomeRoot = mkdtempSync(path.join(tmpdir(), "dcx-ms-route-home-"));
  fakeBin = path.join(tmpRoot, "fake-memsearch.sh");
  writeFileSync(fakeBin, FAKE_SCRIPT, "utf8");
  chmodSync(fakeBin, 0o755);
  process.env.DEEPCODE_MEMSEARCH_BIN = fakeBin;

  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    personalOnly: true,
    engineHomeRoot,
    auth: {
      jwtSecret: "memory-search-route-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("admin-pass-123"), displayName: "管理员" }],
    },
  });
  server = await startWebServer(settings);
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });
  cookie = extractAuthCookie(login.headers) ?? "";
  assert.ok(cookie, "测试前置：登录应下发 Cookie");
});

after(async () => {
  await server.close();
  delete process.env.DEEPCODE_MEMSEARCH_BIN;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(engineHomeRoot, { recursive: true, force: true });
});

test("MS-R1 未登录 → 401（路由继承全局认证门禁）", async () => {
  const { status, body } = await fetchJson(server.port, "GET", "/api/memory/search?q=%E8%AE%B0%E5%BF%86");
  assert.equal(status, 401);
  assert.equal((body as { error: string }).error.length > 0, true);
});

test("MS-R2 登录后缺 q / expand → 400", async () => {
  const { status } = await fetchJson(server.port, "GET", "/api/memory/search", undefined, cookie);
  assert.equal(status, 400);
});

test("MS-R3 登录检索 → 200，返回摘要 + per-user sourcePrefix", async () => {
  const { status, body } = await fetchJson(
    server.port,
    "GET",
    "/api/memory/search?q=%E6%97%A0%E8%BF%9B%E5%B1%95&top_k=3",
    undefined,
    cookie
  );
  assert.equal(status, 200, JSON.stringify(body));
  const data = body as {
    ok: boolean;
    action: string;
    sourcePrefix: string;
    results: Array<{ chunk_hash: string; preview: string }>;
  };
  assert.equal(data.ok, true);
  assert.equal(data.action, "search");
  assert.equal(data.results[0].chunk_hash, "aaa111");
  assert.ok(data.sourcePrefix.length > 0, "必须带 per-user 隔离前缀");
});

test("MS-R4 上游失败 → 502，且 ok:false 不伪装成功", async () => {
  const badBin = path.join(tmpRoot, "bad-memsearch.sh");
  writeFileSync(
    badBin,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "memsearch, version 0.4.23"; exit 0; fi\necho "upstream 401" >&2\nexit 1\n',
    "utf8"
  );
  chmodSync(badBin, 0o755);
  const previous = process.env.DEEPCODE_MEMSEARCH_BIN;
  process.env.DEEPCODE_MEMSEARCH_BIN = badBin;
  try {
    const { status, body } = await fetchJson(server.port, "GET", "/api/memory/search?q=x", undefined, cookie);
    assert.equal(status, 502);
    const data = body as { ok: boolean; status: string; reason: string };
    assert.equal(data.ok, false);
    assert.equal(data.status, "error");
    assert.match(data.reason, /upstream 401/);
  } finally {
    process.env.DEEPCODE_MEMSEARCH_BIN = previous;
  }
});
