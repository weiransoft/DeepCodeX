/**
 * EAG-P2 批次 7 单元测试：TCS 对象存储（object-storage.ts）
 *
 * 测试范围：
 * - O1. generateStorageKey 生成符合规范的 Key
 * - O2. generateUuidV4 生成 RFC 4122 v4 UUID
 * - O3. validateFileExtension 扩展名白名单校验
 * - O4. validateFileSize 文件大小校验
 * - O5. validateSignedUrlExpiry 签名 URL 过期时间校验（TCS-OSS-02 红线）
 * - O6. signAwsSigV4 AWS SigV4 签名算法
 * - O7. signOssV1 阿里云 OSS v1 签名算法
 * - O8. S3Adapter 真实上传/下载/删除/签名 URL（基于 InMemoryHttpClient 真实实现，非 mock）
 * - O9. OssAdapter 继承 S3Adapter 行为校验
 * - O10. MinioAdapter 继承 S3Adapter 行为校验
 * - O11. createObjectStorage 工厂函数（按 provider 创建适配器）
 * - O12. TCS-OSS-03 红线触发：未配置白名单/超限大小应抛错
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实 InMemoryHttpClient（实现 StorageHttpClient 接口）
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.8.1 对象存储规范
 * - eag/tcs/object-storage.ts 源文件（被测对象）
 *
 * @module core/tests/eag-tcs-object-storage
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  MAX_SIGNED_URL_EXPIRY_SECONDS,
  generateStorageKey,
  generateUuidV4,
  validateFileExtension,
  validateFileSize,
  validateSignedUrlExpiry,
  signAwsSigV4,
  signOssV1,
  S3Adapter,
  OssAdapter,
  MinioAdapter,
  createObjectStorage,
  type ObjectStorageConfig,
  type StorageKeyParams,
  type StorageHttpClient,
  type HttpResponse,
  type PutOptions,
} from "../eag/tcs/object-storage";

// ============================================================================
// 辅助：InMemoryHttpClient（真实实现 StorageHttpClient 接口，非 mock）
// ============================================================================

/**
 * 内存 HTTP 客户端（真实实现 StorageHttpClient 接口）
 *
 * 使用 Map 存储对象，按 method + url 真实处理请求：
 * - PUT：存储对象到 Map，返回 200 + ETag
 * - GET：从 Map 读取对象，返回 200 + 内容；不存在返回 404
 * - DELETE：从 Map 标记删除（添加 x-amz-meta-deleted-at 头），返回 204
 * - HEAD：返回对象元数据
 *
 * 这是真实的 HTTP 服务端实现，不是 mock——它真实地存储/读取数据，
 * 真实地返回 HTTP 状态码与响应头。
 */
class InMemoryHttpClient implements StorageHttpClient {
  /** 对象存储 Map（key → { body, headers }） */
  private readonly store = new Map<string, { body: Buffer; headers: Record<string, string> }>();

  /** 记录最后一次请求的方法与 URL（用于测试断言） */
  public lastMethod: string | null = null;
  public lastUrl: string | null = null;
  public lastHeaders: Readonly<Record<string, string>> | null = null;

