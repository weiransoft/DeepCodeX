/**
 * EAG-P5 Phase 5.4 /eag-autonomous CLI 命令处理器（TASK-P5-5.4-001）
 *
 * 本模块实现 `/eag-autonomous` 命令的参数解析与执行调度，是 EAG-P5 无人值守编排器
 * 对接 session.ts 主对话循环的入口。
 *
 * 核心职责（对齐架构师审查 §4.1 + §5 CLI 命令规范）：
 * 1. 参数解析：从命令字符串 `/eag-autonomous --goal "<目标>" --max-iterations 10 --confirmation smart`
 *    提取 goal / max-iterations / confirmation / test-command / stop-when 等参数
 * 2. 请求装配：将解析后的参数映射为 AutonomousRunRequest（对齐 §4.1 接口契约）
 * 3. 编排调度：委托 AutonomousOrchestrator.run() 执行 4 阶段循环
 * 4. 结果渲染：将 AutonomousRunResult 格式化为人类可读的 Markdown 报告
 *
 * 与 /eag-deploy 命令的设计同构（对齐 §5.1 extractDeployRequestFromPrompt 模式）：
 * - 命令字符串本身含参数（非严格匹配），参数由独立函数 extractEagAutonomousRequestFromPrompt 解析
 * - 解析失败的错误信息含参数名与取值范围（便于调用方诊断）
 * - 装配的请求对象通过 Object.freeze 冻结（§5.12.4 G-A6d 不可变优先）
 *
 * 命令格式规范（对齐用户任务说明）：
 * ```
 * /eag-autonomous --goal "<目标>" --max-iterations 10 --confirmation smart
 * ```
 * 参数说明：
 * - --goal（必填）：用户目标文本，如"为订单服务加退款功能"，支持单/双引号包裹
 * - --max-iterations（可选，默认 10）：最大迭代次数，正整数 1-1000
 * - --confirmation（可选，默认 smart）：确认模式，取值 smart / always-ask / fail-closed
 * - --test-command（可选，默认 "npm test"）：测试命令字符串
 * - --stop-when（可选，默认空）：确定性停止条件，如 "all tests pass"
 * - --max-tokens（可选，默认 200000）：最大 Token 预算，正整数
 * - --test-timeout-sec（可选，默认 600）：测试超时秒数，正整数
 * - --consecutive-failure-abort（可选，默认 3）：连续失败 abort 阈值，正整数
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/cli/eag-autonomous-command
 */

import type { AutonomousOrchestrator } from "../p5/autonomous-orchestrator";
import type { AutonomousRunRequest, AutonomousRunResult } from "../p5/autonomous-orchestrator";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * /eag-autonomous 命令前缀字符串
 *
 * 用于检测用户输入是否为 /eag-autonomous 命令。
 * 使用 Object.freeze 冻结，防止运行期篡改。
 */
export const EAG_AUTONOMOUS_COMMAND_PREFIX = "/eag-autonomous" as const;

/**
 * /eag-autonomous 命令合法的 confirmation 取值集合
 *
 * - smart：智能三态确认（默认，基于 SmartConfirmation 决策）
 * - always-ask：始终询问用户（保守策略，所有命令转人工确认）
 * - fail-closed：失败即关闭（最严格策略，任一风险即拒绝）
 *
 * 使用 Object.freeze 冻结。
 */
export const EAG_AUTONOMOUS_CONFIRMATION_VALUES = Object.freeze(["smart", "always-ask", "fail-closed"] as const);

/**
 * /eag-autonomous 命令合法的 confirmation 类型
 *
 * 字面量联合类型，编译期防止拼写错误。
 */
export type EagAutonomousConfirmation = (typeof EAG_AUTONOMOUS_CONFIRMATION_VALUES)[number];

/**
 * /eag-autonomous 命令默认最大迭代次数
 *
 * 对齐架构师审查 §4.4 AutonomousConfig.maxIterations 默认值（10）。
 * 取值 10：覆盖大多数中小型任务的 4 阶段循环需求。
 */
const EAG_AUTONOMOUS_DEFAULT_MAX_ITERATIONS = 10 as const;

/**
 * /eag-autonomous 命令默认 confirmation 模式
 *
 * 取值 "smart"：智能三态确认，平衡自动化与安全性。
 */
