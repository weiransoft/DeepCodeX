/**
 * 质量门禁系统（Quality Gates）
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
 * 作者：trae-multi-agent 融合 Phase 1（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

// ============================================================================
// 门禁 ID 与类别
// ============================================================================

/** 质量门禁 ID 枚举 */
export const QualityGateId = {
  CODE_REVIEW: "code-review",
  TEST_COVERAGE: "test-coverage",
  SPEC_COMPLIANCE: "spec-compliance",
  SECURITY_SCAN: "security-scan",
  PONYTAIL_REDLINES: "ponytail-redlines",
  KARPATHY_PRINCIPLES: "karpathy-principles",
  UIUX_VISUAL: "uiux-visual",
} as const;

export type QualityGateIdType = (typeof QualityGateId)[keyof typeof QualityGateId];

/** 所有门禁 ID */
export const ALL_QUALITY_GATE_IDS: readonly QualityGateIdType[] = [
  QualityGateId.CODE_REVIEW,
  QualityGateId.TEST_COVERAGE,
  QualityGateId.SPEC_COMPLIANCE,
  QualityGateId.SECURITY_SCAN,
  QualityGateId.PONYTAIL_REDLINES,
  QualityGateId.KARPATHY_PRINCIPLES,
  QualityGateId.UIUX_VISUAL,
];

/** 校验门禁 ID */
export function isValidQualityGateId(id: string): id is QualityGateIdType {
  return (ALL_QUALITY_GATE_IDS as readonly string[]).includes(id);
}

// ============================================================================
// 严重程度
// ============================================================================

/** 严重程度 */
export const GateSeverity = {
  CRITICAL: "critical", // 必须通过，否则整体 FAIL
  HIGH: "high", // 高优先级门禁
  MEDIUM: "medium", // 中等优先级
  LOW: "low", // 低优先级（信息性）
} as const;

export type GateSeverityType = (typeof GateSeverity)[keyof typeof GateSeverity];

// ============================================================================
// 门禁状态
// ============================================================================

/** 门禁执行状态 */
export const GateStatus = {
  PENDING: "pending", // 待执行
  RUNNING: "running", // 执行中
  PASSED: "passed", // 通过
  FAILED: "failed", // 失败
  SKIPPED: "skipped", // 跳过（disabled）
  ERROR: "error", // 执行异常
} as const;

export type GateStatusType = (typeof GateStatus)[keyof typeof GateStatus];

// ============================================================================
// 异常类
// ============================================================================

/** 质量门禁基础异常 */
export class QualityGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityGateError";
  }
}

/** 门禁配置异常 */
export class GateConfigError extends QualityGateError {
  constructor(message: string) {
    super(message);
    this.name = "GateConfigError";
  }
}

// ============================================================================
// 数据结构
// ============================================================================

/** 门禁配置 */
export interface QualityGateConfig {
  gateId: QualityGateIdType;
  name: string;
  description: string;
  severity: GateSeverityType;
  required: boolean;
  /** 阈值（覆盖率/SSIM 等数值类门禁） */
  threshold: number;
  /** 权重（用于加权评分） */
  weight: number;
  /** 是否启用 */
  enabled: boolean;
  /** 关联检查器名称（运行时查找） */
  checker: string;
  /** 自定义参数（透传给 checker） */
  params: Record<string, unknown>;
}

/**
 * 创建门禁配置
 */
export function createQualityGateConfig(args: {
  gateId: QualityGateIdType;
  name: string;
  description: string;
  severity?: GateSeverityType;
  required?: boolean;
  threshold?: number;
  weight?: number;
  enabled?: boolean;
  checker?: string;
  params?: Record<string, unknown>;
}): QualityGateConfig {
  return {
    gateId: args.gateId,
    name: args.name,
    description: args.description,
    severity: args.severity ?? GateSeverity.HIGH,
    required: args.required ?? true,
    threshold: args.threshold ?? 0.0,
    weight: args.weight ?? 1.0,
    enabled: args.enabled ?? true,
    checker: args.checker ?? "default_checker",
    params: args.params ?? {},
  };
}

/** 门禁配置转字典 */
export function qualityGateConfigToDict(c: QualityGateConfig): Record<string, unknown> {
  return {
    gateId: c.gateId,
    name: c.name,
    description: c.description,
    severity: c.severity,
    required: c.required,
    threshold: c.threshold,
    weight: c.weight,
    enabled: c.enabled,
    checker: c.checker,
    params: c.params,
  };
}

/** 单条门禁违规/问题 */
export interface GateFinding {
  findingId: string;
  gateId: QualityGateIdType;
  rule: string;
  message: string;
  severity: GateSeverityType;
  filePath: string;
  lineNumber: number;
  evidence: string;
  fix: string;
}

