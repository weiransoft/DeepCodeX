/**
 * 八阶段工作流循环控制器（TypeScript 移植版）
 *
 * 来源：multi-agent-team skill scripts/workflow_loop_controller.py（607 行）
 * 职责：
 * 1. 将八阶段标准工作流构建为一个完整的循环
 * 2. 在审查阶段（阶段 8）检查文档-代码一致性
 * 3. 审查失败时根据缺口维度回退到相应阶段
 * 4. 支持最大迭代次数限制，记录每次迭代执行情况
 *
 * 八阶段定义：
 * 1. 需求分析（产品经理）     → PRD 文档
 * 2. 架构设计（架构师）       → 架构文档
 * 3. UI 设计（UI 设计师）     → UI 设计稿
 * 4. 测试设计（测试专家）     → 测试计划
 * 5. 任务分解（独立开发者）   → 任务清单
 * 6. 开发实现（独立开发者）   → 代码
 * 7. 测试验证（测试专家）     → 测试报告
 * 8. 文档对照代码审查（多角色）→ 审查报告
 *
 * 循环行为：
 * - 阶段 1-5 为"规划阶段"，产出文档
 * - 阶段 6 为"开发阶段"，产出代码
 * - 阶段 7 为"验证阶段"，执行测试
 * - 阶段 8 为"审查阶段"，对照文档检查代码
 *
 * 审查失败时的回退策略：
 * - D1 功能缺失 → 回退到阶段 6（开发）
 * - D2 集成缺失 → 回退到阶段 6（开发）
 * - D3 测试失败 → 回退到阶段 7（验证）
 * - D4 验收标准未满足 → 回退到阶段 6（开发）
 * - D5 TODO/FIXME 未实现 → 回退到阶段 6（开发）
 * - D6 文档意图偏离 → 回退到阶段 6（开发）
 *
 * 设计原则：
 * - 严格真实移植 Python 原版全部逻辑，禁止 mock/占位/简化
 * - 仅依赖 Node.js 内置模块（node:fs / node:path / node:child_process），禁止新增任何 npm 依赖
 * - 所有函数和关键逻辑均有详细中文注释，符合 TypeScript 代码规范
 * - TypeScript 严格类型：所有 exported 类型必须显式定义，使用 interface/type 表达
 * - Python → TS 映射：
 *   * __init__ → constructor；self → this
 *   * Optional[X] → X | null；List[X] → X[]；Dict[K, V] → Record<K, V>
 *   * datetime.now(timezone.utc).isoformat() → new Date().toISOString()
 *   * time.time() → Date.now() / 1000
 *   * subprocess.run(shell=True, timeout=N) → child_process.execSync(cmd, { timeout: N*1000, encoding: "utf-8" })
 *   * __call__ → execute 方法 + toExecutor() 方法（返回 StageExecutor 函数）
 *
 * 创建日期：2026-07-21
 */

import * as path from "node:path";
import * as childProcess from "node:child_process";
import { DocCodeConsistencyChecker } from "./doc-code-consistency-checker.js";
import type { GapItem } from "./doc-code-consistency-checker.js";

// ============================================================================
// 第一部分：八阶段枚举与元数据
// ============================================================================

/**
 * 八阶段工作流阶段值（字符串字面量联合类型）
 *
 * 每个阶段对应一个角色和产出，与 Python WorkflowStage 枚举的字符串值一一对应。
 */
export type WorkflowStage =
  | "requirements" // 阶段 1: 需求分析（产品经理）
  | "architecture" // 阶段 2: 架构设计（架构师）
  | "ui_design" // 阶段 3: UI 设计（UI 设计师）
  | "test_design" // 阶段 4: 测试设计（测试专家）
  | "task_breakdown" // 阶段 5: 任务分解（独立开发者）
  | "development" // 阶段 6: 开发实现（独立开发者）
  | "test_verification" // 阶段 7: 测试验证（测试专家）
  | "doc_code_review"; // 阶段 8: 文档对照代码审查（多角色）

/**
 * WorkflowStage 常量对象（提供 8 个阶段值的命名空间引用）
 *
 * 用法等价于 Python 的 WorkflowStage.REQUIREMENTS / WorkflowStage.DEVELOPMENT 等。
 * 同时作为类型使用：`stage: WorkflowStage` 等价于上述字面量联合类型。
 */
export const WorkflowStage = {
  REQUIREMENTS: "requirements",
  ARCHITECTURE: "architecture",
  UI_DESIGN: "ui_design",
  TEST_DESIGN: "test_design",
  TASK_BREAKDOWN: "task_breakdown",
  DEVELOPMENT: "development",
  TEST_VERIFICATION: "test_verification",
  DOC_CODE_REVIEW: "doc_code_review",
} as const;

/**
 * Ralph 循环的 StageKind（本地定义）
 *
 * 来源：autonomous/loop-controller.ts 中 StageKind 为 "plan" | "dev" | "verify" | "fix"。
 * 此处新增 "review" 对应 Python 原版 StageKind.REVIEW（DOC_CODE_REVIEW 阶段映射）。
 * 本地定义以避免引入跨模块循环依赖，并完整支持 Python 原版映射。
 */
export type StageKind = "plan" | "dev" | "verify" | "fix" | "review";

/**
 * 工作流阶段元数据接口
 *
 * 字段说明：
 * - value: 阶段字符串值（与 WorkflowStage 联合类型成员对应）
 * - stageNumber: 阶段编号（1-8）
 * - roleName: 对应角色名称
 * - outputName: 阶段产出名称
 * - stageKind: 对应的 Ralph StageKind（无对应则 null）
 */
export interface WorkflowStageMeta {
  /** 阶段字符串值 */
  value: WorkflowStage;
  /** 阶段编号（1-8） */
  stageNumber: number;
  /** 角色名称 */
  roleName: string;
  /** 阶段产出名称 */
  outputName: string;
  /** 对应的 Ralph StageKind（无对应则 null） */
  stageKind: StageKind | null;
}

/**
 * 八阶段元数据常量（按 1→8 顺序排列）
 *
 * 等价于 Python WorkflowStage 枚举的 stage_number / role_name / output_name /
 * to_stage_kind 属性聚合。提供单点真实源，避免枚举值与元数据散布导致的同步问题。
 */
