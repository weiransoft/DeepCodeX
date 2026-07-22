/**
 * EAG CLI 命令解析器——从 session.ts 抽取的命令判定与请求装配逻辑
 *
 * 设计依据：EAG-P3 批次 11 §5 S3 改进方案（决策清单 D-S3-1 ~ D-S3-8）
 *
 * 职责：
 * - 判定用户输入是否为 EAG 命令（/eag-design、/eag-test、/eag-run、/eag-resume、/eag-status、/eag-build、/eag-deploy、/eag-autonomous、/eag-autonomous-status、/eag-autonomous-stop）
 * - 从 userPrompt.messageParams 提取预装配的请求对象
 * - 提供 parse() 统一入口，返回 discriminated union 类型 EagCommand
 * - 提供 extractDeployRequestFromPrompt() 独立函数，解析 /eag-deploy 命令字符串（供 session.ts 构造 messageParams 时调用）
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
 * EAG-P5 TASK-P5-3.1-005/006 v1.1 新增（设计文档 §3.5）：
 * - /eag-autonomous-status <run-id>：查询 autonomous 运行状态
 * - /eag-autonomous-stop <run-id>：中止/回滚 autonomous 运行
 * - 命令总数从 8 扩展至 10，新增 2 个 EagCommand kind
 * - parser 优先匹配 status/stop 前缀（在 autonomous 之前），避免 /eag-autonomous-status 被误吞为 /eag-autonomous
 *
 * @module eag/cli/eag-command-parser
 */

import type { UserPromptContent } from "../../session";
import type { CodingLoopRequest } from "../coding/types";
import type { DesignLoopInput } from "../design/design-models";
import type { TestingLoopRequest } from "../testing/types";
import type { EagRunRequest, EagResumeRequest, EagStatusRequest } from "../long-horizon";
// EAG-P5 Phase 5.3 TASK-P5-3.1-006：导入 /eag-autonomous 命令参数解析函数与请求类型
// - extractEagAutonomousRequestFromPrompt：独立函数，从命令字符串解析参数
// - EagAutonomousRequest：/eag-autonomous 命令请求对象类型
// 注：eag-autonomous-command.ts 不依赖本模块，无循环依赖风险
import { extractEagAutonomousRequestFromPrompt } from "./eag-autonomous-command";
import type { EagAutonomousRequest } from "./eag-autonomous-command";
// EAG-P5 TASK-P5-3.1-005/006 v1.1 新增（设计文档 §3.5）：
// 导入 /eag-autonomous-status 与 /eag-autonomous-stop 命令参数解析函数与请求类型
// - extractEagAutonomousStatusRequestFromPrompt：从命令字符串解析 runId
// - extractEagAutonomousStopRequestFromPrompt：从命令字符串解析 runId
// - EagAutonomousStatusRequest / EagAutonomousStopRequest：请求对象类型
import {
  extractEagAutonomousStatusRequestFromPrompt,
  extractEagAutonomousStopRequestFromPrompt,
} from "./eag-autonomous-command";
import type { EagAutonomousStatusRequest, EagAutonomousStopRequest } from "./eag-autonomous-command";

// ============================================================================
// DeployRequest 接口定义（EAG-P4 批次 13 Phase 7 §5.1）
// ============================================================================

/**
 * /eag-deploy 命令请求对象（EAG-P4 批次 13 Phase 7 §5.1）
 *
 * 用于描述一次部署任务的完整参数集合，由 extractDeployRequestFromPrompt()
 * 从命令字符串解析后装配，再由 session.ts 注入到 userPrompt.messageParams.deployRequest。
 *
 * 字段说明（对齐设计文档 §5.1）：
 * - projectName: 项目名称（用于 K8s namespace / Helm release 命名）
 * - environment: 目标环境（dev / staging / prod）
 * - image: 容器镜像引用（含 registry/repository:tag）
 * - port: 容器监听端口（1-65535 正整数）
 * - replicas: 副本数（1-100 正整数）
 * - iacType: IaC 模板类型（terraform / k8s-manifest / helm-chart）
 * - strategy: 部署策略（rolling / blue-green / canary）
 * - dryRun: 可选，dry-run 模式（只生成 IaC 模板，不实际部署）
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 所有字段为 readonly
 * - 实例由 extractDeployRequestFromPrompt() 通过 Object.freeze 冻结后返回
 */
