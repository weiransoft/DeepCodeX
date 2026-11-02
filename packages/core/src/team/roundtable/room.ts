/**
 * Roundtable 编排器：讨论 → 判定 → 分工 → 自更新 → 执行 → 疑问回流
 *
 * 设计文档：`docs/team-roundtable-design-20261102.md`
 *
 * 编排原则：
 * 1. **规则判共识，主持人只起草**——主持人的输出不参与"是否达成共识"的判定；
 * 2. **轮内并行、轮间串行**——保证 N 倍延迟不叠加，同时让角色有机会回应上轮分歧；
 * 3. **失败如实上报**——发言失败、解析失败、执行失败都进报告，不静默降级成"成功"；
 * 4. **越界即止**——回流次数、轮次、工具轮次全部有硬上限，不靠模型自觉收敛。
 *
 * @module team/roundtable/room
 */

import crypto from "node:crypto";
import { buildTask, executeDispatch } from "../team-adapter.js";
import { callLlmOnce, resolveLlmHandle } from "../orchestrator/llm-once.js";
import type { DispatchResult, RoleDefinition } from "../types.js";
import { judgeConsensus, describeVerdict } from "./consensus.js";
import {
  buildAmendmentPrompt,
  buildExecutionDescription,
  buildModeratorDecisionPrompt,
  buildModeratorFocusPrompt,
  buildSpeechSystemPrompt,
  buildSpeechUserPrompt,
  buildTaskUpdatePrompt,
  formatTranscript,
  parseAmendment,
  parseDecision,
  parseExecutionQuestions,
  parseFocus,
  parseSpeech,
  parseTaskUpdate,
} from "./protocol.js";
import type {
  RoundtableAmendment,
  RoundtableAssignment,
  RoundtableDecision,
  RoundtableExecution,
  RoundtableMessage,
  RoundtableMessageKind,
  RoundtableOptions,
  RoundtableResult,
  RoundtableSpeech,
  RoundtableStatus,
  RoundtableTaskUpdate,
  RoundtableVerdict,
} from "./types.js";

/** 默认讨论轮次（3 轮还不收敛，通常是需求本身模糊，加轮次只是烧钱） */
const DEFAULT_MAX_ROUNDS = 3;
/** 默认回流次数（第二轮边际收益远低于成本，更多应回到人） */
const DEFAULT_MAX_ESCALATIONS = 1;
/** 默认单次发言超时 */
const DEFAULT_SPEAK_TIMEOUT_MS = 120_000;
/** 默认工具轮次上限（与 dispatch 默认一致） */
const DEFAULT_MAX_TOOL_ROUNDS = 8;
/** 参与回流讨论的角色数上限（防止 prompt 膨胀） */
const MAX_ESCALATION_PARTICIPANTS = 5;

/** 房间内的角色池：参与者 + 主持人（dispatch 的 candidates 必须含全部，否则 forceRole 会抛错） */
function roomRoles(options: RoundtableOptions): RoleDefinition[] {
  const byId = new Map<string, RoleDefinition>();
  byId.set(options.moderator.roleId, options.moderator);
  for (const role of options.participants) byId.set(role.roleId, role);
  return [...byId.values()];
}

/** 消息 id 生成器（`m1`、`m2`…，供角色 replyTo 引用） */
function createIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `m${counter}`;
  };
}

/**
 * 执行一次 roundtable
 *
 * @param options 编排选项
 * @returns 全量结果（含 transcript、决议、执行报告、修订）
 */
