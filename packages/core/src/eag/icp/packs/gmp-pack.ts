/**
 * GMP（Good Manufacturing Practice）合规规则集
 *
 * 本模块定义 EAG-P3 批次 11 §6.4 GMP 合规包首版的 6 条规则：
 * - GMP-01：工艺验证（Process Validation）—— 21 CFR 211.110(a) —— static / blocker
 * - GMP-02：批记录（Batch Records）—— 21 CFR 211.100 —— dynamic / blocker
 * - GMP-03：变更控制（Change Control）—— ICH Q10 §13 —— static / major
 * - GMP-04：偏差处理（Deviation Handling）—— 21 CFR 211.192 —— dynamic / major
 * - GMP-05：质量风险管理（Quality Risk Management）—— ICH Q9 —— static / major
 * - GMP-06：物料管理（Material Management）—— 21 CFR 211.80 —— dynamic / blocker
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计 §6.1 设计目标（GMP 6 条规则）
 * - EAG-P3 批次 11 设计 §6.4 GMP 规则清单 + GMP-01 详细实现示例
 * - EAG 方案 §5.9.2 ICP 行业合规包
 * - 21 CFR Part 210/211（药品生产质量管理规范）
 * - ICH Q9（质量风险管理）/ ICH Q10（药品质量体系）
 *
 * 实现约束（用户规则 P-1 / P-5）：
 * - 所有静态检查器使用 TypeScript Compiler API（ts.createSourceFile + AST 遍历）
 * - 禁止使用正则匹配代码语义（正则仅用于字符串内容匹配，如测试输出文本校验）
 * - 所有结果通过 Object.freeze 冻结
 *
 * 法规引用说明（真实条款）：
 * - 21 CFR 211.110(a)：药品生产过程中的取样与检验（in-process materials and drug products）
 * - 21 CFR 211.100：批生产与控制记录（batch production and control records）
 * - 21 CFR 211.192：生产记录审查与偏差处理（production record review）
 * - 21 CFR 211.80：物料接收、鉴别、储存与控制（control of components and drug product containers and closures）
 * - ICH Q9：质量风险管理（Quality Risk Management）
 * - ICH Q10 §13：变更管理系统（Change Management System）
 *
 * @module eag/icp/packs/gmp-pack
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
// 1. AST 工具函数（共享辅助）
// ============================================================================

/**
 * 装饰器调用信息（描述一处 @Decorator("arg") 调用的位置与参数）
 */
interface DecoratorCall {
  /** 装饰器名称（如 "ProcessStep" / "ChangeControl" / "RiskAssessed"） */
  readonly name: string;
  /** 装饰器第一个字符串字面量参数（如 stepName / changeId / riskId），无参数时为 undefined */
  readonly firstArg?: string;
  /** 装饰器所在文件路径 */
  readonly filePath: string;
  /** 装饰器起始行号（1-based） */
  readonly lineStart: number;
  /** 装饰器结束行号（1-based） */
  readonly lineEnd: number;
  /** 装饰器所在源代码片段（按行截取） */
  readonly snippet: string;
}

/**
 * 扫描 TypeScript 文件中的所有装饰器调用
 *
 * 算法（使用 TypeScript Compiler API AST 遍历，禁止正则）：
 * 1. ts.createSourceFile 解析源代码为 AST
 * 2. 递归遍历 AST 节点，查找 ts.isDecorator(node) 节点
 * 3. 对每个装饰器，提取装饰器名称与第一个字符串字面量参数
 * 4. 同时支持 @Decorator("arg") 与 @Decorator 形式
 *
 * 注意：本函数仅识别"标识符 + 可选调用表达式"形式的装饰器，
 * 不识别成员表达式装饰器（如 @module.Decorator），因 ICP 规则全部使用顶层装饰器名。
 *
 * @param filePath 文件路径（用于证据来源标注）
 * @param content 文件内容
 * @param filterName 装饰器名称过滤（如 "ProcessStep"），不传则返回全部装饰器
 * @returns 装饰器调用信息列表
 */
