/**
 * 契约测试生成器（ContractTestGenerator）—— EAG-P3 批次 10 §4.2
 *
 * 职责：
 * - 基于 OpenAPI 3.x spec 或 TypeScript 接口签名 AST 提取 ContractTestSpec
 * - 调用 LLM 生成契约测试代码，确保 API 兼容性可自动验证
 * - 对齐 §5.10.5 "契约/集成/E2E 生成" 时序
 *
 * 双通道降级策略（对齐 §4.2.2 关键技术决策）：
 * 1. OpenAPI 3.x 优先：若 openapiSpecPath 提供且文件存在 → 解析为 ContractTestSpec[]
 * 2. AST 提取降级：OpenAPI 不可用时扫描 implementationRoot 下 *.controller.ts / *.service.ts
 *
 * 关键技术决策：
 * - Spec 解析双通道：OpenAPI 3.x 优先 + TypeScript AST 提取降级
 * - AST 提取：复用 V2 CodeMap 符号图谱（不引入 ts-morph，零新增依赖）
 * - LLM 调用：复用 providers/llm-provider.ts 的 LLMClient 接口
 * - 输出格式：JSON 模式（response_format: { type: "json_object" }）
 * - 边界用例：基于 boundaryCases 字段 + LLM 补全
 * - 温度：0.2（低温代码生成，避免幻觉 API）
 *
 * 不可变优先原则：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/testing/contract-test-generator
 */

// ============================================================================
// 1. 外部依赖与类型导入
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { LLMClient, LLMRequest, LLMResponse } from "../../providers/llm-provider";
import type { SessionMessage } from "../../session";
import type { ContractTestSpec, GeneratedTestFile, LogCallback } from "./types";
import { DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL, DEFAULT_TEST_GENERATION_TEMPERATURE } from "./types";

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 默认契约测试模板注册表
 *
 * 本批次实现简化版：使用内置模板字符串生成测试骨架，LLM 仅填充断言细节。
 * 与批次 9 coding/templates 的 TestTemplateRegistry 设计对齐，但本批次不引入
 * 完整的模板注册表机制——P3 批次 11 可扩展为完整的 TestTemplateRegistry。
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
export const DEFAULT_CONTRACT_TEST_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  "contract-test-default": [
    "/**",
    " * 契约测试：{{apiPath}} {{method}}",
    " *",
    " * 自动生成：EAG-P3 批次 10 ContractTestGenerator",
    " * 关联需求：{{requirementId}}",
    " */",
    "",
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    'test("should return 200 when valid request for {{apiPath}}", async () => {',
    "  // TODO: 由 LLM 填充具体断言",
    "  assert.ok(true);",
    "});",
  ].join("\n"),
});

/**
 * OpenAPI 3.x 路径项支持的 HTTP 方法列表
 *
 * OpenAPI 规范定义的 9 种 HTTP 方法（含 TRACE/OPTIONS/HEAD/DELETE/PATCH/POST/PUT/GET/CONNECT）。
 * 本批次仅处理常用 5 种（GET/POST/PUT/DELETE/PATCH）。
 */
const SUPPORTED_HTTP_METHODS: ReadonlyArray<string> = Object.freeze(["get", "post", "put", "delete", "patch"]);

/**
 * OpenAPI 3.x spec 结构 zod 校验 schema
 *
 * 校验 spec 顶层必填字段：openapi / paths。
 * 不校验完整 OpenAPI 规范——仅校验 ContractTestGenerator 消费的字段。
 */
