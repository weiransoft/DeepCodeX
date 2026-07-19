/**
 * EAG CLI 命令解析器——从 session.ts 抽取的命令判定与请求装配逻辑
 *
 * 设计依据：EAG-P3 批次 11 §5 S3 改进方案（决策清单 D-S3-1 ~ D-S3-8）
 *
 * 职责：
 * - 判定用户输入是否为 EAG 命令（/eag-design、/eag-test、/eag-run、/eag-resume、/eag-status、/eag-build）
 * - 从 userPrompt.messageParams 提取预装配的请求对象
 * - 提供 parse() 统一入口，返回 discriminated union 类型 EagCommand
 *
 * 设计原则（对齐 Karpathy Simplicity First 与 §5.12.4 G-A6d 配置冻结）：
 * - 无状态：纯函数式，不持有 session / 不读取文件系统（D-S3-2 / D-S3-4）
 * - 同步：parse() 不返回 Promise，避免无谓的异步开销
 * - 可注入：通过 SessionManagerOptions.eagCommandParser 可选注入（默认 new EagCommandParser()）
 * - 不可变优先：所有命令请求对象使用 readonly 字段，顶层常量使用 Object.freeze
 *
 * 入参契约（D-S3-2 / D-S3-7）：
 * - parse() 入参为 UserPromptContent（由 session.ts 调用前已构造完成）
 * - parser 通过 userPrompt.messageParams 字段访问预装配的请求对象
 * - parser 不直接访问 SessionManager 内部状态（架构师审查 B3-M4 修复）
 *
 * @module eag/cli/eag-command-parser
 */

import type { UserPromptContent } from "../../session";
import type { CodingLoopRequest } from "../coding/types";
import type { DesignLoopInput } from "../design/design-models";
import type { TestingLoopRequest } from "../testing/types";
import type { EagRunRequest, EagResumeRequest, EagStatusRequest } from "../long-horizon";

// ============================================================================
// EagCommand 类型定义（discriminated union，D-S3-3）
// ============================================================================

/**
 * EAG 命令类型联合（discriminated union）
 *
 * 每种命令对应一种 payload，TypeScript 在 switch(command.kind) 分支自动收窄类型。
 * payload 字段携带预装配的请求对象（从 userPrompt.messageParams 提取）。
 *
 * 设计说明（payload 可空性）：
 * - payload 类型为 `XxxRequest | null`
 * - 命令字符串匹配但 messageParams 中未提供 request 时，payload 为 null
 * - session.ts 的 handleEagXxxCommand 方法负责校验 payload 非空，并通知用户错误
 * - 此设计保持既有"未提供 request"错误提示路径不丢失（既有测试 G3/H3/I3/J3/K3 零回归）
 *
 * unknown 兜底分支：用户输入不是任何 EAG 命令时返回，session.ts 按既有非 EAG 流程处理。
 */
export type EagCommand =
  | { readonly kind: "eag-build"; readonly payload: CodingLoopRequest | null }
  | { readonly kind: "eag-design"; readonly payload: DesignLoopInput | null }
  | { readonly kind: "eag-test"; readonly payload: TestingLoopRequest | null }
  | { readonly kind: "eag-run"; readonly payload: EagRunRequest | null }
  | { readonly kind: "eag-resume"; readonly payload: EagResumeRequest | null }
  | { readonly kind: "eag-status"; readonly payload: EagStatusRequest | null }
  | { readonly kind: "unknown"; readonly payload: null };

/**
 * EAG 命令字符串常量集合（D-S3-6）
 *
 * 6 个 EAG 命令的严格匹配字符串。使用 Object.freeze 冻结（§5.12.4 G-A6d 配置冻结）。
 * 命令字符串严格匹配（无参数），参数通过 messageParams 注入（D-S3-7）。
 */
export const EAG_COMMAND_STRINGS = Object.freeze({
  /** /eag-build 命令字符串（触发 CODING Loop 编排，§4.9.3） */
  EAG_BUILD: "/eag-build",
  /** /eag-design 命令字符串（触发 DESIGN Loop 编排，§4.18.3） */
  EAG_DESIGN: "/eag-design",
  /** /eag-test 命令字符串（触发 TESTING Loop 编排，§4.18.3） */
  EAG_TEST: "/eag-test",
  /** /eag-run 命令字符串（触发长程自动化，§4.18.3） */
  EAG_RUN: "/eag-run",
  /** /eag-resume 命令字符串（从断点恢复长程自动化，§4.18.3） */
  EAG_RESUME: "/eag-resume",
  /** /eag-status 命令字符串（查询长程进度报告，§4.18.3） */
  EAG_STATUS: "/eag-status",
} as const);

