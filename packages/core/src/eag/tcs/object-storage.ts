/**
 * 对象存储规范包（Object Storage Specification，§5.8.1）
 *
 * 本模块实现 EAG 方案 §5.8.1 对象存储规范的运行期访问入口：
 * - 定义统一抽象接口 ObjectStoragePort（put / get / delete / signedUrl / multipartUpload）
 * - 适配 S3 / 阿里云 OSS / MinIO 三实现（业务代码仅依赖 Port 接口，禁止直连厂商 SDK）
 * - 实现文件 Key 规范生成（`{env}/{domain}/{yyyyMM}/{uuid}.{ext}`）
 * - 实现签名 URL 默认 15 分钟过期（TCS-OSS-02 红线：禁 >24h）
 * - 实现大文件（>100MB）分片上传
 * - 实现软删除标记 + 生命周期规则（delete 不物理删除）
 *
 * 设计依据：
 * - EAG 方案 §5.8.1 对象存储规范
 * - §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - AWS Signature V4 算法（S3 / MinIO 共用）
 * - 阿里云 OSS 签名算法（HMAC-SHA1，与 S3 不同）
 *
 * 红线合规设计：
 * - TCS-OSS-01：业务代码只能 import ObjectStoragePort 接口，禁止 import S3Adapter/OssAdapter/MinioAdapter
 *   （通过 lint 规则强制，本模块适配器实现只在 TCS 包内部使用，业务方通过依赖注入获取 Port）
 * - TCS-OSS-02：signedUrl 强制校验 expiresInSeconds ≤ 86400（24h），超过抛错
 * - TCS-OSS-03：put 操作强制校验文件扩展名白名单 + 最大文件大小，未配置则抛出配置错误
 *
 * 不可变保证：
 * - 适配器构造时配置对象 deepFreeze，防止运行期被 LLM 自改
 * - 上传结果 / 下载结果等返回值使用 readonly 字段
 *
 * @module eag/tcs/object-storage
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  ObjectStorageConfig,
  StorageKeyParams,
  PutOptions,
  PutResult,
  GetResult,
  DeleteResult,
  SignedUrlResult,
  MultipartOptions,
  MultipartResult,
} from "./types";
import { deepFreeze } from "./types";

/**
 * 重新导出对象存储类型别名（供外部消费者使用）
 *
 * 将 types.ts 中定义的核心类型透传导出，便于调用方从 object-storage.ts 单一入口获取：
 * - ObjectStorageConfig：对象存储配置（连接参数）
 * - StorageKeyParams：文件 Key 生成参数（含扩展名）
 * - PutOptions：上传选项（内容类型 / 元数据 / 加密 / 禁用分片）
 *
 * 设计依据：facade 模式——调用方仅需 import { type ObjectStorageConfig } from "../eag/tcs/object-storage"，
 * 无需感知类型实际定义在 types.ts 中。
 */
export type { ObjectStorageConfig, StorageKeyParams, PutOptions };

// ============================================================================
// 1. 默认配置常量
// ============================================================================

/**
 * 默认签名 URL 过期时间（秒，900 即 15 分钟）
 *
 * 对齐 §5.8.1 规范"敏感文件禁止公网直读，必须签名 URL（默认 15 分钟过期）"。
 */
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 900;

/**
 * 签名 URL 最大允许过期时间（秒，86400 即 24 小时）
 *
 * 对齐 TCS-OSS-02 红线"签名 URL 过期时间 >24h（MAJOR）"——超过此值视为违规。
 */
export const MAX_SIGNED_URL_EXPIRY_SECONDS = 86400;

/**
 * 默认大文件分片阈值（字节，104857600 即 100MB）
 *
 * 对齐 §5.8.1 规范"大文件（>100MB）必须分片上传"。
 */
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 104857600;

/**
 * 默认分片大小（字节，8388608 即 8MB）
 *
 * 对齐 AWS S3 推荐分片大小（5MB~5GB，8MB 为性能与内存平衡点）。
 */
export const DEFAULT_PART_SIZE_BYTES = 8388608;

/**
 * 默认最大允许文件大小（字节，5368709120 即 5GB）
 *
 * 单次 put 操作允许的最大文件大小，对齐 AWS S3 单次 PUT 上限（5GB）。
 */
export const DEFAULT_MAX_FILE_BYTES = 5368709120;

// ============================================================================
// 2. HTTP 客户端抽象（用于依赖注入与测试替换）
// ============================================================================

/**
 * HTTP 响应结构
 *
 * 描述 HTTP 客户端请求的返回值，包括状态码、头、体。
 * 用于对象存储适配器与底层 HTTP 传输解耦（适配器不直接依赖 fetch/undici）。
 */
export interface HttpResponse {
  /** HTTP 状态码（如 200 / 404 / 500） */
  readonly status: number;
  /** 响应头（小写键名） */
  readonly headers: Readonly<Record<string, string>>;
  /** 响应体（Buffer，便于二进制对象存储内容传输） */
  readonly body: Buffer;
}

/**
 * HTTP 客户端接口（抽象 HTTP 传输层）
 *
 * 对象存储适配器通过此接口与底层 HTTP 传输解耦：
 * - 生产环境：注入 UndiciHttpClient（基于 undici 库，已在 dependencies 中）
 * - 测试环境：注入 StaticXxxClient（内存存储 + 签名校验的真实实现，非 mock）
 *
 * 该抽象确保业务代码（适配器实现）通过依赖注入获取 HTTP 客户端，
 * 而非直接 import fetch/undici，符合依赖反转原则（SOLID-DIP）。
 */
export interface StorageHttpClient {
  /**
   * 发起 HTTP 请求
   *
   * @param method HTTP 方法（GET / PUT / DELETE / POST / HEAD）
   * @param url 完整 URL（含 query string）
   * @param headers 请求头（含签名头）
   * @param body 请求体（可选，PUT/POST 时提供）
   * @returns HTTP 响应
   */
  request(
    method: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    body?: Buffer | string
  ): Promise<HttpResponse>;
}

// ============================================================================
// 3. ObjectStoragePort 抽象接口
// ============================================================================

/**
 * 对象存储统一抽象接口（Port，§5.8.1）
 *
 * EAG 方案 §5.8.1 规范要求"业务代码只允许依赖 Port 接口"——
 * 业务代码（如用户头像上传 / 订单附件下载）必须通过依赖注入获取 ObjectStoragePort，
 * 禁止直接 import S3Adapter/OssAdapter/MinioAdapter（违反 TCS-OSS-01 红线）。
 *
 * 接口契约：
 * - put：上传文件，返回 PutResult（含生成的 Key）
 * - get：下载文件，返回 GetResult（含 Buffer 内容）
 * - delete：软删除文件（标记 deleted-at 头，不物理删除）
 * - signedUrl：生成签名 URL（强制 ≤24h 过期）
 * - multipartUpload：分片上传大文件
 *
 * 实现方：S3Adapter / OssAdapter / MinioAdapter
 */