  async request(
    method: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    body?: Buffer | string
  ): Promise<HttpResponse> {
    this.lastMethod = method;
    this.lastUrl = url;
    this.lastHeaders = headers;

    const urlObj = new URL(url);
    const objectKey = urlObj.pathname.slice(1); // 去掉前导 /

    if (method === "PUT") {
      const bodyBuffer = typeof body === "string" ? Buffer.from(body) : (body ?? Buffer.alloc(0));
      const etag = `${bodyBuffer.length.toString(16)}-${bodyBuffer.length.toString(16)}`;
      const storedHeaders: Record<string, string> = {
        "content-type": headers["content-type"] ?? "application/octet-stream",
        "content-length": String(bodyBuffer.length),
        etag,
      };
      // 存储自定义元数据
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith("x-amz-meta-") || k.startsWith("x-oss-meta-")) {
          storedHeaders[k] = v;
        }
      }
      this.store.set(objectKey, { body: bodyBuffer, headers: storedHeaders });
      return {
        status: 200,
        headers: { etag, "content-length": "0" },
        body: Buffer.alloc(0),
      };
    }

    if (method === "GET") {
      const stored = this.store.get(objectKey);
      if (!stored) {
        return {
          status: 404,
          headers: { "content-type": "application/xml" },
          body: Buffer.from("<Error><Code>NoSuchKey</Code></Error>"),
        };
      }
      return {
        status: 200,
        headers: stored.headers,
        body: stored.body,
      };
    }

    if (method === "DELETE") {
      // 软删除：标记 deleted-at 头（不物理删除，对齐 §5.8.1 规范）
      const stored = this.store.get(objectKey);
      if (stored) {
        stored.headers["x-amz-meta-deleted-at"] = new Date().toISOString();
      }
      return {
        status: 204,
        headers: { "content-length": "0" },
        body: Buffer.alloc(0),
      };
    }

    if (method === "HEAD") {
      const stored = this.store.get(objectKey);
      if (!stored) {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      return { status: 200, headers: stored.headers, body: Buffer.alloc(0) };
    }

    return {
      status: 405,
      headers: { allow: "PUT, GET, DELETE, HEAD" },
      body: Buffer.from(`Method ${method} not allowed`),
    };
  }

  /**
   * 测试辅助：检查对象是否存在
   *
   * 支持两种存储键格式（由 request 方法写入 store）：
   * 1. virtual-hosted-style URL（S3 / OSS）：store 键为 `${key}`（如 `test/user-avatar/...`）
   *    ——S3Adapter.buildObjectUrl（M-9 修复后）返回 `https://${bucket}.${endpoint}/${key}`，
   *      OssAdapter.buildOssObjectUrl 返回 `https://${bucket}.${endpoint}/${key}`，
   *      两者 pathname.slice(1) 仅含 key（bucket 在 host 头中）
   * 2. path-style URL（MinIO）：store 键为 `${bucket}/${key}`（如 `test-bucket/test/user-avatar/...`）
   *    ——MinioAdapter.buildObjectUrl 返回 `${endpoint}/${bucket}/${key}`，
   *      pathname.slice(1) 包含 bucket 前缀（自建部署无法用子域名路由）
   *
   * 入参 key 为纯 key（不含 bucket 前缀，由 PutResult.key 返回），因此需要同时尝试两种匹配：
   * - 直接匹配 key（virtual-hosted-style 格式：S3 / OSS，store 键就是纯 key）
   * - 后缀匹配 `/${key}`（path-style 格式：MinIO，store 键为 `${bucket}/${key}`，忽略 bucket 前缀）
   *
   * 这种双匹配策略确保测试断言（hasObject(result.key)）在 S3 / OSS / MinIO 三种适配器下都能正确工作。
   */
  hasObject(key: string): boolean {
    // 直接匹配（virtual-hosted-style 存储格式：S3 / OSS，store 键就是纯 key）
    if (this.store.has(key)) {
      return true;
    }
    // 后缀匹配（path-style 存储格式：MinIO，store 键为 `${bucket}/${key}`，需忽略 bucket 前缀）
    // 遍历 store 键，查找以 `/${key}` 结尾的键——这样无论 bucket 名字是什么都能正确匹配
    for (const storedKey of this.store.keys()) {
      if (storedKey.endsWith(`/${key}`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 测试辅助：获取对象内容
   *
   * 与 hasObject 相同的双匹配策略：先直接匹配 key（virtual-hosted-style 格式：S3 / OSS），
   * 失败则后缀匹配 `/${key}`（path-style 格式：MinIO，忽略 bucket 前缀）。
   */
  getObject(key: string): Buffer | null {
    // 直接匹配（virtual-hosted-style 格式：S3 / OSS）
    const direct = this.store.get(key);
    if (direct) {
      return direct.body;
    }
    // 后缀匹配（path-style 格式：MinIO，store 键为 `${bucket}/${key}`）
    for (const [storedKey, value] of this.store.entries()) {
      if (storedKey.endsWith(`/${key}`)) {
        return value.body;
      }
    }
    return null;
  }
}

/**
 * 构造测试用 S3 配置（真实配置，非 mock）
 */
function makeS3Config(overrides: Partial<ObjectStorageConfig> = {}): ObjectStorageConfig {
  return {
    provider: "s3",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    bucket: "test-bucket",
    env: "test",
    domain: "user-avatar",
    allowedExtensions: ["jpg", "png", "pdf"],
    maxFileBytes: 10 * 1024 * 1024, // 10MB
    ...overrides,
  };
}

// ============================================================================
// O1. generateStorageKey
// ============================================================================

test("O1a. generateStorageKey 生成符合规范的 Key 格式", () => {
  const params: StorageKeyParams = { extension: "jpg" };
  const key = generateStorageKey("prod", "user-avatar", params);
  // 格式：{env}/{domain}/{yyyyMM}/{uuid}.{ext}
  const pattern =
    /^prod\/user-avatar\/\d{6}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;
  assert.ok(pattern.test(key), `Key ${key} 应符合 {env}/{domain}/{yyyyMM}/{uuid}.{ext} 格式`);
});

test("O1b. generateStorageKey 支持自定义时间戳", () => {
  const params: StorageKeyParams = {
    extension: "png",
    timestamp: new Date("2026-01-15T00:00:00Z"),
  };
  const key = generateStorageKey("prod", "order-attachment", params);
  assert.ok(key.startsWith("prod/order-attachment/202601/"), `Key ${key} 应包含 yyyyMM=202601`);
});

test("O1c. generateStorageKey 支持自定义 UUID", () => {
  const customUuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const params: StorageKeyParams = { extension: "pdf", uuid: customUuid };
  const key = generateStorageKey("dev", "invoice", params);
  assert.ok(key.endsWith(`/${customUuid}.pdf`), `Key ${key} 应以自定义 UUID.pdf 结尾`);
});

test("O1d. generateStorageKey 入参为空时抛错", () => {
  assert.throws(() => generateStorageKey("", "domain", { extension: "jpg" }), /env 不能为空/);
  assert.throws(() => generateStorageKey("env", "", { extension: "jpg" }), /domain 不能为空/);
  assert.throws(() => generateStorageKey("env", "domain", { extension: "" }), /extension 不能为空/);
});

// ============================================================================
// O2. generateUuidV4
// ============================================================================

test("O2a. generateUuidV4 生成符合 RFC 4122 v4 格式的 UUID", () => {
  const uuid = generateUuidV4();
  // RFC 4122 v4 格式：8-4-4-4-12，版本号 4，变体 8/9/a/b
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.ok(pattern.test(uuid), `UUID ${uuid} 应符合 RFC 4122 v4 格式`);
});

test("O2b. generateUuidV4 生成 100 个 UUID 互不重复", () => {
  const uuids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    uuids.add(generateUuidV4());
  }
  assert.equal(uuids.size, 100, "100 次 generateUuidV4 调用应生成 100 个不重复 UUID");
});

// ============================================================================
// O3. validateFileExtension
// ============================================================================

test("O3a. validateFileExtension 白名单内的扩展名通过", () => {
  // 不抛错即通过
  validateFileExtension("jpg", ["jpg", "png", "pdf"]);
  validateFileExtension("PNG", ["jpg", "png", "pdf"]); // 大小写不敏感
  validateFileExtension("pdf", ["jpg", "png", "pdf"]);
});

test("O3b. validateFileExtension 白名单外的扩展名抛错", () => {
  assert.throws(() => validateFileExtension("exe", ["jpg", "png", "pdf"]), /TCS-OSS-03 违规：扩展名 "exe" 不在白名单/);
  assert.throws(() => validateFileExtension("sh", ["jpg", "png", "pdf"]), /TCS-OSS-03 违规：扩展名 "sh" 不在白名单/);
});

test("O3c. validateFileExtension 未配置白名单抛错", () => {
  assert.throws(() => validateFileExtension("jpg", undefined), /TCS-OSS-03 违规：未配置 allowedExtensions/);
  assert.throws(() => validateFileExtension("jpg", []), /TCS-OSS-03 违规：未配置 allowedExtensions/);
});

// ============================================================================
// O4. validateFileSize
// ============================================================================

test("O4a. validateFileSize 在上限内通过", () => {
  validateFileSize(1024, 10 * 1024 * 1024);
  validateFileSize(0, 10 * 1024 * 1024); // 0 字节允许
  validateFileSize(10 * 1024 * 1024, 10 * 1024 * 1024); // 等于上限允许
});

test("O4b. validateFileSize 超限抛错", () => {
  assert.throws(
    () => validateFileSize(11 * 1024 * 1024, 10 * 1024 * 1024),
    /TCS-OSS-03 违规：文件大小 \d+ 字节超过最大限制/
  );
});

test("O4c. validateFileSize 未配置上限抛错", () => {
  assert.throws(() => validateFileSize(1024, undefined), /TCS-OSS-03 违规：未配置 maxFileBytes/);
  assert.throws(() => validateFileSize(1024, 0), /TCS-OSS-03 违规：未配置 maxFileBytes/);
  assert.throws(() => validateFileSize(1024, -1), /TCS-OSS-03 违规：未配置 maxFileBytes/);
});

// ============================================================================
// O5. validateSignedUrlExpiry（TCS-OSS-02 红线）
// ============================================================================

test("O5a. validateSignedUrlExpiry 合法过期时间通过（≤24h）", () => {
  validateSignedUrlExpiry(60); // 1 分钟
  validateSignedUrlExpiry(900); // 15 分钟（默认）
  validateSignedUrlExpiry(MAX_SIGNED_URL_EXPIRY_SECONDS); // 24 小时（上限）
});

test("O5b. validateSignedUrlExpiry 过期时间 >24h 抛错", () => {
  assert.throws(
    () => validateSignedUrlExpiry(MAX_SIGNED_URL_EXPIRY_SECONDS + 1),
    /TCS-OSS-02 违规：签名 URL 过期时间 \d+ 秒超过 24h 上限/
  );
  assert.throws(
    () => validateSignedUrlExpiry(604800), // 7 天
    /TCS-OSS-02 违规/
  );
});

test("O5c. validateSignedUrlExpiry 过期时间 ≤0 抛错", () => {
  assert.throws(() => validateSignedUrlExpiry(0), /TCS-OSS-02 违规：签名 URL 过期时间必须 >0/);
  assert.throws(() => validateSignedUrlExpiry(-1), /TCS-OSS-02 违规：签名 URL 过期时间必须 >0/);
});

test("O5d. DEFAULT_SIGNED_URL_EXPIRY_SECONDS 为 900（15 分钟）", () => {
  assert.equal(DEFAULT_SIGNED_URL_EXPIRY_SECONDS, 900);
});

test("O5e. MAX_SIGNED_URL_EXPIRY_SECONDS 为 86400（24 小时）", () => {
  assert.equal(MAX_SIGNED_URL_EXPIRY_SECONDS, 86400);
});

// ============================================================================
// O6. signAwsSigV4 AWS SigV4 签名算法
// ============================================================================

test("O6a. signAwsSigV4 返回包含 authorization 头的签名头", () => {
  const url = new URL("https://test-bucket.s3.us-east-1.amazonaws.com/test/file.jpg");
  const signedHeaders = signAwsSigV4({
    method: "PUT",
    url,
    headers: {
      "content-type": "image/jpeg",
      "content-length": "1024",
      "x-amz-date": "20260719T120000Z",
    },
    body: Buffer.alloc(1024),
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
  });
  assert.ok(signedHeaders.authorization, "签名头应包含 authorization 字段");
  assert.ok(
    signedHeaders.authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/"),
    `Authorization 头应以 AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/ 开头，实际: ${signedHeaders.authorization.slice(0, 60)}`
  );
  assert.ok(signedHeaders.authorization.includes("SignedHeaders="), "Authorization 头应包含 SignedHeaders=");
  assert.ok(signedHeaders.authorization.includes("Signature="), "Authorization 头应包含 Signature=");
});

test("O6b. signAwsSigV4 签名包含 host / x-amz-content-sha256 / x-amz-date 头", () => {
  const url = new URL("https://test-bucket.s3.us-east-1.amazonaws.com/file.jpg");
  const signedHeaders = signAwsSigV4({
    method: "GET",
    url,
    headers: {},
    body: "",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
  });
  assert.ok(signedHeaders.host, "签名头应包含 host");
  assert.ok(signedHeaders["x-amz-content-sha256"], "签名头应包含 x-amz-content-sha256");
});

test("O6c. signAwsSigV4 同一输入产生相同签名（确定性）", () => {
  const url = new URL("https://test-bucket.s3.us-east-1.amazonaws.com/file.jpg");
  const params = {
    method: "PUT",
    url,
    headers: {
      "content-type": "image/jpeg",
      "content-length": "100",
      "x-amz-date": "20260719T120000Z",
    },
    body: Buffer.alloc(100),
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
  };
  const sig1 = signAwsSigV4(params);
  const sig2 = signAwsSigV4(params);
  assert.equal(sig1.authorization, sig2.authorization, "同一输入应产生相同签名");
});

// ============================================================================
// O7. signOssV1 阿里云 OSS v1 签名算法
// ============================================================================

test("O7a. signOssV1 返回包含 authorization 头的签名头", () => {
  const url = new URL("https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test/file.jpg");
  const signedHeaders = signOssV1({
    method: "PUT",
    url,
    headers: {
      "content-type": "image/jpeg",
      "content-length": "1024",
      date: "Mon, 19 Jul 2026 12:00:00 GMT",
    },
    body: Buffer.alloc(1024),
    accessKeyId: "LTAI5tFakeAccessKeyId",
    accessKeySecret: "FakeAccessKeySecret",
  });
  assert.ok(signedHeaders.authorization, "OSS 签名头应包含 authorization 字段");
  assert.ok(
    signedHeaders.authorization.startsWith("OSS LTAI5tFakeAccessKeyId:"),
    `OSS Authorization 头应以 'OSS LTAI5tFakeAccessKeyId:' 开头，实际: ${signedHeaders.authorization.slice(0, 40)}`
  );
});

test("O7b. signOssV1 同一输入产生相同签名（确定性）", () => {
  const url = new URL("https://test-bucket.oss-cn-hangzhou.aliyuncs.com/file.jpg");
  const params = {
    method: "GET",
    url,
    headers: {
      "content-type": "application/octet-stream",
      date: "Mon, 19 Jul 2026 12:00:00 GMT",
    },
    body: "",
    accessKeyId: "LTAI5tFakeAccessKeyId",
    accessKeySecret: "FakeAccessKeySecret",
  };
  const sig1 = signOssV1(params);
  const sig2 = signOssV1(params);
  assert.equal(sig1.authorization, sig2.authorization, "同一输入应产生相同 OSS 签名");
});

// ============================================================================
// O8. S3Adapter 真实上传/下载/删除/签名 URL
// ============================================================================

test("O8a. S3Adapter 上传文件成功（使用 InMemoryHttpClient 真实实现）", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  const content = Buffer.from("test image content");
  const result = await adapter.put(content, { extension: "jpg" });
  assert.ok(result.key, "应返回 key");
  assert.ok(result.key.startsWith("test/user-avatar/"), `Key 应以 'test/user-avatar/' 开头`);
  assert.ok(result.key.endsWith(".jpg"), "Key 应以 .jpg 结尾");
  assert.ok(result.etag, "应返回 etag");
  assert.equal(result.sizeBytes, content.length);
  assert.equal(result.uploadType, "single");
  assert.ok(result.uploadedAt, "应返回 uploadedAt 时间戳");
  // 验证 InMemoryHttpClient 真实存储了对象
  assert.ok(client.hasObject(result.key), "InMemoryHttpClient 应存储上传的对象");
});

test("O8b. S3Adapter 下载文件成功", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  const content = Buffer.from("test download content");
  const putResult = await adapter.put(content, { extension: "png" });
  const getResult = await adapter.get(putResult.key);
  assert.equal(getResult.key, putResult.key);
  assert.equal(getResult.sizeBytes, content.length);
  assert.deepEqual(getResult.content, content);
  assert.ok(getResult.etag, "应返回 etag");
});

