/**
 * 静态判定器共享工具函数（EAG-P2 批次 9 S2 判定器层）
 *
 * 本模块为 13 个 StaticChecker 提供共用的代码扫描与结果构建工具函数，
 * 避免每个判定器重复实现 import / decorator / class method / string literal 扫描逻辑。
 *
 * 设计依据：
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单（13 个）
 * - EAG-P2 批次 9 设计 §4.5.3 StaticChecker 协议定义
 * - 不引入 AST 解析库约束：仅使用 TypeScript 正则 + 字符串处理
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 工具函数返回 ReadonlyArray<T>
 * - 类型定义字段全部 readonly
 * - 构建结果函数返回冻结的 RedlineResult
 *
 * @module eag/coding/static-checkers/checker-utils
 */

import type { RedlineResult, RedlineViolation } from "../../evaluator/types";

// ============================================================================
// 1. 共享类型定义
// ============================================================================

/**
 * import 语句扫描结果
 *
 * 对应 TypeScript / ES Module 的 import 语句元数据。
 * 支持 default import / named import / namespace import / side-effect import 四种形式。
 *
 * 字段语义：
 * - source：模块来源路径（如 "../eag/tcs/cache" / "ali-oss" / "@aws-sdk/client-s3"）
 * - clause：import 子句原文（如 "{ OSS }" / "* as crypto" / "type ObjectStoragePort"）
 * - line：所在行号（1-based）
 * - raw：import 语句原文（去除首尾空白）
 */
export interface ImportStatement {
  /** 模块来源路径（引号内的字符串） */
  readonly source: string;
  /** import 子句原文（从 import 关键字到 from 关键字之间的内容；side-effect import 时为空字符串） */
  readonly clause: string;
  /** 所在行号（1-based） */
  readonly line: number;
  /** import 语句原文（去除首尾空白后的整行或多行语句） */
  readonly raw: string;
}

/**
 * 装饰器扫描结果
 *
 * 对应 TypeScript 装饰器元数据（class-level / method-level / property-level）。
 * 仅识别 @DecoratorName 或 @DecoratorName(args) 形式，不解析参数语义。
 *
 * 字段语义：
 * - name：装饰器名称（如 "IsString" / "IsEmail" / "Injectable"）
 * - args：装饰器参数原文（含括号；如 "(1, 10)"），无参数时为空字符串
 * - line：所在行号（1-based）
 * - target：装饰器所附着的类名或方法名（启发式推断，可能为空字符串）
 */
export interface DecoratorInfo {
  /** 装饰器名称（不含 @ 与参数） */
  readonly name: string;
  /** 装饰器参数原文（含括号），无参数时为空字符串 */
  readonly args: string;
  /** 所在行号（1-based） */
  readonly line: number;
  /** 装饰器所附着的类名或方法名（启发式推断，无法推断时为空字符串） */
  readonly target: string;
}

/**
 * 类方法扫描结果
 *
 * 对应 TypeScript 类中定义的方法元数据（含访问修饰符 / 异步标记 / 参数列表）。
 * 用于贫血模型检测、幂等键参数扫描、双写顺序检测等场景。
 *
 * 字段语义：
 * - className：所属类名
 * - methodName：方法名
 * - params：参数列表原文（含括号）
 * - isAsync：是否 async 方法
 * - visibility：访问修饰符（"public" / "private" / "protected" / "static"）
 * - line：所在行号（1-based）
 * - body：方法体原文（不含签名与大括号）
 */
export interface ClassMethodInfo {
  /** 所属类名 */
  readonly className: string;
  /** 方法名 */
  readonly methodName: string;
  /** 参数列表原文（含括号） */
  readonly params: string;
  /** 是否 async 方法 */
  readonly isAsync: boolean;
  /** 访问修饰符（"public" / "private" / "protected" / "static"，默认 "public"） */
  readonly visibility: string;
  /** 所在行号（1-based，方法签名所在行） */
  readonly line: number;
  /** 方法体原文（不含签名与大括号） */
  readonly body: string;
}

