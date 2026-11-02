/**
 * Team 命令执行体（L0-1 / L1-1 / L1-2 / L1-3，2026-11-02）
 *
 * 本文件把原本只存在于 `packages/cli/src/team/team-cmd.ts` 的执行逻辑平移到 core，
 * 使 **CLI 与 Web 共用同一套执行体**，彻底消除「Web 有菜单无厨房」的双宿主分歧
 * （见 `docs/team-wiring-audit-20261101.md` §3 与 §6-P0-1）。
 *
 * ## 与 CLI 版的差异（全部为必要的解耦，非简化）
 *
 * 1. **不写 process.stdout / process.stderr**：全部写入内存缓冲并随 `TeamCommandResult`
 *    返回。CLI 之所以要在 `App.tsx` 里拦截 `process.stdout.write` 才能在 Ink 下工作，
 *    根因就是执行体直接写终端——返回缓冲后这层补丁可以整体删除。
 * 2. **进度事件回调**：`deps.onProgress` 让宿主实时渲染阶段推进（Web 看不到终端输出，
 *    必须靠事件；CLI 也可以用它替代部分终端输出）。
 * 3. **候选集注入**：`deps.candidates` 让 SKILL.md 智能体（预置专家 / 自建）进入
 *    `/team match` 与 `/team dispatch` 的候选（L0-2）。
 * 4. **执行器注入**：`deps.runner` 让 dispatch 具备真实工具轮次（L1-1）。
 *
 * ## 保持不变（重要）
 *
 * 退出码语义、输出文本格式、fail-fast 语义、`--consensus` 的并行派发 + 聚合流程
 * 全部逐字保留——既有 4 套 CLI team 测试与 e2e 脚本依赖这些细节。
 *
 * @module commands/team-command
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createOpenAIClient, type OpenAIClientHandle } from "../common/openai-client.js";
import { ROLE_REGISTRY, listRoleIds } from "../team/role-registry.js";
import { matchRoles } from "../team/role-matcher.js";
import { buildTask, executeDispatch, formatRoleInfo, listAllRoles, type DispatchRunner } from "../team/team-adapter.js";
import type { DispatchResult, MatchResult, RoleDefinition, TaskRequirement } from "../team/types.js";
import {
  GitDriver,
  NotesMemory,
  RalphLoopController,
  RunState,
  SleepGuard,
  WorkflowLoopController,
  DefaultStageExecutor,
  DocCodeConsistencyChecker,
  createDefaultStageHandlers,
  defaultLoopConfig,
  findLatestResumableRun,
  generateRunId,
  loadAutonomousConfig,
  summarizeWorkflowRunResult,
  type LoopConfig,
  type StageExecutor,
  type WorkflowRunResult,
  type DispatchOptions,
  type IterationKind,
} from "../team/index.js";
import type {
  TeamCommandArgs,
  TeamCommandData,
  TeamCommandDeps,
  TeamCommandResult,
  TeamMatchSummary,
  TeamProgressEvent,
  TeamRoleSummary,
  TeamStageSummary,
  TeamSubcommand,
  TeamSubtaskSummary,
} from "./types.js";
import { TEAM_SUBCOMMANDS } from "./types.js";
import { orchestrate, type OrchestrationResult } from "../team/orchestrator/index.js";

// ============================================================================
// 输出收集器
// ============================================================================

/**
 * 输出收集器（替代 CLI 的 writeStdoutLine / writeStderrLine）
 *
 * 语义与 `utils/stdio-helpers.ts` 完全一致：结尾无 `\n` 时补一个，不产生双换行。
 * 这保证 CLI 薄壳把缓冲原样写回终端时，输出与改动前逐字节相同（A3 golden 断言）。
 */
class OutputCollector {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  out(message: string): void {
    this.stdout.push(message.endsWith("\n") ? message : `${message}\n`);
  }

  err(message: string): void {
    this.stderr.push(message.endsWith("\n") ? message : `${message}\n`);
  }

  /** 结构化进度事件（不进入文本输出，交给宿主渲染） */
  progress(event: TeamProgressEvent): void {
    this.onProgress?.(event);
  }

  constructor(private readonly onProgress?: (event: TeamProgressEvent) => void) {}
}

