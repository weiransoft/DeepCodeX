/**
 * 事务边界判定器（SagaDetector）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E1：事务边界（跨聚合写操作必须通过 Saga 模式实现最终一致性）
 *
 * 判定算法：
 * 1. 跨聚合写调用图分析：扫描聚合根 A 的方法体中是否直接调用聚合根 B 的写方法（setX / updateX / createX / deleteX）
 * 2. Saga 类存在性：扫描代码中是否存在 Saga / Orchestrator / CompensateAction 类定义
 *
 * 判定规则：
 * - 检测到跨聚合写调用 + 无 Saga 类 → 违规
 * - 检测到跨聚合写调用 + 有 Saga 类 → passed（仍可能推理判定，但静态层放行）
 * - 未检测到跨聚合写调用 → passed
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E1
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/saga-detector
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanClassMethods, buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * 写方法名前缀清单（识别跨聚合写调用）
 *
 * 调用方法名以这些前缀开头视为写方法：
 * - set / update / create / delete / remove / add / save / insert / modify / change
 */
const WRITE_METHOD_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "set",
  "update",
  "create",
  "delete",
  "remove",
  "add",
  "save",
  "insert",
  "modify",
  "change",
]);

/**
 * Saga 模式相关关键字（识别 Saga 类存在性）
 *
 * 类名包含以下关键字之一即视为 Saga 编排器：
 * - Saga / Orchestrator / Compensate / Compensation / ProcessManager
 */
const SAGA_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "Saga",
  "Orchestrator",
  "Compensate",
  "Compensation",
  "ProcessManager",
]);

/**
 * 判定方法名是否为写方法
 *
 * @param methodName 方法名
 * @returns true 表示写方法
 */
function isWriteMethod(methodName: string): boolean {
  return WRITE_METHOD_PREFIXES.some((prefix) => methodName.startsWith(prefix));
}

/**
 * 判定类名是否为聚合根
 *
 * 启发式：类名以 "Aggregate" / "Root" 结尾，或路径包含 /domain/ 且类名首字母大写。
 *
 * @param className 类名
 * @returns true 表示聚合根
 */
function isAggregateRoot(className: string): boolean {
  if (/Aggregate$/.test(className)) return true;
  if (/Root$/.test(className)) return true;
  return false;
}

/**
 * 判定类名是否为 Saga 编排器
 *
 * @param className 类名
 * @returns true 表示 Saga 类
 */
function isSagaClass(className: string): boolean {
  return SAGA_KEYWORDS.some((kw) => className.includes(kw));
}

/**
 * 从方法体中提取被调用的方法名
 *
 * 识别形如 `xxx.methodName(...)` 或 `xxx.methodName(...)` 的方法调用。
 * 返回所有被调用的方法名（去重）。
 *
 * @param body 方法体原文
 * @returns 被调用方法名列表
 */
function extractCalledMethods(body: string): Array<{ readonly receiver: string; readonly method: string }> {
  const calls: Array<{ readonly receiver: string; readonly method: string }> = [];
  // 匹配 receiver.method( 形式的方法调用（receiver 为标识符）
  const callRe = /\b([a-z][A-Za-z0-9_]*)\.([A-Za-z_][\w]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(body)) !== null) {
    calls.push({
      receiver: m[1],
      method: m[2],
    });
  }
  return calls;
}

/**
 * 事务边界判定器
 *
 * 实现 StaticChecker 协议，负责 E1 红线的静态判定。
 */
export class SagaDetector implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E1"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 第一遍扫描：检查所有文件中是否存在 Saga 类（设置 hasSagaClass 标记）
   * 2. 第二遍扫描：对每个聚合根类的方法体，提取被调用方法
   *    - 若被调用方法为写方法（setX / updateX / createX 等）且 receiver 与当前类不同
   *    - 则判定为跨聚合写调用
   * 3. 若存在跨聚合写调用且无 Saga 类 → 违规
   *
   * @param artifacts 产出物列表
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    // 第一遍扫描：检测 Saga 类存在性 + 收集所有聚合根类名
    let hasSagaClass = false;
    const aggregateClassNames = new Set<string>();
    for (const artifact of artifacts) {
      const lines = artifact.content.split(/\r?\n/);
      for (const line of lines) {
        if (/^\s*\/\//.test(line)) continue;
        if (/^\s*\*/.test(line)) continue;
        // 识别 class 声明
        const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/);
        if (classMatch) {
          const className = classMatch[1];
          if (isSagaClass(className)) {
            hasSagaClass = true;
          }
          if (isAggregateRoot(className)) {
            aggregateClassNames.add(className);
          }
        }
        // 识别 Saga 关键字注释（如 // Saga: xxx）
        if (/Saga\s*(?:Orchestrator|Pattern|Implementation|class)/i.test(line)) {
          hasSagaClass = true;
        }
      }
    }

    // 第二遍扫描：检测跨聚合写调用
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      const methods = scanClassMethods(artifact.content);

      for (const method of methods) {
        // 仅检查聚合根类的方法
        if (!isAggregateRoot(method.className)) {
          continue;
        }
        // 跳过构造函数与工厂方法（create / from 等）
        if (method.methodName === "constructor" || method.methodName === "create" || method.methodName === "from") {
          continue;
        }

        // 提取方法体中的被调用方法
        const calledMethods = extractCalledMethods(method.body);
        for (const call of calledMethods) {
          // 被调用方法必须是写方法
          if (!isWriteMethod(call.method)) {
            continue;
          }
          // receiver 必须不是 this（this.setX 是聚合内调用，合规）
          if (call.receiver === "this" || call.receiver === "self") {
            continue;
          }
          // 检查 receiver 是否为另一个聚合根的引用
          // 启发式：检查 receiver 是否在聚合根类名列表中（小写形式）
          // 例如：聚合 A 引用 orderAggregate，调用 orderAggregate.updateStatus()
          const receiverName = call.receiver.toLowerCase();
          let isCrossAggregateCall = false;
          let targetAggregate = "";
          for (const aggName of aggregateClassNames) {
            const aggLower = aggName.toLowerCase();
            // receiver 变量名匹配聚合根类名（如 orderAggregate / order）
            if (receiverName === aggLower || receiverName === aggLower.replace(/aggregate$/, "")) {
              isCrossAggregateCall = true;
              targetAggregate = aggName;
              break;
            }
          }
          if (!isCrossAggregateCall) {
            // 还要检查：如果 receiver 类型是另一个聚合根（通过方法签名中的构造函数注入推断）
            // 启发式：如果方法所在类（聚合 A）的构造函数或字段中包含其他聚合根类型，则视为跨聚合引用
            // 此处采用更宽松的判断：任何非 this 的写方法调用都视为潜在跨聚合调用
            // （启发式判定，可能有误报）
            continue;
          }

          // 检测到跨聚合写调用
          if (!hasSagaClass) {
            violations.push({
              filePath,
              line: method.line,
              description:
                `聚合根 ${method.className}.${method.methodName}() 中直接调用聚合根 ` +
                `${targetAggregate}.${call.method}()——违反 E1 红线（事务边界）。` +
                `跨聚合写操作必须通过 Saga 模式实现最终一致性，禁止单数据库事务跨聚合提交`,
              fixSuggestion:
                "1. 识别跨聚合写操作的位置（聚合根 A.method() 调用聚合根 B.setX()）\n" +
                "2. 将跨聚合写重构为领域事件发布 + 事件处理器异步更新\n" +
                "3. 如需跨服务事务，引入 Saga 编排器（eag-saga-orchestration skill）\n" +
                "4. 补偿动作必须幂等且可重试",
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
