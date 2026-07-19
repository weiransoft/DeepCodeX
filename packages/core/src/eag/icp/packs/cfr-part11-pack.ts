/**
 * 21 CFR Part 11 合规规则集
 *
 * 本模块定义 EAG-P3 批次 11 §6 CFR 合规包首版的 5 条规则：
 * - CFR-01：电子签名（Electronic Signatures）—— 21 CFR 11.50 —— static / blocker
 * - CFR-02：记录生成（Record Generation）—— 21 CFR 11.10(b) —— static / blocker
 * - CFR-03：记录保护（Record Protection）—— 21 CFR 11.10(c) —— static / major
 * - CFR-04：系统访问控制（System Access Control）—— 21 CFR 11.10(d) —— static / blocker
 * - CFR-05：审计追踪（Audit Trail）—— 21 CFR 11.10(e) —— dynamic / blocker
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计 §6.1 设计目标（CFR 5 条规则）
 * - EAG-P3 批次 11 设计 §6.5 CFR-01~05 实现要点
 * - 21 CFR Part 11（美国联邦法规第 21 卷第 11 部分：电子记录与电子签名）
 *
 * 法规引用说明（真实条款）：
 * - 21 CFR 11.50：电子签名的表现要求（必须含签名者全名、签名日期时间、签名含义）
 * - 21 CFR 11.10(b)：系统应能生成准确完整的记录副本（含操作时间戳、操作人、操作内容）
 * - 21 CFR 11.10(c)：记录保护（记录应受到保护，防止未经授权的访问与修改）
 * - 21 CFR 11.10(d)：系统访问控制（限制授权用户访问系统）
 * - 21 CFR 11.10(e)：审计追踪（计算机系统应生成独立可追溯的审计记录）
 *
 * 实现约束（用户规则 P-1 / P-5）：
 * - 所有静态检查器使用 TypeScript Compiler API（ts.createSourceFile + AST 遍历）
 * - 禁止使用正则匹配代码语义
 * - 所有结果通过 Object.freeze 冻结
 *
 * @module eag/icp/packs/cfr-part11-pack
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
// 1. AST 工具函数（CFR 专属）
// ============================================================================

/**
 * 函数调用信息（描述一处 functionName(...) 调用的位置与参数）
 */
interface FunctionCall {
  /** 调用表达式的文本表示（如 "auditLog.record" / "signElectronically"） */
  readonly callee: string;
  /** 调用所在文件路径 */
  readonly filePath: string;
  /** 调用起始行号（1-based） */
  readonly lineStart: number;
  /** 调用结束行号（1-based） */
  readonly lineEnd: number;
  /** 调用所在源代码片段（按行截取） */
  readonly snippet: string;
  /** 调用参数列表（每个参数的文本表示，便于校验内容） */
  readonly args: ReadonlyArray<string>;
  /**
   * 调用参数对象字面量的属性名列表（仅当参数为对象字面量时有效，否则为空数组）
   * 用于校验 auditLog.record({ timestamp, operator, content }) 等结构化调用
   */
  readonly argPropertyNames: ReadonlyArray<string>;
}

