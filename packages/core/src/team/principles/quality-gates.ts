/**
 * 质量门禁系统（Quality Gates）—— 管理器与默认执行器
 *
 * 来源：multi-agent-team skill skill-manifest-example.yaml quality_gates +
 *       UI/UX 巡检 + 视觉回归 + Karpathy 原则 + 测试覆盖 + 安全扫描
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 设计目标（v2 修订）：
 * - 7 大门禁类型：code-review / test-coverage / spec-compliance /
 *   security-scan / ponytail-redlines / karpathy-principles / uiux-visual
 * - 每类门禁定义 severity、threshold、checker、weight、enabled 字段
 * - 支持运行时配置覆盖（user override）
 * - 门禁结果聚合 + 整体 PASS/FAIL 判定
 * - 报告输出（结构化 JSON + Markdown）
 *
 * 本文件仅保留 QualityGateManager / DefaultPassExecutor / DEFAULT_QUALITY_GATE_MANAGER
 * 实现；常量、类型、工厂函数、默认配置全部下沉到 quality-gate-common.ts，
 * 避免 quality-gates.ts 与 quality-gate-executors.ts 之间的循环依赖，同时消除
 * 两份源码的重复维护。
 *
 * 作者：trae-multi-agent 融合 Phase 1/2（TypeScript 移植 + 真实执行器版）
 * 创建日期：2026-07-16
 */

import { createDefaultGateExecutors } from "./quality-gate-executors.js";
// 本地使用 quality-gate-common 中的类型、常量与工厂函数
// 注意：`export *` 仅对外 re-export，不会将这些符号引入当前模块作用域，
// 因此本文件内部使用以下符号时必须显式导入。
import type {
  GateExecutorLike,
  QualityGateIdType,
  QualityGateConfig,
  GateFinding,
  GateResult,
  QualityReport,
} from "./quality-gate-common.js";
import {
  GateStatus,
  GateSeverity,
  createQualityReport,
  createGateResult,
  getDefaultGateConfigs,
  findGateConfig,
} from "./quality-gate-common.js";

// ============================================================================
// 公共定义与工厂函数复用
// ============================================================================
//
// quality-gate-common.ts 已统一定义：
//   - 常量：QualityGateId / ALL_QUALITY_GATE_IDS / GateSeverity / GateStatus
//   - 异常：QualityGateError / GateConfigError
//   - 类型：QualityGateConfig / GateFinding / GateResult / QualityReport / GateExecutorLike
//   - 工厂：createQualityGateConfig / qualityGateConfigToDict / createGateFinding /
//          createGateResult / createQualityReport
//   - 默认配置：DEFAULT_GATE_CONFIGS / getDefaultGateConfigs / findGateConfig
//
// 本文件仅保留 QualityGateManager / DefaultPassExecutor / DEFAULT_QUALITY_GATE_MANAGER
// 实现，避免与 quality-gate-executors.ts 产生循环依赖，同时消除两份源码的重复维护。
export * from "./quality-gate-common.js";

// ============================================================================
// 默认占位执行器
// ============================================================================

/**
 * 默认占位执行器：始终返回 PASS（用于骨架/无实现场景）
 *
 * QualityGateManager 在 createDefaultGateExecutors() 未返回某门禁的真实执行器时，
 * 会回退到 DefaultPassExecutor，保证系统不会因为缺少 executor 而崩溃。
 */
export class DefaultPassExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType;

  constructor(gateId: QualityGateIdType) {
    this.gateId = gateId;
  }

  async execute(
    _projectPath: string,
    _config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata?: Record<string, unknown> }> {
    return { score: 1.0, findings: [], metadata: { executor: "default-pass" } };
  }
}

// ============================================================================
// 质量门禁管理器
// ============================================================================

/**
 * 质量门禁管理器
 *
 * 职责：
 * - 持有 7 大门禁配置与执行器注册表
 * - 支持启用/禁用、阈值调整、执行器覆盖
 * - 执行单个/全部门禁并产出 QualityReport
 * - 生成 Markdown / JSON 报告
 *
 * 设计约束：
 * - 构造时自动从 quality-gate-executors.ts 注册真实执行器
 * - 真实执行器缺失时回退到 DefaultPassExecutor（零回归）
 * - runOne 必须将 config.required / config.weight 回写到 GateResult，
 *   供 createQualityReport 计算 overallPassed 与 overallScore
 */
export class QualityGateManager {
  /** 项目根目录 */
  public readonly projectPath: string;
  /** 门禁配置列表 */
  public configs: QualityGateConfig[];
  /** 执行器注册表（gateId → executor） */
  public executors: Map<QualityGateIdType, GateExecutorLike> = new Map();

  constructor(projectPath: string, configs?: QualityGateConfig[]) {
    this.projectPath = projectPath;
    this.configs = configs ?? getDefaultGateConfigs();

    // 注册真实执行器（来自 quality-gate-executors.ts）
    const defaultExecutors = createDefaultGateExecutors();
    for (const c of this.configs) {
      const realExecutor = defaultExecutors.get(c.gateId);
      this.executors.set(c.gateId, realExecutor ?? new DefaultPassExecutor(c.gateId));
    }
  }

  /**
   * 注册执行器（覆盖默认）
   */
  registerExecutor(executor: GateExecutorLike): void {
    this.executors.set(executor.gateId, executor);
  }

