/**
 * multipart/form-data 流式解析器单元测试（src/multipart.ts）。
 *
 * 方式：手工按 RFC 7578 拼接真实字节 body，经真实 http server 接收后
 * 交给 parseMultipartRequest 解析（端到端真实 IO，无 mock 框架）。
 * 覆盖：单文件落盘字节一致、多文件+字段混合、boundary 前缀尾巴保留、
 * 单文件超限 413、字段超限 413、非 multipart 400、畸形 body 400、
 * 文件名穿越安全化、extractBoundary 两种形式。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBoundary, MultipartError, parseMultipartRequest, sanitizeFileName } from "../src/multipart";
import { buildMultipartBody, startCaptureServer } from "./helpers";

/** 每个用例独立的临时落盘目录（after 统一清理） */
const cleanupDirs: string[] = [];

after(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeUploadDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "deepcode-web-multipart-"));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * 通过真实 HTTP 服务解析一段 multipart body（接收端调用被测函数并回传 JSON 结果）。
 *
 * @param body 请求体字节
 * @param contentType Content-Type 头值
 * @param options parseMultipartRequest 选项（uploadDir 必填）
 * @returns { status, result?, error? }：result 为解析产物，error 为 { name, code?, message }
 */
async function parseViaHttp(
  body: Buffer,
  contentType: string,
  options: { uploadDir: string; maxUploadBytes: number; fieldLimitBytes?: number }
): Promise<{ status: number; result?: any; error?: { name: string; code?: string; message: string } }> {
  const server = await startCaptureServer((req, res) => {
    parseMultipartRequest(req, options)
      .then((result) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      })
      .catch((error: unknown) => {
        res.setHeader("content-type", "application/json");
        const code = error instanceof MultipartError ? error.code : undefined;
        res.end(
          JSON.stringify({
            ok: false,
            name: error instanceof Error ? error.name : "Error",
            code,
            message: error instanceof Error ? error.message : String(error),
          })
        );
      });
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(body),
    });
    const parsed = (await response.json()) as any;
    return {
      status: response.status,
      result: parsed.ok ? parsed.result : undefined,
      error: parsed.ok ? undefined : parsed,
    };
  } finally {
    await server.close();
  }
}

test("multipart：extractBoundary 支持带引号与裸 token 两种形式", () => {
  assert.equal(extractBoundary('multipart/form-data; boundary="abc123"'), "abc123");
  assert.equal(extractBoundary("multipart/form-data; boundary=abc123"), "abc123");
  assert.equal(extractBoundary("multipart/form-data; boundary=abc123; charset=utf-8"), "abc123");
  assert.equal(extractBoundary("application/json"), null);
  assert.equal(extractBoundary("multipart/form-data"), null, "缺 boundary 返回 null");
  assert.equal(extractBoundary(undefined), null);
});

test("multipart：sanitizeFileName 取 basename、去控制字符、兜底命名", () => {
  assert.equal(sanitizeFileName("report.pdf"), "report.pdf");
  assert.equal(sanitizeFileName("/etc/passwd"), "passwd", "Unix 路径穿越取 basename");
  assert.equal(sanitizeFileName("..\\..\\win.ini"), "win.ini", "Windows 反斜杠路径穿越取 basename");
  assert.equal(sanitizeFileName("a\x00b\x1fc.txt"), "abc.txt", "控制字符被移除");
  assert.equal(sanitizeFileName(""), "file", "空名兜底");
  assert.equal(sanitizeFileName("."), "file");
  assert.equal(sanitizeFileName(".."), "file");
});

