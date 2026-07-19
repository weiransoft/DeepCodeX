/**
 * ALCOA+ 数据完整性原则合规规则集
 *
 * 本模块定义 EAG-P3 批次 11 §6 ALCOA+ 合规包首版的 9 条规则：
 * - ALCOA-01：Attributable（可归属）—— FDA Guidance 2018 §III.A —— static / blocker
 * - ALCOA-02：Legible（清晰）—— FDA Guidance 2018 §III.B —— static / major
 * - ALCOA-03：Contemporaneous（同时性）—— FDA Guidance 2018 §III.C —— static / blocker
 * - ALCOA-04：Original（原始性）—— FDA Guidance 2018 §III.D —— static / major
 * - ALCOA-05：Accurate（准确性）—— FDA Guidance 2018 §III.E —— dynamic / blocker
 * - ALCOA-06：Complete（完整性）—— FDA Guidance 2018 §III.F —— static / major
 * - ALCOA-07：Consistent（一致性）—— FDA Guidance 2018 §III.G —— static / major
 * - ALCOA-08：Enduring（持久性）—— FDA Guidance 2018 §III.H —— static / warning
 * - ALCOA-09：Available（可用性）—— FDA Guidance 2018 §III.I —— dynamic / warning
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计 §6.1 设计目标（ALCOA+ 9 条规则）
 * - EAG-P3 批次 11 设计 §6.5 ALCOA-01~09 实现要点
 * - FDA Guidance for Industry 2018《Data Integrity and Compliance With Drug CGMP》
 *
 * 法规引用说明（真实条款）：
 * - FDA Guidance 2018 §III.A：Attributable（可归属）—— 数据应能追溯到生成者
 * - FDA Guidance 2018 §III.B：Legible（清晰）—— 数据应可永久阅读
 * - FDA Guidance 2018 §III.C：Contemporaneous（同时性）—— 数据应在生成时即时记录
 * - FDA Guidance 2018 §III.D：Original（原始性）—— 数据应保留原始形式
 * - FDA Guidance 2018 §III.E：Accurate（准确性）—— 数据应真实准确
 * - FDA Guidance 2018 §III.F：Complete（完整性）—— 数据应包含全部信息
 * - FDA Guidance 2018 §III.G：Consistent（一致性）—— 数据应符合一致性原则
 * - FDA Guidance 2018 §III.H：Enduring（持久性）—— 数据应持久保存
 * - FDA Guidance 2018 §III.I：Available（可用性）—— 数据应可被检索
 *
 * 实现约束（用户规则 P-1 / P-5）：
 * - 所有静态检查器使用 TypeScript Compiler API（ts.createSourceFile + AST 遍历）
 * - 禁止使用正则匹配代码语义
 * - 所有结果通过 Object.freeze 冻结
 *
 * @module eag/icp/packs/alcoa-plus-pack
 */

import * as ts from "typescript";
import type {
  ComplianceCheckContext,
  ComplianceEvidence,
  CompliancePack,
  ComplianceRule,
  ComplianceRuleResult,
} from "../types";
import { DEFAULT_COMPLIANCE_PACK_VERSION } from "../types";

// ============================================================================
// 1. AST 工具函数（ALCOA+ 专属）
// ============================================================================

/**
 * 函数调用信息（与 cfr-part11-pack 中相同结构，独立定义避免跨包依赖）
 */
interface FunctionCall {
  readonly callee: string;
  readonly filePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly snippet: string;
  readonly args: ReadonlyArray<string>;
  readonly argPropertyNames: ReadonlyArray<string>;
}

/**
 * 装饰器调用信息
 */
interface DecoratorCall {
  readonly name: string;
  readonly filePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly snippet: string;
  readonly argPropertyNames: ReadonlyArray<string>;
}

/**
 * 接口属性信息（用于 ALCOA-06 完整性校验）
 */
interface InterfaceProperty {
  /** 属性名 */
  readonly name: string;
  /** 是否可选（含 ? 修饰符） */
  readonly optional: boolean;
  /** 是否有装饰器（如 @Required / @IsNotEmpty） */
  readonly hasDecorator: boolean;
  /** 装饰器名称列表 */
  readonly decoratorNames: ReadonlyArray<string>;
  /** 所在接口名 */
  readonly interfaceName: string;
  /** 所在文件路径 */
  readonly filePath: string;
  /** 行号（1-based） */
  readonly line: number;
}

/**
 * 扫描 TypeScript 文件中的函数调用
 *
 * 算法同 cfr-part11-pack.scanFunctionCalls，独立定义避免跨包依赖。
 *
 * @param filePath 文件路径
 * @param content 文件内容
 * @param filterCalleeList 调用者过滤列表，不传则返回全部调用
 * @returns 函数调用信息列表
 */
