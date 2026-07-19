/**
 * 贫血模型判定器（AnemicModelDetector）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E7：贫血模型禁令（实体方法密度启发式，<3 个业务方法 + 全是 getter/setter → 贫血）
 *
 * 判定算法：
 * 1. 识别实体类：类名以 "Aggregate" / "Entity" / "Root" 结尾
 *    （值对象 Value Object 不在检查范围内——值对象天然无业务方法）
 * 2. 统计每个实体类的方法：分类为 getter / setter / 业务方法
 * 3. 若业务方法数 < 2 且存在 setter → 判定为贫血模型
 *
 * 判定规则：
 * - 实体类业务方法 < 2 个 + 有 setter 方法 → violated（warning 级别）
 * - 实体类业务方法 ≥ 2 个 / 无 setter / 值对象 / 非实体类 → passed
 *
 * 业务方法识别（启发式）：
 * - getter：方法名以 "get" / "is" / "has" / "can" 开头，且无参数
 * - setter：方法名以 "set" 开头，且仅 1 个参数
 * - 业务方法：非 getter / setter / constructor / create / from 的方法
 *
 * 注意：本判定器为静态启发式，E7 红线级别为 WARNING（不打回，仅提示）。
 * 误报风险高（如某些实体确实只持有状态），需结合 LLM judge 推理判定。
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E7
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/anemic-model-detector
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanClassMethods, buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * 业务方法最小数量阈值
 *
 * 实体类业务方法数 < 此阈值且存在 setter → 判定为贫血模型。
 * 阈值 2：实体应至少有 2 个业务方法（如 changePassword + deactivate）才被视为充血模型。
 */
const MIN_BUSINESS_METHOD_COUNT = 2;

/**
 * 判定类名是否为实体类
 *
 * 启发式：类名以 "Aggregate" / "Entity" / "Root" 结尾视为实体类。
 * 值对象（以 "VO" / "Value" 结尾）不视为实体（值对象天然无业务方法，不在检查范围）。
 *
 * @param className 类名
 * @returns true 表示实体类
 */
function isEntityClass(className: string): boolean {
  if (/Aggregate$/.test(className)) return true;
  if (/Entity$/.test(className)) return true;
  if (/Root$/.test(className)) return true;
  return false;
}

/**
 * 判定方法名是否为 getter
 *
 * getter 形式：getName() / isActive() / hasPermission() / canEdit()
 * 启发式：方法名以 get/is/has/can 开头，且参数列表为空。
 *
 * @param methodName 方法名
 * @param params 参数列表原文（含括号）
 * @returns true 表示 getter
 */
function isGetter(methodName: string, params: string): boolean {
  if (!/^(get|is|has|can)[A-Z]/.test(methodName)) return false;
  // 参数列表为空 () 视为 getter
  return params === "()" || params.replace(/\s/g, "") === "()";
}

/**
 * 判定方法名是否为 setter
 *
 * setter 形式：setName(value) / setEmail(value)
 * 启发式：方法名以 set 开头，且参数列表只有 1 个参数。
 *
 * @param methodName 方法名
 * @param params 参数列表原文（含括号）
 * @returns true 表示 setter
 */
function isSetter(methodName: string, params: string): boolean {
  if (!/^set[A-Z]/.test(methodName)) return false;
  // 参数列表有且仅有一个参数：去除括号与空白后，包含 1 个非逗号分隔的参数
  const inner = params
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .trim();
  if (inner.length === 0) return false;
  // 不含逗号即视为单参数（不处理嵌套的复杂类型如 (x: { a: number, b: string })）
  if (inner.includes(",")) return false;
  return true;
}

/**
 * 判定方法名是否为业务方法
 *
 * 业务方法：非 getter / setter / constructor / create / from / reconstitute。
 *
 * @param methodName 方法名
 * @param params 参数列表原文（含括号）
 * @returns true 表示业务方法
 */
function isBusinessMethod(methodName: string, params: string): boolean {
  // 排除构造函数与工厂方法
  if (
    methodName === "constructor" ||
    methodName === "create" ||
    methodName === "from" ||
    methodName === "reconstitute"
  ) {
    return false;
  }
  if (isGetter(methodName, params)) return false;
  if (isSetter(methodName, params)) return false;
  return true;
}

/**
 * 贫血模型判定器
 *
 * 实现 StaticChecker 协议，负责 E7 红线的静态判定。
 */
export class AnemicModelDetector implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E7"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 对每个产出物文件，扫描其中的实体类方法
   * 2. 对每个实体类，统计 getter / setter / 业务方法数量
   * 3. 若业务方法数 < 2 且存在 setter → 判定为贫血模型
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
      const methods = scanClassMethods(artifact.content);

      // 按类名分组方法
      const classMethods = new Map<string, typeof methods>();
      for (const method of methods) {
        if (!isEntityClass(method.className)) continue;
        const existing = classMethods.get(method.className);
        if (existing) {
          existing.push(method);
        } else {
          classMethods.set(method.className, [method]);
        }
      }

      // 对每个实体类统计方法分布
      for (const [className, classMethodList] of classMethods) {
        let businessCount = 0;
        let setterCount = 0;
        let getterCount = 0;
        let firstLine = 0;
        for (const m of classMethodList) {
          if (firstLine === 0 || m.line < firstLine) firstLine = m.line;
          if (isGetter(m.methodName, m.params)) {
            getterCount++;
          } else if (isSetter(m.methodName, m.params)) {
            setterCount++;
          } else if (isBusinessMethod(m.methodName, m.params)) {
            businessCount++;
          }
        }

        // 贫血模型判定：业务方法 < 2 且存在 setter
        if (businessCount < MIN_BUSINESS_METHOD_COUNT && setterCount > 0) {
          violations.push({
            filePath,
            line: firstLine,
            description:
              `实体类 ${className} 疑似贫血模型——业务方法数=${businessCount}（< ${MIN_BUSINESS_METHOD_COUNT}），` +
              `setter 数=${setterCount}，getter 数=${getterCount}。违反 E7 红线（贫血模型禁令）。` +
              `DDD 范式下业务逻辑应内聚在实体中，而非散落在 Service 层`,
            fixSuggestion:
              "1. 识别该实体相关的业务逻辑（在 Service 层中操作该实体的代码）\n" +
              "2. 将业务逻辑迁移到实体方法（如 User.changePassword() 取代 UserService.changePassword()）\n" +
              "3. 不变式断言内聚到实体方法（如 User.changePassword() 中校验新密码强度）\n" +
              "4. 移除 setter（DDD 实体应通过业务方法修改状态，而非暴露 setter）\n" +
              "5. 注意：值对象天然无业务方法，本红线不适用",
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
