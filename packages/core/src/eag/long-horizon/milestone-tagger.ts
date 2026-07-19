/**
 * 里程碑 tag 生成器（EAG-P3 批次 10 §4.15）
 *
 * 本模块实现 `MilestoneTagger` 类，对应 EAG 方案 §5.12.2 "里程碑检查点"：
 * 每个 Loop 完成时自动生成 git tag（`eag/<run-id>/m<n>`），触发回归测试，
 * 计算健康度（testPassRate × 0.5 + redlinePassRate × 0.3 + coverageRate × 0.2）。
 *
 * 设计依据：
 * - EAG 方案 §5.12.2 里程碑检查点（tag + 回归 + 健康度）
 * - EAG-P3 批次 10 设计 §4.15 MilestoneTagger
 * - EAG-P3 批次 10 设计 §4.15.3 健康度计算公式
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * 关键实现决策：
 * - GitProcessManager 不含 createTag/hardReset/listTags/getHeadSha 方法，
 *   本模块通过 `child_process.execSync` 直接调用 git 命令实现（真实调用，非 mock）
 * - 回归测试通过 `child_process.spawnSync` 执行 `npm test` 命令，
 *   解析输出统计 totalTests/passedTests/failedTests（基于 node:test TAP 输出）
 * - 健康度计算独立为 HealthScoreCalculator 类，便于单元测试
 *
 * @module eag/long-horizon/milestone-tagger
 */

import * as childProcess from "node:child_process";
import * as path from "node:path";
import type { LoopType } from "../loop/models";
import type { MilestoneRecord, RegressionResult, LogCallback } from "./types";
import { DEFAULT_MILESTONE_TAG_PREFIX, HEALTH_SCORE_WEIGHTS } from "./types";
import type { RunStateStore } from "./run-state-store";

// ============================================================================
// 1. 自定义错误类
// ============================================================================

/**
 * MilestoneTagger 错误类型字面量联合
 *
 * - invalid-request：请求参数非法（runId/projectRoot/name 为空等）
 * - git-tag-create-failed：git tag 创建失败（如 tag 已存在 / git 仓库状态异常）
 * - git-tag-not-found：指定的 tag 不存在（rollback 时无 milestone 可回滚）
 * - git-reset-failed：git reset --hard 失败
 * - regression-test-failed：回归测试执行失败（如 npm test 命令不存在）
 * - git-command-failed：其他 git 命令执行失败
 */
export type MilestoneTaggerErrorKind =
  | "invalid-request"
  | "git-tag-create-failed"
  | "git-tag-not-found"
  | "git-reset-failed"
  | "regression-test-failed"
  | "git-command-failed";

/**
 * MilestoneTagger 错误
 *
 * 自定义错误类，含 kind（错误类型）+ 原始异常（cause）便于上层诊断。
 */
export class MilestoneTaggerError extends Error {
  /** 错误类型字面量（便于程序化分支处理） */
  public readonly kind: MilestoneTaggerErrorKind;

  /**
   * @param kind 错误类型
   * @param message 错误消息
   * @param cause 原始异常（可选，便于上层诊断）
   */
  constructor(
    kind: MilestoneTaggerErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "MilestoneTaggerError";
    this.kind = kind;
  }
}

// ============================================================================
// 2. 里程碑 tag 请求
// ============================================================================

/**
 * 里程碑 tag 请求
 *
 * 对应 §4.15 MilestoneTagRequest：
 * 调用方提供 runId / projectRoot / name / loopType，commitSha 可选（默认 HEAD）。
 *
 * 字段全部 readonly。
 */
export interface MilestoneTagRequest {
  /** run-id（关联 RunState） */
  readonly runId: string;
  /** 项目根目录（绝对路径或相对路径，内部 path.resolve 处理） */
  readonly projectRoot: string;
  /** 里程碑名称（如 "DESIGN Loop 完成" / "CODING Loop T-001 完成"） */
  readonly name: string;
  /** 完成的 Loop 类型（design/coding/testing） */
  readonly loopType: LoopType;
  /** commit SHA（可选，默认 HEAD；用于在特定提交上打 tag） */
  readonly commitSha?: string;
}

