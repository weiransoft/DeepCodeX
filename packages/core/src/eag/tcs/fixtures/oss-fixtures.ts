/**
 * TCS 对象存储红线 fixtures（TCS-OSS-01 / TCS-OSS-02 / TCS-OSS-03）
 *
 * 每条红线 1 个违规样例 + 1 个合规样例（共 6 个 fixture），
 * 用于测试评估器对对象存储红线的判定准确性。
 *
 * 设计依据：
 * - EAG 方案 §5.8.1 对象存储规范
 * - eag/tcs/object-storage.ts（ObjectStoragePort + S3/OSS/MinIO 三适配器）
 * - eag/tcs/tcs-redlines.ts（TCS-OSS-01/02/03 红线定义）
 *
 * @module eag/tcs/fixtures/oss-fixtures
 */

// 引入 deepFreeze 用于递归冻结 fixture 及其嵌套的 expectedViolations 数组。
// Object.freeze 是浅冻结，无法冻结嵌套的 expectedViolations 数组本身——
// F12 测试断言 Object.isFrozen(f.expectedViolations) 必须为 true，
// 因此改用 deepFreeze（types.ts 中已实现）递归冻结所有层级。
import { deepFreeze, type RedlineFixture } from "../types";

// ============================================================================
// TCS-OSS-01：业务代码直连具体厂商 SDK
// ============================================================================

/**
 * TCS-OSS-01 违规样例：业务代码直接 import 阿里云 OSS SDK
 *
 * 场景：用户头像上传业务代码直接 import { OSS } from 'ali-oss' 并调用 client.put，
 * 违反"业务代码禁止直接 import 具体厂商 SDK"红线。
 */
