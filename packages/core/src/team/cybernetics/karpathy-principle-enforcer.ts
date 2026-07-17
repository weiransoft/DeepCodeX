/**
 * Karpathy Principle Enforcer - 四大核心原则执行检查器
 *
 * 来源：multi-agent-team skill scripts/karpathy_principle_enforcer.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 职责：在代码审查和任务执行过程中强制执行 Karpathy 四大核心原则：
 * 1. Think Before Coding（三思而后行）
 * 2. Simplicity First（简单优先）
 * 3. Surgical Changes（精准修改）
 * 4. Goal-Driven Execution（目标驱动执行）
 *
 * 提供：
 * - 原则合规性检查
 * - 违规检测与提醒（含 Ponytail 决策梯检测模式）
 * - 验证检查点管理
 * - 执行报告生成（Markdown 格式）
 *
 * 作者：trae-multi-agent 融合 Phase 2（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

// 显式 ESM 导入 node:fs 和 node:path，避免在 ESM 模块中使用 require 失败
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

// ============================================================================
// 枚举：原则类型与严重程度
// ============================================================================

/**
 * Karpathy 原则类型
 */
export const PrincipleType = {
  THINK_BEFORE_CODING: "think_before_coding",
  SIMPLICITY_FIRST: "simplicity_first",
  SURGICAL_CHANGES: "surgical_changes",
  GOAL_DRIVEN: "goal_driven",
} as const;

export type PrincipleTypeType = (typeof PrincipleType)[keyof typeof PrincipleType];

/** 所有原则类型 */
export const ALL_PRINCIPLE_TYPES: readonly PrincipleTypeType[] = [
  PrincipleType.THINK_BEFORE_CODING,
  PrincipleType.SIMPLICITY_FIRST,
  PrincipleType.SURGICAL_CHANGES,
  PrincipleType.GOAL_DRIVEN,
];

/** 校验原则类型 */
export function isValidPrincipleType(p: string): p is PrincipleTypeType {
  return (ALL_PRINCIPLE_TYPES as readonly string[]).includes(p);
}

/**
 * 违规严重程度
 */
export const ViolationSeverity = {
  CRITICAL: "critical", // 严重违规，必须立即修复
  HIGH: "high", // 高风险违规，需要修复
  MEDIUM: "medium", // 中等风险，建议修复
  LOW: "low", // 低风险，可以优化
  INFO: "info", // 提示信息
} as const;

export type ViolationSeverityType = (typeof ViolationSeverity)[keyof typeof ViolationSeverity];

/** 严重程度排序（值越大越严重） */
export const SEVERITY_ORDER: Record<ViolationSeverityType, number> = {
  [ViolationSeverity.CRITICAL]: 4,
  [ViolationSeverity.HIGH]: 3,
  [ViolationSeverity.MEDIUM]: 2,
  [ViolationSeverity.LOW]: 1,
  [ViolationSeverity.INFO]: 0,
};

/** 所有严重程度 */
export const ALL_VIOLATION_SEVERITIES: readonly ViolationSeverityType[] = [
  ViolationSeverity.CRITICAL,
  ViolationSeverity.HIGH,
  ViolationSeverity.MEDIUM,
  ViolationSeverity.LOW,
  ViolationSeverity.INFO,
];

// ============================================================================
// 异常类
// ============================================================================

/** Karpathy 执行器基础异常 */
export class KarpathyPrincipleEnforcerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KarpathyPrincipleEnforcerError";
  }
}

// ============================================================================
// 违规模式定义
// ============================================================================

/**
 * 违规模式定义
 */
export interface ViolationPattern {
  pattern: RegExp;
  severity: ViolationSeverityType;
  description: string;
  suggestion: string;
  /** 文件白名单：路径包含这些字符串时不检测该模式（如 tests/） */
  file_whitelist?: string[];
  /** 上下文白名单：匹配行前后 5 行包含这些字符串时不报告 */
  context_whitelist?: string[];
}

/**
 * 违规模式定义表（v2 修订：含 Ponytail 决策梯相关检测模式）
 */