// ============================================================================
// 3. 健康度计算器（独立可测）
// ============================================================================

/**
 * 健康度计算器
 *
 * 对应 §4.15.3 健康度计算公式：
 *   healthScore = testPassRate × 0.5 + redlinePassRate × 0.3 + coverageRate × 0.2
 *
 * 其中：
 * - testPassRate = regressionResult.passedTests / regressionResult.totalTests
 * - redlinePassRate = 调用方传入（来自 IndependentEvaluator 评估结果，0~1）
 * - coverageRate = 调用方传入（来自 CoverageGate，0~1，三维度平均值）
 *
 * 权重固定使用 HEALTH_SCORE_WEIGHTS（Object.freeze 冻结，防止运行期被 LLM 自改）。
 *
 * 设计理由（独立可测）：
 * - 健康度计算纯函数，无副作用，便于单元测试覆盖边界值
 * - 与 MilestoneTagger 解耦，未来可被其他场景复用（如 PR 描述生成时计算健康度）
 */
export class HealthScoreCalculator {
  /**
   * 计算里程碑健康度
   *
   * 算法：
   * 1. 计算 testPassRate：
   *    - totalTests = 0 → testPassRate = 0（避免除零）
   *    - 否则 testPassRate = passedTests / totalTests
   * 2. 校验 redlinePassRate 与 coverageRate 范围 [0, 1]
   * 3. 套用公式：healthScore = testPassRate × W_test + redlinePassRate × W_redline + coverageRate × W_coverage
   * 4. 限制结果在 [0, 1] 区间（防止输入异常导致越界）
   *
   * @param regressionResult 回归测试结果（含 totalTests/passedTests）
   * @param redlinePassRate 红线通过率（0~1，超出范围会被钳制到 [0, 1]）
   * @param coverageRate 覆盖率（0~1，超出范围会被钳制到 [0, 1]）
   * @returns 健康度（0~1，保留 4 位小数）
   */
  calculate(regressionResult: Readonly<RegressionResult>, redlinePassRate: number, coverageRate: number): number {
    // 1. 计算 testPassRate（避免除零）
    const totalTests = regressionResult.totalTests;
    const passedTests = regressionResult.passedTests;
    const testPassRate: number = totalTests > 0 ? passedTests / totalTests : 0;

    // 2. 钳制 redlinePassRate 与 coverageRate 到 [0, 1] 区间
    const clampedRedlinePassRate: number = Math.max(0, Math.min(1, redlinePassRate));
    const clampedCoverageRate: number = Math.max(0, Math.min(1, coverageRate));

    // 3. 套用健康度公式
    const rawScore: number =
      testPassRate * HEALTH_SCORE_WEIGHTS.testPassRate +
      clampedRedlinePassRate * HEALTH_SCORE_WEIGHTS.redlinePassRate +
      clampedCoverageRate * HEALTH_SCORE_WEIGHTS.coverageRate;

    // 4. 钳制结果到 [0, 1] 并保留 4 位小数
    const finalScore: number = Math.max(0, Math.min(1, rawScore));
    return Math.round(finalScore * 10000) / 10000;
  }
}

// ============================================================================
// 4. 默认配置常量
// ============================================================================

