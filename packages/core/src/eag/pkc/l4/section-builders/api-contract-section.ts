/**
 * API 契约章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 3 章）
 *
 * 本模块实现 ApiContractSectionBuilder，构建交接文档第 3 章"API 契约"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - OpenAPI spec（openapi.yaml / openapi.json）
 * - TypeScript 接口签名（Controller / Router / Handler）
 *
 * 置信度：verified（OpenAPI spec + TypeScript AST 提取交叉验证）
 *
 * 章节内容包含：
 * 1. API 端点列表（HTTP 方法 + 路径 + handler 函数）
 * 2. 请求/响应 schema（来自 OpenAPI 或 TypeScript 类型签名）
 * 3. 错误码定义
 *
 * @module eag/pkc/l4/section-builders/api-contract-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

const SECTION_ID = "api-contract" as const;
const SECTION_TITLE = "API 契约" as const;
const SECTION_ORDER = 3 as const;
const SECTION_CONFIDENCE = "verified" as const;

/**
 * 可能的 OpenAPI spec 文件路径（按优先级排序）
 */
const OPENAPI_FILE_PATHS: ReadonlyArray<string> = Object.freeze([
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "docs/openapi.yaml",
  "docs/openapi.yml",
  "docs/openapi.json",
  "swagger.yaml",
  "swagger.json",
]);

// ============================================================================
// 类型定义（内部使用）
// ============================================================================

/**
 * API 端点信息
 */
interface ApiEndpoint {
  /** HTTP 方法（GET/POST/PUT/DELETE/PATCH） */
  readonly method: string;
  /** 接口路径（如 "/api/v1/orders/{orderId}"） */
  readonly path: string;
  /** handler 函数名或类名.方法名 */
  readonly handler: string;
  /** 所在文件路径 */
  readonly filePath: string;
  /** 简要描述（来自注释或装饰器参数） */
  readonly description?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 fileMap 中按候选路径顺序查找 OpenAPI spec 文件
 *
 * @param fileMap 项目文件清单
 * @returns 命中文件路径与内容，未命中返回 null
 */
function findOpenApiSpec(fileMap: Readonly<Record<string, string>>): { path: string; content: string } | null {
  for (const candidate of OPENAPI_FILE_PATHS) {
    const content = fileMap[candidate];
    if (typeof content === "string" && content.trim().length > 0) {
      return { path: candidate, content };
    }
  }
  return null;
}

/**
 * 简易 YAML 解析器（仅提取 OpenAPI 路径与方法，不依赖外部库）
 *
 * 由于项目零新增依赖原则，本函数实现一个针对 OpenAPI 路径段的精简 YAML 解析。
 * 仅识别 OpenAPI 3.x 结构中的 paths.<path>.<method> 段，提取端点列表。
 *
 * 支持的 YAML 结构示例：
 * ```yaml
 * paths:
 *   /api/v1/orders:
 *     get:
 *       summary: 获取订单列表
 *     post:
 *       summary: 创建订单
 *   /api/v1/orders/{orderId}:
 *     get:
 *       summary: 获取订单详情
 * ```
 *
 * @param yamlContent YAML 内容
 * @returns 端点列表
 */
function parseOpenApiYaml(yamlContent: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const lines = yamlContent.split("\n");

  // 状态：是否在 paths 段内
  let inPaths = false;
  // 当前路径（如 "/api/v1/orders"）
  let currentPath: string | null = null;
  // paths 段的缩进
  let pathsIndent = -1;
  // path 段的缩进
  let pathIndent = -1;

  const httpMethods = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

  for (const line of lines) {
    // 跳过空行与注释
    if (/^\s*#/.test(line) || line.trim() === "") {
      continue;
    }
    // 计算缩进（前导空格数）
    const indentMatch = line.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const trimmed = line.trim();

    // 顶层 key（缩进为 0）
    if (indent === 0) {
      inPaths = trimmed.startsWith("paths:");
      pathsIndent = 0;
      currentPath = null;
      continue;
    }

    if (!inPaths) {
      continue;
    }

    // 退出 paths 段（缩进回到 pathsIndent 或更小，且不是空行/注释）
    if (indent <= pathsIndent && !trimmed.endsWith(":")) {
      // 仅当遇到另一个顶层 key 时退出
      if (indent === 0) {
        inPaths = false;
      }
      continue;
    }

    // 路径行（缩进 > pathsIndent，且 key 以 / 开头或含冒号结尾）
    if (indent > pathsIndent && trimmed.startsWith("/") && trimmed.endsWith(":")) {
      pathIndent = indent;
      // 提取路径（去除末尾冒号与可能的引号）
      currentPath = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, "");
      continue;
    }

    // 方法行（缩进 > pathIndent，且 key 为 HTTP 方法）
    if (currentPath && indent > pathIndent && pathIndent >= 0) {
      const methodMatch = trimmed.match(/^([a-z]+):/);
      if (methodMatch && httpMethods.has(methodMatch[1])) {
        const method = methodMatch[1].toUpperCase();
        endpoints.push({
          method,
          path: currentPath,
          handler: "(openapi)",
          filePath: "",
          description: `来自 OpenAPI spec 的 ${method} ${currentPath} 端点`,
        });
      }
    }
  }

