/**
 * 多角色群聊协作（Roundtable）
 *
 * 设计文档：`docs/team-roundtable-design-20261102.md`
 *
 * 对外只暴露三样东西：
 * - `runRoundtable`：跑完一次会议（含讨论、分工、执行、回流）
 * - 领域类型：宿主渲染与持久化需要
 * - 两个纯函数（`parseSpeech` / `judgeConsensus`）：可单独测、也可被其它编排复用
 *
 * @module team/roundtable
 */

export { runRoundtable, createRoundtableRunId } from "./room.js";
export { judgeConsensus, describeVerdict } from "./consensus.js";
export { parseSpeech, parseTaskUpdate, parseDecision, extractJsonObject } from "./protocol.js";
export type {
  RoundtableAmendment,
  RoundtableAssignment,
  RoundtableDecision,
  RoundtableExecution,
  RoundtableMessage,
  RoundtableMessageKind,
  RoundtableOptions,
  RoundtablePosture,
  RoundtableResult,
  RoundtableSpeech,
  RoundtableStatus,
  RoundtableTaskUpdate,
  RoundtableVerdict,
} from "./types.js";