/**
 * 默认回归测试命令
 *
 * 使用 `npm test` 触发项目 package.json 中定义的 test 脚本。
 * 对齐项目根目录的 package.json `scripts.test` 字段（node --import tsx --test）。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_REGRESSION_TEST_COMMAND = "npm test" as const;

/**
 * 默认回归测试超时（秒）
 *
 * 数值依据：测试套件 2300+ 用例，正常执行约 60~120 秒，预留 600 秒冗余。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_REGRESSION_TEST_TIMEOUT_SEC = 600 as const;

/**
 * 默认红线通过率（无 IndependentEvaluator 评估结果时使用）
 *
 * 数值依据：保守起见使用 1.0（默认全部红线通过，避免无评估器时健康度偏低）。
 * 调用方可通过参数覆盖。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_REDLINE_PASS_RATE = 1.0 as const;

/**
 * 默认覆盖率（无 CoverageReport 时使用）
 *
 * 数值依据：保守起见使用 0.0（无覆盖率报告时健康度反映真实测试通过率）。
 * 调用方可通过参数覆盖。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_COVERAGE_RATE = 0.0 as const;

// ============================================================================
// 5. 辅助函数：git 命令执行
// ============================================================================

/**
 * 执行 git 命令（同步）
 *
 * 算法：
 * 1. 在指定 cwd 下执行 git 命令
 * 2. 捕获 stdout / stderr / status
 * 3. 非 0 退出码抛 MilestoneTaggerError
 *
 * @param args git 命令参数列表（如 ["rev-parse", "HEAD"]）
 * @param cwd 工作目录（项目根目录）
 * @param logger 日志回调（可选）
 * @returns stdout 输出（已 trim）
 * @throws MilestoneTaggerError git 命令执行失败
 */