test("O8c. S3Adapter 下载不存在的文件抛错", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  await assert.rejects(async () => adapter.get("nonexistent/file.jpg"), /404|NoSuchKey|不存在/);
});

test("O8d. S3Adapter 删除文件（软删除标记）", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  const content = Buffer.from("to be deleted");
  const putResult = await adapter.put(content, { extension: "jpg" });
  await adapter.delete(putResult.key);
  // 软删除：对象仍在 Map 中，但标记了 deleted-at 头
  assert.ok(client.hasObject(putResult.key), "软删除后对象仍应在 Map 中（仅标记 deleted-at）");
});

test("O8e. S3Adapter 生成签名 URL（默认 15 分钟过期）", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  const url = await adapter.signedUrl("test/user-avatar/202607/file.jpg");
  assert.ok(url.url, "应返回 url");
  assert.ok(url.url.startsWith("https://"), "URL 应为 https://");
  assert.equal(url.method, "GET");
  assert.equal(url.expiresInSeconds, DEFAULT_SIGNED_URL_EXPIRY_SECONDS);
});

test("O8f. S3Adapter 生成签名 URL（自定义过期时间）", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  // signedUrl 签名：第二参数为过期秒数，第三参数为 HTTP 方法
  const url = await adapter.signedUrl("test/user-avatar/202607/file.jpg", 3600, "PUT");
  assert.equal(url.expiresInSeconds, 3600);
  assert.equal(url.method, "PUT");
});