/**
 * 创建门禁发现项
 */
export function createGateFinding(args: {
  findingId?: string;
  gateId: QualityGateIdType;
  rule: string;
  message: string;
  severity: GateSeverityType;
  filePath: string;
  lineNumber: number;
  evidence: string;
  fix: string;
}): GateFinding {
  // 简单 ID 生成（时间戳 + 随机）
  const id = args.findingId ?? `${args.gateId}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return {
    findingId: id,
    gateId: args.gateId,
    rule: args.rule,
    message: args.message,
    severity: args.severity,
    filePath: args.filePath,
    lineNumber: args.lineNumber,
    evidence: args.evidence,
    fix: args.fix,
  };
}

/** 门禁执行结果 */
export interface GateResult {
  gateId: QualityGateIdType;
  status: GateStatusType;
  passed: boolean;
  score: number;
  threshold: number;
  findings: GateFinding[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorMessage: string;
  metadata: Record<string, unknown>;
}

/**
 * 创建门禁执行结果
 */
export function createGateResult(args: {
  gateId: QualityGateIdType;
  status: GateStatusType;
  passed: boolean;
  score: number;
  threshold: number;
  findings?: GateFinding[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}): GateResult {
  return {
    gateId: args.gateId,
    status: args.status,
    passed: args.passed,
    score: args.score,
    threshold: args.threshold,
    findings: args.findings ?? [],
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    durationMs: args.durationMs,
    errorMessage: args.errorMessage ?? "",
    metadata: args.metadata ?? {},
  };
}

/** 整体质量报告 */
export interface QualityReport {
  reportId: string;
  projectPath: string;
  timestamp: string;
  overallPassed: boolean;
  overallScore: number;
  totalGates: number;
  passedGates: number;
  failedGates: number;
  skippedGates: number;
  erroredGates: number;
  results: GateResult[];
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
}

/**
 * 创建质量报告
 */
export function createQualityReport(args: {
  reportId: string;
  projectPath: string;
  timestamp: string;
  results: GateResult[];
}): QualityReport {
  const passedGates = args.results.filter((r) => r.passed).length;
  const failedGates = args.results.filter((r) => r.status === GateStatus.FAILED).length;
  const skippedGates = args.results.filter((r) => r.status === GateStatus.SKIPPED).length;
  const erroredGates = args.results.filter((r) => r.status === GateStatus.ERROR).length;

  // 整体通过条件：所有 required 门禁必须 passed，且无 ERROR
  const requiredAllPassed = args.results
    .filter((r) => {
      // 只看 enabled 且非 skipped 的门禁
      return r.status !== GateStatus.SKIPPED;
    })
    .every((r) => r.passed && r.status !== GateStatus.ERROR);

  // 整体分数（加权平均）
  let totalWeight = 0;
  let weightedScore = 0;
  for (const r of args.results) {
    totalWeight += 1.0; // 默认权重 1.0
    weightedScore += r.score;
  }
  const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  let totalFindings = 0;
  let criticalFindings = 0;
  let highFindings = 0;
  let mediumFindings = 0;
  let lowFindings = 0;
  for (const r of args.results) {
    totalFindings += r.findings.length;
    for (const f of r.findings) {
      if (f.severity === GateSeverity.CRITICAL) criticalFindings++;
      else if (f.severity === GateSeverity.HIGH) highFindings++;
      else if (f.severity === GateSeverity.MEDIUM) mediumFindings++;
      else if (f.severity === GateSeverity.LOW) lowFindings++;
    }
  }

  return {
    reportId: args.reportId,
    projectPath: args.projectPath,
    timestamp: args.timestamp,
    overallPassed: requiredAllPassed,
    overallScore: Math.round(overallScore * 10000) / 10000,
    totalGates: args.results.length,
    passedGates,
    failedGates,
    skippedGates,
    erroredGates,
    results: args.results,
    totalFindings,
    criticalFindings,
    highFindings,
    mediumFindings,
    lowFindings,
  };
}

// ============================================================================
// 默认门禁配置
// ============================================================================

/**
 * 默认 7 大门禁配置（与 multi-agent-team skill-manifest-example.yaml 1:1 对应）
 */
export const DEFAULT_GATE_CONFIGS: readonly QualityGateConfig[] = [
  createQualityGateConfig({
    gateId: QualityGateId.CODE_REVIEW,
    name: "代码审查",
    description: "所有代码必须经过多角色团队的代码审查（架构师 + 测试专家）",
    severity: GateSeverity.HIGH,
    required: true,
    threshold: 1.0,
    weight: 1.0,
    enabled: true,
    checker: "code_review_checker",
    params: {
      requiredRoles: ["architect", "test-expert"],
      minApprovals: 2,
    },
  }),
  createQualityGateConfig({
    gateId: QualityGateId.TEST_COVERAGE,
    name: "测试覆盖",
    description: "测试覆盖率（行/分支）必须达到 80% 阈值",
    severity: GateSeverity.CRITICAL,
    required: true,
    threshold: 0.8,
    weight: 1.5,
    enabled: true,
    checker: "test_coverage_checker",
    params: {
      lineThreshold: 0.8,
      branchThreshold: 0.7,
      excludePatterns: ["tests/", "test_", "_test.ts", "*.d.ts", "node_modules/"],
    },
  }),
  createQualityGateConfig({
    gateId: QualityGateId.SPEC_COMPLIANCE,
    name: "规范一致性",
    description: "代码必须符合项目规范（命名、目录、注释、依赖管理）",
    severity: GateSeverity.HIGH,
    required: true,
    threshold: 1.0,
    weight: 1.0,
    enabled: true,
    checker: "spec_compliance_checker",
    params: {
      naming: "kebab-case",
      requireZhComments: true,
      requireTodoResolution: true,
      requireFixmeResolution: true,
    },
  }),
  createQualityGateConfig({
    gateId: QualityGateId.SECURITY_SCAN,
    name: "安全检查",
    description: "代码必须通过安全扫描（SAST、依赖漏洞、敏感信息泄露）",
    severity: GateSeverity.CRITICAL,
    required: true,
    threshold: 1.0,
    weight: 2.0,
    enabled: true,
    checker: "security_scanner",
    params: {
      sastEnabled: true,
      dependencyCheck: true,
      secretScan: true,
      severityThreshold: GateSeverity.HIGH,
    },
  }),
  createQualityGateConfig({
    gateId: QualityGateId.PONYTAIL_REDLINES,
    name: "Ponytail 红线检查",
    description: "检查 16 条不可简化红线（真实业务、输入校验、错误处理、并发安全等）",
    severity: GateSeverity.CRITICAL,
    required: true,
    threshold: 1.0,
    weight: 1.5,
    enabled: true,
    checker: "ponytail_redline_checker",
    params: {
      redLineCount: 16,
      checkProjectRules: true,
    },
  }),
  createQualityGateConfig({
    gateId: QualityGateId.KARPATHY_PRINCIPLES,
    name: "Karpathy 四大原则",
    description: "检查 Karpathy 四大核心原则（Think/Simplicity/Surgical/Goal）合规性",
    severity: GateSeverity.HIGH,
    required: true,
    threshold: 0.9,
    weight: 1.2,
    enabled: true,
    checker: "karpathy_principle_enforcer",
    params: {
      principles: ["think_before_coding", "simplicity_first", "surgical_changes", "goal_driven"],
    },
  }),
  createQualityGateConfig({
    gateId: QualityGateId.UIUX_VISUAL,
    name: "UI/UX 视觉巡检",
    description: "UI/UX 巡检 + 视觉回归（仅在启用 UI 时执行）",
    severity: GateSeverity.MEDIUM,
    required: false,
    threshold: 0.85,
    weight: 0.8,
    enabled: false, // 默认关闭，由 team.enableUIUXAudit 开启
    checker: "uiux_visual_audit",
    params: {
      auditDimensions: ["a11y", "interaction", "layout", "ux"],
      visualDiff: true,
      ssimThreshold: 0.9,
    },
  }),
];

/** 获取默认门禁配置（深拷贝） */
export function getDefaultGateConfigs(): QualityGateConfig[] {
  return DEFAULT_GATE_CONFIGS.map((c) => ({
    ...c,
    params: { ...c.params },
  }));
}

/** 根据 ID 查找门禁配置 */
export function findGateConfig(
  configs: readonly QualityGateConfig[],
  gateId: QualityGateIdType
): QualityGateConfig | null {
  for (const c of configs) {
    if (c.gateId === gateId) return c;
  }
  return null;
}

// ============================================================================
// 门禁执行器
// ============================================================================

/**
 * 门禁执行器接口（运行时注入真实实现）
 */
export interface GateExecutorLike {
  /** 门禁 ID */
  gateId: QualityGateIdType;
  /**
   * 执行门禁检查
   * @param projectPath 项目根目录
   * @param config 门禁配置
   * @returns 执行结果（包含 findings + score）
   */
  execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata?: Record<string, unknown> }>;
}

/** 默认占位执行器：始终返回 PASS（用于骨架/无实现场景） */
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

/** 质量门禁管理器 */
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

    // 注册默认占位执行器
    for (const c of this.configs) {
      this.executors.set(c.gateId, new DefaultPassExecutor(c.gateId));
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