function execGit(args: ReadonlyArray<string>, cwd: string, logger?: LogCallback): string {
  const cmdStr = `git ${args.join(" ")}`;
  logger?.(`执行 git 命令：${cmdStr} (cwd=${cwd})`, "info");

  try {
    const result = childProcess.spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      // 启动 git 进程失败（如 git 未安装）
      throw new MilestoneTaggerError(
        "git-command-failed",
        `git 命令启动失败：${cmdStr} 错误：${result.error.message}`,
        result.error
      );
    }

    if (result.status !== 0) {
      // git 命令执行返回非 0 退出码
      const stderr = (result.stderr ?? "").trim();
      throw new MilestoneTaggerError(
        "git-command-failed",
        `git 命令失败（status=${result.status}）：${cmdStr} stderr=${stderr}`
      );
    }

    return (result.stdout ?? "").trim();
  } catch (err) {
    // 已是 MilestoneTaggerError 直接重抛
    if (err instanceof MilestoneTaggerError) {
      throw err;
    }
    // 其他异常包装为 MilestoneTaggerError
    throw new MilestoneTaggerError(
      "git-command-failed",
      `git 命令执行异常：${cmdStr} 错误：${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

// ============================================================================
// 6. MilestoneTagger 类
// ============================================================================

/**
 * 里程碑 tag 生成器
 *
 * 对应 §4.15 MilestoneTagger：
 * 每个 Loop 完成时调用 tag() 生成 git tag + 触发回归测试 + 计算健康度。
 *
 * 用法：
 * ```typescript
 * const tagger = new MilestoneTagger(runStateStore, logger);
 * const milestone = await tagger.tag({
 *   runId: "a1b2c3d4e5f6",
 *   projectRoot: "/path/to/project",
 *   name: "DESIGN Loop 完成",
 *   loopType: "design",
 * });
 * // milestone.tagName === "eag/a1b2c3d4e5f6/m1"
 * // milestone.healthScore === 0.85
 *
 * // 回滚到上一个 milestone
 * const rolled = await tagger.rollback("a1b2c3d4e5f6", "/path/to/project");
 *
 * // 列出所有 milestone
 * const tags = await tagger.listTags("a1b2c3d4e5f6", "/path/to/project");
 * ```
 *
 * 设计约束：
 * - 通过 `child_process.spawnSync` 直接调用 git 命令（真实调用，非 mock）
 * - 回归测试通过 `child_process.spawnSync` 执行 `npm test`（解析 TAP 输出统计）
 * - 健康度计算委托 HealthScoreCalculator（独立可测）
 */
export class MilestoneTagger {
  // ============================ 依赖组件 ============================

  /** RunState 持久化存储（用于查询已有 milestone 数量计算下一个序号） */
  private readonly runStateStore: RunStateStore;
  /** 日志回调 */
  private readonly log: LogCallback;
  /** 健康度计算器（独立可测） */
  private readonly healthScoreCalculator: HealthScoreCalculator;
  /** 回归测试命令（默认 "npm test"） */
  private readonly regressionTestCommand: string;
  /** 回归测试超时（秒，默认 600） */
  private readonly regressionTestTimeoutSec: number;
  /** tag 前缀（默认 "eag"） */
  private readonly tagPrefix: string;

  /**
   * @param runStateStore RunState 持久化存储（必填）
   * @param logger 日志回调（可选，默认 noop）
   * @param options 高级选项（可选）
   * @param options.regressionTestCommand 回归测试命令（默认 "npm test"）
   * @param options.regressionTestTimeoutSec 回归测试超时秒数（默认 600）
   * @param options.tagPrefix tag 前缀（默认 "eag"）
   * @param options.healthScoreCalculator 健康度计算器（默认 new HealthScoreCalculator()）
   */
  constructor(
    runStateStore: RunStateStore,
    logger: LogCallback = noopLog,
    options?: {
      readonly regressionTestCommand?: string;
      readonly regressionTestTimeoutSec?: number;
      readonly tagPrefix?: string;
      readonly healthScoreCalculator?: HealthScoreCalculator;
    }
  ) {
    if (!runStateStore) {
      throw new MilestoneTaggerError("invalid-request", "runStateStore 必填");
    }
    this.runStateStore = runStateStore;
    this.log = logger;
    this.healthScoreCalculator = options?.healthScoreCalculator ?? new HealthScoreCalculator();
    this.regressionTestCommand = options?.regressionTestCommand ?? DEFAULT_REGRESSION_TEST_COMMAND;
    this.regressionTestTimeoutSec = options?.regressionTestTimeoutSec ?? DEFAULT_REGRESSION_TEST_TIMEOUT_SEC;
    this.tagPrefix = options?.tagPrefix ?? DEFAULT_MILESTONE_TAG_PREFIX;
  }

  // ============================ 公共 API ============================

  /**
   * 生成里程碑 tag
   *
   * 算法（对齐 §4.15.2）：
   * 1. 校验请求字段
   * 2. 加载 RunState 获取已有 milestone 数量 → 计算下一个序号 N
   * 3. 生成 tag 名：<tagPrefix>/<runId>/m<N>
   * 4. 获取 commit SHA（默认 HEAD：git rev-parse HEAD）
   * 5. 创建 git tag：git tag -a <tagName> <commitSha> -m "<name>"
   * 6. 触发回归测试：执行 npm test，解析输出统计
   * 7. 计算健康度（HealthScoreCalculator）
   * 8. 构造 MilestoneRecord（含 tag / commitSha / regressionResult / healthScore）
   * 9. 返回冻结的 MilestoneRecord
   *
   * @param request tag 请求
   * @returns 里程碑记录（含 tagName / commitSha / regressionResult / healthScore）
   * @throws MilestoneTaggerError 请求非法 / git tag 创建失败 / 回归测试执行失败
   */
  async tag(request: Readonly<MilestoneTagRequest>): Promise<Readonly<MilestoneRecord>> {
    // 1. 校验请求字段
    this.validateTagRequest(request);

    const projectRootAbs = path.resolve(request.projectRoot);
    this.log(`生成里程碑 tag：runId=${request.runId} name="${request.name}"`, "info");

    // 2. 加载 RunState 获取已有 milestone 数量
    const runState = await this.runStateStore.load(request.runId, projectRootAbs);
    const nextIndex = runState.milestones.length + 1;

    // 3. 生成 tag 名：<tagPrefix>/<runId>/m<N>
    const tagName = `${this.tagPrefix}/${request.runId}/m${nextIndex}`;
    this.log(`里程碑 tag 名：${tagName}`, "info");

    // 4. 获取 commit SHA（默认 HEAD）
    const commitSha = request.commitSha ?? this.getHeadSha(projectRootAbs);
    this.log(`commit SHA：${commitSha}`, "info");

    // 5. 创建 git tag（带注释的 tag，含名称作为消息）
    this.createGitTag(tagName, commitSha, request.name, projectRootAbs);
    this.log(`git tag 创建成功：${tagName}`, "info");

    // 6. 触发回归测试
    const regressionResult = this.runRegressionTests(projectRootAbs);
    this.log(
      `回归测试完成：total=${regressionResult.totalTests} passed=${regressionResult.passedTests} failed=${regressionResult.failedTests}`,
      "info"
    );

    // 7. 计算健康度（默认全部红线通过 + 无覆盖率报告时覆盖率为 0）
    const healthScore = this.healthScoreCalculator.calculate(
      regressionResult,
      DEFAULT_REDLINE_PASS_RATE,
      DEFAULT_COVERAGE_RATE
    );
    this.log(`健康度：${healthScore}`, "info");

    // 8. 构造 MilestoneRecord
    const milestone: MilestoneRecord = Object.freeze({
      index: nextIndex,
      name: request.name,
      loopType: request.loopType,
      completedAt: new Date().toISOString(),
      tagName,
      commitSha,
      regressionResult: Object.freeze({ ...regressionResult }),
      healthScore,
    });

    return milestone;
  }

  /**
   * 回滚到上一个 milestone tag
   *
   * 算法（对齐 §4.15.2）：
   * 1. 加载 RunState 获取 milestone 列表
   * 2. 若 milestones.length < 2 → 返回 null（无前一个可回滚）
   * 3. 取上一个 milestone（milestones[length - 2]）的 tagName
   * 4. 执行 git reset --hard <tagName>
   * 5. 返回回滚到的 MilestoneRecord
   *
   * 注意：回滚到 milestone[N-1] 时，milestone[N] 仍保留在 git 历史中
   * （通过 tag 标记），但工作区文件已恢复到 milestone[N-1] 的状态。
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 回滚到的里程碑记录（null = 无可回滚的里程碑）
   * @throws MilestoneTaggerError RunState 加载失败 / git reset 失败
   */
  async rollback(runId: string, projectRoot: string): Promise<Readonly<MilestoneRecord> | null> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "runId 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "projectRoot 必须为非空字符串");
    }

    const projectRootAbs = path.resolve(projectRoot);
    this.log(`回滚到上一个 milestone：runId=${runId}`, "info");

    // 2. 加载 RunState 获取 milestone 列表
    const runState = await this.runStateStore.load(runId, projectRootAbs);
    const milestones = runState.milestones;

    // 3. 若 milestones.length < 2，无前一个可回滚
    if (milestones.length < 2) {
      this.log(`无可回滚的里程碑：milestones.length=${milestones.length}`, "warn");
      return null;
    }

    // 4. 取上一个 milestone（倒数第二个，因为最后一个失败才需要回滚到上一个）
    const previousMilestone = milestones[milestones.length - 2];
    this.log(`回滚目标：${previousMilestone.tagName}`, "info");

    // 5. 执行 git reset --hard <tagName>
    this.hardResetToTag(previousMilestone.tagName, projectRootAbs);
    this.log(`git reset --hard ${previousMilestone.tagName} 完成`, "info");

    return previousMilestone;
  }

  /**
   * 列出所有里程碑 tag
   *
   * 算法（对齐 §4.15.2）：
   * 1. 加载 RunState 获取 milestone 列表（RunState 中已记录历史 milestone）
   * 2. 返回按序号升序排序的列表
   *
   * 注意：本方法从 RunState 读取 milestone 列表，而非直接 git tag -l。
   * 设计理由：RunState 中记录的 milestone 含完整字段（健康度/回归结果），
   * git tag -l 仅返回 tag 名，需额外查询 RunState 补全字段。
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 里程碑记录列表（按序号升序）
   * @throws MilestoneTaggerError RunState 加载失败
   */
  async listTags(runId: string, projectRoot: string): Promise<ReadonlyArray<MilestoneRecord>> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "runId 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "projectRoot 必须为非空字符串");
    }

    const projectRootAbs = path.resolve(projectRoot);
    this.log(`列出里程碑 tag：runId=${runId}`, "info");

    // 2. 加载 RunState 获取 milestone 列表
    const runState = await this.runStateStore.load(runId, projectRootAbs);
    const milestones = [...runState.milestones];

    // 3. 按序号升序排序
    milestones.sort((a, b) => a.index - b.index);

    return Object.freeze(milestones);
  }

  // ============================ 私有方法 ============================

  /**
   * 校验 tag 请求字段
   *
   * @param request tag 请求
   * @throws MilestoneTaggerError 任一字段非法
   */
  private validateTagRequest(request: Readonly<MilestoneTagRequest>): void {
    if (!request || typeof request !== "object") {
      throw new MilestoneTaggerError("invalid-request", "request 必须为对象");
    }
    if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "runId 必须为非空字符串");
    }
    // runId 仅允许字母/数字/连字符（防止路径穿越攻击）
    if (!/^[a-zA-Z0-9-]+$/.test(request.runId)) {
      throw new MilestoneTaggerError("invalid-request", `runId 仅允许字母/数字/连字符，实际值：${request.runId}`);
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "projectRoot 必须为非空字符串");
    }
    if (typeof request.name !== "string" || request.name.trim().length === 0) {
      throw new MilestoneTaggerError("invalid-request", "name 必须为非空字符串");
    }
    // loopType 校验：必须为 "design" | "coding" | "testing"
    if (request.loopType !== "design" && request.loopType !== "coding" && request.loopType !== "testing") {
      throw new MilestoneTaggerError(
        "invalid-request",
        `loopType 非法：${request.loopType}（合法值：design/coding/testing）`
      );
    }
  }

  /**
   * 获取当前 HEAD 的 commit SHA
   *
   * @param projectRoot 项目根目录
   * @returns 40 字符的 commit SHA
   * @throws MilestoneTaggerError git rev-parse HEAD 失败
   */
  private getHeadSha(projectRoot: string): string {
    try {
      return execGit(["rev-parse", "HEAD"], projectRoot, this.log);
    } catch (err) {
      throw new MilestoneTaggerError(
        "git-command-failed",
        `获取 HEAD SHA 失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  /**
   * 创建 git tag（带注释）
   *
   * 算法：git tag -a <tagName> <commitSha> -m "<message>"
   * 若 tag 已存在，git tag 命令会返回非 0 退出码，抛 git-tag-create-failed。
   *
   * @param tagName tag 名（如 "eag/a1b2c3d4e5f6/m1"）
   * @param commitSha commit SHA
   * @param message tag 消息（里程碑名称）
   * @param projectRoot 项目根目录
   * @throws MilestoneTaggerError tag 创建失败
   */
  private createGitTag(tagName: string, commitSha: string, message: string, projectRoot: string): void {
    try {
      execGit(["tag", "-a", tagName, commitSha, "-m", message], projectRoot, this.log);
    } catch (err) {
      // 检测 tag 已存在错误（git stderr 含 "already exists"）
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("already exists")) {
        throw new MilestoneTaggerError("git-tag-create-failed", `git tag 已存在：${tagName}`, err);
      }
      throw new MilestoneTaggerError("git-tag-create-failed", `git tag 创建失败：${tagName} 错误：${errMsg}`, err);
    }
  }

  /**
   * 执行 git reset --hard <tagName>
   *
   * @param tagName tag 名
   * @param projectRoot 项目根目录
   * @throws MilestoneTaggerError git reset 失败
   */
  private hardResetToTag(tagName: string, projectRoot: string): void {
    try {
      execGit(["reset", "--hard", tagName], projectRoot, this.log);
    } catch (err) {
      throw new MilestoneTaggerError(
        "git-reset-failed",
        `git reset --hard ${tagName} 失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  /**
   * 运行回归测试
   *
   * 算法：
   * 1. 在 projectRoot 下执行回归测试命令（默认 "npm test"）
   * 2. 解析输出统计 totalTests/passedTests/failedTests
   *    - 解析 node:test TAP 输出：以 "# tests N" / "# pass N" / "# fail N" 行为标记
   *    - 兼容 Mocha 输出：以 "passing (N)" / "failing (N)" 行为标记
   *    - 兜底：若无法解析，totalTests=0 / passedTests=0 / failedTests=0
   * 3. 计算执行耗时
   * 4. 构造 RegressionResult
   *
   * @param projectRoot 项目根目录
   * @returns 回归测试结果
   */
  private runRegressionTests(projectRoot: string): RegressionResult {
    const startTime = Date.now();
    this.log(`运行回归测试：cmd="${this.regressionTestCommand}" cwd=${projectRoot}`, "info");

    // 拆分命令为程序 + 参数（简化实现：按空格切分）
    const parts = this.regressionTestCommand.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    let exitCode = 0;

    try {
      const result = childProcess.spawnSync(cmd, args, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.regressionTestTimeoutSec * 1000,
      });

      exitCode = result.status ?? 1;
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const combinedOutput = stdout + "\n" + stderr;

      // 解析测试统计
      const stats = this.parseTestStats(combinedOutput);
      totalTests = stats.totalTests;
      passedTests = stats.passedTests;
      failedTests = stats.failedTests;

      this.log(
        `回归测试输出解析：total=${totalTests} passed=${passedTests} failed=${failedTests} exitCode=${exitCode}`,
        "info"
      );
    } catch (err) {
      this.log(`回归测试执行异常：${err instanceof Error ? err.message : String(err)}`, "error");
      // 执行异常视为失败，但不抛错（避免阻塞 tag 创建流程）
      exitCode = 1;
    }

    const durationSec = (Date.now() - startTime) / 1000;

    return Object.freeze({
      totalTests,
      passedTests,
      failedTests,
      exitCode,
      durationSec: Math.round(durationSec * 1000) / 1000,
    });
  }

  /**
   * 解析测试输出统计
   *
   * 支持 node:test TAP 格式与 Mocha 格式：
   * - node:test TAP：
   *   # tests N
   *   # pass N
   *   # fail N
   * - Mocha：
   *   passing (N)
   *   failing (N)
   * - 兜底：返回全 0
   *
   * @param output 测试输出（stdout + stderr 合并）
   * @returns 测试统计
   */
  private parseTestStats(output: string): {
    readonly totalTests: number;
    readonly passedTests: number;
    readonly failedTests: number;
  } {
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    // 1. 尝试解析 node:test TAP 格式
    const totalMatch = output.match(/^#\s*tests\s+(\d+)/m);
    const passMatch = output.match(/^#\s*pass\s+(\d+)/m);
    const failMatch = output.match(/^#\s*fail\s+(\d+)/m);

    if (totalMatch) {
      totalTests = parseInt(totalMatch[1], 10);
      passedTests = passMatch ? parseInt(passMatch[1], 10) : 0;
      failedTests = failMatch ? parseInt(failMatch[1], 10) : 0;
      // 若 totalTests 未解析到但有 pass/fail，则推算
      if (totalTests === 0 && (passedTests > 0 || failedTests > 0)) {
        totalTests = passedTests + failedTests;
      }
      return { totalTests, passedTests, failedTests };
    }

    // 2. 尝试解析 Mocha 格式
    const passingMatch = output.match(/(\d+)\s+passing/m);
    const failingMatch = output.match(/(\d+)\s+failing/m);
    if (passingMatch || failingMatch) {
      passedTests = passingMatch ? parseInt(passingMatch[1], 10) : 0;
      failedTests = failingMatch ? parseInt(failingMatch[1], 10) : 0;
      totalTests = passedTests + failedTests;
      return { totalTests, passedTests, failedTests };
    }

    // 3. 兜底：返回全 0
    return { totalTests: 0, passedTests: 0, failedTests: 0 };
  }
}

// ============================================================================
// 7. 默认日志函数
// ============================================================================

/**
 * 空日志函数（默认值，避免每次调用都判断 null）
 *
 * 设计理由：与 long-horizon 其他模块保持一致的 noopLog 模式。
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认不输出日志
}