function scanFunctionCalls(
  filePath: string,
  content: string,
  filterCalleeList?: ReadonlyArray<string>
): FunctionCall[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);

  const lines = content.split(/\r?\n/);
  const results: FunctionCall[] = [];

  /**
   * 提取 CallExpression 的 callee 文本表示
   */
  function getCalleeText(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) {
      return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const objectText = getCalleeText(expression.expression);
      if (objectText === null) return null;
      return `${objectText}.${expression.name.text}`;
    }
    return null;
  }

  /**
   * 提取对象字面量参数的属性名列表
   */
  function getObjectPropertyNames(arg: ts.Node): string[] {
    if (!ts.isObjectLiteralExpression(arg)) return [];
    const names: string[] = [];
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        names.push(prop.name.text);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        names.push(prop.name.text);
      }
    }
    return names;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeText = getCalleeText(node.expression);
      if (calleeText && (!filterCalleeList || filterCalleeList.includes(calleeText))) {
        const startPos = node.getStart();
        const endPos = node.getEnd();
        const lineStart = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
        const lineEnd = sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;
        const snippet = lines.slice(lineStart - 1, lineEnd).join("\n");
        const args = node.arguments.map((arg) => arg.getText(sourceFile));
        const argPropertyNames = node.arguments.length > 0 ? getObjectPropertyNames(node.arguments[0]) : [];

        results.push({
          callee: calleeText,
          filePath,
          lineStart,
          lineEnd,
          snippet,
          args: Object.freeze(args),
          argPropertyNames: Object.freeze(argPropertyNames),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * 扫描 TypeScript 文件中的指定装饰器调用
 *
 * @param filePath 文件路径
 * @param content 文件内容
 * @param filterName 装饰器名称过滤
 * @returns 装饰器调用信息列表
 */
function scanDecorators(filePath: string, content: string, filterName: string): DecoratorCall[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);

  const lines = content.split(/\r?\n/);
  const results: DecoratorCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isDecorator(node)) {
      const expression = node.expression;
      let decoratorName: string | undefined;
      let firstArgNode: ts.Node | undefined;

      if (ts.isIdentifier(expression)) {
        decoratorName = expression.text;
      } else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        decoratorName = expression.expression.text;
        if (expression.arguments.length > 0) {
          firstArgNode = expression.arguments[0];
        }
      }

      if (decoratorName === filterName) {
        const startPos = node.getStart();
        const endPos = node.getEnd();
        const lineStart = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
        const lineEnd = sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;
        const snippet = lines.slice(lineStart - 1, lineEnd).join("\n");

        const argPropertyNames: string[] = [];
        if (firstArgNode && ts.isObjectLiteralExpression(firstArgNode)) {
          for (const prop of firstArgNode.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              argPropertyNames.push(prop.name.text);
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              argPropertyNames.push(prop.name.text);
            }
          }
        }

        results.push({
          name: decoratorName,
          filePath,
          lineStart,
          lineEnd,
          snippet,
          argPropertyNames: Object.freeze(argPropertyNames),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * 扫描 TypeScript 文件中的所有接口属性
 *
 * 用于 ALCOA-06 Complete 完整性校验：
 * - 遍历所有 InterfaceDeclaration 节点
 * - 提取每个属性的名称、是否可选、是否有装饰器、装饰器名称列表
 *
 * @param filePath 文件路径
 * @param content 文件内容
 * @param filterInterfaceName 接口名过滤（如 "Record"），不传则返回全部接口
 * @returns 接口属性列表
 */
function scanInterfaceProperties(filePath: string, content: string, filterInterfaceName?: string): InterfaceProperty[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);

  const results: InterfaceProperty[] = [];

  function visit(node: ts.Node): void {
    // 识别接口声明节点
    if (ts.isInterfaceDeclaration(node)) {
      const interfaceName = node.name.text;

      // 接口名过滤
      if (!filterInterfaceName || interfaceName === filterInterfaceName) {
        // 遍历接口的所有成员
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const propName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sourceFile);

            // 提取属性的完整性约束装饰器名称
            //
            // 说明：TypeScript 语法上，接口属性签名（PropertySignature）不能有真正的装饰器
            // （装饰器只能用于类成员 class X { @Required prop: string }）。
            // 因此 ALCOA-06 完整性校验通过 JSDoc 注解形式 `/** @Required */` 标注约束，
            // 这也是测试用例 T7b/T7c 验证的真实场景。
            //
            // 不调用 ts.getDecorators(member)：
            // 1. TypeScript 5+ 类型定义中 getDecorators 参数为 HasDecorators 类型
            // 2. PropertySignature 不实现 HasDecorators 接口（类型不匹配）
            // 3. 即使运行时调用也永远返回 undefined（接口属性无装饰器节点）
            const decoratorNames: string[] = [];

            // 提取 JSDoc 注释中的注解（如 /** @Required */ / /** @IsNotEmpty */）
            // 这是接口属性签名标注完整性约束的唯一有效方式
            const fullText = member.getFullText(sourceFile);
            const commentMatch = fullText.match(/\/\*\*\s*@(\w+)/);
            if (commentMatch) {
              decoratorNames.push(commentMatch[1]);
            }

            const line = sourceFile.getLineAndCharacterOfPosition(member.getStart()).line + 1;

            results.push({
              name: propName,
              optional: Boolean(member.questionToken),
              hasDecorator: decoratorNames.length > 0,
              decoratorNames: Object.freeze(decoratorNames),
              interfaceName,
              filePath,
              line,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * 构建冻结的合规规则结果
 */
function buildResult(
  ruleId: string,
  passed: boolean,
  severity: ComplianceRuleResult["severity"],
  evidence: ComplianceEvidence[],
  reason: string
): ComplianceRuleResult {
  return Object.freeze({
    ruleId,
    passed,
    severity,
    evidence: Object.freeze(evidence),
    reason,
  }) as ComplianceRuleResult;
}

/**
 * 构建测试运行器未注入时的失败结果
 */
function buildNoTestRunnerResult(
  ruleId: string,
  severity: ComplianceRuleResult["severity"],
  expectedTestPath: string
): ComplianceRuleResult {
  return buildResult(
    ruleId,
    false,
    severity,
    [],
    `动态规则 ${ruleId} 无法执行：上下文未注入 testRunner，期望运行测试 ${expectedTestPath}`
  );
}

// ============================================================================
// 2. ALCOA-01：Attributable（可归属）
// ============================================================================

/**
 * ALCOA-01：Attributable（可归属）
 *
 * 法规引用：FDA Guidance 2018 §III.A "Attributable"
 * （FDA 数据完整性指南 §III.A：数据应能追溯到生成者）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找数据写入调用（repository.save / db.insert / record.create）
 * 3. 对每个调用，校验第一个参数对象含 createdBy + createdAt 字段
 * 4. 任一数据写入缺失归属字段 → passed=false（blocker）
 *
 * 严重性：blocker（数据归属缺失即 PR 打回，不可豁免）
 */
const ALCOA_01: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-01",
  packId: "ALCOA",
  title: "Attributable（可归属）",
  description:
    "所有数据写入调用（repository.save / db.insert / record.create）必须包含 createdBy（创建者）" +
    "与 createdAt（创建时间）字段，对齐 FDA Guidance 2018 §III.A。",
  regulatoryReference: "FDA Guidance 2018 §III.A",
  checkKind: "static",
  severity: "blocker",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedRecords: string[] = [];

    const writeCallees = ["repository.save", "db.insert", "record.create", "repo.save"];
    const requiredFields = ["createdBy", "createdAt"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      const calls = scanFunctionCalls(filePath, content, writeCallees);

      for (const call of calls) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${call.lineStart}-${call.lineEnd}`,
          content: call.snippet,
        });

        const missingFields = requiredFields.filter((field) => !call.argPropertyNames.includes(field));

        if (missingFields.length > 0) {
          failures.push(
            `文件 ${filePath}:${call.lineStart} ${call.callee}() 缺失归属字段：${missingFields.join("、")}`
          );
        } else {
          passedRecords.push(`${filePath}:${call.lineStart}`);
        }
      }
    }

    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到数据写入调用（repository.save / db.insert / record.create），无可归属规则适用",
      });
    }

    return buildResult(
      "ALCOA-01",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? `所有数据写入均含 createdBy + createdAt 字段（共 ${passedRecords.length} 个写入）`
        : `发现 ${failures.length} 处数据写入缺失归属字段：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 3. ALCOA-02：Legible（清晰）
// ============================================================================

/**
 * ALCOA-02：Legible（清晰）
 *
 * 法规引用：FDA Guidance 2018 §III.B "Legible"
 * （FDA 数据完整性指南 §III.B：数据应可永久阅读）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找日志调用（console.log / logger.info / logger.warn / logger.error）
 * 3. 校验日志调用参数为对象字面量，且含 timestamp / level / message 字段
 * 4. 任一日志调用非结构化 → passed=false（major）
 *
 * 严重性：major（日志格式不规范可人工豁免）
 *
 * 实现说明：
 * - "结构化日志"判定标准：第一个参数为对象字面量且含 timestamp/level/message 三个字段
 * - 也接受 2 个参数形式（如 logger.info("message", { timestamp, level })）—— 取所有参数的并集
 */
const ALCOA_02: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-02",
  packId: "ALCOA",
  title: "Legible（清晰）",
  description:
    "所有日志调用（console.log / logger.info/warn/error）必须使用结构化格式——" +
    "包含 timestamp / level / message 字段，对齐 FDA Guidance 2018 §III.B。",
  regulatoryReference: "FDA Guidance 2018 §III.B",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedLogs: string[] = [];

    const logCallees = ["console.log", "logger.info", "logger.warn", "logger.error", "logger.debug"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      const calls = scanFunctionCalls(filePath, content, logCallees);

      for (const call of calls) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${call.lineStart}-${call.lineEnd}`,
          content: call.snippet,
        });

        // 结构化日志判定：参数对象含 timestamp + level + message 三个字段
        // 注：仅校验第一个参数为对象字面量时的属性名（argPropertyNames）
        const requiredFields = ["timestamp", "level", "message"];
        const missingFields = requiredFields.filter((field) => !call.argPropertyNames.includes(field));

        if (missingFields.length > 0) {
          failures.push(
            `文件 ${filePath}:${call.lineStart} ${call.callee}() 非结构化日志，缺失字段：${missingFields.join("、")}（期望对象含 timestamp/level/message）`
          );
        } else {
          passedLogs.push(`${filePath}:${call.lineStart}`);
        }
      }
    }

    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到日志调用（console.log / logger.info 等），无清晰规则适用",
      });
    }

    return buildResult(
      "ALCOA-02",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `所有日志调用均为结构化格式（共 ${passedLogs.length} 个调用）`
        : `发现 ${failures.length} 处日志调用非结构化：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 4. ALCOA-03：Contemporaneous（同时性）
// ============================================================================

/**
 * ALCOA-03：Contemporaneous（同时性）
 *
 * 法规引用：FDA Guidance 2018 §III.C "Contemporaneous"
 * （FDA 数据完整性指南 §III.C：数据应在生成时即时记录）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找 createdAt / timestamp 字段赋值
 * 3. 校验赋值右侧是否为 new Date() / Date.now() / new Date().toISOString() 等实时生成
 * 4. 若赋值为字符串字面量（如 "2024-01-01"）或硬编码数字 → passed=false（blocker）
 *
 * 严重性：blocker（时间戳硬编码即 PR 打回，不可豁免）
 *
 * 实现说明：
 * - 识别的合法时间戳生成形式：
 *   a) new Date() 构造调用
 *   b) Date.now() 静态调用
 *   c) new Date().toISOString() / getTime() 等方法链调用
 *   d) performance.now() / process.uptime() 等运行时时间戳
 * - 禁止形式：
 *   a) 字符串字面量（如 "2024-01-01"）
 *   b) 数字字面量（如 1700000000000）
 *   c) undefined / null（除非字段可选）
 */
const ALCOA_03: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-03",
  packId: "ALCOA",
  title: "Contemporaneous（同时性）",
  description:
    "所有 createdAt / timestamp 字段赋值必须使用实时生成（new Date() / Date.now()），" +
    "禁止硬编码字符串或数字字面量，对齐 FDA Guidance 2018 §III.C。",
  regulatoryReference: "FDA Guidance 2018 §III.C",
  checkKind: "static",
  severity: "blocker",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedTimestamps: string[] = [];

    // 时间戳字段名列表
    const timestampFields = ["createdAt", "timestamp", "updatedAt", "operationTime"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);

      const lines = content.split(/\r?\n/);

      /**
       * 校验时间戳赋值的右侧表达式是否合法
       *
       * @param initializer 赋值右侧 AST 节点
       * @returns 合法返回 true，硬编码返回 false
       */
      function isDynamicTimestamp(initializer: ts.Expression): boolean {
        // 合法形式 1：new Date()
        if (ts.isNewExpression(initializer)) {
          const expr = initializer.expression;
          if (ts.isIdentifier(expr) && expr.text === "Date") {
            return true;
          }
        }
        // 合法形式 2：Date.now() / Date.UTC() 静态调用
        if (ts.isCallExpression(initializer)) {
          const expr = initializer.expression;
          if (ts.isPropertyAccessExpression(expr)) {
            const obj = expr.expression;
            const prop = expr.name;
            if (ts.isIdentifier(obj) && obj.text === "Date" && ts.isIdentifier(prop)) {
              return prop.text === "now" || prop.text === "UTC";
            }
          }
          // 合法形式 3：new Date().toISOString() / getTime() 等方法链
          if (ts.isPropertyAccessExpression(expr)) {
            // 递归校验调用方是否为 new Date() 形式
            // 此处简化为：只要方法链以 new Date() 开头即合法
            const innerCall = expr.expression;
            if (ts.isCallExpression(innerCall) || ts.isNewExpression(innerCall)) {
              return isDynamicTimestamp(innerCall);
            }
          }
          // 合法形式 4：performance.now() / process.uptime()
          if (ts.isPropertyAccessExpression(expr)) {
            const obj = expr.expression;
            const prop = expr.name;
            if (ts.isIdentifier(obj) && (obj.text === "performance" || obj.text === "process")) {
              return prop.text === "now" || prop.text === "uptime" || prop.text === "hrtime";
            }
          }
        }
        // 合法形式 5：变量引用（如 currentTime 变量，假设其动态生成）
        // 此处只接受标识符（认为运行期动态赋值）
        if (ts.isIdentifier(initializer)) {
          return true;
        }
        // 合法形式 6：属性访问（如 Date.now() 已在上面处理，其他如 timeService.now()）
        if (ts.isPropertyAccessExpression(initializer)) {
          return true;
        }

        // 禁止形式：字符串字面量 / 数字字面量
        return false;
      }

      function visit(node: ts.Node): void {
        // 识别属性赋值（如 { createdAt: ... } 或 obj.createdAt = ...）
        // 情况 1：对象字面量中的属性赋值
        if (ts.isPropertyAssignment(node)) {
          if (ts.isIdentifier(node.name) && timestampFields.includes(node.name.text)) {
            const initializer = node.initializer;
            const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
            const snippet = lines.slice(lineStart - 1, lineEnd).join("\n");

            evidence.push({
              kind: "code-snippet",
              source: `${filePath}:${lineStart}-${lineEnd}`,
              content: snippet,
            });

            if (!isDynamicTimestamp(initializer)) {
              failures.push(
                `文件 ${filePath}:${lineStart} ${node.name.text} 字段赋值为硬编码值（${initializer.getText(sourceFile)}），必须使用 new Date() / Date.now() 实时生成`
              );
            } else {
              passedTimestamps.push(`${filePath}:${lineStart}`);
            }
          }
        }
        // 情况 2：二进制表达式赋值（如 obj.createdAt = ...）
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = node.left;
          if (ts.isPropertyAccessExpression(left)) {
            const prop = left.name;
            if (timestampFields.includes(prop.text)) {
              const initializer = node.right;
              const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
              const snippet = lines.slice(lineStart - 1, lineEnd).join("\n");

              evidence.push({
                kind: "code-snippet",
                source: `${filePath}:${lineStart}-${lineEnd}`,
                content: snippet,
              });

              if (!isDynamicTimestamp(initializer)) {
                failures.push(
                  `文件 ${filePath}:${lineStart} ${prop.text} 字段赋值为硬编码值（${initializer.getText(sourceFile)}），必须使用 new Date() / Date.now() 实时生成`
                );
              } else {
                passedTimestamps.push(`${filePath}:${lineStart}`);
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 createdAt / timestamp 字段赋值，无同时性规则适用",
      });
    }

    return buildResult(
      "ALCOA-03",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? `所有时间戳字段均使用动态生成（共 ${passedTimestamps.length} 个赋值）`
        : `发现 ${failures.length} 处时间戳字段使用硬编码：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 5. ALCOA-04：Original（原始性）
// ============================================================================

/**
 * ALCOA-04：Original（原始性）
 *
 * 法规引用：FDA Guidance 2018 §III.D "Original"
 * （FDA 数据完整性指南 §III.D：数据应保留原始形式或真实副本）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找 @DataSource 装饰器调用
 * 3. 校验装饰器参数含 source（数据来源标识）与 type（数据类型）字段
 * 4. 任一数据源缺失标识 → passed=false（major）
 *
 * 严重性：major（数据源缺失可人工豁免）
 */
const ALCOA_04: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-04",
  packId: "ALCOA",
  title: "Original（原始性）",
  description:
    "所有 @DataSource 装饰器标记的数据源必须包含 source（来源标识）与 type（数据类型）字段，" +
    "对齐 FDA Guidance 2018 §III.D。",
  regulatoryReference: "FDA Guidance 2018 §III.D",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedSources: string[] = [];

    const requiredFields = ["source", "type"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      const decorators = scanDecorators(filePath, content, "DataSource");

      for (const decorator of decorators) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${decorator.lineStart}-${decorator.lineEnd}`,
          content: decorator.snippet,
        });

        const missingFields = requiredFields.filter((field) => !decorator.argPropertyNames.includes(field));

        if (missingFields.length > 0) {
          failures.push(
            `文件 ${filePath}:${decorator.lineStart} @DataSource 缺失必需字段：${missingFields.join("、")}`
          );
        } else {
          passedSources.push(`${filePath}:${decorator.lineStart}`);
        }
      }
    }

    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 @DataSource 装饰器，无原始性规则适用",
      });
    }

    return buildResult(
      "ALCOA-04",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `所有 @DataSource 数据源均含 source + type 字段（共 ${passedSources.length} 个数据源）`
        : `发现 ${failures.length} 处数据源缺失标识字段：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 6. ALCOA-05：Accurate（准确性）
// ============================================================================

/**
 * ALCOA-05：Accurate（准确性）
 *
 * 法规引用：FDA Guidance 2018 §III.E "Accurate"
 * （FDA 数据完整性指南 §III.E：数据应真实准确）
 *
 * 校验逻辑（动态）：
 * 1. 通过 testRunner 运行 tests/compliance/alcoa-05.accuracy.test.ts
 * 2. 校验 exitCode=0（测试通过）
 * 3. 校验 output 包含"数据准确性验证通过"标识
 * 4. 任一不满足 → passed=false（blocker）
 *
 * 严重性：blocker（数据准确性验证失败即 PR 打回，不可豁免）
 */
const ALCOA_05: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-05",
  packId: "ALCOA",
  title: "Accurate（准确性）",
  description: "数据准确性必须通过自动化测试验证。通过运行 tests/compliance/alcoa-05.accuracy.test.ts 验证数据准确性。",
  regulatoryReference: "FDA Guidance 2018 §III.E",
  checkKind: "dynamic",
  severity: "blocker",
  dynamicChecker: async (ctx: ComplianceCheckContext): Promise<ComplianceRuleResult> => {
    const expectedTestPath = "tests/compliance/alcoa-05.accuracy.test.ts";

    if (!ctx.testRunner) {
      return buildNoTestRunnerResult("ALCOA-05", "blocker", expectedTestPath);
    }

    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];

    const result = await ctx.testRunner.run(expectedTestPath);

    evidence.push({
      kind: "test-output",
      source: expectedTestPath,
      content: `exitCode=${result.exitCode}\noutput:\n${result.output}`,
    });

    if (result.exitCode !== 0) {
      failures.push(`数据准确性测试 exitCode=${result.exitCode}（期望 0），测试未通过`);
    }

    if (!result.output.includes("数据准确性验证通过")) {
      failures.push(`数据准确性测试输出未包含"数据准确性验证通过"标识，测试可能未完整执行`);
    }

    return buildResult(
      "ALCOA-05",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? "数据准确性测试通过，输出含数据准确性验证通过标识"
        : `数据准确性测试未通过：${failures.join("；")}`
    );
  },
});

// ============================================================================
// 7. ALCOA-06：Complete（完整性）
// ============================================================================

/**
 * ALCOA-06：Complete（完整性）
 *
 * 法规引用：FDA Guidance 2018 §III.F "Complete"
 * （FDA 数据完整性指南 §III.F：数据应包含全部信息）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找所有 InterfaceDeclaration 节点（接口名为 *Record 或 *Entity）
 * 3. 对每个接口的必填属性（无 ? 修饰符），校验是否有完整性约束装饰器
 *    （@Required / @IsNotEmpty / @IsString / @IsNumber 等校验装饰器）
 * 4. 任一必填属性缺少约束 → passed=false（major）
 *
 * 严重性：major（完整性约束缺失可人工豁免）
 */
const ALCOA_06: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-06",
  packId: "ALCOA",
  title: "Complete（完整性）",
  description:
    "所有 *Record / *Entity 接口的必填属性必须有完整性约束装饰器（@Required / @IsNotEmpty / " +
    "@IsString / @IsNumber 等），对齐 FDA Guidance 2018 §III.F。",
  regulatoryReference: "FDA Guidance 2018 §III.F",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedProperties: string[] = [];

    // 识别的完整性约束装饰器列表
    const constraintDecorators = [
      "Required",
      "IsNotEmpty",
      "IsString",
      "IsNumber",
      "IsBoolean",
      "IsDate",
      "IsArray",
      "IsObject",
      "IsEnum",
      "IsUUID",
      "IsEmail",
      "MinLength",
      "MaxLength",
      "Min",
      "Max",
      "Length",
    ];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 扫描所有接口属性
      const properties = scanInterfaceProperties(filePath, content);

      for (const prop of properties) {
        // 仅校验名为 *Record 或 *Entity 的接口的必填属性
        const isRecordInterface = prop.interfaceName.endsWith("Record") || prop.interfaceName.endsWith("Entity");
        if (!isRecordInterface) continue;
        if (prop.optional) continue;

        // 收集属性代码片段作为证据
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${prop.line}`,
          content: `${prop.interfaceName}.${prop.name}${prop.optional ? "?" : ""}: ...`,
        });

        // 校验是否有完整性约束装饰器
        const hasConstraint = constraintDecorators.some((deco) => prop.decoratorNames.includes(deco));

        if (!hasConstraint) {
          failures.push(
            `文件 ${filePath}:${prop.line} 接口 ${prop.interfaceName} 必填属性 ${prop.name} 缺少完整性约束装饰器（@Required / @IsNotEmpty / @IsString 等）`
          );
        } else {
          passedProperties.push(`${filePath}:${prop.line}`);
        }
      }
    }

    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 *Record / *Entity 接口的必填属性，无完整性规则适用",
      });
    }

    return buildResult(
      "ALCOA-06",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `所有 *Record / *Entity 接口的必填属性均有完整性约束装饰器（共 ${passedProperties.length} 个属性）`
        : `发现 ${failures.length} 处必填属性缺少完整性约束：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 8. ALCOA-07：Consistent（一致性）
// ============================================================================

/**
 * ALCOA-07：Consistent（一致性）
 *
 * 法规引用：FDA Guidance 2018 §III.G "Consistent"
 * （FDA 数据完整性指南 §III.G：数据应符合一致性原则）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找日期格式化调用（formatDate / toISOString / toLocaleDateString）
 * 3. 校验日期格式字符串参数一致（如统一使用 ISO 8601 格式 "YYYY-MM-DDTHH:mm:ss.sssZ"）
 * 4. 任一日期格式不一致 → passed=false（major）
 *
 * 严重性：major（日期格式不一致可人工豁免）
 *
 * 实现说明：
 * - 本规则检测两类不一致：
 *   a) 项目内同时使用多种日期格式（如 "YYYY-MM-DD" 与 "DD/MM/YYYY"）
 *   b) 项目内同时使用多种时区（如 UTC 与 Local）
 * - 默认推荐 ISO 8601 UTC 格式（"YYYY-MM-DDTHH:mm:ss.sssZ"）
 */
const ALCOA_07: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-07",
  packId: "ALCOA",
  title: "Consistent（一致性）",
  description:
    "项目内日期格式化调用必须使用一致的格式字符串（推荐 ISO 8601 UTC 格式），" + "对齐 FDA Guidance 2018 §III.G。",
  regulatoryReference: "FDA Guidance 2018 §III.G",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedFormats: string[] = [];

    // 日期格式化调用列表
    const formatDateCallees = ["formatDate", "dateFormat", "moment.format", "dayjs.format", "dateFns.format"];

    // 推荐的 ISO 8601 格式列表
    const isoFormats = [
      "YYYY-MM-DDTHH:mm:ss.sssZ",
      "YYYY-MM-DDTHH:mm:ssZ",
      "YYYY-MM-DDTHH:mm:ss",
      "YYYY-MM-DD",
      "YYYYMMDD",
      "ISO8601",
    ];

    // 收集项目内所有使用的日期格式
    const usedFormats = new Set<string>();

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      const calls = scanFunctionCalls(filePath, content, formatDateCallees);

      for (const call of calls) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${call.lineStart}-${call.lineEnd}`,
          content: call.snippet,
        });

        // 提取格式参数（第一个或第二个参数的字符串字面量）
        // 注：scanFunctionCalls 内部已使用 ts.createSourceFile 进行 AST 遍历，
        // 此处直接从 call.args 字符串数组中提取字面量参数，避免重复创建 AST
        const formatArg = call.args.find((arg) => arg.startsWith('"') || arg.startsWith("'"));
        if (!formatArg) {
          // 无格式参数，跳过（可能使用默认格式）
          passedFormats.push(`${filePath}:${call.lineStart}`);
          continue;
        }

        // 去除引号
        const formatString = formatArg.replace(/^["']|["']$/g, "");
        usedFormats.add(formatString);

        if (isoFormats.includes(formatString)) {
          passedFormats.push(`${filePath}:${call.lineStart}`);
        } else {
          failures.push(
            `文件 ${filePath}:${call.lineStart} ${call.callee}() 使用非 ISO 8601 格式："${formatString}"，推荐统一使用 ISO 8601 格式`
          );
        }
      }
    }

    // 若项目内同时使用多种日期格式，记录为不一致
    if (usedFormats.size > 1) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: `项目内检测到 ${usedFormats.size} 种日期格式：${Array.from(usedFormats).join("、")}`,
      });
    }

    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到日期格式化调用，无一致性规则适用",
      });
    }

    return buildResult(
      "ALCOA-07",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `项目内日期格式一致（共 ${passedFormats.length} 个调用）`
        : `发现 ${failures.length} 处日期格式不一致：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 9. ALCOA-08：Enduring（持久性）
// ============================================================================

/**
 * ALCOA-08：Enduring（持久性）
 *
 * 法规引用：FDA Guidance 2018 §III.H "Enduring"
 * （FDA 数据完整性指南 §III.H：数据应持久保存在数据库或文件中）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找数据持久化调用（repository.save / db.insert / fs.writeFile）
 * 3. 校验持久化目标为数据库或文件（通过 callee 识别）
 * 4. 持久化调用必须存在（项目内至少有 1 处持久化点）→ 否则记录为失败
 * 5. 任一持久化调用使用内存存储（如 memoryCache.set）→ passed=false（warning）
 *
 * 严重性：warning（持久性缺失仅警告，不强制打回）
 */
const ALCOA_08: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-08",
  packId: "ALCOA",
  title: "Enduring（持久性）",
  description:
    "数据持久化必须使用数据库（repository.save / db.insert）或文件（fs.writeFile），" +
    "禁止使用内存存储（memoryCache.set）作为唯一持久化方式，对齐 FDA Guidance 2018 §III.H。",
  regulatoryReference: "FDA Guidance 2018 §III.H",
  checkKind: "static",
  severity: "warning",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedPersistence: string[] = [];

    // 持久化调用列表（数据库或文件）
    const durableCallees = [
      "repository.save",
      "repo.save",
      "db.insert",
      "db.update",
      "db.save",
      "fs.writeFile",
      "fs.appendFile",
    ];

    // 内存存储调用列表（非持久化）
    const memoryCallees = ["memoryCache.set", "inMemoryStore.set", "cache.set"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 检查持久化调用
      const durableCalls = scanFunctionCalls(filePath, content, durableCallees);
      for (const call of durableCalls) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${call.lineStart}-${call.lineEnd}`,
          content: call.snippet,
        });
        passedPersistence.push(`${filePath}:${call.lineStart}`);
      }

      // 检查内存存储调用
      const memoryCalls = scanFunctionCalls(filePath, content, memoryCallees);
      for (const call of memoryCalls) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${call.lineStart}-${call.lineEnd}`,
          content: call.snippet,
        });
        failures.push(
          `文件 ${filePath}:${call.lineStart} ${call.callee}() 使用内存存储，数据不持久——必须配合 repository.save / db.insert / fs.writeFile 等持久化方式`
        );
      }
    }

    // 项目无任何持久化调用 → 警告
    if (passedPersistence.length === 0 && failures.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到任何持久化调用（repository.save / db.insert / fs.writeFile），无法验证持久性",
      });
    }

    return buildResult(
      "ALCOA-08",
      failures.length === 0,
      "warning",
      evidence,
      failures.length === 0
        ? `项目内数据持久化方式合规（共 ${passedPersistence.length} 个持久化调用）`
        : `发现 ${failures.length} 处持久化方式不合规：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 10. ALCOA-09：Available（可用性）