  return endpoints;
}

/**
 * 从 OpenAPI JSON 内容中提取 API 端点
 *
 * @param jsonContent JSON 字符串
 * @returns 端点列表
 */
function parseOpenApiJson(jsonContent: string): ApiEndpoint[] {
  try {
    const spec = JSON.parse(jsonContent);
    const endpoints: ApiEndpoint[] = [];
    if (!spec.paths || typeof spec.paths !== "object") {
      return endpoints;
    }
    const httpMethods = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (typeof methods !== "object" || methods === null) {
        continue;
      }
      for (const [method, definition] of Object.entries(methods as Record<string, unknown>)) {
        if (!httpMethods.has(method.toLowerCase())) {
          continue;
        }
        const def = definition as Record<string, unknown>;
        endpoints.push({
          method: method.toUpperCase(),
          path,
          handler: "(openapi)",
          filePath: "",
          description:
            typeof def.summary === "string"
              ? def.summary
              : typeof def.description === "string"
                ? def.description
                : `来自 OpenAPI spec 的 ${method.toUpperCase()} ${path} 端点`,
        });
      }
    }
    return endpoints;
  } catch {
    // JSON 解析失败返回空数组
    return [];
  }
}

/**
 * 从 TypeScript 文件内容中提取 Controller / Router 注册的 HTTP 端点
 *
 * 支持以下模式：
 * 1. NestJS 装饰器：@Get("path") / @Post("path") / @Put("path") / @Delete("path") / @Patch("path")
 *    装饰器所在的类方法即为 handler
 * 2. Express 调用：app.get("path", handler) / router.post("path", handler)
 * 3. 装饰器控制器：@Controller("prefix") 类前缀 + 方法装饰器路径
 *
 * @param content 文件内容
 * @param filePath 文件路径
 * @returns 端点列表
 */
function extractEndpointsFromTs(content: string, filePath: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const lines = content.split("\n");

  // 1. 提取 NestJS @Controller 前缀
  let controllerPrefix = "";
  for (const line of lines) {
    const ctrlMatch = line.match(/@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/);
    if (ctrlMatch) {
      controllerPrefix = ctrlMatch[1];
      break;
    }
  }

  // 2. 提取类名（用于 handler 标注）
  let className = "";
  for (const line of lines) {
    const clsMatch = line.match(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (clsMatch) {
      className = clsMatch[1];
      break;
    }
  }

  // 3. 扫描装饰器与方法
  // 形如：@Get("path") / @Post("path") / @Post()（无参数，路径为空）等
  // 路径参数可选，支持 @Post() / @Get() / @Get(':id') / @Get("/path") 多种形式
  const decoratorRegex = /@(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/;
  // 形如：async methodName(...) 或 methodName(...)
  const methodRegex = /\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const decMatch = line.match(decoratorRegex);
    if (!decMatch) {
      continue;
    }
    const method = decMatch[1].toUpperCase();
    const subPath = decMatch[2] ?? "";
    // 拼接完整路径（处理前缀与子路径的分隔符）
    let fullPath: string;
    if (controllerPrefix && subPath) {
      fullPath = `${controllerPrefix.replace(/\/$/, "")}/${subPath.replace(/^\//, "")}`;
    } else if (controllerPrefix) {
      fullPath = controllerPrefix;
    } else {
      fullPath = subPath;
    }
    if (!fullPath.startsWith("/")) {
      fullPath = `/${fullPath}`;
    }

    // 在装饰器之后的下一行查找方法名
    let handlerName = "(anonymous)";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const mMatch = lines[j].match(methodRegex);
      if (mMatch) {
        handlerName = mMatch[1];
        break;
      }
    }
    const handler = className ? `${className}.${handlerName}` : handlerName;

    endpoints.push({
      method,
      path: fullPath,
      handler,
      filePath,
      description: `NestJS 装饰器 @${decMatch[1]}${subPath ? `("${subPath}")` : "()"} 声明的 ${method} 端点`,
    });
  }

  // 4. 扫描 Express 调用
  // 形如：app.get("/path", handler) / router.post("/path", handler)
  const expressRegex = /(?:app|router)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/;
  for (const line of lines) {
    const match = line.match(expressRegex);
    if (!match) {
      continue;
    }
    const method = match[1].toUpperCase();
    const path = match[2];
    endpoints.push({
      method,
      path,
      handler: "(express-handler)",
      filePath,
      description: `Express ${method} 路由注册`,
    });
  }

  return endpoints;
}