export const OSS_01_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-OSS-01",
  kind: "violation",
  description:
    "业务代码（user-service.ts）直接 import 阿里云 OSS SDK（ali-oss），" +
    "调用 new OSS(config).put() 上传用户头像。违反 §5.8.1 规范——业务代码应依赖 ObjectStoragePort 抽象，" +
    "由适配器层封装具体厂商 SDK。",
  code: [
    "// src/services/user-service.ts",
    "import { OSS } from 'ali-oss';",
    "import * as crypto from 'crypto';",
    "",
    "/**",
    " * 上传用户头像到阿里云 OSS（违规：业务代码直接依赖 ali-oss SDK）",
    " */",
    "export async function uploadAvatar(userId: string, file: Buffer): Promise<string> {",
    "  // 违规：业务代码直接实例化具体厂商 SDK 客户端",
    "  const client = new OSS({",
    "    region: 'oss-cn-hangzhou',",
    "    accessKeyId: process.env.ALI_ACCESS_KEY_ID!,",
    "    accessKeySecret: process.env.ALI_ACCESS_KEY_SECRET!,",
    "    bucket: 'hongene-avatars',",
    "  });",
    "  const key = `avatars/${userId}/${crypto.randomUUID()}.jpg`;",
    "  // 违规：直接调用 SDK 的 put 方法，未通过 ObjectStoragePort 抽象",
    "  const result = await client.put(key, file);",
    "  return result.url;",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/user-service.ts",
      line: 2,
      description: "业务代码直接 import 'ali-oss'——违反 §5.8.1 规范，业务代码应仅依赖 ObjectStoragePort 抽象接口",
    },
    {
      filePath: "src/services/user-service.ts",
      line: 12,
      description: "业务代码直接实例化 OSS 客户端——应由 IoC 容器注入 ObjectStoragePort 实现",
    },
    {
      filePath: "src/services/user-service.ts",
      line: 21,
      description: "业务代码直接调用 client.put()——应改为 port.put(content, keyParams) 通过抽象接口上传",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-OSS-01 合规样例：业务代码通过 ObjectStoragePort 抽象上传
 *
 * 场景：业务代码仅依赖 ObjectStoragePort 接口（构造函数注入），
 * 由适配器层封装 ali-oss SDK 调用，业务代码可无缝切换 OSS / S3 / MinIO。
 */
export const OSS_01_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-OSS-01",
  kind: "compliant",
  description:
    "业务代码（user-service.ts）仅依赖 ObjectStoragePort 抽象接口（构造函数注入），" +
    "调用 port.put() 上传头像。适配器层（OssAdapter）封装 ali-oss SDK 调用，" +
    "业务代码可无缝切换 OSS / S3 / MinIO。",
  code: [
    "// src/services/user-service.ts",
    "import type { ObjectStoragePort, StorageKeyParams } from '../eag/tcs/object-storage';",
    "import * as crypto from 'crypto';",
    "",
    "/**",
    " * 用户头像服务（依赖注入 ObjectStoragePort，符合 §5.8.1 规范）",
    " */",
    "export class AvatarService {",
    "  constructor(private readonly storage: ObjectStoragePort) {}",
    "",
    "  /** 上传用户头像到对象存储 */",
    "  async uploadAvatar(userId: string, file: Buffer): Promise<string> {",
    "    const keyParams: StorageKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'user',",
    "      entity: 'avatar',",
    "      id: `${userId}/${crypto.randomUUID()}`,",
    "      extension: 'jpg',",
    "    };",
    "    // 通过抽象接口上传——不感知底层是 OSS / S3 / MinIO",
    "    const result = await this.storage.put(file, keyParams, {",
    "      allowedExtensions: ['jpg', 'png'],",
    "      maxSizeBytes: 5 * 1024 * 1024,",
    "    });",
    "    return result.key;",
    "  }",
    "}",
    "",
    "// IoC 容器装配（仅此处感知具体厂商）",
    "// const storage = createObjectStorage('oss', ossConfig);",
    "// const avatarService = new AvatarService(storage);",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-OSS-02：签名 URL 过期时间 >24h
// ============================================================================

/**
 * TCS-OSS-02 违规样例：签名 URL 过期时间设置为 7 天（604800 秒）
 *
 * 场景：生成下载链接时调用 port.signedUrl(key, { expirySeconds: 604800 })，
 * 7 天过期时间超过 24 小时上限（86400 秒），违反红线。
 */
export const OSS_02_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-OSS-02",
  kind: "violation",
  description:
    "业务代码生成签名 URL 时将 expirySeconds 设置为 604800（7 天），" +
    "超过 §5.8.1 规范允许的 24 小时上限（MAX_SIGNED_URL_EXPIRY_SECONDS=86400）。" +
    "签名 URL 泄漏后攻击者可长时间访问私有文件。",
  code: [
    "// src/services/file-share.ts",
    "import type { ObjectStoragePort } from '../eag/tcs/object-storage';",
    "",
    "export class FileShareService {",
    "  constructor(private readonly storage: ObjectStoragePort) {}",
    "",
    "  /** 生成长期有效的分享链接（违规：expirySeconds > 86400） */",
    "  async generateShareLink(fileKey: string): Promise<string> {",
    "    // 违规：7 天过期时间超过 24 小时上限",
    "    const result = await this.storage.signedUrl(fileKey, {",
    "      expirySeconds: 604800, // 7 * 24 * 3600 = 604800",
    "      method: 'GET',",
    "    });",
    "    return result.url;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/file-share.ts",
      line: 11,
      description: "signedUrl 调用 expirySeconds=604800（7 天）超过 24 小时上限（86400），违反 TCS-OSS-02 红线",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-OSS-02 合规样例：签名 URL 过期时间 15 分钟（900 秒）
 *
 * 场景：使用 DEFAULT_SIGNED_URL_EXPIRY_SECONDS（900 秒）生成签名 URL，
 * 远低于 24 小时上限，符合规范。
 */
export const OSS_02_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-OSS-02",
  kind: "compliant",
  description:
    "业务代码使用 DEFAULT_SIGNED_URL_EXPIRY_SECONDS（900 秒即 15 分钟）生成签名 URL，" +
    "远低于 24 小时上限，符合 §5.8.1 规范。",
  code: [
    "// src/services/file-share.ts",
    "import type { ObjectStoragePort } from '../eag/tcs/object-storage';",
    "import { DEFAULT_SIGNED_URL_EXPIRY_SECONDS } from '../eag/tcs/object-storage';",
    "",
    "export class FileShareService {",
    "  constructor(private readonly storage: ObjectStoragePort) {}",
    "",
    "  /** 生成短时有效的分享链接（合规：15 分钟过期） */",
    "  async generateShareLink(fileKey: string): Promise<string> {",
    "    // 合规：使用默认 15 分钟过期时间",
    "    const result = await this.storage.signedUrl(fileKey, {",
    "      expirySeconds: DEFAULT_SIGNED_URL_EXPIRY_SECONDS, // 900 秒",
    "      method: 'GET',",
    "    });",
    "    return result.url;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-OSS-03：文件类型/大小未校验直接上传
// ============================================================================

/**
 * TCS-OSS-03 违规样例：上传文件未校验类型与大小
 *
 * 场景：业务代码直接调用 port.put(content, keyParams)，
 * 未调用 validateFileExtension / validateFileSize，也未提供 PutOptions.allowedExtensions / maxSizeBytes，
 * 恶意用户可上传可执行文件或超大文件。
 */
export const OSS_03_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-OSS-03",
  kind: "violation",
  description:
    "业务代码（attachment-service.ts）直接调用 port.put() 上传附件，" +
    "未调用 validateFileExtension / validateFileSize 校验，" +
    "也未通过 PutOptions.allowedExtensions / maxSizeBytes 委托适配器校验。" +
    "恶意用户可上传 .exe / .sh 等可执行文件攻击其他用户，或上传超大文件耗尽存储空间。",
  code: [
    "// src/services/attachment-service.ts",
    "import type { ObjectStoragePort, StorageKeyParams } from '../eag/tcs/object-storage';",
    "",
    "export class AttachmentService {",
    "  constructor(private readonly storage: ObjectStoragePort) {}",
    "",
    "  /** 上传附件（违规：未校验类型与大小） */",
    "  async uploadAttachment(",
    "    userId: string,",
    "    filename: string,",
    "    content: Buffer,",
    "  ): Promise<string> {",
    "    const keyParams: StorageKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'attachment',",
    "      entity: 'file',",
    "      id: `${userId}/${filename}`,",
    "      extension: filename.split('.').pop()!,",
    "    };",
    "    // 违规：直接调用 put，无任何类型/大小校验",
    "    const result = await this.storage.put(content, keyParams);",
    "    return result.key;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/attachment-service.ts",
      line: 21,
      description:
        "port.put() 调用前未调用 validateFileExtension / validateFileSize，PutOptions 也未提供 allowedExtensions / maxSizeBytes，违反 TCS-OSS-03 红线",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-OSS-03 合规样例：上传文件前校验类型与大小
 *
 * 场景：业务代码调用 port.put 前显式调用 validateFileExtension / validateFileSize，
 * 同时通过 PutOptions.allowedExtensions / maxSizeBytes 委托适配器二次校验。
 */
export const OSS_03_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-OSS-03",
  kind: "compliant",
  description:
    "业务代码（attachment-service.ts）上传附件前显式调用 validateFileExtension（白名单）+ validateFileSize（上限），" +
    "同时通过 PutOptions.allowedExtensions / maxSizeBytes 委托适配器二次校验，符合 §5.8.1 规范。",
  code: [
    "// src/services/attachment-service.ts",
    "import {",
    "  validateFileExtension,",
    "  validateFileSize,",
    "  type ObjectStoragePort,",
    "  type StorageKeyParams,",
    "} from '../eag/tcs/object-storage';",
    "",
    "/** 允许的附件扩展名白名单 */",
    "const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'png'] as const;",
    "/** 附件大小上限：20MB */",
    "const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;",
    "",
    "export class AttachmentService {",
    "  constructor(private readonly storage: ObjectStoragePort) {}",
    "",
    "  /** 上传附件（合规：白名单 + 大小校验 + PutOptions 委托） */",
    "  async uploadAttachment(",
    "    userId: string,",
    "    filename: string,",
    "    content: Buffer,",
    "  ): Promise<string> {",
    "    // 合规：白名单校验扩展名",
    "    validateFileExtension(filename, ALLOWED_EXTENSIONS);",
    "    // 合规：校验文件大小上限",
    "    validateFileSize(content.length, MAX_ATTACHMENT_BYTES);",
    "    const keyParams: StorageKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'attachment',",
    "      entity: 'file',",
    "      id: `${userId}/${filename}`,",
    "      extension: filename.split('.').pop()!,",
    "    };",
    "    // 合规：PutOptions 委托适配器二次校验",
    "    const result = await this.storage.put(content, keyParams, {",
    "      allowedExtensions: [...ALLOWED_EXTENSIONS],",
    "      maxSizeBytes: MAX_ATTACHMENT_BYTES,",
    "    });",
    "    return result.key;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// OSS fixtures 聚合导出
// ============================================================================

/**
 * 对象存储全部 fixtures（6 个，TCS-OSS-01/02/03 各 2 个）
 */
export const OSS_FIXTURES: ReadonlyArray<RedlineFixture> = Object.freeze([
  OSS_01_VIOLATION,
  OSS_01_COMPLIANT,
  OSS_02_VIOLATION,
  OSS_02_COMPLIANT,
  OSS_03_VIOLATION,
  OSS_03_COMPLIANT,
]);