export async function runRoundtable(options: RoundtableOptions): Promise<RoundtableResult> {
  const startedAt = Date.now();
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxEscalations = options.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  const speakTimeoutMs = options.speakTimeoutMs ?? DEFAULT_SPEAK_TIMEOUT_MS;
  const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const roles = roomRoles(options);
  const participantIds = options.participants.map((role) => role.roleId);
  const allowedRoleIds = new Set(roles.map((role) => role.roleId));

  const messages: RoundtableMessage[] = [];
  const nextId = createIdGenerator();

  const push = (
    round: number,
    kind: RoundtableMessageKind,
    roleId: string,
    roleName: string,
    content: string,
    extra?: { posture?: RoundtableSpeech["posture"]; blocking?: boolean; replyTo?: string }
  ): RoundtableMessage => {
    const message: RoundtableMessage = {
      id: nextId(),
      round,
      kind,
      roleId,
      roleName,
      content,
      createdAt: new Date().toISOString(),
      ...(extra?.posture !== undefined ? { posture: extra.posture } : {}),
      ...(extra?.blocking !== undefined ? { blocking: extra.blocking } : {}),
      ...(extra?.replyTo !== undefined ? { replyTo: extra.replyTo } : {}),
    };
    messages.push(message);
    options.onMessage?.(message);
    return message;
  };

  // ---- 前置：模型凭据 ----
  const handle = resolveLlmHandle(options.projectRoot, options.injectedClient);
  if (!handle) {
    return {
      status: "skipped",
      decision: null,
      executions: [],
      amendments: [],
      messages,
      rounds: 0,
      escalations: 0,
      durationMs: Date.now() - startedAt,
      unparsedSpeeches: 0,
      note: "缺少模型凭据（API Key），未执行群聊协商",
    };
  }

  push(
    0,
    "opening",
    options.moderator.roleId,
    options.moderator.name,
    `会议目标：${options.task}\n参与者：${options.participants.map((r) => `${r.name}(${r.roleId})`).join("、")}\n` +
      `规则：${maxRounds} 轮内达成共识，达成后按分工各自执行；执行中的疑问可以回流讨论 ${maxEscalations} 次。`
  );
  options.onProgress?.(`Roundtable 开始：${options.participants.length} 角色，最多 ${maxRounds} 轮`);

  // ---- 讨论轮 ----
  let round = 0;
  let previousSpeeches: RoundtableSpeech[] = [];
  let verdict: RoundtableVerdict | null = null;
  let focus = "";
  let focusQuestions: string[] = [];
  let unparsedSpeeches = 0;

  /** 单角色发言（失败不抛，转成带 error 的 speech） */
  const speak = async (role: RoleDefinition, currentRound: number, transcript: string): Promise<RoundtableSpeech> => {
    if (options.signal?.aborted) {
      return {
        roleId: role.roleId,
        roleName: role.name,
        posture: "refine",
        blocking: false,
        keyPoints: [],
        questions: [],
        content: "",
        error: "已中止",
      };
    }
    const system = buildSpeechSystemPrompt(role, options.projectRoot);
    const user = buildSpeechUserPrompt({ task: options.task, transcript, round: currentRound, focus });
    const result = await callLlmOnce(handle, system, user, speakTimeoutMs);
    if (!result.ok) {
      return {
        roleId: role.roleId,
        roleName: role.name,
        posture: "refine",
        blocking: false,
        keyPoints: [],
        questions: [],
        content: "",
        error: result.message,
      };
    }
    const speech = parseSpeech(result.content, role.roleId, role.name);
    if (speech.unparsed) unparsedSpeeches += 1;
    return speech;
  };

  while (round < maxRounds) {
    if (options.signal?.aborted) break;
    round += 1;
    options.onProgress?.(`第 ${round}/${maxRounds} 轮讨论…`);

    // transcript 快照在轮开始时固定：轮内并行，各自看到同一份历史（设计文档第八节）
    const transcript = formatTranscript(messages);
    const speeches = await Promise.all(options.participants.map((role) => speak(role, round, transcript)));

    for (const speech of speeches) {
      if (speech.error !== undefined) {
        push(round, "note", speech.roleId, speech.roleName, `（本轮发言失败：${speech.error}）`);
        continue;
      }
      push(round, "speech", speech.roleId, speech.roleName, speech.content, {
        posture: speech.posture,
        blocking: speech.blocking,
        ...(speech.replyTo !== undefined ? { replyTo: speech.replyTo } : {}),
      });
    }

    verdict = judgeConsensus(speeches, previousSpeeches, participantIds);
    options.onProgress?.(
      `第 ${round} 轮判定：${verdict.kind}（覆盖 ${(verdict.coverage * 100).toFixed(0)}%，阻断 ${verdict.blocking.length}，反对 ${verdict.dissent.length}）`
    );

    if (verdict.kind === "consensus") break;

    // 最后一轮不再打听下一轮议程（省一次调用，也避免给出"还会继续"的错觉）
    if (round >= maxRounds) {
      previousSpeeches = speeches;
      break;
    }

    const focusResult = await callLlmOnce(
      handle,
      buildSpeechSystemPrompt(options.moderator, options.projectRoot),
      buildModeratorFocusPrompt({
        task: options.task,
        transcript: formatTranscript(messages),
        round,
        verdictSummary: describeVerdict(verdict, speeches),
      }),
      speakTimeoutMs
    );
    if (focusResult.ok) {
      const parsedFocus = parseFocus(focusResult.content);
      // 解析失败时用原文兜底：主持人可能写了人话，直接当议程贴出去也比丢掉强
      focusQuestions = parsedFocus?.openQuestions ?? [];
      focus =
        parsedFocus === null
          ? focusResult.content.slice(0, 800)
          : focusQuestions.length > 0
            ? `${parsedFocus.focus}\n\n未决问题：\n${focusQuestions.map((q) => `- ${q}`).join("\n")}`
            : parsedFocus.focus;
      push(round, "focus", options.moderator.roleId, options.moderator.name, focus);
    } else {
      // 主持人推进失败：用规则统计兜底，讨论继续（不能让一次失败打断整个会议）
      focus = describeVerdict(verdict, speeches);
      push(
        round,
        "note",
        options.moderator.roleId,
        options.moderator.name,
        `（议程推进失败：${focusResult.message}，改用立场统计）`
      );
    }
    previousSpeeches = speeches;
  }

  const rounds = round;

  // ---- 未达成共识：如实报告，不假装 ----
  if (verdict === null || verdict.kind !== "consensus") {
    const degraded = (verdict?.coverage ?? 0) < 0.5;
    const note = degraded
      ? `有效发言覆盖率仅 ${((verdict?.coverage ?? 0) * 100).toFixed(0)}%，无法判定共识`
      : buildUnresolvedNote(verdict, maxRounds);
    return {
      status: degraded ? "degraded" : "unresolved",
      decision: null,
      executions: [],
      amendments: [],
      messages,
      rounds,
      escalations: 0,
      durationMs: Date.now() - startedAt,
      unparsedSpeeches,
      note,
    };
  }

  // ---- 起草决议与分工 ----
  options.onProgress?.("已达成共识，起草决议与任务分工…");
  const decisionResult = await callLlmOnce(
    handle,
    buildSpeechSystemPrompt(options.moderator, options.projectRoot),
    buildModeratorDecisionPrompt({
      task: options.task,
      transcript: formatTranscript(messages),
      participantIds,
    }),
    speakTimeoutMs
  );

  const parsedDecision = decisionResult.ok ? parseDecision(decisionResult.content, allowedRoleIds) : null;
  if (!parsedDecision || parsedDecision.assignments.length === 0) {
    const note = !decisionResult.ok
      ? `决议起草失败：${decisionResult.message}`
      : "决议起草未产出有效分工（模型输出无法解析或未给任何角色派活），已跳过执行";
    push(round, "note", options.moderator.roleId, options.moderator.name, `（${note}）`);
    return {
      status: "degraded",
      decision: null,
      executions: [],
      amendments: [],
      messages,
      rounds,
      escalations: 0,
      durationMs: Date.now() - startedAt,
      unparsedSpeeches,
      note,
    };
  }

  const roleNameById = new Map(roles.map((role) => [role.roleId, role.name]));
  const assignments: RoundtableAssignment[] = parsedDecision.assignments.map((item) => ({
    ...item,
    roleName: roleNameById.get(item.roleId) ?? item.roleId,
  }));
  const decision: RoundtableDecision = {
    round,
    summary: parsedDecision.summary,
    decisions: parsedDecision.decisions,
    openQuestions: parsedDecision.openQuestions,
    assignments,
  };

  push(round, "decision", options.moderator.roleId, options.moderator.name, decision.summary);
  for (const item of assignments) {
    push(
      round,
      "assignment",
      options.moderator.roleId,
      options.moderator.name,
      `${item.roleId}：${item.deliverable}（范围：${item.scope}；验收：${item.acceptance}` +
        `${item.dependsOn.length > 0 ? `；依赖：${item.dependsOn.join("、")}` : ""}）`
    );
  }

  // ---- 各角色更新自己的任务 ----
  options.onProgress?.("各角色确认自己的任务…");
  const roleById = new Map(roles.map((role) => [role.roleId, role]));
  const selfUpdates = new Map<string, RoundtableTaskUpdate>();
  const preExecutionQuestions: Array<{ roleId: string; question: string }> = [];

  await Promise.all(
    assignments.map(async (assignment) => {
      const role = roleById.get(assignment.roleId);
      if (!role) return;
      const updateResult = await callLlmOnce(
        handle,
        buildSpeechSystemPrompt(role, options.projectRoot, assignment),
        buildTaskUpdatePrompt({
          task: options.task,
          decisionSummary: decision.summary,
          assignment,
          allAssignments: assignments,
        }),
        speakTimeoutMs
      );
      const parsed = updateResult.ok ? parseTaskUpdate(updateResult.content) : null;
      const update: RoundtableTaskUpdate = parsed ?? {
        restated: assignment.deliverable,
        steps: [],
        acceptance: assignment.acceptance,
        needDiscussion: false,
        question: "",
      };
      if (parsed === null) {
        push(
          0,
          "note",
          role.roleId,
          role.name,
          `（任务确认未按约定格式输出，已用分工原文兜底${updateResult.ok ? "" : `：${updateResult.message}`}）`
        );
      }
      selfUpdates.set(role.roleId, update);
      push(
        round,
        "task-update",
        role.roleId,
        role.name,
        `${update.restated}${update.steps.length > 0 ? `\n步骤：${update.steps.join(" → ")}` : ""}`
      );
      if (update.needDiscussion && update.question !== "") {
        preExecutionQuestions.push({ roleId: role.roleId, question: update.question });
      }
    })
  );

  // ---- 疑问回流 + 执行 ----
  const amendments: RoundtableAmendment[] = [];
  const amendmentsByRole = new Map<string, RoundtableAmendment[]>();
  let escalations = 0;

  const escalate = async (askers: Array<{ roleId: string; question: string }>): Promise<RoundtableAmendment | null> => {
    if (askers.length === 0) return null;
    if (escalations >= maxEscalations) return null;
    escalations += 1;

    const askerIds = [...new Set(askers.map((item) => item.roleId))];
    const questionText = askers.map((item) => `[${item.roleId}] ${item.question}`).join("\n");
    // 相关角色：提问者 + 其分工依赖的角色 + 主持人（上限 5，防 prompt 膨胀）
    const related = new Set<string>([options.moderator.roleId, ...askerIds]);
    for (const id of askerIds) {
      const assignment = assignments.find((item) => item.roleId === id);
      for (const dep of assignment?.dependsOn ?? []) related.add(dep);
    }
    const escalationParticipants = [...related].slice(0, MAX_ESCALATION_PARTICIPANTS);

    options.onProgress?.(`疑问回流（第 ${escalations}/${maxEscalations} 次）：${askerIds.join("、")}`);
    const result = await callLlmOnce(
      handle,
      buildSpeechSystemPrompt(options.moderator, options.projectRoot),
      buildAmendmentPrompt({
        task: options.task,
        decisionSummary: decision.summary,
        question: questionText,
        askerRoleId: askerIds.join("、"),
        executionSummary: askers.map((item) => item.question).join("；"),
        participantIds: escalationParticipants,
      }),
      speakTimeoutMs
    );
    const parsed = result.ok ? parseAmendment(result.content, allowedRoleIds) : null;
    if (!parsed) {
      push(
        round,
        "note",
        options.moderator.roleId,
        options.moderator.name,
        `（回流未能产出修订${result.ok ? "：输出无法解析" : `：${result.message}`}）`
      );
      return null;
    }

    const amendment: RoundtableAmendment = {
      id: `a${amendments.length + 1}`,
      triggeredBy: askerIds,
      question: questionText,
      change: parsed.change,
      affectedRoles: parsed.affectedRoles.length > 0 ? parsed.affectedRoles : askerIds,
      createdAt: new Date().toISOString(),
    };
    amendments.push(amendment);
    for (const roleId of amendment.affectedRoles) {
      const list = amendmentsByRole.get(roleId) ?? [];
      list.push(amendment);
      amendmentsByRole.set(roleId, list);
    }
    push(
      round,
      "amendment",
      options.moderator.roleId,
      options.moderator.name,
      `问题：${questionText}\n修订：${amendment.change}\n影响：${amendment.affectedRoles.join("、")}`
    );
    return amendment;
  };

  const executions = new Map<string, RoundtableExecution>();

  const executeAssignment = async (assignment: RoundtableAssignment): Promise<void> => {
    if (options.signal?.aborted) {
      executions.set(assignment.roleId, {
        roleId: assignment.roleId,
        roleName: assignment.roleName,
        status: "aborted",
        summary: "",
        filesTouched: [],
        questions: [],
        deniedTools: [],
        mode: options.runner ? "tool" : "text",
        error: "已中止",
      });
      return;
    }

    const update = selfUpdates.get(assignment.roleId) ?? {
      restated: assignment.deliverable,
      steps: [],
      acceptance: assignment.acceptance,
      needDiscussion: false,
      question: "",
    };
    const task = buildTask({
      title: `【群聊执行】${assignment.roleName}：${assignment.deliverable}`,
      description: buildExecutionDescription({
        task: options.task,
        decisionSummary: decision.summary,
        decisions: decision.decisions,
        assignment,
        selfUpdate: update,
        amendments: (amendmentsByRole.get(assignment.roleId) ?? []).map((item) => ({
          question: item.question,
          change: item.change,
        })),
      }),
    });

    const dispatchResult: DispatchResult = await executeDispatch(task, {
      projectRoot: options.projectRoot,
      forceRole: { roleId: assignment.roleId, reason: "roundtable 分工执行" },
      candidates: roles,
      maxToolRounds,
      ...(options.runner !== undefined ? { runner: options.runner } : {}),
      ...(options.injectedClient !== undefined ? { injectedClient: options.injectedClient } : {}),
    });

    const output = dispatchResult.output ?? "";
    const questions = parseExecutionQuestions(output);
    const status: RoundtableExecution["status"] =
      dispatchResult.status === "succeeded" ? "completed" : dispatchResult.status === "skipped" ? "skipped" : "failed";
    const report: RoundtableExecution = {
      roleId: assignment.roleId,
      roleName: assignment.roleName,
      status,
      summary: extractSummary(output),
      filesTouched: [],
      questions,
      deniedTools: [],
      mode: options.runner !== undefined ? "tool" : "text",
      ...(dispatchResult.error !== undefined ? { error: dispatchResult.error } : {}),
    };
    executions.set(assignment.roleId, report);
    push(
      round,
      "execution",
      assignment.roleId,
      assignment.roleName,
      `[${report.status}] ${report.summary}${report.error ? `（${report.error}）` : ""}${
        questions.length > 0 ? `\n待澄清：${questions.join("；")}` : ""
      }`
    );
  };

  // 执行前的问题先回流：还没开工就发现共识有洞，比执行到一半再回流便宜得多
  if (preExecutionQuestions.length > 0) {
    await escalate(preExecutionQuestions);
  }

  // 按 dependsOn 分层执行：层内并行，层间等待（硬依赖不能靠并行"赌它对"）
  const layers = layerAssignments(assignments);
  for (const layer of layers) {
    await Promise.all(layer.map((assignment) => executeAssignment(assignment)));
  }

  // 执行后的问题再回流一次，并重跑受影响角色
  const postQuestions = [...executions.values()]
    .filter((report) => report.questions.length > 0)
    .flatMap((report) => report.questions.map((question) => ({ roleId: report.roleId, question })));
  if (postQuestions.length > 0) {
    const amendment = await escalate(postQuestions);
    if (amendment && amendment.affectedRoles.length > 0) {
      options.onProgress?.(`按修订重跑：${amendment.affectedRoles.join("、")}`);
      const rerun = assignments.filter((item) => amendment.affectedRoles.includes(item.roleId));
      for (const assignment of rerun) {
        await executeAssignment(assignment);
      }
    }
  }

  // ---- 终态 ----
  const executionList = [...executions.values()];
  const failedCount = executionList.filter((item) => item.status === "failed").length;
  const coverage = verdict.coverage;
  const status: RoundtableStatus = coverage < 0.5 ? "degraded" : failedCount > 0 ? "degraded" : "consensus";

  const notes: string[] = [];
  if (coverage < 0.5) notes.push(`有效发言覆盖率仅 ${(coverage * 100).toFixed(0)}%`);
  if (failedCount > 0) notes.push(`${failedCount} 个角色执行失败`);
  if (unparsedSpeeches > 0) notes.push(`${unparsedSpeeches} 条发言未按约定格式输出`);
  if (options.runner === undefined) notes.push("未注入工具执行器，执行阶段仅产出文本建议（未改动文件）");
  if (executionList.some((item) => item.deniedTools.length > 0)) notes.push("部分工具因后台无人审批被自动拒绝");
  if (postQuestions.length > 0 && amendments.length === 0) notes.push("执行中的疑问未能通过回流解决，需人工决定");

  return {
    status,
    decision,
    executions: executionList,
    amendments,
    messages,
    rounds,
    escalations,
    durationMs: Date.now() - startedAt,
    unparsedSpeeches,
    ...(notes.length > 0 ? { note: notes.join("；") } : {}),
  };
}

