/**
 * 文档对照代码一致性检查器（TypeScript 移植版）
 *
 * 来源：multi-agent-team skill scripts/doc_code_consistency_checker.py（1929 行）
 * 职责：
 * 1. 解析文档（PRD/SPEC/架构/测试计划）中的功能点、验收标准、集成关系
 * 2. 扫描代码中的函数、类、模块、API、import 依赖
 * 3. 逐项对照检查六大维度（D1~D6）
 * 4. 生成结构化审查报告
 *
 * 六大维度：
 * - D1 功能完成度：文档中每个功能点是否有对应代码实现
 * - D2 集成完整性：文档定义的模块间集成关系是否在代码中体现
 * - D3 测试正确性：全部测试通过且覆盖文档功能
 * - D4 验收标准满足：文档中每条验收标准是否被代码满足
 * - D5 TODO/FIXME 清零：代码中无残留的未实现 TODO/FIXME
 * - D6 文档意图遵从：代码实现未偏离文档设计意图
 *
 * 支持语言：Python / JavaScript / TypeScript / Java / Go / Rust
 *
 * 设计原则：
 * - 严格真实移植 Python 原版全部逻辑，禁止 mock/占位/简化
 * - 仅依赖 Node.js 内置模块（node:fs / node:path / node:child_process），禁止新增任何 npm 依赖
 * - 所有函数和关键逻辑均有详细中文注释，符合 TypeScript 代码规范
 * - TypeScript 严格类型：所有 exported 类型必须显式定义，使用 interface/type 表达
 * - Python 的 __init__ → constructor；self → this；Optional[X] → X | null；List[X] → X[]；
 *   Dict[K, V] → Record<K, V>；Tuple[X, Y, Z] → [X, Y, Z]
 *
 * 创建日期：2026-07-21
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";

// ============================================================================
// 第一部分：正则辅助函数
// ============================================================================

/**
 * 正则全局匹配迭代器（等价于 Python 的 re.Pattern.finditer）
 *
 * 基于源正则的 source 创建带 g 标志的新正则实例，避免修改原正则的 lastIndex 状态。
 * 防止零宽匹配导致死循环：当匹配位置未前进时，手动推进 lastIndex。
 *
 * @param pattern 源正则（无需 g 标志）
 * @param str 待匹配字符串
 * @returns 匹配结果生成器（RegExpExecArray）
 */
function* finditer(pattern: RegExp, str: string): Generator<RegExpExecArray> {
  // 基于 source 创建带 g 标志的新正则，避免修改原正则的 lastIndex
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    yield m;
    // 防止零宽匹配死循环
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
  }
}

/**
 * 正则搜索（等价于 Python 的 re.Pattern.search）
 *
 * 返回字符串中第一个匹配，未匹配返回 null。
 * 使用不带 g 标志的副本执行，避免 lastIndex 状态问题。
 *
 * @param pattern 源正则
 * @param str 待搜索字符串
 * @returns 第一个匹配结果，未匹配返回 null
 */
function regexSearch(pattern: RegExp, str: string): RegExpExecArray | null {
  if (pattern.flags.includes("g")) {
    // 移除 g 标志，避免 exec 使用 lastIndex 状态
    const re = new RegExp(pattern.source, pattern.flags.replace(/g/g, ""));
    return re.exec(str);
  }
  return pattern.exec(str);
}

/**
 * 正则匹配（等价于 Python 的 re.Pattern.match）
 *
 * Python 的 re.match 锚定在字符串开头。JavaScript 中对于以 ^ 开头的正则，
 * exec 等价于 match（因为 ^ 保证了匹配从位置 0 开始）。
 *
 * @param pattern 源正则
 * @param str 待匹配字符串
 * @returns 开头匹配结果，未匹配返回 null
 */
function regexMatch(pattern: RegExp, str: string): RegExpExecArray | null {
  // 对于以 ^ 开头的正则，exec 等价于 Python 的 re.match
  return regexSearch(pattern, str);
}

/**
 * 统计字符串中指定位置之前的换行符数量，加 1 得到行号
 *
 * 等价于 Python 的 content.count("\n", 0, match.start()) + 1
 *
 * @param content 全文内容
 * @param index 目标位置索引
 * @returns 行号（从 1 开始）
 */
function lineNumberAt(content: string, index: number): number {
  let count = 0;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) count++; // 10 = '\n'
  }
  return count + 1;
}

/**
 * 递归遍历目录，返回所有文件路径（跳过排除目录）
 *
 * 等价于 Python 的 pathlib.Path.rglob("*") + 路径片段过滤
 *
 * @param root 根目录绝对路径
 * @param skipDirs 需要跳过的目录名集合
 * @returns 文件绝对路径数组
 */
function walkFiles(root: string, skipDirs: Set<string>): string[] {
  const results: string[] = [];

  /**
   * 递归遍历内部函数
   * @param dir 当前遍历目录
   */
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不可读（权限不足等），跳过
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过排除目录
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  walk(root);
  return results;
}

// ============================================================================
// 第二部分：数据结构定义
// ============================================================================

/**
 * 功能完成度检查项（D1）
 *
 * 字段说明：
 * - feature_id: 功能 ID（如 F-001）
 * - feature_name: 功能名称
 * - feature_desc: 功能描述
 * - doc_source: 文档来源（如 "PRD §2.1"）
 * - code_location: 代码位置（如 "auth.py:login()"），空表示未找到
 * - status: 实现状态（"implemented" / "missing"）
 * - evidence: 证据描述
 */
export interface FeatureCheckItem {
  feature_id: string;
  feature_name: string;
  feature_desc: string;
  doc_source: string;
  code_location: string;
  /** 实现状态："implemented" 已实现 / "missing" 未实现 */
  status: "implemented" | "missing";
  evidence: string;
}

/**
 * 集成完整性检查项（D2）
 *
 * 字段说明：
 * - integration_desc: 集成关系描述（如 "模块A→模块B"）
 * - doc_source: 文档来源
 * - code_location: 代码位置（如 "a.py: import b"），空表示未找到
 * - status: 集成状态（"connected" / "missing"）
 */
export interface IntegrationCheckItem {
  integration_desc: string;
  doc_source: string;
  code_location: string;
  /** 集成状态："connected" 已连通 / "missing" 缺失 */
  status: "connected" | "missing";
}

/**
 * 测试正确性检查结果（D3）
 *
 * 字段说明：
 * - test_command: 执行的测试命令
 * - passed: 通过数
 * - failed: 失败数
 * - skipped: 跳过数
 * - covered_features: 测试覆盖的功能 ID 列表
 * - uncovered_features: 未覆盖的功能 ID 列表
 * - test_output_tail: 测试输出末尾（诊断用）
 * - duration_sec: 执行耗时（秒）
 */
export interface TestCheckResult {
  test_command: string;
  passed: number;
  failed: number;
  skipped: number;
  covered_features: string[];
  uncovered_features: string[];
  test_output_tail: string;
  duration_sec: number;
}

/**
 * 验收标准检查项（D4）
 *
 * 字段说明：
 * - criteria_id: 验收标准 ID（如 AC-001）
 * - criteria_desc: 验收标准描述
 * - doc_source: 文档来源
 * - verification: 验证方式（"test" / "code" / "manual"）
 * - status: 满足状态（"satisfied" / "unsatisfied"）
 */
export interface AcceptanceCheckItem {
  criteria_id: string;
  criteria_desc: string;
  doc_source: string;
  /** 验证方式："test" 测试验证 / "code" 代码验证 / "manual" 人工验证 */
  verification: "test" | "code" | "manual";
  /** 满足状态："satisfied" 已满足 / "unsatisfied" 不满足 */
  status: "satisfied" | "unsatisfied";
}

/**
 * TODO/FIXME 检查项（D5）
 *
 * 字段说明：
 * - file_path: 文件路径
 * - line_number: 行号
 * - todo_type: 类型（"TODO" / "FIXME"）
 * - content: 内容
 * - has_implementation: 是否有对应实现
 */
export interface TodoItem {
  file_path: string;
  line_number: number;
  /** 类型："TODO" 或 "FIXME" */
  todo_type: "TODO" | "FIXME";
  content: string;
  has_implementation: boolean;
}

/**
 * 文档意图偏离项（D6）
 *
 * 字段说明：
 * - dimension: 偏离维度（如 "架构" / "功能范围" / "技术选型"）
 * - doc_intent: 文档意图
 * - code_reality: 代码实际情况
 * - severity: 严重程度（"high" / "medium" / "low"）
 */
export interface DeviationItem {
  dimension: string;
  doc_intent: string;
  code_reality: string;
  /** 严重程度："high" / "medium" / "low" */
  severity: "high" | "medium" | "low";
}

/**
 * 缺口清单项
 *
 * 字段说明：
 * - dimension: 所属维度（D1~D6）
 * - description: 缺口描述
 * - feature_id: 关联功能 ID（可选，空字符串表示无关联）
 * - priority: 优先级（P0 / P1 / P2）
 * - suggestion: 建议修复方式
 */
export interface GapItem {
  dimension: string;
  description: string;
  feature_id: string;
  /** 优先级："P0" / "P1" / "P2" */
  priority: "P0" | "P1" | "P2";
  suggestion: string;
}

/**
 * 一致性检查完整报告
 *
 * 字段说明：
 * - project_name: 项目名称
 * - check_time: 检查时间（ISO 格式）
 * - feature_checks: D1 功能完成度检查项列表
 * - integration_checks: D2 集成完整性检查项列表
 * - test_result: D3 测试正确性检查结果（null 表示未执行测试检查）
 * - acceptance_checks: D4 验收标准检查项列表
 * - todo_items: D5 TODO/FIXME 检查项列表
 * - deviation_items: D6 文档意图偏离项列表
 * - overall_passed: 最终判定（true=通过）
 * - gap_list: 缺口清单
 */
export interface ConsistencyReport {
  project_name: string;
  check_time: string;
  feature_checks: FeatureCheckItem[];
  integration_checks: IntegrationCheckItem[];
  test_result: TestCheckResult | null;
  acceptance_checks: AcceptanceCheckItem[];
  todo_items: TodoItem[];
  deviation_items: DeviationItem[];
  overall_passed: boolean;
  gap_list: GapItem[];
}

/**
 * 代码符号（函数/类/模块）
 *
 * 字段说明：
 * - name: 符号名称
 * - symbol_type: 类型（"function" / "class" / "module"）
 * - file_path: 文件路径（相对项目根目录）
 * - line_number: 行号
 * - language: 编程语言
 */