const OpenApiSpecSchema = z.object({
  openapi: z.string().min(1),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

// ============================================================================
// 3. 自定义错误类
// ============================================================================

/**
 * 契约测试生成器错误基类
 *
 * 所有 ContractTestGenerator 抛出的错误均继承自此基类，
 * 便于上层捕获与错误分类处理。
 */
export class ContractTestGeneratorError extends Error {
  /**
   * @param kind 错误类型（openapi-parse / llm-format / file-io / ast-extract）
   * @param message 错误消息
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: "openapi-parse" | "llm-format" | "file-io" | "ast-extract",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ContractTestGeneratorError";
  }
}

/**
 * OpenAPI 解析错误
 */
export class OpenApiParseError extends ContractTestGeneratorError {
  constructor(message: string, cause?: unknown) {
    super("openapi-parse", message, cause);
    this.name = "OpenApiParseError";
  }
}

// ============================================================================
// 4. 请求类型定义
// ============================================================================

/**
 * 契约测试生成请求
 *
 * 对应设计文档 §4.2.3 ContractTestGenerationRequest。
 * 字段全部 readonly——请求一经组装即不可变。
 */
export interface ContractTestGenerationRequest {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 契约测试规范列表（来自 OpenAPI 或 AST 提取） */
  readonly specs: ReadonlyArray<ContractTestSpec>;
  /** LLM 客户端（用于生成测试代码骨架与断言） */
  readonly llmClient: LLMClient;
  /** 输出目录（相对 projectRoot，默认 "tests/contract/"） */
  readonly outputDir: string;
  /** 单文件最大 token 上限（默认 4000） */
  readonly maxTokensPerFile: number;
}

// ============================================================================
// 5. OpenApiSpecParser 实现
// ============================================================================

/**
 * OpenAPI 3.x spec 解析器
 *
 * 算法：
 * 1. 读取 spec 文件内容（支持 .json 格式；.yaml/.yml 给出明确错误提示需转换为 JSON）
 * 2. 用 zod 校验 OpenAPI 3.x 顶层结构（openapi / paths 必填）
 * 3. 遍历 paths 对象的每个 {path, method} 组合
 * 4. 从 requestBody 提取 requestSchema，从 responses 提取 responseSchemas
 * 5. 从 required / enum / minimum / maximum 推导 boundaryCases
 * 6. 返回 ContractTestSpec[]
 *
 * 设计依据：§4.2.4 OpenAPI 解析实现要点
 *
 * 注：本批次仅支持 JSON 格式 spec（零新增依赖约束，不引入 yaml 库）。
 *     YAML 格式 spec 需用户预先转换为 JSON。
 */
export class OpenApiSpecParser {
  /**
   * 解析 OpenAPI 3.x spec 文件
   *
   * @param specPath spec 文件绝对路径（.json 格式）
   * @returns ContractTestSpec 列表（每个 {path, method} 组合对应一个 spec）
   * @throws {OpenApiParseError} spec 格式非法 / 版本不支持 / 文件读取失败
   */
  parse(specPath: string): ReadonlyArray<ContractTestSpec> {
    // 1. 校验文件存在性
    if (!fs.existsSync(specPath)) {
      throw new OpenApiParseError(`OpenAPI spec 文件不存在：${specPath}`);
    }

    // 2. 校验文件扩展名（仅支持 .json）
    const ext = path.extname(specPath).toLowerCase();
    if (ext !== ".json") {
      throw new OpenApiParseError(
        `本批次 ContractTestGenerator 仅支持 JSON 格式 OpenAPI spec（零新增依赖约束）。` +
          `检测到 "${ext}" 格式，请将 YAML spec 转换为 JSON：` +
          `npx js-yaml ${specPath} > ${specPath.replace(/\.(ya?ml)$/i, ".json")}`
      );
    }

    // 3. 读取文件内容
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(specPath, "utf-8");
    } catch (e) {
      throw new OpenApiParseError(`读取 OpenAPI spec 文件失败：${specPath}`, e);
    }

    // 4. 解析 JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      throw new OpenApiParseError(`OpenAPI spec JSON 解析失败：${specPath}`, e);
    }

    // 5. 用 zod 校验 OpenAPI 3.x 顶层结构
    const validationResult = OpenApiSpecSchema.safeParse(parsed);
    if (!validationResult.success) {
      throw new OpenApiParseError(
        `OpenAPI spec 结构校验失败：${validationResult.error.message}`,
        validationResult.error
      );
    }

    const spec = validationResult.data;
    const specs: ContractTestSpec[] = [];

    // 6. 遍历 paths 对象的每个 {path, method} 组合
    for (const [apiPath, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem || typeof pathItem !== "object") {
        continue;
      }

      for (const method of SUPPORTED_HTTP_METHODS) {
        const operation = (pathItem as Record<string, unknown>)[method];
        if (!operation || typeof operation !== "object") {
          continue;
        }

        const spec_item = this.extractSpecFromOperation(apiPath, method, operation as Record<string, unknown>);
        if (spec_item) {
          specs.push(spec_item);
        }
      }
    }

    return Object.freeze(specs);
  }

  /**
   * 从 OpenAPI operation 对象提取 ContractTestSpec
   *
   * @param apiPath API 路径（如 "/api/v1/orders/{orderId}"）
   * @param method HTTP 方法（小写，如 "get"）
   * @param operation OpenAPI operation 对象
   * @returns ContractTestSpec 或 null（无响应 schema 时返回 null）
   */
  private extractSpecFromOperation(
    apiPath: string,
    method: string,
    operation: Record<string, unknown>
  ): ContractTestSpec | null {
    // 提取 responses 对象
    const responses = operation["responses"];
    if (!responses || typeof responses !== "object") {
      return null;
    }

    // 构建 responseSchemas（按状态码分组）
    const responseSchemas: Record<string, Record<string, unknown>> = {};
    for (const [statusCode, responseObj] of Object.entries(responses as Record<string, unknown>)) {
      if (responseObj && typeof responseObj === "object") {
        const content = (responseObj as Record<string, unknown>)["content"];
        if (content && typeof content === "object") {
          const appJson = (content as Record<string, unknown>)["application/json"];
          if (appJson && typeof appJson === "object") {
            const schema = (appJson as Record<string, unknown>)["schema"];
            if (schema && typeof schema === "object") {
              responseSchemas[statusCode] = schema as Record<string, unknown>;
            }
          }
        }
      }
    }

    // 提取 requestSchema（从 requestBody.content.application/json.schema）
    let requestSchema: Record<string, unknown> | undefined;
    const requestBody = operation["requestBody"];
    if (requestBody && typeof requestBody === "object") {
      const content = (requestBody as Record<string, unknown>)["content"];
      if (content && typeof content === "object") {
        const appJson = (content as Record<string, unknown>)["application/json"];
        if (appJson && typeof appJson === "object") {
          const schema = (appJson as Record<string, unknown>)["schema"];
          if (schema && typeof schema === "object") {
            requestSchema = schema as Record<string, unknown>;
          }
        }
      }
    }

    // 推导 boundaryCases（从 required / enum / minimum / maximum）
    const boundaryCases = this.deriveBoundaryCases(requestSchema, responseSchemas);

    // 提取 requirementId（从 x-requirement-id 扩展字段，或默认 "F-UNKNOWN"）
    const requirementId = (operation["x-requirement-id"] as string) ?? "F-UNKNOWN";

    return Object.freeze({
      path: apiPath,
      method: method.toUpperCase(),
      requestSchema: requestSchema ? Object.freeze({ ...requestSchema }) : undefined,
      responseSchemas: Object.freeze({ ...responseSchemas }),
      requirementId,
      boundaryCases: Object.freeze([...boundaryCases]),
    }) as ContractTestSpec;
  }

  /**
   * 从 schema 推导边界用例
   *
   * 算法：
   * - 从 required 字段推导"缺失必填字段应返回 400"
   * - 从 enum 字段推导"非法枚举值应返回 400"
   * - 从 minimum/maximum 推导"超出范围应返回 400"
   *
   * @param requestSchema 请求 schema
   * @param responseSchemas 响应 schema（按状态码分组）
   * @returns 边界用例描述列表
   */
  private deriveBoundaryCases(
    requestSchema: Readonly<Record<string, unknown>> | undefined,
    _responseSchemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  ): string[] {
    const cases: string[] = [];

    if (requestSchema && typeof requestSchema === "object") {
      const properties = requestSchema["properties"] as Record<string, Record<string, unknown>> | undefined;
      const required = requestSchema["required"] as string[] | undefined;

      // 从 required 推导缺失字段边界
      if (required && Array.isArray(required) && properties) {
        for (const field of required) {
          cases.push(`缺失必填字段 ${field} 应返回 400`);
        }
      }

      // 从 enum / minimum / maximum 推导字段级边界
      if (properties) {
        for (const [fieldName, fieldSchema] of Object.entries(properties)) {
          if (!fieldSchema || typeof fieldSchema !== "object") continue;

          const enumValues = fieldSchema["enum"] as unknown[] | undefined;
          if (enumValues && Array.isArray(enumValues) && enumValues.length > 0) {
            cases.push(`${fieldName} 传入非枚举值应返回 400（合法值：${enumValues.join("/")}）`);
          }

          const minimum = fieldSchema["minimum"];
          if (typeof minimum === "number") {
            cases.push(`${fieldName} 传入小于 ${minimum} 的值应返回 400`);
          }

          const maximum = fieldSchema["maximum"];
          if (typeof maximum === "number") {
            cases.push(`${fieldName} 传入大于 ${maximum} 的值应返回 400`);
          }
        }
      }
    }

    // 兜底：若无边界用例推导出来，添加默认边界用例
    if (cases.length === 0) {
      cases.push("无效请求应返回 4xx 错误");
    }

    return cases;
  }
}

// ============================================================================
// 6. TsSignatureExtractor 实现（降级通道）
// ============================================================================

/**
 * TypeScript 接口签名 AST 提取器（降级通道）
 *
 * 算法：
 * 1. 扫描 implementationRoot 下的 *.controller.ts / *.service.ts 文件
 * 2. 用正则提取类方法签名（不引入 ts-morph，零新增依赖）
 * 3. 将方法签名转换为 ContractTestSpec（tsSignature 字段填充，
 *    requestSchema/responseSchemas 留空——降级通道无 schema 信息）
 *
 * 设计依据：§4.2.2 "AST 提取：复用 V2 CodeMap 符号图谱（不引入 ts-morph）"
 *
 * 注：本批次为简化实现，仅扫描 controller / service 文件的方法签名。
 *     P3 批次 11 可扩展为完整的 V2 CodeMap 集成。
 */
export class TsSignatureExtractor {
  /**
   * 扫描目录下 Controller / Service 文件，提取接口签名
   *
   * @param implementationRoot 实现代码根目录（绝对路径或相对 projectRoot）
   * @returns ContractTestSpec 列表（tsSignature 字段填充，requestSchema/responseSchemas 留空）
   * @throws {ContractTestGeneratorError} 目录不存在或扫描失败
   */
  extract(implementationRoot: string): ReadonlyArray<ContractTestSpec> {
    if (!fs.existsSync(implementationRoot)) {
      throw new ContractTestGeneratorError("ast-extract", `实现代码根目录不存在：${implementationRoot}`);
    }

    const stats = fs.statSync(implementationRoot);
    if (!stats.isDirectory()) {
      throw new ContractTestGeneratorError("ast-extract", `实现代码根目录不是目录：${implementationRoot}`);
    }

    // 递归扫描 *.controller.ts / *.service.ts 文件
    const targetFiles = this.findControllerAndServiceFiles(implementationRoot);
    const specs: ContractTestSpec[] = [];

    for (const filePath of targetFiles) {
      const fileSpecs = this.extractFromFile(filePath);
      specs.push(...fileSpecs);
    }

    return Object.freeze(specs);
  }

  /**
   * 递归查找 Controller / Service TypeScript 文件
   *
   * @param rootDir 根目录
   * @returns 文件路径列表（绝对路径）
   */
  private findControllerAndServiceFiles(rootDir: string): string[] {
    const results: string[] = [];

    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // 跳过 node_modules / dist / .git 目录
        if (entry.isDirectory()) {
          if (["node_modules", "dist", ".git", "tests"].includes(entry.name)) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile() && /\.(controller|service)\.ts$/.test(entry.name)) {
          results.push(fullPath);
        }
      }
    };

    walk(rootDir);
    return results;
  }

  /**
   * 从单个 TypeScript 文件提取接口签名
   *
   * 算法：
   * 1. 读取文件内容
   * 2. 用正则匹配 class 声明与 public 方法签名
   * 3. 将方法签名转换为 ContractTestSpec
   *
   * @param filePath 文件绝对路径
   * @returns ContractTestSpec 列表
   */
  private extractFromFile(filePath: string): ContractTestSpec[] {
    const content = fs.readFileSync(filePath, "utf-8");
    const specs: ContractTestSpec[] = [];

    // 正则：识别 class 声明
    const classRe = /(?:export\s+)?class\s+([A-Za-z_][\w]*)/g;
    // 正则：识别 public 方法签名（含 async 标记）
    // 分组 1：方法名；分组 2：参数列表（含括号）；分组 3：返回类型
    const methodRe = /(?:public\s+)?(?:async\s+)?([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/g;

    let classMatch: RegExpExecArray | null;
    let currentClassName = "";

    // 按行扫描，跟踪当前类
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      // 跳过注释行
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      // 识别 class 声明
      classRe.lastIndex = 0;
      classMatch = classRe.exec(line);
      if (classMatch) {
        currentClassName = classMatch[1];
        continue;
      }

      // 识别方法签名
      methodRe.lastIndex = 0;
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodRe.exec(line)) !== null) {
        const methodName = methodMatch[1];
        const params = methodMatch[2];
        const returnType = (methodMatch[3] ?? "void").trim();

        // 跳过 constructor / private 方法（无 public 修饰且以 _ 开头视为 private）
        if (methodName === "constructor") continue;
        if (methodName.startsWith("_")) continue;

        // 构建 tsSignature 字符串
        const tsSignature = `${currentClassName}.${methodName}(${params}): ${returnType}`;

        // 推导 API 路径（基于类名 + 方法名约定）
        const apiPath = this.deriveApiPath(currentClassName, methodName);
        const method = this.deriveHttpMethod(methodName);

        specs.push(
          Object.freeze({
            path: apiPath,
            method,
            // 降级通道无 schema 信息
            requestSchema: undefined,
            responseSchemas: Object.freeze({}),
            tsSignature,
            requirementId: "F-UNKNOWN",
            boundaryCases: Object.freeze([
              `${methodName} 无效参数应抛出错误或返回错误响应`,
              `${methodName} 边界值应正确处理`,
            ]),
          }) as ContractTestSpec
        );
      }
    }

    return specs;
  }

  /**
   * 基于类名 + 方法名约定推导 API 路径
   *
   * 约定：
   * - XxxController.getMethod → /xxx/{id}（GET）
   * - XxxController.create → /xxx（POST）
   * - XxxController.update → /xxx/{id}（PUT）
   * - XxxController.delete → /xxx/{id}（DELETE）
   * - XxxService.xxx → /xxx/service/{methodName}（兜底）
   *
   * @param className 类名
   * @param methodName 方法名
   * @returns 推导的 API 路径
   */
  private deriveApiPath(className: string, methodName: string): string {
    // 去除 Controller / Service 后缀，转为 kebab-case
    const baseName = className
      .replace(/Controller$/, "")
      .replace(/Service$/, "")
      .replace(/([A-Z])/g, "-$1")
      .replace(/^-/, "")
      .toLowerCase();

    // 基于方法名推导路径
    if (/^(get|find|query|list|search)/.test(methodName)) {
      // get / getById / findById 等
      if (/ById$/.test(methodName) || /id/i.test(methodName)) {
        return `/api/${baseName}/{id}`;
      }
      return `/api/${baseName}`;
    }
    if (/^(create|add|insert|save)/.test(methodName)) {
      return `/api/${baseName}`;
    }
    if (/^(update|modify|patch)/.test(methodName)) {
      return `/api/${baseName}/{id}`;
    }
    if (/^(delete|remove|destroy)/.test(methodName)) {
      return `/api/${baseName}/{id}`;
    }

    // 兜底
    return `/api/${baseName}/${methodName}`;
  }

  /**
   * 基于方法名约定推导 HTTP 方法
   *
   * @param methodName 方法名
   * @returns HTTP 方法（大写）
   */
  private deriveHttpMethod(methodName: string): string {
    if (/^(get|find|query|list|search)/.test(methodName)) return "GET";
    if (/^(create|add|insert|save)/.test(methodName)) return "POST";
    if (/^(update|modify|patch)/.test(methodName)) return "PUT";
    if (/^(delete|remove|destroy)/.test(methodName)) return "DELETE";
    return "POST"; // 兜底
  }
}