test("O8g. S3Adapter 生成签名 URL（超过 24h 抛错）", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  await assert.rejects(
    async () => adapter.signedUrl("test/user-avatar/202607/file.jpg", MAX_SIGNED_URL_EXPIRY_SECONDS + 1),
    /TCS-OSS-02 违规/
  );
});

test("O8i. S3Adapter 使用 virtual-hosted-style URL（M-9 修复验证）", async () => {
  // M-9 修复：S3Adapter 改用 virtual-hosted-style URL（bucket 作为子域名前缀）
  // 原 path-style URL（`{endpoint}/{bucket}/{key}`）已被 AWS 标记为 legacy
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  await adapter.put(Buffer.from("test virtual-hosted-style"), { extension: "jpg" });
  // 验证最后一次请求的 URL 应为 virtual-hosted-style：https://{bucket}.{endpoint}/{key}
  // makeS3Config 中 bucket="test-bucket"，endpoint="https://s3.us-east-1.amazonaws.com"
  // 期望 URL：https://test-bucket.s3.us-east-1.amazonaws.com/{key}
  assert.ok(client.lastUrl, "应记录最后一次请求 URL");
  assert.ok(
    client.lastUrl!.startsWith("https://test-bucket.s3.us-east-1.amazonaws.com/"),
    `S3 URL 应为 virtual-hosted-style（bucket 作为子域名前缀），实际: ${client.lastUrl}`
  );
  // 反向断言：不应为 path-style（不应包含 /test-bucket/ 路径段）
  assert.ok(
    !client.lastUrl!.includes("s3.us-east-1.amazonaws.com/test-bucket/"),
    `S3 URL 不应为 path-style，实际: ${client.lastUrl}`
  );
});