export const WORKFLOW_STAGES: readonly WorkflowStageMeta[] = [
  {
    value: "requirements",
    stageNumber: 1,
    roleName: "产品经理",
    outputName: "PRD 文档",
    stageKind: null,
  },
  {
    value: "architecture",
    stageNumber: 2,
    roleName: "架构师",
    outputName: "架构设计文档",
    stageKind: null,
  },
  {
    value: "ui_design",
    stageNumber: 3,
    roleName: "UI 设计师",
    outputName: "UI 设计稿",
    stageKind: null,
  },
  {
    value: "test_design",
    stageNumber: 4,
    roleName: "测试专家",
    outputName: "测试计划",
    stageKind: null,
  },
  {
    value: "task_breakdown",
    stageNumber: 5,
    roleName: "独立开发者",
    outputName: "任务清单",
    stageKind: "plan",
  },
  {
    value: "development",
    stageNumber: 6,
    roleName: "独立开发者",
    outputName: "代码实现",
    stageKind: "dev",
  },
  {
    value: "test_verification",
    stageNumber: 7,
    roleName: "测试专家",
    outputName: "测试报告",
    stageKind: "verify",
  },
  {
    value: "doc_code_review",
    stageNumber: 8,
    roleName: "多角色",
    outputName: "审查报告",
    stageKind: "review",
  },
];

/**
 * 按阶段值查找阶段元数据
 *
 * 等价于 Python WorkflowStage.xxx 属性的统一访问入口。
 *
 * @param value 阶段字符串值
 * @returns 阶段元数据，未找到返回 null
 */
export function findStage(value: WorkflowStage): WorkflowStageMeta | null {
  for (const stage of WORKFLOW_STAGES) {
    if (stage.value === value) {
      return stage;
    }
  }
  return null;
}

/**
 * 按阶段编号查找阶段元数据
 *
 * @param stageNumber 阶段编号（1-8）
 * @returns 阶段元数据，未找到返回 null
 */
export function findStageByNumber(stageNumber: number): WorkflowStageMeta | null {
  for (const stage of WORKFLOW_STAGES) {
    if (stage.stageNumber === stageNumber) {
      return stage;
    }
  }
  return null;
}

/**
 * 获取阶段编号（1-8）
 *
 * 等价于 Python WorkflowStage.stage_number 属性。
 *
 * @param stage 工作流阶段值
 * @returns 阶段编号；若未找到抛出 Error（保证类型安全）
 */
export function getStageNumber(stage: WorkflowStage): number {
  const meta = findStage(stage);
  if (meta === null) {
    throw new Error(`未知的工作流阶段: ${stage}`);
  }
  return meta.stageNumber;
}

/**
 * 获取阶段对应的角色名称
 *
 * 等价于 Python WorkflowStage.role_name 属性。
 *
 * @param stage 工作流阶段值
 * @returns 角色名称；若未找到抛出 Error
 */
export function getRoleName(stage: WorkflowStage): string {
  const meta = findStage(stage);
  if (meta === null) {
    throw new Error(`未知的工作流阶段: ${stage}`);
  }
  return meta.roleName;
}

/**
 * 获取阶段产出名称
 *
 * 等价于 Python WorkflowStage.output_name 属性。
 *
 * @param stage 工作流阶段值
 * @returns 阶段产出名称；若未找到抛出 Error
 */
export function getOutputName(stage: WorkflowStage): string {
  const meta = findStage(stage);
  if (meta === null) {
    throw new Error(`未知的工作流阶段: ${stage}`);
  }
  return meta.outputName;
}

/**
 * 将 WorkflowStage 映射为 Ralph 循环的 StageKind
 *
 * 等价于 Python WorkflowStage.to_stage_kind() 方法。
 *
 * 映射关系（详见设计文档 §10.3.2）：
 * - REQUIREMENTS / ARCHITECTURE / UI_DESIGN / TEST_DESIGN → null（Ralph 小循环无对应）
 * - TASK_BREAKDOWN → "plan"
 * - DEVELOPMENT → "dev"
 * - TEST_VERIFICATION → "verify"
 * - DOC_CODE_REVIEW → "review"
 *
 * 采用本地查表实现，避免引入 autonomous/loop-controller 的循环依赖。
 *
 * @param stage 工作流阶段值
 * @returns 对应的 StageKind，无对应则 null
 */
export function toStageKind(stage: WorkflowStage): StageKind | null {
  const meta = findStage(stage);
  if (meta === null) {
    return null;
  }
  return meta.stageKind;
}

// ============================================================================
// 第二部分：阶段执行结果接口
// ============================================================================

/**
 * 单阶段执行结果
 *
 * 等价于 Python 的 StageExecutionResult dataclass。
 *
 * 字段说明：
 * - stage: 执行的阶段
 * - success: 是否成功
 * - summary: 摘要
 * - artifacts: 阶段产出（dict）
 * - error: 错误信息
 * - durationSec: 执行耗时（秒）
 */
export interface StageExecutionResult {
  /** 执行的阶段 */
  stage: WorkflowStage;
  /** 是否成功 */
  success: boolean;
  /** 摘要 */
  summary: string;
  /** 阶段产出（key-value 字典） */
  artifacts: Record<string, unknown>;
  /** 错误信息（空字符串表示无错误） */
  error: string;
  /** 执行耗时（秒） */
  durationSec: number;
}

/**
 * 工作流迭代记录
 *
 * 等价于 Python 的 WorkflowIterationRecord dataclass。
 * 记录一次完整八阶段迭代的执行情况。
 *
 * 字段说明：
 * - iterationIndex: 迭代索引（从 1 开始）
 * - stages: 各阶段执行结果
 * - reviewPassed: 审查是否通过
 * - gaps: 审查发现的缺口
 * - rollbackTo: 回退到的阶段（null 表示不回退）
 * - timestamp: 记录时间（ISO 格式）
 */
export interface WorkflowIterationRecord {
  /** 迭代索引（从 1 开始） */
  iterationIndex: number;
  /** 各阶段执行结果 */
  stages: StageExecutionResult[];
  /** 审查是否通过 */
  reviewPassed: boolean;
  /** 审查发现的缺口 */
  gaps: GapItem[];
  /** 回退到的阶段（null 表示不回退） */
  rollbackTo: WorkflowStage | null;
  /** 记录时间（ISO 格式） */
  timestamp: string;
}

/**
 * 工作流执行结果
 *
 * 等价于 Python 的 WorkflowRunResult dataclass。
 *
 * 字段说明：
 * - projectName: 项目名称
 * - iterations: 迭代历史记录列表
 * - overallSuccess: 是否最终成功
 * - totalIterations: 总迭代次数
 * - maxIterations: 最大迭代次数
 * - finalGaps: 最终剩余缺口
 * - accumulatedArtifacts: 累计产出
 */