const EAG_AUTONOMOUS_DEFAULT_CONFIRMATION: EagAutonomousConfirmation = "smart" as const;

/**
 * /eag-autonomous 命令默认测试命令
 *
 * 对齐 verify-stage-handler.ts 的默认值（"npm test"）。
 */
const EAG_AUTONOMOUS_DEFAULT_TEST_COMMAND = "npm test" as const;

/**
 * /eag-autonomous 命令默认测试超时（秒）
 *
 * 对齐架构师审查 §4.4 AutonomousConfig.testTimeoutSec 默认值（600）。
 */
const EAG_AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC = 600 as const;

/**
 * /eag-autonomous 命令默认最大 Token 预算
 *
 * 对齐架构师审查 §4.4 AutonomousConfig.maxTokens 默认值（200000）。
 */
const EAG_AUTONOMOUS_DEFAULT_MAX_TOKENS = 200_000 as const;

/**
 * /eag-autonomous 命令默认连续失败 abort 阈值
 *
 * 对齐架构师审查 §4.4 AutonomousConfig.consecutiveFailureAbort 默认值（3）。
 */
const EAG_AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT = 3 as const;

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * /eag-autonomous 命令请求对象（TASK-P5-5.4-001）
 *
 * 由 extractEagAutonomousRequestFromPrompt() 从命令字符串解析后装配，
 * 再由 session.ts 注入到 userPrompt.messageParams.autonomousRunRequest。
 *
 * 字段说明（对齐 §5 CLI 命令规范）：
 * - goal: 用户目标文本（必填，非空字符串）
 * - maxIterations: 最大迭代次数（默认 10，1-1000 正整数）
 * - confirmation: 确认模式（默认 smart，取值 smart / always-ask / fail-closed）
 * - testCommand: 测试命令（默认 "npm test"）
 * - stopWhen: 确定性停止条件（可选，如 "all tests pass"）
 * - maxTokens: 最大 Token 预算（默认 200000）
 * - testTimeoutSec: 测试超时秒数（默认 600）
 * - consecutiveFailureAbort: 连续失败 abort 阈值（默认 3）
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 所有字段为 readonly
 * - 实例由 extractEagAutonomousRequestFromPrompt() 通过 Object.freeze 冻结后返回
 */
export interface EagAutonomousRequest {
  /** 用户目标文本（必填，非空字符串，如"为订单服务加退款功能"） */
  readonly goal: string;
  /** 最大迭代次数（默认 10，正整数 1-1000） */
  readonly maxIterations: number;
  /** 确认模式（默认 smart，取值 smart / always-ask / fail-closed） */
  readonly confirmation: EagAutonomousConfirmation;
  /** 测试命令（默认 "npm test"，非空字符串） */
  readonly testCommand: string;
  /** 确定性停止条件（可选，空字符串表示不设置 stop_when） */
  readonly stopWhen: string;
  /** 最大 Token 预算（默认 200000，正整数） */
  readonly maxTokens: number;
  /** 测试超时秒数（默认 600，正整数） */
  readonly testTimeoutSec: number;
  /** 连续失败 abort 阈值（默认 3，正整数） */
  readonly consecutiveFailureAbort: number;
}

/**
 * /eag-autonomous 命令执行结果（TASK-P5-5.4-001）
 *
 * 由 EagAutonomousCommandHandler.execute() 返回，包含：
 * - 原始 AutonomousRunResult（不可变）
 * - 格式化的 Markdown 报告（人类可读）
 * - 执行是否成功（success）
 * - 错误信息（失败时填写）
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface EagAutonomousCommandResult {
  /** 执行是否成功（true=orchestrator.run() 未抛异常） */
  readonly success: boolean;
  /** 原始运行结果（失败时为 undefined） */
  readonly runResult?: Readonly<AutonomousRunResult>;
  /** 格式化的 Markdown 报告（人类可读，含 finalStatus / 统计 / 里程碑） */
  readonly markdownReport: string;
  /** 错误信息（失败时填写，成功时为空字符串） */
  readonly errorMessage: string;
}

// ============================================================================
// 3. 参数解析函数（extractEagAutonomousRequestFromPrompt）
// ============================================================================