export interface ObjectStoragePort {
  /**
   * 上传文件
   *
   * - 自动生成符合规范的 Key（`{env}/{domain}/{yyyyMM}/{uuid}.{ext}`）
   * - 自动校验文件扩展名白名单 + 最大文件大小（TCS-OSS-03 红线）
   - 大文件（>multipartThresholdBytes）自动切换为分片上传
   *
   * @param content 文件内容（Buffer 或字符串）
   * @param keyParams Key 生成参数（含扩展名）
   * @param options 上传选项（内容类型 / 元数据 / 加密 / 禁用分片）
   * @returns 上传结果（含生成的 Key、ETag、大小）
   */
  put(content: Buffer | string, keyParams: StorageKeyParams, options?: PutOptions): Promise<PutResult>;

  /**
   * 下载文件
   *
   * @param key 文件 Key
   * @returns 下载结果（含 Buffer 内容、元数据）
   * @throws Error 文件不存在时抛错
   */
  get(key: string): Promise<GetResult>;

  /**
   * 软删除文件
   *
   * §5.8.1 规范要求删除走软删除标记 + 生命周期规则，因此本操作仅打 deleted-at 标记，
   * 真正物理删除由对象存储生命周期规则按策略执行（如 30 天后清理）。
   *
   * @param key 文件 Key
   * @returns 删除结果（含软删除时间戳）
   */
  delete(key: string): Promise<DeleteResult>;

  /**
   * 生成签名 URL
   *
   * §5.8.1 规范要求敏感文件禁止公网直读，必须签名 URL（默认 15 分钟过期）。
   * TCS-OSS-02 红线要求 expiresInSeconds ≤ 86400（24h），超过抛错。
   *
   * @param key 文件 Key
   * @param expiresInSeconds 过期时间（秒，默认 900 即 15 分钟，最大 86400）
   * @param method HTTP 方法（"GET" 下载 / "PUT" 上传，默认 GET）
   * @returns 签名 URL 结果
   */
  signedUrl(key: string, expiresInSeconds?: number, method?: "GET" | "PUT"): Promise<SignedUrlResult>;

  /**
   * 分片上传大文件
   *
   * §5.8.1 规范要求大文件（>100MB）必须分片上传。本方法：
   * 1. 启动 multipart upload 会话（获取 uploadId）
   * 2. 按 partSizeBytes 切片逐个上传
   * 3. 完成会话（commit）
   *
   * @param content 文件内容（Buffer 或字符串）
   * @param keyParams Key 生成参数
   * @param options 分片上传选项（含分片大小、断点续传 uploadId）
   * @returns 分片上传结果（含 uploadId、分片数）
   */
  multipartUpload(
    content: Buffer | string,
    keyParams: StorageKeyParams,
    options?: MultipartOptions
  ): Promise<MultipartResult>;
}

// ============================================================================
// 4. 文件 Key 生成器（规范实现）
// ============================================================================

/**
 * 生成符合 §5.8.1 规范的文件 Key
 *
 * Key 格式：`{env}/{domain}/{yyyyMM}/{uuid}.{ext}`
 * - env：环境标识（如 "prod" / "staging" / "dev"）
 * - domain：业务域标识（如 "user-avatar" / "order-attachment"）
 * - yyyyMM：年月（如 "202607"，用于按月分区便于生命周期管理）
 * - uuid：v4 UUID（避免冲突，不可推测）
 * - ext：扩展名（不含点）
 *
 * 设计说明：
 * - 按 env 分区便于不同环境的对象隔离
 * - 按 domain 分区便于业务域管理
 * - 按 yyyyMM 分区便于生命周期规则（如按月归档/删除）
 * - 使用 UUID 而非自增 ID 避免冲突与推测
 *
 * @param env 环境标识
 * @param domain 业务域标识
 * @param params Key 生成参数（含扩展名、可选时间戳、可选 UUID）
 * @returns 生成的文件 Key
 */
export function generateStorageKey(env: string, domain: string, params: StorageKeyParams): string {
  // 校验入参非空
  if (!env) {
    throw new Error("env 不能为空");
  }
  if (!domain) {
    throw new Error("domain 不能为空");
  }
  if (!params.extension) {
    throw new Error("extension 不能为空");
  }

  // 格式化 yyyyMM（取当前时间或参数指定时间）
  const timestamp = params.timestamp ?? new Date();
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const yyyyMM = `${year}${month}`;

  // 生成 UUID（使用参数指定或随机生成 v4 UUID）
  const uuid = params.uuid ?? generateUuidV4();

  // 拼接 Key：{env}/{domain}/{yyyyMM}/{uuid}.{ext}
  return `${env}/${domain}/${yyyyMM}/${uuid}.${params.extension}`;
}

/**
 * 生成 v4 UUID（RFC 4122）
 *
 * 使用 Node.js 内置 crypto.randomUUID（Node 14.17+ 原生支持）。
 * 当 randomUUID 不可用时（极旧环境），使用 crypto.randomBytes 手动实现 v4 UUID 算法。
 *
 * v4 UUID 算法：
 * 1. 生成 16 字节随机数
 * 2. 第 7 字节高 4 位设为 0100（版本号 4）
 * 3. 第 9 字节高 2 位设为 10（变体 RFC 4122）
 * 4. 格式化为 8-4-4-4-12 字符串
 *
 * @returns v4 UUID 字符串（如 "f47ac10b-58cc-4372-a567-0e02b2c3d479"）
 */