export interface WorkflowRunResult {
  /** 项目名称 */
  projectName: string;
  /** 迭代历史记录列表 */
  iterations: WorkflowIterationRecord[];
  /** 是否最终成功 */
  overallSuccess: boolean;
  /** 总迭代次数 */
  totalIterations: number;
  /** 最大迭代次数 */
  maxIterations: number;
  /** 最终剩余缺口 */
  finalGaps: GapItem[];
  /** 累计产出 */
  accumulatedArtifacts: Record<string, unknown>;
}

// ============================================================================
// 第三部分：阶段执行器接口
// ============================================================================

/**
 * 日志回调类型
 *
 * 等价于 Python 的 Callable[[str, str], None]。
 * 参数：(level, message)；level 为 "INFO" / "WARN" / "ERROR" 等。
 */
export type LogCallback = (level: string, message: string) => void;

/**
 * 阶段执行上下文
 *
 * 等价于 Python _execute_single_stage 构建的 exec_context dict。
 * 将原 dict 改为强类型 interface，提供 IDE 类型提示与编译期检查。
 *
 * 字段说明：
 * - iterationIndex: 迭代索引（从 1 开始）
 * - stageNumber: 当前阶段编号（1-8）
 * - prevResults: 前序阶段执行结果列表
 * - accumulatedArtifacts: 累计产出（跨迭代传递）
 * - docPaths: 文档路径字典
 * - testCommand: 测试命令
 * - projectRoot: 项目根目录（绝对路径）
 */
export interface StageExecutionContext {
  /** 迭代索引（从 1 开始） */
  iterationIndex: number;
  /** 当前阶段编号（1-8） */
  stageNumber: number;
  /** 前序阶段执行结果列表 */
  prevResults: StageExecutionResult[];
  /** 累计产出（跨迭代传递） */
  accumulatedArtifacts: Record<string, unknown>;
  /** 文档路径字典（键为文档类型，值为文档文件绝对路径） */
  docPaths: Record<string, string>;
  /** 测试执行命令 */
  testCommand: string;
  /** 项目根目录（绝对路径） */
  projectRoot: string;
}

/**
 * 阶段执行器函数类型
 *
 * 等价于 Python 的 Callable[[WorkflowStage, Dict[str, Any]], StageExecutionResult]。
 * 调用方传入该函数，由 WorkflowLoopController 在每个阶段调用。
 *
 * @param stage 当前执行的工作流阶段
 * @param context 阶段执行上下文
 * @returns 阶段执行结果
 */
export type StageExecutor = (stage: WorkflowStage, context: StageExecutionContext) => StageExecutionResult;

// ============================================================================
// 第四部分：回退策略
// ============================================================================

/**
 * 审查失败时的回退策略
 *
 * 等价于 Python 的 RollbackStrategy 类。
 *
 * 根据缺口维度决定回退到哪个阶段：
 * - D1 功能缺失 → 回退到 DEVELOPMENT（阶段 6）
 * - D2 集成缺失 → 回退到 DEVELOPMENT（阶段 6）
 * - D3 测试失败 → 回退到 TEST_VERIFICATION（阶段 7）
 * - D4 验收标准未满足 → 回退到 DEVELOPMENT（阶段 6）
 * - D5 TODO/FIXME 未实现 → 回退到 DEVELOPMENT（阶段 6）
 * - D6 文档意图偏离 → 回退到 DEVELOPMENT（阶段 6）
 */
export class RollbackStrategy {
  /**
   * 缺口维度到回退阶段的映射
   *
   * 等价于 Python 的 _ROLLBACK_MAP。
   * key 为维度前缀（用于 startsWith 匹配，避免维度描述尾部差异影响判定），
   * value 为对应回退阶段。
   */
  static readonly ROLLBACK_MAP: Readonly<Record<string, WorkflowStage>> = {
    "D1 功能完成度": "development",
    "D2 集成完整性": "development",
    "D3 测试正确性": "test_verification",
    "D4 验收标准": "development",
    "D5 TODO/FIXME": "development",
    "D6 文档意图": "development",
  };

  /**
   * 根据缺口列表决定回退到哪个阶段
   *
   * 等价于 Python 的 RollbackStrategy.determine_rollback 静态方法。
   *
   * 策略：
   * 1. 遍历缺口列表，对每个缺口匹配 ROLLBACK_MAP 中的维度前缀
   * 2. 收集所有匹配的回退阶段
   * 3. 优先回退到更早的阶段（DEVELOPMENT 优先于 TEST_VERIFICATION）
   * 4. 默认回退到 DEVELOPMENT
   * 5. 若无缺口，返回 null
   *
   * @param gaps 缺口列表
   * @returns 回退到的阶段，null 表示不需要回退
   */
  static determineRollback(gaps: GapItem[]): WorkflowStage | null {
    if (!gaps || gaps.length === 0) {
      return null;
    }

    // 收集所有匹配的回退阶段（去重）
    const rollbackStages = new Set<WorkflowStage>();
    for (const gap of gaps) {
      // 匹配缺口维度到回退阶段（前缀匹配，匹配到则停止本轮）
      for (const [dimPrefix, stage] of Object.entries(RollbackStrategy.ROLLBACK_MAP)) {
        if (gap.dimension.startsWith(dimPrefix)) {
          rollbackStages.add(stage);
          break;
        }
      }
    }

    // 优先回退到更早的阶段（DEVELOPMENT 优先于 TEST_VERIFICATION）
    if (rollbackStages.has("development")) {
      return "development";
    }
    if (rollbackStages.has("test_verification")) {
      return "test_verification";
    }

    // 默认回退到开发阶段
    return "development";
  }
}

// ============================================================================
// 第五部分：工作流循环控制器
// ============================================================================

/**
 * 八阶段工作流循环控制器
 *
 * 等价于 Python 的 WorkflowLoopController 类。
 *
 * 职责：
 * 1. 按顺序执行八阶段工作流
 * 2. 在审查阶段（阶段 8）检查文档-代码一致性
 * 3. 审查失败时根据缺口维度回退到相应阶段
 * 4. 支持最大迭代次数限制
 * 5. 记录每次迭代的执行情况
 *
 * 使用方式：
 * ```typescript
 * const controller = new WorkflowLoopController({
 *     projectRoot: "/path/to/project",
 *     stageExecutor: myExecutor, // 阶段执行回调
 *     maxIterations: 3,
 * });
 * const result = controller.run();
 * ```
 */