/**
 * 从 /eag-autonomous 命令字符串解析请求对象（TASK-P5-5.4-001）
 *
 * 此函数为**导出的独立函数**（非类方法），供 session.ts 在
 * 构造 userPrompt.messageParams.autonomousRunRequest 时调用。
 *
 * 算法（对齐 §5 CLI 命令规范 + 参考 extractDeployRequestFromPrompt 模式）：
 * 1. 校验 prompt 为非空字符串
 * 2. 移除命令前缀 /eag-autonomous（大小写不敏感，匹配后裁剪）
 * 3. 用正则解析 --key value 形式参数（支持单引号 / 双引号包裹的值）
 * 4. 校验必填参数 --goal（非空字符串）
 * 5. 校验可选参数取值范围与类型：
 *    - --max-iterations: 正整数 1-1000
 *    - --confirmation: smart / always-ask / fail-closed
 *    - --test-command: 非空字符串
 *    - --stop-when: 任意字符串（可选）
 *    - --max-tokens: 正整数
 *    - --test-timeout-sec: 正整数
 *    - --consecutive-failure-abort: 正整数
 * 6. 装配 EagAutonomousRequest 对象并 Object.freeze 冻结
 * 7. 任一校验失败抛 Error，错误信息含参数名与取值范围
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 返回的 EagAutonomousRequest 对象通过 Object.freeze 冻结
 * - 函数内部使用的常量集合亦被 Object.freeze 冻结
 *
 * @param prompt /eag-autonomous 命令字符串（含命令前缀与参数）
 * @returns 冻结的 EagAutonomousRequest 对象
 * @throws {Error} 当 prompt 非字符串、命令前缀不匹配、必填参数缺失、取值范围非法时抛出
 */
