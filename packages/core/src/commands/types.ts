/**
 * 跨宿主命令层的类型契约（L0-1，2026-11-02）
 *
 * ## 为什么单独一层 `commands/`
 *
 * `team/` 已有 23 个 `.ts` + 8 个子目录，塞命令执行器会继续膨胀；且命令属于
 * 「人类与宿主的关注点」（怎么解析一行文本、输出给谁看），不属于「能力领域」
 * （角色匹配、派单、循环）。这是 `industry-research.md` 里 dsh 的分层做法：
 * 命令归 host 侧，能力归 domain 侧。
 *
 * ## 依赖方向（硬约束）
 *
 * ```
 * 宿主(CLI/Web) → commands → { team, agents }
 * ```
 *
 * 反向依赖一律禁止：`team/` 不得 import `commands/`；`commands/` 不得 import
 * `cli/` 或 `web/`（那会造成跨包环）。宿主差异（写终端 / 推 SSE / 渲染卡片）
 * 通过 `TeamCommandDeps` 注入，执行体本身零 I/O 副作用。
 *
 * @module commands/types
 */

import type { OpenAIClientHandle } from "../common/openai-client.js";
import type { DynamicCommandDescriptor } from "../eag/dynamic/eag-dynamic-suggester.js";
import type { DispatchEndReason } from "../team/dispatch-event-log.js";
import type { DispatchRunner } from "../team/team-adapter.js";
import type { DispatchResult, MatchResult, RoleDefinition } from "../team/types.js";

/** Team 子命令（唯一权威定义；CLI 侧改为 re-export） */
export type TeamSubcommand = "list" | "match" | "dispatch" | "autonomous" | "full-lifecycle" | "auto";

/** 全部子命令（供解析器与描述符复用，顺序即帮助文本顺序） */
export const TEAM_SUBCOMMANDS: ReadonlyArray<TeamSubcommand> = Object.freeze([
  "list",
  "match",
  "dispatch",
  "autonomous",
  "full-lifecycle",
  "auto",
]);

/** Team 子命令参数 */
export interface TeamCommandArgs {
  subcommand: TeamSubcommand;
  /** 角色 ID（dispatch 模式；可为运行时角色 ID） */
  role?: string;
  /** 任务文本（dispatch / autonomous / full-lifecycle 模式） */
  task?: string;
  /**
   * 任务文件路径：指定时从文件读取任务描述，覆盖 task 字段
   * - 用途：task 描述包含 shell 特殊字符或内容超长时，避免命令行参数转义问题
   * - 优先级：taskFile > task（同时指定时 taskFile 生效）
   */
  taskFile?: string;
  /** 项目目标（autonomous / full-lifecycle 模式） */
  goal?: string;
  /** 角色关键词（match 模式） */
  keywords?: string[];
  /** 最大迭代次数（autonomous / full-lifecycle --use-loop 模式） */
  maxIterations?: number;
  /** 是否强制指定角色（禁用匹配） */
  forceRole?: boolean;
  /** 共识模式（5 角色联合评审） */
  consensus?: boolean;
  /**
   * 失败时中止（fail-fast）
   * 统一判定 `failFast !== false`（默认 true）：
   *   - consensus 模式：任一角色评审失败 → 跳过聚合阶段并返回退出码 1
   *   - full-lifecycle 线性模式：任一阶段失败 → 立即中止
   *   - false（--no-fail-fast）：部分失败时继续执行并汇总，最终仍有失败 → 返回 1
   *   - dispatch 单角色 / autonomous / full-lifecycle --use-loop 模式不适用
   */
  failFast?: boolean;
  /** 项目根目录 */
  projectRoot?: string;
  /** 断点续跑（autonomous 模式）：true 时查找最近一次可恢复的 run */
  resumeRun?: boolean;
  /** 注入的 OpenAI 客户端句柄（测试专用；生产环境由 createOpenAIClient 构造） */
  injectedClient?: OpenAIClientHandle;
  /** 启用八阶段循环控制器（full-lifecycle 模式） */
  useLoop?: boolean;
  /** PRD 文档路径（full-lifecycle 阶段 8 输入） */
  prdPath?: string;
  /** 架构设计文档路径（full-lifecycle 阶段 8 输入） */
  architecturePath?: string;
  /** 测试计划文档路径（full-lifecycle 阶段 8 输入） */
  testPlanPath?: string;
  /** 测试命令（full-lifecycle 阶段 7 + 阶段 8 D3 检查） */
  testCommand?: string;