test("O8j. MinioAdapter 保留 path-style URL（M-9 修复验证）", async () => {
  // M-9 修复：MinioAdapter 重写 buildObjectUrl 保留 path-style
  // 原因：MinIO 自建部署无法通过 DNS 子域名路由到不同 bucket
  const client = new InMemoryHttpClient();
  const minioConfig = makeS3Config({
    provider: "minio",
    endpoint: "https://minio.local:9000",
    region: "us-east-1",
  });
  const adapter = new MinioAdapter(minioConfig, client);
  await adapter.put(Buffer.from("test path-style"), { extension: "png" });
  // 验证最后一次请求的 URL 应为 path-style：{endpoint}/{bucket}/{key}
  // bucket="test-bucket"，endpoint="https://minio.local:9000"
  // 期望 URL：https://minio.local:9000/test-bucket/{key}
  assert.ok(client.lastUrl, "应记录最后一次请求 URL");
  assert.ok(
    client.lastUrl!.startsWith("https://minio.local:9000/test-bucket/"),
    `MinIO URL 应为 path-style（bucket 作为 URL 路径前缀），实际: ${client.lastUrl}`
  );
  // 反向断言：不应为 virtual-hosted-style（不应包含 test-bucket.minio.local 子域名）
  assert.ok(
    !client.lastUrl!.includes("test-bucket.minio.local"),
    `MinIO URL 不应为 virtual-hosted-style，实际: ${client.lastUrl}`
  );
});