/**
 * 冻结的 unknown 命令常量（§5.12.4 G-A6d 不可变优先）
 *
 * 用于 parseEagXxxCommand 方法的 false 分支，避免重复创建对象。
 * 此常量被 Object.freeze 冻结，运行期不可修改。
 */
const FROZEN_UNKNOWN_COMMAND: EagCommand = Object.freeze({
  kind: "unknown",
  payload: null,
}) as EagCommand;

// ============================================================================
// EagCommandParser 类（D-S3-1 / D-S3-4）
// ============================================================================

/**
 * EAG CLI 命令解析器
 *
 * 职责：
 * - 判定用户输入是否为 EAG 命令（/eag-build /eag-design /eag-test /eag-run /eag-resume /eag-status）
 * - 从 userPrompt.messageParams 提取预装配的请求对象
 * - 返回 EagCommand 类型联合
 *
 * 使用方式：
 * ```typescript
 * const parser = new EagCommandParser();
 * const command = parser.parse(userPrompt);
 * switch (command.kind) {
 *   case "eag-build": await handleEagBuildCommand(sessionId, command.payload, controller); break;
 *   // ...
 *   case "unknown": /* 非 EAG 命令流程 *\/
 * }
 * ```
 *
 * 不可变优先原则：
 * - 类本身无状态（无实例字段）
 * - 所有命令请求对象使用 readonly 字段
 * - 顶层常量使用 Object.freeze
 */
export class EagCommandParser {
  /**
   * 解析用户输入，返回 EagCommand 类型联合
   *
   * 算法（对齐设计文档 §5.2）：
   * 1. 校验 userPrompt.text 是否为字符串
   * 2. trim 后严格匹配 6 个 EAG 命令字符串
   * 3. 校验无图片附件、无技能匹配（避免误判）
   * 4. 从 messageParams 提取对应 payload（命令匹配但 payload 缺失时 payload 为 null）
   * 5. 未匹配任何命令 → 返回 { kind: "unknown", payload: null }
   *
   * 不可变优先（§5.12.4 G-A6d）：返回的 EagCommand 顶层对象被 Object.freeze 冻结，
   * 运行期不可修改 kind / payload 字段（payload 对象本身的冻结责任在调用方）。
   *
   * @param userPrompt 用户输入内容（含 messageParams 元数据）
   * @returns EagCommand 类型联合（顶层对象被冻结）
   */
  parse(userPrompt: UserPromptContent): EagCommand {
    // 调用 private resolveCommand 计算结果，再 Object.freeze 保证顶层不可变
    // Object.freeze 是幂等操作，对已冻结对象再次调用不会抛异常
    return Object.freeze(this.resolveCommand(userPrompt)) as EagCommand;
  }

  /**
   * 内部命令解析逻辑（返回未冻结的 EagCommand）
   *
   * 此方法为 private，外部应通过 parse() 访问。parse() 会 Object.freeze 返回对象。
   * 拆分原因：避免在 9 个 return 点重复写 Object.freeze，保持方法体简洁。
   *
   * @param userPrompt 用户输入内容（含 messageParams 元数据）
   * @returns EagCommand 类型联合（未冻结，由 parse() 负责冻结）
   */
  private resolveCommand(userPrompt: UserPromptContent): EagCommand {
    // 步骤 1：text 必须为字符串
    if (typeof userPrompt.text !== "string") {
      return { kind: "unknown", payload: null };
    }
    const text = userPrompt.text.trim();

    // 步骤 2：无图片附件、无技能匹配（避免误判，对齐 isEagXxxPrompt 既有逻辑）
    const hasImages = !!userPrompt.imageUrls && userPrompt.imageUrls.length > 0;
    const hasSkills = !!userPrompt.skills && userPrompt.skills.length > 0;
    if (hasImages || hasSkills) {
      return { kind: "unknown", payload: null };
    }

    // 步骤 3：严格匹配 6 个命令字符串（无参数，参数通过 messageParams 注入）
    switch (text) {
      case EAG_COMMAND_STRINGS.EAG_BUILD:
        return { kind: "eag-build", payload: this.extractCodingLoopRequest(userPrompt) };
      case EAG_COMMAND_STRINGS.EAG_DESIGN:
        return { kind: "eag-design", payload: this.extractDesignLoopInput(userPrompt) };
      case EAG_COMMAND_STRINGS.EAG_TEST:
        return { kind: "eag-test", payload: this.extractTestingLoopRequest(userPrompt) };
      case EAG_COMMAND_STRINGS.EAG_RUN:
        return { kind: "eag-run", payload: this.extractEagRunRequest(userPrompt) };
      case EAG_COMMAND_STRINGS.EAG_RESUME:
        return { kind: "eag-resume", payload: this.extractEagResumeRequest(userPrompt) };
      case EAG_COMMAND_STRINGS.EAG_STATUS:
        return { kind: "eag-status", payload: this.extractEagStatusRequest(userPrompt) };
      default:
        // 未匹配任何 EAG 命令，返回 unknown 兜底分支
        return { kind: "unknown", payload: null };
    }
  }