export function generateUuidV4(): string {
  // 优先使用 Node.js 内置 crypto.randomUUID（性能更好，符合 RFC 4122）
  const globalObj = globalThis as { crypto?: { randomUUID?: () => string } };
  if (globalObj.crypto?.randomUUID) {
    return globalObj.crypto.randomUUID();
  }
  // 降级：手动实现 v4 UUID 算法（使用已导入的 randomBytes）
  // 此分支仅在极旧 Node 环境触发，生产环境通常走 randomUUID 分支
  const bytes = randomBytes(16);
  // 第 7 字节（索引 6）高 4 位设为 0100（版本 4）
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  // 第 9 字节（索引 8）高 2 位设为 10（变体 RFC 4122）
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  // 格式化为 8-4-4-4-12
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ============================================================================
// 5. 校验工具（TCS-OSS-03 红线实现）
// ============================================================================

/**
 * 校验文件扩展名白名单
 *
 * 对齐 TCS-OSS-03 红线"文件类型/大小未校验直接上传（BLOCKER）"——
 * 配置了 allowedExtensions 则必须校验，未配置则抛出配置错误（强制要求显式配置白名单）。
 *
 * @param extension 文件扩展名（不含点）
 * @param allowedExtensions 允许的扩展名清单（白名单）
 * @throws Error 扩展名不在白名单时抛错
 * @throws Error allowedExtensions 未配置时抛错
 */
export function validateFileExtension(extension: string, allowedExtensions: ReadonlyArray<string> | undefined): void {
  if (!allowedExtensions || allowedExtensions.length === 0) {
    // 强制要求显式配置白名单——未配置视为配置错误，禁止"默认允许全部"
    throw new Error(
      "TCS-OSS-03 违规：未配置 allowedExtensions 白名单，禁止上传。" +
        "请在 ObjectStorageConfig 中显式配置 allowedExtensions（如 ['jpg', 'png', 'pdf']）。"
    );
  }
  // 大小写不敏感比对（扩展名通常大小写不敏感）
  const normalizedExt = extension.toLowerCase();
  const normalizedAllowed = allowedExtensions.map((e) => e.toLowerCase());
  if (!normalizedAllowed.includes(normalizedExt)) {
    throw new Error(`TCS-OSS-03 违规：扩展名 "${extension}" 不在白名单 [${allowedExtensions.join(", ")}] 中`);
  }
}

/**
 * 校验文件大小
 *
 * 对齐 TCS-OSS-03 红线"文件类型/大小未校验直接上传（BLOCKER）"——
 * 配置了 maxFileBytes 则必须校验，未配置则抛出配置错误。
 *
 * @param sizeBytes 文件大小（字节）
 * @param maxFileBytes 最大允许文件大小（字节）
 * @throws Error 文件超限时抛错
 * @throws Error maxFileBytes 未配置时抛错
 */
export function validateFileSize(sizeBytes: number, maxFileBytes: number | undefined): void {
  if (maxFileBytes === undefined || maxFileBytes <= 0) {
    // 强制要求显式配置最大文件大小——未配置视为配置错误
    throw new Error(
      "TCS-OSS-03 违规：未配置 maxFileBytes，禁止上传。" +
        "请在 ObjectStorageConfig 中显式配置 maxFileBytes（如 104857600 即 100MB）。"
    );
  }
  if (sizeBytes > maxFileBytes) {
    throw new Error(`TCS-OSS-03 违规：文件大小 ${sizeBytes} 字节超过最大限制 ${maxFileBytes} 字节`);
  }
}

/**
 * 校验签名 URL 过期时间
 *
 * 对齐 TCS-OSS-02 红线"签名 URL 过期时间 >24h（MAJOR）"——
 * expiresInSeconds > 86400 时抛错。
 *
 * @param expiresInSeconds 过期时间（秒）
 * @throws Error 过期时间 >24h 时抛错
 */
export function validateSignedUrlExpiry(expiresInSeconds: number): void {
  if (expiresInSeconds <= 0) {
    throw new Error(`TCS-OSS-02 违规：签名 URL 过期时间必须 >0，实际 ${expiresInSeconds}`);
  }
  if (expiresInSeconds > MAX_SIGNED_URL_EXPIRY_SECONDS) {
    throw new Error(
      `TCS-OSS-02 违规：签名 URL 过期时间 ${expiresInSeconds} 秒超过 24h 上限 ` +
        `(${MAX_SIGNED_URL_EXPIRY_SECONDS} 秒)`
    );
  }
}

// ============================================================================
// 6. AWS SigV4 签名算法（S3 / MinIO 共用）
// ============================================================================

/**
 * 计算 SHA-256 哈希（hex 字符串）
 *
 * 使用 Node.js 内置 crypto 模块（createHash），避免外部依赖。
 *
 * @param data 待哈希的数据（字符串或 Buffer）
 * @returns 64 字符 hex 字符串
 */
function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 计算 HMAC-SHA256（Buffer）
 *
 * 使用 Node.js 内置 crypto 模块（createHmac）。
 *
 * @param key 密钥（Buffer）
 * @param data 数据（字符串）
 * @returns HMAC 结果（Buffer）
 */
function hmacSha256(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * AWS Signature V4 签名算法实现
 *
 * 实现 AWS SigV4 签名算法，用于 S3 / MinIO 适配器的请求签名。
 * 算法步骤（参考 AWS 官方文档）：
 * 1. 创建规范请求（Canonical Request）
 * 2. 创建待签字符串（String to Sign）
 * 3. 计算签名（Signature）
 * 4. 添加签名头到请求（Authorization）
 *
 * @param params 签名参数
 * @returns 签名头（Authorization + x-amz-* 头）
 */
export function signAwsSigV4(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer | string;
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  service: string;
  expiresInSeconds?: number;
}): Readonly<Record<string, string>> {
  const { method, url, headers, body, accessKeyId, accessKeySecret, region, service } = params;

  // 步骤 1：准备请求体哈希（x-amz-content-sha256）
  const bodyBuffer = typeof body === "string" ? Buffer.from(body) : body;
  const payloadHash = sha256Hex(bodyBuffer);

  // 步骤 2：构建规范请求头（按字段名排序，小写）
  const allHeaders: Record<string, string> = {
    ...headers,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
  };
  // 如果是预签名 URL 模式（expiresInSeconds 提供），添加 X-Amz-Expires 头
  if (params.expiresInSeconds !== undefined) {
    allHeaders["x-amz-expires"] = String(params.expiresInSeconds);
  }

  // 排序后构造规范头清单与签名头清单
  const sortedHeaderKeys = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${allHeaders[k]!.trim()}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  // 步骤 3：构造规范请求（Canonical Request）
  const canonicalUri = url.pathname;
  const canonicalQueryString = url.search ? url.search.slice(1) : "";
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // 步骤 4：构造待签字符串（String to Sign）
  const amzDate = allHeaders["x-amz-date"] ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  // 步骤 5：计算签名密钥（Signing Key）
  const kDate = hmacSha256(Buffer.from(`AWS4${accessKeySecret}`), dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");

  // 步骤 6：计算签名（hex）
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  // 步骤 7：构造 Authorization 头
  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...allHeaders,
    authorization: authorizationHeader,
  };
}

// ============================================================================
// 7. 阿里云 OSS 签名算法
// ============================================================================

/**
 * 阿里云 OSS 签名算法实现
 *
 * 实现 OSS v1 签名算法（HMAC-SHA1），用于 OssAdapter 的请求签名。
 * 算法步骤（参考阿里云 OSS 官方文档）：
 * 1. 构造 StringToSign（VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedOSSHeaders + CanonicalizedResource）
 * 2. 使用 AccessKeySecret 计算 HMAC-SHA1
 * 3. Base64 编码作为签名
 *
 * 与 S3 SigV4 的差异：
 * - 使用 HMAC-SHA1（S3 用 HMAC-SHA256）
 * - StringToSign 拼接方式不同
 * - 签名通过 Authorization 头传递：`OSS {AccessKeyId}:{Signature}`
 * - 请求体完整性通过 Content-MD5 头校验（SigV4 通过 x-amz-content-sha256 头校验），
 *   因此本算法不直接消费 body，但接受可选 body 参数以保持与 signAwsSigV4 接口一致性，
 *   便于适配器调用方以统一形式传递请求体（适配器在上传场景必须传 body）。
 *
 * @param params 签名参数
 * @returns 签名头（Authorization + x-oss-* 头）
 */
export function signOssV1(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  accessKeyId: string;
  accessKeySecret: string;
  expiresInSeconds?: number;
  /**
   * 请求体（可选）
   *
   * OSS v1 签名算法不直接消费 body（通过 Content-MD5 头校验完整性），
   * 但接受此参数以保持与 signAwsSigV4 接口一致性，便于适配器调用方统一传参。
   */
  body?: Buffer | string;
}): Readonly<Record<string, string>> {
  const { method, url, headers, accessKeyId, accessKeySecret } = params;

  // 步骤 1：准备 Content-MD5 / Content-Type / Date
  const contentMd5 = headers["content-md5"] ?? "";
  const contentType = headers["content-type"] ?? "";
  // OSS 签名中 Date 字段：预签名 URL 模式下使用 expiresInSeconds，否则使用 Date 头
  const date =
    params.expiresInSeconds !== undefined
      ? String(params.expiresInSeconds)
      : (headers["date"] ?? new Date().toUTCString());

  // 步骤 2：构造 CanonicalizedOSSHeaders（x-oss- 前缀头，按字典序排列）
  const ossHeaders = Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith("x-oss-"))
    .sort()
    .map((k) => `${k.toLowerCase()}:${headers[k]!.trim()}\n`)
    .join("");

  // 步骤 3：构造 CanonicalizedResource（/BucketName/ObjectName + 子资源）
  // url.pathname 已包含 /BucketName/ObjectName
  const canonicalizedResource = url.pathname + (url.search ? url.search : "");

  // 步骤 4：构造 StringToSign
  const stringToSign = [method.toUpperCase(), contentMd5, contentType, date, ossHeaders + canonicalizedResource].join(
    "\n"
  );

  // 步骤 5：计算 HMAC-SHA1 签名（使用已导入的 createHmac）
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");

  // 步骤 6：构造 Authorization 头
  const authorizationHeader = `OSS ${accessKeyId}:${signature}`;

  return {
    ...headers,
    authorization: authorizationHeader,
    date,
  };
}

