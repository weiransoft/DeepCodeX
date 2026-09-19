/**
 * 文件端点集成测试（真实 HTTP + 真实文件系统，docs/dev/web-ui.md §3.5）。
 *
 * 全链路：登录 → 目录浏览（排序/size/mtime）→ multipart 上传（字节一致）→
 * 下载（字节一致 + Content-Disposition）→ 牢笼越界 403 → 空白名单 403 →
 * 超限 413 → 目录不存在 404 / 非目录 400。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("files：缺 path 参数应 400", async () => {
  const noPath = await fetchJson(server.port, "GET", "/api/files", undefined, cookie);
  assert.equal(noPath.status, 400);
  assert.match(noPath.body.error, /缺少 path/);
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
