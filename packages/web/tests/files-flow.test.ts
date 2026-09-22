/**
 * 文件端点集成测试（真实 HTTP + 真实文件系统，docs/dev/web-ui.md §3.5）。
 *
 * 全链路：登录 → 目录浏览（排序/size/mtime）→ multipart 上传（字节一致）→
 * 下载（字节一致 + Content-Disposition）→ 牢笼越界 403 → 空白名单 403 →
 * 超限 413 → 目录不存在 404 / 非目录 400。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { buildMultipartBody, createResolvedSettings, extractAuthCookie, fetchJson, sha256Hex } from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;
let cookie: string;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-files-"));
  // 预置目录结构：<root>/docs/（子目录）、<root>/hello.txt、<root>/docs/report.md
  mkdirSync(path.join(tmpRoot, "docs"));
  writeFileSync(path.join(tmpRoot, "hello.txt"), "hello world", "utf8");
  writeFileSync(path.join(tmpRoot, "docs", "report.md"), "# report\n\n内容", "utf8");

  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    auth: {
      jwtSecret: "files-flow-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("files-pass") }],
    },
  });
  server = await startWebServer(settings);

  const login = await fetchJson(server.port, "POST", "/api/auth/login", { username: "admin", password: "files-pass" });
  assert.equal(login.status, 200, "登录前置条件失败");
  cookie = extractAuthCookie(login.headers)!;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("files：目录浏览应返回条目（目录在前、文件在后、各按名升序）并含 size/mtime", async () => {
  const { status, body } = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(tmpRoot)}`,
    undefined,
    cookie
  );

  assert.equal(status, 200);
  // macOS /var → /private/var 符号链接：返回路径必须与 realpath 归一后的牢笼根一致
  assert.equal(body.path, await realpath(tmpRoot), "返回路径必须是牢笼内归一绝对路径");
  const names = (body.entries as any[]).map((entry) => entry.name);
  assert.deepEqual(names, ["docs", "hello.txt"], "目录 docs 在前、文件 hello.txt 在后");

  const docs = body.entries[0];
  assert.equal(docs.type, "dir");
  assert.equal(docs.size, 0, "目录条目 size 为 0");
  assert.ok(!Number.isNaN(Date.parse(docs.mtime)), "mtime 必须是合法 ISO 时间");

  const hello = body.entries[1];
  assert.equal(hello.type, "file");
  assert.equal(hello.size, 11, "hello world = 11 字节");
});

test("files：子目录浏览正常；浏览文件路径应 400（ENOTDIR）", async () => {
  const sub = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "docs"))}`,
    undefined,
    cookie
  );
  assert.equal(sub.status, 200);
  assert.deepEqual(
    sub.body.entries.map((entry: any) => entry.name),
    ["report.md"]
  );

  const notDir = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "hello.txt"))}`,
    undefined,
    cookie
  );
  assert.equal(notDir.status, 400);
});

test("files：multipart 上传到指定目录应落盘且字节一致（随机名防冲突）", async () => {
  const targetDir = path.join(tmpRoot, "docs");
  const content = Buffer.from("上传的文件内容-上傳的檔案內容", "utf8");
  const body = buildMultipartBody("filesBOUNDARY", [
    { name: "file", filename: "upload.dat", contentType: "application/octet-stream", data: content },
  ]);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/files/upload?path=${encodeURIComponent(targetDir)}`,
    {
      method: "POST",
      headers: { cookie, "content-type": 'multipart/form-data; boundary="filesBOUNDARY"' },
      body: new Uint8Array(body),
    }
  );
  const result = await response.json();
  assert.equal(response.status, 200, `上传失败：${JSON.stringify(result)}`);

  assert.equal(result.files.length, 1);
  const saved = result.files[0];
  assert.equal(saved.originalName, "upload.dat");
  assert.equal(saved.size, content.length);
  // 落盘位置与内容（服务端上传目录为 realpath 归一后的路径，macOS /var → /private/var）
  const realTargetDir = await realpath(targetDir);
  assert.ok(saved.savedPath.startsWith(realTargetDir + path.sep), "落盘路径必须在目标目录内");
  assert.ok(readFileSync(saved.savedPath).equals(content), "落盘字节必须与上传一致");
  // 随机名：与原名不同但以后缀结尾
  assert.notEqual(saved.savedName, "upload.dat");
  assert.ok(saved.savedName.endsWith("-upload.dat"));
});

test("files：上传到不存在的目录应 400（不隐式建目录）", async () => {
  const missing = path.join(tmpRoot, "no-such-dir");
  const body = buildMultipartBody("missBOUNDARY", [{ name: "file", filename: "x.txt", data: Buffer.from("x") }]);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/files/upload?path=${encodeURIComponent(missing)}`, {
    method: "POST",
    headers: { cookie, "content-type": 'multipart/form-data; boundary="missBOUNDARY"' },
    body: new Uint8Array(body),
  });
  assert.equal(response.status, 400);
});

test("files：下载应逐字节一致并携带 attachment 头", async () => {
  const filePath = path.join(tmpRoot, "docs", "report.md");
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(filePath)}`,
    { headers: { cookie } }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.ok(response.headers.get("content-disposition")?.startsWith("attachment"), "必须为 attachment 下载语义");
  assert.ok(response.headers.get("x-content-type-options") === "nosniff");

  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.ok(downloaded.equals(readFileSync(filePath)), "下载字节必须与磁盘文件一致");
});

test("files：下载不存在文件应 404；下载目录应 400", async () => {
  const missing = await fetch(
    `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(path.join(tmpRoot, "ghost.txt"))}`,
    { headers: { cookie } }
  );
  assert.equal(missing.status, 404);

  const dirDownload = await fetch(
    `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(path.join(tmpRoot, "docs"))}`,
    { headers: { cookie } }
  );
  assert.equal(dirDownload.status, 400);
});

test("files：牢笼越界（../ 逃逸）应 403 且不泄露内部路径", async () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-outside-"));
  try {
    writeFileSync(path.join(outsideDir, "secret.txt"), "top secret", "utf8");

    // 列目录越界
    const list = await fetchJson(
      server.port,
      "GET",
      `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "..", path.basename(outsideDir)))}`,
      undefined,
      cookie
    );
    assert.equal(list.status, 403);
    assert.match(list.body.error, /白名单/);

    // 下载越界
    const download = await fetch(
      `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(path.join(outsideDir, "secret.txt"))}`,
      { headers: { cookie } }
    );
    assert.equal(download.status, 403, "白名单外文件下载必须 403");

    // 上传越界
    const body = buildMultipartBody("jailBOUNDARY", [{ name: "file", filename: "x.txt", data: Buffer.from("x") }]);
    const upload = await fetch(
      `http://127.0.0.1:${server.port}/api/files/upload?path=${encodeURIComponent(outsideDir)}`,
      {
        method: "POST",
        headers: { cookie, "content-type": 'multipart/form-data; boundary="jailBOUNDARY"' },
        body: new Uint8Array(body),
      }
    );
    assert.equal(upload.status, 403);

    // 上传确实没有写到目标（真实校验未越界落盘）
    assert.deepEqual(readdirSync(outsideDir), ["secret.txt"]);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("files：单根牢笼空 path 缺省浏览根；多根牢笼空 path 仍 400", async () => {
  // 主 server 为单根 allowRoots：空 path 缺省到该根（personal「我的文件」与
  // 单根 shared 的统一缺省语义——根无歧义时前端无需感知服务端派生路径）
  const noPath = await fetchJson(server.port, "GET", "/api/files", undefined, cookie);
  assert.equal(noPath.status, 200, "单根牢笼空 path 应缺省到根");
  assert.equal(noPath.body.path, await realpath(tmpRoot), "缺省路径必须是归一后的白名单根");

  // 多根牢笼（shared）根选择有歧义：空 path 仍必须 400（根选择由前端负责）
  const rootsDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-multi-"));
  const secondRoot = path.join(rootsDir, "second");
  mkdirSync(secondRoot, { recursive: true });
  try {
    const multiServer = await startWebServer(
      createResolvedSettings({
        allowRoots: [tmpRoot, secondRoot],
        auth: {
          jwtSecret: "multi-root-secret",
          sessionTtlSeconds: 3600,
          localUsers: [{ username: "admin", passwordHash: sha256Hex("multi-pass") }],
        },
      })
    );
    try {
      const loginRes = await fetchJson(multiServer.port, "POST", "/api/auth/login", {
        username: "admin",
        password: "multi-pass",
      });
      assert.equal(loginRes.status, 200, "多根服务器登录前置条件失败");
      const multiCookie = extractAuthCookie(loginRes.headers)!;
      const multiNoPath = await fetchJson(multiServer.port, "GET", "/api/files?scope=shared", undefined, multiCookie);
      assert.equal(multiNoPath.status, 400, "多根牢笼空 path 必须保持 400");
      assert.match(multiNoPath.body.error, /缺少 path/);
    } finally {
      await multiServer.close();
    }
  } finally {
    rmSync(rootsDir, { recursive: true, force: true });
  }
});

test("files：allowRoots 为空时文件端点一律 403（文件功能禁用）", async () => {
  const emptyServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [],
      auth: {
        jwtSecret: "empty-jail-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: "admin", passwordHash: sha256Hex("empty-pass") }],
      },
    })
  );
  try {
    const login = await fetchJson(emptyServer.port, "POST", "/api/auth/login", {
      username: "admin",
      password: "empty-pass",
    });
    const emptyCookie = extractAuthCookie(login.headers)!;

    const list = await fetchJson(
      emptyServer.port,
      "GET",
      `/api/files?path=${encodeURIComponent(tmpdir())}`,
      undefined,
      emptyCookie
    );
    assert.equal(list.status, 403);
    assert.match(list.body.error, /allowRoots 未配置/);
  } finally {
    await emptyServer.close();
  }
});

test("files：超过 maxUploadBytes 的上传应 413", async () => {
  const limitServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [tmpRoot],
      // 单文件上限 1024：默认请求体总量上限 = maxUploadBytes × 2 = 2048，
      // 1100 字节文件（+multipart 协议开销约 100 字节）总量低于 2048，
      // 确保触发的是「单文件超限」检查而非总量检查（总量维度由 multipart.test.ts 专测）
      maxUploadBytes: 1024,
      auth: {
        jwtSecret: "limit-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: "admin", passwordHash: sha256Hex("limit-pass") }],
      },
    })
  );
  try {
    const login = await fetchJson(limitServer.port, "POST", "/api/auth/login", {
      username: "admin",
      password: "limit-pass",
    });
    const limitCookie = extractAuthCookie(login.headers)!;

    const targetDir = path.join(tmpRoot, "docs");
    const beforeCount = readdirSync(targetDir).length;
    const bigContent = Buffer.alloc(1100, 0x62);
    const body = buildMultipartBody("limitBOUNDARY", [{ name: "file", filename: "big.bin", data: bigContent }]);
    const response = await fetch(
      `http://127.0.0.1:${limitServer.port}/api/files/upload?path=${encodeURIComponent(targetDir)}`,
      {
        method: "POST",
        headers: { cookie: limitCookie, "content-type": 'multipart/form-data; boundary="limitBOUNDARY"' },
        body: new Uint8Array(body),
      }
    );
    assert.equal(response.status, 413);
    const errorBody = await response.json();
    assert.match(errorBody.error, /大小上限/);
    // 半成品清理：目标目录不得新增文件
    assert.equal(readdirSync(targetDir).length, beforeCount);
  } finally {
    await limitServer.close();
  }
});

// ============================================================================
// 文本文件预览（docs/dev/web-file-preview.md P1：GET /api/files/preview）
// ============================================================================

test("preview：UTF-8 文本应 200 且内容与磁盘一致（含 name/size/mtime/truncated 字段）", async () => {
  const filePath = path.join(tmpRoot, "docs", "report.md");
  const { status, body } = await fetchJson(
    server.port,
    "GET",
    `/api/files/preview?path=${encodeURIComponent(filePath)}`,
    undefined,
    cookie
  );

  assert.equal(status, 200);
  assert.equal(body.name, "report.md");
  assert.ok(body.path.endsWith("report.md"), "path 必须是归一后的文件绝对路径");
  assert.equal(body.text, "# report\n\n内容", "text 必须与磁盘 UTF-8 内容一致");
  assert.equal(body.size, Buffer.byteLength("# report\n\n内容", "utf8"));
  assert.equal(body.truncated, false, "限内文件 truncated 必须为 false");
  assert.ok(!Number.isNaN(Date.parse(body.mtime)), "mtime 必须是合法 ISO 时间");
});

test("preview：含 NUL 二进制应 415；非法 UTF-8 采样应 415", async () => {
  const binPath = path.join(tmpRoot, "binary.bin");
  writeFileSync(binPath, Buffer.concat([Buffer.from("PNG\u0000\u0000binary", "utf8"), Buffer.from([0x89, 0x50])]));
  const bin = await fetchJson(
    server.port,
    "GET",
    `/api/files/preview?path=${encodeURIComponent(binPath)}`,
    undefined,
    cookie
  );
  assert.equal(bin.status, 415);
  assert.match(bin.body.error, /二进制/);

  const badPath = path.join(tmpRoot, "bad-utf8.txt");
  // 0xff/0xfe 不是合法 UTF-8 起始字节——fatal 解码必须拒绝
  writeFileSync(badPath, Buffer.from([0xff, 0xfe, 0x41, 0x42]));
  const bad = await fetchJson(
    server.port,
    "GET",
    `/api/files/preview?path=${encodeURIComponent(badPath)}`,
    undefined,
    cookie
  );
  assert.equal(bad.status, 415);
  assert.match(bad.body.error, /UTF-8/);
});

test("preview：超过 maxPreviewBytes 应 413 引导下载；目录应 400；不存在应 404", async () => {
  const limitServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [tmpRoot],
      maxPreviewBytes: 64,
      auth: {
        jwtSecret: "preview-limit-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: "admin", passwordHash: sha256Hex("pv-pass") }],
      },
    })
  );
  try {
    const login = await fetchJson(limitServer.port, "POST", "/api/auth/login", {
      username: "admin",
      password: "pv-pass",
    });
    const pvCookie = extractAuthCookie(login.headers)!;

    const bigPath = path.join(tmpRoot, "big.txt");
    writeFileSync(bigPath, "字".repeat(100), "utf8"); // 300 字节 > 64
    const big = await fetchJson(
      limitServer.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(bigPath)}`,
      undefined,
      pvCookie
    );
    assert.equal(big.status, 413, "超限文件必须 413 引导下载");
    assert.match(big.body.error, /预览上限/);

    const dir = await fetchJson(
      limitServer.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(path.join(tmpRoot, "docs"))}`,
      undefined,
      pvCookie
    );
    assert.equal(dir.status, 400);

    const missing = await fetchJson(
      limitServer.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(path.join(tmpRoot, "ghost.txt"))}`,
      undefined,
      pvCookie
    );
    assert.equal(missing.status, 404);
  } finally {
    await limitServer.close();
  }
});

test("preview：牢笼越界应 403（白名单防护与 download 同链路）", async () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-pv-outside-"));
  try {
    const secretPath = path.join(outsideDir, "secret.txt");
    writeFileSync(secretPath, "top secret", "utf8");
    const { status, body } = await fetchJson(
      server.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(secretPath)}`,
      undefined,
      cookie
    );
    assert.equal(status, 403, "白名单外文件预览必须 403");
    assert.match(body.error, /白名单/);
    assert.ok(!JSON.stringify(body).includes("top secret"), "403 响应绝不能包含文件内容");
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("preview：多字节字符截断不得产生残缺尾（UTF-8 安全边界）", async () => {
  // 上限 67 字节：1 字节 ASCII 头 + 多字节中文，67 恰落中文字符中间
  const limitServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [tmpRoot],
      maxPreviewBytes: 67,
      auth: {
        jwtSecret: "preview-utf8-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: "admin", passwordHash: sha256Hex("pv8-pass") }],
      },
    })
  );
  try {
    const login = await fetchJson(limitServer.port, "POST", "/api/auth/login", {
      username: "admin",
      password: "pv8-pass",
    });
    const pvCookie = extractAuthCookie(login.headers)!;

    const path8 = path.join(tmpRoot, "utf8-edge.txt");
    writeFileSync(path8, "a中中中中中", "utf8"); // 1 + 5×3 = 16 字节 < 67，全量返回无截断
    const ok = await fetchJson(
      limitServer.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(path8)}`,
      undefined,
      pvCookie
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.text, "a中中中中中");
    assert.ok(!ok.body.text.includes("\uFFFD"), "全量文本绝不含替换符");

    // 边界两侧：67 字节（恰等于上限）全量 200；70 字节（超上限）必须 413
    const edgePath = path.join(tmpRoot, "utf8-trunc.txt");
    writeFileSync(edgePath, "a" + "中".repeat(22), "utf8"); // 1 + 22×3 = 67 字节整 → 200 全量
    const edge = await fetchJson(
      limitServer.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(edgePath)}`,
      undefined,
      pvCookie
    );
    assert.equal(edge.status, 200, "67 字节恰好等于上限（≤ 判定）须 200");

    const overPath = path.join(tmpRoot, "utf8-over.txt");
    writeFileSync(overPath, "a" + "中".repeat(23), "utf8"); // 1 + 23×3 = 70 字节 > 67 → 413
    const over = await fetchJson(
      limitServer.port,
      "GET",
      `/api/files/preview?path=${encodeURIComponent(overPath)}`,
      undefined,
      pvCookie
    );
    assert.equal(over.status, 413, "超过 maxPreviewBytes 的文件必须 413");
  } finally {
    await limitServer.close();
  }
});