/**
 * 字符串字面量扫描结果
 *
 * 对应代码中的字符串字面量（单引号 / 双引号 / 模板字符串）。
 * 用于硬编码密钥扫描、SQL 语句提取等场景。
 *
 * 字段语义：
 * - value：字符串值（去除引号后的内容）
 * - quote：引号类型（"'" / '"' / "`"）
 * - line：所在行号（1-based）
 * - raw：原文（含引号）
 */
export interface StringLiteral {
  /** 字符串值（去除引号后的内容） */
  readonly value: string;
  /** 引号类型（"'" / '"' / "`"） */
  readonly quote: string;
  /** 所在行号（1-based） */
  readonly line: number;
  /** 原文（含引号） */
  readonly raw: string;
}

// ============================================================================
// 2. 代码扫描工具函数
// ============================================================================

/**
 * 扫描代码中的 import 语句
 *
 * 支持 4 种 import 形式：
 * 1. default import：`import OSS from 'ali-oss';`
 * 2. named import：`import { OSS } from 'ali-oss';` / `import { OSS, type StorageKeyParams } from '...';`
 * 3. namespace import：`import * as crypto from 'crypto';`
 * 4. side-effect import：`import 'reflect-metadata';`
 *
 * 算法：
 * 1. 按行分割，逐行扫描
 * 2. 跳过注释行（// 与 /* *\/）
 * 3. 匹配 `^import\s+(...)?\s+from\s+['"]<source>['"]\s*;?$` 或 `^import\s+['"]<source>['"]\s*;?$`
 * 4. 提取 source 与 clause
 *
 * @param content 代码内容
 * @returns import 语句列表（按行号升序）
 */
export function scanImports(content: string): ImportStatement[] {
  const results: ImportStatement[] = [];
  const lines = content.split(/\r?\n/);

  // 正则：标准 import ... from '...' 形式
  // 分组 1：import 子句（含括号或 default 名）
  // 分组 2：模块来源路径
  const standardRe = /^\s*import\s+(?:type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
  // 正则：side-effect import '...' 形式
  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过单行注释
    if (/^\s*\/\//.test(line)) continue;
    // 跳过块注释行
    if (/^\s*\*/.test(line)) continue;

    let m = line.match(standardRe);
    if (m) {
      const clause = m[1].trim();
      const source = m[2];
      results.push({
        source,
        clause,
        line: i + 1,
        raw: line.trim(),
      });
      continue;
    }
    m = line.match(sideEffectRe);
    if (m) {
      const source = m[1];
      results.push({
        source,
        clause: "",
        line: i + 1,
        raw: line.trim(),
      });
    }
  }
  return results;
}

/**
 * 扫描代码中的装饰器
 *
 * 识别 `@DecoratorName` 或 `@DecoratorName(args)` 形式。
 * 启发式推断 target：装饰器所在行或下一行的 class / method / property 名。
 *
 * 算法：
 * 1. 按行分割，逐行扫描
 * 2. 跳过注释行
 * 3. 匹配 `^\s*@([A-Za-z_][\w]*)(\([^)]*\))?\s*$` 或 `^\s*@([A-Za-z_][\w]*)(\([^)]*\))?\s+\w+`
 * 4. 启发式推断 target：查找下一行非装饰器行的 class/method/property 名
 *
 * @param content 代码内容
 * @returns 装饰器列表（按行号升序）
 */
export function scanDecorators(content: string): DecoratorInfo[] {
  const results: DecoratorInfo[] = [];
  const lines = content.split(/\r?\n/);

  // 正则：装饰器行，可能单独一行也可能与目标同行
  // 分组 1：装饰器名称
  // 分组 2：参数（含括号，可能为空）
  const decoratorRe = /^\s*@([A-Za-z_][\w.]*)(\([^)]*\))?/;

  // 正则：识别下一行的目标（class / method / property）
  const classRe = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/;
  const methodRe = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_][\w]*)\s*\(/;
  const propertyRe = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*([A-Za-z_][\w]*)\s*[:?=]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    const m = line.match(decoratorRe);
    if (!m) continue;

    const name = m[1];
    const args = m[2] ?? "";

    // 启发式推断 target：当前行剩余部分若已有目标则取，否则查下一行
    let target = "";
    const restOfLine = line.slice(m[0].length).trim();
    if (restOfLine.length > 0) {
      // 同行有目标
      const classMatch = restOfLine.match(classRe);
      const methodMatch = restOfLine.match(methodRe);
      const propertyMatch = restOfLine.match(propertyRe);
      if (classMatch) {
        target = classMatch[1];
      } else if (methodMatch) {
        target = methodMatch[1];
      } else if (propertyMatch) {
        target = propertyMatch[1];
      }
    }
    if (!target && i + 1 < lines.length) {
      // 查下一行
      const nextLine = lines[i + 1];
      const classMatch = nextLine.match(classRe);
      const methodMatch = nextLine.match(methodRe);
      const propertyMatch = nextLine.match(propertyRe);
      if (classMatch) {
        target = classMatch[1];
      } else if (methodMatch) {
        target = methodMatch[1];
      } else if (propertyMatch) {
        target = propertyMatch[1];
      }
    }

    results.push({
      name,
      args,
      line: i + 1,
      target,
    });
  }
  return results;
}