export interface DeployRequest {
  /** 项目名称（用于 K8s namespace / Helm release 命名，非空字符串） */
  readonly projectName: string;
  /** 目标环境（dev / staging / prod） */
  readonly environment: "dev" | "staging" | "prod";
  /** 容器镜像引用（含 registry/repository:tag，非空字符串） */
  readonly image: string;
  /** 容器监听端口（1-65535 正整数） */
  readonly port: number;
  /** 副本数（1-100 正整数） */
  readonly replicas: number;
  /** IaC 模板类型（terraform / k8s-manifest / helm-chart） */
  readonly iacType: "terraform" | "k8s-manifest" | "helm-chart";
  /** 部署策略（rolling / blue-green / canary） */
  readonly strategy: "rolling" | "blue-green" | "canary";
  /** 可选，dry-run 模式（只生成 IaC 模板，不实际部署） */
  readonly dryRun?: boolean;
}

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
  | { readonly kind: "eag-deploy"; readonly payload: DeployRequest | null }
  | { readonly kind: "eag-autonomous"; readonly payload: EagAutonomousRequest | null }
  | { readonly kind: "eag-autonomous-status"; readonly payload: EagAutonomousStatusRequest | null }
  | { readonly kind: "eag-autonomous-stop"; readonly payload: EagAutonomousStopRequest | null }
  | { readonly kind: "unknown"; readonly payload: null };