/**
 * 按 dependsOn 把分工分层（Kahn）
 *
 * 依赖关系是**执行顺序**而不是建议：architect 没定规则，coder 并行写出来的东西必然要返工。
 * 存在环时退化为单层并行（并在 note 中说明），避免死锁。
 *
 * @param assignments 全部分工
 * @returns 分层结果（层内可并行）
 */
function layerAssignments(assignments: ReadonlyArray<RoundtableAssignment>): RoundtableAssignment[][] {
  const byId = new Map(assignments.map((item) => [item.roleId, item]));
  const remaining = new Set(assignments.map((item) => item.roleId));
  const layers: RoundtableAssignment[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const assignment = byId.get(id)!;
      return assignment.dependsOn.every((dep) => !remaining.has(dep));
    });
    // 环：没有任何节点就绪 → 全部并到最后一层
    const layerIds = ready.length > 0 ? ready : [...remaining];
    layers.push(layerIds.map((id) => byId.get(id)!));
    for (const id of layerIds) remaining.delete(id);
  }
  return layers;
}

/** 从执行输出里抽一段可读摘要（优先 JSON 的 summary 字段） */
function extractSummary(output: string): string {
  const trimmed = output.trim();
  if (trimmed === "") return "(无输出)";
  const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const summary = parsed["summary"];
      if (typeof summary === "string" && summary.trim() !== "") return summary.trim();
    } catch {
      // 落到下面的原文截断
    }
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

/** 未达成共识时的说明文案（把分歧点讲清楚，而不是只说"没共识"） */
function buildUnresolvedNote(verdict: RoundtableVerdict | null, maxRounds: number): string {
  if (!verdict) return `讨论 ${maxRounds} 轮后仍未获得有效立场，未达成共识`;
  const parts = [`讨论 ${maxRounds} 轮后仍未达成共识`];
  if (verdict.blocking.length > 0) {
    parts.push(`阻断性反对：${verdict.blocking.map((item) => `${item.roleId}（${item.reason}）`).join("；")}`);
  }
  if (verdict.dissent.length > 0) {
    parts.push(`未解决反对：${verdict.dissent.map((item) => `${item.roleId}（${item.reason}）`).join("；")}`);
  }
  if (verdict.silent.length > 0) parts.push(`未发言角色：${verdict.silent.join("、")}`);
  return parts.join("；");
}

/**
 * 生成一个稳定的 runId（供宿主持久化 transcript 时使用）
 *
 * 这里不用 crypto.randomUUID 之外的方案：与仓库其它模块保持一致。
 */
export function createRoundtableRunId(): string {
  return crypto.randomUUID();
}