export function extractEagAutonomousRequestFromPrompt(prompt: string): EagAutonomousRequest {
  // 步骤 1：校验 prompt 为非空字符串
  if (typeof prompt !== "string") {
    throw new Error("extractEagAutonomousRequestFromPrompt: prompt 必须为非空字符串");
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error("extractEagAutonomousRequestFromPrompt: prompt 不能为空字符串");
  }

  // 步骤 2：移除命令前缀 /eag-autonomous（大小写不敏感）
  // 使用正则匹配前缀（大小写不敏感），后跟空白字符或字符串结尾
  const prefixMatch = /^\/eag-autonomous(?:\s+|$)/i.exec(trimmed);
  if (!prefixMatch) {
    throw new Error(
      `extractEagAutonomousRequestFromPrompt: 命令前缀不匹配，期望以 /eag-autonomous 开头（大小写不敏感），实际为: ${trimmed}`
    );
  }
  // 截取前缀之后的部分作为参数字符串
  const argsPart = trimmed.slice(prefixMatch[0].length).trim();

  // 步骤 3：用正则解析 --key value 形式参数
  // 正则说明（与 extractDeployRequestFromPrompt 一致）：
  // - --([\w][\w-]*)                              匹配参数名 → 捕获组 1
  // - (?:[=\s]+                                   分隔符（= 或空白，至少一个）
  //   (?:"([^"]*)"                                双引号值 → 捕获组 2
  //   |'([^']*)'                                  单引号值 → 捕获组 3
  //   |(?!--)([^\s"']+)                           裸值（不以 -- 开头）→ 捕获组 4
  //   ))?                                         整个值组可选（支持 flag 形式）
  // - (?=\s|$)                                    前瞻断言：匹配结束位置必须是空白或字符串结尾
  const argPattern = /--([\w][\w-]*)(?:[=\s]+(?:"([^"]*)"|'([^']*)'|(?!--)([^\s"']+)))?(?=\s|$)/g;
  const args: Record<string, string | true> = {};

  // 注意：重复参数首次匹配生效（后续覆盖被跳过）
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(argsPart)) !== null) {
    const key = match[1];
    // 三种值形式：双引号（match[2]）、单引号（match[3]）、裸值（match[4]）；均未匹配则为 flag（true）
    const value = match[2] ?? match[3] ?? match[4] ?? true;
    // 仅首次匹配生效（重复参数被跳过）
    if (!(key in args)) {
      args[key] = value;
    }
  }

  // 步骤 4：校验必填参数 --goal（非空字符串）
  const goalRaw = args["goal"];
  if (goalRaw === undefined || goalRaw === true || String(goalRaw).trim().length === 0) {
    throw new Error(
      'extractEagAutonomousRequestFromPrompt: 缺少必填参数 --goal 或值为空（期望非空字符串，如 --goal "为订单服务加退款功能"）'
    );
  }
  const goal = String(goalRaw).trim();

  // 步骤 5：校验可选参数并应用默认值

  // --max-iterations: 正整数 1-1000，默认 10
  const maxIterationsRaw = args["max-iterations"];
  let maxIterations: number;
  if (maxIterationsRaw === undefined) {
    maxIterations = EAG_AUTONOMOUS_DEFAULT_MAX_ITERATIONS;
  } else if (maxIterationsRaw === true) {
    throw new Error("extractEagAutonomousRequestFromPrompt: --max-iterations 必须提供值（期望正整数 1-1000）");
  } else {
    maxIterations = Number(maxIterationsRaw);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000) {
      throw new Error(
        `extractEagAutonomousRequestFromPrompt: --max-iterations 取值非法（期望正整数 1-1000，实际为: ${maxIterationsRaw}）`
      );
    }
  }

  // --confirmation: smart / always-ask / fail-closed，默认 smart
  const confirmationRaw = args["confirmation"];
  let confirmation: EagAutonomousConfirmation;
  if (confirmationRaw === undefined) {
    confirmation = EAG_AUTONOMOUS_DEFAULT_CONFIRMATION;
  } else if (confirmationRaw === true) {
    throw new Error(
      "extractEagAutonomousRequestFromPrompt: --confirmation 必须提供值（期望取值: smart | always-ask | fail-closed）"
    );
  } else if (!EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes(confirmationRaw as EagAutonomousConfirmation)) {
    throw new Error(
      `extractEagAutonomousRequestFromPrompt: --confirmation 取值非法（期望 smart | always-ask | fail-closed，实际为: ${confirmationRaw}）`
    );
  } else {
    confirmation = confirmationRaw as EagAutonomousConfirmation;
  }

  // --test-command: 非空字符串，默认 "npm test"
  const testCommandRaw = args["test-command"];
  let testCommand: string;
  if (testCommandRaw === undefined) {
    testCommand = EAG_AUTONOMOUS_DEFAULT_TEST_COMMAND;
  } else if (testCommandRaw === true || String(testCommandRaw).trim().length === 0) {
    throw new Error('extractEagAutonomousRequestFromPrompt: --test-command 取值非法（期望非空字符串，如 "npm test"）');
  } else {
    testCommand = String(testCommandRaw).trim();
  }

  // --stop-when: 任意字符串（可选，默认空字符串）
  const stopWhenRaw = args["stop-when"];
  const stopWhen = stopWhenRaw === undefined || stopWhenRaw === true ? "" : String(stopWhenRaw).trim();

  // --max-tokens: 正整数，默认 200000
  const maxTokensRaw = args["max-tokens"];
  let maxTokens: number;
  if (maxTokensRaw === undefined) {
    maxTokens = EAG_AUTONOMOUS_DEFAULT_MAX_TOKENS;
  } else if (maxTokensRaw === true) {
    throw new Error("extractEagAutonomousRequestFromPrompt: --max-tokens 必须提供值（期望正整数）");
  } else {
    maxTokens = Number(maxTokensRaw);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new Error(
        `extractEagAutonomousRequestFromPrompt: --max-tokens 取值非法（期望正整数，实际为: ${maxTokensRaw}）`
      );
    }
  }

  // --test-timeout-sec: 正整数，默认 600
  const testTimeoutSecRaw = args["test-timeout-sec"];
  let testTimeoutSec: number;
  if (testTimeoutSecRaw === undefined) {
    testTimeoutSec = EAG_AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC;
  } else if (testTimeoutSecRaw === true) {
    throw new Error("extractEagAutonomousRequestFromPrompt: --test-timeout-sec 必须提供值（期望正整数）");
  } else {
    testTimeoutSec = Number(testTimeoutSecRaw);
    if (!Number.isInteger(testTimeoutSec) || testTimeoutSec < 1) {
      throw new Error(
        `extractEagAutonomousRequestFromPrompt: --test-timeout-sec 取值非法（期望正整数，实际为: ${testTimeoutSecRaw}）`
      );
    }
  }

  // --consecutive-failure-abort: 正整数，默认 3
  const consecutiveFailureAbortRaw = args["consecutive-failure-abort"];
  let consecutiveFailureAbort: number;
  if (consecutiveFailureAbortRaw === undefined) {
    consecutiveFailureAbort = EAG_AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT;
  } else if (consecutiveFailureAbortRaw === true) {
    throw new Error("extractEagAutonomousRequestFromPrompt: --consecutive-failure-abort 必须提供值（期望正整数）");
  } else {
    consecutiveFailureAbort = Number(consecutiveFailureAbortRaw);
    if (!Number.isInteger(consecutiveFailureAbort) || consecutiveFailureAbort < 1) {
      throw new Error(
        `extractEagAutonomousRequestFromPrompt: --consecutive-failure-abort 取值非法（期望正整数，实际为: ${consecutiveFailureAbortRaw}）`
      );
    }
  }

  // 步骤 6：装配 EagAutonomousRequest 对象并 Object.freeze 冻结
  const request: EagAutonomousRequest = {
    goal,
    maxIterations,
    confirmation,
    testCommand,
    stopWhen,
    maxTokens,
    testTimeoutSec,
    consecutiveFailureAbort,
  };
  return Object.freeze(request) as EagAutonomousRequest;
}

