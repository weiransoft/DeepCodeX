/**
 * OssPatternChecker 单元测试 —— EAG-P3 批次 12 C2 收尾补全
 *
 * 测试范围：
 * - TCS-OSS-02：签名 URL 过期时间 > 24h
 *   - 正例：无 signedUrl 调用 → passed
 *   - 正例：signedUrl 调用未提供 expirySeconds → passed（保守策略）
 *   - 正例：signedUrl 调用 expirySeconds ≤ 86400 → passed
 *   - 反例：signedUrl 调用 expirySeconds > 86400 → violated
 *   - 反例：generateSignedUrl 顶层函数调用 expirySeconds > 86400 → violated
 *   - 正例：非 OSS receiver 的 signedUrl 调用 → 不被检测（passed）
 *
 * - TCS-OSS-03：文件类型/大小未校验直接上传
 *   - 正例：无 put 调用 → passed
 *   - 正例：put 调用前有 validateFileExtension 调用 → passed
 *   - 正例：put 调用参数中含 allowedExtensions 字段 → passed
 *   - 反例：put 调用前无校验 → violated
 *   - 正例：非 OSS receiver 的 put 调用 → 不被检测（passed）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 使用真实 OssPatternChecker 实例，不使用 mock
 * - 使用真实 redline 定义（ENTERPRISE_REDLINES + TCS_REDLINES）
 *
 * @module core/tests/eag-oss-pattern-checker
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { OssPatternChecker } from "../eag/coding/static-checkers/oss-pattern-checker";
import { TCS_REDLINES } from "../eag/tcs/tcs-redlines";
import type { RedlineDefinition } from "../eag/evaluator/types";

// ============================================================================
// 测试夹具：从 TCS_REDLINES 中提取 TCS-OSS-02 / TCS-OSS-03 红线定义
// ============================================================================

/**
 * 查找指定 redlineId 的红线定义
 *
 * @param id 红线 ID
 * @returns 红线定义
 */
function findRedline(id: string): RedlineDefinition {
  for (const r of TCS_REDLINES) {
    if (r.id === id) return r;
  }
  throw new Error(`未找到红线定义：${id}`);
}

/** TCS-OSS-02 红线定义（签名 URL 过期时间 > 24h） */
const TCS_OSS_02_REDLINES: RedlineDefinition = findRedline("TCS-OSS-02");
/** TCS-OSS-03 红线定义（文件类型/大小未校验直接上传） */
const TCS_OSS_03_REDLINES: RedlineDefinition = findRedline("TCS-OSS-03");

/** OssPatternChecker 实例（无状态单例，可全局共享） */
const checker = new OssPatternChecker();

// ============================================================================
// TCS-OSS-02：签名 URL 过期时间 > 24h 测试
// ============================================================================