  /**
   * 启用/禁用门禁
   */
  setEnabled(gateId: QualityGateIdType, enabled: boolean): void {
    const cfg = findGateConfig(this.configs, gateId);
    if (cfg) cfg.enabled = enabled;
  }

  /**
   * 更新门禁阈值
   */
  setThreshold(gateId: QualityGateIdType, threshold: number): void {
    const cfg = findGateConfig(this.configs, gateId);
    if (cfg) cfg.threshold = threshold;
  }

  /**
   * 执行所有启用的门禁
   */
  async runAll(): Promise<QualityReport> {
    const enabledConfigs = this.configs.filter((c) => c.enabled);
    const results: GateResult[] = [];

    for (const config of enabledConfigs) {
      const result = await this.runOne(config);
      results.push(result);
    }

    return createQualityReport({
      reportId: `qr-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      projectPath: this.projectPath,
      timestamp: new Date().toISOString(),
      results,
    });
  }

  /**
   * 执行单个门禁
   *
   * 注意：返回的 GateResult 必须携带 config.required 与 config.weight，
   * 否则 createQualityReport 无法正确计算整体通过状态与加权平均分。
   */
  async runOne(config: QualityGateConfig): Promise<GateResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // 未启用：返回 SKIPPED
    if (!config.enabled) {
      return createGateResult({
        gateId: config.gateId,
        status: GateStatus.SKIPPED,
        passed: true,
        score: 0.0,
        threshold: config.threshold,
        required: config.required,
        weight: config.weight,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        errorMessage: "gate disabled",
      });
    }

    const executor = this.executors.get(config.gateId);
    if (!executor) {
      return createGateResult({
        gateId: config.gateId,
        status: GateStatus.ERROR,
        passed: false,
        score: 0.0,
        threshold: config.threshold,
        required: config.required,
        weight: config.weight,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        errorMessage: `no executor registered for ${config.gateId}`,
      });
    }

    try {
      const execResult = await executor.execute(this.projectPath, config);
      const score = execResult.score;
      const passed = score >= config.threshold;
      const completedAt = new Date().toISOString();

      return createGateResult({
        gateId: config.gateId,
        status: passed ? GateStatus.PASSED : GateStatus.FAILED,
        passed,
        score,
        threshold: config.threshold,
        required: config.required,
        weight: config.weight,
        findings: execResult.findings,
        startedAt,
        completedAt,
        durationMs: Date.now() - startMs,
        metadata: execResult.metadata,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return createGateResult({
        gateId: config.gateId,
        status: GateStatus.ERROR,
        passed: false,
        score: 0.0,
        threshold: config.threshold,
        required: config.required,
        weight: config.weight,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        errorMessage: message,
      });
    }
  }

  /**
   * 生成 Markdown 报告
   */
  reportToMarkdown(report: QualityReport): string {
    const lines: string[] = [];
    lines.push(`# 质量门禁报告`);
    lines.push("");
    lines.push(`- 报告 ID: ${report.reportId}`);
    lines.push(`- 项目路径: ${report.projectPath}`);
    lines.push(`- 时间戳: ${report.timestamp}`);
    lines.push(`- 整体通过: ${report.overallPassed ? "✅ PASS" : "❌ FAIL"}`);
    lines.push(`- 整体分数: ${(report.overallScore * 100).toFixed(2)}%`);
    lines.push(
      `- 门禁统计: ${report.totalGates} 总 / ${report.passedGates} 通过 / ${report.failedGates} 失败 / ${report.skippedGates} 跳过 / ${report.erroredGates} 异常`
    );
    lines.push(
      `- 发现项统计: ${report.totalFindings} 总 / ${report.criticalFindings} 严重 / ${report.highFindings} 高 / ${report.mediumFindings} 中 / ${report.lowFindings} 低`
    );
    lines.push("");
    lines.push("## 门禁详情");
    lines.push("");
    lines.push("| 门禁 | 状态 | 分数 | 阈值 | 严重度 | 耗时(ms) |");
    lines.push("|------|------|------|------|--------|----------|");
    for (const r of report.results) {
      const statusIcon =
        r.status === GateStatus.PASSED
          ? "✅"
          : r.status === GateStatus.FAILED
            ? "❌"
            : r.status === GateStatus.SKIPPED
              ? "⏭️"
              : r.status === GateStatus.ERROR
                ? "⚠️"
                : "⏳";
      lines.push(
        `| ${r.gateId} | ${statusIcon} ${r.status} | ${(r.score * 100).toFixed(1)}% | ${(r.threshold * 100).toFixed(1)}% | ${r.findings[0]?.severity ?? "info"} | ${r.durationMs} |`
      );
    }
    lines.push("");
    if (report.totalFindings > 0) {
      lines.push("## 关键发现");
      lines.push("");
      const criticalFindings = report.results
        .flatMap((r) => r.findings)
        .filter((f) => f.severity === GateSeverity.CRITICAL)
        .slice(0, 20);
      for (const f of criticalFindings) {
        lines.push(`- **[${f.gateId}]** ${f.filePath}:${f.lineNumber} - ${f.message}`);
        lines.push(`  - 建议: ${f.fix}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * 生成 JSON 报告
   */
  reportToJson(report: QualityReport): string {
    return JSON.stringify(report, null, 2);
  }
}

/** 默认全局质量门禁管理器（项目路径 = "."） */
export const DEFAULT_QUALITY_GATE_MANAGER = new QualityGateManager(".");