/**
 * EAG 命令字符串常量集合（D-S3-6）
 *
 * 10 个 EAG 命令的匹配字符串。使用 Object.freeze 冻结（§5.12.4 G-A6d 配置冻结）。
 *
 * 命令匹配模式（两种）：
 * - 严格匹配（无参数）：/eag-build /eag-design /eag-test /eag-run /eag-resume /eag-status /eag-deploy
 *   参数通过 messageParams 注入（D-S3-7）
 * - 前缀匹配（含参数）：/eag-autonomous /eag-autonomous-status /eag-autonomous-stop
 *   命令本身携带参数，由独立的 extractXxxFromPrompt 函数解析
 *
 * 注：/eag-deploy 的命令字符串本身亦为严格匹配（无参数），
 * 参数解析由 extractDeployRequestFromPrompt() 独立函数在 session.ts 构造
 * userPrompt.messageParams 时完成，与既有 6 个命令保持一致的注入模式。
 *
 * EAG-P5 TASK-P5-3.1-005/006 v1.1 新增（设计文档 §3.5）：
 * - /eag-autonomous-status <run-id>：查询 autonomous 运行状态
 * - /eag-autonomous-stop <run-id>：中止/回滚 autonomous 运行
 * - 两者均使用前缀匹配，命令总数从 8 扩展至 10
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
  /** /eag-deploy 命令字符串（触发部署任务编排，EAG-P4 批次 13 Phase 7 §5.1） */
  EAG_DEPLOY: "/eag-deploy",
  /**
   * /eag-autonomous 命令前缀字符串（触发 EAG-P5 无人值守编排，TASK-P5-3.1-005）
   *
   * 注：与其他 7 个命令不同，/eag-autonomous 使用前缀匹配（非严格匹配），
   * 因为命令本身携带参数（--goal / --max-iterations / --confirmation 等）。
   * 参数解析由 extractEagAutonomousRequestFromPrompt() 独立函数完成。
   */
  EAG_AUTONOMOUS: "/eag-autonomous",
  /**
   * /eag-autonomous-status 命令前缀字符串（查询 autonomous 运行状态，TASK-P5-3.1-005/006 v1.1）
   *
   * 命令格式：/eag-autonomous-status <run-id>
   * 使用前缀匹配（非严格匹配），runId 由 extractEagAutonomousStatusRequestFromPrompt() 解析。
   *
   * parser 优先匹配此命令（在 /eag-autonomous 之前），避免 /eag-autonomous-status 被误吞为 /eag-autonomous。
   */
  EAG_AUTONOMOUS_STATUS: "/eag-autonomous-status",
  /**
   * /eag-autonomous-stop 命令前缀字符串（中止/回滚 autonomous 运行，TASK-P5-3.1-005/006 v1.1）
   *
   * 命令格式：/eag-autonomous-stop <run-id>
   * 使用前缀匹配（非严格匹配），runId 由 extractEagAutonomousStopRequestFromPrompt() 解析。
   *
   * parser 优先匹配此命令（在 /eag-autonomous 之前），避免 /eag-autonomous-stop 被误吞为 /eag-autonomous。
   */
  EAG_AUTONOMOUS_STOP: "/eag-autonomous-stop",
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
   * 拆分原因：避免在多个 return 点重复写 Object.freeze，保持方法体简洁。
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

    // 步骤 2.1（EAG-P5 v1.1 新增，设计文档 §3.5）：
    // /eag-autonomous-status 前缀匹配（必须优先于 /eag-autonomous，避免被误吞）
    // 匹配规则（大小写不敏感）：
    // - text === "/eag-autonomous-status"（理论无参数形式，但 runId 必填，实际不会出现）
    // - text 以 "/eag-autonomous-status " 开头（含 runId 参数形式）
    // 参数解析委托 extractEagAutonomousStatusRequestFromPrompt 独立函数完成
    const autonomousStatusPrefix = EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STATUS;
    const textLower = text.toLowerCase();
    const autonomousStatusLower = autonomousStatusPrefix.toLowerCase();
    if (textLower === autonomousStatusLower || textLower.startsWith(autonomousStatusLower + " ")) {
      return {
        kind: "eag-autonomous-status",
        payload: this.extractEagAutonomousStatusRequest(text),
      };
    }

    // 步骤 2.2（EAG-P5 v1.1 新增，设计文档 §3.5）：
    // /eag-autonomous-stop 前缀匹配（必须优先于 /eag-autonomous，避免被误吞）
    // 匹配规则（大小写不敏感）：
    // - text === "/eag-autonomous-stop"
    // - text 以 "/eag-autonomous-stop " 开头
    // 参数解析委托 extractEagAutonomousStopRequestFromPrompt 独立函数完成
    const autonomousStopPrefix = EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STOP;
    const autonomousStopLower = autonomousStopPrefix.toLowerCase();
    if (textLower === autonomousStopLower || textLower.startsWith(autonomousStopLower + " ")) {
      return {
        kind: "eag-autonomous-stop",
        payload: this.extractEagAutonomousStopRequest(text),
      };
    }

    // 步骤 2.3：EAG-P5 Phase 5.3 /eag-autonomous 前缀匹配（TASK-P5-3.1-006）
    // 与其他 7 个命令不同，/eag-autonomous 使用前缀匹配（非严格匹配），
    // 因为命令本身携带参数（--goal / --max-iterations / --confirmation 等）。
    // 匹配规则（大小写不敏感）：
    // - text === "/eag-autonomous"（无参数形式，payload 从 messageParams 提取）
    // - text 以 "/eag-autonomous " 开头（含参数形式，payload 从命令字符串解析）
    // 参数解析委托 extractEagAutonomousRequestFromPrompt 独立函数完成
    //
    // 注：此步骤必须在 2.1/2.2 之后，否则 /eag-autonomous-status / /eag-autonomous-stop
    //     会被 /eag-autonomous 前缀误吞（见设计文档 v1.1 P0-1）
    const autonomousPrefix = EAG_COMMAND_STRINGS.EAG_AUTONOMOUS;
    const prefixLower = autonomousPrefix.toLowerCase();
    if (textLower === prefixLower || textLower.startsWith(prefixLower + " ")) {
      return { kind: "eag-autonomous", payload: this.extractEagAutonomousRequest(userPrompt, text) };
    }

    // 步骤 3：严格匹配 7 个命令字符串（无参数，参数通过 messageParams 注入）
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
      case EAG_COMMAND_STRINGS.EAG_DEPLOY:
        return { kind: "eag-deploy", payload: this.extractDeployRequest(userPrompt) };
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

  /**
   * 判定用户输入是否为 /eag-deploy 命令并提取 payload
   *
   * 判定规则（对齐 EAG-P4 批次 13 Phase 7 §5.1）：
   * - text 为字符串且 trim 后等于 /eag-deploy
   * - 无图片附件
   * - 无技能匹配
   *
   * 注：命令字符串本身严格匹配（无参数），参数解析由独立函数
   * extractDeployRequestFromPrompt() 在 session.ts 构造 messageParams 时完成。
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-deploy" 或 "unknown"）
   */
  parseEagDeployCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-deploy" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-autonomous 命令并提取 payload（TASK-P5-3.1-006）
   *
   * 判定规则（对齐 EAG-P5 Phase 5.3 §5 CLI 命令规范）：
   * - text 为字符串且以 /eag-autonomous 开头（前缀匹配，大小写不敏感）
   * - text === "/eag-autonomous" 或 text 以 "/eag-autonomous " 开头
   * - 无图片附件
   * - 无技能匹配
   *
   * 与其他 7 个命令的差异：
   * - 其他命令使用严格匹配（text === "/eag-xxx"）
   * - /eag-autonomous 使用前缀匹配，因为命令本身携带参数
   * - 参数解析由 extractEagAutonomousRequestFromPrompt() 独立函数完成
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-autonomous" 或 "unknown"）
   */
  parseEagAutonomousCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-autonomous" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-autonomous-status 命令并提取 payload
   * （EAG-P5 TASK-P5-3.1-005/006 v1.1 新增，设计文档 §3.5）
   *
   * 判定规则（对齐 EAG-P5 v1.1 §5 CLI 命令规范）：
   * - text 为字符串且以 /eag-autonomous-status 开头（前缀匹配，大小写不敏感）
   * - text === "/eag-autonomous-status" 或 text 以 "/eag-autonomous-status " 开头
   * - 无图片附件
   * - 无技能匹配
   *
   * 与 /eag-autonomous 的差异：
   * - /eag-autonomous-status 仅需位置参数 <run-id>，无需 --key value 形式
   * - parser 优先匹配此命令（在 /eag-autonomous 之前），避免被 /eag-autonomous 前缀误吞
   * - payload 仅含 runId，projectRoot 由 session.ts 在调用 orchestrator.status() 时注入
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-autonomous-status" 或 "unknown"）
   */
  parseEagAutonomousStatusCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-autonomous-status" ? cmd : FROZEN_UNKNOWN_COMMAND;
  }

  /**
   * 判定用户输入是否为 /eag-autonomous-stop 命令并提取 payload
   * （EAG-P5 TASK-P5-3.1-005/006 v1.1 新增，设计文档 §3.5）
   *
   * 判定规则（同 parseEagAutonomousStatusCommand，仅命令前缀不同）：
   * - text 为字符串且以 /eag-autonomous-stop 开头（前缀匹配，大小写不敏感）
   * - text === "/eag-autonomous-stop" 或 text 以 "/eag-autonomous-stop " 开头
   * - 无图片附件
   * - 无技能匹配
   *
   * @param userPrompt 用户输入内容
   * @returns EagCommand（kind 为 "eag-autonomous-stop" 或 "unknown"）
   */
  parseEagAutonomousStopCommand(userPrompt: UserPromptContent): EagCommand {
    const cmd = this.parse(userPrompt);
    return cmd.kind === "eag-autonomous-stop" ? cmd : FROZEN_UNKNOWN_COMMAND;
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

  /**
   * 从 userPrompt.messageParams 提取预装配的 DeployRequest（EAG-P4 批次 13 Phase 7 §5.1）
   *
   * 设计原则（对齐其他 6 个 extractXxxRequest）：
   * - parser 不直接解析命令字符串（参数解析由 extractDeployRequestFromPrompt 独立函数完成）
   * - 调用方通过 userPrompt.messageParams.deployRequest 传入预装配的请求
   * - 字段校验不通过时返回 null（与 extractEagStatusRequest 等一致）
   *
   * 校验规则（对齐设计文档 §5.1 字段约束）：
   * - projectName: 非空字符串
   * - environment: "dev" | "staging" | "prod"
   * - image: 非空字符串
   * - port: 正整数 1-65535
   * - replicas: 正整数 1-100
   * - iacType: "terraform" | "k8s-manifest" | "helm-chart"
   * - strategy: "rolling" | "blue-green" | "canary"
   * - dryRun: 可选，为 boolean 类型
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @returns 预装配的 DeployRequest；未提供或字段不完整时返回 null
   */
  private extractDeployRequest(userPrompt: UserPromptContent): DeployRequest | null {
    // 步骤 1：校验 messageParams 存在且为对象
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (!params || typeof params !== "object") {
      return null;
    }
    // 步骤 2：校验 deployRequest 字段存在且为对象
    const request = params.deployRequest;
    if (!request || typeof request !== "object") {
      return null;
    }
    // 步骤 3：基本字段校验（避免类型断言误用，对齐其他 extractXxxRequest 校验风格）
    const candidate = request as Partial<DeployRequest>;

    // projectName 必须为非空字符串
    if (typeof candidate.projectName !== "string" || candidate.projectName.trim().length === 0) {
      return null;
    }
    // environment 必须为 "dev" | "staging" | "prod" 之一
    if (candidate.environment !== "dev" && candidate.environment !== "staging" && candidate.environment !== "prod") {
      return null;
    }
    // image 必须为非空字符串
    if (typeof candidate.image !== "string" || candidate.image.trim().length === 0) {
      return null;
    }
    // port 必须为正整数且在 1-65535 范围内
    if (
      typeof candidate.port !== "number" ||
      !Number.isInteger(candidate.port) ||
      candidate.port < 1 ||
      candidate.port > 65535
    ) {
      return null;
    }
    // replicas 必须为正整数且在 1-100 范围内
    if (
      typeof candidate.replicas !== "number" ||
      !Number.isInteger(candidate.replicas) ||
      candidate.replicas < 1 ||
      candidate.replicas > 100
    ) {
      return null;
    }
    // iacType 必须为 "terraform" | "k8s-manifest" | "helm-chart" 之一
    if (
      candidate.iacType !== "terraform" &&
      candidate.iacType !== "k8s-manifest" &&
      candidate.iacType !== "helm-chart"
    ) {
      return null;
    }
    // strategy 必须为 "rolling" | "blue-green" | "canary" 之一
    if (candidate.strategy !== "rolling" && candidate.strategy !== "blue-green" && candidate.strategy !== "canary") {
      return null;
    }
    // dryRun 可选，若提供则必须为 boolean
    if (candidate.dryRun !== undefined && typeof candidate.dryRun !== "boolean") {
      return null;
    }
    // 所有字段校验通过，返回 candidate（类型已收窄为 DeployRequest）
    return candidate as DeployRequest;
  }

  /**
   * 从 userPrompt.messageParams 或命令字符串提取 EagAutonomousRequest（TASK-P5-3.1-006）
   *
   * 提取优先级：
   * 1. 优先从 messageParams.autonomousRunRequest 提取（调用方预解析模式）
   *    - 适用于 UI 表单场景：用户分别填写 goal/maxIterations 等字段
   *    - 调用方在构造 userPrompt 时通过 messageParams.autonomousRunRequest 注入
   * 2. 回退到从命令字符串解析（CLI 内联参数模式）
   *    - 适用于 CLI 场景：用户输入 `/eag-autonomous --goal "..." --max-iterations 10`
   *    - 委托 extractEagAutonomousRequestFromPrompt 独立函数完成解析
   *    - 解析失败时返回 null（session.ts 通知用户参数错误）
   *
   * 设计原则（对齐 extractDeployRequest 模式 + CLI 内联参数扩展）：
   * - parser 不直接读取文件系统（保持职责单一）
   * - 调用方可以通过 messageParams 注入预装配的请求（与 extractDeployRequest 一致）
   * - 调用方也可以通过命令字符串内联参数（extractDeployRequest 不支持，本方法扩展支持）
   * - 任一提取失败返回 null，由 session.ts 通知用户错误
   *
   * @param userPrompt 用户输入（含 messageParams 元数据）
   * @param text 用户输入的命令字符串（用于回退解析）
   * @returns 预装配的 EagAutonomousRequest；未提供或解析失败时返回 null
   */
  private extractEagAutonomousRequest(userPrompt: UserPromptContent, text: string): EagAutonomousRequest | null {
    // 步骤 1：优先从 messageParams.autonomousRunRequest 提取（调用方预解析模式）
    const params = userPrompt.messageParams as Record<string, unknown> | null | undefined;
    if (params && typeof params === "object") {
      const request = params.autonomousRunRequest;
      if (request && typeof request === "object") {
        const candidate = request as Partial<EagAutonomousRequest>;
        // 基本字段校验（goal 必须为非空字符串，其他字段由 extractEagAutonomousRequestFromPrompt 保证）
        if (
          typeof candidate.goal === "string" &&
          candidate.goal.trim().length > 0 &&
          typeof candidate.maxIterations === "number" &&
          typeof candidate.confirmation === "string" &&
          typeof candidate.testCommand === "string"
        ) {
          return candidate as EagAutonomousRequest;
        }
      }
    }

    // 步骤 2：回退到从命令字符串解析（CLI 内联参数模式）
    // 委托 extractEagAutonomousRequestFromPrompt 独立函数完成解析
    // 解析失败（抛异常）时返回 null，由 session.ts 通知用户参数错误
    try {
      return extractEagAutonomousRequestFromPrompt(text);
    } catch {
      // 参数解析失败：返回 null，session.ts 将通知用户具体错误
      // 注：错误详情由 session.ts 重新调用 extractEagAutonomousRequestFromPrompt 获取
      return null;
    }
  }

  /**
   * 从命令字符串提取 EagAutonomousStatusRequest
   * （EAG-P5 TASK-P5-3.1-005/006 v1.1 新增，设计文档 §3.5 + P2-N1）
   *
   * 与 extractEagAutonomousRequest（L839，支持 messageParams 注入 + CLI 字符串回退两种模式）不同，
   * 本方法**仅从命令字符串解析**，不支持 messageParams 注入模式。
   *
   * 设计理由（对齐 Karpathy Simplicity First）：
   * - EagAutonomousStatusRequest 只有 runId 一个字段，UI 表单场景无意义
   *   （用户直接在 CLI 输入 `/eag-autonomous-status <run-id>` 即可）
   * - 保持实现简洁，避免引入不必要的 messageParams 注入路径
   *
   * 算法：
   * 1. 委托 extractEagAutonomousStatusRequestFromPrompt 独立函数解析命令字符串
   * 2. 解析成功 → 返回冻结的 EagAutonomousStatusRequest
   * 3. 解析失败（抛异常）→ 返回 null，由 session.ts 重新调用以获取错误详情
   *
   * @param text 用户输入的命令字符串（已 trim）
   * @returns EagAutonomousStatusRequest；解析失败时返回 null
   */
  private extractEagAutonomousStatusRequest(text: string): EagAutonomousStatusRequest | null {
    try {
      return extractEagAutonomousStatusRequestFromPrompt(text);
    } catch {
      // 参数解析失败：返回 null，session.ts 将重新调用以获取错误详情
      return null;
    }
  }

  /**
   * 从命令字符串提取 EagAutonomousStopRequest
   * （EAG-P5 TASK-P5-3.1-005/006 v1.1 新增，设计文档 §3.5 + P2-N1）
   *
   * 同 extractEagAutonomousStatusRequest，仅从命令字符串解析，不支持 messageParams 注入。
   * 设计理由同上：EagAutonomousStopRequest 只有 runId 一个字段，UI 表单场景无意义。
   *
   * @param text 用户输入的命令字符串（已 trim）
   * @returns EagAutonomousStopRequest；解析失败时返回 null
   */
  private extractEagAutonomousStopRequest(text: string): EagAutonomousStopRequest | null {
    try {
      return extractEagAutonomousStopRequestFromPrompt(text);
    } catch {
      // 参数解析失败：返回 null，session.ts 将重新调用以获取错误详情
      return null;
    }
  }
}