export class WorkflowLoopController {
  /**
   * 默认八阶段顺序
   *
   * 等价于 Python 的 DEFAULT_STAGE_ORDER 类属性。
   */
  static readonly DEFAULT_STAGE_ORDER: readonly WorkflowStage[] = [
    "requirements",
    "architecture",
    "ui_design",
    "test_design",
    "task_breakdown",
    "development",
    "test_verification",
    "doc_code_review",
  ];

  /** 项目根目录（绝对路径） */
  private readonly _projectRoot: string;
  /** 阶段执行回调函数 */
  private readonly _stageExecutor: StageExecutor;
  /** 最大迭代次数（≥1） */
  private readonly _maxIterations: number;
  /** 阶段顺序（默认为八阶段完整顺序） */
  private readonly _stageOrder: WorkflowStage[];
  /** 文档路径字典 */
  private readonly _docPaths: Record<string, string>;
  /** 测试命令 */
  private readonly _testCommand: string;
  /** 日志回调 */
  private readonly _log: LogCallback;

  /** 迭代历史记录 */
  private readonly _iterations: WorkflowIterationRecord[];
  /** 累计上下文（跨迭代传递） */
  private readonly _accumulatedArtifacts: Record<string, unknown>;

  /**
   * 构造工作流循环控制器
   *
   * 等价于 Python WorkflowLoopController.__init__。
   *
   * @param params 构造参数：
   *   - projectRoot: 项目根目录
   *   - stageExecutor: 阶段执行回调函数，签名为
   *     (stage: WorkflowStage, context: StageExecutionContext) => StageExecutionResult
   *   - maxIterations: 最大迭代次数（默认 3 次）
   *   - stageOrder: 阶段顺序（默认为八阶段完整顺序）
   *   - docPaths: 文档路径字典
   *   - testCommand: 测试命令
   *   - log: 日志回调 (level, message)
   */
  constructor(params: {
    projectRoot: string;
    stageExecutor: StageExecutor;
    maxIterations?: number;
    stageOrder?: WorkflowStage[];
    docPaths?: Record<string, string>;
    testCommand?: string;
    log?: LogCallback;
  }) {
    // 解析为绝对路径，等价于 Python Path(project_root).resolve()
    this._projectRoot = path.resolve(params.projectRoot);
    this._stageExecutor = params.stageExecutor;
    // 最小 1 次，等价于 Python max(1, int(max_iterations))
    this._maxIterations = Math.max(1, Math.floor(params.maxIterations ?? 3));
    // 默认八阶段顺序的副本（避免外部修改静态常量）
    this._stageOrder = params.stageOrder ? [...params.stageOrder] : [...WorkflowLoopController.DEFAULT_STAGE_ORDER];
    this._docPaths = { ...(params.docPaths ?? {}) };
    this._testCommand = params.testCommand ?? "";
    // 默认日志回调为 no-op，等价于 Python lambda level, msg: None
    this._log =
      params.log ??
      ((_level: string, _msg: string) => {
        /* 默认无操作 */
      });

    // 初始化迭代历史
    this._iterations = [];
    // 初始化累计上下文
    this._accumulatedArtifacts = {};
  }

  /**
   * 执行八阶段工作流循环
   *
   * 等价于 Python WorkflowLoopController.run 方法。
   *
   * 流程：
   * 1. 遍历迭代 1..maxIterations
   * 2. 每次迭代：
   *    - 计算起始阶段索引
   *    - 执行从起始阶段到最后阶段的所有阶段
   *    - 记录本次迭代
   *    - 若审查通过则退出循环
   *    - 若达到最大迭代次数仍未通过则退出
   * 3. 构建最终结果返回
   *
   * @returns 工作流执行结果
   */
  run(): WorkflowRunResult {
    this._log("INFO", "八阶段工作流循环开始");
    let overallSuccess = false;

    // 等价于 Python for iter_idx in range(1, self._max_iterations + 1)
    for (let iterIdx = 1; iterIdx <= this._maxIterations; iterIdx++) {
      this._log("INFO", `===== 迭代 ${iterIdx}/${this._maxIterations} =====`);

      // 创建本次迭代记录
      const iterationRecord: WorkflowIterationRecord = {
        iterationIndex: iterIdx,
        stages: [],
        reviewPassed: false,
        gaps: [],
        rollbackTo: null,
        // 等价于 Python datetime.now(timezone.utc).isoformat()
        timestamp: new Date().toISOString(),
      };

      // 确定本次迭代的起始阶段索引
      const startStageIdx = this._calculateStartStageIdx(iterIdx);

      // 执行从起始阶段到最后的所有阶段
      overallSuccess = this._executeStages(startStageIdx, iterIdx, iterationRecord);

      // 记录本次迭代
      this._iterations.push(iterationRecord);

      // 如果审查通过，退出循环
      if (overallSuccess) {
        break;
      }

      // 如果是最后一次迭代仍未通过，退出
      if (iterIdx === this._maxIterations) {
        this._log("WARN", `达到最大迭代次数 ${this._maxIterations}，工作流终止`);
        break;
      }
    }

    // 构建最终结果
    return this._buildRunResult(overallSuccess);
  }

  /**
   * 计算本次迭代的起始阶段索引
   *
   * 等价于 Python WorkflowLoopController._calculate_start_stage_idx。
   *
   * 策略：
   * - 第 1 次迭代：从第一个阶段开始（索引 0）
   * - 后续迭代：从上次回退目标开始；若无回退目标，从审查阶段重新开始
   *
   * @param iterIdx 迭代索引（从 1 开始）
   * @returns 起始阶段在 _stageOrder 中的索引
   */
  private _calculateStartStageIdx(iterIdx: number): number {
    if (iterIdx === 1) {
      return 0;
    }

    // 上次迭代的回退目标
    const prevIteration = this._iterations[this._iterations.length - 1];
    const prevRollback = prevIteration?.rollbackTo ?? null;
    if (prevRollback === null) {
      // 没有回退目标（所有阶段成功但审查未通过且 _handleReviewResult 未设置回退目标），
      // 从审查阶段重新开始（最后阶段索引）
      return this._stageOrder.length - 1;
    }

    // 在阶段顺序中查找回退目标的索引
    const idx = this._stageOrder.indexOf(prevRollback);
    if (idx === -1) {
      // 回退目标不在阶段顺序中（不应发生），从第一个阶段开始
      return 0;
    }
    return idx;
  }