  // ============================================================================
  // 公开独立判定方法（供 session.ts 分流使用，对齐任务说明设计）
  // ============================================================================

  /**
   * 判定用户输入是否为 /eag-build 命令并提取 payload
   *
   * 判定规则（迁移自 session.ts L1853 isEagBuildPrompt）：
   * - text 为字符串且 trim 后等于 /eag-build
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-build" 或 "unknown"）
   */
  parseEagBuildCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-build" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-design 命令并提取 payload
   *
   * 判定规则（迁移自 session.ts L1872 isEagDesignPrompt）：
   * - text 为字符串且 trim 后等于 /eag-design
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-design" 或 "unknown"）
   */
  parseEagDesignCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-design" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-test 命令并提取 payload
   *
   * 判定规则（迁移自 session.ts L1890 isEagTestPrompt）：
   * - text 为字符串且 trim 后等于 /eag-test
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-test" 或 "unknown"）
   */
  parseEagTestCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-test" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-run 命令并提取 payload
   *
   * 判定规则（迁移自 session.ts L1908 isEagRunPrompt）：
   * - text 为字符串且 trim 后等于 /eag-run
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-run" 或 "unknown"）
   */
  parseEagRunCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-run" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-resume 命令并提取 payload
   *
   * 判定规则（迁移自 session.ts L1926 isEagResumePrompt）：
   * - text 为字符串且 trim 后等于 /eag-resume
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-resume" 或 "unknown"）
   */
  parseEagResumeCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-resume" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-status 命令并提取 payload
   *
   * 判定规则（迁移自 session.ts L1944 isEagStatusPrompt）：
   * - text 为字符串且 trim 后等于 /eag-status
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-status" 或 "unknown"）
   */
  parseEagStatusCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-status" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  // ============================================================================
  // 私有提取方法（迁移自 session.ts，D-S3-7）
  // ============================================================================

  /**
   * 从 userPrompt.messageParams 提取预装配的 CodingLoopRequest（§4.9.3）
   *
   * 迁移自 session.ts L2089 extractCodingLoopRequest。
   *
   * 设计原则：parser 不直接读取 spec.md/plan.md/tasks.md，保持职责单一。
   * 调用方通过 userPrompt.messageParams.codingLoopRequest 传入预装配的请求。
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 CodingLoopRequest；未提供或字段不完整时返回 null
   */
  private extractCodingLoopRequest(userPrompt: UserPromptContent): CodingLoopRequest | null {
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    const request = params.codingLoopRequest;
    if (!request || typeof request !== "object") {
      return null;
    }
    // 基本字段校验（避免类型断言误用，对齐 session.ts 既有校验逻辑）
    const candidate = request as Partial<CodingLoopRequest>;
    if (
      typeof candidate.projectRoot === "string" &&
      typeof candidate.specContent === "string" &&
      typeof candidate.planContent === "string" &&
      typeof candidate.tasksContent === "string" &&
      candidate.taskDag &&
      Array.isArray(candidate.taskDag.nodes) &&
      Array.isArray(candidate.taskDag.topologicalOrder) &&
      Array.isArray(candidate.taskCards) &&
      Array.isArray(candidate.techStack) &&
      typeof candidate.constitutionContent === "string" &&
      candidate.llmClient &&
      candidate.pkcAccessor &&
      candidate.loopGuard &&
      typeof candidate.maxIterations === "number" &&
      typeof candidate.maxFixRounds === "number"
    ) {
      return candidate as CodingLoopRequest;
    }
    return null;
  }

  /**
   * 从 userPrompt.messageParams 提取预装配的 DesignLoopInput（§4.18.3）
   *
   * 迁移自 session.ts L2299 extractDesignLoopInput。
   *
   * 设计原则：parser 不直接解析原始需求文本，保持职责单一。
   * 调用方通过 userPrompt.messageParams.designLoopInput 传入预装配的输入。
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 DesignLoopInput；未提供或字段不完整时返回 null
   */
  private extractDesignLoopInput(userPrompt: UserPromptContent): DesignLoopInput | null {
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    const input = params.designLoopInput;
    if (!input || typeof input !== "object") {
      return null;
    }
    // 基本字段校验（避免类型断言误用，对齐 session.ts 既有校验逻辑）
    const candidate = input as Partial<DesignLoopInput>;
    if (typeof candidate.rawRequirement === "string" && candidate.rawRequirement.trim().length > 0) {
      return candidate as DesignLoopInput;
    }
    return null;
  }