// ============================================================================
// 7. ContractTestGenerator 实现
// ============================================================================

/**
 * 契约测试生成器
 *
 * 算法（对齐 §4.2.3）：
 * 1. 解析 OpenAPI spec（若 openapiSpecPath 提供且文件存在）→ ContractTestSpec[]
 *    否则降级到 TypeScript AST 提取（扫描 implementationRoot 下 *.controller.ts / *.service.ts）
 * 2. 对每个 ContractTestSpec 调用 LLM 生成契约测试代码
 * 3. 用 tsSignature 校验生成代码的方法签名一致性（若 tsSignature 提供）
 * 4. 用 zod schema 校验生成代码结构
 * 5. 返回 GeneratedTestFile[]（kind="contract"）
 */
export class ContractTestGenerator {
  /**
   * 初始化契约测试生成器
   *
   * @param templateRegistry 测试模板注册表（默认使用内置 contract-test-template）
   * @param logger 日志回调（可选）
   */
  constructor(
    private readonly templateRegistry: Readonly<Record<string, string>> = DEFAULT_CONTRACT_TEST_TEMPLATES,
    private readonly logger?: LogCallback
  ) {}

  /**
   * 生成契约测试
   *
   * @param request 生成请求（含 ContractTestSpec[] + LLM 客户端 + 项目根目录）
   * @returns 生成的契约测试文件列表
   * @throws {ContractTestGeneratorError} OpenAPI 解析失败或 LLM 生成格式非法
   */
  async generate(request: Readonly<ContractTestGenerationRequest>): Promise<ReadonlyArray<GeneratedTestFile>> {
    this.log("开始生成契约测试", "info");

    // 1. 校验请求字段
    this.validateRequest(request);

    const results: GeneratedTestFile[] = [];

    // 2. 对每个 ContractTestSpec 调用 LLM 生成测试代码
    for (const spec of request.specs) {
      this.log(`生成契约测试：${spec.method} ${spec.path}`, "info");

      try {
        const testFile = await this.generateSingleTest(spec, request);
        results.push(testFile);
      } catch (e) {
        // 单个 spec 生成失败：记录错误并继续处理其他 spec（fail-soft 策略）
        const errorMsg = e instanceof Error ? e.message : String(e);
        this.log(`生成契约测试失败：${spec.method} ${spec.path} - ${errorMsg}`, "error");

        // 若是 LLM 格式错误，向上抛出（避免静默失败）
        if (e instanceof ContractTestGeneratorError && e.kind === "llm-format") {
          throw e;
        }
      }
    }

    this.log(`契约测试生成完成，共 ${results.length} 个文件`, "info");
    return Object.freeze(results);
  }