// ============================================================================
// 独立函数：extractDeployRequestFromPrompt（EAG-P4 批次 13 Phase 7 §5.1 L3637-L3731）
// ============================================================================

/**
 * /eag-deploy 命令字符串参数解析的合法 environment 取值集合
 *
 * 用于校验 --env 参数取值，避免在多个分支重复书写字面量联合判断。
 */
const DEPLOY_ENV_VALUES = Object.freeze(["dev", "staging", "prod"] as const);

/**
 * /eag-deploy 命令字符串参数解析的合法 iacType 取值集合
 *
 * 用于校验 --iac 参数取值。
 */
const DEPLOY_IAC_TYPE_VALUES = Object.freeze(["terraform", "k8s-manifest", "helm-chart"] as const);

/**
 * /eag-deploy 命令字符串参数解析的合法 strategy 取值集合
 *
 * 用于校验 --strategy 参数取值。
 */
const DEPLOY_STRATEGY_VALUES = Object.freeze(["rolling", "blue-green", "canary"] as const);

/**
 * 从 /eag-deploy 命令字符串解析 DeployRequest（EAG-P4 批次 13 Phase 7 §5.1 L3637-L3731）
 *
 * 此函数为**导出的独立函数**（非 EagCommandParser 类方法），供 session.ts 在
 * 构造 userPrompt.messageParams.deployRequest 时调用。
 *
 * 算法（对齐设计文档 §5.1）：
 * 1. 校验 prompt 为非空字符串
 * 2. 移除命令前缀 /eag-deploy（大小写不敏感，匹配后裁剪）
 * 3. 用正则解析 --key value 形式参数（支持单引号 / 双引号包裹的值）
 * 4. 解析 --dry-run flag（无值，存在即为 true）
 * 5. 校验 7 个必填参数（--project / --env / --image / --port / --replicas / --iac / --strategy）
 * 6. 校验 --env / --iac / --strategy 取值范围
 * 7. 校验 --port 正整数 1-65535
 * 8. 校验 --replicas 正整数 1-100
 * 9. 装配 DeployRequest 对象并 Object.freeze 冻结
 * 10. 任一校验失败抛 Error，错误信息含参数名与取值范围
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 返回的 DeployRequest 对象通过 Object.freeze 冻结
 * - 函数内部使用的常量集合（DEPLOY_ENV_VALUES 等）亦被 Object.freeze 冻结
 *
 * @param prompt /eag-deploy 命令字符串（含命令前缀与参数）
 * @returns 冻结的 DeployRequest 对象
 * @throws {Error} 当 prompt 非字符串、命令前缀不匹配、必填参数缺失、取值范围非法时抛出
 */