  /**
   * 从 userPrompt.messageParams 提取预装配的 TestingLoopRequest（§4.18.3）
   *
   * 迁移自 session.ts L2470 extractTestingLoopRequest。
   *
   * 设计原则：parser 不直接读取 spec.md/plan.md/tasks.md，保持职责单一。
   * 调用方通过 userPrompt.messageParams.testingLoopRequest 传入预装配的请求。
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 TestingLoopRequest；未提供或字段不完整时返回 null
   */
  private extractTestingLoopRequest(userPrompt: UserPromptContent): TestingLoopRequest | null {
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    const request = params.testingLoopRequest;
    if (!request || typeof request !== "object") {
      return null;
    }
    // 基本字段校验（避免类型断言误用，对齐 session.ts 既有校验逻辑）
    const candidate = request as Partial<TestingLoopRequest>;
    if (
      typeof candidate.projectRoot === "string" &&
      typeof candidate.specContent === "string" &&
      typeof candidate.planContent === "string" &&
      typeof candidate.tasksContent === "string" &&
      typeof candidate.implementationRoot === "string" &&
      candidate.taskDag &&
      Array.isArray((candidate.taskDag as unknown as { nodes?: unknown[] }).nodes) &&
      Array.isArray(candidate.acceptanceCriteria) &&
      candidate.llmClient &&
      candidate.pkcAccessor &&
      candidate.loopGuard &&
      candidate.coverageThreshold &&
      typeof candidate.maxIterations === "number"
    ) {
      return candidate as TestingLoopRequest;
    }
    return null;
  }

  /**
   * 从 userPrompt.messageParams 提取预装配的 EagRunRequest（§4.18.3）
   *
   * 迁移自 session.ts L2704 extractEagRunRequest。
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 EagRunRequest；未提供或字段不完整时返回 null
   */
  private extractEagRunRequest(userPrompt: UserPromptContent): EagRunRequest | null {
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    const request = params.eagRunRequest;
    if (!request || typeof request !== "object") {
      return null;
    }
    // 基本字段校验（避免类型断言误用，对齐 session.ts 既有校验逻辑）
    const candidate = request as Partial<EagRunRequest>;
    if (
      typeof candidate.projectRoot === "string" &&
      typeof candidate.userIntent === "string" &&
      Array.isArray(candidate.loopExecutors) &&
      candidate.loopExecutors.length > 0
    ) {
      return candidate as EagRunRequest;
    }
    return null;
  }

  /**
   * 从 userPrompt.messageParams 提取预装配的 EagResumeRequest（§4.18.3）
   *
   * 迁移自 session.ts L2915 extractEagResumeRequest。
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 EagResumeRequest；未提供或字段不完整时返回 null
   */
  private extractEagResumeRequest(userPrompt: UserPromptContent): EagResumeRequest | null {
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    const request = params.eagResumeRequest;
    if (!request || typeof request !== "object") {
      return null;
    }
    // 基本字段校验（对齐 session.ts 既有校验逻辑）
    const candidate = request as Partial<EagResumeRequest>;
    if (
      typeof candidate.runId === "string" &&
      candidate.runId.trim().length > 0 &&
      typeof candidate.projectRoot === "string" &&
      typeof candidate.userIntent === "string" &&
      Array.isArray(candidate.loopExecutors) &&
      candidate.loopExecutors.length > 0
    ) {
      return candidate as EagResumeRequest;
    }
    return null;
  }

  /**
   * 从 userPrompt.messageParams 提取预装配的 EagStatusRequest（§4.18.3）
   *
   * 迁移自 session.ts L3051 extractEagStatusRequest。
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 EagStatusRequest；未提供或字段不完整时返回 null
   */
  private extractEagStatusRequest(userPrompt: UserPromptContent): EagStatusRequest | null {
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    const request = params.eagStatusRequest;
    if (!request || typeof request !== "object") {
      return null;
    }
    // 基本字段校验（projectRoot 必填，runId 与 recentCount 二选一，对齐 session.ts 既有校验逻辑）
    const candidate = request as Partial<EagStatusRequest>;
    if (typeof candidate.projectRoot === "string" && candidate.projectRoot.trim().length > 0) {
      return candidate as EagStatusRequest;
    }
    return null;
  }
}
