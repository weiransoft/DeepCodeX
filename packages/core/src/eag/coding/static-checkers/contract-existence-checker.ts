/**
 * API 契约存在性判定器（ContractExistenceChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E8：API 契约（OpenAPI spec 文件 + 契约测试文件存在性）
 *
 * 判定算法：
 * 1. 检查产出物中是否存在 REST Controller 类（@Controller / @RestController 装饰器）
 * 2. 检查这些 Controller 类是否有 OpenAPI 装饰器（@Api / @ApiOperation / @ApiResponse / @ApiProperty）
 * 3. 检查产出物中是否包含 OpenAPI spec 文件（openapi.json / openapi.yaml / swagger.json / swagger.yaml）
 * 4. 检查产出物中是否包含契约测试文件（*.contract.test.ts / pact.json / *.pact.ts）
 *
 * 判定规则：
 * - 存在 Controller 但无 OpenAPI 装饰器且无 OpenAPI spec 文件 → violated
 * - 存在 Controller 且有 OpenAPI 装饰器或 OpenAPI spec 文件 → passed
 * - 无 Controller 产出物 → passed（不适用）
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E8
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/contract-existence-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanDecorators, buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * REST Controller 装饰器清单（识别 REST 控制器类）
 *
 * 识别 NestJS / Express / Midway 等框架的 Controller 装饰器：
 * - @Controller：NestJS 通用控制器
 * - @RestController：Spring 风格的 REST 控制器（也用于 TypeORM demo）
 */
const CONTROLLER_DECORATORS: ReadonlyArray<string> = Object.freeze(["Controller", "RestController"]);

/**
 * OpenAPI / Swagger 装饰器清单（识别 API 契约装饰器）
 *
 * 识别 @nestjs/swagger / swagger-jsdoc 等库的装饰器：
 * - @Api：类级别的 API 标签
 * - @ApiOperation：方法级别的操作描述
 * - @ApiResponse：方法级别的响应描述
 * - @ApiProperty：DTO 字段的属性描述
 * - @ApiTags：类级别的标签分组
 * - @ApiBody / @ApiQuery / @ApiParam：方法级别的输入描述
 */
const OPENAPI_DECORATORS: ReadonlyArray<string> = Object.freeze([
  "Api",
  "ApiOperation",
  "ApiResponse",
  "ApiProperty",
  "ApiTags",
  "ApiBody",
  "ApiQuery",
  "ApiParam",
  "ApiHeader",
  "ApiBearerAuth",
  "ApiExcludeEndpoint",
  "ApiExtraModels",
  "ApiHideProperty",
  "ApiOAuth2",
  "ApiSecurity",
]);

/**
 * OpenAPI spec 文件名清单（识别 OpenAPI 规范文件）
 *
 * 这些文件名出现在产出物路径中即视为存在 OpenAPI 契约文件。
 */
const OPENAPI_SPEC_FILENAMES: ReadonlyArray<string> = Object.freeze([
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
]);

/**
 * 契约测试文件名模式（识别契约测试文件）
 *
 * 这些文件名模式出现在产出物路径中即视为存在契约测试。
 */
const CONTRACT_TEST_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\.contract\.test\.ts$/,
  /\.contract\.test\.js$/,
  /\.pact\.ts$/,
  /\.pact\.js$/,
  /pact\.json$/,
  /contract\.spec\.ts$/,
]);

/**
 * 判定文件路径是否为 OpenAPI spec 文件
 *
 * @param filePath 文件路径
 * @returns true 表示 OpenAPI spec 文件
 */
function isOpenApiSpecFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return OPENAPI_SPEC_FILENAMES.some((name) => lowerPath.endsWith(name));
}

/**
 * 判定文件路径是否为契约测试文件
 *
 * @param filePath 文件路径
 * @returns true 表示契约测试文件
 */
function isContractTestFile(filePath: string): boolean {
  return CONTRACT_TEST_PATTERNS.some((re) => re.test(filePath));
}

/**
 * API 契约存在性判定器
 *
 * 实现 StaticChecker 协议，负责 E8 红线的静态判定。
 */
export class ContractExistenceChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E8"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 第一遍扫描：识别所有 Controller 文件 + 收集 OpenAPI spec / 契约测试文件存在性
   * 2. 第二遍扫描：检查每个 Controller 文件是否使用 OpenAPI 装饰器
   * 3. 若存在 Controller 文件但既无 OpenAPI 装饰器，也无 OpenAPI spec 文件，也无契约测试文件 → 违规
   *
   * @param artifacts 产出物列表
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    // 第一遍扫描：收集 OpenAPI spec 文件 + 契约测试文件存在性
    let hasOpenApiSpec = false;
    let hasContractTest = false;
    for (const artifact of artifacts) {
      if (isOpenApiSpecFile(artifact.path)) {
        hasOpenApiSpec = true;
      }
      if (isContractTestFile(artifact.path)) {
        hasContractTest = true;
      }
    }

    // 第二遍扫描：识别 Controller 文件 + 检查 OpenAPI 装饰器使用
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      // 跳过 OpenAPI spec 文件与契约测试文件
      if (isOpenApiSpecFile(filePath) || isContractTestFile(filePath)) continue;

      const decorators = scanDecorators(artifact.content);

      // 检测 Controller 装饰器
      let controllerClassName = "";
      let controllerLine = 0;
      for (const dec of decorators) {
        if (CONTROLLER_DECORATORS.includes(dec.name)) {
          controllerClassName = dec.target;
          controllerLine = dec.line;
          break;
        }
      }
      if (!controllerClassName || controllerLine === 0) {
        // 当前文件不是 Controller
        continue;
      }

      // 检测 OpenAPI 装饰器使用
      let hasOpenApiDecorator = false;
      for (const dec of decorators) {
        if (OPENAPI_DECORATORS.includes(dec.name)) {
          hasOpenApiDecorator = true;
          break;
        }
      }

      // 若 Controller 无 OpenAPI 装饰器，且全局无 OpenAPI spec 文件，也无契约测试 → 违规
      if (!hasOpenApiDecorator && !hasOpenApiSpec && !hasContractTest) {
        violations.push({
          filePath,
          line: controllerLine,
          description:
            `Controller 类 ${controllerClassName} 未使用 OpenAPI 装饰器，且项目无 OpenAPI spec 文件 / 契约测试文件——` +
            `违反 E8 红线（API 契约）。对外 API 必须有显式契约：DTO 定义 + 错误模型 + 版本号`,
          fixSuggestion:
            "1. 为 Controller 类添加 @ApiTags 装饰器（类级别）\n" +
            "2. 为每个端点方法添加 @ApiOperation / @ApiResponse / @ApiBody 等装饰器\n" +
            "3. 为请求/响应 DTO 添加 @ApiProperty 描述字段含义\n" +
            "4. 在 API 路径中包含版本号（如 /api/v1/users）\n" +
            "5. 或在项目根目录添加 openapi.yaml / swagger.json 显式契约文件\n" +
            "6. 引入契约测试（Pact / Spring Cloud Contract）验证一致性",
        });
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