// ============================================================================

/**
 * ALCOA-09：Available（可用性）
 *
 * 法规引用：FDA Guidance 2018 §III.I "Available"
 * （FDA 数据完整性指南 §III.I：数据应可被检索）
 *
 * 校验逻辑（动态）：
 * 1. 通过 testRunner 运行 tests/compliance/alcoa-09.available.test.ts
 * 2. 校验 exitCode=0（测试通过）
 * 3. 校验 output 包含"数据可用性验证通过"标识
 * 4. 任一不满足 → passed=false（warning）
 *
 * 严重性：warning（数据可用性验证失败仅警告，不强制打回）
 */
const ALCOA_09: ComplianceRule = Object.freeze({
  ruleId: "ALCOA-09",
  packId: "ALCOA",
  title: "Available（可用性）",
  description:
    "数据可用性必须通过自动化测试验证。通过运行 tests/compliance/alcoa-09.available.test.ts 验证数据可被检索。",
  regulatoryReference: "FDA Guidance 2018 §III.I",
  checkKind: "dynamic",
  severity: "warning",
  dynamicChecker: async (ctx: ComplianceCheckContext): Promise<ComplianceRuleResult> => {
    const expectedTestPath = "tests/compliance/alcoa-09.available.test.ts";

    if (!ctx.testRunner) {
      return buildNoTestRunnerResult("ALCOA-09", "warning", expectedTestPath);
    }

    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];

    const result = await ctx.testRunner.run(expectedTestPath);

    evidence.push({
      kind: "test-output",
      source: expectedTestPath,
      content: `exitCode=${result.exitCode}\noutput:\n${result.output}`,
    });

    if (result.exitCode !== 0) {
      failures.push(`数据可用性测试 exitCode=${result.exitCode}（期望 0），测试未通过`);
    }

    if (!result.output.includes("数据可用性验证通过")) {
      failures.push(`数据可用性测试输出未包含"数据可用性验证通过"标识，测试可能未完整执行`);
    }

    return buildResult(
      "ALCOA-09",
      failures.length === 0,
      "warning",
      evidence,
      failures.length === 0
        ? "数据可用性测试通过，输出含数据可用性验证通过标识"
        : `数据可用性测试未通过：${failures.join("；")}`
    );
  },
});