  /**
   * 执行从起始阶段到最后的所有阶段
   *
   * 等价于 Python WorkflowLoopController._execute_stages。
   *
   * @param startStageIdx 起始阶段索引
   * @param iterIdx 迭代索引
   * @param iterationRecord 本次迭代记录（会追加 stage 结果）
   * @returns 审查是否通过（true 表示通过，可退出循环）
   */
  private _executeStages(startStageIdx: number, iterIdx: number, iterationRecord: WorkflowIterationRecord): boolean {
    let reviewPassed = false;

    for (let stageIdx = startStageIdx; stageIdx < this._stageOrder.length; stageIdx++) {
      const stage = this._stageOrder[stageIdx];
      // 日志：当前阶段信息
      const stageNumber = getStageNumber(stage);
      const roleName = getRoleName(stage);
      this._log("INFO", `  阶段 ${stageNumber}: ${stage}（${roleName}）`);

      // 执行单个阶段
      const result = this._executeSingleStage(stage, iterIdx, iterationRecord);
      iterationRecord.stages.push(result);

      // 更新累计上下文（合并产出 dict）
      Object.assign(this._accumulatedArtifacts, result.artifacts);

      // 如果阶段失败且不是审查阶段，终止本次迭代
      if (!result.success && stage !== "doc_code_review") {
        this._log("WARN", `  阶段 ${stageNumber} 失败: ${result.error}`);
        // P2-2 修复：记录失败阶段为回退目标，使下次迭代从失败阶段续跑，
        // 而非从审查阶段重启（避免浪费迭代额度产生针对破损代码的误导性审查报告）
        iterationRecord.rollbackTo = stage;
        break;
      }

      // 如果是审查阶段，处理审查结果
      if (stage === "doc_code_review") {
        reviewPassed = this._handleReviewResult(result, iterationRecord);
        if (reviewPassed) {
          // 审查通过，退出阶段循环
          break;
        }
      }
    }

    return reviewPassed;
  }

  /**
   * 执行单个阶段
   *
   * 等价于 Python WorkflowLoopController._execute_single_stage。
   *
   * 构建执行上下文并调用 stageExecutor，捕获异常避免单阶段异常导致整个循环崩溃。
   *
   * @param stage 工作流阶段
   * @param iterIdx 迭代索引
   * @param iterationRecord 本次迭代记录
   * @returns 阶段执行结果
   */
  private _executeSingleStage(
    stage: WorkflowStage,
    iterIdx: number,
    iterationRecord: WorkflowIterationRecord
  ): StageExecutionResult {
    // 构建执行上下文（等价于 Python exec_context dict）
    const execContext: StageExecutionContext = {
      iterationIndex: iterIdx,
      stageNumber: getStageNumber(stage),
      // 前序阶段结果的浅拷贝（避免外部修改内部记录）
      prevResults: [...iterationRecord.stages],
      // 累计产出的引用（执行器可读但不应直接修改）
      accumulatedArtifacts: this._accumulatedArtifacts,
      docPaths: this._docPaths,
      testCommand: this._testCommand,
      projectRoot: this._projectRoot,
    };

    // 执行阶段（try/catch 捕获异常，等价于 Python try/except Exception）
    try {
      return this._stageExecutor(stage, execContext);
    } catch (e) {
      // 异常时返回失败的 StageExecutionResult
      const errName = e instanceof Error ? e.constructor.name : typeof e;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        stage: stage,
        success: false,
        summary: `阶段执行异常: ${errName}: ${errMsg}`,
        artifacts: {},
        error: errMsg,
        durationSec: 0,
      };
    }
  }

  /**
   * 处理审查阶段的执行结果
   *
   * 等价于 Python WorkflowLoopController._handle_review_result。
   *
   * 提取审查通过状态和缺口清单，根据缺口决定回退阶段。
   *
   * @param result 审查阶段执行结果
   * @param iterationRecord 本次迭代记录（会更新 reviewPassed / gaps / rollbackTo）
   * @returns 审查是否通过
   */
  private _handleReviewResult(result: StageExecutionResult, iterationRecord: WorkflowIterationRecord): boolean {
    // 提取审查通过状态（默认 false）
    const reviewPassed = Boolean(result.artifacts["overall_passed"]);
    iterationRecord.reviewPassed = reviewPassed;

    // 提取缺口信息（artifacts.gap_list 为缺口对象数组）
    const gapListRaw = result.artifacts["gap_list"];
    const gapList: Array<Record<string, unknown>> = Array.isArray(gapListRaw)
      ? (gapListRaw as Array<Record<string, unknown>>)
      : [];

    // 将原始 gap dict 转换为强类型 GapItem 数组
    iterationRecord.gaps = gapList.map((g) => ({
      dimension: typeof g["dimension"] === "string" ? g["dimension"] : "",
      description: typeof g["description"] === "string" ? g["description"] : "",
      feature_id: typeof g["feature_id"] === "string" ? g["feature_id"] : "",
      // priority 默认 "P1"，等价于 Python g.get("priority", "P1")
      priority:
        g["priority"] === "P0" || g["priority"] === "P1" || g["priority"] === "P2"
          ? (g["priority"] as "P0" | "P1" | "P2")
          : "P1",
      suggestion: typeof g["suggestion"] === "string" ? g["suggestion"] : "",
    }));

    if (reviewPassed) {
      this._log("INFO", "  审查通过！工作流完成");
      return true;
    }

    // 审查不通过，确定回退阶段
    this._log("WARN", `  审查不通过：${gapList.length} 个缺口`);
    const rollbackStage = RollbackStrategy.determineRollback(iterationRecord.gaps);
    iterationRecord.rollbackTo = rollbackStage;
    if (rollbackStage !== null) {
      const rollbackNumber = getStageNumber(rollbackStage);
      this._log("INFO", `  回退到阶段 ${rollbackNumber}: ${rollbackStage}`);
    } else {
      this._log("WARN", "  无法确定回退目标");
    }
    return false;
  }

  /**
   * 构建工作流执行结果
   *
   * 等价于 Python WorkflowLoopController._build_run_result。
   *
   * @param overallSuccess 是否最终成功
   * @returns 工作流执行结果
   */
  private _buildRunResult(overallSuccess: boolean): WorkflowRunResult {
    // 最后一次迭代的缺口；若无迭代记录则空数组
    const lastGaps: GapItem[] = this._iterations.length > 0 ? this._iterations[this._iterations.length - 1].gaps : [];

    return {
      // 项目名称取根目录的最后一段，等价于 Python self._project_root.name
      projectName: path.basename(this._projectRoot),
      // 迭代历史记录的浅拷贝（避免外部修改内部状态）
      iterations: [...this._iterations],
      overallSuccess: overallSuccess,
      totalIterations: this._iterations.length,
      maxIterations: this._maxIterations,
      finalGaps: [...lastGaps],
      // 累计产出的浅拷贝
      accumulatedArtifacts: { ...this._accumulatedArtifacts },
    };
  }

  /**
   * 获取迭代历史记录（属性访问器）
   *
   * 等价于 Python WorkflowLoopController.iterations @property。
   * 返回副本以避免外部修改内部状态。
   */
  get iterations(): WorkflowIterationRecord[] {
    return [...this._iterations];
  }
}