export function extractDeployRequestFromPrompt(prompt: string): DeployRequest {
  // 步骤 1：校验 prompt 为非空字符串
  if (typeof prompt !== "string") {
    throw new Error("extractDeployRequestFromPrompt: prompt 必须为非空字符串");
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error("extractDeployRequestFromPrompt: prompt 不能为空字符串");
  }

  // 步骤 2：移除命令前缀 /eag-deploy（大小写不敏感）
  // 使用正则匹配前缀（大小写不敏感），后跟空白字符或字符串结尾
  const prefixMatch = /^\/eag-deploy(?:\s+|$)/i.exec(trimmed);
  if (!prefixMatch) {
    throw new Error(
      `extractDeployRequestFromPrompt: 命令前缀不匹配，期望以 /eag-deploy 开头（大小写不敏感），实际为: ${trimmed}`
    );
  }
  // 截取前缀之后的部分作为参数字符串
  const argsPart = trimmed.slice(prefixMatch[0].length).trim();

  // 步骤 3：用正则解析 --key value 形式参数
  // 正则说明（关键设计：必须消费 key 与 value 之间的分隔符，且裸值必须用捕获组包裹）：
  // - --([\w][\w-]*)                              匹配参数名（字母/下划线开头，可含字母数字下划线与连字符）→ 捕获组 1
  // - (?:[=\s]+                                   分隔符（= 或空白，至少一个，必须消费以避免值丢失）
  //   (?:"([^"]*)"                                双引号值 → 捕获组 2
  //   |'([^']*)'                                  单引号值 → 捕获组 3
  //   |(?!--)([^\s"']+)                           裸值（不以 -- 开头，避免误吞后续 flag）→ 捕获组 4
  //   ))?                                         整个值组可选（?），支持 --dry-run flag（无值）形式
  // - (?=\s|$)                                    前瞻断言：匹配结束位置必须是空白或字符串结尾
  //
  // 设计要点：
  // - 分隔符 [=\s]+ 必须在值组内部，确保 --key value 形式的空格被消费（避免 value 丢失）
  // - 裸值前的 (?!--) 负向前瞻，避免 --dry-run --env prod 中 --env 被误当作 --dry-run 的值
  // - 裸值必须用 ([^\s"']+) 捕获组包裹，否则 match[4] 为 undefined（关键修复点）
  // - 整个值组可选（?），支持 --dry-run flag（无值）形式
  // - 前瞻 (?=\s|$) 确保匹配边界清晰，避免值尾部粘连
  // - 全局匹配（g 标志），依次取出所有 --key value 对
  const argPattern = /--([\w][\w-]*)(?:[=\s]+(?:"([^"]*)"|'([^']*)'|(?!--)([^\s"']+)))?(?=\s|$)/g;
  const args: Record<string, string | true> = {};

  // 注意：--dry-run 是 flag（无值），匹配时 value 部分为 undefined，记录为 true
  // 注意：重复参数首次匹配生效（后续覆盖被跳过），与设计文档 §5.1 一致
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(argsPart)) !== null) {
    const key = match[1];
    // 三种值形式：双引号（match[2]）、单引号（match[3]）、裸值（match[4]）；均未匹配则为 flag（true）
    const value = match[2] ?? match[3] ?? match[4] ?? true;
    // 仅首次匹配生效（重复参数被跳过，对齐设计文档"首次匹配生效"约定）
    if (!(key in args)) {
      args[key] = value;
    }
  }

  // 步骤 4：校验 7 个必填参数并提取值
  // projectName: --project 参数
  const projectName = args["project"];
  if (projectName === undefined || projectName === true || String(projectName).trim().length === 0) {
    throw new Error("extractDeployRequestFromPrompt: 缺少必填参数 --project 或值为空（期望非空字符串）");
  }

  // environment: --env 参数，取值范围 dev / staging / prod
  const environmentRaw = args["env"];
  if (environmentRaw === undefined || environmentRaw === true) {
    throw new Error("extractDeployRequestFromPrompt: 缺少必填参数 --env（期望取值: dev | staging | prod）");
  }
  if (!DEPLOY_ENV_VALUES.includes(environmentRaw as "dev" | "staging" | "prod")) {
    throw new Error(
      `extractDeployRequestFromPrompt: --env 取值非法（期望 dev | staging | prod，实际为: ${environmentRaw}）`
    );
  }
  const environment = environmentRaw as "dev" | "staging" | "prod";

  // image: --image 参数
  const image = args["image"];
  if (image === undefined || image === true || String(image).trim().length === 0) {
    throw new Error(
      "extractDeployRequestFromPrompt: 缺少必填参数 --image 或值为空（期望非空字符串，格式 registry/repository:tag）"
    );
  }

  // port: --port 参数，正整数 1-65535
  const portRaw = args["port"];
  if (portRaw === undefined || portRaw === true) {
    throw new Error("extractDeployRequestFromPrompt: 缺少必填参数 --port（期望正整数 1-65535）");
  }
  const portNum = Number(portRaw);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`extractDeployRequestFromPrompt: --port 取值非法（期望正整数 1-65535，实际为: ${portRaw}）`);
  }

  // replicas: --replicas 参数，正整数 1-100
  const replicasRaw = args["replicas"];
  if (replicasRaw === undefined || replicasRaw === true) {
    throw new Error("extractDeployRequestFromPrompt: 缺少必填参数 --replicas（期望正整数 1-100）");
  }
  const replicasNum = Number(replicasRaw);
  if (!Number.isInteger(replicasNum) || replicasNum < 1 || replicasNum > 100) {
    throw new Error(`extractDeployRequestFromPrompt: --replicas 取值非法（期望正整数 1-100，实际为: ${replicasRaw}）`);
  }

  // iacType: --iac 参数，取值范围 terraform / k8s-manifest / helm-chart
  const iacTypeRaw = args["iac"];
  if (iacTypeRaw === undefined || iacTypeRaw === true) {
    throw new Error(
      "extractDeployRequestFromPrompt: 缺少必填参数 --iac（期望取值: terraform | k8s-manifest | helm-chart）"
    );
  }
  if (!DEPLOY_IAC_TYPE_VALUES.includes(iacTypeRaw as "terraform" | "k8s-manifest" | "helm-chart")) {
    throw new Error(
      `extractDeployRequestFromPrompt: --iac 取值非法（期望 terraform | k8s-manifest | helm-chart，实际为: ${iacTypeRaw}）`
    );
  }
  const iacType = iacTypeRaw as "terraform" | "k8s-manifest" | "helm-chart";

  // strategy: --strategy 参数，取值范围 rolling / blue-green / canary
  const strategyRaw = args["strategy"];
  if (strategyRaw === undefined || strategyRaw === true) {
    throw new Error(
      "extractDeployRequestFromPrompt: 缺少必填参数 --strategy（期望取值: rolling | blue-green | canary）"
    );
  }
  if (!DEPLOY_STRATEGY_VALUES.includes(strategyRaw as "rolling" | "blue-green" | "canary")) {
    throw new Error(
      `extractDeployRequestFromPrompt: --strategy 取值非法（期望 rolling | blue-green | canary，实际为: ${strategyRaw}）`
    );
  }
  const strategy = strategyRaw as "rolling" | "blue-green" | "canary";

  // 步骤 5：解析 --dry-run flag（可选，存在即为 true）
  const dryRunRaw = args["dry-run"];
  // dryRun 应为 flag（true）或未提供（undefined）；若误传值（字符串），仍按存在即 true 处理
  const dryRun: boolean | undefined = dryRunRaw !== undefined ? true : undefined;

  // 步骤 6：装配 DeployRequest 对象并 Object.freeze 冻结
  const request: DeployRequest = {
    projectName: String(projectName).trim(),
    environment,
    image: String(image).trim(),
    port: portNum,
    replicas: replicasNum,
    iacType,
    strategy,
    ...(dryRun !== undefined ? { dryRun } : {}),
  };
  return Object.freeze(request) as DeployRequest;
}