/**
 * 扫描 TypeScript 文件中的所有函数调用（callee 形式匹配）
 *
 * 算法（使用 TypeScript Compiler API AST 遍历）：
 * 1. ts.createSourceFile 解析源代码为 AST
 * 2. 递归遍历 AST，查找 ts.isCallExpression(node) 节点
 * 3. 对每个 CallExpression，识别 callee（支持 Identifier 与 PropertyAccessExpression 两种形式）
 * 4. 若 callee 匹配 filterCallee（或 filterCallee 为 undefined 时返回全部），记录调用信息
 *
 * 注意：本函数仅识别直接调用，不识别通过 apply/call 间接调用或反射调用
 *
 * @param filePath 文件路径
 * @param content 文件内容
 * @param filterCalleeList 调用者过滤列表（如 ["auditLog.record", "saveRecord"]），不传则返回全部调用
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
   *
   * 支持两种形式：
   * - Identifier（如 signElectronically）
   * - PropertyAccessExpression（如 auditLog.record）
   *
   * @param expression 调用表达式的 callee
   * @returns callee 文本，无法识别时返回 null
   */
  function getCalleeText(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) {
      return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      // 递归获取对象部分 + "." + 属性名
      const objectText = getCalleeText(expression.expression);
      if (objectText === null) return null;
      return `${objectText}.${expression.name.text}`;
    }
    return null;
  }

  /**
   * 提取对象字面量参数的属性名列表
   *
   * 当参数为 ObjectLiteralExpression 时，提取所有属性的名称。
   * 支持两种属性形式：
   * - PropertyAssignment（如 timestamp: ...）
   * - ShorthandPropertyAssignment（如 timestamp）
   *
   * @param arg 参数 AST 节点
   * @returns 属性名列表（无属性或非对象字面量时返回空数组）
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

  /**
   * 递归遍历 AST 节点
   */
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeText = getCalleeText(node.expression);

      if (calleeText) {
        // 应用 callee 过滤
        const matches = !filterCalleeList || filterCalleeList.includes(calleeText);

        if (matches) {
          const startPos = node.getStart();
          const endPos = node.getEnd();
          const lineStart = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
          const lineEnd = sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;
          const snippet = lines.slice(lineStart - 1, lineEnd).join("\n");

          // 提取参数文本与属性名
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
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * 装饰器调用信息（描述一处 @Decorator(...) 调用的位置与参数）
 */
interface DecoratorCall {
  /** 装饰器名称 */
  readonly name: string;
  /** 装饰器所在文件路径 */
  readonly filePath: string;
  /** 装饰器起始行号（1-based） */
  readonly lineStart: number;
  /** 装饰器结束行号（1-based） */
  readonly lineEnd: number;
  /** 装饰器所在源代码片段 */
  readonly snippet: string;
  /** 装饰器参数对象字面量的属性名列表 */
  readonly argPropertyNames: ReadonlyArray<string>;
}

/**
 * 扫描 TypeScript 文件中的指定装饰器调用
 *
 * @param filePath 文件路径
 * @param content 文件内容
 * @param filterName 装饰器名称过滤（必填）
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

        // 提取装饰器参数对象字面量的属性名
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
 * 构建冻结的合规规则结果
 *
 * @param ruleId 规则 ID
 * @param passed 是否通过
 * @param severity 严重性
 * @param evidence 证据列表（可变数组，内部会被冻结）
 * @param reason 判定理由
 * @returns 冻结的 ComplianceRuleResult
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
// 2. CFR-01：电子签名（Electronic Signatures）
// ============================================================================

/**
 * CFR-01：电子签名（Electronic Signatures）
 *
 * 法规引用：21 CFR 11.50 "Signature manifestations"
 * （21 CFR 11.50：签名表现要求——电子签名必须含签名者全名、签名日期时间、签名含义）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找 @ElectronicSignature({...}) 装饰器调用
 * 3. 对每个 @ElectronicSignature，校验参数对象含必需字段：
 *    - userId（签名者标识）
 *    - timestamp（签名时间戳）
 *    - meaning（签名含义，如"批准"/"审核"/"创建"）
 * 4. 任一电子签名缺失必需字段 → passed=false（blocker）
 *
 * 严重性：blocker（电子签名缺失必需字段即 PR 打回，不可豁免）
 */
const CFR_01: ComplianceRule = Object.freeze({
  ruleId: "CFR-01",
  packId: "CFR",
  title: "电子签名（Electronic Signatures）",
  description:
    "所有 @ElectronicSignature 装饰器标记的电子签名必须包含 userId（签名者）、" +
    "timestamp（签名时间戳）、meaning（签名含义）三个必需字段，对齐 21 CFR 11.50 签名表现要求。",
  regulatoryReference: "21 CFR 11.50",
  checkKind: "static",
  severity: "blocker",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedSignatures: string[] = [];

    // 必需字段列表
    const requiredFields = ["userId", "timestamp", "meaning"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      const decorators = scanDecorators(filePath, content, "ElectronicSignature");

      for (const decorator of decorators) {
        // 收集装饰器代码片段作为证据
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${decorator.lineStart}-${decorator.lineEnd}`,
          content: decorator.snippet,
        });

        // 校验必需字段
        const missingFields = requiredFields.filter((field) => !decorator.argPropertyNames.includes(field));

        if (missingFields.length > 0) {
          failures.push(
            `文件 ${filePath}:${decorator.lineStart} @ElectronicSignature 缺失必需字段：${missingFields.join("、")}`
          );
        } else {
          passedSignatures.push(`${filePath}:${decorator.lineStart}`);
        }
      }
    }

    // 若项目无任何 @ElectronicSignature 装饰器，记录为通过
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 @ElectronicSignature 装饰器，无电子签名规则适用",
      });
    }

    return buildResult(
      "CFR-01",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? `所有 @ElectronicSignature 电子签名均含必需字段（共 ${passedSignatures.length} 个签名）`
        : `发现 ${failures.length} 处电子签名缺失必需字段：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 3. CFR-02：记录生成（Record Generation）
// ============================================================================

/**
 * CFR-02：记录生成（Record Generation）
 *
 * 法规引用：21 CFR 11.10(b) "The ability to generate accurate and complete copies of records"
 * （21 CFR 11.10(b)：系统能力——生成准确完整的记录副本，含操作时间戳、操作人、操作内容）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找记录生成调用（auditLog.record / saveRecord / logRecord）
 * 3. 对每个调用，校验第一个参数对象含必需字段：
 *    - timestamp（操作时间戳）
 *    - operator（操作人）
 *    - content / action（操作内容）
 * 4. 任一记录生成缺失必需字段 → passed=false（blocker）
 *
 * 严重性：blocker（记录生成缺失必需字段即 PR 打回，不可豁免）
 */
const CFR_02: ComplianceRule = Object.freeze({
  ruleId: "CFR-02",
  packId: "CFR",
  title: "记录生成（Record Generation）",
  description:
    "所有记录生成调用（auditLog.record / saveRecord / logRecord）必须包含 timestamp（时间戳）、" +
    "operator（操作人）、content 或 action（操作内容）三个必需字段，对齐 21 CFR 11.10(b)。",
  regulatoryReference: "21 CFR 11.10(b)",
  checkKind: "static",
  severity: "blocker",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedRecords: string[] = [];

    // 必需字段（content 与 action 任一存在即可）
    const requiredFields = ["timestamp", "operator"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 查找记录生成调用
      const calls = scanFunctionCalls(filePath, content, ["auditLog.record", "saveRecord", "logRecord"]);

      for (const call of calls) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${call.lineStart}-${call.lineEnd}`,
          content: call.snippet,
        });

        // 校验必需字段
        const missingFields = requiredFields.filter((field) => !call.argPropertyNames.includes(field));

        // content 与 action 任一存在即可
        const hasContentOrAction =
          call.argPropertyNames.includes("content") || call.argPropertyNames.includes("action");

        if (missingFields.length > 0 || !hasContentOrAction) {
          const allMissing = [...missingFields];
          if (!hasContentOrAction) allMissing.push("content/action（任一）");
          failures.push(`文件 ${filePath}:${call.lineStart} ${call.callee}() 缺失必需字段：${allMissing.join("、")}`);
        } else {
          passedRecords.push(`${filePath}:${call.lineStart}`);
        }
      }
    }

    // 若项目无任何记录生成调用，记录为通过
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 auditLog.record / saveRecord / logRecord 调用，无记录生成规则适用",
      });
    }

    return buildResult(
      "CFR-02",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? `所有记录生成调用均含必需字段（共 ${passedRecords.length} 个记录）`
        : `发现 ${failures.length} 处记录生成缺失必需字段：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 4. CFR-03：记录保护（Record Protection）
// ============================================================================

/**
 * CFR-03：记录保护（Record Protection）
 *
 * 法规引用：21 CFR 11.10(c) "Protection of records"
 * （21 CFR 11.10(c)：记录应受到保护，防止未经授权的访问、修改与删除）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找文件操作调用（fs.writeFile / fs.unlink / fs.appendFile）
 * 3. 对每个文件操作，校验所在类或方法是否有 @Protected 装饰器 或 调用了 setPermissions / chmod
 * 4. 任一文件操作缺少权限保护 → passed=false（major）
 *
 * 严重性：major（记录保护缺失可人工豁免，需记录豁免理由）
 *
 * 实现说明：
 * - 本规则识别两类保护方式：
 *   a) 方法/类上有 @Protected 装饰器（同一源文件内）
 *   b) 文件操作后调用 setPermissions / chmod 进行权限设置
 * - 简化原则（避免过度工程化）：仅在文件操作所在文件中检查 @Protected 装饰器存在性
 *   或检查同文件内是否有 setPermissions/chmod 调用
 */
const CFR_03: ComplianceRule = Object.freeze({
  ruleId: "CFR-03",
  packId: "CFR",
  title: "记录保护（Record Protection）",
  description:
    "所有文件操作（fs.writeFile / fs.unlink / fs.appendFile）必须有对应的权限保护——" +
    "通过 @Protected 装饰器或调用 setPermissions/chmod 进行权限设置，对齐 21 CFR 11.10(c)。",
  regulatoryReference: "21 CFR 11.10(c)",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedOperations: string[] = [];

    // 文件操作调用列表
    const fileOperationCallees = ["fs.writeFile", "fs.unlink", "fs.appendFile"];

    // 权限保护调用列表
    const protectionCallees = ["setPermissions", "chmod", "fs.chmod", "fs.chown"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 查找文件操作调用
      const fileOps = scanFunctionCalls(filePath, content, fileOperationCallees);

      if (fileOps.length === 0) continue;

      // 检查同一文件内是否有 @Protected 装饰器 或 权限设置调用
      const protectedDecorators = scanDecorators(filePath, content, "Protected");
      const protectionCalls = scanFunctionCalls(filePath, content, protectionCallees);

      const hasProtection = protectedDecorators.length > 0 || protectionCalls.length > 0;

      for (const op of fileOps) {
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${op.lineStart}-${op.lineEnd}`,
          content: op.snippet,
        });

        if (hasProtection) {
          passedOperations.push(`${filePath}:${op.lineStart}`);
          evidence.push({
            kind: "config",
            source: filePath,
            content: `文件含 @Protected 装饰器（${protectedDecorators.length} 处）或权限设置调用（${protectionCalls.length} 处）`,
          });
        } else {
          failures.push(
            `文件 ${filePath}:${op.lineStart} ${op.callee}() 调用缺少权限保护（无 @Protected 装饰器或 setPermissions/chmod 调用）`
          );
        }
      }
    }

    // 若项目无任何文件操作调用，记录为通过
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 fs.writeFile / fs.unlink / fs.appendFile 调用，无记录保护规则适用",
      });
    }

    return buildResult(
      "CFR-03",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `所有文件操作均有权限保护（共 ${passedOperations.length} 个操作）`
        : `发现 ${failures.length} 处文件操作缺少权限保护：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 5. CFR-04：系统访问控制（System Access Control）
// ============================================================================

/**
 * CFR-04：系统访问控制（System Access Control）
 *
 * 法规引用：21 CFR 11.10(d) "Limiting system access to authorized individuals"
 * （21 CFR 11.10(d)：限制系统访问仅授权用户）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 查找 API 端点装饰器（@Get / @Post / @Put / @Delete / @Patch / @RequestMapping）
 * 3. 对每个 API 端点，校验所在类或方法是否有 @Authenticated 装饰器 或 requireAuth 调用
 * 4. 任一 API 端点缺少认证 → passed=false（blocker）
 *
 * 严重性：blocker（系统访问控制缺失即 PR 打回，不可豁免）
 */
const CFR_04: ComplianceRule = Object.freeze({
  ruleId: "CFR-04",
  packId: "CFR",
  title: "系统访问控制（System Access Control）",
  description:
    "所有 API 端点（@Get/@Post/@Put/@Delete/@Patch/@RequestMapping）必须有对应的认证保护——" +
    "通过 @Authenticated 装饰器或 requireAuth 调用，对齐 21 CFR 11.10(d)。",
  regulatoryReference: "21 CFR 11.10(d)",
  checkKind: "static",
  severity: "blocker",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedEndpoints: string[] = [];

    // API 端点装饰器列表
    const endpointDecorators = ["Get", "Post", "Put", "Delete", "Patch", "RequestMapping"];

    // 认证调用列表
    const authCallees = ["requireAuth", "checkAuth", "authenticate"];

    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 查找所有 API 端点装饰器
      let endpointCount = 0;
      for (const decoName of endpointDecorators) {
        const decorators = scanDecorators(filePath, content, decoName);
        endpointCount += decorators.length;
      }

      if (endpointCount === 0) continue;

      // 检查同一文件内是否有认证装饰器或调用
      const authDecorators = scanDecorators(filePath, content, "Authenticated");
      const authCalls = scanFunctionCalls(filePath, content, authCallees);

      const hasAuth = authDecorators.length > 0 || authCalls.length > 0;

      // 收集 API 端点装饰器证据
      for (const decoName of endpointDecorators) {
        const decorators = scanDecorators(filePath, content, decoName);
        for (const decorator of decorators) {
          evidence.push({
            kind: "code-snippet",
            source: `${filePath}:${decorator.lineStart}-${decorator.lineEnd}`,
            content: decorator.snippet,
          });

          if (hasAuth) {
            passedEndpoints.push(`${filePath}:${decorator.lineStart}`);
          } else {
            failures.push(
              `文件 ${filePath}:${decorator.lineStart} @${decoName}() 端点缺少认证（无 @Authenticated 装饰器或 requireAuth 调用）`
            );
          }
        }
      }

      if (hasAuth) {
        evidence.push({
          kind: "config",
          source: filePath,
          content: `文件含 @Authenticated 装饰器（${authDecorators.length} 处）或认证调用（${authCalls.length} 处）`,
        });
      }
    }

    // 若项目无任何 API 端点装饰器，记录为通过
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 API 端点装饰器（@Get/@Post/...），无系统访问控制规则适用",
      });
    }

    return buildResult(
      "CFR-04",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? `所有 API 端点均有认证保护（共 ${passedEndpoints.length} 个端点）`
        : `发现 ${failures.length} 处 API 端点缺少认证：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 6. CFR-05：审计追踪（Audit Trail）
// ============================================================================

/**
 * CFR-05：审计追踪（Audit Trail）
 *
 * 法规引用：21 CFR 11.10(e) "Use of secure, computer-generated, time-stamped audit trails"
 * （21 CFR 11.10(e)：使用安全的、计算机生成的、带时间戳的审计追踪）
 *
 * 校验逻辑（动态）：
 * 1. 通过 testRunner 运行 tests/compliance/cfr-05.audit.test.ts
 * 2. 校验 exitCode=0（测试通过）
 * 3. 校验 output 包含"审计追踪验证通过"标识
 * 4. 任一不满足 → passed=false（blocker）
 *
 * 严重性：blocker（审计追踪缺失即 PR 打回，不可豁免）
 */
const CFR_05: ComplianceRule = Object.freeze({
  ruleId: "CFR-05",
  packId: "CFR",
  title: "审计追踪（Audit Trail）",
  description:
    "所有数据变更必须有独立可追溯的审计记录。通过运行 tests/compliance/cfr-05.audit.test.ts 验证审计追踪完整性。",
  regulatoryReference: "21 CFR 11.10(e)",
  checkKind: "dynamic",
  severity: "blocker",
  dynamicChecker: async (ctx: ComplianceCheckContext): Promise<ComplianceRuleResult> => {
    const expectedTestPath = "tests/compliance/cfr-05.audit.test.ts";

    if (!ctx.testRunner) {
      return buildNoTestRunnerResult("CFR-05", "blocker", expectedTestPath);
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
      failures.push(`审计追踪测试 exitCode=${result.exitCode}（期望 0），测试未通过`);
    }

    if (!result.output.includes("审计追踪验证通过")) {
      failures.push(`审计追踪测试输出未包含"审计追踪验证通过"标识，测试可能未完整执行`);
    }

    return buildResult(
      "CFR-05",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? "审计追踪测试通过，输出含审计追踪验证通过标识"
        : `审计追踪测试未通过：${failures.join("；")}`
    );
  },
});

// ============================================================================
// 7. CFR_PART_11_PACK 合规包导出
// ============================================================================

/**
 * CFR_PART_11_PACK：21 CFR Part 11 合规包（5 条规则集）
 *
 * 包含 5 条 CFR 规则（CFR-01 ~ CFR-05），覆盖：
 * - 电子签名（21 CFR 11.50）
 * - 记录生成（21 CFR 11.10(b)）
 * - 记录保护（21 CFR 11.10(c)）
 * - 系统访问控制（21 CFR 11.10(d)）
 * - 审计追踪（21 CFR 11.10(e)）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
export const CFR_PART_11_PACK: CompliancePack = Object.freeze({
  packId: "CFR",
  packName: "21 CFR Part 11 电子记录与电子签名",
  version: DEFAULT_COMPLIANCE_PACK_VERSION,
  rules: Object.freeze([CFR_01, CFR_02, CFR_03, CFR_04, CFR_05]),
}) as CompliancePack;

// ============================================================================
// 8. 内部工具函数导出（仅供测试使用）
// ============================================================================

/**
 * 内部工具函数导出，供单元测试验证 AST 解析正确性使用。
 */
export const __internal = Object.freeze({
  scanFunctionCalls,
  scanDecorators,
  buildResult,
  buildNoTestRunnerResult,
});