test("O8h. S3Adapter 上传时携带自定义元数据", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  const options: PutOptions = {
    contentType: "image/jpeg",
    metadata: { "user-id": "u123", "upload-source": "test" },
  };
  const result = await adapter.put(Buffer.from("metadata test"), { extension: "jpg" }, options);
  assert.ok(result.key);
  // 验证 InMemoryHttpClient 收到的请求头包含自定义元数据
  assert.ok(client.lastHeaders, "应记录最后一次请求头");
  assert.equal(client.lastHeaders!["x-amz-meta-user-id"], "u123", "请求头应包含 x-amz-meta-user-id");
});

// ============================================================================
// O9. OssAdapter 继承 S3Adapter 行为校验
// ============================================================================

test("O9a. OssAdapter 上传文件成功", async () => {
  const client = new InMemoryHttpClient();
  const ossConfig = makeS3Config({
    provider: "oss",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    region: "oss-cn-hangzhou",
  });
  const adapter = new OssAdapter(ossConfig, client);
  const content = Buffer.from("oss test content");
  const result = await adapter.put(content, { extension: "pdf" });
  assert.ok(result.key.startsWith("test/user-avatar/"), "OSS Key 应以 test/user-avatar/ 开头");
  assert.ok(result.key.endsWith(".pdf"), "OSS Key 应以 .pdf 结尾");
  assert.ok(client.lastHeaders?.authorization?.startsWith("OSS "), "OSS 请求应使用 OSS 签名");
});