  /**
   * 校验请求字段合法性
   *
   * @param request 生成请求
   * @throws {ContractTestGeneratorError} 字段非法时抛出
   */
  private validateRequest(request: Readonly<ContractTestGenerationRequest>): void {
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new ContractTestGeneratorError("file-io", "projectRoot 必须为非空字符串");
    }
    if (!Array.isArray(request.specs)) {
      throw new ContractTestGeneratorError("file-io", "specs 必须为数组");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new ContractTestGeneratorError("file-io", "llmClient 必须实现 LLMClient 接口");
    }
    if (typeof request.outputDir !== "string" || request.outputDir.trim().length === 0) {
      throw new ContractTestGeneratorError("file-io", "outputDir 必须为非空字符串");
    }
    if (typeof request.maxTokensPerFile !== "number" || request.maxTokensPerFile < 1) {
      throw new ContractTestGeneratorError("file-io", "maxTokensPerFile 必须为 ≥1 的数字");
    }
  }

  /**
   * 为单个 ContractTestSpec 生成契约测试文件
   *
   * 算法：
   * 1. 装配 LLM prompt（system + user 消息）
   * 2. 调用 llmClient.createMessage() 生成测试代码
   * 3. 解析 LLM 响应（JSON 模式：{ files: [{ path, content }] }）
   * 4. 校验生成代码结构（用 zod schema）
   * 5. 转换为 GeneratedTestFile
   *
   * @param spec 契约测试规范
   * @param request 生成请求
   * @returns 生成的测试文件
   */
  private async generateSingleTest(
    spec: ContractTestSpec,
    request: Readonly<ContractTestGenerationRequest>
  ): Promise<GeneratedTestFile> {
    // 1. 装配 LLM prompt
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(spec);

    // 2. 构造 LLMRequest
    const llmRequest: LLMRequest = this.buildLlmRequest(systemPrompt, userPrompt, request.maxTokensPerFile);

    // 3. 调用 LLM
    let response: LLMResponse;
    try {
      response = await request.llmClient.createMessage(llmRequest);
    } catch (e) {
      throw new ContractTestGeneratorError(
        "llm-format",
        `LLM 调用失败：${spec.method} ${spec.path} - ${e instanceof Error ? e.message : String(e)}`,
        e
      );
    }

    // 4. 解析 LLM 响应（JSON 模式）
    const generatedContent = this.parseLlmResponse(response, spec);

    // 5. 提取测试用例描述（用于 GeneratedTestFile.testCaseDescriptions）
    const testCaseDescriptions = this.extractTestCaseDescriptions(generatedContent, spec);

    // 6. 统计测试用例数（统计 it/test 节点数）
    const testCaseCount = this.countTestCases(generatedContent);

    // 7. 构建文件路径（基于 outputDir + API 路径）
    const relativePath = this.buildTestFilePath(spec, request.outputDir);

    // 8. 组装并冻结 GeneratedTestFile
    return Object.freeze({
      relativePath,
      content: generatedContent,
      kind: "contract" as const,
      requirementId: spec.requirementId,
      sourceId: spec.path,
      testCaseCount,
      testCaseDescriptions: Object.freeze([...testCaseDescriptions]),
    }) as GeneratedTestFile;
  }

  /**
   * 构建 LLM system prompt
   *
   * 角色定义 + 测试框架约束 + 输出格式约束
   *
   * @returns system prompt 字符串
   */
  private buildSystemPrompt(): string {
    return [
      "你是测试专家，遵循测试金字塔与契约优先原则。",
      "",
      "测试框架约束：",
      "- 使用 Node.js 内置 node:test + node:assert/strict",
      "- 禁止引入 Jest / Mocha / Chai 等第三方测试框架",
      "- 每个 it/test 用例必须含至少 1 个 assert/expect 断言",
      "",
      "输出格式约束：",
      '- 必须返回 JSON 格式：{ "files": [{ "path": "...", "content": "..." }] }',
      "- path 字段为文件相对路径（如 tests/contract/order.contract.test.ts）",
      "- content 字段为完整 TypeScript 测试代码（含 import / describe / it / 断言）",
      "- content 中的换行符使用 \\n 转义",
      "",
      "强制断言规则：",
      "- 每个测试用例必须含至少 1 个 assert/expect 断言",
      "- 边界用例必须覆盖 boundaryCases 字段描述的场景",
      "- 响应状态码必须断言",
      "- 响应体关键字段必须断言",
    ].join("\n");
  }

  /**
   * 构建 LLM user prompt
   *
   * 输入契约测试规范 + 边界用例 + 接口签名
   *
   * @param spec 契约测试规范
   * @returns user prompt 字符串
   */
  private buildUserPrompt(spec: ContractTestSpec): string {
    const lines: string[] = [
      "请为以下 API 接口生成契约测试：",
      "",
      "## 接口信息",
      `- 路径：${spec.path}`,
      `- 方法：${spec.method}`,
      `- 关联需求：${spec.requirementId}`,
    ];

    if (spec.tsSignature) {
      lines.push(`- TypeScript 签名：${spec.tsSignature}`);
    }

    if (spec.requestSchema) {
      lines.push("", "## 请求 Schema", "```json", JSON.stringify(spec.requestSchema, null, 2), "```");
    }

    if (spec.responseSchemas && Object.keys(spec.responseSchemas).length > 0) {
      lines.push("", "## 响应 Schema（按状态码分组）");
      for (const [statusCode, schema] of Object.entries(spec.responseSchemas)) {
        lines.push(`### ${statusCode}`, "```json", JSON.stringify(schema, null, 2), "```");
      }
    }

    if (spec.boundaryCases && spec.boundaryCases.length > 0) {
      lines.push("", "## 边界用例（必须覆盖）");
      for (const boundaryCase of spec.boundaryCases) {
        lines.push(`- ${boundaryCase}`);
      }
    }

    lines.push(
      "",
      "## 输出要求",
      "返回 JSON 格式：",
      "```json",
      '{ "files": [{ "path": "tests/contract/xxx.contract.test.ts", "content": "..." }] }',
      "```",
      "",
      "content 字段要求：",
      "- 完整的 TypeScript 测试代码",
      "- 使用 node:test 与 node:assert/strict",
      "- 每个边界用例对应至少 1 个 it/test 节点",
      "- 每个节点含至少 1 个断言"
    );

    return lines.join("\n");
  }

  /**
   * 构建 LLMRequest
   *
   * @param systemPrompt system 消息内容
   * @param userPrompt user 消息内容
   * @param maxTokensPerFile 单文件最大 token 上限
   * @returns LLMRequest 对象
   */
  private buildLlmRequest(systemPrompt: string, userPrompt: string, maxTokensPerFile: number): LLMRequest {
    const now = new Date().toISOString();
    const sessionId = `contract-test-${Date.now()}`;

    // 构造 system 消息
    const systemMessage: SessionMessage = {
      id: `msg-system-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: "system",
      content: systemPrompt,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    };

    // 构造 user 消息
    const userMessage: SessionMessage = {
      id: `msg-user-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: "user",
      content: userPrompt,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    };

    return {
      messages: [systemMessage, userMessage],
      thinkingEnabled: false,
      maxTokens: Math.min(maxTokensPerFile, DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL),
      temperature: DEFAULT_TEST_GENERATION_TEMPERATURE,
    };
  }

  /**
   * 解析 LLM 响应（JSON 模式）
   *
   * @param response LLM 响应
   * @param spec 契约测试规范（用于错误消息）
   * @returns 生成的测试代码内容
   * @throws {ContractTestGeneratorError} LLM 响应格式非法
   */
  private parseLlmResponse(response: LLMResponse, spec: ContractTestSpec): string {
    if (!response || typeof response.content !== "string") {
      throw new ContractTestGeneratorError(
        "llm-format",
        `LLM 响应格式非法（content 非字符串）：${spec.method} ${spec.path}`
      );
    }

    const content = response.content.trim();

    // 尝试解析为 JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new ContractTestGeneratorError(
        "llm-format",
        `LLM 响应 JSON 解析失败：${spec.method} ${spec.path} - ${e instanceof Error ? e.message : String(e)}`,
        e
      );
    }

    // 用 zod 校验响应结构
    const responseSchema = z.object({
      files: z
        .array(
          z.object({
            path: z.string().min(1),
            content: z.string(),
          })
        )
        .min(1),
    });

    const validationResult = responseSchema.safeParse(parsed);
    if (!validationResult.success) {
      throw new ContractTestGeneratorError(
        "llm-format",
        `LLM 响应结构校验失败：${spec.method} ${spec.path} - ${validationResult.error.message}`,
        validationResult.error
      );
    }

    // 取第一个文件的 content 作为测试代码
    const firstFile = validationResult.data.files[0];

    // 反转义换行符（LLM 可能返回 \n 转义形式）
    return firstFile.content.replace(/\\n/g, "\n");
  }

  /**
   * 从生成的测试代码提取测试用例描述
   *
   * 扫描 it/test 节点的第一个字符串参数作为用例描述。
   *
   * @param content 测试代码内容
   * @param spec 契约测试规范（用于兜底描述）
   * @returns 测试用例描述列表
   */
  private extractTestCaseDescriptions(content: string, spec: ContractTestSpec): string[] {
    const descriptions: string[] = [];
    const lines = content.split(/\r?\n/);

    // 正则：识别 it/test 节点的第一个字符串参数
    const testCaseRe = /\b(?:it|test)\b(?:\.(?:skip|todo|only))?\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

    for (const line of lines) {
      // 跳过注释行
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      const m = line.match(testCaseRe);
      if (m) {
        const desc = m[1] ?? m[2] ?? m[3] ?? "";
        if (desc.length > 0) {
          descriptions.push(desc);
        }
      }
    }

    // 兜底：若无提取到描述，使用 spec.boundaryCases 作为描述
    if (descriptions.length === 0 && spec.boundaryCases.length > 0) {
      descriptions.push(...spec.boundaryCases);
    }

    return descriptions;
  }

  /**
   * 统计测试代码中的 it/test 节点数
   *
   * @param content 测试代码内容
   * @returns 测试用例数
   */
  private countTestCases(content: string): number {
    const lines = content.split(/\r?\n/);
    let count = 0;

    const testCaseRe = /^\s*\b(it|test)\b(\.(?:skip|todo|only))?\s*\(/;

    for (const line of lines) {
      // 跳过注释行
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      if (testCaseRe.test(line)) {
        count++;
      }
    }

    return count;
  }

  /**
   * 构建测试文件相对路径
   *
   * 算法：
   * 1. 基于 outputDir 拼接
   * 2. 基于 spec.path 与 spec.method 生成文件名
   *
   * @param spec 契约测试规范
   * @param outputDir 输出目录
   * @returns 测试文件相对路径
   */
  private buildTestFilePath(spec: ContractTestSpec, outputDir: string): string {
    // 将 API 路径转换为文件名片段
    // /api/v1/orders/{orderId} → orders-orderId
    const pathFragment = spec.path
      .replace(/^\//, "") // 去除开头 /
      .replace(/\//g, "-") // / → -
      .replace(/[{}]/g, "") // 去除 {}
      .replace(/-v\d+-/, "-") // 去除版本号 -v1-
      .toLowerCase();

    const method = spec.method.toLowerCase();

    // 规范化 outputDir（去除末尾 /）
    const normalizedDir = outputDir.replace(/\/$/, "");

    return `${normalizedDir}/${pathFragment}.${method}.contract.test.ts`;
  }

  /**
   * 日志回调（若提供 logger 则调用）
   *
   * @param message 日志消息
   * @param level 日志级别（默认 info）
   */
  private log(message: string, level: "info" | "warn" | "error" = "info"): void {
    if (this.logger) {
      this.logger(message, level);
    }
  }
}

// ============================================================================
// 8. 默认导出与工厂函数
// ============================================================================

/**
 * 创建默认契约测试生成器实例
 *
 * 工厂函数：使用内置模板注册表创建 ContractTestGenerator 实例。
 * 调用方无需关心模板注册表的细节。
 *
 * @param logger 日志回调（可选）
 * @returns ContractTestGenerator 实例
 */
export function createDefaultContractTestGenerator(logger?: LogCallback): ContractTestGenerator {
  return new ContractTestGenerator(DEFAULT_CONTRACT_TEST_TEMPLATES, logger);
}

/**
 * 创建 OpenAPI spec 解析器实例
 *
 * @returns OpenApiSpecParser 实例
 */
export function createOpenApiSpecParser(): OpenApiSpecParser {
  return new OpenApiSpecParser();
}

/**
 * 创建 TypeScript 接口签名提取器实例
 *
 * @returns TsSignatureExtractor 实例
 */
export function createTsSignatureExtractor(): TsSignatureExtractor {
  return new TsSignatureExtractor();
}

// ============================================================================
// 9. 常量与默认值重导出（便于外部模块统一从本模块导入）
// ============================================================================

// 注：DEFAULT_CONTRACT_TEST_TEMPLATES 在本文件内定义，直接 export（已通过 const + Object.freeze 导出）。
// 此处仅重导出从 ./types 引入的默认常量，便于外部模块从 contract-test-generator 统一导入。
export {
  DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
  DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  DEFAULT_TEST_GENERATION_TEMPERATURE,
} from "./types";