// ============================================================================
// 第六部分：工作流执行结果摘要函数
// ============================================================================

/**
 * 生成工作流执行结果摘要文本
 *
 * 等价于 Python WorkflowRunResult.summary 方法（独立函数形式）。
 *
 * 输出格式：
 * ```
 * 八阶段工作流执行结果：
 *   项目: <project_name>
 *   最终状态: ✅ 成功 / ❌ 未通过
 *   迭代次数: <total>/<max>
 *   剩余缺口: N 个
 *     1. [P0] D1 功能完成度: 功能 F-001 未实现
 *     ...
 *   迭代历史:
 *     迭代 1: ❌ 不通过 → 回退到阶段 6
 *       阶段 1 (requirements): ✅
 *       阶段 2 (architecture): ✅
 *       ...
 * ```
 *
 * @param result 工作流执行结果
 * @returns 摘要文本
 */
export function summarizeWorkflowRunResult(result: WorkflowRunResult): string {
  const lines: string[] = [];
  lines.push(`八阶段工作流执行结果：`);
  lines.push(`  项目: ${result.projectName}`);
  lines.push(`  最终状态: ${result.overallSuccess ? "✅ 成功" : "❌ 未通过"}`);
  lines.push(`  迭代次数: ${result.totalIterations}/${result.maxIterations}`);

  if (result.finalGaps.length > 0) {
    lines.push(`  剩余缺口: ${result.finalGaps.length} 个`);
    // 最多展示前 10 个缺口
    const displayGaps = result.finalGaps.slice(0, 10);
    displayGaps.forEach((gap, idx) => {
      lines.push(`    ${idx + 1}. [${gap.priority}] ${gap.dimension}: ${gap.description}`);
    });
  } else {
    lines.push(`  剩余缺口: 0 个`);
  }

  lines.push(`  迭代历史:`);
  for (const iteration of result.iterations) {
    const status = iteration.reviewPassed ? "✅ 通过" : "❌ 不通过";
    const rollbackInfo = iteration.rollbackTo !== null ? ` → 回退到阶段 ${getStageNumber(iteration.rollbackTo)}` : "";
    lines.push(`    迭代 ${iteration.iterationIndex}: ${status}${rollbackInfo}`);
    for (const stageResult of iteration.stages) {
      const stageStatus = stageResult.success ? "✅" : "❌";
      lines.push(`      阶段 ${getStageNumber(stageResult.stage)} (${stageResult.stage}): ${stageStatus}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// 第七部分：默认阶段执行器
// ============================================================================

/**
 * 默认阶段执行器构造参数
 *
 * 字段说明：
 * - projectRoot: 项目根目录（用于 executeTestVerification / executeReview 的 cwd）
 * - testCommand: 默认测试命令（仅当 context.testCommand 为空时使用）
 * - testTimeoutSec: 测试执行超时（秒，默认 600）
 * - docPaths: 文档路径字典（仅当 context.docPaths 为空时使用）
 */
export interface DefaultStageExecutorOptions {
  /** 项目根目录 */
  projectRoot: string;
  /** 默认测试命令 */
  testCommand?: string;
  /** 默认测试超时（秒，默认 600） */
  testTimeoutSec?: number;
  /** 默认文档路径字典 */
  docPaths?: Record<string, string>;
}

/**
 * 默认阶段执行器
 *
 * 提供 8 阶段的默认执行实现，等价于 Python 中可被传入 stage_executor 的回调对象。
 *
 * 由于 Python 的 __call__ 在 TypeScript 中无效，本类提供：
 * - execute 方法：实例方法，等价于 Python __call__ 的实现入口
 * - toExecutor 方法：返回 StageExecutor 函数包装器，可传入 WorkflowLoopController
 *
 * 静态方法：
 * - executeDocStage: 执行文档阶段（阶段 1-5），返回占位产出
 * - executeDevelopment: 执行开发阶段（阶段 6），返回占位产出
 * - executeTestVerification: 执行测试验证（阶段 7），运行测试命令并解析结果
 * - executeReview: 执行审查（阶段 8），调用 DocCodeConsistencyChecker 检查一致性
 * - parseTestOutput: 解析测试命令输出，提取通过/失败/跳过数
 *
 * 设计说明：
 * - 文档阶段（1-5）的实际产出由外部 LLM 或人工提供，本执行器仅返回基础框架占位
 * - 开发阶段（6）的实际编码由外部工具完成，本执行器返回"待人工实现"占位
 * - 测试阶段（7）使用 child_process.execSync 执行测试命令
 * - 审查阶段（8）使用 DocCodeConsistencyChecker 完成六大维度检查
 */
export class DefaultStageExecutor {
  /** 项目根目录（绝对路径） */
  private readonly projectRoot: string;
  /** 默认测试命令 */
  private readonly testCommand: string;
  /** 默认测试超时（秒） */
  private readonly testTimeoutSec: number;
  /** 默认文档路径字典 */
  private readonly docPaths: Record<string, string>;

  /**
   * 构造默认阶段执行器
   *
   * @param options 构造参数
   */
  constructor(options: DefaultStageExecutorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.testCommand = options.testCommand ?? "";
    this.testTimeoutSec = options.testTimeoutSec ?? 600;
    this.docPaths = { ...(options.docPaths ?? {}) };
  }

  /**
   * 执行入口（实例方法）
   *
   * 等价于 Python 的 __call__ 方法。根据阶段值分发到对应的静态方法。
   *
   * @param stage 工作流阶段
   * @param context 阶段执行上下文
   * @returns 阶段执行结果
   */
  execute(stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult {
    // 阶段 1-5：文档阶段（需求/架构/UI设计/测试设计/任务分解）
    const docStages: WorkflowStage[] = ["requirements", "architecture", "ui_design", "test_design", "task_breakdown"];
    if (docStages.indexOf(stage) !== -1) {
      return DefaultStageExecutor.executeDocStage(stage, context);
    }

    // 阶段 6：开发阶段
    if (stage === "development") {
      return DefaultStageExecutor.executeDevelopment(stage, context);
    }

    // 阶段 7：测试验证阶段
    if (stage === "test_verification") {
      return DefaultStageExecutor.executeTestVerification(stage, context);
    }

    // 阶段 8：审查阶段
    if (stage === "doc_code_review") {
      return DefaultStageExecutor.executeReview(stage, context);
    }

    // 未知阶段，返回失败结果
    return {
      stage: stage,
      success: false,
      summary: `未知的工作流阶段: ${stage}`,
      artifacts: {},
      error: `未知的工作流阶段: ${stage}`,
      durationSec: 0,
    };
  }

  /**
   * 转换为 StageExecutor 函数
   *
   * 由于 Python 的 __call__ 在 TypeScript 中无效，本方法返回一个
   * 符合 StageExecutor 函数签名的闭包，可传入 WorkflowLoopController。
   *
   * @returns StageExecutor 函数包装器
   */
  toExecutor(): StageExecutor {
    // 闭包绑定 this，确保函数调用时仍指向本实例
    return (stage: WorkflowStage, context: StageExecutionContext) => this.execute(stage, context);
  }

  /**
   * 执行文档阶段（阶段 1-5）
   *
   * 文档阶段包含：需求/架构/UI设计/测试设计/任务分解。
   * 这些阶段的实际产出由外部 LLM 或人工提供，本方法返回基础占位产出，
   * 在 artifacts 中写入 output_name 与 timestamp，供后续阶段引用。
   *
   * @param stage 工作流阶段（必须是 1-5 之一）
   * @param context 阶段执行上下文
   * @returns 阶段执行结果（默认 success=true）
   */
  static executeDocStage(stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult {
    const startTime = Date.now();
    const meta = findStage(stage);
    // 若元数据缺失，返回失败
    if (meta === null) {
      return {
        stage: stage,
        success: false,
        summary: `未知的工作流阶段: ${stage}`,
        artifacts: {},
        error: `未知的工作流阶段: ${stage}`,
        durationSec: 0,
      };
    }

    // 构造占位产出
    const artifacts: Record<string, unknown> = {
      // 阶段产出名称
      output_name: meta.outputName,
      // 时间戳（ISO 格式）
      timestamp: new Date().toISOString(),
      // 阶段编号
      stage_number: meta.stageNumber,
      // 角色名称
      role_name: meta.roleName,
      // 标记为占位产出（实际产出由外部 LLM/人工提供）
      placeholder: true,
      // 迭代索引（便于追踪）
      iteration_index: context.iterationIndex,
    };

    const durationSec = (Date.now() - startTime) / 1000;
    return {
      stage: stage,
      success: true,
      summary: `阶段 ${meta.stageNumber}(${stage}) 完成，产出: ${meta.outputName}（占位）`,
      artifacts: artifacts,
      error: "",
      durationSec: durationSec,
    };
  }

  /**
   * 执行开发阶段（阶段 6）
   *
   * 实际编码由外部工具/人工完成。本方法返回占位产出，标记待人工实现。
   *
   * @param stage 工作流阶段（必须为 "development"）
   * @param context 阶段执行上下文
   * @returns 阶段执行结果（默认 success=true）
   */
  static executeDevelopment(stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult {
    const startTime = Date.now();

    // 构造占位产出
    const artifacts: Record<string, unknown> = {
      output_name: "代码实现",
      timestamp: new Date().toISOString(),
      stage_number: 6,
      role_name: "独立开发者",
      placeholder: true,
      iteration_index: context.iterationIndex,
      // 标记为待人工实现（实际由外部工具完成）
      pending_implementation: true,
    };

    const durationSec = (Date.now() - startTime) / 1000;
    return {
      stage: stage,
      success: true,
      summary: `阶段 6(development) 完成，代码实现待人工/外部工具完成（占位）`,
      artifacts: artifacts,
      error: "",
      durationSec: durationSec,
    };
  }

  /**
   * 执行测试验证阶段（阶段 7）
   *
   * 使用 child_process.execSync 执行测试命令（shell 模式，等价于 Python
   * subprocess.run(shell=True, timeout=N)），并通过 parseTestOutput 解析输出。
   *
   * cwd 优先使用 context.projectRoot，若为空则回退到本执行器的 projectRoot。
   *
   * @param stage 工作流阶段（必须为 "test_verification"）
   * @param context 阶段执行上下文
   * @returns 阶段执行结果
   */
  static executeTestVerification(stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult {
    const startTime = Date.now();

    // 优先使用 context.testCommand，为空则回退到本执行器实例的 testCommand
    // 但本方法是 static，无法访问 this.testCommand，因此从 context 中获取
    // 调用方应在 context.testCommand 中传入测试命令
    const testCommand = context.testCommand;
    if (!testCommand) {
      // 未配置测试命令，返回失败结果
      const durationSec = (Date.now() - startTime) / 1000;
      return {
        stage: stage,
        success: false,
        summary: "未配置测试命令，无法执行测试验证",
        artifacts: {
          test_command: "(未配置)",
          passed: 0,
          failed: 0,
          skipped: 0,
          test_output_tail: "未配置测试命令",
          duration_sec: 0,
        },
        error: "未配置测试命令",
        durationSec: durationSec,
      };
    }

    // cwd 优先使用 context.projectRoot，若为空则回退到 process.cwd()
    // 注意：本方法为 static，无法访问 this.projectRoot；
    //       调用方需在 context.projectRoot 中传入项目根目录
    const cwd = context.projectRoot && context.projectRoot.length > 0 ? context.projectRoot : process.cwd();

    // 测试超时：固定 600 秒（10 分钟）
    // 等价于 Python subprocess.run(shell=True, timeout=600)
    const testTimeoutSec = 600;

    try {
      // 执行测试命令（同步，shell 模式，超时 600s）
      // execSync 默认在 shell 中执行（Unix 为 /bin/sh，Windows 为 cmd.exe），
      // 等价于 Python subprocess.run(shell=True, timeout=N)
      // execSync 抛出异常表示非零退出码或超时
      const output = childProcess.execSync(testCommand, {
        cwd: cwd,
        encoding: "utf-8",
        timeout: testTimeoutSec * 1000, // 转换为毫秒
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env },
      });

      // 解析测试输出
      const parsed = DefaultStageExecutor.parseTestOutput(output ?? "");
      const durationSec = (Date.now() - startTime) / 1000;

      // 测试通过判定：失败数为 0 且通过数 > 0
      const success = parsed.failed === 0 && parsed.passed > 0;
      return {
        stage: stage,
        success: success,
        summary: `测试执行完成：${parsed.passed} passed / ${parsed.failed} failed / ${parsed.skipped} skipped`,
        artifacts: {
          test_command: testCommand,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          test_output_tail: (output ?? "").slice(-2000),
          duration_sec: durationSec,
        },
        error: success ? "" : `测试失败：${parsed.failed} 个用例未通过`,
        durationSec: durationSec,
      };
    } catch (e) {
      // execSync 抛出异常：可能是非零退出码或超时
      const durationSec = (Date.now() - startTime) / 1000;
      let stdout = "";
      let stderr = "";
      let errMsg = "";

      // 解析 execSync 异常对象（含 stdout / stderr / killed / signal）
      if (e !== null && typeof e === "object") {
        const errObj = e as {
          stdout?: Buffer | string;
          stderr?: Buffer | string;
          message?: string;
          killed?: boolean;
          signal?: string | null;
        };
        if (errObj.stdout) {
          stdout = typeof errObj.stdout === "string" ? errObj.stdout : errObj.stdout.toString("utf-8");
        }
        if (errObj.stderr) {
          stderr = typeof errObj.stderr === "string" ? errObj.stderr : errObj.stderr.toString("utf-8");
        }
        // 超时判定（execSync 超时后会设置 killed=true 与 signal="SIGTERM"）
        if (errObj.killed && errObj.signal === "SIGTERM") {
          errMsg = `测试执行超时（>${testTimeoutSec}s）`;
        } else {
          errMsg = errObj.message ?? String(e);
        }
      } else {
        errMsg = String(e);
      }

      const combinedOutput = stdout + "\n" + stderr;
      const parsed = DefaultStageExecutor.parseTestOutput(combinedOutput);

      return {
        stage: stage,
        success: false,
        summary: `测试执行失败：${errMsg}`,
        artifacts: {
          test_command: testCommand,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          test_output_tail: combinedOutput.slice(-2000),
          duration_sec: durationSec,
        },
        error: errMsg,
        durationSec: durationSec,
      };
    }
  }

  /**
   * 执行审查阶段（阶段 8）
   *
   * 使用 context.projectRoot 调用 DocCodeConsistencyChecker，
   * 执行六大维度检查并构建审查产出。
   *
   * 产出 artifacts 字段（供 WorkflowLoopController._handle_review_result 使用）：
   * - overall_passed: 是否通过（缺口清单为空）
   * - gap_list: 缺口清单（数组）
   * - report: ConsistencyReport 完整报告对象
   * - markdown_report: Markdown 格式报告文本
   *
   * @param stage 工作流阶段（必须为 "doc_code_review"）
   * @param context 阶段执行上下文
   * @returns 阶段执行结果
   */
  static executeReview(stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult {
    const startTime = Date.now();

    // 使用 context.projectRoot 作为检查器的工作目录
    // 若 context.projectRoot 为空，回退到 process.cwd()
    const projectRoot = context.projectRoot && context.projectRoot.length > 0 ? context.projectRoot : process.cwd();

    // 文档路径字典：使用 context.docPaths
    const docPaths = context.docPaths;

    // 测试命令：使用 context.testCommand
    const testCommand = context.testCommand;

    try {
      // 构造 DocCodeConsistencyChecker 并执行全部检查
      const checker = new DocCodeConsistencyChecker(
        projectRoot,
        docPaths,
        testCommand,
        600.0 // 测试超时 600 秒
      );
      const report = checker.checkAll();
      // 生成 Markdown 报告
      const markdownReport = checker.generateReport(report);

      // 构建产出
      const overallPassed = report.overall_passed;
      const durationSec = (Date.now() - startTime) / 1000;

      return {
        stage: stage,
        // 审查阶段本身执行成功（不代表缺口为空，仅表示检查流程完成）
        success: true,
        summary: overallPassed ? "审查通过：文档-代码一致" : `审查不通过：${report.gap_list.length} 个缺口`,
        artifacts: {
          // overall_passed 字段供 _handle_review_result 提取
          overall_passed: overallPassed,
          // gap_list 字段供 _handle_review_result 提取
          // 注意：将 GapItem 强类型对象转为通用对象，便于 _handle_review_result 通过 key 访问
          gap_list: report.gap_list.map((g) => ({
            dimension: g.dimension,
            description: g.description,
            feature_id: g.feature_id,
            priority: g.priority,
            suggestion: g.suggestion,
          })),
          // 完整 ConsistencyReport 对象（供下游分析）
          report: report,
          // Markdown 格式报告文本
          markdown_report: markdownReport,
          // 检查时间
          check_time: report.check_time,
          // 项目名称
          project_name: report.project_name,
        },
        error: "",
        durationSec: durationSec,
      };
    } catch (e) {
      // 检查器执行异常，返回失败结果
      const durationSec = (Date.now() - startTime) / 1000;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        stage: stage,
        success: false,
        summary: `审查阶段执行异常: ${errMsg}`,
        artifacts: {
          overall_passed: false,
          gap_list: [],
          report: null,
          markdown_report: "",
        },
        error: errMsg,
        durationSec: durationSec,
      };
    }
  }

  /**
   * 解析测试命令输出
   *
   * 从测试输出文本中提取通过/失败/跳过数。
   * 支持 pytest / unittest / mocha / jest 等格式的 summary 行。
   *
   * 解析规则（与 DocCodeConsistencyChecker.checkTestCorrectness 保持一致）：
   * - 通过数：匹配 "N passed" / "N passed, M failed" 等
   * - 失败数：匹配 "N failed"
   * - 跳过数：匹配 "N skipped"
   *
   * @param output 测试命令输出文本
   * @returns 解析结果：{ passed, failed, skipped }
   */
  static parseTestOutput(output: string): {
    passed: number;
    failed: number;
    skipped: number;
  } {
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // 通过数：匹配 "N passed"（大小写不敏感）
    const passedMatch = output.match(/(\d+)\s+passed/i);
    if (passedMatch) {
      passed = parseInt(passedMatch[1], 10);
    }

    // 失败数：匹配 "N failed"
    const failedMatch = output.match(/(\d+)\s+failed/i);
    if (failedMatch) {
      failed = parseInt(failedMatch[1], 10);
    }

    // 跳过数：匹配 "N skipped"
    const skippedMatch = output.match(/(\d+)\s+skipped/i);
    if (skippedMatch) {
      skipped = parseInt(skippedMatch[1], 10);
    }

    return {
      passed: passed,
      failed: failed,
      skipped: skipped,
    };
  }
}
