/**
 * 审计事件比对判定器（AuditEventMatcher）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E3：审计（实体状态变更点 vs 领域事件发布点 1:1 比对）
 *
 * 判定算法：
 * 1. 扫描每个实体类（Aggregate / Entity 后缀）的方法
 * 2. 识别"状态变更点"：方法名以 set/update/change/modify/mark/cancel/close 等开头，且非构造函数
 * 3. 识别"事件发布点"：方法体内出现 publish / emit / dispatch / apply / addEvent + DomainEvent 调用
 * 4. 对每个状态变更点检查方法体是否包含事件发布调用
 * 5. 若状态变更点无对应事件发布 → 违规
 *
 * 判定规则：
 * - 任一状态变更方法未发布领域事件 → violated
 * - 无状态变更方法 / 所有变更点都发布事件 → passed
 *
 * 注意：本判定器为静态启发式，仅识别"方法名 + 方法体内事件发布调用"的对应关系。
 * 完整的语义匹配（变更点与事件类型的对应关系）需 LLM judge 推理判定，本判定器返回 unknown 时
 * 可由 STRICT 评估器降级到 LLM judge。
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E3
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/audit-event-matcher
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanClassMethods, buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * 状态变更方法名前缀清单（识别状态变更点）
 *
 * 方法名以这些前缀开头视为状态变更方法：
 * - set / update / change / modify / mark / cancel / close / activate / deactivate / reset
 *
 * 注：create / delete / remove 不在此清单——这些方法通常对应工厂方法或仓储操作，
 * 而非实体的状态变更。构造函数 constructor 也排除。
 */
const STATE_CHANGE_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "set",
  "update",
  "change",
  "modify",
  "mark",
  "cancel",
  "close",
  "activate",
  "deactivate",
  "reset",
]);

/**
 * 事件发布方法名清单（识别事件发布点）
 *
 * 识别以下方法调用为事件发布：
 * - publish / emit / dispatch / apply / addEvent / addDomainEvent / recordEvent
 */
const EVENT_PUBLISH_METHODS: ReadonlyArray<string> = Object.freeze([
  "publish",
  "emit",
  "dispatch",
  "apply",
  "addEvent",
  "addDomainEvent",
  "recordEvent",
]);

/**
 * 判定方法名是否为状态变更方法
 *
 * @param methodName 方法名
 * @returns true 表示状态变更方法
 */
function isStateChangeMethod(methodName: string): boolean {
  // 排除构造函数与工厂方法
  if (
    methodName === "constructor" ||
    methodName === "create" ||
    methodName === "from" ||
    methodName === "reconstitute"
  ) {
    return false;
  }
  return STATE_CHANGE_PREFIXES.some((prefix) => methodName.startsWith(prefix));
}

/**
 * 判定方法体是否包含事件发布调用
 *
 * 扫描方法体原文中是否出现 receiver.publish( / emit( / dispatch( 等调用形式。
 * 启发式：仅匹配方法调用名，不解析调用上下文。
 *
 * @param body 方法体原文
 * @returns true 表示包含事件发布调用
 */
function hasEventPublishInBody(body: string): boolean {
  for (const publishMethod of EVENT_PUBLISH_METHODS) {
    // 匹配 .publish( / .emit( 等形式的方法调用（避免误匹配如 publisher 函数名）
    const callRe = new RegExp(`\\.${publishMethod}\\s*\\(`);
    if (callRe.test(body)) {
      return true;
    }
    // 也匹配 this.publish( / this.emit( 等显式 this 调用
    const thisCallRe = new RegExp(`\\bthis\\.${publishMethod}\\s*\\(`);
    if (thisCallRe.test(body)) {
      return true;
    }
  }
  return false;
}

/**
 * 判定类名是否为实体或聚合根
 *
 * 启发式：类名以 "Aggregate" / "Entity" / "Root" 结尾视为实体类。
 * 值对象（以 "VO" / "Value" 结尾）与 DTO（以 "DTO" / "Dto" 结尾）不视为实体。
 *
 * @param className 类名
 * @returns true 表示实体或聚合根
 */
function isEntityClass(className: string): boolean {
  if (/Aggregate$/.test(className)) return true;
  if (/Entity$/.test(className)) return true;
  if (/Root$/.test(className)) return true;
  return false;
}

/**
 * 审计事件比对判定器
 *
 * 实现 StaticChecker 协议，负责 E3 红线的静态判定。
 */
export class AuditEventMatcher implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E3"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 对每个产出物文件，扫描其中的实体类方法
   * 2. 对每个识别为状态变更的方法（方法名以 set/update/change 等开头），
   *    检查方法体是否包含事件发布调用（publish/emit/dispatch/apply 等）
   * 3. 若状态变更方法未发布事件 → 记录违规
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

      for (const method of methods) {
        // 仅检查实体类的方法
        if (!isEntityClass(method.className)) {
          continue;
        }
        // 仅检查状态变更方法
        if (!isStateChangeMethod(method.methodName)) {
          continue;
        }
        // 检查方法体是否包含事件发布调用
        if (hasEventPublishInBody(method.body)) {
          continue;
        }

        // 状态变更方法未发布事件 → 违规
        violations.push({
          filePath,
          line: method.line,
          description:
            `实体 ${method.className}.${method.methodName}() 修改状态但未发布领域事件——违反 E3 红线（审计）。` +
            `所有状态变更必须发布领域事件，以便审计系统追踪业务操作轨迹`,
          fixSuggestion:
            "1. 在该方法体末尾添加领域事件发布调用（如 this.publish(new XxxChangedEvent(...))）\n" +
            "2. 事件应包含变更前后的快照（before/after）与操作者信息\n" +
            "3. 事件发布必须在事务提交后异步执行（避免事务回滚但事件已发）\n" +
            "4. 事件类应继承 DomainEvent 基类，包含事件 ID / 时间戳 / 聚合 ID",
        });
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
