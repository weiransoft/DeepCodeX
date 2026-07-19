/**
 * 输入校验判定器（DtoValidatorChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E5：输入校验（DTO 必须有 class-validator 装饰器 / 构造函数断言）
 *
 * 判定算法：
 * 1. 识别 DTO 类：类名以 "DTO" / "Dto" / "Request" / "Command" / "Query" 结尾
 * 2. 扫描 DTO 类的字段装饰器，检查是否包含 class-validator 装饰器（@IsString/@IsInt/@IsEmail 等）
 * 3. 若 DTO 类无任何 class-validator 装饰器 → 违规
 *
 * 判定规则：
 * - DTO 类没有任何 class-validator 装饰器 → violated
 * - 非 DTO 类 / DTO 类有 class-validator 装饰器 → passed
 *
 * class-validator 装饰器清单（30+ 个）：
 * - 类型校验：@IsString / @IsNumber / @IsInt / @IsBoolean / @IsDate / @IsArray / @IsObject
 * - 字符串校验：@IsEmail / @IsUrl / @IsUUID / @IsIP / @IsCreditCard / @IsBase64
 * - 数值校验：@Min / @Max / @IsPositive / @IsNegative
 * - 集合校验：@ArrayMinSize / @ArrayMaxSize / @ArrayNotEmpty / @ArrayUnique
 * - 嵌套校验：@ValidateNested / @ValidateIf / @ValidatePromise
 * - 通用校验：@IsNotEmpty / @NotEmpty / @Length / @MinLength / @MaxLength / @Matches / @IsOptional
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E5
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/dto-validator-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanDecorators, buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * class-validator 装饰器清单（识别输入校验装饰器）
 *
 * 列举 class-validator 包提供的所有装饰器名称（不含 @ 前缀）。
 * 出现任一装饰器即视为该字段有输入校验。
 */
const CLASS_VALIDATOR_DECORATORS: ReadonlyArray<string> = Object.freeze([
  // 类型校验装饰器
  "IsString",
  "IsNumber",
  "IsInt",
  "IsBoolean",
  "IsDate",
  "IsArray",
  "IsObject",
  "IsEnum",
  "IsInstance",
  // 字符串校验装饰器
  "IsEmail",
  "IsUrl",
  "IsUUID",
  "IsIP",
  "IsCreditCard",
  "IsBase64",
  "IsAlpha",
  "IsAlphanumeric",
  "IsByteLength",
  "IsDateString",
  "IsFQDN",
  "IsHexColor",
  "IsHexadecimal",
  "IsISO8601",
  "IsISBN",
  "IsJSON",
  "IsJWT",
  "IsLowercase",
  "IsMACAddress",
  "IsMilitaryTime",
  "IsMongoId",
  "IsMobilePhone",
  "IsPort",
  "IsPostalCode",
  "IsRFC3339",
  "IsUppercase",
  // 数值校验装饰器
  "Min",
  "Max",
  "IsPositive",
  "IsNegative",
  // 集合校验装饰器
  "ArrayMinSize",
  "ArrayMaxSize",
  "ArrayNotEmpty",
  "ArrayUnique",
  "ArrayContains",
  "ArrayNotContains",
  // 长度校验装饰器
  "Length",
  "MinLength",
  "MaxLength",
  // 通用校验装饰器
  "IsNotEmpty",
  "NotEmpty",
  "IsDefined",
  "IsOptional",
  "Equals",
  "NotEquals",
  "Contains",
  "NotContains",
  "IsIn",
  "IsNotIn",
  "Matches",
  // 嵌套校验装饰器
  "ValidateNested",
  "ValidateIf",
  "ValidatePromise",
  "Validate",
]);

/**
 * 判定类名是否为 DTO 类
 *
 * 启发式：类名以 "DTO" / "Dto" / "Request" / "Command" / "Query" / "Response" 结尾视为 DTO 类。
 *
 * @param className 类名
 * @returns true 表示 DTO 类
 */