describe("OssPatternChecker / TCS-OSS-02 签名 URL 过期时间", () => {
  test("正例：代码中无 signedUrl 调用应通过（合规）", () => {
    // 构造一份不含任何 signedUrl 调用的代码
    const content = [
      "// src/domain/order/OrderService.ts",
      "export class OrderService {",
      "  async createOrder() {",
      "    // 业务逻辑",
      "    return { id: 'order-001' };",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/domain/order/OrderService.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "passed", "无 signedUrl 调用时应通过");
    assert.equal(result.redlineId, "TCS-OSS-02");
    assert.equal(result.violations.length, 0);
  });

  test("正例：signedUrl 调用未显式提供 expirySeconds 应通过（保守策略）", () => {
    // signedUrl 调用未提供 expirySeconds 参数 → 使用默认值，保守不视为违规
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async getDownloadUrl(key: string) {",
      "    return await this.objectStorage.signedUrl(key);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "passed", "未显式提供 expirySeconds 时应保守通过");
    assert.equal(result.violations.length, 0);
  });

  test("正例：signedUrl 调用 expirySeconds = 300（15 分钟）应通过", () => {
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async getDownloadUrl(key: string) {",
      "    return await this.objectStorage.signedUrl(key, { expirySeconds: 300 });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "passed", "expirySeconds=300（15 分钟）应通过");
    assert.equal(result.violations.length, 0);
  });

  test("正例：signedUrl 调用 expirySeconds = 86400（24 小时上限）应通过", () => {
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async getLongLivedDownloadUrl(key: string) {",
      "    return await this.objectStorage.signedUrl(key, { expirySeconds: 86400 });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "passed", "expirySeconds=86400（24 小时上限）应通过");
    assert.equal(result.violations.length, 0);
  });

  test("反例：signedUrl 调用 expirySeconds = 100000（>24h）应违规", () => {
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async getDownloadUrl(key: string) {",
      "    return await this.objectStorage.signedUrl(key, { expirySeconds: 100000 });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "violated", "expirySeconds=100000（>24h）应违规");
    assert.equal(result.violations.length, 1, "应有 1 条违规");
    const violation = result.violations[0];
    assert.ok(violation.description.includes("100000"), "违规描述应含数值 100000");
    assert.ok(violation.description.includes("TCS-OSS-02"), "违规描述应含红线 ID");
    assert.ok(violation.fixSuggestion.length > 0, "应提供修复建议");
  });

  test("反例：signedUrl 调用 expiresIn = 172800（48 小时）应违规", () => {
    // 测试 expiresIn 别名参数
    const content = [
      "// src/infrastructure/S3Adapter.ts",
      "export class S3Adapter {",
      "  async getSignedUrl(key: string) {",
      "    return await this.s3.getSignedUrl(key, { expiresIn: 172800 });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/S3Adapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "violated", "expiresIn=172800（48 小时）应违规");
    assert.equal(result.violations.length, 1);
  });

  test("反例：signedUrl 位置参数为 200000（>24h）应违规", () => {
    // 测试位置参数形式：signedUrl(key, 200000)
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async getDownloadUrl(key: string) {",
      "    return await this.oss.signedUrl(key, 200000);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "violated", "位置参数 200000（>24h）应违规");
    assert.equal(result.violations.length, 1);
  });

  test("正例：generateSignedUrl 顶层函数调用 expirySeconds = 3600（1 小时）应通过", () => {
    // 测试无 receiver 的顶层函数调用形式
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "import { generateSignedUrl } from './oss-utils';",
      "export class OssAdapter {",
      "  async getDownloadUrl(key: string) {",
      "    return await generateSignedUrl(key, { expirySeconds: 3600 });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "passed", "generateSignedUrl 顶层函数调用 expirySeconds=3600 应通过");
    assert.equal(result.violations.length, 0);
  });

  test("正例：非 OSS receiver 的 signedUrl 调用应不被检测", () => {
    // localStorage.signedUrl 不是对象存储调用，应不被检测
    const content = [
      "// src/infrastructure/LocalStorageAdapter.ts",
      "export class LocalStorageAdapter {",
      "  async getDownloadUrl(key: string) {",
      "    // localStorage 不是对象存储，不应被检测",
      "    return await this.localStorage.signedUrl(key, { expirySeconds: 100000 });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/LocalStorageAdapter.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(result.status, "passed", "localStorage.signedUrl 不应被检测");
    assert.equal(result.violations.length, 0);
  });
});

// ============================================================================
// TCS-OSS-03：文件类型/大小未校验直接上传 测试
// ============================================================================

describe("OssPatternChecker / TCS-OSS-03 文件上传校验", () => {
  test("正例：代码中无 put 调用应通过（合规）", () => {
    const content = [
      "// src/domain/order/OrderService.ts",
      "export class OrderService {",
      "  async createOrder() {",
      "    // 业务逻辑",
      "    return { id: 'order-001' };",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/domain/order/OrderService.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "passed", "无 put 调用时应通过");
    assert.equal(result.violations.length, 0);
  });

  test("正例：put 调用前有 validateFileExtension + validateFileSize 调用应通过", () => {
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async uploadAvatar(filename: string, content: Buffer, fileSize: number) {",
      "    // 上传前校验文件扩展名与大小",
      "    validateFileExtension(filename, ['jpg', 'png', 'gif']);",
      "    validateFileSize(fileSize, 10 * 1024 * 1024); // 10MB 上限",
      "    return await this.objectStorage.put(content, `avatars/${filename}`);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "passed", "put 调用前有校验调用应通过");
    assert.equal(result.violations.length, 0);
  });

  test("正例：put 调用参数中含 allowedExtensions 字段应通过", () => {
    // 通过 PutOptions 委托适配器校验
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async uploadAvatar(filename: string, content: Buffer) {",
      "    return await this.objectStorage.put(content, `avatars/${filename}`, {",
      "      allowedExtensions: ['jpg', 'png', 'gif'],",
      "      maxSizeBytes: 10 * 1024 * 1024",
      "    });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "passed", "put 参数含 allowedExtensions 应通过");
    assert.equal(result.violations.length, 0);
  });

  test("反例：put 调用前无任何校验应违规", () => {
    const content = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async uploadFile(filename: string, content: Buffer) {",
      "    // 无任何校验直接上传",
      "    return await this.objectStorage.put(content, `uploads/${filename}`);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "violated", "put 调用前无校验应违规");
    assert.equal(result.violations.length, 1);
    const violation = result.violations[0];
    assert.ok(violation.description.includes("TCS-OSS-03"), "违规描述应含红线 ID");
    assert.ok(violation.fixSuggestion.includes("validateFileExtension"), "修复建议应含 validateFileExtension");
  });

  test("正例：put 调用前 15 行内有校验调用应通过", () => {
    // 校验调用在 put 调用前 15 行内（边界值）
    const lines = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async uploadFile(filename: string, content: Buffer, fileSize: number) {",
    ];
    // 添加 12 行注释/空白（使校验调用在 put 前 15 行内）
    for (let i = 0; i < 12; i++) {
      lines.push(`    // 注释行 ${i + 1}`);
    }
    lines.push("    validateFileExtension(filename, ['jpg', 'png']);");
    lines.push("    return await this.objectStorage.put(content, `uploads/${filename}`);");
    lines.push("  }");
    lines.push("}");
    lines.push("");
    const content = lines.join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "passed", "校验在 put 前 15 行内应通过");
    assert.equal(result.violations.length, 0);
  });

  test("反例：校验调用在 put 前 16 行外应违规", () => {
    // 校验调用在 put 前 16 行（超出 LOOKBACK_LINES_FOR_VALIDATION=15）
    // 构造方式：validateFileExtension 在第 4 行，put 在第 20 行
    //   putLine=20, LOOKBACK=15, startLine=Math.max(0, 20-15)=5
    //   扫描 lines[5] 到 lines[19]（1-based 6-20），不含 lines[3]（validateFileExtension）
    const lines = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async uploadFile(filename: string, content: Buffer, fileSize: number) {",
      "    validateFileExtension(filename, ['jpg', 'png']);", // 第 4 行
    ];
    // 添加 15 行注释（使 put 在第 20 行，距离 validateFileExtension 16 行）
    for (let i = 0; i < 15; i++) {
      lines.push(`    // 注释行 ${i + 1}`);
    }
    lines.push("    return await this.objectStorage.put(content, `uploads/${filename}`);");
    lines.push("  }");
    lines.push("}");
    lines.push("");
    const content = lines.join("\n");
    const result = checker.check([{ path: "src/infrastructure/OssAdapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "violated", "校验在 put 前 16 行外应违规");
    assert.equal(result.violations.length, 1);
  });

  test("正例：非 OSS receiver 的 put 调用应不被检测", () => {
    // state.put / this.props.put 不是对象存储调用
    const content = [
      "// src/ui/components/FormComponent.ts",
      "export class FormComponent {",
      "  async submitForm() {",
      "    // this.state.put 不是对象存储调用",
      "    return await this.state.put({ field: 'value' });",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/ui/components/FormComponent.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "passed", "this.state.put 不应被检测");
    assert.equal(result.violations.length, 0);
  });

  test("正例：upload 方法调用前有 validateFileSize 调用应通过", () => {
    const content = [
      "// src/infrastructure/MinioAdapter.ts",
      "export class MinioAdapter {",
      "  async uploadDocument(filename: string, content: Buffer, fileSize: number) {",
      "    validateFileSize(fileSize, 50 * 1024 * 1024); // 50MB 上限",
      "    return await this.minio.upload(content, `documents/${filename}`);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/MinioAdapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "passed", "upload 调用前有 validateFileSize 应通过");
    assert.equal(result.violations.length, 0);
  });

  test("反例：uploadFile 方法调用前无校验应违规", () => {
    const content = [
      "// src/infrastructure/S3Adapter.ts",
      "export class S3Adapter {",
      "  async uploadProfilePicture(filename: string, content: Buffer) {",
      "    return await this.s3.uploadFile(content, `profile-pics/${filename}`);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check([{ path: "src/infrastructure/S3Adapter.ts", content }], TCS_OSS_03_REDLINES);
    assert.equal(result.status, "violated", "uploadFile 调用前无校验应违规");
    assert.equal(result.violations.length, 1);
  });
});

// ============================================================================
// OssPatternChecker 基础属性测试
// ============================================================================

describe("OssPatternChecker 基础属性", () => {
  test("redlineIds 应包含 TCS-OSS-02 和 TCS-OSS-03", () => {
    const localChecker = new OssPatternChecker();
    assert.ok(localChecker.redlineIds.includes("TCS-OSS-02"), "redlineIds 应包含 TCS-OSS-02");
    assert.ok(localChecker.redlineIds.includes("TCS-OSS-03"), "redlineIds 应包含 TCS-OSS-03");
    assert.equal(localChecker.redlineIds.length, 2, "redlineIds 应仅含 2 条");
  });

  test("redlineIds 应被 Object.freeze 冻结", () => {
    const localChecker = new OssPatternChecker();
    assert.ok(Object.isFrozen(localChecker.redlineIds), "redlineIds 应被冻结");
    // 尝试修改应抛 TypeError
    assert.throws(
      () => {
        // 通过 unknown 中转绕过 TypeScript 类型检查，运行期验证 Object.freeze
        (localChecker.redlineIds as unknown as string[]).push("TCS-XXX");
      },
      TypeError,
      "向冻结数组 push 应抛 TypeError"
    );
  });

  test("无状态 Checker 实例应可全局共享", () => {
    const c1 = new OssPatternChecker();
    const c2 = new OssPatternChecker();
    // 两个实例处理相同输入应返回相同结果
    const content = "// src/test.ts\nexport const x = 1;\n";
    const r1 = c1.check([{ path: "src/test.ts", content }], TCS_OSS_02_REDLINES);
    const r2 = c2.check([{ path: "src/test.ts", content }], TCS_OSS_02_REDLINES);
    assert.equal(r1.status, r2.status, "两个实例应返回相同状态");
    assert.equal(r1.violations.length, r2.violations.length, "两个实例应返回相同违规数");
  });
});

// ============================================================================
// 多文件场景测试
// ============================================================================

describe("OssPatternChecker 多文件场景", () => {
  test("应在多个文件中分别检测违规", () => {
    // 文件 1：合规（无 OSS 调用）
    const file1 = [
      "// src/domain/order/OrderAggregate.ts",
      "export class OrderAggregate {",
      "  private status: string = 'pending';",
      "}",
      "",
    ].join("\n");
    // 文件 2：违规（put 无校验）
    const file2 = [
      "// src/infrastructure/OssAdapter.ts",
      "export class OssAdapter {",
      "  async uploadFile(filename: string, content: Buffer) {",
      "    return await this.objectStorage.put(content, filename);",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = checker.check(
      [
        { path: "src/domain/order/OrderAggregate.ts", content: file1 },
        { path: "src/infrastructure/OssAdapter.ts", content: file2 },
      ],
      TCS_OSS_03_REDLINES
    );
    assert.equal(result.status, "violated", "多文件中至少一个违规应整体违规");
    assert.equal(result.violations.length, 1, "应有 1 条违规");
    assert.equal(result.violations[0].filePath, "src/infrastructure/OssAdapter.ts", "违规应在 OssAdapter.ts");
  });
});