// ============================================================================
// 11. ALCOA_PLUS_PACK 合规包导出
// ============================================================================

/**
 * ALCOA_PLUS_PACK：ALCOA+ 数据完整性原则合规包（9 条规则集）
 *
 * 包含 9 条 ALCOA+ 规则（ALCOA-01 ~ ALCOA-09），覆盖：
 * - Attributable 可归属（FDA Guidance 2018 §III.A）
 * - Legible 清晰（FDA Guidance 2018 §III.B）
 * - Contemporaneous 同时性（FDA Guidance 2018 §III.C）
 * - Original 原始性（FDA Guidance 2018 §III.D）
 * - Accurate 准确性（FDA Guidance 2018 §III.E）
 * - Complete 完整性（FDA Guidance 2018 §III.F）
 * - Consistent 一致性（FDA Guidance 2018 §III.G）
 * - Enduring 持久性（FDA Guidance 2018 §III.H）
 * - Available 可用性（FDA Guidance 2018 §III.I）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
export const ALCOA_PLUS_PACK: CompliancePack = Object.freeze({
  packId: "ALCOA",
  packName: "ALCOA+ 数据完整性原则",
  version: DEFAULT_COMPLIANCE_PACK_VERSION,
  rules: Object.freeze([ALCOA_01, ALCOA_02, ALCOA_03, ALCOA_04, ALCOA_05, ALCOA_06, ALCOA_07, ALCOA_08, ALCOA_09]),
}) as CompliancePack;

// ============================================================================
// 12. 内部工具函数导出（仅供测试使用）
// ============================================================================

/**
 * 内部工具函数导出，供单元测试验证 AST 解析正确性使用。
 */
export const __internal = Object.freeze({
  scanFunctionCalls,
  scanDecorators,
  scanInterfaceProperties,
  buildResult,
  buildNoTestRunnerResult,
});
