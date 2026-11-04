/**
 * Super Agent 子命令 —— `deepcode super`
 *
 * ## 子命令
 *
 * | 子命令 | 作用 |
 * |---|---|
 * | `start` | 启动 Super Agent（事件源 + 周期调度）；`--once` 只跑一轮 |
 * | `status` | 运行时状态（接单模式、工单数、副作用积压、能力可用性、候选/待办/token/直通计数） |
 * | `candidates` | 待研判候选 + 最近决策（含 observe 模式的影子记录） |
 * | `tickets` | 工单列表 |
 * | `ticket <id>` | 工单详情（授权、派工、输入、消息、Attention） |
 * | `inject <text>` | 投递一个事件（走与真实 Source 完全相同的准入路径） |
 * | `policy` | 查看策略 / 切换接单模式 |
 * | `memory` | 列出历史研判经验（全局层上下文——「系统记住了什么」的唯一出口） |
 * | `soul` | 「司南」的人格与分类记忆（查看 / 记一条 / 整理 / 打印提示词） |
 * | `help` | 帮助 |
 *
 * ## 首期诚实边界
 *
 * - 默认接单模式是 `observe`：**推断型候选只记影子（"本应接单"），不真的建工单**。
 * - 显式请求（`--addressed`）在任何模式下都真的接单。
 * - Worker 是「一次真实 LLM 调用 + 结构化报告」，不是完整 agentic 会话。
 * - 没配置模型凭据时，Worker 不可用——系统**如实降级**为「只准入与研判」。
 *
 * @module cli/super/super-cmd
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  allCategories,
  categoryLabel,
  createSoulEngine,
  memoryLabel,
  renderPlan,
  renderSoulPrompt,
  soulMemoryLocations,
  SuperAgentRuntime,
  superAgentSignature,
  type AcceptMode,
  type Decision,
  type EvalCandidate,
  type HistoricalDecision,
  type MemoryCategory,
  type Ticket,
  type TicketDetail,
} from "@vegamo/deepcode-core";
import { createSuperWorkerBridge } from "./super-worker.js";

// ============================================================================
// 类型
// ============================================================================

/** Super 子命令 */
export type SuperSubcommand =
  | "start"
  | "status"
  | "candidates"
  | "tickets"
  | "ticket"
  | "plan"
  | "inject"
  | "policy"
  | "memory"
  | "soul"
  | "help";

/** Super 子命令参数 */
export interface SuperCommandArgs {
  /** 子命令名 */
  readonly subcommand: SuperSubcommand;
  /** 项目根目录（默认 process.cwd()） */
  readonly projectRoot: string;
  /** 工单 ID（ticket 子命令） */
  readonly ticketId?: string;
  /** 事件正文（inject 子命令） */
  readonly text?: string;
  /** 事件发送者（inject 子命令，默认 local-developer） */
  readonly actor?: string;
  /** 事件是否显式寻址（inject 子命令，默认 false） */
  readonly addressed?: boolean;
  /** inject 时是否立即研判（默认 false——不触发模型调用，只排队） */
  readonly assess?: boolean;
  /** 新接单模式（policy 子命令） */
  readonly mode?: AcceptMode;
  /** 只跑一轮（start 子命令） */
  readonly once?: boolean;
  /** 启用本地文件监听（start 子命令，默认 true） */
  readonly watch?: boolean;
  /** 工单状态过滤（tickets 子命令） */
  readonly state?: "open" | "ended";
  /** 来源过滤（memory 子命令；缺省列出全部来源） */
  readonly source?: string;
  /** 条数上限（memory 子命令，默认 30） */
  readonly limit?: number;
  /** 要记住的一条事实（soul 子命令；省略则展示人格与记忆） */
  readonly remember?: string;
  /** 记忆分类（soul 子命令；省略则由文本推断） */
  readonly category?: string;
  /** 要遗忘的记忆 ID（soul 子命令） */
  readonly forget?: string;
  /** 整理记忆（soul 子命令） */
  readonly organize?: boolean;
  /** 是否显示凭证明文（soul 子命令，仅本机终端） */
  readonly revealSecrets?: boolean;
  /** 只打印注入模型的提示词（soul 子命令） */
  readonly promptOnly?: boolean;
  /** 输出格式 */
  readonly format?: "text" | "json";
}