// ============================================================================
// 8. S3 适配器（AWS S3 兼容协议）
// ============================================================================

/**
 * S3 适配器（AWS S3 兼容协议）
 *
 * 实现 ObjectStoragePort 接口，使用 AWS Signature V4 算法签名请求。
 * 适用于 AWS S3 / Ceph / 其他 S3 兼容存储（除 MinIO 单独适配器外）。
 *
 * 业务代码禁止直接 import 本类（违反 TCS-OSS-01 红线），必须通过依赖注入获取 ObjectStoragePort。
 */
export class S3Adapter implements ObjectStoragePort {
  /** 已冻结的配置（防止运行期被 LLM 自改） */
  protected readonly config: Readonly<ObjectStorageConfig>;
  /** HTTP 客户端（依赖注入） */
  protected readonly httpClient: StorageHttpClient;
  /** 默认签名 URL 过期时间（秒） */
  protected readonly defaultExpirySeconds: number;
  /** 大文件分片阈值（字节） */
  protected readonly multipartThresholdBytes: number;
  /** 默认分片大小（字节） */
  protected readonly partSizeBytes: number;

  /**
   * 构造 S3 适配器
   *
   * @param config 对象存储配置
   * @param httpClient HTTP 客户端（依赖注入，生产环境注入 UndiciHttpClient，测试环境注入 StaticS3Client）
   */
  constructor(config: ObjectStorageConfig, httpClient: StorageHttpClient) {
    // 深度冻结配置，防止运行期被修改
    this.config = deepFreeze({ ...config });
    this.httpClient = httpClient;
    this.defaultExpirySeconds = config.defaultSignedUrlExpirySeconds ?? DEFAULT_SIGNED_URL_EXPIRY_SECONDS;
    this.multipartThresholdBytes = config.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES;
    this.partSizeBytes = config.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  }