export interface CodeSymbol {
  name: string;
  /** 符号类型："function" / "class" / "module" */
  symbol_type: "function" | "class" | "module";
  file_path: string;
  line_number: number;
  language: string;
}

/**
 * 代码 import 关系
 *
 * 字段说明：
 * - source_file: 源文件路径（相对项目根目录）
 * - imported_module: 被导入的模块名
 * - import_type: 导入方式（"import" / "from" / "require" / "use"）
 * - line_number: 行号
 * - language: 编程语言
 */
export interface ImportRelation {
  source_file: string;
  imported_module: string;
  /** 导入方式："import" / "from" / "require" / "use" */
  import_type: string;
  line_number: number;
  language: string;
}

/**
 * 解析后的功能点（DocParser.parse_features 返回项）
 *
 * 字段说明：
 * - feature_id: 功能 ID
 * - feature_name: 功能名称
 * - feature_desc: 功能描述
 * - section: 文档来源标记（如 "prd.md §功能列表"）
 */
export interface ParsedFeature {
  feature_id: string;
  feature_name: string;
  feature_desc: string;
  section: string;
}

/**
 * 解析后的验收标准（DocParser.parse_acceptance_criteria 返回项）
 *
 * 字段说明：
 * - criteria_id: 验收标准 ID
 * - criteria_desc: 验收标准描述
 * - section: 文档来源标记
 */
export interface ParsedAcceptanceCriteria {
  criteria_id: string;
  criteria_desc: string;
  section: string;
}

/**
 * 解析后的集成关系（DocParser.parse_integration_relations 返回项）
 *
 * 字段说明：
 * - integration_desc: 集成关系描述（如 "模块A→模块B"）
 * - source: 源模块名
 * - target: 目标模块名
 * - section: 文档来源标记
 */
export interface ParsedIntegrationRelation {
  integration_desc: string;
  source: string;
  target: string;
  section: string;
}

// ============================================================================
// 第三部分：文档解析器 DocParser
// ============================================================================

/**
 * Markdown 文档解析器
 *
 * 职责：
 * 1. 解析功能列表表格（F-xxx 格式）
 * 2. 解析验收标准（AC-xxx 格式）
 * 3. 解析模块集成关系（A→B / A 依赖 B 格式）
 * 4. 提取文档章节标题用于来源定位
 *
 * 所有方法均为静态方法，无实例状态，线程安全。
 */
export class DocParser {
  // 功能 ID 正则：F-001 / F001 / F_001
  static readonly _FEATURE_ID_PATTERN: RegExp = /\bF[-_]?\d{3,}\b/i;
  // 验收标准 ID 正则：AC-001 / AC001
  static readonly _ACCEPTANCE_ID_PATTERN: RegExp = /\bAC[-_]?\d{3,}\b/i;
  // 模块依赖正则：A→B / A->B / A 依赖 B / A 调用 B / A 模块 依赖 B 模块
  // 支持模块名后跟可选的 "模块" 后缀，避免将 "模块" 误匹配为源模块名
  static readonly _DEPENDENCY_PATTERN: RegExp =
    /([\w\u4e00-\u9fff]+)(?:\s*模块)?\s*(?:→|->|依赖|调用|引用|import[s]?)\s*([\w\u4e00-\u9fff]+)(?:\s*模块)?/;
  // Markdown 表格行正则
  static readonly _TABLE_ROW_PATTERN: RegExp = /^\|(.+)\|$/m;
  // 章节标题正则
  static readonly _SECTION_PATTERN: RegExp = /^(#{1,6})\s+(.+)$/m;
  // 表格分隔行正则（如 | --- | --- |）
  static readonly _SEPARATOR_PATTERN: RegExp = /^[-:\s]+$/;

  /**
   * 解析文档中的功能列表表格
   *
   * 支持的表格格式：
   * | 功能ID | 功能名称 | 功能描述 | 优先级 | 所属模块 | 状态 |
   * | F-001 | 登录 | 用户登录功能 | P0 | auth | 待实现 |
   *
   * 如果表格解析未找到功能，则从全文提取功能 ID 作为兜底。
   *
   * @param content 文档内容
   * @param docName 文档名称（用于来源标记）
   * @returns 功能列表
   */
  static parseFeatures(content: string, docName: string = ""): ParsedFeature[] {
    const features: ParsedFeature[] = [];
    const lines = content.split("\n");
    // 当前章节标题（用于来源定位）
    let currentSection = "";
    // 是否在功能表格内
    let inFeatureTable = false;
    // 表头列索引映射
    let colMap: Record<string, number> = {};

    for (const line of lines) {
      // 检测章节标题
      const sectionMatch = regexMatch(DocParser._SECTION_PATTERN, line);
      if (sectionMatch) {
        currentSection = sectionMatch[2].trim();
        inFeatureTable = false;
        continue;
      }

      // 检测表格行
      if (!line.trim().startsWith("|")) {
        inFeatureTable = false;
        continue;
      }

      const cells = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      if (cells.length === 0) {
        continue;
      }

      // 检测表头行（包含 "功能" 和 "ID" 或 "名称" 关键词）
      const headerText = cells.join(" ").toLowerCase();
      if (
        (headerText.includes("功能") || headerText.includes("feature")) &&
        (headerText.includes("id") || headerText.includes("编号") || headerText.includes("标识"))
      ) {
        inFeatureTable = true;
        colMap = {};
        for (let idx = 0; idx < cells.length; idx++) {
          const cell = cells[idx];
          const cellLower = cell.toLowerCase();
          if (cellLower.includes("id") || cellLower.includes("编号") || cellLower.includes("标识")) {
            colMap["id"] = idx;
          } else if (cellLower.includes("名称") || cellLower.includes("name")) {
            colMap["name"] = idx;
          } else if (cellLower.includes("描述") || cellLower.includes("desc")) {
            colMap["desc"] = idx;
          } else if (cellLower.includes("优先") || cellLower.includes("priority")) {
            colMap["priority"] = idx;
          } else if (cellLower.includes("模块") || cellLower.includes("module")) {
            colMap["module"] = idx;
          } else if (cellLower.includes("状态") || cellLower.includes("status")) {
            colMap["status"] = idx;
          }
        }
        continue;
      }

      // 跳过分隔行（| --- | --- |）
      if (cells.every((c) => DocParser._SEPARATOR_PATTERN.test(c))) {
        continue;
      }

      // 解析功能行
      if (inFeatureTable && Object.keys(colMap).length > 0) {
        const featureId = colMap["id"] !== undefined && colMap["id"] < cells.length ? cells[colMap["id"]] : "";
        // 检查是否是有效的功能 ID
        if (!regexSearch(DocParser._FEATURE_ID_PATTERN, featureId)) {
          continue;
        }
        const featureName = colMap["name"] !== undefined && colMap["name"] < cells.length ? cells[colMap["name"]] : "";
        const featureDesc = colMap["desc"] !== undefined && colMap["desc"] < cells.length ? cells[colMap["desc"]] : "";
        // 构建来源标记
        const sectionRef = currentSection ? `${docName} §${currentSection}` : docName;
        features.push({
          feature_id: featureId.trim(),
          feature_name: featureName.trim(),
          feature_desc: featureDesc.trim(),
          section: sectionRef,
        });
      }
    }

    // 如果表格解析未找到功能，尝试从全文提取功能 ID
    if (features.length === 0) {
      for (const match of finditer(DocParser._FEATURE_ID_PATTERN, content)) {
        const fid = match[0].toUpperCase();
        // 提取上下文作为名称
        const matchStart = match.index ?? 0;
        const matchEnd = matchStart + match[0].length;
        let lineStart = content.lastIndexOf("\n", matchStart - 1) + 1;
        if (lineStart < 0) lineStart = 0;
        let lineEnd = content.indexOf("\n", matchEnd);
        if (lineEnd < 0) lineEnd = content.length;
        const contextLine = content.slice(lineStart, lineEnd).trim();
        // 去掉功能 ID 本身，剩余作为名称
        const name = contextLine
          .replace(match[0], "")
          .trim()
          .replace(/^[-|：:\s]+/, "")
          .replace(/[-|：:\s]+$/, "");
        features.push({
          feature_id: fid,
          feature_name: name.slice(0, 100) || fid,
          feature_desc: "",
          section: docName,
        });
      }
    }

    return features;
  }

  /**
   * 解析文档中的验收标准
   *
   * 支持格式：
   * 1. 表格：| AC-001 | 描述 | ... |
   * 2. 列表：- AC-001: 描述
   * 3. 章节内容："验收标准" 章节下的条目
   *
   * @param content 文档内容
   * @param docName 文档名称
   * @returns 验收标准列表
   */
  static parseAcceptanceCriteria(content: string, docName: string = ""): ParsedAcceptanceCriteria[] {
    const criteria: ParsedAcceptanceCriteria[] = [];
    const lines = content.split("\n");
    let currentSection = "";
    let inAcceptanceSection = false;
    let inAcTable = false;
    let colMap: Record<string, number> = {};

    for (const line of lines) {
      const sectionMatch = regexMatch(DocParser._SECTION_PATTERN, line);
      if (sectionMatch) {
        currentSection = sectionMatch[2].trim();
        // 检测"验收标准"章节
        inAcceptanceSection = currentSection.includes("验收") || currentSection.toLowerCase().includes("acceptance");
        inAcTable = false;
        continue;
      }

      // 表格行解析
      if (line.trim().startsWith("|")) {
        const cells = line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        const headerText = cells.join(" ").toLowerCase();
        // 检测验收标准表头
        // 在"验收标准"章节内，或表头包含"验收"/"验证"/"acceptance"关键词
        if (
          (inAcceptanceSection ||
            headerText.includes("验收") ||
            headerText.includes("acceptance") ||
            headerText.includes("验证")) &&
          (headerText.includes("id") || headerText.includes("编号"))
        ) {
          inAcTable = true;
          colMap = {};
          for (let idx = 0; idx < cells.length; idx++) {
            const cell = cells[idx];
            const cellLower = cell.toLowerCase();
            if (cellLower.includes("id") || cellLower.includes("编号")) {
              colMap["id"] = idx;
            } else if (cellLower.includes("描述") || cellLower.includes("desc") || cellLower.includes("标准")) {
              colMap["desc"] = idx;
            } else if (cellLower.includes("验证") || cellLower.includes("verify")) {
              colMap["verify"] = idx;
            }
          }
          continue;
        }

        // 跳过分隔行
        if (cells.every((c) => DocParser._SEPARATOR_PATTERN.test(c))) {
          continue;
        }

        // 解析验收标准表格行
        if (inAcTable && Object.keys(colMap).length > 0) {
          const acId = colMap["id"] !== undefined && colMap["id"] < cells.length ? cells[colMap["id"]] : "";
          if (regexSearch(DocParser._ACCEPTANCE_ID_PATTERN, acId)) {
            const acDesc = colMap["desc"] !== undefined && colMap["desc"] < cells.length ? cells[colMap["desc"]] : "";
            const sectionRef = currentSection ? `${docName} §${currentSection}` : docName;
            criteria.push({
              criteria_id: acId.trim(),
              criteria_desc: acDesc.trim(),
              section: sectionRef,
            });
          }
        }
        continue;
      }

      // 列表项解析：- AC-001: 描述
      // 全局搜索列表项中的 AC ID（in_acceptance_section or True 始终为 true）
      const listMatch = regexMatch(/^\s*[-*]\s*(AC[-_]?\d{3,}\s*[:：]?\s*.+)/i, line);
      if (listMatch) {
        const text = listMatch[1].trim();
        const idMatch = regexSearch(DocParser._ACCEPTANCE_ID_PATTERN, text);
        if (idMatch) {
          const acId = idMatch[0].toUpperCase();
          const acDesc = text
            .slice(idMatch.index! + idMatch[0].length)
            .trim()
            .replace(/^[:：\s]+/, "");
          const sectionRef = currentSection ? `${docName} §${currentSection}` : docName;
          // 去重
          if (!criteria.some((c) => c.criteria_id === acId)) {
            criteria.push({
              criteria_id: acId,
              criteria_desc: acDesc,
              section: sectionRef,
            });
          }
        }
      }
    }

    return criteria;
  }

  /**
   * 解析文档中的模块集成关系
   *
   * 支持格式：
   * 1. A→B / A->B
   * 2. A 依赖 B / A 调用 B / A 引用 B
   * 3. A imports B
   *
   * @param content 文档内容
   * @param docName 文档名称
   * @returns 集成关系列表
   */
  static parseIntegrationRelations(content: string, docName: string = ""): ParsedIntegrationRelation[] {
    const relations: ParsedIntegrationRelation[] = [];
    const lines = content.split("\n");
    let currentSection = "";

    for (const line of lines) {
      const sectionMatch = regexMatch(DocParser._SECTION_PATTERN, line);
      if (sectionMatch) {
        currentSection = sectionMatch[2].trim();
        continue;
      }

      // 跳过代码块内的内容
      if (line.trim().startsWith("```")) {
        continue;
      }

      // 查找依赖关系
      for (const match of finditer(DocParser._DEPENDENCY_PATTERN, line)) {
        const sourceMod = match[1].trim();
        const targetMod = match[2].trim();
        // 过滤掉太短的或非模块名的匹配
        if (sourceMod.length < 2 || targetMod.length < 2) {
          continue;
        }
        // 过滤掉常见非模块词
        const skipWords = new Set(["如果", "则", "否则", "当", "在", "通过", "使用", "基于"]);
        if (skipWords.has(sourceMod) || skipWords.has(targetMod)) {
          continue;
        }
        const desc = `${sourceMod}→${targetMod}`;
        const sectionRef = currentSection ? `${docName} §${currentSection}` : docName;
        // 去重
        if (!relations.some((r) => r.integration_desc === desc)) {
          relations.push({
            integration_desc: desc,
            source: sourceMod,
            target: targetMod,
            section: sectionRef,
          });
        }
      }
    }

    return relations;
  }
}

// ============================================================================
// 第四部分：代码扫描器 CodeScanner
// ============================================================================

/**
 * 多语言代码扫描器
 *
 * 职责：
 * 1. 扫描源码中的函数、类定义
 * 2. 扫描 import / require / use 语句
 * 3. 扫描 TODO / FIXME 注释
 * 4. 支持多种编程语言
 *
 * 支持语言：Python / JavaScript / TypeScript / Java / Go / Rust
 *
 * 所有方法均为静态方法，无实例状态。
 */
export class CodeScanner {
  /** 支持的源码文件扩展名 → 语言映射 */
  static readonly _SOURCE_EXTENSIONS: Record<string, string> = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".jsx": "javascript",
    ".tsx": "typescript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
  };