  // ---- L2（自动多角色拆解）auto 子命令专属 ----

  /** 只拆解 + 分层，不执行（验收工具，不动工作区） */
  dryRun?: boolean;
  /** 拆解子任务数上限（默认 6） */
  maxSubtasks?: number;
  /** 层内并发上限（默认 2） */
  maxParallel?: number;
  /** 跳过 LLM 聚合，直接本地拼装报告 */
  skipAggregate?: boolean;
}

/** 进度事件级别 */
export type TeamProgressLevel = "info" | "success" | "warn" | "error";

/** 进度事件阶段 */
export type TeamProgressPhase = "start" | "stage" | "match" | "dispatch" | "loop" | "decompose" | "aggregate" | "end";

/**
 * 进度事件（宿主据此渲染实时进度）
 *
 * 设计：只携带「可读文案 + 结构化定位」，不携带内部对象——宿主（Web SSE / CLI Ink）
 * 各自决定怎么展示，core 不关心。
 */
export interface TeamProgressEvent {
  phase: TeamProgressPhase;
  level: TeamProgressLevel;
  /** 可直接展示给用户的一段文本 */
  message: string;
  /** 阶段 / 迭代序号（从 1 起） */
  index?: number;
  /** 总阶段数 / 总迭代数（未知时不填） */
  total?: number;
  /** 结构化附加信息（如 roleId / runId / exitCode） */
  data?: Record<string, unknown>;
}

/** 注入到执行体的宿主能力（全部可选，缺省即"无该能力"） */
export interface TeamCommandDeps {
  /** 项目根目录（args.projectRoot 优先） */
  projectRoot?: string;
  /**
   * 角色候选集（含运行时角色）
   *
   * 未传 → 仅 5 个内置角色（改动前行为）。
   * 典型由宿主调用 `buildRolesFromAgents(skills)` 后与 `ROLE_REGISTRY` 合并传入。
   */
  candidates?: ReadonlyArray<RoleDefinition>;
  /** 注入的 OpenAI 客户端（测试专用） */
  injectedClient?: OpenAIClientHandle;
  /** 进度回调（宿主渲染实时进度） */
  onProgress?: (event: TeamProgressEvent) => void;
  /**
   * 带工具轮次的执行器（L1-1）
   *
   * 注入后 `/team dispatch` 拥有与主对话一致的完整工具能力；未注入时退化为
   * 单次 LLM 调用（返回设计建议文本）。由宿主注入，避免 `team/` 反向依赖 `session/`。
   */
  runner?: DispatchRunner;
  /** dispatch 事件日志开关（默认按 projectRoot 开启；false 关闭） */
  eventLog?: boolean | { dir?: string; enabled?: boolean };
  /** dispatch 工具轮次上限（默认 8） */
  maxToolRounds?: number;
}

/** 角色摘要（list 子命令的结构化产物） */
export interface TeamRoleSummary {
  roleId: string;
  name: string;
  /** 业务类别（运行时角色才有，来自 SKILL.md frontmatter 的 group） */
  group?: string;
  /** 是否来自 SKILL.md 预置智能体 */
  preset?: boolean;
  /** 是否用户自建智能体 */
  custom?: boolean;
  priority: number;
}

/** 匹配摘要（match 子命令的结构化产物） */
export interface TeamMatchSummary {
  roleId: string;
  roleName: string;
  confidence: number;
  reason: string;
  /** 是否内置角色（false = 运行时角色 / 领域专家映射） */
  builtin: boolean;
}

/** 派单摘要（dispatch 子命令的结构化产物） */
export interface TeamDispatchSummary {
  status: DispatchResult["status"];
  taskId: string;
  dispatchId: string;
  roleId: string;
  roleName: string;
  confidence: number;
  output: string;
  error?: string;
  /** 是否走了工具轮次（runner 模式） */
  toolCapable: boolean;
}

/** 单阶段结果（full-lifecycle 结构化产物） */
export interface TeamStageSummary {
  index: number;
  title: string;
  role: string;
  status: "succeeded" | "skipped" | "failed";
  artifact: string;
  error?: string;
}

/** 编排子任务摘要（auto 子命令结构化产物） */
export interface TeamSubtaskSummary {
  id: string;
  title: string;
  roleName: string | null;
  status: "succeeded" | "failed" | "skipped" | "cancelled";
  layer: number;
  durationMs: number;
  rounds: number;
  toolCalls: number;
  error?: string;
}