export const VIOLATION_PATTERNS: Record<PrincipleTypeType, ViolationPattern[]> = {
  // 原则 1：Think Before Coding
  [PrincipleType.THINK_BEFORE_CODING]: [
    {
      pattern: /\b(TODO|FIXME|HACK|XXX)\b/,
      severity: ViolationSeverity.MEDIUM,
      description: "发现 TODO/FIXME/HACK 标记，可能存在未明确的假设或临时方案",
      suggestion: "在编码前明确所有假设，移除临时方案，使用明确的实现",
    },
    {
      pattern: /#.*假设|#.*assume|#.*可能|#.*maybe/i,
      severity: ViolationSeverity.LOW,
      description: "发现未验证的假设注释",
      suggestion: "将假设转化为明确的验证逻辑或文档化",
    },
  ],

  // 原则 2：Simplicity First（含 Ponytail YAGNI 违规检测）
  [PrincipleType.SIMPLICITY_FIRST]: [
    {
      pattern: /class\s+\w*(Factory|Builder|Strategy)\b/,
      severity: ViolationSeverity.LOW,
      description: "发现复杂的设计模式使用，可能过度设计",
      suggestion: "评估是否真的需要这些模式，优先考虑简单函数",
    },
    {
      pattern: /#.*以后|#.*future|#.*预留|#.*reserve/i,
      severity: ViolationSeverity.HIGH,
      description: "发现为未来预留的代码（speculative code）",
      suggestion: "删除未使用的代码，只在需要时添加",
    },
    {
      pattern: /interface\s+\w+\s*\{|abstract\s+class\s+\w+/,
      severity: ViolationSeverity.LOW,
      description: "发现抽象类或接口，评估是否必要",
      suggestion: "确保抽象有实际用途，避免为抽象而抽象",
    },
    // 【Ponytail】YAGNI 违规：创建了未被要求的抽象类（带 ponytail 标记的除外）
    {
      pattern: /class\s+\w*(Manager|Handler|Controller|Service)\b.*#\s*ponytail/,
      severity: ViolationSeverity.MEDIUM,
      description: "疑似 YAGNI 违规：创建了未被要求的抽象类（带 ponytail 标记）",
      suggestion: "评估是否真的需要这个抽象类，如果不需要则删除",
    },
    // 【Ponytail】新增不必要依赖检测
    {
      pattern: /(import|from)\s+\w+.*#\s*ponytail:\s*new\s+dep/,
      severity: ViolationSeverity.HIGH,
      description: "疑似新增不必要依赖（ponytail: new dep 标记）",
      suggestion: "复用现有依赖，绝不为几行能搞定的事新增依赖",
    },
  ],

  // 原则 3：Surgical Changes（含 Ponytail 占位代码检测）
  [PrincipleType.SURGICAL_CHANGES]: [
    {
      pattern: /pass\s*#\s*(占位|placeholder|TODO)/i,
      severity: ViolationSeverity.CRITICAL,
      description: "发现占位符代码（mock/占位/简化实现）",
      suggestion: "严禁使用占位符，必须实现真实逻辑",
    },
    {
      pattern: /\b(mock|Mock|stub|Stub)\b/,
      severity: ViolationSeverity.HIGH,
      description: "发现 mock/stub 代码，可能不是真实实现",
      suggestion: "在生产代码中移除 mock，使用真实实现",
      file_whitelist: ["tests/", "test_", "_test.", "conftest."],
    },
    {
      pattern: /#.*顺手|#.*顺便|#.*改.*其他/,
      severity: ViolationSeverity.MEDIUM,
      description: "发现可能涉及无关修改的注释",
      suggestion: "只修改直接相关的代码，不碰无关功能",
    },
    // 【Ponytail】占位代码检测（无 ponytail 标记的 pass）
    {
      pattern: /^\s*pass\s*$/,
      severity: ViolationSeverity.LOW,
      description: "疑似占位代码（pass 无 ponytail 标记）",
      suggestion: "如果是故意简化，标记 # ponytail: <说明>；否则实现真实逻辑",
      context_whitelist: ["class ", "def ", "except", "try:"],
    },
    // 【Ponytail】红线违规：真实业务逻辑被 mock 替代
    {
      pattern: /from\s+unittest\.mock\s+import\s+Mock/,
      severity: ViolationSeverity.CRITICAL,
      description: "真实业务逻辑被 mock 替代（红线违规）",
      suggestion: "生产代码禁止用 mock/占位/stub 替代真实业务逻辑",
      file_whitelist: ["tests/", "test_", "_test.", "conftest."],
    },
  ],

  // 原则 4：Goal-Driven Execution
  [PrincipleType.GOAL_DRIVEN]: [
    {
      pattern: /def\s+test\w*\s*\(.*\):\s*$/,
      severity: ViolationSeverity.CRITICAL,
      description: "发现空的测试函数签名（待检查实现）",
      suggestion: "为所有功能编写完整的测试用例",
    },
    {
      pattern: /#.*未测试|#.*未验证|#.*跳过/,
      severity: ViolationSeverity.HIGH,
      description: "发现未测试或未验证的代码标记",
      suggestion: "为代码添加完整的测试和验证",
    },
    {
      pattern: /\bprint\(|\bconsole\.log\(|\blogger\.debug\(/,
      severity: ViolationSeverity.LOW,
      description: "发现调试输出，可能影响生产环境",
      suggestion: "移除调试代码，使用正式的日志机制",
    },
  ],
};

// ============================================================================
// 数据结构
// ============================================================================

/**
 * 原则违规记录
 */
export interface PrincipleViolation {
  principle: PrincipleTypeType;
  severity: ViolationSeverityType;
  file_path: string;
  line_number: number;
  description: string;
  suggestion: string;
  evidence: string;
}

/** 创建 PrincipleViolation */
export function createPrincipleViolation(args: {
  principle: PrincipleTypeType;
  severity: ViolationSeverityType;
  file_path: string;
  line_number: number;
  description: string;
  suggestion: string;
  evidence: string;
}): PrincipleViolation {
  return {
    principle: args.principle,
    severity: args.severity,
    file_path: args.file_path,
    line_number: args.line_number,
    description: args.description,
    suggestion: args.suggestion,
    evidence: args.evidence,
  };
}

/** PrincipleViolation 转字典 */
export function principleViolationToDict(v: PrincipleViolation): Record<string, unknown> {
  return {
    principle: v.principle,
    severity: v.severity,
    file_path: v.file_path,
    line_number: v.line_number,
    description: v.description,
    suggestion: v.suggestion,
    evidence: v.evidence,
  };
}

/**
 * 验证检查点
 */
export interface VerificationCheckpoint {
  checkpoint_id: string;
  principle: PrincipleTypeType;
  description: string;
  criteria: string[];
  verified: boolean;
  verified_at: string | null;
  verified_by: string;
  notes: string;
}

/** 创建 VerificationCheckpoint */
export function createVerificationCheckpoint(args: {
  checkpoint_id: string;
  principle: PrincipleTypeType;
  description: string;
  criteria: string[];
  verified?: boolean;
  verified_at?: string | null;
  verified_by?: string;
  notes?: string;
}): VerificationCheckpoint {
  return {
    checkpoint_id: args.checkpoint_id,
    principle: args.principle,
    description: args.description,
    criteria: args.criteria,
    verified: args.verified ?? false,
    verified_at: args.verified_at ?? null,
    verified_by: args.verified_by ?? "",
    notes: args.notes ?? "",
  };
}

/** VerificationCheckpoint 转字典 */
export function verificationCheckpointToDict(cp: VerificationCheckpoint): Record<string, unknown> {
  return {
    checkpoint_id: cp.checkpoint_id,
    principle: cp.principle,
    description: cp.description,
    criteria: cp.criteria,
    verified: cp.verified,
    verified_at: cp.verified_at,
    verified_by: cp.verified_by,
    notes: cp.notes,
  };
}

/**
 * Karpathy 原则执行报告
 */
export interface KarpathyEnforcementReport {
  report_id: string;
  project_path: string;
  timestamp: string;
  violations: PrincipleViolation[];
  checkpoints: VerificationCheckpoint[];
  summary: Record<string, unknown>;
}

/** KarpathyEnforcementReport 转字典 */
export function karpathyEnforcementReportToDict(r: KarpathyEnforcementReport): Record<string, unknown> {
  return {
    report_id: r.report_id,
    project_path: r.project_path,
    timestamp: r.timestamp,
    violations: r.violations.map(principleViolationToDict),
    checkpoints: r.checkpoints.map(verificationCheckpointToDict),
    summary: r.summary,
  };
}

// ============================================================================
// 文件系统抽象（与 feedback-control-loop 兼容）
// ============================================================================

/** 文件系统抽象接口 */
export interface KarpathyFileSystemLike {
  exists(path: string): boolean;
  readFile(path: string): string;
  listFiles(dir: string, extension: string): string[];
  isDirectory(path: string): boolean;
}

/** Node.js 文件系统实现 */
export class KarpathyNodeFileSystem implements KarpathyFileSystemLike {
  // 使用 ESM 导入的 node:fs（nodeFs），避免在 ESM 模式下 require 未定义
  private _fs: typeof import("node:fs") = nodeFs;
  // 使用 ESM 导入的 node:path（nodePath），避免在 ESM 模式下 require 未定义
  private _path: typeof import("node:path") = nodePath;

  exists(path: string): boolean {
    try {
      this._fs.accessSync(path);
      return true;
    } catch {
      return false;
    }
  }

  readFile(path: string): string {
    return this._fs.readFileSync(path, "utf-8");
  }

  listFiles(dir: string, extension: string): string[] {
    if (!this.exists(dir) || !this.isDirectory(dir)) {
      return [];
    }
    const all = this._fs.readdirSync(dir);
    return all.filter((f) => f.endsWith(extension));
  }

  isDirectory(path: string): boolean {
    try {
      const stat = this._fs.statSync(path);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 递归列出目录中指定扩展名的所有文件
   */
  listFilesRecursive(root: string, extension: string, skipDirs: string[] = []): string[] {
    const results: string[] = [];
    if (!this.exists(root) || !this.isDirectory(root)) {
      return results;
    }
    const entries = this._fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = this._path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.some((d) => entry.name === d)) {
          continue;
        }
        results.push(...this.listFilesRecursive(full, extension, skipDirs));
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        results.push(full);
      }
    }
    return results;
  }
}

// ============================================================================
// KarpathyPrincipleEnforcer 主类
// ============================================================================

/**
 * Karpathy 执行检查器配置
 */
export interface KarpathyPrincipleEnforcerConfig {
  project_root: string;
  fs?: KarpathyFileSystemLike;
}

/**
 * Karpathy 四大核心原则执行检查器
 *
 * 用于在代码审查和任务执行过程中强制执行 Karpathy 原则。
 */
export class KarpathyPrincipleEnforcer {
  public project_root: string;
  public violations: PrincipleViolation[] = [];
  public checkpoints: VerificationCheckpoint[] = [];
  private _fs: KarpathyFileSystemLike;
  /** 递归时跳过的目录 */
  private static readonly SKIP_DIRS = ["node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build"];

  constructor(config: KarpathyPrincipleEnforcerConfig) {
    this.project_root = config.project_root;
    this._fs = config.fs ?? new KarpathyNodeFileSystem();
    this._initDefaultCheckpoints();
  }

  /**
   * 初始化默认验证检查点
   */
  private _initDefaultCheckpoints(): void {
    this.checkpoints = [
      createVerificationCheckpoint({
        checkpoint_id: "cp_think_1",
        principle: PrincipleType.THINK_BEFORE_CODING,
        description: "需求理解检查点",
        criteria: ["已明确所有业务需求", "已识别所有技术约束", "已确认输入输出边界", "已文档化所有假设"],
      }),
      createVerificationCheckpoint({
        checkpoint_id: "cp_think_2",
        principle: PrincipleType.THINK_BEFORE_CODING,
        description: "方案评估检查点",
        criteria: ["已评估至少 2 种实现方案", "已明确各方案的权衡", "已选择最简单的可行方案"],
      }),
      createVerificationCheckpoint({
        checkpoint_id: "cp_simple_1",
        principle: PrincipleType.SIMPLICITY_FIRST,
        description: "简单性检查点",
        criteria: ["无单次使用的抽象", "无 speculative features", "无未来可能用到的代码", "代码量最小化"],
      }),
      createVerificationCheckpoint({
        checkpoint_id: "cp_surgical_1",
        principle: PrincipleType.SURGICAL_CHANGES,
        description: "精准修改检查点",
        criteria: ["只修改直接相关的代码", "保持原有代码风格一致", "未修改无关功能", "无格式化混杂"],
      }),
      createVerificationCheckpoint({
        checkpoint_id: "cp_goal_1",
        principle: PrincipleType.GOAL_DRIVEN,
        description: "目标定义检查点",
        criteria: ["已定义明确的成功标准", "已设定可验证的指标", "已确定完成边界"],
      }),
      createVerificationCheckpoint({
        checkpoint_id: "cp_goal_2",
        principle: PrincipleType.GOAL_DRIVEN,
        description: "验证完成检查点",
        criteria: ["所有测试用例通过", "代码审查通过", "功能符合需求", "无已知缺陷"],
      }),
    ];
  }

  /**
   * 扫描单个文件的违规情况
   *
   * 支持 file_whitelist 和 context_whitelist：
   * - file_whitelist: 文件路径包含这些字符串时不检测该模式
   * - context_whitelist: 匹配行前后 5 行包含这些字符串时不报告
   */
  scanFile(file_path: string): PrincipleViolation[] {
    const violations: PrincipleViolation[] = [];

    if (!this._fs.exists(file_path)) {
      return violations;
    }

    try {
      const content = this._fs.readFile(file_path);
      const lines = content.split(/\r?\n/);
      const file_path_str = file_path;

      for (const [principle, patterns] of Object.entries(VIOLATION_PATTERNS) as Array<
        [PrincipleTypeType, ViolationPattern[]]
      >) {
        for (const pattern_def of patterns) {
          // 文件白名单检查
          if (pattern_def.file_whitelist) {
            if (pattern_def.file_whitelist.some((wl) => file_path_str.includes(wl))) {
              continue;
            }
          }

          for (let line_num = 0; line_num < lines.length; line_num++) {
            const line = lines[line_num] ?? "";
            if (pattern_def.pattern.test(line)) {
              // 上下文白名单检查：匹配行前后 5 行
              if (pattern_def.context_whitelist) {
                const ctx_start = Math.max(0, line_num - 5);
                const ctx_end = Math.min(lines.length, line_num + 5);
                const context_text = lines.slice(ctx_start, ctx_end).join("\n");
                if (pattern_def.context_whitelist.some((wl) => context_text.includes(wl))) {
                  continue;
                }
              }

              // 获取上下文（前后各 2 行）
              const start = Math.max(0, line_num - 3);
              const end = Math.min(lines.length, line_num + 2);
              const evidence = lines.slice(start, end).join("\n");

              violations.push(
                createPrincipleViolation({
                  principle,
                  severity: pattern_def.severity,
                  file_path: file_path,
                  line_number: line_num + 1,
                  description: pattern_def.description,
                  suggestion: pattern_def.suggestion,
                  evidence,
                })
              );
            }
          }
        }
      }
    } catch (e) {
      // 扫描失败时静默忽略（与原 Python 行为一致：print 错误但不抛）
      const message = e instanceof Error ? e.message : String(e);

      console.error(`扫描文件失败 ${file_path}: ${message}`);
    }

    // 同步到 this.violations（保持 hasCriticalViolations / getViolationsByPrinciple 等查询方法可用）
    this.violations.push(...violations);
    return violations;
  }

  /**
   * 扫描整个项目的违规情况
   */
  scanProject(file_extensions?: string[]): PrincipleViolation[] {
    if (!file_extensions) {
      file_extensions = [".py", ".java", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".c", ".cpp"];
    }

    const all_violations: PrincipleViolation[] = [];

    for (const ext of file_extensions) {
      // 使用 NodeFileSystem 的递归扫描
      const fs_with_recursive = this._fs as KarpathyFileSystemLike & {
        listFilesRecursive?: (root: string, ext: string, skipDirs: string[]) => string[];
      };
      let files: string[];
      if (fs_with_recursive.listFilesRecursive) {
        files = fs_with_recursive.listFilesRecursive(this.project_root, ext, [...KarpathyPrincipleEnforcer.SKIP_DIRS]);
      } else {
        // 退化方案：只扫描根目录
        files = this._fs.listFiles(this.project_root, ext);
      }

      for (const file_path of files) {
        const violations = this.scanFile(file_path);
        all_violations.push(...violations);
      }
    }

    this.violations = all_violations;
    return all_violations;
  }

  /**
   * 验证检查点
   */
  verifyCheckpoint(checkpoint_id: string, verified: boolean, verified_by: string = "", notes: string = ""): boolean {
    for (const cp of this.checkpoints) {
      if (cp.checkpoint_id === checkpoint_id) {
        cp.verified = verified;
        cp.verified_at = new Date().toISOString();
        cp.verified_by = verified_by;
        cp.notes = notes;
        return true;
      }
    }
    return false;
  }

  /**
   * 获取检查点状态
   */
  getCheckpointStatus(principle?: PrincipleTypeType): Record<string, unknown> {
    let checkpoints = this.checkpoints;
    if (principle) {
      checkpoints = checkpoints.filter((cp) => cp.principle === principle);
    }

    const total = checkpoints.length;
    const verified = checkpoints.filter((cp) => cp.verified).length;

    return {
      total,
      verified,
      pending: total - verified,
      completion_rate: total > 0 ? Math.round((verified / total) * 10000) / 100 : 0,
      checkpoints: checkpoints.map((cp) => ({
        id: cp.checkpoint_id,
        principle: cp.principle,
        description: cp.description,
        verified: cp.verified,
        verified_at: cp.verified_at,
      })),
    };
  }

  /**
   * 生成执行报告（Markdown 格式）
   */
  generateReport(output_path?: string): string {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const report_id = `KARPATHY-${new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 14)}`;

    // 统计违规
    const critical_count = this.violations.filter((v) => v.severity === ViolationSeverity.CRITICAL).length;
    const high_count = this.violations.filter((v) => v.severity === ViolationSeverity.HIGH).length;
    const medium_count = this.violations.filter((v) => v.severity === ViolationSeverity.MEDIUM).length;
    const low_count = this.violations.filter((v) => v.severity === ViolationSeverity.LOW).length;

    // 检查点状态
    const cp_status = this.getCheckpointStatus();

    const report: KarpathyEnforcementReport = {
      report_id,
      project_path: this.project_root,
      timestamp,
      violations: this.violations,
      checkpoints: this.checkpoints,
      summary: {
        total_violations: this.violations.length,
        critical: critical_count,
        high: high_count,
        medium: medium_count,
        low: low_count,
        checkpoint_completion_rate: cp_status["completion_rate"] as number,
        checkpoint_verified: cp_status["verified"] as number,
        checkpoint_total: cp_status["total"] as number,
      },
    };

    // 生成 Markdown 报告
    const severity_emoji: Record<ViolationSeverityType, string> = {
      [ViolationSeverity.CRITICAL]: "🔴",
      [ViolationSeverity.HIGH]: "🟠",
      [ViolationSeverity.MEDIUM]: "🟡",
      [ViolationSeverity.LOW]: "🟢",
      [ViolationSeverity.INFO]: "ℹ️",
    };

    let md = `# Karpathy 四大核心原则执行报告

> **报告 ID**: ${report_id}
> **项目路径**: ${this.project_root}
> **生成时间**: ${timestamp}

---

## 1. 执行摘要

### 1.1 违规统计

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| 🔴 严重 (Critical) | ${critical_count} | 必须立即修复 |
| 🟠 高 (High) | ${high_count} | 需要修复 |
| 🟡 中 (Medium) | ${medium_count} | 建议修复 |
| 🟢 低 (Low) | ${low_count} | 可以优化 |
| **总计** | **${this.violations.length}** | - |

### 1.2 检查点完成度

| 指标 | 数值 |
|------|------|
| 已验证检查点 | ${cp_status["verified"]} / ${cp_status["total"]} |
| 完成率 | ${cp_status["completion_rate"]}% |

---

## 2. 违规详情

`;

    if (this.violations.length > 0) {
      for (const principle of ALL_PRINCIPLE_TYPES) {
        const principle_violations = this.violations.filter((v) => v.principle === principle);
        if (principle_violations.length > 0) {
          md += `\n### ${getPrincipleName(principle)}\n\n`;
          for (const v of principle_violations) {
            const emoji = severity_emoji[v.severity] ?? "⚪";
            md += `
**${emoji} [${v.severity}]** ${v.description}

- **文件**: \`${v.file_path}:${v.line_number}\`
- **建议**: ${v.suggestion}

\`\`\`
${v.evidence}
\`\`\`

`;
          }
        }
      }
    } else {
      md += "\n✅ 未发现违规，代码符合 Karpathy 原则！\n";
    }

    md += `

---

## 3. 验证检查点

`;

    for (const principle of ALL_PRINCIPLE_TYPES) {
      const principle_cps = this.checkpoints.filter((cp) => cp.principle === principle);
      if (principle_cps.length > 0) {
        md += `\n### ${getPrincipleName(principle)}\n\n`;
        md += "| 检查点 | 状态 | 验证时间 | 验证人 |\n";
        md += "|--------|------|----------|--------|\n";
        for (const cp of principle_cps) {
          const status = cp.verified ? "✅ 已通过" : "⏳ 待验证";
          const verified_at = cp.verified_at ?? "-";
          const verified_by = cp.verified_by || "-";
          md += `| ${cp.description} | ${status} | ${verified_at} | ${verified_by} |\n`;
        }
      }
    }

    md += `

---

## 4. 改进建议

### 4.1 立即行动项

`;

    const critical_and_high = this.violations.filter(
      (v) => v.severity === ViolationSeverity.CRITICAL || v.severity === ViolationSeverity.HIGH
    );
    if (critical_and_high.length > 0) {
      for (const v of critical_and_high.slice(0, 10)) {
        md += `- [ ] **${v.file_path}:${v.line_number}** - ${v.description}\n`;
      }
    } else {
      md += "无立即行动项\n";
    }

    md += `

### 4.2 原则应用速查

| 场景 | 应用原则 | 具体行动 |
|------|---------|---------|
| 需求不明确 | Think Before Coding | 停下来问清楚 |
| 多种方案可选 | Think Before Coding | 呈现权衡让用户选 |
| 考虑添加抽象 | Simplicity First | 问"真的需要吗？" |
| 看到复杂代码 | Simplicity First | 简化到最小可用 |
| 修改代码 | Surgical Changes | 只改必要的行 |
| 准备提交代码 | Surgical Changes | 检查是否有多余修改 |
| 开始实现 | Goal-Driven | 定义成功标准 |
| 完成后 | Goal-Driven | 验证是否达标 |

---

*本报告由 Karpathy 原则执行检查器生成*
*生成时间: ${timestamp}*
`;

    if (output_path) {
      // 使用注入的 fs 写文件
      const fs_with_write = this._fs as KarpathyFileSystemLike & {
        writeFile?: (path: string, content: string) => void;
      };
      if (fs_with_write.writeFile) {
        fs_with_write.writeFile(output_path, md);
      } else {
        // 退化：使用 ESM 导入的 node:fs / node:path 写入
        const dir = nodePath.dirname(output_path);
        nodeFs.mkdirSync(dir, { recursive: true });
        nodeFs.writeFileSync(output_path, md, "utf-8");
      }

      console.log(`报告已保存: ${output_path}`);
    }

    return md;
  }

  /** 是否有严重违规 */
  hasCriticalViolations(): boolean {
    return this.violations.some((v) => v.severity === ViolationSeverity.CRITICAL);
  }

  /** 获取指定原则的违规列表 */
  getViolationsByPrinciple(principle: PrincipleTypeType): PrincipleViolation[] {
    return this.violations.filter((v) => v.principle === principle);
  }

  /** 获取指定严重程度的违规列表 */
  getViolationsBySeverity(severity: ViolationSeverityType): PrincipleViolation[] {
    return this.violations.filter((v) => v.severity === severity);
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/** 获取原则中文名称 */
export function getPrincipleName(principle: PrincipleTypeType): string {
  const names: Record<PrincipleTypeType, string> = {
    [PrincipleType.THINK_BEFORE_CODING]: "🧠 Think Before Coding（三思而后行）",
    [PrincipleType.SIMPLICITY_FIRST]: "🎯 Simplicity First（简单优先）",
    [PrincipleType.SURGICAL_CHANGES]: "🔬 Surgical Changes（精准修改）",
    [PrincipleType.GOAL_DRIVEN]: "✅ Goal-Driven Execution（目标驱动执行）",
  };
  return names[principle] ?? principle;
}