/** 执行上下文（贯穿各子命令，避免长参数列表） */
interface RunContext {
  deps: TeamCommandDeps;
  io: OutputCollector;
  startTime: number;
  projectRoot: string;
  /** 全部候选角色（内置 + 运行时） */
  candidates: ReadonlyArray<RoleDefinition>;
  /** 内置角色 ID 集合（判定 builtin，不靠前缀猜测） */
  builtinRoleIds: ReadonlySet<string>;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 team 命令（纯执行，零终端副作用）
 *
 * @param args 已解析的子命令参数
 * @param deps 宿主能力注入（进度、候选集、执行器、日志开关）
 * @returns 退出码 + 文本输出 + 结构化产物 + 耗时
 */
export async function runTeamCommand(args: TeamCommandArgs, deps: TeamCommandDeps = {}): Promise<TeamCommandResult> {
  const startTime = Date.now();
  const io = new OutputCollector(deps.onProgress);
  const projectRoot = args.projectRoot ?? deps.projectRoot ?? process.cwd();
  const candidates = deps.candidates && deps.candidates.length > 0 ? deps.candidates : ROLE_REGISTRY;
  const ctx: RunContext = {
    deps,
    io,
    startTime,
    projectRoot,
    candidates,
    builtinRoleIds: new Set(listRoleIds()),
  };

  io.out(`\n🧠 DeepCodeX Team - ${args.subcommand}\n`);
  io.progress({ phase: "start", level: "info", message: `开始执行 /team ${args.subcommand}`, data: { projectRoot } });

  let exitCode: number;
  let data: TeamCommandData | undefined;
  try {
    switch (args.subcommand) {
      case "list": {
        const result = executeListCommand(ctx);
        exitCode = result.exitCode;
        data = result.data;
        break;
      }
      case "match": {
        const result = await executeMatchCommand(args, ctx);
        exitCode = result.exitCode;
        data = result.data;
        break;
      }
      case "dispatch": {
        const result = await executeDispatchCommand(args, ctx);
        exitCode = result.exitCode;
        data = result.data;
        break;
      }
      case "autonomous": {
        const result = await executeAutonomousCommand(args, ctx);
        exitCode = result.exitCode;
        data = result.data;
        break;
      }
      case "full-lifecycle": {
        const result = await executeFullLifecycleCommand(args, ctx);
        exitCode = result.exitCode;
        data = result.data;
        break;
      }
      case "auto": {
        const result = await executeAutoCommand(args, ctx);
        exitCode = result.exitCode;
        data = result.data;
        break;
      }
      default: {
        // TypeScript exhaustiveness check：未知子命令应被参数解析拒绝
        const exhaustive: never = args.subcommand;
        io.err(`未知的 team 子命令: ${String(exhaustive)}`);
        exitCode = 1;
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`\n✖ Team 命令执行失败: ${message}\n`);
    // 未捕获异常属于运行时异常，返回 4
    // （业务失败 = 1，参数错误 = 2，未捕获异常 = 4，对齐 quality-cmd.ts 先例）
    exitCode = 4;
    io.progress({ phase: "end", level: "error", message: `执行异常：${message}`, data: { exitCode } });
  }

  const durationMs = Date.now() - startTime;
  io.progress({
    phase: "end",
    level: exitCode === 0 ? "success" : "error",
    message: exitCode === 0 ? `执行完成（${durationMs}ms）` : `执行结束，退出码 ${exitCode}（${durationMs}ms）`,
    data: { exitCode, durationMs },
  });

  return {
    exitCode,
    stdout: io.stdout.join(""),
    stderr: io.stderr.join(""),
    data,
    durationMs,
  };
}

// ============================================================================
// list 子命令
// ============================================================================

/**
 * list 子命令 - 列出所有可用角色
 *
 * 输出格式（B8）：内置角色保持改动前的完整块状输出（golden 断言零变化），
 * 运行时角色（来自 SKILL.md 智能体）追加为按业务类别分组的紧凑清单，并标注来源。
 */
function executeListCommand(ctx: RunContext): { exitCode: number; data?: TeamCommandData } {
  const builtins = listAllRoles();
  const runtimeRoles = ctx.candidates.filter((role) => !ctx.builtinRoleIds.has(role.roleId));

  if (runtimeRoles.length === 0) {
    // 无运行时角色：逐字节保持改动前输出
    ctx.io.out(`可用角色（${builtins.length} 个）:\n`);
  } else {
    ctx.io.out(`可用角色（${builtins.length} 个内置 + ${runtimeRoles.length} 个业务角色）:\n`);
  }

  for (const role of builtins) {
    ctx.io.out(formatRoleInfo(role));
    ctx.io.out("");
  }

  if (runtimeRoles.length > 0) {
    ctx.io.out(`\n━━━ 业务角色（${runtimeRoles.length} 个，来自智能体）━━━\n`);
    const grouped = groupRuntimeRoles(runtimeRoles);
    for (const [group, roles] of grouped) {
      ctx.io.out(`\n【${group}】`);
      for (const role of roles) {
        const sourceLabel = role.metadata.source === "custom" ? "自建" : "预置";
        ctx.io.out(`  - ${role.roleId.padEnd(32)} ${role.name}  [${sourceLabel}]`);
      }
    }
    ctx.io.out("");
  }

  ctx.io.out(`⏱  耗时: ${Date.now() - ctx.startTime}ms\n`);

  const roles: TeamRoleSummary[] = [
    ...builtins.map((role) => ({
      roleId: role.roleId,
      name: role.name,
      priority: role.priority,
    })),
    ...runtimeRoles.map((role) => ({
      roleId: role.roleId,
      name: role.name,
      priority: role.priority,
      ...(role.metadata.group ? { group: role.metadata.group } : {}),
      ...(role.metadata.source === "custom" ? { custom: true } : { preset: true }),
    })),
  ];

  return { exitCode: 0, data: { kind: "list", roles } };
}

/** 业务类别中文标签（与 preset-agents 的 CATEGORY_LABELS 对齐，避免跨模块依赖） */
const GROUP_LABELS: Record<string, string> = {
  product: "业务需求",
  "project-management": "业务流程",
  strategy: "业务战略",
  support: "业务支持",
  specialized: "专业领域",
  academic: "学术研究",
  marketing: "营销增长",
  sales: "销售",
};

/** 按业务类别分组（未知类别归入"其他"，保证不丢角色） */
function groupRuntimeRoles(roles: ReadonlyArray<RoleDefinition>): Array<[string, RoleDefinition[]]> {
  const buckets = new Map<string, RoleDefinition[]>();
  for (const role of roles) {
    const key = role.metadata.group ?? "other";
    const label = GROUP_LABELS[key] ?? "其他";
    const bucket = buckets.get(label);
    if (bucket) {
      bucket.push(role);
    } else {
      buckets.set(label, [role]);
    }
  }
  return Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

// ============================================================================
// match 子命令
// ============================================================================

async function executeMatchCommand(
  args: TeamCommandArgs,
  ctx: RunContext
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  if (!args.keywords || args.keywords.length === 0) {
    ctx.io.err("match 子命令需要 --keywords 参数");
    return { exitCode: 2 };
  }

  const description = args.keywords.join(" ");
  const task: TaskRequirement = buildTask({
    title: args.task ?? description,
    description,
  });

  const matches = await matchRoles(task, {
    topK: 5,
    // L0-2：候选集（含运行时角色）——未注入时等价于 5 内置角色，结果与改动前一致
    // 展开为可变数组：zod schema 推论出的是 mutable 数组，而 deps 侧是 readonly
    ...(ctx.deps.candidates && ctx.deps.candidates.length > 0 ? { candidates: [...ctx.candidates] } : {}),
  });

  // 输出含英文关键字（matchedRole / roleId / confidence），便于 e2e 脚本 grep 断言
  ctx.io.out(`\n匹配结果（top ${matches.length}）:\n`);
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const bar = "█".repeat(Math.round(match.confidence * 20));
    ctx.io.out(
      `  ${i + 1}. roleId: ${match.roleId.padEnd(20)} ${bar} confidence: ${(match.confidence * 100).toFixed(1)}%`
    );
    if (match.reasons.length > 0) {
      ctx.io.out(`     理由: ${match.reasons[0]}`);
    }
  }

  ctx.io.out(`\n⏱  耗时: ${Date.now() - ctx.startTime}ms\n`);

  const summaries: TeamMatchSummary[] = matches.map((match) => ({
    roleId: match.roleId,
    roleName: match.roleName,
    confidence: match.confidence,
    reason: match.reasons[0] ?? "",
    builtin: ctx.builtinRoleIds.has(match.roleId),
  }));
  if (summaries[0]) {
    ctx.io.progress({
      phase: "match",
      level: "info",
      message: `匹配到 ${summaries[0].roleName}（${(summaries[0].confidence * 100).toFixed(1)}%）`,
      data: { roleId: summaries[0].roleId },
    });
  }

  return { exitCode: 0, data: { kind: "match", matches: summaries } };
}

// ============================================================================
// 任务描述解析
// ============================================================================

/**
 * 任务描述解析结果
 *
 * 为区分三种失败场景并返回不同退出码：
 *   - ok：成功解析到 task 描述
 *   - missing：未提供 --task 与 --task-file（dispatch 属参数错误，退出码 2）
 *   - task-file-empty / task-file-read-error：属于执行失败，退出码 1
 */
type ResolveTaskDescriptionResult =
  | { status: "ok"; task: string }
  | { status: "missing" }
  | { status: "task-file-empty" }
  | { status: "task-file-read-error"; message: string };

function resolveTaskDescription(
  args: TeamCommandArgs,
  subcommandName: string,
  io: OutputCollector,
  allowMissing: boolean = false
): ResolveTaskDescriptionResult {
  if (args.taskFile) {
    try {
      const content = fs.readFileSync(args.taskFile, "utf-8");
      if (content.trim().length === 0) {
        io.err(`✖ --task-file 指定的文件为空: ${args.taskFile}`);
        return { status: "task-file-empty" };
      }
      return { status: "ok", task: content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.err(`✖ 读取 --task-file 失败: ${args.taskFile} - ${message}`);
      return { status: "task-file-read-error", message };
    }
  }

  if (args.task) {
    return { status: "ok", task: args.task };
  }

  if (allowMissing) {
    return { status: "missing" };
  }

  io.err(`${subcommandName} 子命令需要 --task 或 --task-file 参数`);
  return { status: "missing" };
}

// ============================================================================
// dispatch 子命令
// ============================================================================

/** 构造 DispatchOptions（统一注入候选集 / 执行器 / 日志开关） */
function buildDispatchOptions(args: TeamCommandArgs, ctx: RunContext): Partial<DispatchOptions> {
  const options: Partial<DispatchOptions> = {
    projectRoot: ctx.projectRoot,
    ...(args.injectedClient ? { injectedClient: args.injectedClient } : {}),
    ...(ctx.deps.candidates && ctx.deps.candidates.length > 0 ? { candidates: [...ctx.candidates] } : {}),
    ...(ctx.deps.runner ? { runner: ctx.deps.runner } : {}),
    ...(ctx.deps.maxToolRounds ? { maxToolRounds: ctx.deps.maxToolRounds } : {}),
    ...(ctx.deps.eventLog !== undefined ? { eventLog: ctx.deps.eventLog } : {}),
  };
  return options;
}

async function executeDispatchCommand(
  args: TeamCommandArgs,
  ctx: RunContext
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  const resolvedTask = resolveTaskDescription(args, "dispatch", ctx.io);
  if (resolvedTask.status !== "ok") {
    if (resolvedTask.status === "missing") {
      ctx.io.err("用法: deepcode team dispatch --task <task> [--role <role-id>] [--project-root <path>]");
      ctx.io.err("      deepcode team dispatch --task-file <path> [--role <role-id>] [--project-root <path>]");
      return { exitCode: 2 };
    }
    return { exitCode: 1 };
  }
  const taskDescription = resolvedTask.task;

  // --consensus 互斥校验：共识评审固定派发全部 5 角色，与强制单角色语义冲突
  if (args.consensus && (args.role || args.forceRole)) {
    ctx.io.err("✖ --consensus 与 --role/--force-role 互斥：共识评审固定派发全部 5 角色，不可强制单角色");
    return { exitCode: 1 };
  }

  if (args.consensus) {
    return executeConsensusReview(taskDescription, args, ctx);
  }

  const task: TaskRequirement = buildTask({
    title: taskDescription,
    description: taskDescription,
  });

  let forceRoleObj: DispatchOptions["forceRole"] | undefined;
  if (args.role) {
    forceRoleObj = { roleId: args.role, reason: "通过命令行 --role 强制指定" };
  } else if (args.forceRole) {
    ctx.io.err("✖ --force-role 需要 --role 参数配合使用");
    return { exitCode: 1 };
  }

  const options: Partial<DispatchOptions> = {
    ...buildDispatchOptions(args, ctx),
    ...(forceRoleObj ? { forceRole: forceRoleObj } : {}),
  };

  ctx.io.out(`\n📋 任务: ${task.title}\n`);
  if (forceRoleObj) {
    ctx.io.out(`🎯 目标角色: ${forceRoleObj.roleId}（强制）\n`);
  } else {
    ctx.io.out(`🔍 模式: 自动匹配\n`);
  }
  ctx.io.out(`\n`);

  ctx.io.progress({
    phase: "dispatch",
    level: "info",
    message: forceRoleObj ? `派发到 ${forceRoleObj.roleId}…` : "正在匹配角色并派发…",
  });

  const result: DispatchResult = await executeDispatch(task, options, (status, message) => {
    ctx.io.progress({
      phase: "dispatch",
      level: status === "failed" || status === "cancelled" ? "error" : status === "succeeded" ? "success" : "info",
      message,
      data: { status },
    });
  });

  // 输出调度结果（含英文关键字，e2e 脚本依赖）
  ctx.io.out(`\n━━━ 调度结果（DispatchResult）━━━\n`);
  ctx.io.out(`status: ${result.status}\n`);
  ctx.io.out(`taskId: ${result.taskId}\n`);
  ctx.io.out(`dispatchId: ${result.dispatchId}\n`);
  ctx.io.out(`matchedRole: ${result.matchedRole.roleId} (${(result.matchedRole.confidence * 100).toFixed(1)}%)\n`);
  ctx.io.out(`continueCount: ${result.continueCount}\n`);
  ctx.io.out(`isPartial: ${result.isPartial}\n`);
  if (result.error) {
    ctx.io.err(`错误: ${result.error}\n`);
  }
  if (result.output) {
    ctx.io.out(`\n📤 输出:\n${result.output}\n`);
  }

  ctx.io.out(`\n⏱  耗时: ${Date.now() - ctx.startTime}ms\n`);

  // skipped 表示因缺少 API Key 等环境原因跳过 LLM 调用，不是代码错误 → 0
  const exitCode = result.status === "succeeded" || result.status === "skipped" ? 0 : 1;

  return {
    exitCode,
    data: {
      kind: "dispatch",
      dispatch: {
        status: result.status,
        taskId: result.taskId,
        dispatchId: result.dispatchId,
        roleId: result.matchedRole.roleId,
        roleName: result.matchedRole.roleName,
        confidence: result.matchedRole.confidence,
        output: result.output ?? "",
        ...(result.error ? { error: result.error } : {}),
        toolCapable: Boolean(ctx.deps.runner),
      },
    },
  };
}

// ============================================================================
// 共识评审（--consensus）
// ============================================================================

/**
 * 参与共识评审的 5 核心角色
 *
 * 与 RoleId 枚举对齐：architect / product-manager / solo-coder / test-expert / ui-designer
 */
const CONSENSUS_ROLE_IDS: ReadonlyArray<string> = Object.freeze([
  "architect",
  "product-manager",
  "solo-coder",
  "test-expert",
  "ui-designer",
]);

/**
 * 聚合阶段单角色输出嵌入上限（字符数）
 *
 * 5 角色 × 4000 字符 ≈ 20K 字符（约 10K token），加上聚合指令本身仍在主流模型
 * 上下文窗口安全范围内。截断保留开头（角色结论通常前置）并追加显式标记。
 */
const CONSENSUS_SYNTHESIS_OUTPUT_CAP = 4000;

/** 共识评审整体状态 */
type ConsensusStatus = "succeeded" | "partial" | "skipped" | "failed";

function capRoleOutputForSynthesis(output: string): string {
  if (output.length <= CONSENSUS_SYNTHESIS_OUTPUT_CAP) {
    return output;
  }
  return `${output.slice(0, CONSENSUS_SYNTHESIS_OUTPUT_CAP)}\n...[输出过长已截断，原文 ${output.length} 字符]`;
}

/**
 * 执行 5 角色共识评审
 *
 * 流程：并行派发 5 角色 → 状态统计 → LLM 聚合（三段式）→ 结构化输出。
 * 退出码：failFast 且任一角色失败 → 1；全部失败 → 1；其余（含 skipped）→ 0。
 */
async function executeConsensusReview(
  taskDescription: string,
  args: TeamCommandArgs,
  ctx: RunContext
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  ctx.io.out(`\n📋 任务: ${taskDescription}\n`);
  ctx.io.out(`🤝 模式: 5 角色共识评审（并行派发 + LLM 聚合）\n\n`);
  ctx.io.progress({ phase: "dispatch", level: "info", message: "5 角色并行评审中…", data: { roles: 5 } });

  const reviewTask: TaskRequirement = buildTask({
    title: `【共识评审】${taskDescription}`,
    description: `请从你角色的专业视角评审以下任务，输出你的评审意见（优点、风险、建议）：\n\n${taskDescription}`,
  });

  const baseOptions = buildDispatchOptions(args, ctx);

  const roleResults: Array<{ roleId: string; result: DispatchResult }> = await Promise.all(
    CONSENSUS_ROLE_IDS.map(async (roleId) => {
      const result = await executeDispatch(reviewTask, {
        ...baseOptions,
        forceRole: { roleId, reason: "共识评审（--consensus）" },
      });
      return { roleId, result };
    })
  );

  const succeededCount = roleResults.filter((item) => item.result.status === "succeeded").length;
  const failedCount = roleResults.filter((item) => item.result.status === "failed").length;
  const skippedCount = roleResults.filter((item) => item.result.status === "skipped").length;

  let consensusStatus: ConsensusStatus;
  if (succeededCount === CONSENSUS_ROLE_IDS.length) {
    consensusStatus = "succeeded";
  } else if (skippedCount === CONSENSUS_ROLE_IDS.length) {
    consensusStatus = "skipped";
  } else if (failedCount === CONSENSUS_ROLE_IDS.length) {
    consensusStatus = "failed";
  } else {
    consensusStatus = "partial";
  }

  const failFast = args.failFast !== false;
  const abortByFailFast = failFast && failedCount > 0;

  let synthesisOutput: string | null = null;
  let synthesisNote: string | null = null;
  const successfulReviews = roleResults.filter((item) => item.result.status === "succeeded" && item.result.output);

  if (abortByFailFast) {
    synthesisNote = `fail-fast 生效：${failedCount} 个角色评审失败，跳过聚合阶段`;
  } else if (successfulReviews.length > 0) {
    const embeddedReviews = successfulReviews
      .map(({ roleId, result }) => `### ${roleId} 的评审意见\n${capRoleOutputForSynthesis(result.output ?? "")}`)
      .join("\n\n");
    const synthesisTask: TaskRequirement = buildTask({
      title: `【共识聚合】${taskDescription}`,
      description:
        `以下是 ${successfulReviews.length} 个角色对同一任务的评审意见。\n` +
        `请聚合输出以下三段式结论（使用中文，每段以对应标题开头）：\n` +
        `1. 共识点：各角色一致认可的观点\n` +
        `2. 分歧点：角色间存在冲突或不同侧重的观点\n` +
        `3. 最终建议：综合权衡后的可执行建议\n\n` +
        `原始任务：${taskDescription}\n\n${embeddedReviews}`,
    });

    const synthesisResult = await executeDispatch(synthesisTask, {
      ...baseOptions,
      forceRole: { roleId: "architect", reason: "共识评审聚合（--consensus synthesis）" },
    });

    if (synthesisResult.status === "succeeded" && synthesisResult.output) {
      synthesisOutput = synthesisResult.output;
    } else if (synthesisResult.status === "skipped") {
      synthesisNote = "聚合阶段因环境原因跳过（缺 API Key），未生成聚合结论";
    } else {
      synthesisNote = `聚合阶段失败：${synthesisResult.error ?? "未知错误"}，请直接参考各角色评审意见`;
    }
  } else {
    synthesisNote = "无成功角色产出，未执行聚合";
  }

  // 结构化输出（ConsensusResult 关键字供 e2e 断言）
  ctx.io.out(`\n━━━ 共识评审结果（ConsensusResult）━━━\n`);
  ctx.io.out(`consensusStatus: ${consensusStatus}\n`);
  ctx.io.out(`roles: ${CONSENSUS_ROLE_IDS.length}\n`);
  ctx.io.out(`succeeded: ${succeededCount}\n`);
  ctx.io.out(`failed: ${failedCount}\n`);
  ctx.io.out(`skipped: ${skippedCount}\n`);

  ctx.io.out(`\n【各角色评审意见】\n`);
  for (const { roleId, result } of roleResults) {
    ctx.io.out(`\n--- ${roleId} (${result.status}) ---\n`);
    if (result.output) {
      ctx.io.out(`${result.output}\n`);
    }
    if (result.error) {
      ctx.io.err(`错误: ${result.error}\n`);
    }
    if (!result.output && !result.error) {
      ctx.io.out(`(无输出，status=${result.status})\n`);
    }
  }

  ctx.io.out(`\n━━━ 聚合结论 ━━━\n`);
  if (synthesisOutput) {
    ctx.io.out(`${synthesisOutput}\n`);
  } else {
    ctx.io.out(`（未聚合：${synthesisNote ?? "未知原因"}）\n`);
  }

  ctx.io.out(`\n⏱  耗时: ${Date.now() - ctx.startTime}ms\n`);

  const exitCode = abortByFailFast || consensusStatus === "failed" ? 1 : 0;

  return {
    exitCode,
    data: {
      kind: "dispatch",
      dispatch: {
        status: consensusStatus === "failed" ? "failed" : consensusStatus === "skipped" ? "skipped" : "succeeded",
        taskId: reviewTask.taskId,
        dispatchId: `consensus-${reviewTask.taskId}`,
        roleId: "consensus",
        roleName: "5 角色共识评审",
        confidence: 1,
        output: synthesisOutput ?? "",
        ...(synthesisNote ? { error: synthesisNote } : {}),
        toolCapable: Boolean(ctx.deps.runner),
      },
    },
  };
}

// ============================================================================
// auto 子命令（L2：自动多角色拆解）
// ============================================================================

/**
 * 编排进度 → 命令层进度
 *
 * 两套枚举的差异是刻意的：orchestrator 只关心自己的四个阶段，
 * 宿主（CLI/Web）只关心「粗粒度阶段」这一层稳定的词表。中间的映射放这里，
 * 避免让 orchestrator 反向依赖 commands 的类型。
 */
function mapOrchestrationPhase(
  phase: "decompose" | "plan" | "execute" | "aggregate" | "end"
): TeamProgressEvent["phase"] {
  switch (phase) {
    case "decompose":
      return "decompose";
    case "plan":
      return "stage";
    case "execute":
      return "dispatch";
    case "aggregate":
      return "aggregate";
    case "end":
      return "end";
  }
}

async function executeAutoCommand(
  args: TeamCommandArgs,
  ctx: RunContext
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  const goal = (args.goal ?? args.task ?? "").trim();
  if (goal === "") {
    ctx.io.err("auto 子命令需要 --goal 参数（或用 --task 传入目标）");
    ctx.io.err('用法: /team auto --goal "给项目加一个 CSV 导出功能" [--max-subtasks 6] [--max-parallel 2] [--dry-run]');
    return { exitCode: 2 };
  }

  if (args.maxSubtasks !== undefined && (!Number.isFinite(args.maxSubtasks) || args.maxSubtasks < 1)) {
    ctx.io.err("✖ --max-subtasks 必须是正整数");
    return { exitCode: 2 };
  }
  if (args.maxParallel !== undefined && (!Number.isFinite(args.maxParallel) || args.maxParallel < 1)) {
    ctx.io.err("✖ --max-parallel 必须是正整数");
    return { exitCode: 2 };
  }

  const budget = {
    ...(args.maxSubtasks !== undefined ? { maxSubtasks: args.maxSubtasks } : {}),
    ...(args.maxParallel !== undefined ? { maxParallel: args.maxParallel } : {}),
    ...(ctx.deps.maxToolRounds !== undefined ? { maxToolRounds: ctx.deps.maxToolRounds } : {}),
  };

  const result: OrchestrationResult = await orchestrate({
    goal,
    projectRoot: ctx.projectRoot,
    budget,
    candidates: ctx.candidates,
    ...(ctx.deps.runner ? { runner: ctx.deps.runner } : {}),
    ...(args.injectedClient ? { injectedClient: args.injectedClient } : {}),
    dryRun: args.dryRun === true,
    skipAggregate: args.skipAggregate === true,
    ...(ctx.deps.eventLog !== undefined ? { eventLog: ctx.deps.eventLog } : {}),
    onProgress: (event) => {
      ctx.io.progress({
        phase: mapOrchestrationPhase(event.phase),
        level: event.level,
        message: event.message,
        ...(event.data ? { data: event.data } : {}),
      });
    },
  });

  // ---- 终端输出：概要 + 报告 ------------------------------------------------
  // 子任务数从 layers 求和，而不是用 result.subtasks.length：
  // dry-run 时 subtasks 为空（没执行），用它会显示「0 个子任务」——与紧跟其后的
  // 计划表格自相矛盾（冒烟时实际踩到）。
  const plannedCount = result.layers.reduce((sum, layer) => sum + layer.length, 0);

  ctx.io.out(`\n🎯 目标: ${goal}\n`);
  if (result.mode === "degraded-single") {
    ctx.io.out(`⚠️  拆解未生效，已降级为单角色派单（${result.degradationReason ?? "未知原因"}）\n`);
  } else {
    ctx.io.out(
      `🧩 拆解: ${plannedCount} 个子任务 / ${result.layers.length} 层${
        result.serialized.length > 0 ? `（${result.serialized.length} 个因文件冲突改为串行）` : ""
      }\n`
    );
  }
  if (result.dryRun) {
    ctx.io.out("🔍 dry-run：仅生成计划，未执行任何子任务\n");
  }
  ctx.io.out(`🆔 编排 ID: ${result.runId}\n`);
  ctx.io.out(`\n${result.aggregate.text}\n`);
  if (result.mode === "orchestrated" && !result.dryRun) {
    ctx.io.out(
      `\n⏱  耗时: ${result.durationMs}ms ｜ 工具轮次: ${result.budget.usedToolRounds}/${result.budget.totalToolRounds}\n`
    );
  }

  const subtasks: TeamSubtaskSummary[] = result.subtasks.map((subtask) => ({
    id: subtask.id,
    title: subtask.title,
    roleName: subtask.roleName,
    status: subtask.status,
    layer: subtask.layer,
    durationMs: subtask.durationMs,
    rounds: subtask.rounds,
    toolCalls: subtask.toolCalls,
    ...(subtask.error ? { error: subtask.error } : {}),
  }));

  return {
    // 退出码：有子任务失败 → 1（与 dispatch 的「业务失败」语义一致）。
    // aborted 归 0：那是用户主动取消，不是编排出错——把用户的选择报成失败会误导脚本。
    exitCode: result.endReason === "completed" || result.endReason === "aborted" ? 0 : 1,
    data: {
      kind: "orchestrate",
      runId: result.runId,
      mode: result.mode,
      dryRun: result.dryRun === true,
      ...(result.degradationReason ? { degradationReason: result.degradationReason } : {}),
      layers: result.layers,
      subtasks,
      serializedCount: result.serialized.length,
      report: result.aggregate.text,
      aggregated: result.aggregate.aggregated,
      usedToolRounds: result.budget.usedToolRounds,
      totalToolRounds: result.budget.totalToolRounds,
      undocumentedChanges: result.undocumentedChanges,
    },
  };
}

// ============================================================================
// autonomous 子命令
// ============================================================================

const AUTONOMOUS_EXIT_MESSAGES: Record<number, string> = {
  0: "✅ Ralph Autonomous Loop 完成",
  1: "⚠️  Ralph Autonomous Loop 部分失败",
  2: "✖ Fatal abort（连续失败超限）",
  3: "🎯 命中 stop_when 条件",
};

async function executeAutonomousCommand(
  args: TeamCommandArgs,
  ctx: RunContext
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  const projectRoot = ctx.projectRoot;
  ctx.io.out(`🚀 启动 Ralph Autonomous Loop\n`);
  ctx.io.out(`项目根目录: ${projectRoot}\n`);

  // 必填参数前置校验：缺参必须在 API Key 检查之前判定为参数错误（退出码 2）
  if (!args.resumeRun && !args.goal && !args.task && !args.taskFile) {
    ctx.io.err("autonomous 子命令需要 --goal 或 --task 参数");
    return { exitCode: 2 };
  }

  // Step 2：API Key（injectedClient 优先）
  let clientHandle: OpenAIClientHandle;
  if (args.injectedClient) {
    clientHandle = args.injectedClient;
    ctx.io.out(`使用注入的 OpenAI 客户端（测试模式）\n`);
  } else {
    const created = createOpenAIClient(projectRoot);
    if (created.client === null) {
      ctx.io.err(
        `✖ autonomous 模式需要 API Key，无法启动 Ralph Autonomous Loop\n` +
          `  请通过以下任一方式配置：\n` +
          `  1. 设置环境变量 DEEPCODE_API_KEY（或 OPENAI_API_KEY）\n` +
          `  2. 在 ~/.deepcode/settings.json 或 ./.deepcode/settings.json 中配置 env.API_KEY 字段\n` +
          `  3. 使用 --injected-client 参数注入客户端（测试用）\n`
      );
      return { exitCode: 1 };
    }
    clientHandle = {
      client: created.client,
      model: created.model,
      baseURL: created.baseURL,
      temperature: created.temperature,
      thinkingEnabled: created.thinkingEnabled,
      reasoningEffort: created.reasoningEffort,
      debugLogEnabled: created.debugLogEnabled,
    };
  }
  ctx.io.out(`模型: ${clientHandle.model}\n`);
  ctx.io.out(`API Base: ${clientHandle.baseURL}\n`);

  // Step 3：run 状态（新建 / 断点续跑）
  const runsDir = path.join(projectRoot, ".deepcodex", "runs");
  let runState: RunState;
  let objective: string;

  const resolvedTask = resolveTaskDescription(args, "autonomous", ctx.io, true);
  if (resolvedTask.status === "task-file-empty" || resolvedTask.status === "task-file-read-error") {
    return { exitCode: 1 };
  }

  if (args.resumeRun) {
    ctx.io.out(`\n🔍 查找可恢复的 run...\n`);
    const resumable = findLatestResumableRun(runsDir);
    if (resumable === null) {
      ctx.io.out(`未找到可恢复的 run，将创建新 run\n`);
      objective = args.goal ?? (resolvedTask.status === "ok" ? resolvedTask.task : "") ?? "";
      if (!objective) {
        ctx.io.err("autonomous 子命令需要 --goal 或 --task 参数");
        return { exitCode: 2 };
      }
      const runId = generateRunId();
      runState = new RunState(path.join(runsDir, runId), runId, objective);
    } else {
      runState = resumable;
      objective = runState.state.objective;
      ctx.io.out(`✅ 已恢复运行: runId=${runState.state.runId}, iterIndex=${runState.state.iterIndex}\n`);
    }
  } else {
    objective = args.goal ?? (resolvedTask.status === "ok" ? resolvedTask.task : "") ?? "";
    if (!objective) {
      ctx.io.err("autonomous 子命令需要 --goal 或 --task 参数");
      return { exitCode: 2 };
    }
    const runId = generateRunId();
    runState = new RunState(path.join(runsDir, runId), runId, objective);
    ctx.io.out(`创建新 run: runId=${runId}\n`);
  }
  runState.persist();

  // Step 4：配置（项目级 → 用户级 → 默认值，CLI 参数优先）
  const autonomousConfig = loadAutonomousConfig(projectRoot);
  const baseLoopConfig = defaultLoopConfig();
  const loopConfig: LoopConfig = {
    ...baseLoopConfig,
    maxIterations: args.maxIterations ?? autonomousConfig.maxIterations ?? baseLoopConfig.maxIterations,
    maxTokens: autonomousConfig.maxTokens ?? baseLoopConfig.maxTokens,
    enforceTokenBudget: autonomousConfig.enforceTokenBudget ?? baseLoopConfig.enforceTokenBudget,
    stopWhen: autonomousConfig.stopWhen ?? baseLoopConfig.stopWhen,
    backoffBaseSec: autonomousConfig.backoffBaseSec ?? baseLoopConfig.backoffBaseSec,
    backoffMaxSec: autonomousConfig.backoffMaxSec ?? baseLoopConfig.backoffMaxSec,
    consecutiveFailureAbort: autonomousConfig.consecutiveFailureAbort ?? baseLoopConfig.consecutiveFailureAbort,
    testCommand: autonomousConfig.testCommand ?? baseLoopConfig.testCommand,
    securityAnalyzer: autonomousConfig.securityAnalyzer ?? baseLoopConfig.securityAnalyzer,
  };

  ctx.io.out(`\n📋 Autonomous 配置:\n`);
  ctx.io.out(`  最大迭代: ${loopConfig.maxIterations}\n`);
  ctx.io.out(`  最大 token（压缩基线，不终止运行）: ${loopConfig.maxTokens}\n`);
  ctx.io.out(`  连续失败上限: ${loopConfig.consecutiveFailureAbort}\n`);
  ctx.io.out(`  目标: ${objective}\n\n`);

  ctx.io.progress({
    phase: "stage",
    level: "info",
    message: `Ralph 循环启动：目标「${objective}」，最多 ${loopConfig.maxIterations} 轮`,
    index: 0,
    total: loopConfig.maxIterations,
    data: { runId: runState.state.runId },
  });

  // Step 6：驱动组件
  const gitDriver = new GitDriver({
    repoRoot: projectRoot,
    runId: runState.state.runId,
    runDir: runState.runDirPath,
  });
  const notesMemory = new NotesMemory(path.join(projectRoot, ".deepcodex", "notes.md"));
  let sleepGuard: SleepGuard | null = null;
  try {
    sleepGuard = new SleepGuard("on");
  } catch (error) {
    ctx.io.err(`⚠️  SleepGuard 初始化失败（不阻塞）: ${error instanceof Error ? error.message : String(error)}\n`);
    sleepGuard = null;
  }

  const stageHandlers = createDefaultStageHandlers({
    projectRoot,
    injectedClient: clientHandle,
    testCommand: loopConfig.testCommand,
  });

  // Step 7：执行循环（log 回调同时写文本与进度事件 → Web 可见 plan→dev→verify→fix）
  const controller = new RalphLoopController({
    config: loopConfig,
    projectRoot,
    gitDriver,
    notesMemory,
    runState,
    stageHandlers,
    objective,
    log: (level, message) => {
      const prefix = level === "error" ? "✖" : level === "warn" ? "⚠️ " : level === "debug" ? "🔍" : "ℹ️";
      ctx.io.out(`  ${prefix} ${message}\n`);
      // debug 级不推给用户（噪声），其余转发为进度事件
      if (level !== "debug") {
        ctx.io.progress({
          phase: "loop",
          level: level === "error" ? "error" : level === "warn" ? "warn" : level === "info" ? "info" : "info",
          message,
          index: runState.state.iterIndex,
          total: loopConfig.maxIterations,
          data: { runId: runState.state.runId },
        });
      }
    },
    sleepGuard,
  });

  const exitCode = await controller.run();
  runState.persist();

  // Step 8：终态输出
  const message = AUTONOMOUS_EXIT_MESSAGES[exitCode] ?? `未知退出码: ${exitCode}`;
  ctx.io.out(`\n${message}\n`);
  ctx.io.out(`  退出码: ${exitCode}\n`);
  ctx.io.out(`  总迭代: ${runState.state.iterIndex}\n`);
  ctx.io.out(`  累计 token: ${runState.state.cumulativeTokens}\n`);
  ctx.io.out(`  已提交 commit: ${runState.state.commitsMade}\n`);
  ctx.io.out(`  耗时: ${Date.now() - ctx.startTime}ms\n`);

  return {
    exitCode,
    data: {
      kind: "autonomous",
      runId: runState.state.runId,
      exitCode,
      iterations: runState.state.iterIndex,
      tokens: runState.state.cumulativeTokens,
      commits: runState.state.commitsMade,
      endReason: exitCode === 0 ? "completed" : exitCode === 2 ? "aborted" : exitCode === 3 ? "completed" : "error",
    },
  };
}

// ============================================================================
// full-lifecycle 子命令
// ============================================================================

/**
 * 八阶段标准工作流（与 multi-agent-team skill 一致）
 * 1 需求分析（产品经理）→ 2 架构设计 → 3 UI 设计 → 4 测试设计
 * 5 任务分解 → 6 开发实现 → 7 测试验证 → 8 文档对照代码审查
 */
const LIFECYCLE_STAGES: ReadonlyArray<{ role: string; title: string; artifact: string }> = Object.freeze([
  { role: "product-manager", title: "需求分析", artifact: "PRD.md" },
  { role: "architect", title: "架构设计", artifact: "ARCHITECTURE.md" },
  { role: "ui-designer", title: "UI 设计", artifact: "UI_MOCKUPS.md" },
  { role: "test-expert", title: "测试设计", artifact: "TEST_PLAN.md" },
  { role: "solo-coder", title: "任务分解", artifact: "TASKS.md" },
  { role: "solo-coder", title: "开发实现", artifact: "src/" },
  { role: "test-expert", title: "测试验证", artifact: "tests/" },
  { role: "solo-coder", title: "文档对照代码审查", artifact: "DOC_CODE_REVIEW.md" },
]);

async function executeFullLifecycleCommand(
  args: TeamCommandArgs,
  ctx: RunContext
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  const resolvedTask = resolveTaskDescription(args, "full-lifecycle", ctx.io, true);
  if (resolvedTask.status === "task-file-empty" || resolvedTask.status === "task-file-read-error") {
    return { exitCode: 1 };
  }

  const project = args.goal ?? (resolvedTask.status === "ok" ? resolvedTask.task : undefined);
  if (!project) {
    ctx.io.err("full-lifecycle 子命令需要 --goal 或 --task 参数");
    return { exitCode: 2 };
  }

  if (args.useLoop) {
    return executeFullLifecycleWithLoop(args, ctx, project);
  }
  return executeFullLifecycleLinear(args, ctx, project);
}

/**
 * 线性模式：8 阶段顺序执行
 *
 * 阶段 1-7 通过 executeDispatch 调度到对应角色，阶段 8 调用 DocCodeConsistencyChecker。
 * fail-fast 默认开启：任一阶段失败即中止并返回 1；--no-fail-fast 时汇总后仍返回 1。
 */
async function executeFullLifecycleLinear(
  args: TeamCommandArgs,
  ctx: RunContext,
  project: string
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  const failFast = args.failFast !== false;
  const failedStages: Array<{ index: number; title: string; error?: string }> = [];
  const stageSummaries: TeamStageSummary[] = [];

  ctx.io.out(`\n🎬 启动 8 阶段全流程（线性模式）: ${project}\n`);
  ctx.io.out(`项目根: ${ctx.projectRoot}\n\n`);

  for (let i = 0; i < LIFECYCLE_STAGES.length - 1; i++) {
    const stage = LIFECYCLE_STAGES[i]!;
    ctx.io.out(`\n━━━ 阶段 ${i + 1}/${LIFECYCLE_STAGES.length}: ${stage.title}（${stage.role}）━━━\n`);
    // F1/F3：阶段推进事件（Web 上可见 plan→dev→verify 序列）
    ctx.io.progress({
      phase: "stage",
      level: "info",
      message: `阶段 ${i + 1}/${LIFECYCLE_STAGES.length}：${stage.title}（${stage.role}）`,
      index: i + 1,
      total: LIFECYCLE_STAGES.length,
      data: { role: stage.role, artifact: stage.artifact, project },
    });

    const task: TaskRequirement = buildTask({
      title: `[阶段${i + 1}] ${stage.title} - ${project}`,
      description: `${stage.title} for project "${project}"`,
    });
    task.upstreamContext = {
      lifecycleStage: i + 1,
      lifecycleStageName: stage.title,
      lifecycleArtifact: stage.artifact,
    };

    const result = await executeDispatch(task, {
      ...buildDispatchOptions(args, ctx),
      forceRole: { roleId: stage.role, reason: `8 阶段全流程 - 阶段 ${i + 1}: ${stage.title}` },
    });

    ctx.io.out(`  角色: ${result.matchedRole.roleId}\n`);
    ctx.io.out(`  状态: ${result.status}\n`);
    ctx.io.out(`  产物: ${stage.artifact}\n`);

    const stageOk = result.status === "succeeded" || result.status === "skipped";
    stageSummaries.push({
      index: i + 1,
      title: stage.title,
      role: result.matchedRole.roleId,
      status: result.status === "succeeded" ? "succeeded" : result.status === "skipped" ? "skipped" : "failed",
      artifact: stage.artifact,
      ...(result.error ? { error: result.error } : {}),
    });

    if (!stageOk) {
      if (failFast) {
        ctx.io.err(`\n✖ 阶段 ${i + 1} (${stage.title}) 失败，中止全流程\n`);
        if (result.error) {
          ctx.io.err(`  错误: ${result.error}\n`);
        }
        return {
          exitCode: 1,
          data: { kind: "full-lifecycle", project, stages: stageSummaries, overallSuccess: false },
        };
      }
      ctx.io.err(`\n✖ 阶段 ${i + 1} (${stage.title}) 失败（--no-fail-fast，继续执行后续阶段）\n`);
      if (result.error) {
        ctx.io.err(`  错误: ${result.error}\n`);
      }
      failedStages.push({ index: i + 1, title: stage.title, error: result.error });
    }
  }

  // 阶段 8：文档对照代码审查
  const stage8 = LIFECYCLE_STAGES[7]!;
  ctx.io.out(`\n━━━ 阶段 8/${LIFECYCLE_STAGES.length}: ${stage8.title}（多角色）━━━\n`);
  ctx.io.out(`  调用 DocCodeConsistencyChecker 执行六大维度检查...\n`);
  ctx.io.progress({
    phase: "stage",
    level: "info",
    message: `阶段 8/${LIFECYCLE_STAGES.length}：${stage8.title}`,
    index: 8,
    total: LIFECYCLE_STAGES.length,
    data: { artifact: stage8.artifact, project },
  });

  const docPaths: Record<string, string> = {};
  if (args.prdPath) docPaths["prd"] = args.prdPath;
  if (args.architecturePath) docPaths["architecture"] = args.architecturePath;
  if (args.testPlanPath) docPaths["test_plan"] = args.testPlanPath;

  const reviewExitCode = executeDocCodeReviewStage(ctx, docPaths, args.testCommand);
  stageSummaries.push({
    index: 8,
    title: stage8.title,
    role: "multi-role",
    status: reviewExitCode === 0 ? "succeeded" : "failed",
    artifact: stage8.artifact,
  });

  if (reviewExitCode !== 0) {
    ctx.io.err(`\n✖ 阶段 8 (${stage8.title}) 审查未通过，全流程失败\n`);
    if (failFast) {
      return { exitCode: 1, data: { kind: "full-lifecycle", project, stages: stageSummaries, overallSuccess: false } };
    }
    failedStages.push({ index: 8, title: stage8.title });
  }

  if (failedStages.length > 0) {
    const failedSummary = failedStages
      .map((stage) => `阶段${stage.index}(${stage.title})${stage.error ? `: ${stage.error}` : ""}`)
      .join("、");
    ctx.io.err(`\n✖ 全流程执行完毕，但 ${failedStages.length} 个阶段失败: ${failedSummary}\n`);
    return { exitCode: 1, data: { kind: "full-lifecycle", project, stages: stageSummaries, overallSuccess: false } };
  }

  ctx.io.out(`\n\n🎉 8 阶段全流程完成！耗时: ${Date.now() - ctx.startTime}ms\n`);
  return { exitCode: 0, data: { kind: "full-lifecycle", project, stages: stageSummaries, overallSuccess: true } };
}

/**
 * 循环模式：WorkflowLoopController 八阶段（审查失败按 D1~D6 精准回退）
 */
async function executeFullLifecycleWithLoop(
  args: TeamCommandArgs,
  ctx: RunContext,
  project: string
): Promise<{ exitCode: number; data?: TeamCommandData }> {
  const maxIterations = args.maxIterations ?? 3;
  const projectRoot = ctx.projectRoot;
  ctx.io.out(`\n🎬 启动 8 阶段全流程（循环模式，最大迭代 ${maxIterations}）: ${project}\n`);
  ctx.io.out(`项目根: ${projectRoot}\n\n`);

  const docPaths: Record<string, string> = {};
  if (args.prdPath) docPaths["prd"] = args.prdPath;
  if (args.architecturePath) docPaths["architecture"] = args.architecturePath;
  if (args.testPlanPath) docPaths["test_plan"] = args.testPlanPath;

  const baseExecutor = new DefaultStageExecutor({
    projectRoot,
    testCommand: args.testCommand ?? "",
    docPaths,
  });

  // 无测试命令时：阶段 7 占位通过 + 阶段 8 过滤 D3 缺口（真实流程控制，非 mock）
  const hasTestCommand = Boolean(args.testCommand && args.testCommand.trim().length > 0);
  const customExecutor: StageExecutor = (stage, context) => {
    const result = baseExecutor.execute(stage, context);

    if (stage === "test_verification" && !hasTestCommand) {
      return {
        ...result,
        success: true,
        summary: "未配置测试命令，跳过测试验证（占位通过）",
        error: "",
        artifacts: {
          ...result.artifacts,
          test_command: "(未配置)",
          passed: 0,
          failed: 0,
          skipped: 0,
          test_output_tail: "未配置测试命令，跳过测试验证",
        },
      };
    }

    if (stage === "doc_code_review" && !hasTestCommand) {
      const gapListRaw = result.artifacts["gap_list"];
      const gapList: Array<Record<string, unknown>> = Array.isArray(gapListRaw)
        ? (gapListRaw as Array<Record<string, unknown>>)
        : [];
      const filteredGaps = gapList.filter((gap) => !String(gap["dimension"] ?? "").startsWith("D3 测试正确性"));
      const overallPassed = filteredGaps.length === 0;
      return {
        ...result,
        success: true,
        summary: overallPassed
          ? "审查通过：文档-代码一致（已跳过 D3 测试正确性检查）"
          : `审查不通过：${filteredGaps.length} 个缺口（已跳过 D3 测试正确性检查）`,
        artifacts: {
          ...result.artifacts,
          gap_list: filteredGaps,
          overall_passed: overallPassed,
        },
      };
    }

    return result;
  };

  const controller = new WorkflowLoopController({
    projectRoot,
    stageExecutor: customExecutor,
    maxIterations,
    docPaths,
    testCommand: args.testCommand ?? "",
    log: (level: string, message: string) => {
      const prefix = level === "ERROR" ? "✖" : level === "WARN" ? "⚠️ " : level === "DEBUG" ? "🔍" : "ℹ️";
      ctx.io.out(`  ${prefix} ${message}\n`);
      if (level !== "DEBUG") {
        ctx.io.progress({
          phase: "loop",
          level: level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info",
          message,
          total: maxIterations,
          data: { project },
        });
      }
    },
  });

  const result: WorkflowRunResult = controller.run();
  ctx.io.out(`\n${summarizeWorkflowRunResult(result)}\n`);

  const durationMs = Date.now() - ctx.startTime;
  const stageSummaries: TeamStageSummary[] = LIFECYCLE_STAGES.map((stage, index) => ({
    index: index + 1,
    title: stage.title,
    role: stage.role,
    status: result.overallSuccess ? "succeeded" : "failed",
    artifact: stage.artifact,
  }));

  if (result.overallSuccess) {
    ctx.io.out(`\n🎉 8 阶段循环完成（${result.totalIterations} 次迭代）！耗时: ${durationMs}ms\n`);
    return {
      exitCode: 0,
      data: { kind: "full-lifecycle", project, stages: stageSummaries, overallSuccess: true },
    };
  }

  ctx.io.err(
    `\n✖ 8 阶段循环未通过（${result.totalIterations}/${result.maxIterations} 次迭代），剩余 ${result.finalGaps.length} 个缺口\n`
  );
  ctx.io.err(`  耗时: ${durationMs}ms\n`);
  return {
    exitCode: 1,
    data: { kind: "full-lifecycle", project, stages: stageSummaries, overallSuccess: false },
  };
}

/**
 * 阶段 8 文档对照代码审查（线性模式）
 *
 * D1 功能完成度 / D2 集成完整性 / D3 测试正确性 / D4 验收标准 / D5 TODO 清零 / D6 意图遵从
 */
function executeDocCodeReviewStage(ctx: RunContext, docPaths: Record<string, string>, testCommand?: string): number {
  try {
    const checker = new DocCodeConsistencyChecker(ctx.projectRoot, docPaths, testCommand ?? "", 600);
    const report = checker.checkAll();

    let effectiveGaps = report.gap_list;
    let effectivePassed = report.overall_passed;
    if (!testCommand || testCommand.trim() === "") {
      // 未配置测试命令时过滤 D3 缺口：该维度依赖测试执行结果，缺失不应阻塞流程
      effectiveGaps = report.gap_list.filter((gap) => !gap.dimension.startsWith("D3 测试正确性"));
      effectivePassed = effectiveGaps.length === 0;
    }

    ctx.io.out(`\n  ━━━ 文档对照代码审查报告 ━━━\n`);
    ctx.io.out(`  项目: ${report.project_name}\n`);
    ctx.io.out(`  检查时间: ${report.check_time}\n`);
    ctx.io.out(`  D1 功能完成度: ${report.feature_checks.length} 项检查\n`);
    ctx.io.out(`  D2 集成完整性: ${report.integration_checks.length} 项检查\n`);
    if (report.test_result) {
      ctx.io.out(
        `  D3 测试正确性: passed=${report.test_result.passed}, failed=${report.test_result.failed}, skipped=${report.test_result.skipped}\n`
      );
    } else {
      ctx.io.out(`  D3 测试正确性: 未执行（未配置测试命令或测试命令为空）\n`);
    }
    ctx.io.out(`  D4 验收标准: ${report.acceptance_checks.length} 项检查\n`);
    ctx.io.out(`  D5 TODO/FIXME: ${report.todo_items.length} 项残留\n`);
    ctx.io.out(`  D6 文档意图偏离: ${report.deviation_items.length} 项\n`);

    if (effectivePassed) {
      ctx.io.out(`\n  ✅ 审查通过：文档-代码一致\n`);
      return 0;
    }

    ctx.io.err(`\n  ❌ 审查不通过：${effectiveGaps.length} 个缺口\n`);
    for (let i = 0; i < effectiveGaps.length; i++) {
      const gap = effectiveGaps[i]!;
      ctx.io.err(`    ${i + 1}. [${gap.priority}] ${gap.dimension}: ${gap.description}\n`);
      if (gap.suggestion) {
        ctx.io.err(`       建议: ${gap.suggestion}\n`);
      }
    }
    return 1;
  } catch (error) {
    const errMsg = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
    ctx.io.err(`\n  ✖ 文档对照代码审查执行异常: ${errMsg}\n`);
    return 1;
  }
}

// ============================================================================
// 命令行解析（Web / CLI 共用）
// ============================================================================

/** 帮助文本（与 CLI 版逐字一致，仅角色清单动态化） */
export function formatTeamHelp(): string {
  const roleList = ROLE_REGISTRY.map((role) => `  - ${role.roleId.padEnd(20)} ${role.name}`).join("\n");
  return `
DeepCodeX Team - 多角色协同调度

用法:
  deepcode team <subcommand> [options]

子命令:
  list                              列出所有可用角色
  match --keywords <kw1,kw2,...>    根据关键词匹配角色
  dispatch --task <task>            分派任务到角色（自动匹配或 --role 强制）
  dispatch --task-file <path>       从文件读取任务描述（避免 shell 转义问题）
  autonomous --goal <goal>          启动 Ralph 自主迭代（4 阶段循环）
  full-lifecycle --project <name>   8 阶段项目全流程（v2.1 P5）
  auto --goal <goal>                自动多角色拆解：拆解→分层→并行执行→聚合（L2）

内置角色（${ROLE_REGISTRY.length}）:
${roleList}

选项:
  --role <role-id>                  强制指定角色（dispatch 模式）
  --task <text>                     任务描述（dispatch / autonomous / full-lifecycle）
  --task-file <path>                任务文件路径（v2.1.1：从文件读取，避免 shell 转义问题）
  --force-role                      禁用自动匹配（需要 --role）
  --consensus                       启用 5 角色联合评审（并行派发 + LLM 聚合共识点/分歧点/最终建议；
                                    与 --role/--force-role 互斥）
  --fail-fast                       失败时立即中止（默认开启；仅 consensus 与 full-lifecycle
                                    线性模式生效；--no-fail-fast 部分失败时继续执行并汇总）
  --max-iterations <n>              最大迭代次数（autonomous / full-lifecycle --use-loop，默认 5/3）
  --project-root <path>             项目根目录（默认当前目录）
  --resume-run                      断点续跑（autonomous 模式）

v2.1 P5 full-lifecycle 专属选项:
  --use-loop                        启用 WorkflowLoopController（审查失败时精准回退）
  --prd-path <path>                 PRD 文档路径（阶段 8 输入）
  --architecture-path <path>        架构设计文档路径（阶段 8 输入）
  --test-plan-path <path>           测试计划文档路径（阶段 8 输入）
  --test-command <cmd>              测试命令（阶段 7 + 阶段 8 D3 检查使用）

L2 auto 专属选项:
  --goal <text>                     要完成的目标（自然语言，auto 的唯一必填项）
  --max-subtasks <n>                拆解出的子任务数上限（默认 6）
  --max-parallel <n>                层内并发上限（默认 2）
  --dry-run                         只拆解 + 分层并展示计划，不执行、不改文件
  --no-aggregate                    跳过最终汇总的 LLM 调用，直接本地拼装报告

退出码:
  0  成功（命令正常完成，审查/检查通过）
  1  执行失败（命令运行完成但结果未通过，如审查发现缺陷、测试失败）
  2  参数错误（缺少必填参数、参数格式非法、未知子命令/选项）
  4  运行时异常（未捕获的异常、依赖缺失、I/O 错误等无法继续执行的情况）

示例:
  deepcode team list
  deepcode team match --keywords "微服务,架构,API"
  deepcode team dispatch --task "设计用户认证模块"
  deepcode team dispatch --role architect --task "系统架构评审"
  deepcode team dispatch --task "用户登录方案" --consensus
  deepcode team dispatch --role solo-coder --task-file ./task.txt
  deepcode team autonomous --goal "实现 OAuth2 登录"
  deepcode team full-lifecycle --project "电商网站"
  deepcode team full-lifecycle --project "电商网站" --use-loop --max-iterations 3
  deepcode team auto --goal "给项目加一个 CSV 导出功能"
  deepcode team auto --goal "重构配置加载" --dry-run
  deepcode team auto --goal "补齐测试覆盖" --max-subtasks 4 --max-parallel 2
  deepcode team full-lifecycle --project "电商网站" \\
    --prd-path docs/prd.md \\
    --architecture-path docs/architecture.md \\
    --test-command "npm test"
`;
}

/**
 * 判定「这段文本是在调用 /team 命令」，而不是"里面碰巧有 team 字样"
 *
 * ## 为什么不能只用 `parseTeamCommandLine() !== null` 做判定
 *
 * `parseTeamCommandLine` 对**非法子命令**返回 null（"这不是一条合法命令"），宿主据此
 * 回落成普通消息。但用户在聊天框里敲 `/team`、`/team help`、`/team ls`（手误）时，
 * 意图明确是"我要用 team 命令"，回落给模型只会复现审计报告 §3.2 的静默降级：
 * 模型配合演出一段像命令输出的文字，用户以为成功了。
 *
 * 因此把"是否在调用命令"与"参数是否合法"拆开：
 * - 本函数判**意图**（首 token 严格等于 `team`，`/teams` 不算）
 * - `parseTeamCommandLine` 判**参数**，返回 null 时由执行体回显帮助 + 明确报错
 *
 * @param text 用户原始输入
 * @returns 首 token 为 `team` 时 true
 */
export function isTeamCommandIntent(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const tokens = tokenizeCommandLine(trimmed.slice(1));
  return tokens[0] === "team";
}

/**
 * 取 `/team` 之后的第一个 token（用于"未知子命令"报错文案）
 *
 * @returns 子命令 token；裸 `/team` 返回 undefined
 */
export function extractTeamSubcommandToken(text: string): string | undefined {
  if (!isTeamCommandIntent(text)) return undefined;
  const tokens = tokenizeCommandLine(text.trim().slice(1));
  return tokens[1];
}

/**
 * 解析命令行形式的 team 命令（供聊天输入框 / Web 消息直接执行）
 *
 * 支持形态（与 CLI `parse-team-args` 的常用子集对齐，覆盖人类手输场景）：
 * - `/team list`
 * - `/team match --keywords 增长,营销`
 * - `/team dispatch --task "..." [--role id] [--consensus] [--force-role]`
 * - `/team autonomous --goal "..." [--max-iterations 5] [--resume-run]`
 * - `/team full-lifecycle --project "..." [--use-loop] [--test-command "npm test"]`
 * - `/team auto --goal "..." [--max-subtasks 6] [--max-parallel 2] [--dry-run] [--no-aggregate]`
 *
 * 参数值支持 `--flag value` 与 `--flag=value` 两种写法；值可用单/双引号包裹。
 *
 * @returns 解析成功返回参数对象；文本不以 `/team` 开头或子命令非法时返回 null
 *          （返回 null 表示"这不是 team 命令"，调用方应继续走普通消息路径）
 */
export function parseTeamCommandLine(text: string): TeamCommandArgs | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokens = tokenizeCommandLine(trimmed.slice(1));
  const [name, ...rest] = tokens;
  if (name !== "team" || rest.length === 0) return null;

  const sub = rest[0] as TeamSubcommand;
  if (!TEAM_SUBCOMMANDS.includes(sub)) return null;

  const args: TeamCommandArgs = { subcommand: sub };
  const keywords: string[] = [];

  for (let i = 1; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) continue;

    const eqIndex = token.indexOf("=");
    const flag = eqIndex >= 0 ? token.slice(2, eqIndex) : token.slice(2);
    const inlineValue = eqIndex >= 0 ? token.slice(eqIndex + 1) : undefined;

    /** 取参数值：`--flag=v` 直接用；否则吞掉下一个非 flag token */
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };

    switch (flag) {
      case "keywords": {
        const value = takeValue();
        if (value) {
          keywords.push(
            ...value
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean)
          );
        }
        break;
      }
      case "role": {
        const value = takeValue();
        if (value) args.role = value;
        break;
      }
      case "task": {
        const value = takeValue();
        if (value) args.task = value;
        break;
      }
      case "task-file": {
        const value = takeValue();
        if (value) args.taskFile = value;
        break;
      }
      case "goal":
      case "project": {
        const value = takeValue();
        if (value) args.goal = value;
        break;
      }
      case "max-iterations": {
        const value = takeValue();
        const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
        if (Number.isFinite(parsed) && parsed > 0) args.maxIterations = parsed;
        break;
      }
      case "project-root": {
        const value = takeValue();
        if (value) args.projectRoot = value;
        break;
      }
      case "prd-path": {
        const value = takeValue();
        if (value) args.prdPath = value;
        break;
      }
      case "architecture-path": {
        const value = takeValue();
        if (value) args.architecturePath = value;
        break;
      }
      case "test-plan-path": {
        const value = takeValue();
        if (value) args.testPlanPath = value;
        break;
      }
      case "test-command": {
        const value = takeValue();
        if (value) args.testCommand = value;
        break;
      }
      case "force-role":
        args.forceRole = true;
        break;
      case "consensus":
        args.consensus = true;
        break;
      case "resume-run":
        args.resumeRun = true;
        break;
      case "use-loop":
        args.useLoop = true;
        break;
      case "no-fail-fast":
        args.failFast = false;
        break;
      // ---- auto 子命令（L2）----
      case "dry-run":
        args.dryRun = true;
        break;
      case "no-aggregate":
        args.skipAggregate = true;
        break;
      case "max-subtasks": {
        const value = takeValue();
        const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
        if (Number.isFinite(parsed) && parsed > 0) args.maxSubtasks = parsed;
        break;
      }
      case "max-parallel": {
        const value = takeValue();
        const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
        if (Number.isFinite(parsed) && parsed > 0) args.maxParallel = parsed;
        break;
      }
      default:
        // 未知选项交由执行体忽略（与 CLI parse-team-args 的宽容策略一致）
        break;
    }
  }

  if (keywords.length > 0) args.keywords = keywords;
  return args;
}

/**
 * 极简命令分词器：按空白切分，支持单/双引号包裹的整体 token
 *
 * 不引入 shell-quote 等依赖（约束：无新增运行时依赖）；覆盖聊天输入框的真实用法：
 * `--task "实现登录"`、`--task='实现登录'`。
 */
function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

// 供外部（CLI 类型兼容）复用的类型出口
export type { MatchResult, IterationKind };