/**
 * 扫描代码中的类方法
 *
 * 识别 TypeScript 类中的方法定义，提取方法名、参数列表、async 标记、访问修饰符。
 * 仅识别顶层类方法（不识别嵌套函数或 lambda）。
 *
 * 算法：
 * 1. 跟踪当前所属类（class Name { ... } 块）
 * 2. 在类体内匹配方法签名：`<modifiers> methodName(params): ReturnType {`
 * 3. 提取方法体（匹配大括号配对）
 *
 * @param content 代码内容
 * @returns 类方法列表（按行号升序）
 */
export function scanClassMethods(content: string): ClassMethodInfo[] {
  const results: ClassMethodInfo[] = [];
  const lines = content.split(/\r?\n/);

  // 跟踪当前所属类名与类体深度
  let currentClass = "";
  let braceDepth = 0;
  let inClass = false;

  // 正则：识别 class 声明
  const classDeclRe = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/;
  // 正则：识别方法签名
  // 分组 1：修饰符整体（可能为空，含 public/private/protected/static/async/readonly）
  // 分组 2：方法名
  // 分组 3：参数列表（含括号）
  const methodRe =
    /^\s*((?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|abstract\s+|get\s+|set\s+)*)((?:get|set)?\s*[A-Za-z_][\w]*)\s*(\([^)]*\))/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测 class 声明开始
    const classMatch = line.match(classDeclRe);
    if (classMatch) {
      currentClass = classMatch[1];
      inClass = true;
      // 重置 brace 深度（class 块从 0 开始计算）
      braceDepth = 0;
      // 计算当前行中 { 的数量
      const openBraces = (line.match(/\{/g) ?? []).length;
      const closeBraces = (line.match(/\}/g) ?? []).length;
      braceDepth += openBraces - closeBraces;
      continue;
    }

    if (inClass) {
      // 更新大括号深度
      const openBraces = (line.match(/\{/g) ?? []).length;
      const closeBraces = (line.match(/\}/g) ?? []).length;
      braceDepth += openBraces - closeBraces;

      // 检测方法签名
      const methodMatch = line.match(methodRe);
      if (methodMatch) {
        const modifiers = methodMatch[1] ?? "";
        const methodName = methodMatch[2].trim();
        const params = methodMatch[3];
        const isAsync = /\basync\b/.test(modifiers);
        let visibility = "public";
        if (/\bprivate\b/.test(modifiers)) {
          visibility = "private";
        } else if (/\bprotected\b/.test(modifiers)) {
          visibility = "protected";
        } else if (/\bstatic\b/.test(modifiers)) {
          visibility = "static";
        }

        // 提取方法体：从当前行向下扫描大括号配对
        let body = "";
        let bodyBraceDepth = 0;
        let bodyStarted = false;
        for (let j = i; j < lines.length; j++) {
          const bodyLine = lines[j];
          for (const ch of bodyLine) {
            if (ch === "{") {
              bodyBraceDepth++;
              bodyStarted = true;
            } else if (ch === "}") {
              bodyBraceDepth--;
            }
          }
          if (j > i) body += bodyLine + "\n";
          if (bodyStarted && bodyBraceDepth === 0) break;
        }

        results.push({
          className: currentClass,
          methodName,
          params,
          isAsync,
          visibility,
          line: i + 1,
          body,
        });
      }

      // 类体结束（brace 归零）
      if (braceDepth <= 0) {
        inClass = false;
        currentClass = "";
      }
    }
  }
  return results;
}