// ============================================================================
// 4. EagAutonomousCommandHandler 类
// ============================================================================

/**
 * /eag-autonomous 命令处理器（TASK-P5-5.4-001）
 *
 * 职责：
 * 1. 接收 EagAutonomousRequest（已由 extractEagAutonomousRequestFromPrompt 解析）
 * 2. 装配 AutonomousRunRequest（映射字段 + 注入 projectRoot）
 * 3. 委托 AutonomousOrchestrator.run() 执行 4 阶段循环
 * 4. 将 AutonomousRunResult 格式化为 Markdown 报告
 * 5. 异常兜底：捕获 orchestrator 抛出的异常，返回 success=false 的结果
 *
 * 设计原则（对齐 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
 * - 不在 handler 内部 new AutonomousOrchestrator（由调用方注入完整装配的实例）
 * - handler 仅负责装配请求 + 调用 run() + 渲染结果
 * - 不可变优先：所有接口字段 readonly + Object.freeze
 *
 * 使用方式：
 * ```typescript
 * const handler = new EagAutonomousCommandHandler(orchestrator);
 * const request = extractEagAutonomousRequestFromPrompt(
 *   '/eag-autonomous --goal "为订单服务加退款功能" --max-iterations 10'
 * );
 * const result = await handler.execute(request, "/path/to/project");
 * console.log(result.markdownReport);
 * ```
 */
export class EagAutonomousCommandHandler {
  /** 注入的 AutonomousOrchestrator 实例（由调用方完整装配依赖后注入） */
  private readonly orchestrator: AutonomousOrchestrator;

  /**
   * @param orchestrator 已装配完整依赖的 AutonomousOrchestrator 实例
   * @throws Error orchestrator 为空时抛出（fail-closed）
   */
  constructor(orchestrator: AutonomousOrchestrator) {
    if (!orchestrator) {
      throw new Error("EagAutonomousCommandHandler 构造失败：orchestrator 必填");
    }
    this.orchestrator = orchestrator;
  }

  /**
   * 执行 /eag-autonomous 命令
   *
   * 算法：
   * 1. 校验入参（request + projectRoot 必填）
   * 2. 装配 AutonomousRunRequest（映射字段 + 注入 projectRoot）
   * 3. 调用 orchestrator.run() 执行 4 阶段循环
   * 4. 格式化 AutonomousRunResult 为 Markdown 报告
   * 5. 异常兜底：捕获异常，返回 success=false 的结果
   *
   * @param request 已解析的 EagAutonomousRequest
   * @param projectRoot 项目根目录（绝对路径）
   * @returns 命令执行结果（不可变，Object.freeze 冻结）
   */
  async execute(
    request: Readonly<EagAutonomousRequest>,
    projectRoot: string
  ): Promise<Readonly<EagAutonomousCommandResult>> {
    // 1. 校验入参
    this.validateRequest(request);
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new Error("EagAutonomousCommandHandler.execute 失败：projectRoot 必须为非空字符串");
    }