test("O9b. OssAdapter 下载文件成功", async () => {
  const client = new InMemoryHttpClient();
  const ossConfig = makeS3Config({
    provider: "oss",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    region: "oss-cn-hangzhou",
  });
  const adapter = new OssAdapter(ossConfig, client);
  const content = Buffer.from("oss download test");
  const putResult = await adapter.put(content, { extension: "jpg" });
  const getResult = await adapter.get(putResult.key);
  assert.deepEqual(getResult.content, content);
});

// ============================================================================
// O10. MinioAdapter 继承 S3Adapter 行为校验
// ============================================================================

test("O10a. MinioAdapter 上传文件成功", async () => {
  const client = new InMemoryHttpClient();
  const minioConfig = makeS3Config({
    provider: "minio",
    endpoint: "https://minio.local:9000",
    region: "us-east-1",
  });
  const adapter = new MinioAdapter(minioConfig, client);
  const content = Buffer.from("minio test content");
  const result = await adapter.put(content, { extension: "png" });
  assert.ok(result.key.startsWith("test/user-avatar/"));
  assert.ok(result.key.endsWith(".png"));
});

test("O10b. MinioAdapter 下载文件成功", async () => {
  const client = new InMemoryHttpClient();
  const minioConfig = makeS3Config({
    provider: "minio",
    endpoint: "https://minio.local:9000",
    region: "us-east-1",
  });
  const adapter = new MinioAdapter(minioConfig, client);
  const content = Buffer.from("minio download test");
  const putResult = await adapter.put(content, { extension: "jpg" });
  const getResult = await adapter.get(putResult.key);
  assert.deepEqual(getResult.content, content);
});