/**
 * 扫描代码中的字符串字面量
 *
 * 识别单引号 / 双引号 / 模板字符串字面量。
 * 跳过注释行内的字符串（避免误报）。
 *
 * 算法：
 * 1. 按行分割
 * 2. 跳过注释行
 * 3. 用正则匹配 `"[^"\\]*(?:\\.[^"\\]*)*"` / `'[^'\\]*(?:\\.[^'\\]*)*'` / `` `[^`\\]*(?:\\.[^`\\]*)*` ``
 *
 * @param content 代码内容
 * @returns 字符串字面量列表（按行号升序）
 */
export function scanStringLiterals(content: string): StringLiteral[] {
  const results: StringLiteral[] = [];
  const lines = content.split(/\r?\n/);

  // 三种引号的正则：处理转义字符
  const doubleQuotedRe = /"((?:[^"\\]|\\.)*)"/g;
  const singleQuotedRe = /'((?:[^'\\]|\\.)*)'/g;
  const templateRe = /`((?:[^`\\]|\\.)*)`/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行（避免误识别注释中的字符串）
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    // 双引号
    let m: RegExpExecArray | null;
    doubleQuotedRe.lastIndex = 0;
    while ((m = doubleQuotedRe.exec(line)) !== null) {
      results.push({
        value: m[1],
        quote: '"',
        line: i + 1,
        raw: m[0],
      });
    }
    // 单引号
    singleQuotedRe.lastIndex = 0;
    while ((m = singleQuotedRe.exec(line)) !== null) {
      results.push({
        value: m[1],
        quote: "'",
        line: i + 1,
        raw: m[0],
      });
    }
    // 模板字符串
    templateRe.lastIndex = 0;
    while ((m = templateRe.exec(line)) !== null) {
      results.push({
        value: m[1],
        quote: "`",
        line: i + 1,
        raw: m[0],
      });
    }
  }
  return results;
}

// ============================================================================
// 3. 判定结果构建函数
// ============================================================================

/**
 * 构建违规结果
 *
 * 工具函数：判定器检测到违规时调用此函数快速构建 RedlineResult。
 * 自动填充 redlineId / status="violated" / violations 数组。
 *
 * 不可变优先：返回的对象与 violations 数组均通过 Object.freeze 冻结。
 * 注意：RedlineResult.violations 在 evaluator/types.ts 中定义为 mutable 数组类型，
 * 此处通过类型断言将 readonly 数组断言为 RedlineViolation[] 以满足接口契约，
 * 运行期实际不可变（Object.freeze 已冻结）。这是不可变优先与既有契约的兼容方案。
 *
 * @param redlineId 红线 ID
 * @param filePath 违规文件路径
 * @param line 违规行号（1-based，可选）
 * @param description 违规描述
 * @param fixSuggestion 修复建议
 * @returns 冻结的违规 RedlineResult
 */
export function buildViolation(
  redlineId: string,
  filePath: string,
  line: number | undefined,
  description: string,
  fixSuggestion: string
): RedlineResult {
  const violation: RedlineViolation = {
    filePath,
    line,
    description,
    fixSuggestion,
  };
  // Object.freeze 同时冻结外层对象与内层 violations 数组；
  // 类型断言将 readonly RedlineViolation[] 断言为 RedlineViolation[] 以匹配接口。
  const frozen = Object.freeze({
    redlineId,
    status: "violated" as const,
    violations: Object.freeze([violation]),
  });
  // readonly 数组与 mutable RedlineViolation[] 类型不兼容，通过 unknown 中转断言。
  return frozen as unknown as RedlineResult;
}