    // 2. 装配 AutonomousRunRequest
    // 字段映射：
    // - objective ← request.goal（用户目标文本）
    // - maxIterations ← request.maxIterations
    // - testCommand ← request.testCommand
    // - stopWhen ← request.stopWhen（空字符串表示不设置）
    // - maxTokens ← request.maxTokens
    // - testTimeoutSec ← request.testTimeoutSec
    // - consecutiveFailureAbort ← request.consecutiveFailureAbort
    // 注：confirmation 字段由 SmartConfirmation 内部处理，此处不直接映射到 AutonomousRunRequest
    //     （Phase 5.3 decideWithContext 通过 context 传入，Phase 5.4 暂不启用扩展数据源）
    const runRequest: AutonomousRunRequest = Object.freeze({
      projectRoot,
      objective: request.goal,
      maxIterations: request.maxIterations,
      maxTokens: request.maxTokens,
      stopWhen: request.stopWhen,
      testCommand: request.testCommand,
      testTimeoutSec: request.testTimeoutSec,
      consecutiveFailureAbort: request.consecutiveFailureAbort,
    });

    // 3. 调用 orchestrator.run() 执行 4 阶段循环
    let runResult: AutonomousRunResult;
    try {
      runResult = await this.orchestrator.run(runRequest);
    } catch (err) {
      // 异常兜底：返回 success=false 的结果
      const errorMessage = err instanceof Error ? err.message : String(err);
      const markdownReport = this.formatErrorReport(request, errorMessage);
      return Object.freeze({
        success: false,
        markdownReport,
        errorMessage,
      });
    }

    // 4. 格式化 AutonomousRunResult 为 Markdown 报告
    const markdownReport = this.formatSuccessReport(request, runResult);

    // 5. 返回冻结的结果对象
    return Object.freeze({
      success: true,
      runResult,
      markdownReport,
      errorMessage: "",
    });
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 校验 EagAutonomousRequest 入参
   *
   * @param request 命令请求
   * @throws Error 必填字段缺失或非法时抛出
   */
  private validateRequest(request: Readonly<EagAutonomousRequest>): void {
    if (!request || typeof request !== "object") {
      throw new Error("EagAutonomousRequest 必须为对象");
    }
    if (typeof request.goal !== "string" || request.goal.trim().length === 0) {
      throw new Error("EagAutonomousRequest.goal 必须为非空字符串");
    }
    if (
      typeof request.maxIterations !== "number" ||
      !Number.isInteger(request.maxIterations) ||
      request.maxIterations < 1 ||
      request.maxIterations > 1000
    ) {
      throw new Error(`EagAutonomousRequest.maxIterations 必须为正整数 1-1000，实际值：${request.maxIterations}`);
    }
    if (!EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes(request.confirmation)) {
      throw new Error(
        `EagAutonomousRequest.confirmation 非法：${request.confirmation}（合法值：smart / always-ask / fail-closed）`
      );
    }
    if (typeof request.testCommand !== "string" || request.testCommand.trim().length === 0) {
      throw new Error("EagAutonomousRequest.testCommand 必须为非空字符串");
    }
    if (typeof request.stopWhen !== "string") {
      throw new Error("EagAutonomousRequest.stopWhen 必须为字符串");
    }
    if (typeof request.maxTokens !== "number" || !Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
      throw new Error(`EagAutonomousRequest.maxTokens 必须为正整数，实际值：${request.maxTokens}`);
    }
    if (
      typeof request.testTimeoutSec !== "number" ||
      !Number.isInteger(request.testTimeoutSec) ||
      request.testTimeoutSec < 1
    ) {
      throw new Error(`EagAutonomousRequest.testTimeoutSec 必须为正整数，实际值：${request.testTimeoutSec}`);
    }
    if (
      typeof request.consecutiveFailureAbort !== "number" ||
      !Number.isInteger(request.consecutiveFailureAbort) ||
      request.consecutiveFailureAbort < 1
    ) {
      throw new Error(
        `EagAutonomousRequest.consecutiveFailureAbort 必须为正整数，实际值：${request.consecutiveFailureAbort}`
      );
    }
  }