function scanDecorators(filePath: string, content: string, filterName?: string): DecoratorCall[] {
  // 使用 TypeScript Compiler API 解析 AST
  // setParentNodes=true 便于通过 node.getParent() 反向溯源
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);

  const lines = content.split(/\r?\n/);
  const results: DecoratorCall[] = [];

  /**
   * 递归遍历 AST 节点
   *
   * @param node 当前 AST 节点
   */
  function visit(node: ts.Node): void {
    // 识别装饰器节点（@Decorator 或 @Decorator(...)）
    if (ts.isDecorator(node)) {
      const expression = node.expression;
      let decoratorName: string | undefined;
      let firstArg: string | undefined;

      // 情况 1：@Decorator（仅标识符）
      if (ts.isIdentifier(expression)) {
        decoratorName = expression.text;
      }
      // 情况 2：@Decorator("arg")（调用表达式）
      else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        decoratorName = expression.expression.text;
        // 提取第一个字符串字面量参数
        const arg0 = expression.arguments[0];
        if (arg0 && ts.isStringLiteral(arg0)) {
          firstArg = arg0.text;
        }
      }

      // 名称过滤
      if (decoratorName && (!filterName || decoratorName === filterName)) {
        const startPos = node.getStart();
        const endPos = node.getEnd();
        const lineStart = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
        const lineEnd = sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;
        const snippet = lines.slice(lineStart - 1, lineEnd).join("\n");

        results.push({
          name: decoratorName,
          firstArg,
          filePath,
          lineStart,
          lineEnd,
          snippet,
        });
      }
    }

    // 递归遍历子节点
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * 统计测试文件中的 test() / it() 调用次数（基于 AST，禁止正则）
 *
 * 算法：
 * 1. ts.createSourceFile 解析测试文件
 * 2. 递归遍历 AST，识别 ts.isCallExpression(node) 节点
 * 3. 当调用表达式为 ts.isIdentifier(node.expression) 且名称为 "test" 或 "it" 时计数
 *
 * 注意：仅识别顶层 test() / it() 调用，不识别 describe.skip 等变种
 * （ICP 规则要求"至少 1 个 test() 用例"，因此 .skip 也计入）
 *
 * @param content 测试文件内容
 * @returns test/it 调用次数
 */
function countTestCalls(content: string): number {
  const sourceFile = ts.createSourceFile("test.ts", content, ts.ScriptTarget.Latest, /* setParentNodes */ false);

  let count = 0;

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "test" || node.expression.text === "it")
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return count;
}

/**
 * 构建冻结的合规规则结果
 *
 * 工厂函数：将 ruleId / passed / severity / evidence / reason 组装为 Object.freeze 冻结的结果。
 * 用于统一所有 staticChecker / dynamicChecker 的返回值构建。
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
 *
 * 动态规则在 testRunner 未注入时返回 passed=false + reason 说明（不抛异常）。
 *
 * @param ruleId 规则 ID
 * @param severity 严重性
 * @param expectedTestPath 期望运行的测试路径
 * @returns 冻结的 ComplianceRuleResult（passed=false）
 */
function buildNoTestRunnerResult(
  ruleId: string,
  severity: ComplianceRuleResult["severity"],
  expectedTestPath: string
): ComplianceRuleResult {
  return buildResult(
    ruleId,
    /* passed */ false,
    severity,
    [],
    `动态规则 ${ruleId} 无法执行：上下文未注入 testRunner，期望运行测试 ${expectedTestPath}`
  );
}

// ============================================================================
// 2. GMP-01：工艺验证（Process Validation）
// ============================================================================

/**
 * GMP-01：工艺验证（Process Validation）
 *
 * 法规引用：21 CFR 211.110(a) "Sampling and testing of in-process materials and drug products"
 * （21 CFR 211.110(a)：药品生产过程中间物料与成品的取样与检验）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 解析查找 @ProcessStep("step-name") 装饰器调用
 * 3. 对每个 @ProcessStep，校验是否存在对应的验证测试文件：
 *    tests/process-validation/<step-name>.process.test.ts
 * 4. 验证测试文件必须包含至少 1 个 test() 或 it() 调用（基于 AST 统计）
 * 5. 任一工艺步骤缺失验证测试 → passed=false（blocker）
 *
 * 严重性：blocker（GMP 强制要求工艺验证，缺失即 PR 打回）
 *
 * 实现说明（设计文档 §6.4 完整代码示例）：
 * - 不使用正则匹配 @ProcessStep（违反 P-1 / P-5）
 * - 使用 TypeScript Compiler API（ts.createSourceFile + forEachChild 遍历），零新增依赖
 * - AST 解析准确性高于正则，且能处理多行装饰器 / 注释干扰 / 字符串内伪装饰器等边界情况
 */