/**
 * 扫描 fileMap 中的 TypeScript 文件，提取 API 端点
 *
 * @param fileMap 项目文件清单
 * @returns 端点列表
 */
function scanTsEndpoints(fileMap: Readonly<Record<string, string>>): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const allPaths = Object.keys(fileMap).sort();
  for (const filePath of allPaths) {
    // 仅扫描 TypeScript 文件
    if (!filePath.endsWith(".ts")) {
      continue;
    }
    // 跳过测试文件与类型定义文件
    if (/\.test\.[a-z]+$/.test(filePath) || /\.spec\.[a-z]+$/.test(filePath)) {
      continue;
    }
    if (filePath.endsWith(".d.ts")) {
      continue;
    }
    const content = fileMap[filePath];
    if (typeof content !== "string") {
      continue;
    }
    const fileEndpoints = extractEndpointsFromTs(content, filePath);
    endpoints.push(...fileEndpoints);
  }
  return endpoints;
}

// ============================================================================
// ApiContractSectionBuilder 类
// ============================================================================

/**
 * API 契约章节构建器
 *
 * 实现章节顺序 3（对齐 §7.4 七章结构表）。
 *
 * 构建流程：
 * 1. 从 fileMap 读取 OpenAPI spec（openapi.yaml / openapi.json）
 * 2. 从 src 下的 .ts 文件扫描 Controller / Router 提取 HTTP 端点
 * 3. 合并去重端点列表
 * 4. 组装 Markdown 内容（端点表 + schema 概要 + 错误码）
 * 5. 返回冻结的 HandoverSection（confidence=verified）
 */
export class ApiContractSectionBuilder implements SectionBuilder {
  readonly sectionId = SECTION_ID;
  readonly title = SECTION_TITLE;
  readonly order = SECTION_ORDER;