test("multipart：单文件解析应落盘且字节一致", async () => {
  const uploadDir = makeUploadDir();
  const fileData = Buffer.from("PNG-image-bytes-\x89PNG\r\n\x1a\n-可以包含二进制", "utf8");
  const body = buildMultipartBody("sepBOUNDARY", [
    { name: "file", filename: "photo.png", contentType: "image/png", data: fileData },
  ]);

  const { result } = await parseViaHttp(body, 'multipart/form-data; boundary="sepBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024 * 1024,
  });

  assert.equal(result.files.length, 1);
  const file = result.files[0];
  assert.equal(file.fieldName, "file");
  assert.equal(file.originalName, "photo.png");
  assert.equal(file.mimeType, "image/png");
  assert.equal(file.size, fileData.length);
  // 落盘内容逐字节一致
  const saved = readFileSync(file.savedPath);
  assert.ok(saved.equals(fileData), "落盘字节必须与上传内容完全一致");
  // 落盘名在 uploadDir 内且为随机名（含安全化原名后缀）
  assert.ok(path.dirname(file.savedPath) === uploadDir);
  assert.ok(file.savedPath.endsWith("-photo.png"));
  assert.deepEqual(result.fields, {}, "无字段 part 时 fields 为空");
});

test("multipart：多文件 + 普通字段混合解析", async () => {
  const uploadDir = makeUploadDir();
  const dataA = Buffer.from("AAA-content");
  const dataB = Buffer.from("BBB-内容-内容");
  const body = buildMultipartBody("mixedBOUNDARY", [
    { name: "text", data: Buffer.from("看看这两个附件", "utf8") },
    { name: "file", filename: "a.txt", contentType: "text/plain", data: dataA },
    { name: "file", filename: "b.txt", contentType: "text/plain", data: dataB },
    { name: "payload", data: Buffer.from('{"k":"v"}', "utf8") },
  ]);

  const { result } = await parseViaHttp(body, 'multipart/form-data; boundary="mixedBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024 * 1024,
  });

  assert.equal(result.fields["text"], "看看这两个附件");
  assert.equal(result.fields["payload"], '{"k":"v"}');
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].originalName, "a.txt");
  assert.equal(result.files[1].originalName, "b.txt");
  assert.ok(readFileSync(result.files[0].savedPath).equals(dataA));
  assert.ok(readFileSync(result.files[1].savedPath).equals(dataB));
});

