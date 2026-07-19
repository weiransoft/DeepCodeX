/**
 * EvidenceCollector：合规证据采集器（可选辅助工具类）
 *
 * 定位（架构师审查 B1-M6 修复——明确使用关系）：
 * - EvidenceCollector 是**可选辅助工具类**，ComplianceRule.staticChecker / dynamicChecker 实现可选择使用
 * - ComplianceRuleResult.evidence 字段类型为 `ReadonlyArray<ComplianceEvidence>`，
 *   staticChecker 实现**既可直接构造 ComplianceEvidence 对象**（适合简单场景，如 GMP-01 的代码片段），
 *   **也可委托 EvidenceCollector** 统一采集（适合复杂场景，如多文件证据聚合）
 * - 二者产出结构一致（都是 ComplianceEvidence 对象），下游消费者（ComplianceEngine / G-7 门禁）
 *   只读取 evidence 数组，不感知证据是直接构造还是通过 EvidenceCollector 采集
 *
 * 职责：
 * - 从代码文件采集 code-snippet 证据（按行号范围截取）
 * - 从测试输出采集 test-output 证据（截取 stdout / stderr）
 * - 从配置文件采集 config 证据（按字段路径提取）
 * - 从日志文件采集 log 证据（按时间范围过滤）
 * - 从审计表采集 audit-trail 证据（按操作类型过滤）
 *
 * 所有采集方法均为纯函数，不修改原始数据，返回 Object.freeze 冻结的 ComplianceEvidence。
 *
 * 使用关系说明（架构师审查 B1-M6 修复）：
 *
 * | 场景 | 推荐方式 | 示例 |
 * |------|---------|------|
 * | 简单规则（单条证据 / 证据来源固定） | 直接构造 ComplianceEvidence 对象 | GMP-01 的代码片段证据 |
 * | 复杂规则（多条证据 / 跨文件聚合） | 委托 EvidenceCollector 统一采集 | GMP-04 偏差处理：从日志 + 审计表 + 测试输出 3 处采集证据 |
 * | 动态规则（运行期采集） | 在 dynamicChecker 内部委托 EvidenceCollector.collectTestOutput() | GMP-02 批记录：测试运行后采集 stdout |
 *
 * @module eag/icp/evidence-collector
 */

import type { ComplianceEvidence } from "./types";

// ============================================================================
// 1. EvidenceCollector 类
// ============================================================================

/**
 * EvidenceCollector：合规证据采集器
 *
 * 使用方式：
 * ```typescript
 * const collector = new EvidenceCollector();
 * const evidence = collector.collectCodeSnippet(
 *   "src/services/OrderService.ts",
 *   fileContent,
 *   42,
 *   58
 * );
 * // evidence.kind === "code-snippet"
 * // evidence.source === "src/services/OrderService.ts:42-58"
 * // evidence.content === "<行 42-58 的代码片段>"
 * ```
 *
 * 设计原则：
 * - 纯函数：所有采集方法不修改原始数据
 * - 不可变：所有方法返回 Object.freeze 冻结的 ComplianceEvidence
 * - 防御性编程：对越界行号、空字符串等边界情况做合理处理
 */
export class EvidenceCollector {
  /**
   * 从代码文件采集 code-snippet 证据
   *
   * 按行号范围截取代码片段，生成 ComplianceEvidence 对象。
   *
   * 算法：
   * 1. 按 \n 分割文件内容为行数组
   * 2. 校验 lineStart / lineEnd 合法性（1-based，lineStart <= lineEnd）
   * 3. 越界处理：lineStart < 1 时调整为 1，lineEnd > 行数时调整为行数
   * 4. 截取行 [lineStart-1, lineEnd)（slice 半开区间）
   * 5. 拼接为字符串，生成冻结的 ComplianceEvidence
   *
   * @param filePath 文件路径（如 "src/services/OrderService.ts"）
   * @param content 文件内容
   * @param lineStart 起始行号（1-based）
   * @param lineEnd 结束行号（1-based，含本行）
   * @returns 冻结的 ComplianceEvidence 对象
   */
  collectCodeSnippet(filePath: string, content: string, lineStart: number, lineEnd: number): ComplianceEvidence {
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    // 越界处理：lineStart 至少为 1，lineEnd 至多为 totalLines
    const adjustedStart = Math.max(1, Math.min(lineStart, totalLines));
    const adjustedEnd = Math.max(adjustedStart, Math.min(lineEnd, totalLines));

    // 截取行 [adjustedStart-1, adjustedEnd)（slice 半开区间，1-based → 0-based）
    const snippet = lines.slice(adjustedStart - 1, adjustedEnd).join("\n");

    return Object.freeze({
      kind: "code-snippet" as const,
      source: `${filePath}:${adjustedStart}-${adjustedEnd}`,
      content: snippet,
    }) as ComplianceEvidence;
  }