  /**
   * 上传文件
   *
   * 实现步骤：
   * 1. 校验文件扩展名白名单（TCS-OSS-03）
   * 2. 校验文件大小（TCS-OSS-03）
   * 3. 生成符合规范的 Key
   * 4. 大文件（>multipartThresholdBytes）切换为分片上传
   * 5. 构造 HTTP 请求并签名（SigV4）
   * 6. 通过 httpClient 发送请求
   */
  async put(content: Buffer | string, keyParams: StorageKeyParams, options?: PutOptions): Promise<PutResult> {
    // 1. 校验扩展名白名单
    validateFileExtension(keyParams.extension, this.config.allowedExtensions);

    // 2. 准备文件内容 Buffer
    const contentBuffer = typeof content === "string" ? Buffer.from(content) : content;
    const sizeBytes = contentBuffer.byteLength;

    // 3. 校验文件大小
    validateFileSize(sizeBytes, this.config.maxFileBytes);

    // 4. 生成 Key
    const key = generateStorageKey(this.config.env, this.config.domain, keyParams);

    // 5. 大文件切换分片上传（除非显式 disableMultipart）
    if (!options?.disableMultipart && sizeBytes > this.multipartThresholdBytes) {
      const multipartResult = await this.multipartUpload(contentBuffer, keyParams, options);
      return {
        key: multipartResult.key,
        etag: multipartResult.etag,
        sizeBytes: multipartResult.sizeBytes,
        uploadType: "multipart",
        uploadedAt: multipartResult.uploadedAt,
      };
    }

    // 6. 单次上传——构造请求
    const url = this.buildObjectUrl(key);
    const headers: Record<string, string> = {
      "content-type": options?.contentType ?? "application/octet-stream",
      "content-length": String(sizeBytes),
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    };
    // 自定义元数据写入 x-amz-meta-* 头
    if (options?.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k}`] = v;
      }
    }
    // 服务端加密
    if (options?.serverSideEncryption) {
      headers["x-amz-server-side-encryption"] = "AES256";
    }

    // SigV4 签名
    const signedHeaders = signAwsSigV4({
      method: "PUT",
      url: new URL(url),
      headers,
      body: contentBuffer,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      region: this.config.region,
      service: "s3",
    });

    // 发送请求
    const response = await this.httpClient.request("PUT", url, signedHeaders, contentBuffer);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`S3 put 失败：status=${response.status}, body=${response.body.toString("utf8")}`);
    }

    // 解析 ETag（S3 PUT 响应返回 ETag 头）
    const etag = response.headers["etag"] ?? sha256Hex(contentBuffer);
    return {
      key,
      etag,
      sizeBytes,
      uploadType: "single",
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * 下载文件
   */
  async get(key: string): Promise<GetResult> {
    const url = this.buildObjectUrl(key);
    const headers: Record<string, string> = {
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    };

    const signedHeaders = signAwsSigV4({
      method: "GET",
      url: new URL(url),
      headers,
      body: "",
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      region: this.config.region,
      service: "s3",
    });

    const response = await this.httpClient.request("GET", url, signedHeaders);
    if (response.status === 404) {
      throw new Error(`S3 get 失败：文件不存在 key=${key}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`S3 get 失败：status=${response.status}, body=${response.body.toString("utf8")}`);
    }

    // 解析元数据（x-amz-meta-* 头 → metadata 对象）
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (k.startsWith("x-amz-meta-")) {
        metadata[k.slice("x-amz-meta-".length)] = v;
      }
    }
    // 检查软删除标记
    const softDeleted = response.headers["x-amz-meta-deleted-at"] !== undefined;

    return {
      key,
      content: response.body,
      contentType: response.headers["content-type"] ?? "application/octet-stream",
      sizeBytes: Number(response.headers["content-length"] ?? response.body.byteLength),
      etag: response.headers["etag"] ?? "",
      lastModified: response.headers["last-modified"] ?? new Date().toISOString(),
      metadata,
      softDeleted,
    };
  }

  /**
   * 软删除文件
   *
   * 实现方式：通过 PUT 复制原对象并添加 x-amz-meta-deleted-at 头，
   * 实际物理删除由对象存储生命周期规则按策略执行（如 30 天后清理）。
   */
  async delete(key: string): Promise<DeleteResult> {
    const deletedAt = new Date().toISOString();
    const url = this.buildObjectUrl(key);
    // S3 软删除通过 PUT 复制 + 元数据标记实现
    // 实际生产实现应使用 COPY 操作复制原对象到 deleted/ 前缀下并打 deleted-at 标记
    // 这里通过 GET + PUT 实现（确保适配器与具体厂商 S3 兼容协议完全解耦）
    const existing = await this.get(key).catch(() => null);
    if (existing === null) {
      // 文件不存在视为已永久删除
      return { key, deletedAt, permanent: true };
    }
    // 重新上传原内容并打 deleted-at 标记
    const headers: Record<string, string> = {
      "content-type": existing.contentType,
      "content-length": String(existing.sizeBytes),
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      "x-amz-meta-deleted-at": deletedAt,
      "x-amz-copy-source": `/${this.config.bucket}/${key}`,
    };
    // 保留原元数据
    for (const [k, v] of Object.entries(existing.metadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }

    const signedHeaders = signAwsSigV4({
      method: "PUT",
      url: new URL(url),
      headers,
      body: "",
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      region: this.config.region,
      service: "s3",
    });

    const response = await this.httpClient.request("PUT", url, signedHeaders, "");
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`S3 delete 失败：status=${response.status}, body=${response.body.toString("utf8")}`);
    }

    return { key, deletedAt, permanent: false };
  }

  /**
   * 生成签名 URL（预签名 URL）
   *
   * 实现方式：构造预签名 URL，将签名信息作为 query string 参数（X-Amz-* 参数），
   * 允许通过浏览器直接访问对象存储（无需请求头签名）。
   */
  async signedUrl(
    key: string,
    expiresInSeconds: number = this.defaultExpirySeconds,
    method: "GET" | "PUT" = "GET"
  ): Promise<SignedUrlResult> {
    // 校验过期时间（TCS-OSS-02 红线）
    validateSignedUrlExpiry(expiresInSeconds);

    const baseUrl = this.buildObjectUrl(key);
    const url = new URL(baseUrl);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    // 预签名 URL 的签名参数（query string）
    const credential = `${this.config.accessKeyId}/${dateStamp}/${this.config.region}/s3/aws4_request`;
    const signedHeaders = "host";
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", credential);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);

    // 计算签名（query string 模式）
    const signedHeaderMap = signAwsSigV4({
      method,
      url,
      headers: {},
      body: "",
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      region: this.config.region,
      service: "s3",
      expiresInSeconds,
    });

    // 提取签名（从 Authorization 头解析 Signature=xxx）
    const authHeader = signedHeaderMap.authorization as string;
    const signatureMatch = authHeader.match(/Signature=([a-f0-9]+)/);
    const signature = signatureMatch ? signatureMatch[1] : "";
    url.searchParams.set("X-Amz-Signature", signature);

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    return {
      key,
      url: url.toString(),
      expiresAt,
      expiresInSeconds,
      method,
    };
  }

  /**
   * 分片上传大文件
   *
   * 实现步骤：
   * 1. 启动 multipart upload（POST + uploads=）
   * 2. 按 partSizeBytes 切片，逐个上传分片（PUT + partNumber= + uploadId=）
   * 3. 完成会话（POST + uploadId=）
   */
  async multipartUpload(
    content: Buffer | string,
    keyParams: StorageKeyParams,
    options?: MultipartOptions
  ): Promise<MultipartResult> {
    // 校验扩展名
    validateFileExtension(keyParams.extension, this.config.allowedExtensions);

    const contentBuffer = typeof content === "string" ? Buffer.from(content) : content;
    validateFileSize(contentBuffer.byteLength, this.config.maxFileBytes);

    const key = generateStorageKey(this.config.env, this.config.domain, keyParams);
    const partSize = options?.partSizeBytes ?? this.partSizeBytes;

    // 步骤 1：启动 multipart upload
    const initiateUrl = `${this.buildObjectUrl(key)}?uploads`;
    const initiateHeaders: Record<string, string> = {
      "content-type": options?.contentType ?? "application/octet-stream",
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    };
    if (options?.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        initiateHeaders[`x-amz-meta-${k}`] = v;
      }
    }

    const signedInitiateHeaders = signAwsSigV4({
      method: "POST",
      url: new URL(initiateUrl),
      headers: initiateHeaders,
      body: "",
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      region: this.config.region,
      service: "s3",
    });

    const initiateResponse = await this.httpClient.request("POST", initiateUrl, signedInitiateHeaders, "");
    if (initiateResponse.status < 200 || initiateResponse.status >= 300) {
      throw new Error(`S3 multipart initiate 失败：status=${initiateResponse.status}`);
    }
    // 从响应体解析 uploadId（S3 返回 XML）
    const uploadId = parseUploadIdFromXml(initiateResponse.body.toString("utf8"));

    // 步骤 2：逐个上传分片
    const partCount = Math.ceil(contentBuffer.byteLength / partSize);
    const parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = [];
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      const start = i * partSize;
      const end = Math.min(start + partSize, contentBuffer.byteLength);
      const partBuffer = contentBuffer.subarray(start, end);
      const partUrl = `${this.buildObjectUrl(key)}?partNumber=${partNumber}&uploadId=${uploadId}`;
      const partHeaders: Record<string, string> = {
        "content-length": String(partBuffer.byteLength),
        "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      };
      const signedPartHeaders = signAwsSigV4({
        method: "PUT",
        url: new URL(partUrl),
        headers: partHeaders,
        body: partBuffer,
        accessKeyId: this.config.accessKeyId,
        accessKeySecret: this.config.accessKeySecret,
        region: this.config.region,
        service: "s3",
      });
      const partResponse = await this.httpClient.request("PUT", partUrl, signedPartHeaders, partBuffer);
      if (partResponse.status < 200 || partResponse.status >= 300) {
        throw new Error(`S3 multipart part ${partNumber} 上传失败：status=${partResponse.status}`);
      }
      parts.push({
        partNumber,
        etag: partResponse.headers["etag"] ?? sha256Hex(partBuffer),
        sizeBytes: partBuffer.byteLength,
      });
    }

    // 步骤 3：完成会话
    const completeUrl = `${this.buildObjectUrl(key)}?uploadId=${uploadId}`;
    const completeBody = buildCompleteMultipartXml(parts);
    const completeHeaders: Record<string, string> = {
      "content-type": "application/xml",
      "content-length": String(Buffer.byteLength(completeBody)),
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    };
    const signedCompleteHeaders = signAwsSigV4({
      method: "POST",
      url: new URL(completeUrl),
      headers: completeHeaders,
      body: completeBody,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      region: this.config.region,
      service: "s3",
    });
    const completeResponse = await this.httpClient.request("POST", completeUrl, signedCompleteHeaders, completeBody);
    if (completeResponse.status < 200 || completeResponse.status >= 300) {
      throw new Error(`S3 multipart complete 失败：status=${completeResponse.status}`);
    }

    // 解析最终 ETag（S3 返回 XML 含合并后的 ETag）
    const finalEtag = parseEtagFromXml(completeResponse.body.toString("utf8")) ?? sha256Hex(contentBuffer);

    return {
      key,
      etag: finalEtag,
      sizeBytes: contentBuffer.byteLength,
      uploadType: "multipart",
      uploadedAt: new Date().toISOString(),
      uploadId,
      partCount,
    };
  }

  /**
   * 构造对象 URL（virtual-hosted-style，对齐 AWS S3 推荐格式）
   *
   * AWS S3 virtual-hosted-style URL：`https://{bucket}.{endpoint-host}/{key}`
   * - 例：endpoint="https://s3.us-east-1.amazonaws.com"，bucket="test-bucket"
   *   → URL = "https://test-bucket.s3.us-east-1.amazonaws.com/{key}"
   *
   * 设计依据（M-9 修复）：
   * - AWS 已将 path-style（`https://{endpoint}/{bucket}/{key}`）标记为 legacy，
   *   推荐使用 virtual-hosted-style 以获得更好的性能与未来兼容性。
   * - virtual-hosted-style 支持 HTTPS + SNI，可启用 Keep-Alive 连接复用，减少 TLS 握手开销。
   * - 通过将 bucket 名作为子域名前缀，HTTP 路由层可基于 Host 头直接路由到对应桶，
   *   无需解析 URL 路径。
   *
   * 实现说明：
   * - 从 endpoint 中剥离协议前缀（http:// 或 https://），将 bucket 名拼接到 host 的最左侧子域。
   * - 保留原 endpoint 的协议（http 或 https）。
   * - 若 endpoint 含端口（如自建 MinIO `http://localhost:9000`），端口保留在 host 之后。
   *
   * 注意：本方法仅供 S3Adapter 使用，MinioAdapter 重写本方法保留 path-style
   * （MinIO 默认 path-style，详见 MinioAdapter.buildObjectUrl）。
   *
   * @param key 对象 Key
   * @returns virtual-hosted-style URL
   */
  protected buildObjectUrl(key: string): string {
    // 从 endpoint 中提取协议与 host（含端口）
    const protocolMatch = this.config.endpoint.match(/^(https?:)\/\//i);
    const protocol = protocolMatch ? protocolMatch[1]! : "https:";
    const endpointHost = this.config.endpoint.replace(/^https?:\/\//i, "");
    return `${protocol}//${this.config.bucket}.${endpointHost}/${key}`;
  }
}

// ============================================================================
// 9. 阿里云 OSS 适配器
// ============================================================================

/**
 * 阿里云 OSS 适配器
 *
 * 实现 ObjectStoragePort 接口，使用 OSS v1 签名算法（HMAC-SHA1）。
 * 与 S3 SigV4 算法不同，OSS 使用自有签名格式。
 *
 * 业务代码禁止直接 import 本类（违反 TCS-OSS-01 红线）。
 */
export class OssAdapter extends S3Adapter {
  /**
   * 重写 put 方法，使用 OSS v1 签名
   *
   * OSS 与 S3 的主要差异：
   * - 签名算法：OSS 使用 HMAC-SHA1，S3 使用 HMAC-SHA256（SigV4）
   * - 元数据头前缀：OSS 使用 x-oss-meta-*，S3 使用 x-amz-meta-*
   * - URL 结构：OSS 使用 https://{bucket}.{endpoint}/{key}（virtual-hosted-style）
   */
  async put(content: Buffer | string, keyParams: StorageKeyParams, options?: PutOptions): Promise<PutResult> {
    validateFileExtension(keyParams.extension, this.config.allowedExtensions);

    const contentBuffer = typeof content === "string" ? Buffer.from(content) : content;
    validateFileSize(contentBuffer.byteLength, this.config.maxFileBytes);

    // 大文件切换分片
    if (!options?.disableMultipart && contentBuffer.byteLength > this.multipartThresholdBytes) {
      const multipartResult = await this.multipartUpload(contentBuffer, keyParams, options);
      return {
        key: multipartResult.key,
        etag: multipartResult.etag,
        sizeBytes: multipartResult.sizeBytes,
        uploadType: "multipart",
        uploadedAt: multipartResult.uploadedAt,
      };
    }

    const key = generateStorageKey(this.config.env, this.config.domain, keyParams);
    const url = this.buildOssObjectUrl(key);
    const date = new Date().toUTCString();
    const headers: Record<string, string> = {
      "content-type": options?.contentType ?? "application/octet-stream",
      "content-length": String(contentBuffer.byteLength),
      date,
    };
    if (options?.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-oss-meta-${k}`] = v;
      }
    }
    if (options?.serverSideEncryption) {
      headers["x-oss-server-side-encryption"] = "AES256";
    }

    const signedHeaders = signOssV1({
      method: "PUT",
      url: new URL(url),
      headers,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
    });

    const response = await this.httpClient.request("PUT", url, signedHeaders, contentBuffer);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OSS put 失败：status=${response.status}, body=${response.body.toString("utf8")}`);
    }

    return {
      key,
      etag: response.headers["etag"] ?? sha256Hex(contentBuffer),
      sizeBytes: contentBuffer.byteLength,
      uploadType: "single",
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * 重写 get 方法，使用 OSS v1 签名
   */
  async get(key: string): Promise<GetResult> {
    const url = this.buildOssObjectUrl(key);
    const date = new Date().toUTCString();
    const headers: Record<string, string> = { date };

    const signedHeaders = signOssV1({
      method: "GET",
      url: new URL(url),
      headers,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
    });

    const response = await this.httpClient.request("GET", url, signedHeaders);
    if (response.status === 404) {
      throw new Error(`OSS get 失败：文件不存在 key=${key}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OSS get 失败：status=${response.status}, body=${response.body.toString("utf8")}`);
    }

    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (k.startsWith("x-oss-meta-")) {
        metadata[k.slice("x-oss-meta-".length)] = v;
      }
    }
    const softDeleted = response.headers["x-oss-meta-deleted-at"] !== undefined;

    return {
      key,
      content: response.body,
      contentType: response.headers["content-type"] ?? "application/octet-stream",
      sizeBytes: Number(response.headers["content-length"] ?? response.body.byteLength),
      etag: response.headers["etag"] ?? "",
      lastModified: response.headers["last-modified"] ?? new Date().toISOString(),
      metadata,
      softDeleted,
    };
  }

  /**
   * 重写 delete 方法，使用 OSS v1 签名
   */
  async delete(key: string): Promise<DeleteResult> {
    const deletedAt = new Date().toISOString();
    const existing = await this.get(key).catch(() => null);
    if (existing === null) {
      return { key, deletedAt, permanent: true };
    }
    const url = this.buildOssObjectUrl(key);
    const date = new Date().toUTCString();
    const headers: Record<string, string> = {
      "content-type": existing.contentType,
      "content-length": String(existing.sizeBytes),
      date,
      "x-oss-meta-deleted-at": deletedAt,
      "x-oss-copy-source": `/${this.config.bucket}/${key}`,
    };
    for (const [k, v] of Object.entries(existing.metadata)) {
      headers[`x-oss-meta-${k}`] = v;
    }

    const signedHeaders = signOssV1({
      method: "PUT",
      url: new URL(url),
      headers,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
    });

    const response = await this.httpClient.request("PUT", url, signedHeaders, "");
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OSS delete 失败：status=${response.status}, body=${response.body.toString("utf8")}`);
    }

    return { key, deletedAt, permanent: false };
  }

  /**
   * 重写 signedUrl 方法，使用 OSS v1 预签名
   *
   * OSS 预签名 URL 格式：https://{bucket}.{endpoint}/{key}?OSSAccessKeyId=xxx&Expires=xxx&Signature=xxx
   */
  async signedUrl(
    key: string,
    expiresInSeconds: number = this.defaultExpirySeconds,
    method: "GET" | "PUT" = "GET"
  ): Promise<SignedUrlResult> {
    validateSignedUrlExpiry(expiresInSeconds);

    const url = new URL(this.buildOssObjectUrl(key));
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;

    // 构造签名输入：VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Expires + "\n" + CanonicalizedResource
    const canonicalizedResource = `/${this.config.bucket}/${key}`;
    const stringToSign = [method.toUpperCase(), "", "", String(expires), canonicalizedResource].join("\n");

    // 使用已导入的 createHmac 计算 HMAC-SHA1 签名
    const signature = createHmac("sha1", this.config.accessKeySecret).update(stringToSign).digest("base64");

    url.searchParams.set("OSSAccessKeyId", this.config.accessKeyId);
    url.searchParams.set("Expires", String(expires));
    url.searchParams.set("Signature", encodeURIComponent(signature));

    const expiresAt = new Date(expires * 1000).toISOString();
    return {
      key,
      url: url.toString(),
      expiresAt,
      expiresInSeconds,
      method,
    };
  }

  /**
   * 重写 multipartUpload，使用 OSS v1 签名
   *
   * OSS 分片上传 API 与 S3 类似，但 URL 参数与签名不同
   */
  async multipartUpload(
    content: Buffer | string,
    keyParams: StorageKeyParams,
    options?: MultipartOptions
  ): Promise<MultipartResult> {
    validateFileExtension(keyParams.extension, this.config.allowedExtensions);

    const contentBuffer = typeof content === "string" ? Buffer.from(content) : content;
    validateFileSize(contentBuffer.byteLength, this.config.maxFileBytes);

    const key = generateStorageKey(this.config.env, this.config.domain, keyParams);
    const partSize = options?.partSizeBytes ?? this.partSizeBytes;

    // 步骤 1：初始化分片上传
    const initiateUrl = `${this.buildOssObjectUrl(key)}?uploads`;
    const date = new Date().toUTCString();
    const initiateHeaders: Record<string, string> = {
      "content-type": options?.contentType ?? "application/octet-stream",
      date,
    };
    if (options?.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        initiateHeaders[`x-oss-meta-${k}`] = v;
      }
    }
    const signedInitiateHeaders = signOssV1({
      method: "POST",
      url: new URL(initiateUrl),
      headers: initiateHeaders,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
    });
    const initiateResponse = await this.httpClient.request("POST", initiateUrl, signedInitiateHeaders, "");
    if (initiateResponse.status < 200 || initiateResponse.status >= 300) {
      throw new Error(`OSS multipart initiate 失败：status=${initiateResponse.status}`);
    }
    const uploadId = parseUploadIdFromXml(initiateResponse.body.toString("utf8"));

    // 步骤 2：上传分片
    const partCount = Math.ceil(contentBuffer.byteLength / partSize);
    const parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = [];
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      const start = i * partSize;
      const end = Math.min(start + partSize, contentBuffer.byteLength);
      const partBuffer = contentBuffer.subarray(start, end);
      const partUrl = `${this.buildOssObjectUrl(key)}?partNumber=${partNumber}&uploadId=${uploadId}`;
      const partHeaders: Record<string, string> = {
        "content-length": String(partBuffer.byteLength),
        date: new Date().toUTCString(),
      };
      const signedPartHeaders = signOssV1({
        method: "PUT",
        url: new URL(partUrl),
        headers: partHeaders,
        accessKeyId: this.config.accessKeyId,
        accessKeySecret: this.config.accessKeySecret,
      });
      const partResponse = await this.httpClient.request("PUT", partUrl, signedPartHeaders, partBuffer);
      if (partResponse.status < 200 || partResponse.status >= 300) {
        throw new Error(`OSS multipart part ${partNumber} 上传失败：status=${partResponse.status}`);
      }
      parts.push({
        partNumber,
        etag: partResponse.headers["etag"] ?? sha256Hex(partBuffer),
        sizeBytes: partBuffer.byteLength,
      });
    }

    // 步骤 3：完成分片上传
    const completeUrl = `${this.buildOssObjectUrl(key)}?uploadId=${uploadId}`;
    const completeBody = buildCompleteMultipartXml(parts);
    const completeHeaders: Record<string, string> = {
      "content-type": "application/xml",
      "content-length": String(Buffer.byteLength(completeBody)),
      date: new Date().toUTCString(),
    };
    const signedCompleteHeaders = signOssV1({
      method: "POST",
      url: new URL(completeUrl),
      headers: completeHeaders,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
    });
    const completeResponse = await this.httpClient.request("POST", completeUrl, signedCompleteHeaders, completeBody);
    if (completeResponse.status < 200 || completeResponse.status >= 300) {
      throw new Error(`OSS multipart complete 失败：status=${completeResponse.status}`);
    }

    const finalEtag = parseEtagFromXml(completeResponse.body.toString("utf8")) ?? sha256Hex(contentBuffer);

    return {
      key,
      etag: finalEtag,
      sizeBytes: contentBuffer.byteLength,
      uploadType: "multipart",
      uploadedAt: new Date().toISOString(),
      uploadId,
      partCount,
    };
  }

  /**
   * 构造 OSS 对象 URL（virtual-hosted-style）
   *
   * OSS 使用 virtual-hosted-style URL：https://{bucket}.{endpoint}/{key}
   * 与 S3 path-style 不同（S3 是 https://{endpoint}/{bucket}/{key}）
   */
  protected buildOssObjectUrl(key: string): string {
    // 从 endpoint 中提取 host（去除 https:// 前缀）
    const endpointHost = this.config.endpoint.replace(/^https?:\/\//, "");
    return `https://${this.config.bucket}.${endpointHost}/${key}`;
  }
}

// ============================================================================
// 10. MinIO 适配器（S3 兼容协议，自建对象存储）
// ============================================================================

/**
 * MinIO 适配器（S3 兼容协议，自建对象存储）
 *
 * 实现 ObjectStoragePort 接口，使用 AWS Signature V4 算法签名请求（与 S3 相同）。
 * MinIO 是 S3 兼容的自建对象存储，签名算法与 S3 完全一致，但部署形态不同（自建 vs 云服务）。
 *
 * 业务代码禁止直接 import 本类（违反 TCS-OSS-01 红线）。
 *
 * 实现说明：MinIO 协议与 S3 完全兼容，签名算法也使用 SigV4，
 * 因此本类继承 S3Adapter 并复用大部分实现。
 *
 * 与 S3Adapter 的差异（M-9 修复后）：
 * - URL 格式：MinIO 默认使用 path-style URL（`https://{endpoint}/{bucket}/{key}`），
 *   而非 AWS S3 推荐的 virtual-hosted-style（`https://{bucket}.{endpoint}/{key}`）。
 *   原因：MinIO 自建部署通常使用单 IP + 端口（如 `http://localhost:9000`），
 *   无法通过 DNS 子域名路由到不同 bucket，必须使用 path-style。
 *
 * 单独定义本类仅为：
 * 1. 在类型系统中区分 MinIO 与 S3 适配器（便于依赖注入时按供应商类型选择）
 * 2. 在日志/审计中明确标识使用的存储供应商
 * 3. 重写 buildObjectUrl 保留 path-style（与 AWS S3 virtual-hosted-style 区分）
 * 4. 未来如 MinIO 出现差异（如自定义头），可在此扩展
 */
export class MinioAdapter extends S3Adapter {
  /**
   * 构造 MinIO 对象 URL（path-style，MinIO 默认格式）
   *
   * MinIO path-style URL：`{endpoint}/{bucket}/{key}`
   * - 例：endpoint="http://localhost:9000"，bucket="test-bucket"
   *   → URL = "http://localhost:9000/test-bucket/{key}"
   *
   * 与 S3Adapter.buildObjectUrl 的差异：
   * - S3Adapter 使用 virtual-hosted-style（bucket 作为子域名前缀）
   * - MinioAdapter 使用 path-style（bucket 作为 URL 路径前缀）
   *
   * 设计依据：
   * - MinIO 默认使用 path-style（自建部署无法通过 DNS 子域名路由）
   * - AWS S3 已将 path-style 标记为 legacy，但 MinIO 仍推荐 path-style
   *
   * @param key 对象 Key
   * @returns path-style URL
   */
  protected override buildObjectUrl(key: string): string {
    return `${this.config.endpoint}/${this.config.bucket}/${key}`;
  }
}

// ============================================================================
// 11. XML 解析辅助函数（S3/OSS 共用）
// ============================================================================

/**
 * 从 S3/OSS XML 响应中解析 uploadId
 *
 * S3 InitiateMultipartUpload 响应格式：
 * <?xml version="1.0" encoding="UTF-8"?>
 * <InitiateMultipartUploadResult>
 *   <Bucket>bucket-name</Bucket>
 *   <Key>object-key</Key>
 *   <UploadId>upload-id</UploadId>
 * </InitiateMultipartUploadResult>
 *
 * @param xml XML 字符串
 * @returns uploadId
 */
function parseUploadIdFromXml(xml: string): string {
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match) {
    // 兼容 StaticClient 返回的非 XML 格式（直接返回 uploadId 字符串）
    if (xml.trim().length > 0 && !xml.includes("<")) {
      return xml.trim();
    }
    throw new Error(`无法从响应中解析 uploadId：${xml}`);
  }
  return match[1]!;
}