const GMP_01: ComplianceRule = Object.freeze({
  ruleId: "GMP-01",
  packId: "GMP",
  title: "工艺验证（Process Validation）",
  description:
    "所有 @ProcessStep 装饰器标记的关键工艺步骤必须有对应的验证测试文件" +
    "（tests/process-validation/<step-name>.process.test.ts），且测试文件至少包含 1 个 test() 或 it() 用例。",
  regulatoryReference: "21 CFR 211.110(a)",
  checkKind: "static",
  severity: "blocker",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedSteps: string[] = [];

    // 遍历项目所有 TypeScript 文件
    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      // 跳过非 .ts 文件（.d.ts 也跳过，避免类型声明干扰）
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 使用 AST 扫描 @ProcessStep 装饰器
      const decorators = scanDecorators(filePath, content, "ProcessStep");

      for (const decorator of decorators) {
        const stepName = decorator.firstArg;
        if (!stepName) {
          failures.push(`文件 ${filePath}:${decorator.lineStart} @ProcessStep 装饰器未提供 stepName 字符串参数`);
          continue;
        }

        // 收集装饰器代码片段作为证据
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${decorator.lineStart}-${decorator.lineEnd}`,
          content: decorator.snippet,
        });

        // 校验对应的验证测试文件存在
        const expectedTestPath = `tests/process-validation/${stepName}.process.test.ts`;
        const testFile = ctx.fileMap[expectedTestPath];

        if (!testFile) {
          failures.push(`工艺步骤 "${stepName}" 缺失验证测试：${expectedTestPath}`);
          continue;
        }

        // 使用 AST 统计 test() / it() 调用次数（禁止正则）
        const testCount = countTestCalls(testFile);

        if (testCount === 0) {
          failures.push(`验证测试 ${expectedTestPath} 不包含任何 test() / it() 用例`);
          evidence.push({
            kind: "test-output",
            source: expectedTestPath,
            content: testFile,
          });
        } else {
          passedSteps.push(stepName);
          evidence.push({
            kind: "test-output",
            source: expectedTestPath,
            content: `验证测试包含 ${testCount} 个 test/it 用例`,
          });
        }
      }
    }

    // 若项目无任何 @ProcessStep 装饰器，记录为通过（无工艺步骤需验证）
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 @ProcessStep 装饰器，无工艺验证规则适用",
      });
    }

    return buildResult(
      "GMP-01",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? `所有 @ProcessStep 工艺步骤均有对应验证测试（共 ${passedSteps.length} 个步骤）`
        : `以下 @ProcessStep 工艺验证失败：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 3. GMP-02：批记录（Batch Records）
// ============================================================================

/**
 * GMP-02：批记录（Batch Records）
 *
 * 法规引用：21 CFR 211.100 "Batch production and control records"
 * （21 CFR 211.100：批生产与控制记录）
 *
 * 校验逻辑（动态）：
 * 1. 通过 testRunner 运行 tests/compliance/gmp-02.batch.test.ts
 * 2. 校验 exitCode=0（测试通过）
 * 3. 校验 output 包含"批记录验证通过"标识（字符串匹配，非代码语义识别）
 * 4. 任一不满足 → passed=false（blocker）
 *
 * 严重性：blocker（批记录缺失即 PR 打回，不可豁免）
 *
 * 实现说明：
 * - testRunner 未注入时返回 passed=false + reason 说明（不抛异常）
 * - 测试输出"批记录验证通过"字符串校验仅用于识别测试是否完整执行，
 *   真实校验由测试文件本身（gmp-02.batch.test.ts）通过 assert 完成
 */
const GMP_02: ComplianceRule = Object.freeze({
  ruleId: "GMP-02",
  packId: "GMP",
  title: "批记录（Batch Records）",
  description:
    "批生产与控制记录必须完整、可追溯，包含批号、生产日期、操作人、关键工艺参数、检验结果等。" +
    "通过运行 tests/compliance/gmp-02.batch.test.ts 验证批记录完整性。",
  regulatoryReference: "21 CFR 211.100",
  checkKind: "dynamic",
  severity: "blocker",
  dynamicChecker: async (ctx: ComplianceCheckContext): Promise<ComplianceRuleResult> => {
    const expectedTestPath = "tests/compliance/gmp-02.batch.test.ts";

    // 测试运行器未注入时返回失败
    if (!ctx.testRunner) {
      return buildNoTestRunnerResult("GMP-02", "blocker", expectedTestPath);
    }

    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];

    // 通过 testRunner 运行批记录测试
    const result = await ctx.testRunner.run(expectedTestPath);

    evidence.push({
      kind: "test-output",
      source: expectedTestPath,
      content: `exitCode=${result.exitCode}\noutput:\n${result.output}`,
    });

    // 校验 exitCode=0
    if (result.exitCode !== 0) {
      failures.push(`批记录测试 exitCode=${result.exitCode}（期望 0），测试未通过`);
    }

    // 校验 output 包含"批记录验证通过"标识（字符串匹配，非代码语义识别）
    if (!result.output.includes("批记录验证通过")) {
      failures.push(`批记录测试输出未包含"批记录验证通过"标识，测试可能未完整执行`);
    }

    return buildResult(
      "GMP-02",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0 ? "批记录测试通过，输出含批记录验证通过标识" : `批记录测试未通过：${failures.join("；")}`
    );
  },
});

// ============================================================================
// 4. GMP-03：变更控制（Change Control）
// ============================================================================

/**
 * GMP-03：变更控制（Change Control）
 *
 * 法规引用：ICH Q10 §13 "Change Management System"
 * （ICH Q10 第 13 章：变更管理系统）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 解析查找 @ChangeControl("change-id") 装饰器调用
 * 3. 对每个 @ChangeControl，校验对应的变更记录文件存在：
 *    docs/change-control/<change-id>.md
 * 4. 变更记录文件必须包含"## 变更概述"和"## 风险评估"两节（基于字符串匹配）
 * 5. 任一变更点缺失变更记录 → passed=false（major）
 *
 * 严重性：major（变更控制缺失可人工豁免，需记录豁免理由）
 */
const GMP_03: ComplianceRule = Object.freeze({
  ruleId: "GMP-03",
  packId: "GMP",
  title: "变更控制（Change Control）",
  description:
    "所有 @ChangeControl 装饰器标记的变更点必须有对应的变更记录文件" +
    "（docs/change-control/<change-id>.md），且记录文件包含变更概述与风险评估。",
  regulatoryReference: "ICH Q10 §13",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedChanges: string[] = [];

    // 遍历项目所有 TypeScript 文件
    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 使用 AST 扫描 @ChangeControl 装饰器
      const decorators = scanDecorators(filePath, content, "ChangeControl");

      for (const decorator of decorators) {
        const changeId = decorator.firstArg;
        if (!changeId) {
          failures.push(`文件 ${filePath}:${decorator.lineStart} @ChangeControl 装饰器未提供 changeId 字符串参数`);
          continue;
        }

        // 收集装饰器代码片段作为证据
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${decorator.lineStart}-${decorator.lineEnd}`,
          content: decorator.snippet,
        });

        // 校验变更记录文件存在
        const expectedDocPath = `docs/change-control/${changeId}.md`;
        const docFile = ctx.fileMap[expectedDocPath];

        if (!docFile) {
          failures.push(`变更 ${changeId} 缺失变更记录文件：${expectedDocPath}`);
          continue;
        }

        // 校验变更记录文件包含必要章节（基于字符串匹配，非代码语义识别）
        const hasOverview = docFile.includes("## 变更概述");
        const hasRiskAssessment = docFile.includes("## 风险评估");

        if (!hasOverview || !hasRiskAssessment) {
          const missingSections: string[] = [];
          if (!hasOverview) missingSections.push("## 变更概述");
          if (!hasRiskAssessment) missingSections.push("## 风险评估");
          failures.push(`变更记录 ${expectedDocPath} 缺失必要章节：${missingSections.join("、")}`);
          evidence.push({
            kind: "config",
            source: expectedDocPath,
            content: docFile,
          });
        } else {
          passedChanges.push(changeId);
          evidence.push({
            kind: "config",
            source: expectedDocPath,
            content: `变更记录完整，含变更概述与风险评估章节`,
          });
        }
      }
    }

    // 若项目无任何 @ChangeControl 装饰器，记录为通过（无变更点需校验）
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 @ChangeControl 装饰器，无变更控制规则适用",
      });
    }

    return buildResult(
      "GMP-03",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `所有 @ChangeControl 变更点均有完整变更记录（共 ${passedChanges.length} 个变更）`
        : `发现 ${failures.length} 处变更控制缺失：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 5. GMP-04：偏差处理（Deviation Handling）
// ============================================================================

/**
 * GMP-04：偏差处理（Deviation Handling）
 *
 * 法规引用：21 CFR 211.192 "Production record review"
 * （21 CFR 211.192：生产记录审查与偏差处理）
 *
 * 校验逻辑（动态）：
 * 1. 通过 testRunner 运行 tests/compliance/gmp-04.deviation.test.ts
 * 2. 校验 exitCode=0（测试通过）
 * 3. 校验 output 包含"偏差处理验证通过"标识
 * 4. 任一不满足 → passed=false（major）
 *
 * 严重性：major（偏差处理缺失可人工豁免，需记录豁免理由）
 */
const GMP_04: ComplianceRule = Object.freeze({
  ruleId: "GMP-04",
  packId: "GMP",
  title: "偏差处理（Deviation Handling）",
  description:
    "生产过程中的偏差必须记录、调查、处理并闭环。通过运行 tests/compliance/gmp-04.deviation.test.ts 验证偏差处理流程。",
  regulatoryReference: "21 CFR 211.192",
  checkKind: "dynamic",
  severity: "major",
  dynamicChecker: async (ctx: ComplianceCheckContext): Promise<ComplianceRuleResult> => {
    const expectedTestPath = "tests/compliance/gmp-04.deviation.test.ts";

    // 测试运行器未注入时返回失败
    if (!ctx.testRunner) {
      return buildNoTestRunnerResult("GMP-04", "major", expectedTestPath);
    }

    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];

    // 通过 testRunner 运行偏差处理测试
    const result = await ctx.testRunner.run(expectedTestPath);

    evidence.push({
      kind: "test-output",
      source: expectedTestPath,
      content: `exitCode=${result.exitCode}\noutput:\n${result.output}`,
    });

    // 校验 exitCode=0
    if (result.exitCode !== 0) {
      failures.push(`偏差处理测试 exitCode=${result.exitCode}（期望 0），测试未通过`);
    }

    // 校验 output 包含"偏差处理验证通过"标识
    if (!result.output.includes("偏差处理验证通过")) {
      failures.push(`偏差处理测试输出未包含"偏差处理验证通过"标识，测试可能未完整执行`);
    }

    return buildResult(
      "GMP-04",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? "偏差处理测试通过，输出含偏差处理验证通过标识"
        : `偏差处理测试未通过：${failures.join("；")}`
    );
  },
});

// ============================================================================
// 6. GMP-05：质量风险管理（Quality Risk Management）
// ============================================================================

/**
 * GMP-05：质量风险管理（Quality Risk Management）
 *
 * 法规引用：ICH Q9 "Quality Risk Management"
 * （ICH Q9：质量风险管理）
 *
 * 校验逻辑（静态，使用 TypeScript Compiler API AST 解析）：
 * 1. 遍历 fileMap 中所有 .ts 文件
 * 2. 使用 AST 解析查找 @RiskAssessed("risk-id") 装饰器调用
 * 3. 对每个 @RiskAssessed，校验对应的风险评估文档存在：
 *    docs/risk-assessment/<risk-id>.md
 * 4. 风险评估文档必须包含"## 风险识别"和"## 风险控制"两节（基于字符串匹配）
 * 5. 任一风险评估缺失 → passed=false（major）
 *
 * 严重性：major（风险评估缺失可人工豁免，需记录豁免理由）
 */
const GMP_05: ComplianceRule = Object.freeze({
  ruleId: "GMP-05",
  packId: "GMP",
  title: "质量风险管理（Quality Risk Management）",
  description:
    "所有 @RiskAssessed 装饰器标记的风险点必须有对应的风险评估文档" +
    "（docs/risk-assessment/<risk-id>.md），且文档包含风险识别与风险控制章节。",
  regulatoryReference: "ICH Q9",
  checkKind: "static",
  severity: "major",
  staticChecker: (ctx: ComplianceCheckContext): ComplianceRuleResult => {
    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];
    const passedRisks: string[] = [];

    // 遍历项目所有 TypeScript 文件
    for (const [filePath, content] of Object.entries(ctx.fileMap)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;

      // 使用 AST 扫描 @RiskAssessed 装饰器
      const decorators = scanDecorators(filePath, content, "RiskAssessed");

      for (const decorator of decorators) {
        const riskId = decorator.firstArg;
        if (!riskId) {
          failures.push(`文件 ${filePath}:${decorator.lineStart} @RiskAssessed 装饰器未提供 riskId 字符串参数`);
          continue;
        }

        // 收集装饰器代码片段作为证据
        evidence.push({
          kind: "code-snippet",
          source: `${filePath}:${decorator.lineStart}-${decorator.lineEnd}`,
          content: decorator.snippet,
        });

        // 校验风险评估文档存在
        const expectedDocPath = `docs/risk-assessment/${riskId}.md`;
        const docFile = ctx.fileMap[expectedDocPath];

        if (!docFile) {
          failures.push(`风险点 ${riskId} 缺失风险评估文档：${expectedDocPath}`);
          continue;
        }

        // 校验风险评估文档包含必要章节
        const hasIdentification = docFile.includes("## 风险识别");
        const hasControl = docFile.includes("## 风险控制");

        if (!hasIdentification || !hasControl) {
          const missingSections: string[] = [];
          if (!hasIdentification) missingSections.push("## 风险识别");
          if (!hasControl) missingSections.push("## 风险控制");
          failures.push(`风险评估文档 ${expectedDocPath} 缺失必要章节：${missingSections.join("、")}`);
          evidence.push({
            kind: "config",
            source: expectedDocPath,
            content: docFile,
          });
        } else {
          passedRisks.push(riskId);
          evidence.push({
            kind: "config",
            source: expectedDocPath,
            content: `风险评估文档完整，含风险识别与风险控制章节`,
          });
        }
      }
    }

    // 若项目无任何 @RiskAssessed 装饰器，记录为通过
    if (evidence.length === 0) {
      evidence.push({
        kind: "config",
        source: "ctx.fileMap",
        content: "项目中未检测到 @RiskAssessed 装饰器，无质量风险管理规则适用",
      });
    }

    return buildResult(
      "GMP-05",
      failures.length === 0,
      "major",
      evidence,
      failures.length === 0
        ? `所有 @RiskAssessed 风险点均有完整风险评估文档（共 ${passedRisks.length} 个风险点）`
        : `发现 ${failures.length} 处风险评估缺失：\n${failures.join("\n")}`
    );
  },
});

// ============================================================================
// 7. GMP-06：物料管理（Material Management）
// ============================================================================

/**
 * GMP-06：物料管理（Material Management）
 *
 * 法规引用：21 CFR 211.80 "Control of components and drug product containers and closures"
 * （21 CFR 211.80：组分、药品包装容器与密封件的管控）
 *
 * 校验逻辑（动态）：
 * 1. 通过 testRunner 运行 tests/compliance/gmp-06.material.test.ts
 * 2. 校验 exitCode=0（测试通过）
 * 3. 校验 output 包含"物料管理验证通过"标识
 * 4. 任一不满足 → passed=false（blocker）
 *
 * 严重性：blocker（物料管理缺失即 PR 打回，不可豁免）
 */
const GMP_06: ComplianceRule = Object.freeze({
  ruleId: "GMP-06",
  packId: "GMP",
  title: "物料管理（Material Management）",
  description:
    "物料接收、鉴别、储存与控制必须可追溯。通过运行 tests/compliance/gmp-06.material.test.ts 验证物料管理流程。",
  regulatoryReference: "21 CFR 211.80",
  checkKind: "dynamic",
  severity: "blocker",
  dynamicChecker: async (ctx: ComplianceCheckContext): Promise<ComplianceRuleResult> => {
    const expectedTestPath = "tests/compliance/gmp-06.material.test.ts";

    // 测试运行器未注入时返回失败
    if (!ctx.testRunner) {
      return buildNoTestRunnerResult("GMP-06", "blocker", expectedTestPath);
    }

    const evidence: ComplianceEvidence[] = [];
    const failures: string[] = [];

    // 通过 testRunner 运行物料管理测试
    const result = await ctx.testRunner.run(expectedTestPath);

    evidence.push({
      kind: "test-output",
      source: expectedTestPath,
      content: `exitCode=${result.exitCode}\noutput:\n${result.output}`,
    });

    // 校验 exitCode=0
    if (result.exitCode !== 0) {
      failures.push(`物料管理测试 exitCode=${result.exitCode}（期望 0），测试未通过`);
    }

    // 校验 output 包含"物料管理验证通过"标识
    if (!result.output.includes("物料管理验证通过")) {
      failures.push(`物料管理测试输出未包含"物料管理验证通过"标识，测试可能未完整执行`);
    }

    return buildResult(
      "GMP-06",
      failures.length === 0,
      "blocker",
      evidence,
      failures.length === 0
        ? "物料管理测试通过，输出含物料管理验证通过标识"
        : `物料管理测试未通过：${failures.join("；")}`
    );
  },
});

// ============================================================================
// 8. GMP_PACK 合规包导出
// ============================================================================

/**
 * GMP_PACK：GMP 合规包（6 条规则集）
 *
 * 包含 6 条 GMP 规则（GMP-01 ~ GMP-06），覆盖：
 * - 工艺验证（21 CFR 211.110(a)）
 * - 批记录（21 CFR 211.100）
 * - 变更控制（ICH Q10 §13）
 * - 偏差处理（21 CFR 211.192）
 * - 质量风险管理（ICH Q9）
 * - 物料管理（21 CFR 211.80）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 *
 * 顺序对齐设计文档 §6.4 GMP 规则清单声明顺序：GMP-01 → GMP-02 → ... → GMP-06。
 */
export const GMP_PACK: CompliancePack = Object.freeze({
  packId: "GMP",
  packName: "药品生产质量管理规范（GMP）",
  version: DEFAULT_COMPLIANCE_PACK_VERSION,
  rules: Object.freeze([GMP_01, GMP_02, GMP_03, GMP_04, GMP_05, GMP_06]),
}) as CompliancePack;

// ============================================================================
// 9. 内部工具函数导出（仅供测试使用，不在 index.ts barrel 暴露）
// ============================================================================

/**
 * 内部工具函数导出，供单元测试验证 AST 解析正确性使用。
 *
 * 设计说明：将 scanDecorators / countTestCalls 通过 __internal 命名空间导出，
 * 便于测试时直接验证工具函数行为，而非通过 ComplianceRule 间接验证。
 * 这是有意为之的"测试可观测性"设计，不构成生产 API 的一部分。
 */
export const __internal = Object.freeze({
  /** 扫描装饰器（用于测试直接验证 AST 解析） */
  scanDecorators,
  /** 统计 test/it 调用次数（用于测试直接验证 AST 解析） */
  countTestCalls,
  /**
   * 构建冻结的合规规则结果（用于测试构造期望结果）
   */
  buildResult,
  /**
   * 构建测试运行器未注入时的失败结果（用于测试验证错误处理）
   */
  buildNoTestRunnerResult,
});
