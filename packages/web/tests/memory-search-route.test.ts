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
  // 隔离：本文件不测自动索引，显式关闭，避免宿主环境注入语料根导致后台 spawn
  process.env.DEEPCODE_WEB_MEMSEARCH_AUTOINDEX = "0";

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
  delete process.env.DEEPCODE_WEB_MEMSEARCH_AUTOINDEX;
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

/**
 * 共享语料根测试用的 fake CLI：返回「共享文档 + 越权私有文档」两条结果，
 * expand 的 source 由环境变量控制，便于同一脚本覆盖合法/越权两种分支。
 */
const SHARED_FAKE_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "memsearch, version 0.4.23"; exit 0; fi
if [ "$1" = "search" ]; then
  printf '[{"chunk_hash":"shared1","content":"shared doc","source":"%s/shared.md","heading":"shared","heading_level":1,"start_line":1,"end_line":2,"score":0.9},{"chunk_hash":"foreign1","content":"private","source":"/other/private.md","heading":"private","heading_level":1,"start_line":1,"end_line":2,"score":0.8}]\\n' "$DCX_MS_SHARED_ROOT"
  exit 0
fi
if [ "$1" = "expand" ]; then
  printf '{"chunk_hash":"x1","content":"expanded","source":"%s","heading":"h","start_line":1,"end_line":2}\\n' "$DCX_MS_EXPAND_SOURCE"
  exit 0
fi
echo unsupported >&2
exit 1
`;

/** 临时切到共享根 fake CLI，用例结束恢复全部环境变量 */
async function withSharedCli<T>(sharedRoot: string, expandSource: string, fn: () => Promise<T>): Promise<T> {
  const sharedBin = path.join(tmpRoot, "shared-memsearch.sh");
  writeFileSync(sharedBin, SHARED_FAKE_SCRIPT, "utf8");
  chmodSync(sharedBin, 0o755);
  const keys = [
    "DEEPCODE_MEMSEARCH_BIN",
    "DEEPCODE_WEB_MEMSEARCH_CORPUS_DIRS",
    "DCX_MS_SHARED_ROOT",
    "DCX_MS_EXPAND_SOURCE",
  ] as const;
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  process.env.DEEPCODE_MEMSEARCH_BIN = sharedBin;
  process.env.DEEPCODE_WEB_MEMSEARCH_CORPUS_DIRS = sharedRoot;
  process.env.DCX_MS_SHARED_ROOT = sharedRoot;
  process.env.DCX_MS_EXPAND_SOURCE = expandSource;
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      const old = previous.get(k);
      if (old === undefined) delete process.env[k];
      else process.env[k] = old;
    }
  }
}

test("MS-R5 服务端声明共享根 → 本地多前缀过滤，越权 source 不出现在结果", async () => {
  const sharedRoot = mkdtempSync(path.join(tmpdir(), "dcx-ms-shared-"));
  try {
    await withSharedCli(sharedRoot, "/other/private.md", async () => {
      const { status, body } = await fetchJson(
        server.port,
        "GET",
        "/api/memory/search?q=%E5%85%B1%E4%BA%AB&top_k=5",
        undefined,
        cookie
      );
      assert.equal(status, 200, JSON.stringify(body));
      const data = body as {
        ok: boolean;
        allowedPrefixes: string[];
        excludedCount: number;
        results: Array<{ chunk_hash: string }>;
      };
      assert.equal(data.ok, true);
      assert.deepEqual(
        data.results.map((r) => r.chunk_hash),
        ["shared1"],
        "越权文档必须被本地过滤掉"
      );
      assert.ok(data.allowedPrefixes.includes(sharedRoot), "共享根必须显式出现在允许前缀里");
      assert.equal(data.excludedCount, 1);
    });
  } finally {
    rmSync(sharedRoot, { recursive: true, force: true });
  }
});

test("MS-R6 expand 越权（source 不属于任何允许前缀）→ 403，不返回正文", async () => {
  const sharedRoot = mkdtempSync(path.join(tmpdir(), "dcx-ms-shared-"));
  try {
    await withSharedCli(sharedRoot, "/other/private.md", async () => {
      const { status, body } = await fetchJson(
        server.port,
        "GET",
        "/api/memory/search?expand=foreign1",
        undefined,
        cookie
      );
      assert.equal(status, 403);
      const data = body as { ok: boolean; status: string; expansion?: unknown };
      assert.equal(data.ok, false);
      assert.equal(data.status, "forbidden");
      assert.equal(data.expansion, undefined, "不得泄露被拒绝 chunk 的正文");
    });
  } finally {
    rmSync(sharedRoot, { recursive: true, force: true });
  }
});

test("MS-R7 expand 命中服务端声明的共享根 → 200", async () => {
  const sharedRoot = mkdtempSync(path.join(tmpdir(), "dcx-ms-shared-"));
  try {
    await withSharedCli(sharedRoot, path.join(sharedRoot, "shared.md"), async () => {
      const { status, body } = await fetchJson(
        server.port,
        "GET",
        "/api/memory/search?expand=shared1",
        undefined,
        cookie
      );
      assert.equal(status, 200, JSON.stringify(body));
      const data = body as { ok: boolean; action: string; expansion: { content: string } };
      assert.equal(data.ok, true);
      assert.equal(data.action, "expand");
      assert.equal(data.expansion.content, "expanded");
    });
  } finally {
    rmSync(sharedRoot, { recursive: true, force: true });
  }
});