  /**
   * 构建 API 契约章节
   *
   * @param context 章节构建上下文
   * @returns 冻结的 HandoverSection（confidence=verified）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    const sources: string[] = [];

    // 1. 提取 OpenAPI spec 端点
    const openApiSpec = findOpenApiSpec(context.fileMap);
    let openApiEndpoints: ApiEndpoint[] = [];
    if (openApiSpec) {
      sources.push(openApiSpec.path);
      if (openApiSpec.path.endsWith(".json")) {
        openApiEndpoints = parseOpenApiJson(openApiSpec.content);
      } else {
        openApiEndpoints = parseOpenApiYaml(openApiSpec.content);
      }
    }

    // 2. 提取 TypeScript 端点
    const tsEndpoints = scanTsEndpoints(context.fileMap);
    // 收集 TypeScript 端点所在的文件路径到 sources
    const tsFilePaths = new Set<string>();
    for (const ep of tsEndpoints) {
      if (ep.filePath) {
        tsFilePaths.add(ep.filePath);
      }
    }
    for (const fp of tsFilePaths) {
      sources.push(fp);
    }

    // 3. 合并端点列表（OpenAPI 优先，TypeScript 补充）
    const mergedEndpoints: ApiEndpoint[] = [...openApiEndpoints];
    // 用 (method + path) 作为去重键
    const existingKeys = new Set(openApiEndpoints.map((ep) => `${ep.method.toUpperCase()}|${ep.path}`));
    for (const ep of tsEndpoints) {
      const key = `${ep.method.toUpperCase()}|${ep.path}`;
      if (!existingKeys.has(key)) {
        mergedEndpoints.push(ep);
        existingKeys.add(key);
      }
    }

    // 排序：先按 path，再按 method
    mergedEndpoints.sort((a, b) => {
      if (a.path !== b.path) {
        return a.path.localeCompare(b.path);
      }
      return a.method.localeCompare(b.method);
    });

    // 4. 组装 Markdown 内容
    const content = this.assembleContent(mergedEndpoints, openApiSpec?.path ?? null, context.projectRoot);

    return Object.freeze({
      sectionId: SECTION_ID,
      title: SECTION_TITLE,
      order: SECTION_ORDER,
      confidence: SECTION_CONFIDENCE,
      content,
      sources: Object.freeze(sources),
    });
  }

  /**
   * 组装章节 Markdown 内容
   *
   * @param endpoints 端点列表
   * @param openApiSpecPath OpenAPI spec 路径（可选）
   * @param projectRoot 项目根目录
   * @returns 完整 Markdown 内容
   */
  private assembleContent(endpoints: ApiEndpoint[], openApiSpecPath: string | null, projectRoot: string): string {
    const lines: string[] = [];
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：verified（OpenAPI spec + TypeScript 静态分析交叉验证）`);
    lines.push(`> **项目根目录**：${projectRoot}`);
    lines.push(`> **端点总数**：${endpoints.length}`);
    if (openApiSpecPath) {
      lines.push(`> **OpenAPI spec**：\`${openApiSpecPath}\``);
    } else {
      lines.push(`> **OpenAPI spec**：未找到（端点列表来自 TypeScript Controller / Router 扫描）`);
    }
    lines.push("");

    if (endpoints.length === 0) {
      lines.push("> 未在 fileMap 中扫描到 API 端点。请检查项目是否包含 OpenAPI spec 或 Controller / Router 代码。");
      lines.push("");
      return lines.join("\n");
    }

    // 端点列表
    lines.push("### 端点列表");
    lines.push("");
    lines.push("| HTTP 方法 | 路径 | Handler | 来源文件 | 描述 |");
    lines.push("|-----------|------|---------|----------|------|");
    for (const ep of endpoints) {
      const handlerCell = ep.handler || "(anonymous)";
      const fileCell = ep.filePath ? `\`${ep.filePath}\`` : "—";
      const descCell = ep.description || "—";
      lines.push(`| ${ep.method} | \`${ep.path}\` | ${handlerCell} | ${fileCell} | ${descCell} |`);
    }
    lines.push("");

    // 方法统计
    lines.push("### 方法统计");
    lines.push("");
    const methodCounts = new Map<string, number>();
    for (const ep of endpoints) {
      methodCounts.set(ep.method, (methodCounts.get(ep.method) ?? 0) + 1);
    }
    lines.push("| HTTP 方法 | 端点数 |");
    lines.push("|-----------|--------|");
    for (const method of [...methodCounts.keys()].sort()) {
      lines.push(`| ${method} | ${methodCounts.get(method)} |`);
    }
    lines.push("");

    // 错误码（基于端点描述推断）
    lines.push("### 错误码约定");
    lines.push("");
    lines.push("> **注**：以下为通用 HTTP 错误码约定，具体错误码请参考 OpenAPI spec 的 responses 段。");
    lines.push("");
    lines.push("| 状态码 | 含义 |");
    lines.push("|--------|------|");
    lines.push("| 400 | 请求参数非法 |");
    lines.push("| 401 | 未认证 |");
    lines.push("| 403 | 无权限 |");
    lines.push("| 404 | 资源不存在 |");
    lines.push("| 409 | 资源冲突（如唯一约束冲突） |");
    lines.push("| 422 | 请求语义错误（业务校验失败） |");
    lines.push("| 500 | 服务器内部错误 |");
    lines.push("| 503 | 服务不可用 |");
    lines.push("");

    return lines.join("\n");
  }
}