function isDtoClass(className: string): boolean {
  if (/DTO$/.test(className)) return true;
  if (/Dto$/.test(className)) return true;
  if (/Request$/.test(className)) return true;
  if (/Command$/.test(className)) return true;
  if (/Query$/.test(className)) return true;
  if (/Response$/.test(className)) return true;
  return false;
}

/**
 * 输入校验判定器
 *
 * 实现 StaticChecker 协议，负责 E5 红线的静态判定。
 */
export class DtoValidatorChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E5"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 扫描每个产出物文件的装饰器
   * 2. 识别 DTO 类（通过 scanDecorators 的 target 字段推断类名）
   * 3. 收集每个 DTO 类的所有装饰器
   * 4. 检查每个 DTO 类是否至少有一个 class-validator 装饰器
   * 5. 若 DTO 类无任何 class-validator 装饰器 → 违规
   *
   * @param artifacts 产出物列表
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      const decorators = scanDecorators(artifact.content);

      // 按类名分组装饰器（target 为类名时）
      const classDecorators = new Map<string, { readonly line: number; readonly count: number }>();
      for (const dec of decorators) {
        const target = dec.target;
        if (!target) continue;
        // 仅检查 DTO 类
        if (!isDtoClass(target)) continue;
        const existing = classDecorators.get(target);
        if (existing) {
          classDecorators.set(target, { line: existing.line, count: existing.count + 1 });
        } else {
          classDecorators.set(target, { line: dec.line, count: 1 });
        }
      }

      // 检查每个 DTO 类是否有 class-validator 装饰器
      // 第一遍：收集所有 DTO 类名（从代码中扫描 class XxxDTO）
      const lines = artifact.content.split(/\r?\n/);
      const dtoClassLines = new Map<string, number>();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*\/\//.test(line)) continue;
        const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/);
        if (classMatch && isDtoClass(classMatch[1])) {
          dtoClassLines.set(classMatch[1], i + 1);
        }
      }

      // 第二遍：对每个 DTO 类，统计其字段的 class-validator 装饰器数量
      for (const [className, classLine] of dtoClassLines) {
        // 收集该 DTO 类范围内（从类声明到下一个 class 声明或文件末尾）的装饰器
        let validatorCount = 0;
        let inTargetClass = false;
        for (let i = classLine - 1; i < lines.length; i++) {
          const line = lines[i];
          // 检测是否进入目标类
          const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/);
          if (classMatch) {
            if (classMatch[1] === className) {
              inTargetClass = true;
              continue;
            } else if (inTargetClass) {
              // 已离开目标类
              break;
            }
          }
          if (!inTargetClass) continue;
          // 跳过注释行
          if (/^\s*\/\//.test(line)) continue;
          if (/^\s*\*/.test(line)) continue;
          // 检测 class-validator 装饰器
          for (const dec of CLASS_VALIDATOR_DECORATORS) {
            const decRe = new RegExp(`@${dec}\\b`);
            if (decRe.test(line)) {
              validatorCount++;
              break; // 同一行只算一次
            }
          }
        }

        if (validatorCount === 0) {
          violations.push({
            filePath,
            line: classLine,
            description:
              `DTO 类 ${className} 未使用任何 class-validator 装饰器——违反 E5 红线（输入校验）。` +
              `所有 DTO 字段必须显式声明校验装饰器（如 @IsString/@IsInt/@IsEmail），` +
              `未校验的输入将导致脏数据进入领域层，破坏聚合不变式`,
            fixSuggestion:
              "1. 为每个 DTO 字段添加 class-validator 装饰器（@IsString/@IsInt/@IsEmail 等）\n" +
              "2. 在 Controller 入口调用 validate() 或 UsePipes(ValidationPipe) 自动校验\n" +
              "3. 校验失败抛出 BadRequestException，由全局异常处理器转换为 400 响应\n" +
              "4. 对嵌套对象使用 @ValidateNested() 递归校验",
          });
        }
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