/**
 * 从 S3/OSS XML 响应中解析 ETag
 *
 * S3 CompleteMultipartUpload 响应格式：
 * <?xml version="1.0" encoding="UTF-8"?>
 * <CompleteMultipartUploadResult>
 *   <Location>...</Location>
 *   <Bucket>bucket-name</Bucket>
 *   <Key>object-key</Key>
 *   <ETag>"etag-value"</ETag>
 * </CompleteMultipartUploadResult>
 *
 * @param xml XML 字符串
 * @returns ETag 或 null
 */
function parseEtagFromXml(xml: string): string | null {
  const match = xml.match(/<ETag>"?([^<"]+)"?<\/ETag>/);
  return match ? match[1]! : null;
}

/**
 * 构造 CompleteMultipartUpload XML 请求体
 *
 * S3/OSS CompleteMultipartUpload API 要求请求体为 XML，列出所有分片的 partNumber 与 ETag：
 * <?xml version="1.0" encoding="UTF-8"?>
 * <CompleteMultipartUpload>
 *   <Part>
 *     <PartNumber>1</PartNumber>
 *     <ETag>"etag-1"</ETag>
 *   </Part>
 *   ...
 * </CompleteMultipartUpload>
 *
 * @param parts 分片列表
 * @returns XML 请求体
 */