/**
 * 构建多条违规结果
 *
 * 工具函数：判定器检测到多个违规点时调用此函数构建含多个 violation 的 RedlineResult。
 *
 * 不可变优先：返回的对象与 violations 数组中每条 violation 均通过 Object.freeze 冻结。
 *
 * @param redlineId 红线 ID
 * @param violations 违规列表
 * @returns 冻结的违规 RedlineResult
 */
export function buildViolations(
  redlineId: string,
  violations: ReadonlyArray<{
    readonly filePath: string;
    readonly line?: number;
    readonly description: string;
    readonly fixSuggestion: string;
  }>
): RedlineResult {
  if (violations.length === 0) {
    return buildPass(redlineId);
  }
  // 冻结每条 violation 对象，再冻结外层 violations 数组与 RedlineResult 对象；
  // 类型断言将 readonly 数组断言为 mutable 以匹配 RedlineResult 接口契约。
  const frozen = Object.freeze({
    redlineId,
    status: "violated" as const,
    violations: Object.freeze(violations.map((v) => Object.freeze({ ...v }))),
  });
  // readonly 数组与 mutable RedlineViolation[] 类型不兼容，通过 unknown 中转断言。
  return frozen as unknown as RedlineResult;
}

/**
 * 构建通过结果
 *
 * 工具函数：判定器检测无违规时调用此函数构建通过 RedlineResult。
 *
 * 不可变优先：返回的对象与 violations 空数组均通过 Object.freeze 冻结。
 *
 * @param redlineId 红线 ID
 * @returns 冻结的通过 RedlineResult
 */
export function buildPass(redlineId: string): RedlineResult {
  const frozen = Object.freeze({
    redlineId,
    status: "passed" as const,
    violations: Object.freeze([]),
  });
  // 空数组的 readonly 类型与 mutable RedlineViolation[] 类型不够重叠，
  // 需要先断言为 unknown 再断言为 RedlineResult。
  return frozen as unknown as RedlineResult;
}

/**
 * 构建未知结果（无法判定）
 *
 * 工具函数：判定器无法判定时调用此函数构建 unknown RedlineResult。
 * STRICT 评估器会将 unknown 状态的红线升级为 HUMAN_CHECKPOINT。
 *
 * 不可变优先：返回的对象与 violations 空数组均通过 Object.freeze 冻结。
 *
 * @param redlineId 红线 ID
 * @param reason 无法判定的原因
 * @returns 冻结的 unknown RedlineResult
 */
export function buildUnknown(redlineId: string, reason: string): RedlineResult {
  const frozen = Object.freeze({
    redlineId,
    status: "unknown" as const,
    violations: Object.freeze([]),
    evidence: reason,
  });
  // 空数组的 readonly 类型与 mutable RedlineViolation[] 类型不够重叠，
  // 需要先断言为 unknown 再断言为 RedlineResult。
  return frozen as unknown as RedlineResult;
}

// ============================================================================
// 4. 辅助工具函数
// ============================================================================

/**
 * 提取代码文件中的第一行文件路径标记
 *
 * 约定：fixture 代码与生成代码的第一行以 `// path/to/file.ts` 形式标注文件路径。
 * 本函数提取该路径；若无标记则返回空字符串。
 *
 * @param content 代码内容
 * @returns 文件路径（无标记时为空字符串）
 */
export function extractFilePathFromComment(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const m = firstLine.match(/^\s*\/\/\s*(\S+)\s*$/);
  return m ? m[1] : "";
}

/**
 * 计算字符串在多行内容中的行号
 *
 * 工具函数：判定器扫描到违规模式后，调用此函数计算违规行号（1-based）。
 *
 * @param content 完整代码内容
 * @param matchStart 违规匹配在内容中的字符起始位置
 * @returns 1-based 行号
 */
export function lineOf(content: string, matchStart: number): number {
  if (matchStart < 0) return 0;
  let line = 1;
  for (let i = 0; i < matchStart && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