/** 命令执行结果 */
export interface SuperCommandResult {
  /** 退出码：0=成功，1=运行失败，2=参数错误 */
  readonly exitCode: number;
  /** 标准输出 */
  readonly stdout: string;
  /** 标准错误 */
  readonly stderr: string;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 Super 子命令
 *
 * @param args 命令参数
 * @returns 执行结果
 */
export async function executeSuperCommand(args: SuperCommandArgs): Promise<SuperCommandResult> {
  try {
    switch (args.subcommand) {
      case "help":
        return { exitCode: 0, stdout: formatSuperHelp(), stderr: "" };
      case "start":
        return await runStart(args);
      case "status":
        return await runStatus(args);
      case "candidates":
        return await runCandidates(args);
      case "tickets":
        return await runTickets(args);
      case "ticket":
        return await runTicket(args);
      case "plan":
        return await runPlan(args);
      case "inject":
        return await runInject(args);
      case "policy":
        return await runPolicy(args);
      case "memory":
        return await runMemory(args);
      case "soul":
        return await runSoul(args);
      default:
        return { exitCode: 2, stdout: "", stderr: `未知的 super 子命令：${String(args.subcommand)}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `Super Agent 命令失败：${message}` };
  }
}

// ============================================================================
// 子命令实现
// ============================================================================

/** 启动 Super Agent */
async function runStart(args: SuperCommandArgs): Promise<SuperCommandResult> {
  ensureDatabaseDir(args.projectRoot);
  const databasePath = resolveDatabasePath(args.projectRoot);
  const bridge = createSuperWorkerBridge(args.projectRoot);
  const runtime = await SuperAgentRuntime.create({
    databasePath,
    projectRoot: args.projectRoot,
    launcher: bridge.llmAvailable ? bridge.launcher : null,
    injector: bridge.llmAvailable ? bridge.injector : null,
    sources: args.watch === false ? [] : [localWatcherSpec(args.projectRoot)],
  });
  bridge.bind(runtime);

  // 首次运行时写入默认的来源策略（cli / local-watcher）
  await ensureDefaultPolicy(runtime);

  const lines: string[] = [];
  lines.push(`${superAgentSignature()} 已启动（数据库：${databasePath}）`);
  lines.push(`接单模式：${runtime.status().acceptMode}`);
  lines.push(`事件源：${args.watch === false ? "（已关闭）" : "local-watcher（本地文件变更）"}`);
  lines.push(
    bridge.llmAvailable
      ? "Worker：可用（按计划分步派工，单轮 LLM 执行 + 结构化报告）"
      : `Worker：不可用——${bridge.unavailableReason}`
  );

  if (args.once === true) {
    // 单轮模式：跑一次调度（研判 + 副作用），然后退出
    await runtime.tick();
    const status = runtime.status();
    lines.push("");
    lines.push("单轮执行完成。");
    lines.push(`  工单：${status.totalTickets}（开放 ${status.openTickets}）`);
    lines.push(`  副作用积压：${formatPending(status.pendingEffects)}`);
    await runtime.stop();
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  await runtime.start();
  lines.push("按 Ctrl+C 退出。");
  process.stdout.write(`${lines.join("\n")}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  await runtime.stop();
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** 查看状态 */
async function runStatus(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const runtime = await openRuntime(args.projectRoot);
  try {
    const status = runtime.status();
    if (args.format === "json") {
      return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n`, stderr: "" };
    }
    const lines: string[] = [];
    lines.push(`${superAgentSignature()}`);
    lines.push(`  数据库：${status.databasePath}`);
    lines.push(`  接单模式：${status.acceptMode}（Policy v${status.policyVersion}）`);
    lines.push(`  工单：${status.totalTickets}（开放 ${status.openTickets}）`);
    lines.push(
      `  候选：待研判 ${status.candidates.pending}，今日新增 ${status.candidates.today}，累计 ${status.candidates.total}`
    );
    lines.push(`  待办（未决 Attention）：${status.openAttention}`);
    lines.push(`  订阅直通：${status.routedViaSubscription} 次（命中订阅工单，未经过 Router 决策）`);
    lines.push(
      `  累计 token（估算）：${status.workerTokens.total}（输入 ${status.workerTokens.input} / 输出 ${status.workerTokens.output}）`
    );
    lines.push(`  研判能力：${status.assessorAvailable ? "可用" : "不可用"}`);
    lines.push(`  计划能力：${status.plannerAvailable ? "可用（动态分解 + 组队）" : "不可用（按单步降级）"}`);
    lines.push(
      `  计划：${status.plans.total} 份（步骤 待派工 ${status.plans.pendingSteps} / 运行中 ${status.plans.runningSteps} / 已完成 ${status.plans.completedSteps} / 失败 ${status.plans.failedSteps}）`
    );
    lines.push(`  派工能力：${status.executorAvailable ? "可用" : "不可用"}`);
    lines.push(`  注入通道：${status.injectorAvailable ? "可用" : "不可用"}`);
    lines.push(
      `  人格与记忆：${
        status.soul === undefined
          ? "未装配"
          : `${status.soul.name}（记忆 ${status.soul.memories} 条，语气 ${status.soul.tone}）`
      }`
    );
    lines.push(`  事件源：${status.sources.length === 0 ? "（无）" : status.sources.map((s) => s.id).join("、")}`);
    lines.push(`  副作用积压：${formatPending(status.pendingEffects)}`);
    if (status.effectHealth.some((entry) => entry.consecutiveFailures > 0)) {
      lines.push("  副作用健康：");
      for (const entry of status.effectHealth) {
        if (entry.consecutiveFailures === 0) continue;
        lines.push(`    - ${entry.kind}：连续失败 ${entry.consecutiveFailures} 次（${entry.lastError ?? "未知原因"}）`);
      }
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/** 查看候选与决策 */
async function runCandidates(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const runtime = await openRuntime(args.projectRoot);
  try {
    const candidates = runtime.engine.router.listCandidates();
    const decisions = runtime.repos.listRecentDecisions(30);
    if (args.format === "json") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ candidates, decisions }, null, 2)}\n`,
        stderr: "",
      };
    }
    const lines: string[] = [];
    lines.push(`待研判候选（${candidates.length}）`);
    if (candidates.length === 0) {
      lines.push("  （无）");
    }
    for (const candidate of candidates) {
      lines.push(`  - 线程 ${candidate.threadId}（${candidate.triggers.length} 条事件）`);
      for (const trigger of candidate.triggers) {
        lines.push(`      [${trigger.actorKind}:${trigger.actor}] ${truncate(trigger.text, 80)}`);
      }
    }
    lines.push("");
    lines.push(`最近决策（${decisions.length}）`);
    if (decisions.length === 0) {
      lines.push("  （无）");
    }
    for (const decision of decisions) {
      lines.push(`  - ${formatDecision(decision)}`);
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/** 工单列表 */
async function runTickets(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const runtime = await openRuntime(args.projectRoot);
  try {
    const tickets = runtime.engine.people.listTickets(args.state);
    if (args.format === "json") {
      return { exitCode: 0, stdout: `${JSON.stringify(tickets, null, 2)}\n`, stderr: "" };
    }
    if (tickets.length === 0) {
      return { exitCode: 0, stdout: "（无工单）\n", stderr: "" };
    }
    const lines = tickets.map((ticket) => `  - ${formatTicketLine(ticket)}`);
    return { exitCode: 0, stdout: `工单（${tickets.length}）\n${lines.join("\n")}\n`, stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/** 工单详情 */
async function runTicket(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const ticketId = args.ticketId ?? "";
  if (ticketId.length === 0) {
    return { exitCode: 2, stdout: "", stderr: "ticket 子命令需要工单 ID（deepcode super ticket <id>）。" };
  }
  const runtime = await openRuntime(args.projectRoot);
  try {
    const detail = runtime.engine.people.getTicket(ticketId);
    if (args.format === "json") {
      return { exitCode: 0, stdout: `${JSON.stringify(detail, null, 2)}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: formatTicketDetail(detail), stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/**
 * 查看工单的执行计划（动态分解 / 工作流 / 组队）
 *
 * 这是「司南怎么想这件事」的唯一出口：目标、策略、步骤 DAG、团队分工、逐步进度。
 * 没有计划的工单（旧版单角色执行）如实说明，不伪造一份计划。
 *
 * @param args 命令参数
 * @returns 执行结果
 */
async function runPlan(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const ticketId = args.ticketId ?? "";
  if (ticketId.length === 0) {
    return { exitCode: 2, stdout: "", stderr: "plan 子命令需要工单 ID（deepcode super plan <id>）。" };
  }
  const runtime = await openRuntime(args.projectRoot);
  try {
    const detail = runtime.engine.people.getTicket(ticketId);
    if (args.format === "json") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ticketId, plan: detail.plan, steps: detail.planSteps }, null, 2)}\n`,
        stderr: "",
      };
    }
    const lines: string[] = [];
    lines.push(`${superAgentSignature()} · 工单计划`);
    lines.push(`工单：${ticketId}（${detail.ticket.execution.name}）`);
    lines.push("");
    if (detail.plan === null) {
      lines.push("该工单没有执行计划：按单角色执行（旧版语义，未做动态分解）。");
      lines.push("原因通常是：接单时未配置计划器，或计划层尚未上线时创建的历史工单。");
      return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    const states = new Map(detail.planSteps.map((step) => [step.stepId, step.state] as const));
    lines.push(renderPlan(detail.plan, states));
    lines.push("");
    lines.push("进度：");
    const done = detail.planSteps.filter((step) => step.state === "ready").length;
    lines.push(`  已完成 ${done}/${detail.planSteps.length} 步`);
    for (const step of detail.planSteps) {
      lines.push(
        `  - ${step.stepId} [${step.state}] 第 ${step.wave + 1} 波 / ${step.role}` +
          `${step.assignmentId === null ? "" : ` / 派工 ${step.assignmentId}`}` +
          `${step.summary === null ? "" : ` / ${truncate(step.summary, 60)}`}`
      );
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/** 投递事件 */
async function runInject(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const text = args.text ?? "";
  if (text.trim().length === 0) {
    return { exitCode: 2, stdout: "", stderr: "inject 子命令需要事件正文（deepcode super inject <文本>）。" };
  }
  const runtime = await openRuntime(args.projectRoot, args.assess === true);
  try {
    await ensureDefaultPolicy(runtime);
    const actor = args.actor ?? "local-developer";
    const result = runtime.injectTrigger(
      {
        sourceId: "cli",
        idempotencyKey: "",
        actor,
        actorKind: "human",
        addressed: args.addressed === true,
        text,
        meta: { scope: "cli" },
      },
      [`cli:${actor}`]
    );
    if (result.status === "duplicate") {
      return {
        exitCode: 0,
        stdout: `事件已存在（幂等命中）：${result.trigger.id}\n`,
        stderr: "",
      };
    }
    if (result.status === "filtered") {
      return { exitCode: 0, stdout: `事件未进入领域：${result.reason}\n`, stderr: "" };
    }
    // 事件入队后立即跑一轮调度，让用户立刻看到结果
    await runtime.tick();
    const candidates = runtime.engine.router.listCandidates();
    const tickets = runtime.engine.people.listTickets("open");
    const lines: string[] = [];
    lines.push(`事件已接收：${result.trigger.id}`);
    lines.push(`  待研判候选：${candidates.length}`);
    lines.push(`  开放工单：${tickets.length}`);
    if (tickets.length > 0) {
      lines.push(`  最新工单：${formatTicketLine(tickets[0])}`);
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/** 查看 / 设置策略 */
async function runPolicy(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const runtime = await openRuntime(args.projectRoot);
  try {
    if (args.mode === undefined) {
      const policy = runtime.engine.settings.getPolicy();
      if (args.format === "json") {
        return { exitCode: 0, stdout: `${JSON.stringify(policy, null, 2)}\n`, stderr: "" };
      }
      const lines: string[] = [];
      lines.push(`Super Agent 策略（v${policy.version}）`);
      lines.push(`  接单模式：${policy.acceptMode}`);
      lines.push(`  每日打扰上限：${policy.dailyAttentionBudget ?? "不限"}`);
      lines.push(`  规则（${policy.rules.length}）：`);
      for (const rule of policy.rules) {
        lines.push(`    - [${rule.enabled ? "启用" : "停用"}] ${rule.id}：${rule.title}`);
      }
      lines.push(`  来源策略（${Object.keys(policy.sourceParts).length}）：`);
      for (const part of Object.values(policy.sourceParts)) {
        lines.push(`    - ${part.sourceId}：名单 ${part.allowlist.join("、") || "（空）"}`);
      }
      return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }

    const current = runtime.engine.settings.getPolicy();
    runtime.engine.settings.setPolicy({ ...current, acceptMode: args.mode });
    const next = runtime.engine.settings.getPolicy();
    return {
      exitCode: 0,
      stdout: `接单模式已切换为 ${next.acceptMode}（Policy v${next.version}）\n`,
      stderr: "",
    };
  } finally {
    await runtime.stop();
  }
}

/**
 * 查看历史研判经验（全局层上下文）
 *
 * **只读**：历史经验是从既有 `decision` ⋈ `trigger` 表**派生**的视图，
 * 不是独立存储——这里没有任何写入动作。
 *
 * @param args 命令参数
 * @returns 执行结果
 */
async function runMemory(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const runtime = await openRuntime(args.projectRoot);
  try {
    const limit = args.limit ?? 30;
    const sources = args.source !== undefined ? [args.source] : listSourceIds(runtime);

    const entries: HistoricalDecision[] = [];
    for (const sourceId of sources) {
      entries.push(...runtime.repos.listHistoricalDecisions(sourceId, limit));
    }
    // 跨来源时按时间倒序，再截断到 limit
    entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const trimmed = entries.slice(0, limit);

    if (args.format === "json") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ sources, count: trimmed.length, entries: trimmed }, null, 2)}\n`,
        stderr: "",
      };
    }

    const lines: string[] = [];
    lines.push(`历史研判经验（${trimmed.length}）`);
    if (trimmed.length === 0) {
      lines.push("  （无——系统还没有做出过任何研判决策）");
    }
    for (const entry of trimmed) {
      const event = entry.trigger === null ? "（无关联事件）" : truncate(entry.trigger.text, 60);
      const marker = entry.wouldAccept ? "影子（本应接单）" : entry.kind;
      lines.push(`  - ${entry.at} [${marker}] ${event}`);
      lines.push(`      理由：${entry.reason}`);
      lines.push(`      来源：${entry.sourceId} · 线程：${entry.threadId}`);
    }
    lines.push("");
    lines.push("说明：历史经验由既有决策记录派生（只读），用于研判时的参考层。");
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } finally {
    await runtime.stop();
  }
}

/**
 * `super soul` —— 人格与分类记忆
 *
 * 四种动作，一个入口（避免把 soul 拆成四个子命令再各自维护帮助）：
 * - 无参数：展示人格 + 记忆分组 + 未记录类别 + 文件位置；
 * - `--remember "<事实>"`：记一条（分类可显式给，省略则由文本推断）；
 * - `--organize`：去重合并 + 陈旧衰减 + 休眠清理；
 * - `--prompt`：打印**实际注入模型**的那段提示词（可观测，不是「应该是这样」）。
 *
 * 凭证默认遮蔽：`--reveal-secrets` 才显示明文，且仅在终端——不进提示词、
 * 不进日志（原因见 `soul/render.ts` 头部）。
 *
 * @param args 命令参数
 * @returns 执行结果
 */
async function runSoul(args: SuperCommandArgs): Promise<SuperCommandResult> {
  const { engine } = createSoulEngine({ projectRoot: args.projectRoot });
  const locations = soulMemoryLocations(args.projectRoot);
  const lines: string[] = [];

  // 1) 记一条
  if (args.remember !== undefined && args.remember.trim().length > 0) {
    const category = parseMemoryCategory(args.category);
    const result = engine.remember({ text: args.remember.trim(), category });
    const action = result.action === "created" ? "已记住" : "已更新";
    lines.push(
      `${action}：${result.memory.title}（分类 ${result.memory.category}，置信 ${(result.confidence * 100).toFixed(0)}%）`
    );
    if (result.fallback) {
      lines.push("  提示：未匹配到关键词，按「协作偏好」记录；可用 --category 指定分类。");
    } else if (result.matched.length > 0) {
      lines.push(`  依据：命中 ${result.matched.join("、")}`);
    }
    if (result.secret) {
      lines.push("  该分类为凭证：值不会进入模型提示词，只保留「已记录」与键名。");
    }
    lines.push("");
  }

  // 2) 忘一条
  if (args.forget !== undefined && args.forget.length > 0) {
    const removed = engine.forget(args.forget);
    lines.push(removed ? `已遗忘：${args.forget}` : `未找到该记忆：${args.forget}`);
    lines.push("");
  }

  // 3) 整理
  if (args.organize === true) {
    const report = engine.organize();
    lines.push(`整理完成：合并 ${report.merged} 条，清理 ${report.pruned} 条，现存 ${report.total} 条`);
    for (const note of report.notes) lines.push(`  - ${note}`);
    lines.push("");
  }

  const soul = engine.soul();
  const revealSecrets = args.revealSecrets === true;

  // 4) 只打印提示词
  if (args.promptOnly === true) {
    return { exitCode: 0, stdout: `${renderSoulPrompt(soul, { revealSecrets })}\n`, stderr: "" };
  }

  const snapshot = engine.snapshot({ revealSecrets });

  if (args.format === "json") {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ snapshot, locations }, null, 2)}\n`,
      stderr: "",
    };
  }

  if (lines.length === 0) lines.push(superAgentSignature());
  lines.push(`本质：${snapshot.nature}`);
  lines.push(`模式：${snapshot.modeLabel}${snapshot.mode === "companion" ? "（先接住人，再谈事）" : ""}`);
  lines.push(`语气：${snapshot.emotion.label}（强度 ${(snapshot.emotion.intensity * 100).toFixed(0)}%）`);
  lines.push(
    `记忆：${snapshot.memoryStats.total} 条${
      snapshot.memoryStats.total > 0
        ? `（${snapshot.memoryGroups.map((group) => `${group.label} ${group.items.length}`).join(" / ")}）`
        : ""
    }`
  );
  if (snapshot.memoryStats.missing.length > 0) {
    lines.push(`尚未记录：${snapshot.memoryStats.missing.map((category) => categoryLabel(category)).join("、")}`);
  }
  lines.push("");

  if (snapshot.memoryGroups.length === 0) {
    lines.push('尚无记忆。用 --remember "<事实>" 记下项目地址、部署方式、代码规范等；');
    lines.push("记一次之后，规划器与 Worker 都不必再问。");
  } else {
    for (const group of snapshot.memoryGroups) {
      lines.push(`${group.label}（${group.items.length}）`);
      for (const item of group.items) {
        const strength = `${(item.strength * 100).toFixed(0)}%`;
        lines.push(`  - [${strength}] ${memoryLabel(item)}`);
      }
    }
  }

  lines.push("");
  lines.push(`文件：${locations.global}`);
  if (locations.project !== undefined) lines.push(`      ${locations.project}`);
  lines.push("提示：--organize 整理记忆；--prompt 查看注入模型的提示词。");

  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

/**
 * 校验并转换记忆分类
 *
 * @param raw 用户输入
 * @returns 分类；非法或未给出返回 undefined（交给分类器推断）
 */
function parseMemoryCategory(raw: string | undefined): MemoryCategory | undefined {
  if (raw === undefined) return undefined;
  const categories = allCategories();
  return categories.includes(raw as MemoryCategory) ? (raw as MemoryCategory) : undefined;
}

/**
 * 列出库中出现过的全部 Source ID
 *
 * @param runtime 运行时
 * @returns Source ID 列表（去重、升序）
 */
function listSourceIds(runtime: SuperAgentRuntime): string[] {
  const ids = new Set<string>();
  for (const thread of runtime.repos.listAllThreads()) {
    if (thread.sourceId.length > 0) ids.add(thread.sourceId);
  }
  return [...ids].sort();
}

// ============================================================================
// 辅助
// ============================================================================
/**
 * 打开一个运行时
 *
 * @param projectRoot 项目根目录
 * @param assess 是否装配真实研判器（true = 会调用用户配置的模型；false = 只排队不研判）
 * @returns 运行时
 */
async function openRuntime(projectRoot: string, assess = false): Promise<SuperAgentRuntime> {
  ensureDatabaseDir(projectRoot);
  return SuperAgentRuntime.create({
    databasePath: resolveDatabasePath(projectRoot),
    projectRoot,
    // undefined → 运行时装配默认的 LlmAssessor；null → 无研判能力（不调模型）
    assessor: assess ? undefined : null,
    launcher: null,
    injector: null,
  });
}

/** 数据库文件路径 */
export function resolveDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, ".deepcode", "super-agent", "super-agent.db");
}

/** 本地监听 Source 声明 */
function localWatcherSpec(projectRoot: string): {
  kindId: string;
  sourceId: string;
  config: Record<string, unknown>;
} {
  return {
    kindId: "local-watcher",
    sourceId: "local-watcher",
    config: { root: projectRoot },
  };
}

/**
 * 首次运行时写入默认的来源策略
 *
 * 两个来源各有默认准入表：
 * - `cli`：CLI 注入的事件（发送者默认 local-developer 在名单内）
 * - `local-watcher`：本地文件变更（`file-change` → 推断候选）
 *
 * 幂等：已存在的来源策略不会被覆盖（避免每次启动都抬版本号）。
 */
async function ensureDefaultPolicy(runtime: SuperAgentRuntime): Promise<void> {
  const policy = runtime.engine.settings.getPolicy();
  const sourceParts = { ...policy.sourceParts };
  let changed = false;

  if (sourceParts["cli"] === undefined) {
    sourceParts["cli"] = {
      sourceId: "cli",
      allowlist: ["local-developer"],
      botList: [],
      admission: { cli: "inferred" },
    };
    changed = true;
  }
  if (sourceParts["local-watcher"] === undefined) {
    sourceParts["local-watcher"] = {
      sourceId: "local-watcher",
      allowlist: ["local-developer"],
      botList: [],
      admission: { "file-change": "inferred" },
    };
    changed = true;
  }
  if (!changed) return;
  runtime.engine.settings.setPolicy({ ...policy, sourceParts });
}

/** 格式化副作用积压 */
function formatPending(pending: Readonly<Record<string, number>>): string {
  const entries = Object.entries(pending);
  if (entries.length === 0) return "（无）";
  return entries.map(([kind, count]) => `${kind}=${count}`).join("，");
}

/** 格式化一条决策 */
function formatDecision(decision: Decision): string {
  const marker = decision.wouldAccept ? "影子（本应接单）" : decision.kind;
  return `${decision.at} [${marker}] ${decision.reason}`;
}

/** 格式化工单一行摘要 */
function formatTicketLine(ticket: Ticket): string {
  const report = ticket.latestReport?.kind ?? "未回报";
  return `${ticket.id} [${ticket.state}] ${ticket.execution.name}（角色 ${ticket.execution.role}，报告 ${report}）`;
}

/** 格式化工单详情 */
function formatTicketDetail(detail: TicketDetail): string {
  const { ticket } = detail;
  const lines: string[] = [];
  lines.push(`工单 ${ticket.id}`);
  lines.push(`  状态：${ticket.state}${ticket.endedReason === null ? "" : `（${ticket.endedReason}）`}`);
  lines.push(`  名称：${ticket.execution.name}`);
  lines.push(`  角色：${ticket.execution.role}`);
  lines.push(`  授权强度：${ticket.mandate.strength}`);
  lines.push(`  授权范围：${ticket.mandate.scope || "（未指定）"}`);
  lines.push(`  匹配规则：${ticket.mandate.matchedRules.join("、") || "（无）"}`);
  lines.push(`  发起者：${ticket.mandate.actor}（来源 ${ticket.mandate.sourceId || "未知"}）`);
  if (detail.plan === null) {
    lines.push("  执行计划：（无——单角色执行）");
  } else {
    const done = detail.planSteps.filter((step) => step.state === "ready").length;
    lines.push(
      `  执行计划：${detail.plan.steps.length} 步 / 团队 ${detail.plan.team.length} 角色（来源 ${detail.plan.source}，已完成 ${done} 步）`
    );
    lines.push(`    目标：${detail.plan.objective}`);
    for (const step of detail.planSteps) {
      lines.push(`    - ${step.stepId} [${step.state}] 第 ${step.wave + 1} 波 · ${step.role}`);
    }
  }
  lines.push(`  派工（${detail.assignments.length}）：`);
  for (const assignment of detail.assignments) {
    lines.push(`    - ${assignment.id} [${assignment.state}] 会话 ${assignment.workerSessionId ?? "未启动"}`);
  }
  lines.push(`  输入（${detail.inputs.length}）：`);
  for (const input of detail.inputs) {
    lines.push(
      `    - [${input.kind}] ${truncate(input.body, 100)}（${input.deliveredAt === null ? "待投递" : "已投递"}）`
    );
  }
  lines.push(`  消息（${detail.messages.length}）：`);
  for (const message of detail.messages) {
    lines.push(`    - [${message.direction}/${message.state}] ${truncate(message.body, 100)}`);
  }
  lines.push(`  待办问题（${detail.attention.length}）：`);
  if (detail.attention.length === 0) {
    lines.push("    （无）");
  }
  for (const attention of detail.attention) {
    lines.push(
      `    - ${attention.question}（${attention.blocking ? "阻塞" : "非阻塞"}${attention.resolvedAt === null ? "，未解决" : "，已解决"}）`
    );
  }
  return `${lines.join("\n")}\n`;
}

/** 截断长文本 */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/** 确保数据库目录存在 */
export function ensureDatabaseDir(projectRoot: string): string {
  const dir = path.join(projectRoot, ".deepcode", "super-agent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 格式化帮助文本
 *
 * @returns 帮助文本
 */
export function formatSuperHelp(): string {
  return [
    `deepcode super —— ${superAgentSignature()}`,
    "事件 → 决策 → 动态分解 → 组队 → 分波次执行 → 报告",
    "",
    "用法：",
    "  deepcode super start [--once] [--no-watch]   启动（常驻模式）",
    "  deepcode super status [--format json]       查看运行时状态（含计划与步骤进度）",
    "  deepcode super candidates                   查看候选与最近决策",
    "  deepcode super tickets [--state open|ended] 查看工单列表",
    "  deepcode super ticket <id>                  查看工单详情",
    "  deepcode super plan <id>                    查看工单的执行计划与团队分工",
    "  deepcode super inject <文本> [--addressed] [--assess]  投递一个事件",
    "  deepcode super policy [--mode off|observe|auto]  查看/切换策略",
    "  deepcode super memory [--source <id>] [--limit N]  列出历史研判经验",
    "  deepcode super soul                         查看人格与分类记忆",
    '  deepcode super soul --remember "<事实>" [--category deploy]  记一条',
    "  deepcode super soul --organize              整理记忆（去重 / 衰减 / 清理）",
    "  deepcode super soul --prompt                打印注入模型的提示词",
    "  deepcode super help                         显示本帮助",
    "",
    "说明：",
    '  - 默认接单模式为 observe：推断型候选只记影子（"本应接单"），不真的建工单。',
    "  - 显式请求（inject --addressed）在任何模式下都真的接单。",
    "  - 接单后由「司南」动态分解出计划（目标 / 步骤 / 角色），并按波次派工；",
    "    无模型凭据时降级为单步计划，行为与旧版一致（super plan 会写明降级原因）。",
    "  - inject 默认只排队不研判（不调模型）；加 --assess 才会立即研判。",
    "  - memory 展示的历史经验由既有决策记录派生（只读），不是独立存储。",
    "  - soul 是「司南」的人格与长期记忆：项目地址 / 部署位置与形式 / 凭证 / 代码规范等",
    "    记一次就够，规划器与 Worker 都会带上；凭证默认遮蔽，不进提示词。",
  ].join("\n");
}

/** 候选类型（供类型检查引用） */
export type { EvalCandidate };
