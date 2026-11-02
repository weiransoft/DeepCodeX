/**
 * 共识判定（纯规则，不由模型宣布）
 *
 * 为什么必须由规则判定：模型倾向于说「我们已经达成一致」——这句话不可测、不可解释，
 * 且一旦被采信，后续分工执行就会各干各的。因此主持人只起草决议，
 * 是否算共识由这里的规则决定（设计文档第四节）。
 *
 * @module team/roundtable/consensus
 */

import type { RoundtableSpeech, RoundtableVerdict } from "./types.js";

/**
 * 判定 refine 是否「已经说完了」
 *
 * 背景：真实模型很少直接给 `support`，多数会用 `refine` 表达"同意 + 一点补充"。
 * 如果只要有 refine 就不能算共识，3 轮讨论几乎永远收敛不了。
 *
 * 因此引入「refine 稳定」：本轮没有提出新的补充（keyPoints 为空），
 * 或与本轮之前同角色提出的补充集合完全一致 → 视为已收敛。
 *
 * 这是确定性规则（可测），不是让模型自评。
 *
 * @param current 本轮该角色的发言
 * @param previous 上一轮该角色的发言（没有则 undefined）
 */
function isStableRefinement(current: RoundtableSpeech, previous: RoundtableSpeech | undefined): boolean {
  const now = normalizePoints(current.keyPoints);
  if (now.length === 0) return true;
  if (!previous || previous.posture !== "refine") return false;
  const before = normalizePoints(previous.keyPoints);
  if (before.length !== now.length) return false;
  return before.every((point, index) => point === now[index]);
}

/** 去空白 + 去重 + 排序，用于比较两次发言的要点是否相同 */
function normalizePoints(points: ReadonlyArray<string>): string[] {
  return [...new Set(points.map((p) => p.trim()).filter((p) => p !== ""))].sort();
}

/**
 * 判定本轮是否达成共识
 *
 * 三条硬规则（设计文档第四节）：
 * 1. 没解析出立场的发言按 `refine` 计入，绝不当成同意；
 * 2. `object` + `blocking: true` 一票否决，哪怕其余人全 support；
 * 3. 有效发言覆盖率不足半数 → 不给出 `consensus`（由调用方降级为 degraded）。
 *
 * @param current 本轮各角色发言（失败的发言已在 speech.error 上标记）
 * @param previous 上一轮各角色发言，用于判断 refine 是否已稳定
 * @param participantIds 房间内全部参与角色
 */
export function judgeConsensus(
  current: ReadonlyArray<RoundtableSpeech>,
  previous: ReadonlyArray<RoundtableSpeech>,
  participantIds: ReadonlyArray<string>
): RoundtableVerdict {
  // 调用失败的发言不参与判定，但会出现在 silent 里被如实报告
  const active = current.filter((speech) => speech.error === undefined);
  const activeIds = new Set(active.map((speech) => speech.roleId));
  const silent = participantIds.filter((id) => !activeIds.has(id));
  const coverage = participantIds.length === 0 ? 0 : active.length / participantIds.length;

  const previousById = new Map(previous.map((speech) => [speech.roleId, speech]));
  const objecting = active.filter((speech) => speech.posture === "object");
  const blocking = objecting.filter((speech) => speech.blocking);
  const refining = active.filter((speech) => speech.posture === "refine");
  const pendingRefinements = refining.filter((speech) => !isStableRefinement(speech, previousById.get(speech.roleId)));

  const toEntry = (speech: RoundtableSpeech) => ({
    roleId: speech.roleId,
    roleName: speech.roleName,
    reason: speech.keyPoints[0] ?? speech.content.slice(0, 120),
  });

  let kind: RoundtableVerdict["kind"];
  if (active.length === 0) {
    // 全员失声：既不是共识也不是分歧，交由调用方按 degraded/failed 处理
    kind = "diverging";
  } else if (blocking.length > 0 || objecting.length > 0 || pendingRefinements.length > 0) {
    kind = "diverging";
  } else if (coverage < 0.5) {
    // 有过半角色没发声时，即使剩下的人全 support 也不能算共识
    kind = "converging";
  } else {
    kind = "consensus";
  }

  return {
    kind,
    blocking: blocking.map(toEntry),
    dissent: objecting.filter((speech) => !speech.blocking).map(toEntry),
    silent,
    coverage,
  };
}

/**
 * 把判定结果压成一段给主持人 prompt 用的统计文本
 *
 * 主持人据此决定下一轮聚焦什么；它读到的只是**事实**（谁反对、卡在哪），
 * 而不是"已经达成共识"这类结论。
 *
 * @param verdict 判定结果
 * @param speeches 本轮发言（用于标注每人立场）
 */
export function describeVerdict(verdict: RoundtableVerdict, speeches: ReadonlyArray<RoundtableSpeech>): string {
  const lines: string[] = [];
  lines.push(`结论倾向：${verdict.kind}`);
  lines.push(`有效发言覆盖率：${(verdict.coverage * 100).toFixed(0)}%`);
  for (const speech of speeches) {
    if (speech.error !== undefined) {
      lines.push(`- ${speech.roleId}: 发言失败（${speech.error}）`);
      continue;
    }
    const flag = speech.blocking ? "，阻断" : "";
    lines.push(`- ${speech.roleId}: ${speech.posture}${flag}`);
  }
  if (verdict.blocking.length > 0) {
    lines.push(`\n阻断性反对：`);
    for (const item of verdict.blocking) {
      lines.push(`- ${item.roleId}: ${item.reason}`);
    }
  }
  if (verdict.dissent.length > 0) {
    lines.push(`\n非阻断反对：`);
    for (const item of verdict.dissent) {
      lines.push(`- ${item.roleId}: ${item.reason}`);
    }
  }
  if (verdict.silent.length > 0) {
    lines.push(`\n未发言：${verdict.silent.join("、")}`);
  }
  return lines.join("\n");
}