  /**
   * 格式化成功执行的 Markdown 报告
   *
   * 报告结构（对齐 §4.1 AutonomousRunResult 字段）：
   * - 标题：[EAG Autonomous Loop] 执行结果
   * - 基本信息：runId / finalStatus / exitCode / 耗时
   * - 统计信息：迭代次数 / LLM 调用次数 / Token 消耗
   * - 里程碑列表：每轮 4 阶段全绿的记录
   * - 触发的护栏记录：BLOCKER / MAJOR 列表
   * - 阻塞分析报告（如有）
   *
   * @param request 原始命令请求（用于显示目标）
   * @param runResult 运行结果
   * @returns Markdown 格式报告
   */
  private formatSuccessReport(
    request: Readonly<EagAutonomousRequest>,
    runResult: Readonly<AutonomousRunResult>
  ): string {
    const lines: string[] = [];
    lines.push("# [EAG Autonomous Loop] 执行结果");
    lines.push("");
    lines.push("## 基本信息");
    lines.push(`- **目标**：${request.goal}`);
    lines.push(`- **Run ID**：${runResult.runId}`);
    lines.push(`- **最终状态**：${runResult.finalStatus}`);
    lines.push(`- **退出码**：${runResult.exitCode}`);
    lines.push(`- **总耗时**：${runResult.durationSec} 秒`);
    lines.push("");

    lines.push("## 统计信息");
    lines.push(`- **迭代次数**：${runResult.totalIterations}`);
    lines.push(`- **LLM 调用次数**：${runResult.totalLlmCallCount}`);
    lines.push(`- **Token 消耗**：${runResult.totalTokensUsed}`);
    lines.push(`- **完成的 Loop**：${runResult.completedLoops.join(", ") || "（无）"}`);
    lines.push("");

    // 里程碑列表
    if (runResult.milestones.length > 0) {
      lines.push("## 里程碑");
      for (const milestone of runResult.milestones) {
        lines.push(`- **#${milestone.index} ${milestone.name}**（${milestone.completedAt}）：${milestone.summary}`);
      }
      lines.push("");
    }

    // 触发的护栏记录
    if (runResult.triggeredGuards.length > 0) {
      lines.push("## 触发的护栏记录");
      for (const guard of runResult.triggeredGuards) {
        lines.push(
          `- [${guard.severity}] ${guard.ruleId}（迭代 ${guard.iterIndex} / 阶段 ${guard.stage}）：${guard.reason}`
        );
      }
      lines.push("");
    }

    // 阻塞分析报告
    if (runResult.blockageReport) {
      lines.push("## 阻塞分析报告");
      lines.push(`- **阻塞 Loop**：${runResult.blockageReport.blockedLoop}`);
      lines.push(`- **阻塞迭代**：${runResult.blockageReport.blockedIteration}`);
      lines.push(`- **阻塞阶段**：${runResult.blockageReport.blockedStage}`);
      lines.push(`- **阻塞原因**：${runResult.blockageReport.summary}`);
      if (runResult.blockageReport.rootCauseHypotheses.length > 0) {
        lines.push("- **根因假设**：");
        for (const hypothesis of runResult.blockageReport.rootCauseHypotheses) {
          lines.push(`  - ${hypothesis}`);
        }
      }
      if (runResult.blockageReport.suggestedSolutions.length > 0) {
        lines.push("- **建议方案**：");
        for (const solution of runResult.blockageReport.suggestedSolutions) {
          lines.push(`  - ${solution}`);
        }
      }
      lines.push("");
    }

    // 最终报告
    lines.push("## 最终报告");
    lines.push(runResult.finalReport);

    return lines.join("\n");
  }

  /**
   * 格式化错误执行的 Markdown 报告
   *
   * @param request 原始命令请求
   * @param errorMessage 错误信息
   * @returns Markdown 格式报告
   */
  private formatErrorReport(request: Readonly<EagAutonomousRequest>, errorMessage: string): string {
    const lines: string[] = [];
    lines.push("# [EAG Autonomous Loop] 执行失败");
    lines.push("");
    lines.push("## 基本信息");
    lines.push(`- **目标**：${request.goal}`);
    lines.push(`- **错误信息**：${errorMessage}`);
    lines.push("");
    lines.push("## 建议排查方向");
    lines.push("- 检查 projectRoot 路径是否存在且可读写");
    lines.push("- 检查 tasks.md 文件是否存在且格式正确");
    lines.push("- 检查 testCommand 是否可执行");
    lines.push("- 检查 AutonomousOrchestrator 的 5 个核心依赖是否完整注入");
    lines.push("- 查看 RunState 持久化文件（.eag/p5/run-state/<runId>.jsonl）了解失败位置");
    return lines.join("\n");
  }
}