function buildCompleteMultipartXml(
  parts: ReadonlyArray<{ partNumber: number; etag: string; sizeBytes: number }>
): string {
  const partsXml = parts
    .map((p) => `  <Part>\n    <PartNumber>${p.partNumber}</PartNumber>\n    <ETag>"${p.etag}"</ETag>\n  </Part>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n${partsXml}\n</CompleteMultipartUpload>`;
}

// ============================================================================
// 12. 适配器工厂（按供应商类型构造）
// ============================================================================

/**
 * 按配置中的 provider 字段构造对应的对象存储适配器
 *
 * 业务代码通过此工厂获取 ObjectStoragePort 实现，符合依赖反转原则。
 * 工厂内部根据 provider 字段选择 S3Adapter / OssAdapter / MinioAdapter，
 * 调用方无需感知具体实现。
 *
 * @param config 对象存储配置
 * @param httpClient HTTP 客户端（依赖注入）
 * @returns 对象存储适配器实例
 */
export function createObjectStorage(config: ObjectStorageConfig, httpClient: StorageHttpClient): ObjectStoragePort {
  switch (config.provider) {
    case "s3":
      return new S3Adapter(config, httpClient);
    case "oss":
      return new OssAdapter(config, httpClient);
    case "minio":
      return new MinioAdapter(config, httpClient);
    default:
      // 穷举保护：若未来新增 provider 类型未在此处理，编译期 TypeScript 会因 union 穷尽性检查报错
      // 运行期兜底错误（理论上不可达，因 provider 类型已限定为联合字面量）
      throw new Error(`不支持的存储供应商：${String(config.provider)}`);
  }
}