test("multipart：跨 chunk 边界的 boundary 前缀尾巴应正确保留（按 7 字节切片发送）", async () => {
  const uploadDir = makeUploadDir();
  const content = "0123456789".repeat(50); // 500 字节，非 7 的倍数，制造错位切分
  const body = buildMultipartBody("chunkBOUNDARY", [
    {
      name: "file",
      filename: "sliced.bin",
      contentType: "application/octet-stream",
      data: Buffer.from(content, "utf8"),
    },
  ]);

  // 用真实 socket 按 7 字节一片推送，保证 "\r\n--chunkBOUNDARY" 被切片打散
  const server = await startCaptureServer((req, res) => {
    parseMultipartRequest(req, { uploadDir, maxUploadBytes: 1024 * 1024 })
      .then((result) => res.end(JSON.stringify({ ok: true, result })))
      .catch((error: Error) => res.end(JSON.stringify({ ok: false, message: error.message })));
  });

  try {
    // 收集服务端响应（解析完成后 handler 会回 JSON），收到完整响应/连接关闭后再断言，消除竞态
    const responseText = await new Promise<string>((resolve, reject) => {
      let received = "";
      const socket = net.connect(server.port, "127.0.0.1", () => {
        const header =
          `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: multipart/form-data; boundary="chunkBOUNDARY"\r\n` +
          `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
        socket.write(header);
        let offset = 0;
        const timer = setInterval(() => {
          if (offset >= body.length) {
            clearInterval(timer);
            socket.end();
            return;
          }
          socket.write(body.subarray(offset, Math.min(offset + 7, body.length)));
          offset += 7;
        }, 1);
      });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(received));
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      // 兜底超时：防止异常情况下用例悬挂
      setTimeout(() => reject(new Error("切片用例 10 秒未收到服务端响应")), 10000).unref();
    });
    // 服务端响应必须为 200（解析成功），响应中应包含落盘文件名
    assert.match(
      responseText,
      /HTTP\/1\.1 200/,
      `服务端必须成功解析（响应前 200 字节：${responseText.slice(0, 200)}）`
    );
    assert.match(responseText, /sliced\.bin/, "解析结果应包含安全化后的文件名");

    // 直接读 uploadDir 验证：恰好一个文件、字节数与内容完全一致
    const files = [];
    for (const name of readdirSync(uploadDir)) {
      files.push({ path: path.join(uploadDir, name), size: statSync(path.join(uploadDir, name)).size });
    }
    assert.equal(files.length, 1, "切片发送后应恰好落盘一个文件");
    assert.equal(files[0].size, Buffer.byteLength(content), "跨 chunk 切片不得丢字节/多字节");
    assert.equal(readFileSync(files[0].path).toString("utf8"), content, "内容必须逐字节一致");
  } finally {
    await server.close();
  }
});

test("multipart：单文件超过 maxUploadBytes 应抛 PAYLOAD_TOO_LARGE（413）且清理半成品", async () => {
  const uploadDir = makeUploadDir();
  const data = Buffer.alloc(200, 0x61);
  const body = buildMultipartBody("overBOUNDARY", [{ name: "file", filename: "big.bin", data }]);

  // 显式放大总量上限（1024KB），隔离 P2 总量维度，专注单文件上限语义：
  // 200 字节文件 > maxUploadBytes=100，由 writeBody 的单文件检查触发 PAYLOAD_TOO_LARGE
  // （默认总量行为由独立用例「未显式配置 maxTotalBytes 时默认取 maxUploadBytes × 2」覆盖）
  const { error } = await parseViaHttp(body, 'multipart/form-data; boundary="overBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 100,
    maxTotalBytes: 1024 * 1024,
  });

  assert.ok(error, "必须抛错");
  assert.equal(error!.name, "MultipartError");
  assert.equal(error!.code, "PAYLOAD_TOO_LARGE");
  assert.match(error!.message, /大小上限/);
  // 半成品文件必须清理：目录内不得残留
  const { readdirSync } = await import("node:fs");
  assert.equal(readdirSync(uploadDir).length, 0, "超限中断后不得残留半成品文件");
});

test("multipart：普通字段超过 fieldLimitBytes 应抛 FIELD_TOO_LARGE", async () => {
  const uploadDir = makeUploadDir();
  const bigField = "x".repeat(200);
  const body = buildMultipartBody("fieldBOUNDARY", [{ name: "text", data: Buffer.from(bigField, "utf8") }]);

  const { error } = await parseViaHttp(body, 'multipart/form-data; boundary="fieldBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024 * 1024,
    fieldLimitBytes: 100,
  });

  assert.ok(error);
  assert.equal(error!.code, "FIELD_TOO_LARGE");
});

test("multipart：多个小文件合计超过 maxTotalBytes 应抛 PAYLOAD_TOO_LARGE（413）且清理半成品", async () => {
  const uploadDir = makeUploadDir();
  // 两个文件各 80 字节，均低于单文件上限 100，但合计 160 超过总量上限 150
  // （协议开销还会再叠加，确保总量必然越限）
  const dataA = Buffer.alloc(80, 0x61);
  const dataB = Buffer.alloc(80, 0x62);
  const body = buildMultipartBody("totalBOUNDARY", [
    { name: "file", filename: "a.bin", data: dataA },
    { name: "file", filename: "b.bin", data: dataB },
  ]);

  const { error } = await parseViaHttp(body, 'multipart/form-data; boundary="totalBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 100,
    maxTotalBytes: 150,
  });

  assert.ok(error, "合计超总量上限必须抛错");
  assert.equal(error!.name, "MultipartError");
  assert.equal(error!.code, "PAYLOAD_TOO_LARGE");
  assert.match(error!.message, /总量超过上限/);
  // 半成品文件必须清理：第一个文件虽已完整落盘，中断后目录内不得残留
  const { readdirSync } = await import("node:fs");
  assert.equal(readdirSync(uploadDir).length, 0, "总量超限中断后不得残留半成品文件");
});

test("multipart：未显式配置 maxTotalBytes 时默认取 maxUploadBytes × 2", async () => {
  const uploadDir = makeUploadDir();
  // 单文件 120 字节低于单文件上限 200，但 body 总量（120 + 协议开销）超过默认总量 400
  const data = Buffer.alloc(120, 0x63);
  const body = buildMultipartBody("defaultBOUNDARY", [
    { name: "file", filename: "c.bin", data },
    { name: "file", filename: "d.bin", data: Buffer.alloc(120, 0x64) },
  ]);

  const { error } = await parseViaHttp(body, 'multipart/form-data; boundary="defaultBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 200, // 默认总量 = 400；两个 120 字节文件 + 协议开销 > 400
  });

  assert.ok(error, "默认总量上限（maxUploadBytes × 2）必须生效");
  assert.equal(error!.code, "PAYLOAD_TOO_LARGE");
  assert.match(error!.message, /总量超过上限/);
});

test("multipart：非 multipart Content-Type 应抛 NOT_MULTIPART", async () => {
  const uploadDir = makeUploadDir();
  const { error } = await parseViaHttp(Buffer.from("{}"), "application/json", {
    uploadDir,
    maxUploadBytes: 1024,
  });

  assert.ok(error);
  assert.equal(error!.code, "NOT_MULTIPART");
  assert.equal(error!.name, "MultipartError");
});

test("multipart：畸形 body（缺结束符/boundary 后缺 CRLF）应抛 INVALID_MULTIPART", async () => {
  const uploadDir = makeUploadDir();

  // 用例 1：只有起始分隔符，无 headers 无结束符
  const truncated = Buffer.from(
    '--cutBOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\npartial',
    "utf8"
  );
  const r1 = await parseViaHttp(truncated, 'multipart/form-data; boundary="cutBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024,
  });
  assert.ok(r1.error, "数据流不完整必须抛错");
  assert.equal(r1.error!.code, "INVALID_MULTIPART");

  // 用例 2：boundary 后跟非法字节（非 CRLF/非 --）
  const badAfterBoundary = Buffer.from("--badBOUNDARYXX-no-crlf", "utf8");
  const r2 = await parseViaHttp(badAfterBoundary, 'multipart/form-data; boundary="badBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024,
  });
  assert.ok(r2.error);
  assert.equal(r2.error!.code, "INVALID_MULTIPART");
});

test("multipart：part 缺 Content-Disposition / name 应抛 INVALID_MULTIPART", async () => {
  const uploadDir = makeUploadDir();

  // 缺 Content-Disposition 头
  const noDisposition = Buffer.concat([
    Buffer.from("--nodispBOUNDARY\r\n", "utf8"),
    Buffer.from("X-Other: value\r\n\r\n", "utf8"),
    Buffer.from("body\r\n--nodispBOUNDARY--\r\n", "utf8"),
  ]);
  const r1 = await parseViaHttp(noDisposition, 'multipart/form-data; boundary="nodispBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024,
  });
  assert.ok(r1.error);
  assert.match(r1.error!.message, /Content-Disposition/);

  // 有 disposition 但缺 name
  const noName = Buffer.concat([
    Buffer.from("--nonameBOUNDARY\r\n", "utf8"),
    Buffer.from("Content-Disposition: form-data\r\n\r\n", "utf8"),
    Buffer.from("body\r\n--nonameBOUNDARY--\r\n", "utf8"),
  ]);
  const r2 = await parseViaHttp(noName, 'multipart/form-data; boundary="nonameBOUNDARY"', {
    uploadDir,
    maxUploadBytes: 1024,
  });
  assert.ok(r2.error);
  assert.match(r2.error!.message, /name/);
});