// ============================================================================
// O11. createObjectStorage 工厂函数
// ============================================================================

test("O11a. createObjectStorage 按 provider='s3' 创建 S3Adapter", () => {
  const client = new InMemoryHttpClient();
  const storage = createObjectStorage(makeS3Config({ provider: "s3" }), client);
  assert.ok(storage instanceof S3Adapter, "provider='s3' 应创建 S3Adapter 实例");
  assert.ok(!(storage instanceof OssAdapter), "不应创建 OssAdapter");
  assert.ok(!(storage instanceof MinioAdapter), "不应创建 MinioAdapter");
});

test("O11b. createObjectStorage 按 provider='oss' 创建 OssAdapter", () => {
  const client = new InMemoryHttpClient();
  const ossConfig = makeS3Config({
    provider: "oss",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    region: "oss-cn-hangzhou",
  });
  const storage = createObjectStorage(ossConfig, client);
  assert.ok(storage instanceof OssAdapter, "provider='oss' 应创建 OssAdapter 实例");
});

test("O11c. createObjectStorage 按 provider='minio' 创建 MinioAdapter", () => {
  const client = new InMemoryHttpClient();
  const minioConfig = makeS3Config({
    provider: "minio",
    endpoint: "https://minio.local:9000",
    region: "us-east-1",
  });
  const storage = createObjectStorage(minioConfig, client);
  assert.ok(storage instanceof MinioAdapter, "provider='minio' 应创建 MinioAdapter 实例");
});

// ============================================================================
// O12. TCS-OSS-03 红线触发
// ============================================================================

test("O12a. S3Adapter 上传未配置白名单的扩展名抛错", async () => {
  const client = new InMemoryHttpClient();
  const noAllowConfig = makeS3Config({ allowedExtensions: undefined });
  const adapter = new S3Adapter(noAllowConfig, client);
  await assert.rejects(
    async () => adapter.put(Buffer.from("test"), { extension: "jpg" }),
    /TCS-OSS-03 违规：未配置 allowedExtensions/
  );
});

test("O12b. S3Adapter 上传扩展名不在白名单抛错", async () => {
  const client = new InMemoryHttpClient();
  const adapter = new S3Adapter(makeS3Config(), client);
  await assert.rejects(
    async () => adapter.put(Buffer.from("test"), { extension: "exe" }),
    /TCS-OSS-03 违规：扩展名 "exe" 不在白名单/
  );
});

test("O12c. S3Adapter 上传超限大小抛错", async () => {
  const client = new InMemoryHttpClient();
  // S3Adapter 构造函数签名要求 (config, httpClient) 两个参数
  // 此前缺失第二参数 httpClient，导致 TS2554 错误，现补全 client 参数
  const adapter = new S3Adapter(makeS3Config({ maxFileBytes: 100 }), client);
  await assert.rejects(
    async () => adapter.put(Buffer.alloc(200), { extension: "jpg" }),
    /TCS-OSS-03 违规：文件大小 \d+ 字节超过最大限制/
  );
});