/** 结构化产物联合（宿主可直接渲染，不必解析文本） */
export type TeamCommandData =
  | { kind: "list"; roles: TeamRoleSummary[] }
  | { kind: "match"; matches: TeamMatchSummary[] }
  | { kind: "dispatch"; dispatch: TeamDispatchSummary }
  | {
      kind: "autonomous";
      runId: string;
      exitCode: number;
      iterations: number;
      tokens: number;
      commits: number;
      endReason: DispatchEndReason;
    }
  | { kind: "full-lifecycle"; project: string; stages: TeamStageSummary[]; overallSuccess: boolean }
  | {
      kind: "orchestrate";
      runId: string;
      mode: "orchestrated" | "degraded-single";
      dryRun: boolean;
      degradationReason?: string;
      /** 实际执行的层（含冲突下移） */
      layers: string[][];
      subtasks: TeamSubtaskSummary[];
      /** 因文件写冲突被改为串行的数量 */
      serializedCount: number;
      /** 聚合报告（Markdown；dry-run 时为计划预览） */
      report: string;
      aggregated: boolean;
      usedToolRounds: number;
      totalToolRounds: number;
      undocumentedChanges: string[];
    };

/** 命令执行结果（宿主唯一消费入口） */
export interface TeamCommandResult {
  /** 退出码：0 成功 / 1 执行失败 / 2 参数错误 / 4 运行时异常 */
  exitCode: number;
  /** 已渲染的文本输出（CLI 直接写终端；Web 可直接作为一条消息） */
  stdout: string;
  stderr: string;
  /** 结构化产物（可缺省：出错或宿主不需要时不下发） */
  data?: TeamCommandData;
  /** 耗时（毫秒） */
  durationMs: number;
}

/**
 * Team 命令描述符（供建议层 / 命令面板展示）
 *
 * 单一数据源：CLI `ui/core/dynamic-commands.ts` 与 Web `session-pool.ts` 都从这里取，
 * 消除此前 Web 侧手写 5 条描述符、与实际能力不一致（有菜单无厨房）的分歧。
 */
export const TEAM_COMMAND_DESCRIPTORS: ReadonlyArray<DynamicCommandDescriptor> = Object.freeze([
  Object.freeze({
    category: "team" as const,
    id: "team-list",
    name: "/team list",
    description: "列出所有可用角色（5 个内置角色 + 由智能体映射而来的业务角色，按类别分组）。",
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-match",
    name: "/team match",
    description: "根据关键词匹配最合适的角色，输出置信度和匹配理由（含业务类专家）。",
    args: ["--keywords <kw1,kw2,...>"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-dispatch",
    name: "/team dispatch",
    description: "分派任务到指定角色并**真实执行**（自动匹配或 --role 强制指定），可在工作区落代码改动。",
    args: ["--task <任务描述>", "--role <role-id>", "--consensus"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-autonomous",
    name: "/team autonomous",
    description: "启动 Ralph 自主迭代（plan → dev → verify → fix 循环），阶段推进实时可见。",
    args: ["--goal <目标>", "--max-iterations <n>", "--resume-run"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-full-lifecycle",
    name: "/team full-lifecycle",
    description: "8 阶段项目全流程（需求→架构→UI→测试设计→分解→开发→测试→文档审查）。",
    args: ["--project <项目名>", "--use-loop", "--test-command <cmd>"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-auto",
    name: "/team auto",
    description:
      "自动多角色拆解：把一个目标拆成有依赖的子任务，按层并行派给不同角色，最后汇总成一份报告（--dry-run 只看计划）。",
    args: ["--goal <目标>", "--max-subtasks <n>", "--max-parallel <n>", "--dry-run", "--no-aggregate"],
  }),
]);

/** 取 team 命令描述符（返回冻结数组，调用方无需再拷贝） */
export function buildTeamCommandDescriptors(): ReadonlyArray<DynamicCommandDescriptor> {
  return TEAM_COMMAND_DESCRIPTORS;
}

/** 判断给定 category 是否为 team 命令体系 */
export function isTeamCommandDescriptor(descriptor: DynamicCommandDescriptor): boolean {
  return descriptor.category === "team";
}

/** match 结果 → 摘要（内置角色判定用 ROLE_REGISTRY 成员关系，不猜前缀） */
export function toMatchSummary(match: MatchResult, builtinRoleIds: ReadonlySet<string>): TeamMatchSummary {
  return {
    roleId: match.roleId,
    roleName: match.roleName,
    confidence: match.confidence,
    reason: match.reasons[0] ?? "",
    builtin: builtinRoleIds.has(match.roleId),
  };
}