  /**
   * 从测试输出采集 test-output 证据
   *
   * 将测试运行的 stdout / stderr 合并，生成 ComplianceEvidence 对象。
   *
   * 算法：
   * 1. 将 stdout + stderr 合并为统一输出（带分隔标识）
   * 2. 截取前 N 行（避免超长输出），N=1000（对齐 §4.4.2 单文件 token 上限）
   * 3. 生成冻结的 ComplianceEvidence
   *
   * @param testPath 测试文件路径（如 "tests/compliance/gmp-02.batch.test.ts"）
   * @param stdout 标准输出
   * @param stderr 标准错误（可选，默认为空字符串）
   * @returns 冻结的 ComplianceEvidence 对象
   */
  collectTestOutput(testPath: string, stdout: string, stderr: string = ""): ComplianceEvidence {
    // 合并 stdout + stderr，带分隔标识
    const mergedOutput = stderr && stderr.length > 0 ? `=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}` : stdout;

    // 截取前 1000 行（避免超长输出）
    const lines = mergedOutput.split(/\r?\n/);
    const truncatedLines = lines.slice(0, 1000);
    const truncated = truncatedLines.join("\n");

    // 若截断，附加截断标识
    const finalContent =
      lines.length > 1000 ? `${truncated}\n... (输出已截断，共 ${lines.length} 行，仅显示前 1000 行)` : truncated;

    return Object.freeze({
      kind: "test-output" as const,
      source: testPath,
      content: finalContent,
    }) as ComplianceEvidence;
  }

  /**
   * 从配置文件采集 config 证据
   *
   * 按字段路径提取配置值，生成 ComplianceEvidence 对象。
   *
   * 算法：
   * 1. 将字段路径按 "." 分割为字段名数组（如 "compliance.gmp.version" → ["compliance", "gmp", "version"]）
   * 2. 递归遍历配置对象，按路径查找字段值
   * 3. 字段值序列化为字符串（对象则 JSON.stringify，基础类型则 String()）
   * 4. 生成冻结的 ComplianceEvidence
   *
   * @param filePath 配置文件路径（如 ".eag/icp-config.yml"）
   * @param fieldPath 字段路径（如 "compliance.gmp.version"）
   * @param value 字段值（已解析的配置值，由调用方提供）
   * @returns 冻结的 ComplianceEvidence 对象
   */
  collectConfig(filePath: string, fieldPath: string, value: unknown): ComplianceEvidence {
    // 序列化字段值
    let content: string;
    if (value === null) {
      content = "null";
    } else if (value === undefined) {
      content = "undefined";
    } else if (typeof value === "object") {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    } else {
      content = String(value);
    }

    return Object.freeze({
      kind: "config" as const,
      source: `${filePath}#${fieldPath}`,
      content,
    }) as ComplianceEvidence;
  }

  /**
   * 从日志文件采集 log 证据
   *
   * 按时间戳与日志级别生成结构化日志证据。
   *
   * 算法：
   * 1. 校验时间戳格式（非空字符串）
   * 2. 校验日志级别合法性（info / warn / error / debug）
   * 3. 拼接为结构化日志行：[timestamp] [level] message
   * 4. 生成冻结的 ComplianceEvidence
   *
   * @param timestamp 时间戳（ISO 8601 字符串，如 "2026-07-19T10:00:00.000Z"）
   * @param level 日志级别（info / warn / error / debug）
   * @param message 日志消息
   * @returns 冻结的 ComplianceEvidence 对象
   */
  collectLog(timestamp: string, level: "info" | "warn" | "error" | "debug", message: string): ComplianceEvidence {
    // 拼接为结构化日志行
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    return Object.freeze({
      kind: "log" as const,
      source: `log:${timestamp}`,
      content: logLine,
    }) as ComplianceEvidence;
  }

  /**
   * 从审计表采集 audit-trail 证据
   *
   * 按操作人、时间戳、操作动作生成审计追踪证据。
   *
   * 算法：
   * 1. 校验操作人非空
   * 2. 校验时间戳格式（ISO 8601 字符串）
   * 3. 校验操作动作非空
   * 4. 拼接为审计追踪记录：operator=<operator>, timestamp=<timestamp>, action=<action>
   * 5. 生成冻结的 ComplianceEvidence
   *
   * @param operator 操作人（如 "user-001"）
   * @param timestamp 时间戳（ISO 8601 字符串）
   * @param action 操作动作（如 "approve-batch-record"）
   * @returns 冻结的 ComplianceEvidence 对象
   */
  collectAuditTrail(operator: string, timestamp: string, action: string): ComplianceEvidence {
    // 拼接为审计追踪记录
    const auditRecord = `operator=${operator}, timestamp=${timestamp}, action=${action}`;

    return Object.freeze({
      kind: "audit-trail" as const,
      source: `audit:${operator}@${timestamp}`,
      content: auditRecord,
    }) as ComplianceEvidence;
  }
}