  /** 跳过的目录名集合 */
  static readonly _SKIP_DIRS: Set<string> = new Set([
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
    ".gradle",
    ".idea",
    ".vscode",
  ]);

  /** 各语言函数定义正则（使用命名组 name） */
  static readonly _FUNCTION_PATTERNS: Record<string, RegExp> = {
    python: /^(?<indent>[ \t]*)def\s+(?<name>\w+)\s*\(/m,
    javascript: /^(?<indent>[ \t]*)(?:export\s+)?(?:async\s+)?function\s+(?<name>\w+)\s*\(/m,
    typescript: /^(?<indent>[ \t]*)(?:export\s+)?(?:async\s+)?function\s+(?<name>\w+)\s*\(/m,
    java: /^(?<indent>[ \t]*)(?:public|private|protected|static|final|abstract|synchronized|\s)*(?:[\w<>[\]]+\s+)*(?<name>\w+)\s*\([^)]*\)\s*(?:\{|=>)/m,
    go: /^func\s+(?:\([^)]*\)\s+)?(?<name>\w+)\s*\(/m,
    rust: /^(?<indent>[ \t]*)(?:pub\s+)?(?:async\s+)?fn\s+(?<name>\w+)\s*\(/m,
  };

  /** 各语言类定义正则（使用命名组 name） */
  static readonly _CLASS_PATTERNS: Record<string, RegExp> = {
    python: /^class\s+(?<name>\w+)/m,
    javascript: /(?:export\s+)?class\s+(?<name>\w+)/m,
    typescript: /(?:export\s+)?(?:abstract\s+)?class\s+(?<name>\w+)/m,
    java: /(?:public|private|protected|static|final|abstract|\s)*class\s+(?<name>\w+)/m,
    go: /type\s+(?<name>\w+)\s+struct/m,
    rust: /(?:pub\s+)?struct\s+(?<name>\w+)/m,
  };

  /** 各语言 import 正则列表（使用命名组 module） */
  static readonly _IMPORT_PATTERNS: Record<string, RegExp[]> = {
    python: [/^import\s+(?<module>[\w.]+)/m, /^from\s+(?<module>[\w.]+)\s+import/m],
    javascript: [
      /import\s+.*\s+from\s+['"](?<module>[\w./@-]+)['"]/m,
      /require\s*\(\s*['"](?<module>[\w./@-]+)['"]\s*\)/m,
    ],
    typescript: [/import\s+.*\s+from\s+['"](?<module>[\w./@-]+)['"]/m],
    java: [/^import\s+(?<module>[\w.]+);/m],
    go: [/"(?<module>[\w./]+)"/m],
    rust: [/use\s+(?<module>[\w:]+)/m],
  };

  /** TODO/FIXME 正则（# 注释风格，Python/Ruby/Shell 等） */
  static readonly _TODO_PATTERN: RegExp = /#\s*(TODO|FIXME)\s*[:：]?\s*(.+)/i;
  /** TODO/FIXME 正则（// 注释风格，JS/TS/Java/C/C++/Go/Rust 等） */
  static readonly _TODO_PATTERN_MULTI: RegExp = /\/\/\s*(TODO|FIXME)\s*[:：]?\s*(.+)/i;
  /** TODO/FIXME 正则（* 注释风格，块注释内） */
  static readonly _TODO_PATTERN_BLOCK: RegExp = /\*\s*(TODO|FIXME)\s*[:：]?\s*(.+)/i;

  /** 最大文件大小（1MB），超过则跳过扫描 */
  static readonly _MAX_FILE_SIZE: number = 1024 * 1024;

  /**
   * 扫描项目全部源码
   *
   * 遍历项目根目录下所有支持的源码文件，提取函数/类定义、import 语句、TODO/FIXME 注释。
   * 跳过 _SKIP_DIRS 中的目录，跳过超过 _MAX_FILE_SIZE 的文件。
   *
   * @param projectRoot 项目根目录绝对路径
   * @returns 三元组：[代码符号列表, import 关系列表, TODO/FIXME 列表]
   */
  static scanProject(projectRoot: string): [CodeSymbol[], ImportRelation[], TodoItem[]] {
    const symbols: CodeSymbol[] = [];
    const imports: ImportRelation[] = [];
    const todos: TodoItem[] = [];

    if (!fs.existsSync(projectRoot)) {
      return [symbols, imports, todos];
    }

    for (const filePath of CodeScanner._iterSourceFiles(projectRoot)) {
      const ext = path.extname(filePath).toLowerCase();
      const language = CodeScanner._SOURCE_EXTENSIONS[ext] ?? "";
      if (!language) {
        continue;
      }
      let content: string;
      try {
        // 跳过过大文件
        const stat = fs.statSync(filePath);
        if (stat.size > CodeScanner._MAX_FILE_SIZE) {
          continue;
        }
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        // 文件读取失败（权限/编码等），跳过
        continue;
      }

      // 计算相对项目根目录的路径
      const relPath = path.relative(projectRoot, filePath);

      // 扫描函数
      for (const symbol of CodeScanner._scanFunctions(content, relPath, language)) {
        symbols.push(symbol);
      }
      // 扫描类
      for (const symbol of CodeScanner._scanClasses(content, relPath, language)) {
        symbols.push(symbol);
      }
      // 扫描 import
      for (const imp of CodeScanner._scanImports(content, relPath, language)) {
        imports.push(imp);
      }
      // 扫描 TODO/FIXME
      for (const todo of CodeScanner._scanTodos(content, relPath)) {
        todos.push(todo);
      }
    }

    return [symbols, imports, todos];
  }

  /**
   * 遍历项目中的源码文件，跳过排除目录
   *
   * @param root 项目根目录
   * @returns 源码文件绝对路径数组
   */
  static _iterSourceFiles(root: string): string[] {
    const allFiles = walkFiles(root, CodeScanner._SKIP_DIRS);
    // 仅保留支持的扩展名
    return allFiles.filter((p) => {
      const ext = path.extname(p).toLowerCase();
      return ext in CodeScanner._SOURCE_EXTENSIONS;
    });
  }

  /**
   * 扫描函数定义
   *
   * 根据语言的函数定义正则，提取函数名和行号。
   *
   * @param content 文件内容
   * @param filePath 文件相对路径
   * @param language 编程语言
   * @returns 代码符号列表（symbol_type 为 "function"）
   */
  static _scanFunctions(content: string, filePath: string, language: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const pattern = CodeScanner._FUNCTION_PATTERNS[language];
    if (!pattern) {
      return symbols;
    }
    for (const match of finditer(pattern, content)) {
      const name = match.groups!.name;
      // 计算行号
      const lineNum = lineNumberAt(content, match.index!);
      symbols.push({
        name: name,
        symbol_type: "function",
        file_path: filePath,
        line_number: lineNum,
        language: language,
      });
    }
    return symbols;
  }

  /**
   * 扫描类定义
   *
   * 根据语言的类定义正则，提取类名和行号。
   *
   * @param content 文件内容
   * @param filePath 文件相对路径
   * @param language 编程语言
   * @returns 代码符号列表（symbol_type 为 "class"）
   */
  static _scanClasses(content: string, filePath: string, language: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const pattern = CodeScanner._CLASS_PATTERNS[language];
    if (!pattern) {
      return symbols;
    }
    for (const match of finditer(pattern, content)) {
      const name = match.groups!.name;
      const lineNum = lineNumberAt(content, match.index!);
      symbols.push({
        name: name,
        symbol_type: "class",
        file_path: filePath,
        line_number: lineNum,
        language: language,
      });
    }
    return symbols;
  }

  /**
   * 扫描 import 语句
   *
   * 根据语言的 import 正则列表，提取导入的模块名和行号。
   *
   * @param content 文件内容
   * @param filePath 文件相对路径
   * @param language 编程语言
   * @returns import 关系列表
   */
  static _scanImports(content: string, filePath: string, language: string): ImportRelation[] {
    const imports: ImportRelation[] = [];
    const patterns = CodeScanner._IMPORT_PATTERNS[language] ?? [];
    for (const pattern of patterns) {
      for (const match of finditer(pattern, content)) {
        const module = match.groups!.module;
        const lineNum = lineNumberAt(content, match.index!);
        imports.push({
          source_file: filePath,
          imported_module: module,
          import_type: "import",
          line_number: lineNum,
          language: language,
        });
      }
    }
    return imports;
  }

  /**
   * 扫描 TODO/FIXME 注释
   *
   * 使用三种正则（# 风格、// 风格、* 块注释风格）扫描文件，
   * 并检查每个 TODO/FIXME 是否有对应的代码实现。
   * 对同一行被多个正则匹配的情况进行去重。
   *
   * @param content 文件内容
   * @param filePath 文件相对路径
   * @returns TODO/FIXME 检查项列表（已去重）
   */
  static _scanTodos(content: string, filePath: string): TodoItem[] {
    const todos: TodoItem[] = [];
    const patterns = [CodeScanner._TODO_PATTERN, CodeScanner._TODO_PATTERN_MULTI, CodeScanner._TODO_PATTERN_BLOCK];
    for (const pattern of patterns) {
      for (const match of finditer(pattern, content)) {
        const todoType = match[1].toUpperCase() as "TODO" | "FIXME";
        const contentText = match[2].trim();
        const lineNum = lineNumberAt(content, match.index!);
        // 检查是否有对应实现：搜索同文件中是否有与 TODO 内容相关的函数/类
        const hasImpl = CodeScanner._checkTodoImplementation(content, contentText);
        todos.push({
          file_path: filePath,
          line_number: lineNum,
          todo_type: todoType,
          content: contentText,
          has_implementation: hasImpl,
        });
      }
    }
    // 去重（同一行可能被多个正则匹配）
    const seen = new Set<string>();
    const uniqueTodos: TodoItem[] = [];
    for (const todo of todos) {
      const key = `${todo.file_path}|${todo.line_number}|${todo.content.slice(0, 50)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTodos.push(todo);
      }
    }
    return uniqueTodos;
  }

  /**
   * 检查 TODO/FIXME 是否有对应实现
   *
   * 策略：
   * 1. 从 TODO 内容中提取可能的函数名/类名关键词（英文单词 + 中文词语）
   * 2. 在同文件中搜索是否有对应的 def/class/function/fn/func 定义
   * 3. 如果找到，认为有对应实现
   *
   * @param content 文件内容
   * @param todoContent TODO/FIXME 内容
   * @returns 是否有对应实现
   */
  static _checkTodoImplementation(content: string, todoContent: string): boolean {
    // 提取关键词：中文 + 英文单词
    const keywords: string[] = [];
    for (const m of finditer(/[\w\u4e00-\u9fff]+/, todoContent)) {
      keywords.push(m[0]);
    }
    // 过滤掉太短的关键词
    const filteredKeywords = keywords.filter((kw) => kw.length >= 3);
    if (filteredKeywords.length === 0) {
      return false;
    }

    // 搜索函数/类定义
    const implPatterns: RegExp[] = [
      /^\s*def\s+(\w+)/m,
      /^\s*function\s+(\w+)/m,
      /^\s*class\s+(\w+)/m,
      /^\s*fn\s+(\w+)/m,
      /^\s*func\s+(\w+)/m,
    ];

    const definedNames = new Set<string>();
    for (const pattern of implPatterns) {
      for (const match of finditer(pattern, content)) {
        definedNames.add(match[1].toLowerCase());
      }
    }

    // 检查关键词是否在已定义名称中出现
    for (const kw of filteredKeywords) {
      const kwLower = kw.toLowerCase();
      for (const name of definedNames) {
        if (kwLower.includes(name) || name.includes(kwLower)) {
          return true;
        }
      }
    }
    return false;
  }
}

// ============================================================================
// 第五部分：核心检查器 DocCodeConsistencyChecker
// ============================================================================

/**
 * 文档对照代码一致性检查器
 *
 * 职责：
 * 1. 解析文档（PRD/SPEC/架构/测试计划）中的功能点、验收标准、集成关系
 * 2. 扫描代码中的函数、类、模块、API、import 依赖
 * 3. 逐项对照检查六大维度（D1~D6）
 * 4. 生成结构化审查报告
 *
 * 使用方式：
 * ```typescript
 * const checker = new DocCodeConsistencyChecker(
 *     "/path/to/project",
 *     { prd: "prd.md", architecture: "arch.md" },
 *     "python3 -m pytest",
 *     600.0
 * );
 * const report = checker.checkAll();
 * const markdownReport = checker.generateReport(report);
 * ```
 */
export class DocCodeConsistencyChecker {
  /** 项目根目录绝对路径 */
  private _projectRoot: string;
  /** 文档路径字典（键为文档类型，值为文档文件路径） */
  private _docPaths: Record<string, string>;
  /** 测试执行命令（空字符串则跳过测试检查） */
  private _testCommand: string;
  /** 测试执行超时时间（秒） */
  private _testTimeout: number;

  /** 缓存：代码扫描结果 - 代码符号列表 */
  private _symbols: CodeSymbol[];
  /** 缓存：代码扫描结果 - import 关系列表 */
  private _imports: ImportRelation[];
  /** 缓存：代码扫描结果 - TODO/FIXME 列表 */
  private _todos: TodoItem[];
  /** 缓存：代码是否已扫描 */
  private _codeScanned: boolean;

  /** 缓存：文档解析结果 - 功能点列表 */
  private _features: ParsedFeature[];
  /** 缓存：文档解析结果 - 验收标准列表 */
  private _acceptanceCriteria: ParsedAcceptanceCriteria[];
  /** 缓存：文档解析结果 - 集成关系列表 */
  private _integrationRelations: ParsedIntegrationRelation[];
  /** 缓存：文档是否已解析 */
  private _docsParsed: boolean;

  /**
   * 构造检查器
   *
   * @param projectRoot 项目根目录路径
   * @param docPaths 文档路径字典，键为文档类型（prd/architecture/spec/test_plan），
   *                 值为文档文件路径。如果为 null/undefined，则不解析文档
   * @param testCommand 测试执行命令（空字符串则跳过测试检查）
   * @param testTimeoutSec 测试执行超时时间（秒，最小 10 秒）
   */
  constructor(
    projectRoot: string,
    docPaths: Record<string, string> | null = null,
    testCommand: string = "",
    testTimeoutSec: number = 600.0
  ) {
    // 解析为绝对路径
    this._projectRoot = path.resolve(projectRoot);
    this._docPaths = docPaths ?? {};
    this._testCommand = testCommand;
    this._testTimeout = Math.max(10.0, testTimeoutSec);

    // 初始化缓存：代码扫描结果
    this._symbols = [];
    this._imports = [];
    this._todos = [];
    this._codeScanned = false;

    // 初始化缓存：文档解析结果
    this._features = [];
    this._acceptanceCriteria = [];
    this._integrationRelations = [];
    this._docsParsed = false;
  }

  /**
   * 执行全部六大维度检查，返回完整报告
   *
   * 执行流程：
   * 1. 解析文档（功能点、验收标准、集成关系）
   * 2. 扫描代码（符号、import、TODO/FIXME）
   * 3. 执行六大维度检查（D1~D6）
   * 4. 构建缺口清单
   * 5. 判定最终结果（缺口清单为空则通过）
   * 6. 构建并返回完整报告
   *
   * @returns 一致性检查完整报告
   */
  checkAll(): ConsistencyReport {
    // 1. 解析文档
    this._parseDocuments();
    // 2. 扫描代码
    this._scanCode();
    // 3. 执行六大维度检查
    const featureChecks = this.checkFeatureCompleteness();
    const integrationChecks = this.checkIntegrationCompleteness();
    const testResult = this.checkTestCorrectness();
    const acceptanceChecks = this.checkAcceptanceCriteria();
    const todoItems = this.checkTodoFixme();
    const deviationItems = this.checkDocIntentAlignment();
    // 4. 构建缺口清单
    const gapList = this._buildGapList(
      featureChecks,
      integrationChecks,
      testResult,
      acceptanceChecks,
      todoItems,
      deviationItems
    );
    // 5. 判定最终结果
    const overallPassed = gapList.length === 0;
    // 6. 构建报告
    const report: ConsistencyReport = {
      project_name: path.basename(this._projectRoot),
      check_time: new Date().toISOString(),
      feature_checks: featureChecks,
      integration_checks: integrationChecks,
      test_result: testResult,
      acceptance_checks: acceptanceChecks,
      todo_items: todoItems,
      deviation_items: deviationItems,
      overall_passed: overallPassed,
      gap_list: gapList,
    };
    return report;
  }

  // ----------------------------------------------------------------
  // D1: 功能完成度检查
  // ----------------------------------------------------------------

  /**
   * D1: 功能完成度检查
   *
   * 将文档中的每个功能点与代码符号进行匹配，判断功能是否已实现。
   *
   * 匹配策略（按优先级）：
   * 1. 功能 ID 在符号名中出现 → 已实现
   * 2. 功能名称的英文关键词在函数名/类名中出现 → 已实现
   * 3. 功能名称的关键词在文件路径中出现 → 已实现
   * 4. 以上均不满足 → 未实现
   *
   * @returns 功能完成度检查项列表
   */
  checkFeatureCompleteness(): FeatureCheckItem[] {
    if (!this._docsParsed) {
      this._parseDocuments();
    }
    if (!this._codeScanned) {
      this._scanCode();
    }

    const results: FeatureCheckItem[] = [];
    for (const feature of this._features) {
      const fid = feature.feature_id;
      const fname = feature.feature_name;
      const fdesc = feature.feature_desc;
      const section = feature.section;

      // 在代码符号中搜索匹配
      let codeLocation = "";
      let evidence = "";
      const status: "implemented" | "missing" = "missing";
      const matchedSymbol = this._matchFeatureToCode(fname, fdesc, fid);
      if (matchedSymbol) {
        codeLocation = `${matchedSymbol.file_path}:${matchedSymbol.name}()`;
        const symbolTypeCn = matchedSymbol.symbol_type === "function" ? "函数" : "类";
        evidence = `在 ${matchedSymbol.file_path} 中找到${symbolTypeCn} ${matchedSymbol.name}（行 ${matchedSymbol.line_number}）`;
        results.push({
          feature_id: fid,
          feature_name: fname,
          feature_desc: fdesc,
          doc_source: section,
          code_location: codeLocation,
          status: "implemented",
          evidence: evidence,
        });
      } else {
        results.push({
          feature_id: fid,
          feature_name: fname,
          feature_desc: fdesc,
          doc_source: section,
          code_location: codeLocation,
          status: "missing",
          evidence: evidence,
        });
      }
    }
    return results;
  }

  /**
   * 将功能点匹配到代码符号
   *
   * 匹配策略（按优先级）：
   * 1. 功能 ID（去除 - 和 _ 后）在符号名中出现
   * 2. 功能名称的英文关键词（长度≥3）在函数名/类名中出现
   * 3. 功能名称的关键词（长度≥4）在文件路径中出现
   *
   * @param featureName 功能名称
   * @param featureDesc 功能描述
   * @param featureId 功能 ID
   * @returns 匹配到的代码符号，null 表示未匹配
   */
  private _matchFeatureToCode(featureName: string, featureDesc: string, featureId: string): CodeSymbol | null {
    // 提取功能名称中的关键词
    const keywords = this._extractKeywords(featureName, featureDesc);
    if (keywords.length === 0) {
      return null;
    }

    // 策略1: 功能 ID 在符号名中出现
    const fidLower = featureId.toLowerCase().replace(/[-_]/g, "");
    for (const symbol of this._symbols) {
      if (symbol.name.toLowerCase().includes(fidLower)) {
        return symbol;
      }
    }

    // 策略2: 关键词在函数名/类名中出现
    for (const symbol of this._symbols) {
      const symbolNameLower = symbol.name.toLowerCase();
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (kwLower.length >= 3 && symbolNameLower.includes(kwLower)) {
          return symbol;
        }
      }
    }

    // 策略3: 关键词在文件路径中出现
    for (const symbol of this._symbols) {
      const filePathLower = symbol.file_path.toLowerCase();
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (kwLower.length >= 4 && filePathLower.includes(kwLower)) {
          return symbol;
        }
      }
    }

    return null;
  }

  /**
   * 从文本中提取关键词（英文单词 + 中文词语）
   *
   * 英文单词：以字母开头，长度≥3 的字母数字下划线序列
   * 中文词语：2~6 个连续中文字符
   *
   * @param texts 一个或多个文本
   * @returns 去重后的关键词列表
   */
  private _extractKeywords(...texts: string[]): string[] {
    const keywords = new Set<string>();
    for (const text of texts) {
      if (!text) {
        continue;
      }
      // 提取英文单词
      for (const m of finditer(/[a-zA-Z][a-zA-Z0-9_]+/, text)) {
        const word = m[0];
        if (word.length >= 3) {
          keywords.add(word);
        }
      }
      // 提取中文词语（2~6个连续中文字符）
      for (const m of finditer(/[\u4e00-\u9fff]{2,6}/, text)) {
        keywords.add(m[0]);
      }
    }
    return Array.from(keywords);
  }

  // ----------------------------------------------------------------
  // D2: 集成完整性检查
  // ----------------------------------------------------------------

  /**
   * D2: 集成完整性检查
   *
   * 将文档中定义的模块集成关系与代码中的 import 语句进行匹配，
   * 判断集成是否已实现。
   *
   * @returns 集成完整性检查项列表
   */
  checkIntegrationCompleteness(): IntegrationCheckItem[] {
    if (!this._docsParsed) {
      this._parseDocuments();
    }
    if (!this._codeScanned) {
      this._scanCode();
    }

    const results: IntegrationCheckItem[] = [];
    for (const relation of this._integrationRelations) {
      const desc = relation.integration_desc;
      const sourceMod = relation.source;
      const targetMod = relation.target;
      const section = relation.section;

      // 在 import 关系中搜索匹配
      let codeLocation = "";
      const matchedImport = this._matchIntegrationToImports(sourceMod, targetMod);
      if (matchedImport) {
        codeLocation = `${matchedImport.source_file}: import ${matchedImport.imported_module}`;
        results.push({
          integration_desc: desc,
          doc_source: section,
          code_location: codeLocation,
          status: "connected",
        });
      } else {
        results.push({
          integration_desc: desc,
          doc_source: section,
          code_location: codeLocation,
          status: "missing",
        });
      }
    }
    return results;
  }

  /**
   * 将集成关系匹配到代码 import
   *
   * 匹配策略（按优先级）：
   * 1. target 在 import 模块名中出现，且 source 在源文件路径中出现
   * 2. 仅 target 在 import 模块名中出现
   * 3. target 在源文件路径中出现（模块作为文件存在）
   *
   * @param sourceMod 源模块名
   * @param targetMod 目标模块名
   * @returns 匹配到的 import 关系，null 表示未匹配
   */
  private _matchIntegrationToImports(sourceMod: string, targetMod: string): ImportRelation | null {
    const targetLower = targetMod.toLowerCase();
    const sourceLower = sourceMod.toLowerCase();

    // 策略1: target 在 import 模块名中出现，且 source 在文件路径中出现
    for (const imp of this._imports) {
      const importedLower = imp.imported_module.toLowerCase();
      if (importedLower.includes(targetLower) && imp.source_file.toLowerCase().includes(sourceLower)) {
        return imp;
      }
    }

    // 策略2: 仅 target 在 import 模块名中出现
    for (const imp of this._imports) {
      const importedLower = imp.imported_module.toLowerCase();
      if (importedLower.includes(targetLower)) {
        return imp;
      }
    }

    // 策略3: target 在文件路径中出现（模块作为文件存在）
    for (const imp of this._imports) {
      if (imp.source_file.toLowerCase().includes(targetLower)) {
        return imp;
      }
    }

    return null;
  }

  // ----------------------------------------------------------------
  // D3: 测试正确性检查
  // ----------------------------------------------------------------

  /**
   * D3: 测试正确性检查
   *
   * 执行测试命令，解析通过/失败/跳过数量，
   * 并检查测试是否覆盖文档中定义的功能。
   *
   * 测试结果解析：支持 pytest / unittest / mocha / jest 等格式的 summary 行。
   * 功能覆盖检查：在测试输出和测试文件中搜索功能 ID 或功能名称。
   *
   * @returns 测试正确性检查结果
   */
  checkTestCorrectness(): TestCheckResult {
    if (!this._testCommand) {
      return {
        test_command: "(未配置测试命令)",
        passed: 0,
        failed: 0,
        skipped: 0,
        covered_features: [],
        uncovered_features: [],
        test_output_tail: "跳过测试执行：未配置测试命令",
        duration_sec: 0.0,
      };
    }
    if (!this._docsParsed) {
      this._parseDocuments();
    }

    // 执行测试命令
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let testOutput = "";
    let duration = 0.0;

    try {
      const startTime = Date.now();
      // 使用 spawnSync 执行测试命令（shell 模式，等价于 Python 的 subprocess.run shell=True）
      const proc = childProcess.spawnSync(this._testCommand, {
        shell: true,
        cwd: this._projectRoot,
        encoding: "utf-8",
        timeout: this._testTimeout * 1000, // 转换为毫秒
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      duration = (Date.now() - startTime) / 1000; // 转换为秒

      // 检查是否超时（spawnSync 超时后 signal 为 SIGTERM）
      if (proc.error) {
        const errnoErr = proc.error as NodeJS.ErrnoException;
        if (errnoErr.code === "ETIMEDOUT") {
          return {
            test_command: this._testCommand,
            passed: 0,
            failed: 0,
            skipped: 0,
            covered_features: [],
            uncovered_features: [],
            test_output_tail: `测试超时（>${this._testTimeout}s）`,
            duration_sec: this._testTimeout,
          };
        }
        // 其他执行错误
        return {
          test_command: this._testCommand,
          passed: 0,
          failed: 0,
          skipped: 0,
          covered_features: [],
          uncovered_features: [],
          test_output_tail: `测试执行失败: ${proc.error.message}`,
          duration_sec: 0.0,
        };
      }

      const stdout = proc.stdout ?? "";
      const stderr = proc.stderr ?? "";
      testOutput = stdout + "\n" + stderr;
      // 解析测试结果：分别使用独立正则匹配 passed / failed / skipped
      // 支持 pytest / unittest / mocha / jest 等格式的 summary 行
      const combinedOutput = stdout + "\n" + stderr;
      const passedMatch = combinedOutput.match(/(\d+)\s+passed/i);
      const failedMatch = combinedOutput.match(/(\d+)\s+failed/i);
      const skippedMatch = combinedOutput.match(/(\d+)\s+skipped/i);
      if (passedMatch) {
        passed = parseInt(passedMatch[1], 10);
      }
      if (failedMatch) {
        failed = parseInt(failedMatch[1], 10);
      }
      if (skippedMatch) {
        skipped = parseInt(skippedMatch[1], 10);
      }
    } catch (e) {
      // spawnSync 抛出的异常（如命令不存在）
      return {
        test_command: this._testCommand,
        passed: 0,
        failed: 0,
        skipped: 0,
        covered_features: [],
        uncovered_features: [],
        test_output_tail: `测试执行失败: ${e instanceof Error ? e.message : String(e)}`,
        duration_sec: 0.0,
      };
    }

    // 检查功能覆盖：扫描测试文件中是否提及功能 ID
    const coveredFeatures: string[] = [];
    const uncoveredFeatures: string[] = [];
    for (const feature of this._features) {
      const fid = feature.feature_id;
      const fname = feature.feature_name;
      // 在测试输出中搜索功能 ID 或功能名称
      if (
        testOutput.toLowerCase().includes(fid.toLowerCase()) ||
        testOutput.toLowerCase().includes(fname.toLowerCase())
      ) {
        coveredFeatures.push(fid);
      } else {
        // 扫描测试文件内容
        let foundInTest = false;
        const testDirs = ["tests", "test", "__tests__", "spec"];
        for (const testDir of testDirs) {
          const testPath = path.join(this._projectRoot, testDir);
          if (fs.existsSync(testPath)) {
            const testFiles = walkFiles(testPath, new Set());
            for (const testFile of testFiles) {
              try {
                const testContent = fs.readFileSync(testFile, "utf-8");
                if (
                  testContent.toLowerCase().includes(fid.toLowerCase()) ||
                  testContent.toLowerCase().includes(fname.toLowerCase())
                ) {
                  foundInTest = true;
                  break;
                }
              } catch {
                continue;
              }
            }
          }
          if (foundInTest) {
            break;
          }
        }
        if (foundInTest) {
          coveredFeatures.push(fid);
        } else {
          uncoveredFeatures.push(fid);
        }
      }
    }

    return {
      test_command: this._testCommand,
      passed: passed,
      failed: failed,
      skipped: skipped,
      covered_features: coveredFeatures,
      uncovered_features: uncoveredFeatures,
      test_output_tail: testOutput.slice(-2000),
      duration_sec: duration,
    };
  }

  // ----------------------------------------------------------------
  // D4: 验收标准满足检查
  // ----------------------------------------------------------------

  /**
   * D4: 验收标准满足检查
   *
   * 将文档中的验收标准与代码和测试结果进行匹配，判断验收标准是否满足。
   *
   * 判定策略（按优先级）：
   * 1. 验收标准描述中的关键词在代码符号名中出现 → satisfied（代码验证）
   * 2. 验收标准描述中的关键词在测试输出中出现 → satisfied（测试验证）
   * 3. 验收标准 ID 在测试文件或源码文件注释中出现 → satisfied
   * 4. 以上均不满足 → unsatisfied（人工验证）
   *
   * @returns 验收标准检查项列表
   */
  checkAcceptanceCriteria(): AcceptanceCheckItem[] {
    if (!this._docsParsed) {
      this._parseDocuments();
    }
    if (!this._codeScanned) {
      this._scanCode();
    }

    const results: AcceptanceCheckItem[] = [];
    for (const criteria of this._acceptanceCriteria) {
      const acId = criteria.criteria_id;
      const acDesc = criteria.criteria_desc;
      const section = criteria.section;

      // 提取关键词
      const keywords = this._extractKeywords(acDesc);
      let verification: "test" | "code" | "manual" = "manual";
      let status: "satisfied" | "unsatisfied" = "unsatisfied";

      // 策略1: 在代码符号中搜索
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        let found = false;
        for (const symbol of this._symbols) {
          if (symbol.name.toLowerCase().includes(kwLower)) {
            verification = "code";
            status = "satisfied";
            found = true;
            break;
          }
        }
        if (found) break;
      }

      // 策略2: 如果代码未匹配，在测试输出中搜索
      if (status !== "satisfied" && this._testCommand) {
        // 获取测试输出（复用 check_test_correctness 的结果）
        const testResult = this.checkTestCorrectness();
        const testOutput = testResult.test_output_tail;
        for (const kw of keywords) {
          if (testOutput.toLowerCase().includes(kw.toLowerCase())) {
            verification = "test";
            status = "satisfied";
            break;
          }
        }
      }

      // 策略3: 如果仍未匹配，在测试文件和源码文件内容中搜索 AC ID
      if (status !== "satisfied") {
        const acIdLower = acId.toLowerCase();
        // 搜索测试文件
        const testDirs = ["tests", "test", "__tests__", "spec"];
        for (const testDir of testDirs) {
          const testPath = path.join(this._projectRoot, testDir);
          if (fs.existsSync(testPath)) {
            const testFiles = walkFiles(testPath, new Set());
            let found = false;
            for (const testFile of testFiles) {
              try {
                const testContent = fs.readFileSync(testFile, "utf-8");
                if (testContent.toLowerCase().includes(acIdLower)) {
                  verification = "test";
                  status = "satisfied";
                  found = true;
                  break;
                }
              } catch {
                continue;
              }
            }
            if (found) break;
          }
          if (status === "satisfied") break;
        }
        // 搜索源码文件中的 AC ID 注释
        if (status !== "satisfied") {
          for (const symbol of this._symbols) {
            try {
              const srcPath = path.join(this._projectRoot, symbol.file_path);
              if (fs.existsSync(srcPath)) {
                const srcContent = fs.readFileSync(srcPath, "utf-8");
                if (srcContent.toLowerCase().includes(acIdLower)) {
                  verification = "code";
                  status = "satisfied";
                  break;
                }
              }
            } catch {
              continue;
            }
          }
        }
      }

      results.push({
        criteria_id: acId,
        criteria_desc: acDesc,
        doc_source: section,
        verification: verification,
        status: status,
      });
    }
    return results;
  }

  // ----------------------------------------------------------------
  // D5: TODO/FIXME 清零检查
  // ----------------------------------------------------------------

  /**
   * D5: TODO/FIXME 清零检查
   *
   * 返回代码扫描阶段已扫描到的所有 TODO/FIXME 检查项。
   * 每个 TODO/FIXME 项的 has_implementation 字段标识是否有对应实现。
   *
   * @returns TODO/FIXME 检查项列表（副本）
   */
  checkTodoFixme(): TodoItem[] {
    if (!this._codeScanned) {
      this._scanCode();
    }
    // 返回副本，避免外部修改内部缓存
    return this._todos.map((t) => ({ ...t }));
  }

  // ----------------------------------------------------------------
  // D6: 文档意图遵从检查
  // ----------------------------------------------------------------

  /**
   * D6: 文档意图遵从检查
   *
   * 基于代码-文档关键词匹配，检测代码实现是否偏离文档设计意图。
   *
   * 检查策略：
   * 1. 技术选型一致性：文档中提到的技术栈/框架是否在代码中使用
   * 2. 模块划分一致性：文档中定义的模块名是否在代码中体现（文件路径、符号名或 import 关系）
   *
   * @returns 偏离项列表
   */
  checkDocIntentAlignment(): DeviationItem[] {
    if (!this._docsParsed) {
      this._parseDocuments();
    }
    if (!this._codeScanned) {
      this._scanCode();
    }

    const deviations: DeviationItem[] = [];

    // 检查1: 文档中提到的技术栈是否在代码中使用
    // 从架构文档中提取技术栈关键词
    const techKeywords = this._extractTechStackFromDocs();
    const codeText = this._getCodeSummary();
    for (const tech of techKeywords) {
      if (!codeText.toLowerCase().includes(tech.toLowerCase())) {
        deviations.push({
          dimension: "技术选型",
          doc_intent: `文档要求使用 ${tech}`,
          code_reality: `代码中未发现 ${tech} 的使用`,
          severity: "medium",
        });
      }
    }

    // 检查2: 文档中定义的模块名是否在代码中体现
    for (const relation of this._integrationRelations) {
      const sourceMod = relation.source;
      const targetMod = relation.target;
      // 检查模块名是否在文件路径、符号名或 import 关系中出现
      const foundSource =
        this._symbols.some(
          (s) =>
            s.file_path.toLowerCase().includes(sourceMod.toLowerCase()) ||
            s.name.toLowerCase().includes(sourceMod.toLowerCase())
        ) ||
        this._imports.some(
          (imp) =>
            imp.source_file.toLowerCase().includes(sourceMod.toLowerCase()) ||
            imp.imported_module.toLowerCase().includes(sourceMod.toLowerCase())
        );
      const foundTarget =
        this._symbols.some(
          (s) =>
            s.file_path.toLowerCase().includes(targetMod.toLowerCase()) ||
            s.name.toLowerCase().includes(targetMod.toLowerCase())
        ) ||
        this._imports.some(
          (imp) =>
            imp.source_file.toLowerCase().includes(targetMod.toLowerCase()) ||
            imp.imported_module.toLowerCase().includes(targetMod.toLowerCase())
        );
      if (!foundSource) {
        deviations.push({
          dimension: "模块划分",
          doc_intent: `文档定义了模块 ${sourceMod}`,
          code_reality: `代码中未发现 ${sourceMod} 相关文件或符号`,
          severity: "low",
        });
      }
      if (!foundTarget) {
        deviations.push({
          dimension: "模块划分",
          doc_intent: `文档定义了模块 ${targetMod}`,
          code_reality: `代码中未发现 ${targetMod} 相关文件或符号`,
          severity: "low",
        });
      }
    }

    return deviations;
  }

  /**
   * 从文档中提取技术栈关键词
   *
   * 搜索文档中常见的"技术栈"/"框架"/"依赖"章节，
   * 提取已知的技术名称。
   *
   * @returns 去重后的技术栈关键词列表
   */
  private _extractTechStackFromDocs(): string[] {
    const techKeywords = new Set<string>();
    // 常见技术栈关键词
    const knownTechs = [
      "Flask",
      "Django",
      "FastAPI",
      "Express",
      "Koa",
      "NestJS",
      "React",
      "Vue",
      "Angular",
      "Svelte",
      "PostgreSQL",
      "MySQL",
      "SQLite",
      "MongoDB",
      "Redis",
      "Docker",
      "Kubernetes",
      "Celery",
      "RabbitMQ",
      "pytest",
      "unittest",
      "jest",
      "mocha",
    ];
    for (const docPath of Object.values(this._docPaths)) {
      if (!docPath || !fs.existsSync(docPath)) {
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(docPath, "utf-8");
      } catch {
        continue;
      }
      for (const tech of knownTechs) {
        if (content.toLowerCase().includes(tech.toLowerCase())) {
          techKeywords.add(tech);
        }
      }
    }
    return Array.from(techKeywords);
  }

  /**
   * 获取代码摘要文本（用于关键词匹配）
   *
   * 将所有代码符号的名称和文件路径、import 关系的模块名拼接为文本。
   *
   * @returns 代码摘要文本
   */
  private _getCodeSummary(): string {
    const parts: string[] = [];
    for (const symbol of this._symbols) {
      parts.push(`${symbol.file_path}:${symbol.name}`);
    }
    for (const imp of this._imports) {
      parts.push(`import:${imp.imported_module}`);
    }
    return parts.join(" ");
  }

  // ----------------------------------------------------------------
  // 缺口清单构建
  // ----------------------------------------------------------------

  /**
   * 构建缺口清单
   *
   * 汇总所有维度的不通过项，生成结构化缺口清单。
   * 每个缺口项包含：维度、描述、关联功能 ID、优先级、建议修复方式。
   *
   * 优先级规则：
   * - D1 功能未实现：P0
   * - D2 集成缺失：P0
   * - D3 测试失败：P0；无测试结果：P1；功能未覆盖：P1
   * - D4 验收标准未满足：P1
   * - D5 TODO/FIXME 未实现：P1
   * - D6 文档意图偏离：P2（low）/ P1（medium/high）
   *
   * @param featureChecks D1 检查结果
   * @param integrationChecks D2 检查结果
   * @param testResult D3 检查结果
   * @param acceptanceChecks D4 检查结果
   * @param todoItems D5 检查结果
   * @param deviationItems D6 检查结果
   * @returns 缺口清单
   */
  private _buildGapList(
    featureChecks: FeatureCheckItem[],
    integrationChecks: IntegrationCheckItem[],
    testResult: TestCheckResult,
    acceptanceChecks: AcceptanceCheckItem[],
    todoItems: TodoItem[],
    deviationItems: DeviationItem[]
  ): GapItem[] {
    const gaps: GapItem[] = [];

    // D1 缺口：未实现的功能
    for (const item of featureChecks) {
      if (item.status === "missing") {
        gaps.push({
          dimension: "D1 功能完成度",
          description: `功能 ${item.feature_id}(${item.feature_name}) 未实现`,
          feature_id: item.feature_id,
          priority: "P0",
          suggestion: `实现功能 ${item.feature_name}，参考 ${item.doc_source}`,
        });
      }
    }

    // D2 缺口：缺失的集成
    for (const item of integrationChecks) {
      if (item.status === "missing") {
        gaps.push({
          dimension: "D2 集成完整性",
          description: `集成关系 ${item.integration_desc} 缺失`,
          feature_id: "",
          priority: "P0",
          suggestion: `添加 ${item.integration_desc} 的 import/调用关系，参考 ${item.doc_source}`,
        });
      }
    }

    // D3 缺口：测试失败或未覆盖
    if (testResult.failed > 0) {
      gaps.push({
        dimension: "D3 测试正确性",
        description: `测试失败：${testResult.failed} failed / ${testResult.passed} passed`,
        feature_id: "",
        priority: "P0",
        suggestion: "修复失败的测试用例",
      });
    }
    if (testResult.passed === 0 && testResult.failed === 0) {
      gaps.push({
        dimension: "D3 测试正确性",
        description: "无测试执行结果（可能未配置测试命令或测试为空）",
        feature_id: "",
        priority: "P1",
        suggestion: "配置并执行测试命令",
      });
    }
    for (const fid of testResult.uncovered_features) {
      gaps.push({
        dimension: "D3 测试正确性",
        description: `功能 ${fid} 未被测试覆盖`,
        feature_id: fid,
        priority: "P1",
        suggestion: `为功能 ${fid} 添加测试用例`,
      });
    }

    // D4 缺口：未满足的验收标准
    for (const item of acceptanceChecks) {
      if (item.status === "unsatisfied") {
        gaps.push({
          dimension: "D4 验收标准",
          description: `验收标准 ${item.criteria_id}(${item.criteria_desc.slice(0, 50)}) 未满足`,
          feature_id: "",
          priority: "P1",
          suggestion: `实现验收标准 ${item.criteria_id}，参考 ${item.doc_source}`,
        });
      }
    }

    // D5 缺口：未实现的 TODO/FIXME
    for (const item of todoItems) {
      if (!item.has_implementation) {
        gaps.push({
          dimension: "D5 TODO/FIXME",
          description: `${item.todo_type} 未实现：${item.file_path}:${item.line_number} ${item.content.slice(0, 50)}`,
          feature_id: "",
          priority: "P1",
          suggestion: `实现或删除 ${item.todo_type}：${item.file_path}:${item.line_number}`,
        });
      }
    }

    // D6 缺口：文档意图偏离
    for (const item of deviationItems) {
      gaps.push({
        dimension: "D6 文档意图",
        description: `${item.dimension} 偏离：${item.doc_intent}（实际：${item.code_reality}）`,
        feature_id: "",
        priority: item.severity === "low" ? "P2" : "P1",
        suggestion: `对齐 ${item.dimension}：${item.doc_intent}`,
      });
    }

    return gaps;
  }

  // ----------------------------------------------------------------
  // 报告生成
  // ----------------------------------------------------------------

  /**
   * 生成 Markdown 审查报告
   *
   * 报告包含以下章节：
   * 1. 文档信息（项目名称、审查时间、最终判定）
   * 2. 审查概览（审查范围、各维度通过率）
   * 3. D1 功能完成度对照清单
   * 4. D2 集成完整性对照清单
   * 5. D3 测试执行结果与功能覆盖
   * 6. D4 验收标准对照清单
   * 7. D5 TODO/FIXME 清单
   * 8. D6 文档意图偏离清单
   * 9. 缺口清单
   * 10. 审查结论
   *
   * @param report 一致性检查完整报告
   * @returns Markdown 格式的审查报告
   */
  generateReport(report: ConsistencyReport): string {
    const lines: string[] = [];
    // 文档头部
    lines.push("# 文档对照代码审查报告");
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## 文档信息");
    lines.push("");
    lines.push("| 项目 | 内容 |");
    lines.push("|------|------|");
    lines.push(`| 项目名称 | ${report.project_name} |`);
    lines.push(`| 审查时间 | ${report.check_time} |`);
    lines.push("| 审查角色 | 架构师、独立开发者、测试专家 |");
    const judgment = report.overall_passed ? "✅ 审查通过" : "❌ 审查不通过";
    lines.push(`| 最终判定 | ${judgment} |`);
    lines.push("| 报告版本 | v1.0 |");
    lines.push("");

    // 1. 审查概览
    lines.push("## 1. 审查概览");
    lines.push("");
    const totalFeatures = report.feature_checks.length;
    const implFeatures = report.feature_checks.filter((f) => f.status === "implemented").length;
    const missingFeatures = totalFeatures - implFeatures;
    const totalIntegrations = report.integration_checks.length;
    const connectedIntegrations = report.integration_checks.filter((i) => i.status === "connected").length;
    const missingIntegrations = totalIntegrations - connectedIntegrations;
    const totalCriteria = report.acceptance_checks.length;
    const satisfiedCriteria = report.acceptance_checks.filter((a) => a.status === "satisfied").length;
    const unsatisfiedCriteria = totalCriteria - satisfiedCriteria;
    const totalTodos = report.todo_items.length;
    const implTodos = report.todo_items.filter((t) => t.has_implementation).length;
    const unimplTodos = totalTodos - implTodos;
    const totalDeviations = report.deviation_items.length;

    lines.push("### 1.1 审查范围");
    lines.push("");
    lines.push(`- **功能点总数**: ${totalFeatures}`);
    lines.push(`- **集成关系总数**: ${totalIntegrations}`);
    lines.push(`- **验收标准总数**: ${totalCriteria}`);
    lines.push(`- **TODO/FIXME 总数**: ${totalTodos}`);
    lines.push("");

    lines.push("### 1.2 审查结果摘要");
    lines.push("");
    lines.push("| 维度 | 检查项 | 通过 | 不通过 | 通过率 | 判定 |");
    lines.push("|------|--------|------|--------|--------|------|");
    const featureRate = totalFeatures > 0 ? `${Math.floor((implFeatures * 100) / totalFeatures)}%` : "-";
    const d1Pass = missingFeatures === 0 ? "✅" : "❌";
    lines.push(
      `| D1 功能完成度 | ${totalFeatures} | ${implFeatures} | ${missingFeatures} | ${featureRate} | ${d1Pass} |`
    );
    const intRate = totalIntegrations > 0 ? `${Math.floor((connectedIntegrations * 100) / totalIntegrations)}%` : "-";
    const d2Pass = missingIntegrations === 0 ? "✅" : "❌";
    lines.push(
      `| D2 集成完整性 | ${totalIntegrations} | ${connectedIntegrations} | ${missingIntegrations} | ${intRate} | ${d2Pass} |`
    );
    if (report.test_result) {
      const tr = report.test_result;
      const d3Pass = tr.failed === 0 && tr.passed > 0 ? "✅" : "❌";
      const total = tr.passed + tr.failed;
      const testRate = total > 0 ? `${Math.floor((tr.passed * 100) / total)}%` : "0%";
      lines.push(`| D3 测试正确性 | ${total} | ${tr.passed} | ${tr.failed} | ${testRate} | ${d3Pass} |`);
    }
    const acRate = totalCriteria > 0 ? `${Math.floor((satisfiedCriteria * 100) / totalCriteria)}%` : "-";
    const d4Pass = unsatisfiedCriteria === 0 ? "✅" : "❌";
    lines.push(
      `| D4 验收标准 | ${totalCriteria} | ${satisfiedCriteria} | ${unsatisfiedCriteria} | ${acRate} | ${d4Pass} |`
    );
    const d5Pass = unimplTodos === 0 ? "✅" : "❌";
    lines.push(`| D5 TODO/FIXME | ${totalTodos} | ${implTodos} | ${unimplTodos} | - | ${d5Pass} |`);
    const d6Pass = totalDeviations === 0 ? "✅" : "❌";
    lines.push(`| D6 文档意图 | ${totalDeviations} | 0 | ${totalDeviations} | - | ${d6Pass} |`);
    lines.push("");

    // 2. D1 功能完成度
    lines.push("## 2. D1 功能完成度");
    lines.push("");
    if (report.feature_checks.length > 0) {
      lines.push("### 2.1 功能对照清单");
      lines.push("");
      lines.push("| 功能 ID | 功能名称 | 文档来源 | 代码位置 | 状态 | 证据 |");
      lines.push("|---------|----------|----------|----------|------|------|");
      for (const item of report.feature_checks) {
        const statusCn = item.status === "implemented" ? "✅ 已实现" : "❌ 未实现";
        lines.push(
          `| ${item.feature_id} | ${item.feature_name} | ${item.doc_source} | ` +
            `${item.code_location || "-"} | ${statusCn} | ${item.evidence || "-"} |`
        );
      }
      lines.push("");
    } else {
      lines.push("（未解析到功能列表）");
      lines.push("");
    }

    // 3. D2 集成完整性
    lines.push("## 3. D2 集成完整性");
    lines.push("");
    if (report.integration_checks.length > 0) {
      lines.push("### 3.1 集成对照清单");
      lines.push("");
      lines.push("| 集成关系 | 文档来源 | 代码位置 | 状态 |");
      lines.push("|----------|----------|----------|------|");
      for (const item of report.integration_checks) {
        const statusCn = item.status === "connected" ? "✅ 已连通" : "❌ 缺失";
        lines.push(
          `| ${item.integration_desc} | ${item.doc_source} | ` + `${item.code_location || "-"} | ${statusCn} |`
        );
      }
      lines.push("");
    } else {
      lines.push("（未解析到集成关系）");
      lines.push("");
    }

    // 4. D3 测试正确性
    lines.push("## 4. D3 测试正确性");
    lines.push("");
    if (report.test_result) {
      const tr = report.test_result;
      lines.push("### 4.1 测试执行结果");
      lines.push("");
      lines.push(`- 测试命令: \`${tr.test_command}\``);
      lines.push(`- 通过: ${tr.passed}`);
      lines.push(`- 失败: ${tr.failed}`);
      lines.push(`- 跳过: ${tr.skipped}`);
      lines.push(`- 执行时间: ${tr.duration_sec.toFixed(2)}s`);
      lines.push("");
      if (tr.covered_features.length > 0 || tr.uncovered_features.length > 0) {
        lines.push("### 4.2 功能覆盖检查");
        lines.push("");
        lines.push("| 功能 ID | 是否有测试 |");
        lines.push("|---------|-----------|");
        for (const fid of tr.covered_features) {
          lines.push(`| ${fid} | ✅ |`);
        }
        for (const fid of tr.uncovered_features) {
          lines.push(`| ${fid} | ❌ |`);
        }
        lines.push("");
      }
      if (tr.test_output_tail) {
        lines.push("### 4.3 测试输出（末尾 2000 字符）");
        lines.push("");
        lines.push("```");
        lines.push(tr.test_output_tail.slice(-2000));
        lines.push("```");
        lines.push("");
      }
    } else {
      lines.push("（未执行测试检查）");
      lines.push("");
    }

    // 5. D4 验收标准
    lines.push("## 5. D4 验收标准满足");
    lines.push("");
    if (report.acceptance_checks.length > 0) {
      lines.push("### 5.1 验收标准对照清单");
      lines.push("");
      lines.push("| 验收标准 ID | 描述 | 文档来源 | 验证方式 | 状态 |");
      lines.push("|-------------|------|----------|----------|------|");
      for (const item of report.acceptance_checks) {
        const statusCn = item.status === "satisfied" ? "✅ 满足" : "❌ 不满足";
        lines.push(
          `| ${item.criteria_id} | ${item.criteria_desc.slice(0, 60)} | ${item.doc_source} | ` +
            `${item.verification} | ${statusCn} |`
        );
      }
      lines.push("");
    } else {
      lines.push("（未解析到验收标准）");
      lines.push("");
    }

    // 6. D5 TODO/FIXME
    lines.push("## 6. D5 TODO/FIXME 清零");
    lines.push("");
    if (report.todo_items.length > 0) {
      lines.push("### 6.1 TODO/FIXME 清单");
      lines.push("");
      lines.push("| 文件 | 行号 | 类型 | 内容 | 是否有对应实现 |");
      lines.push("|------|------|------|------|---------------|");
      for (const item of report.todo_items) {
        const implCn = item.has_implementation ? "✅ 已实现" : "❌ 未实现";
        lines.push(
          `| ${item.file_path} | ${item.line_number} | ${item.todo_type} | ` +
            `${item.content.slice(0, 60)} | ${implCn} |`
        );
      }
      lines.push("");
    } else {
      lines.push("✅ 无 TODO/FIXME 残留");
      lines.push("");
    }

    // 7. D6 文档意图
    lines.push("## 7. D6 文档意图遵从");
    lines.push("");
    if (report.deviation_items.length > 0) {
      lines.push("### 7.1 偏离清单");
      lines.push("");
      lines.push("| 偏离维度 | 文档意图 | 代码实际情况 | 严重程度 |");
      lines.push("|----------|----------|-------------|----------|");
      for (const item of report.deviation_items) {
        lines.push(`| ${item.dimension} | ${item.doc_intent} | ${item.code_reality} | ${item.severity} |`);
      }
      lines.push("");
    } else {
      lines.push("✅ 无偏离项");
      lines.push("");
    }

    // 8. 缺口清单
    lines.push("## 8. 缺口清单");
    lines.push("");
    if (report.gap_list.length > 0) {
      lines.push("| # | 维度 | 缺口描述 | 功能 ID | 优先级 | 建议修复方式 |");
      lines.push("|---|------|----------|---------|--------|-------------|");
      for (let idx = 0; idx < report.gap_list.length; idx++) {
        const gap = report.gap_list[idx];
        lines.push(
          `| ${idx + 1} | ${gap.dimension} | ${gap.description} | ` +
            `${gap.feature_id || "-"} | ${gap.priority} | ${gap.suggestion} |`
        );
      }
      lines.push("");
    } else {
      lines.push("✅ 无缺口");
      lines.push("");
    }

    // 9. 审查结论
    lines.push("## 9. 审查结论");
    lines.push("");
    if (report.overall_passed) {
      lines.push("- **最终判定**: ✅ 审查通过，可发布");
    } else {
      lines.push("- **最终判定**: ❌ 审查不通过，需回退修复");
    }
    lines.push(`- **缺口总数**: ${report.gap_list.length}`);
    if (report.overall_passed) {
      lines.push("- **建议操作**: 发布");
    } else {
      lines.push("- **建议操作**: 回退到开发阶段修复缺口");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("> 审查人签名: ________________  日期: ________________");

    return lines.join("\n");
  }

  // ----------------------------------------------------------------
  // 内部辅助方法
  // ----------------------------------------------------------------

  /**
   * 解析所有文档，提取功能点、验收标准、集成关系
   *
   * 遍历 _docPaths 中的所有文档，调用 DocParser 的三个解析方法。
   * 集成关系仅从 "architecture" 类型文档解析。
   * 解析后对结果去重。
   */
  private _parseDocuments(): void {
    this._features = [];
    this._acceptanceCriteria = [];
    this._integrationRelations = [];

    for (const [docType, docPath] of Object.entries(this._docPaths)) {
      if (!docPath || !fs.existsSync(docPath)) {
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(docPath, "utf-8");
      } catch {
        continue;
      }
      const docName = path.basename(docPath);
      // 解析功能列表
      const features = DocParser.parseFeatures(content, docName);
      this._features.push(...features);
      // 解析验收标准
      const criteria = DocParser.parseAcceptanceCriteria(content, docName);
      this._acceptanceCriteria.push(...criteria);
      // 解析集成关系（仅从架构文档解析）
      if (docType === "architecture") {
        const relations = DocParser.parseIntegrationRelations(content, docName);
        this._integrationRelations.push(...relations);
      }
    }

    // 去重
    this._features = DocCodeConsistencyChecker._dedupFeatures(this._features);
    this._acceptanceCriteria = DocCodeConsistencyChecker._dedupCriteria(this._acceptanceCriteria);
    this._integrationRelations = DocCodeConsistencyChecker._dedupRelations(this._integrationRelations);

    this._docsParsed = true;
  }

  /**
   * 扫描项目代码，提取符号、import、TODO
   *
   * 调用 CodeScanner.scanProject 扫描整个项目，
   * 将结果缓存到 _symbols、_imports、_todos。
   */
  private _scanCode(): void {
    [this._symbols, this._imports, this._todos] = CodeScanner.scanProject(this._projectRoot);
    this._codeScanned = true;
  }

  /**
   * 功能列表去重（按 feature_id）
   *
   * @param features 待去重的功能列表
   * @returns 去重后的功能列表
   */
  private static _dedupFeatures(features: ParsedFeature[]): ParsedFeature[] {
    const seen = new Set<string>();
    const result: ParsedFeature[] = [];
    for (const f of features) {
      const fid = f.feature_id;
      if (!seen.has(fid)) {
        seen.add(fid);
        result.push(f);
      }
    }
    return result;
  }

  /**
   * 验收标准去重（按 criteria_id）
   *
   * @param criteria 待去重的验收标准列表
   * @returns 去重后的验收标准列表
   */
  private static _dedupCriteria(criteria: ParsedAcceptanceCriteria[]): ParsedAcceptanceCriteria[] {
    const seen = new Set<string>();
    const result: ParsedAcceptanceCriteria[] = [];
    for (const c of criteria) {
      const cid = c.criteria_id;
      if (!seen.has(cid)) {
        seen.add(cid);
        result.push(c);
      }
    }
    return result;
  }

  /**
   * 集成关系去重（按 integration_desc）
   *
   * @param relations 待去重的集成关系列表
   * @returns 去重后的集成关系列表
   */
  private static _dedupRelations(relations: ParsedIntegrationRelation[]): ParsedIntegrationRelation[] {
    const seen = new Set<string>();
    const result: ParsedIntegrationRelation[] = [];
    for (const r of relations) {
      const desc = r.integration_desc;
      if (!seen.has(desc)) {
        seen.add(desc);
        result.push(r);
      }
    }
    return result;
  }
}

// ============================================================================
// 第六部分：类型别名导出
// ============================================================================

/**
 * 文档路径字典类型别名
 *
 * 键为文档类型（如 "prd" / "architecture" / "spec" / "test_plan"），
 * 值为文档文件路径字符串。
 *
 * 用法：
 * ```typescript
 * const docPaths: DocPaths = {
 *     prd: "docs/prd.md",
 *     architecture: "docs/arch.md"
 * };
 * ```
 */
export type DocPaths = Record<string, string>;
